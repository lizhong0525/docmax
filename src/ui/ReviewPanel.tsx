/**
 * 审阅面板（右侧「校样栏」）。
 *
 * 展示顺序刻意贴近编辑部审稿流程：
 *   阶段与耗时 → 本地识别 → 模型识别 → 词级差异 → 警告 → 接受 / 拒绝
 *
 * 规则：
 * - severity='error' 的警告（截断等）必须二次确认才能接受；
 * - 无改动（no-change）禁用接受；
 * - 提案与当前文档不匹配（已过期）时禁用接受并提供「重新生成」；
 * - ask 模式只展示流式回答，不出现接受 / 拒绝修改。
 */
import { useEffect, useMemo, useState } from 'react';
import type { EditProposal, LocalSelectionAnalysis, ModelAnalysis, ProposalWarning } from '../core/types';
import { promptPresetLabel } from '../core/presets';
import { DiffView } from './DiffView';
import { MarkdownPreview } from './Preview';
import type { EditSessionState } from './types';
import {
  BLOCK_LABELS,
  MODE_LABELS,
  PHASE_LABELS,
  PHASE_ORDER,
  SEVERITY_LABELS,
  formatCount,
  formatDuration,
  modelLabel,
} from './labels';
import { oneLine } from './utils';

export interface ReviewPanelProps {
  state: EditSessionState;
  stale: boolean;
  staleReason: string | null;
  canAccept: boolean;
  acceptLabel: string;
  requiresConfirm: boolean;
  noChange: boolean;
  isAsk: boolean;
  onClose: () => void;
  onAbort: () => void;
  onReject: () => void;
  onAccept: () => void;
  onRetry: () => void;
  onRegenerate: () => void;
}

function dedupeWarnings(warnings: ProposalWarning[]): ProposalWarning[] {
  const seen = new Set<string>();
  const order = { error: 0, warn: 1, info: 2 } as const;
  return warnings
    .filter((warning) => {
      const key = `${warning.severity}:${warning.code}:${warning.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

function PhaseStrip({ state }: { state: EditSessionState }) {
  const displayPhase = state.phase === 'connecting' && state.reasoning ? 'thinking' : state.phase;
  const normalized = displayPhase === 'repairing' || displayPhase === 'done' ? 'validating' : displayPhase;
  const activeIndex = normalized ? PHASE_ORDER.indexOf(normalized) : -1;
  const running = state.status === 'running';
  const finished = state.status === 'review' || state.status === 'error';
  const phaseText = running
    ? state.phase === 'repairing'
      ? `${PHASE_LABELS.repairing}重试`
      : PHASE_LABELS[normalized ?? 'connecting']
    : state.status === 'error'
      ? '生成失败'
      : state.ask
        ? '回答完成'
        : '待确认';

  return (
    <div className={`phase-strip${running ? ' is-running' : ''}`} data-testid="phase-strip">
      <div className="phase-steps" aria-hidden="true">
        {PHASE_ORDER.map((phase, index) => {
          const done = finished && state.phase === 'done' ? true : activeIndex > index;
          const active = running && activeIndex === index;
          return (
            <span className={`phase-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}`} key={phase}>
              {PHASE_LABELS[phase]}
            </span>
          );
        })}
      </div>
      <div className="phase-status">
        <span className="phase-label" data-testid="phase-label" aria-live="polite">
          {phaseText}
        </span>
        <span className="phase-detail" data-testid="phase-detail">
          {running ? formatDuration(state.elapsedMs) : state.timings?.totalMs ? formatDuration(state.timings.totalMs) : ''}
        </span>
        {state.batch.total > 1 ? (
          <span className="phase-batch">
            第 {state.batch.current}/{state.batch.total} 处
          </span>
        ) : null}
        {state.attempt > 1 ? <span className="phase-attempt">第 {state.attempt} 次尝试</span> : null}
      </div>
      {state.phaseNote ? <p className="phase-note">{state.phaseNote}</p> : null}
    </div>
  );
}

function FactChips({ analysis }: { analysis: LocalSelectionAnalysis }) {
  return (
    <div className="fact-chips">
      <span className="fact-chip fact-chip-block">{BLOCK_LABELS[analysis.blockKind]}</span>
      <span className="fact-chip">{formatCount(analysis.chars)} 字</span>
      <span className="fact-chip">{formatCount(analysis.words)} 词</span>
      <span className="fact-chip">
        第 {analysis.startLine}
        {analysis.endLine !== analysis.startLine ? `–${analysis.endLine}` : ''} 行
      </span>
      {analysis.codeFenceLang ? <span className="fact-chip fact-chip-code">{analysis.codeFenceLang}</span> : null}
      {analysis.spansMultipleBlocks ? <span className="fact-chip fact-chip-warn">跨块</span> : null}
      {analysis.startsMidWord || analysis.endsMidWord ? <span className="fact-chip fact-chip-warn">截断单词</span> : null}
      {analysis.delimiterWarnings.length ? <span className="fact-chip fact-chip-warn">标记不平衡</span> : null}
    </div>
  );
}

function LocalAnalysisBlock({ analysis }: { analysis: LocalSelectionAnalysis | null }) {
  return (
    <section className="analysis-block" data-testid="local-analysis" aria-label="本地选区识别">
      <h4>
        本地识别 <span className="analysis-source">确定性 · 不需要模型</span>
      </h4>
      {analysis ? (
        <>
          <FactChips analysis={analysis} />
          <dl className="analysis-grid">
            <div>
              <dt>起始</dt>
              <dd>{analysis.startsMidLine ? '行中' : '行首'}</dd>
            </div>
            <div>
              <dt>结束</dt>
              <dd>{analysis.endsMidLine ? '行中' : '行尾'}</dd>
            </div>
            <div>
              <dt>完整单词</dt>
              <dd>{analysis.startsMidWord || analysis.endsMidWord ? '否' : '是'}</dd>
            </div>
            <div>
              <dt>代码围栏</dt>
              <dd>{analysis.codeFenceLang ?? (analysis.blockKind === 'code' ? '无语言' : '否')}</dd>
            </div>
          </dl>
          {analysis.suggestions.length ? (
            <ul className="suggestions suggestions-compact">
              {analysis.suggestions.map((suggestion) => (
                <li key={suggestion}>{suggestion}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="analysis-empty">未返回本地识别结果。</p>
      )}
    </section>
  );
}

const ANALYSIS_KNOWN_KEYS = new Set(['kind', 'language', 'summary', 'confidence']);

function ModelAnalysisBlock({ analysis }: { analysis: ModelAnalysis | null }) {
  const extras = useMemo(() => {
    if (!analysis) return [];
    return Object.entries(analysis).filter(([key]) => !ANALYSIS_KNOWN_KEYS.has(key));
  }, [analysis]);

  return (
    <section className="analysis-block analysis-model" data-testid="model-analysis" aria-label="模型识别结果">
      <h4>
        模型识别 <span className="analysis-source">模型输出</span>
      </h4>
      {analysis ? (
        <>
          <dl className="analysis-grid">
            {typeof analysis.kind === 'string' ? (
              <div>
                <dt>类型</dt>
                <dd>{analysis.kind}</dd>
              </div>
            ) : null}
            {typeof analysis.language === 'string' ? (
              <div>
                <dt>语言</dt>
                <dd>{analysis.language}</dd>
              </div>
            ) : null}
            {typeof analysis.confidence === 'number' ? (
              <div>
                <dt>置信度</dt>
                <dd>{Math.round(analysis.confidence * 100)}%</dd>
              </div>
            ) : null}
          </dl>
          {typeof analysis.summary === 'string' && analysis.summary.trim() ? (
            <p className="analysis-summary">{analysis.summary}</p>
          ) : null}
          {extras.length ? (
            <details className="analysis-extra">
              <summary>其它字段</summary>
              <pre>{JSON.stringify(Object.fromEntries(extras), null, 2)}</pre>
            </details>
          ) : null}
        </>
      ) : (
        <p className="analysis-empty">模型没有返回结构化识别结果。</p>
      )}
    </section>
  );
}

function WarningList({ warnings }: { warnings: ProposalWarning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="warnings" data-testid="warnings">
      {warnings.map((warning, index) => (
        <li key={`${warning.code}-${index}`} className={`warning warning-${warning.severity}`}>
          <span className="warning-mark" aria-hidden="true">
            {warning.severity === 'error' ? '✕' : warning.severity === 'warn' ? '!' : '·'}
          </span>
          <span className="warning-body">
            <span className="warning-severity">{SEVERITY_LABELS[warning.severity]}</span>
            <span>{warning.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProposalCard({ proposal, index, total }: { proposal: EditProposal; index: number; total: number }) {
  const warnings = dedupeWarnings(proposal.warnings);
  const local = proposal.localAnalyses[0] ?? null;
  return (
    <section className="proposal-card" data-testid="proposal-card">
      <header className="proposal-head">
        <span className="proposal-index">
          第 {index + 1} 处{total > 1 ? ` / 共 ${total} 处` : ''}
        </span>
        <span className="proposal-mode">{MODE_LABELS[proposal.mode]}</span>
        {proposal.ops[0] ? (
          <span className="proposal-delta">
            −{formatCount(proposal.ops[0].stats.removedChars)} +{formatCount(proposal.ops[0].stats.addedChars)}
          </span>
        ) : null}
      </header>

      <LocalAnalysisBlock analysis={local} />
      <ModelAnalysisBlock analysis={proposal.analysis} />

      {proposal.ops.map((op) => (
        <div className="proposal-diff" key={op.rangeId}>
          <div className="diff-title-row">
            <h4>词级差异</h4>
            <span className="diff-legend">
              <span className="legend-del">删除</span>
              <span className="legend-add">新增</span>
            </span>
          </div>
          <DiffView before={op.oldText} after={op.newText} />
          <details className="new-text">
            <summary>查看替换后的完整文本</summary>
            <pre>{op.newText || '（空内容：接受后会删除该选区）'}</pre>
          </details>
        </div>
      ))}

      <WarningList warnings={warnings} />
    </section>
  );
}

function ErrorBlock({
  state,
  onRetry,
  onRegenerate,
}: {
  state: EditSessionState;
  onRetry: () => void;
  onRegenerate: () => void;
}) {
  const error = state.error;
  if (!error) return null;
  return (
    <div className="review-error" role="alert" data-testid="review-error">
      <div className="review-error-head">
        <span className="review-error-code">{error.code}</span>
        <span className="review-error-title">请求失败</span>
      </div>
      <p>{error.message}</p>
      {error.detail ? (
        <details>
          <summary>技术细节</summary>
          <pre>{error.detail}</pre>
        </details>
      ) : null}
      <div className="review-error-actions">
        {error.retryable ? (
          <button type="button" className="btn btn-ghost" onClick={onRetry} data-testid="retry">
            重试
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onRegenerate} data-testid="regenerate-error">
          用当前选区重新生成
        </button>
      </div>
    </div>
  );
}

export function ReviewPanel(props: ReviewPanelProps) {
  const { state, stale, staleReason, requiresConfirm, noChange, isAsk } = props;
  const [copied, setCopied] = useState(false);
  const running = state.status === 'running';

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(state.answer);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const streamText = state.answer || state.streamText;
  const trimmedStream = streamText.length > 4000 ? `…${streamText.slice(-4000)}` : streamText;
  const mode = state.proposals[0]?.mode ?? (state.ask ? 'ask' : null);

  return (
    <aside className="review-panel" data-testid="review-panel" aria-label="修改审阅">
      <header className="review-head">
        <div className="review-heading">
          <span className="review-eyebrow">{isAsk ? '回答' : '修改审阅'}</span>
          <h2 className="review-instruction" title={state.instruction}>
            {oneLine(state.instruction, 52) || '（无指令）'}
          </h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={running ? props.onAbort : props.onClose}
          aria-label={running ? '中止生成' : '关闭审阅'}
          data-testid="close-review"
        >
          ✕
        </button>
      </header>

      <div className="review-body">
        <PhaseStrip state={state} />

        <div className="review-meta">
          <span>{modelLabel(state.model)}</span>
          {mode ? <span>{MODE_LABELS[mode]}</span> : null}
          {!isAsk ? <span>提示词 · {promptPresetLabel(state.presetId)}</span> : null}
          {state.usage ? <span>{formatCount(state.usage.totalTokens)} tokens</span> : null}
          {state.timings?.firstContentMs ? <span>首字 {formatDuration(state.timings.firstContentMs)}</span> : null}
          {state.timings?.repairs ? <span>修复 {state.timings.repairs} 次</span> : null}
        </div>

        {stale ? (
          <div className="stale-banner" role="alert" data-testid="stale-banner">
            <strong>提案已过期</strong>
            <p>{staleReason ?? '文档在生成期间发生了变化，修改位置可能已错位。'}</p>
          </div>
        ) : null}

        <ErrorBlock state={state} onRetry={props.onRetry} onRegenerate={props.onRegenerate} />

        {state.reasoning ? (
          <details className="reasoning" data-testid="reasoning">
            <summary>
              思考过程 <span className="reasoning-count">{formatCount(state.reasoning.length)} 字</span>
            </summary>
            <pre>{state.reasoning}</pre>
          </details>
        ) : null}

        {running && trimmedStream ? (
          <div className="stream-block" data-testid="stream-output">
            <div className="stream-head">
              <span>{state.ask ? '回答生成中' : '修改生成中'}</span>
              <span className="stream-count">{formatCount(streamText.length)} 字</span>
            </div>
            <pre className="stream-text">{trimmedStream}</pre>
          </div>
        ) : null}

        {running && state.rawText && state.proposals.length === 0 ? (
          <details className="raw-output">
            <summary>模型原始输出</summary>
            <pre>{state.rawText.length > 6000 ? `…${state.rawText.slice(-6000)}` : state.rawText}</pre>
          </details>
        ) : null}

        {isAsk && !running ? (
          <section className="answer-block" data-testid="review-answer">
            <div className="answer-head">
              <h3>回答</h3>
              <button type="button" className="link-btn" onClick={copyAnswer}>
                {copied ? '已复制' : '复制回答'}
              </button>
            </div>
            <div className="answer-text">
              <MarkdownPreview docText={state.answer} className="prose prose-answer" testId="review-answer-markdown" />
            </div>
            {state.proposals.map((proposal, index) => (
              <ProposalCard key={proposal.requestId} proposal={proposal} index={index} total={state.proposals.length} />
            ))}
          </section>
        ) : (
          state.proposals.map((proposal, index) => (
            <ProposalCard key={proposal.requestId} proposal={proposal} index={index} total={state.proposals.length} />
          ))
        )}

        {noChange && !running ? (
          <p className="nochange-note">模型认为这段文字无需修改。</p>
        ) : null}

        {requiresConfirm && !running ? (
          <p className="confirm-note" data-testid="confirm-note">
            存在 error 级警告（内容可能被截断）。请核对差异后，再点一次「确认接受」。
          </p>
        ) : null}
      </div>

      <footer className="review-foot">
        {running ? (
          <>
            <span className="foot-note">生成期间文档不会被修改</span>
            <button type="button" className="btn btn-ghost" onClick={props.onAbort} data-testid="abort">
              中止生成
            </button>
          </>
        ) : isAsk ? (
          <>
            <span className="foot-note">解释模式不会修改文档</span>
            <button type="button" className="btn btn-primary" onClick={props.onClose} data-testid="close-answer">
              完成
            </button>
          </>
        ) : state.proposals.length === 0 ? (
          <>
            <span className="foot-note">没有可应用的修改</span>
            <button type="button" className="btn btn-primary" onClick={props.onClose} data-testid="close-error">
              关闭
            </button>
          </>
        ) : (
          <>
            <span className="foot-note">Ctrl+Enter 接受 · Esc 关闭</span>
            <button type="button" className="btn btn-ghost" onClick={props.onReject} data-testid="reject">
              拒绝
            </button>
            <div className="review-foot-main">
              {stale ? (
                <button type="button" className="btn btn-primary" onClick={props.onRegenerate} data-testid="regenerate">
                  重新生成
                </button>
              ) : (
                <button
                  type="button"
                  className={`btn btn-primary${requiresConfirm ? ' btn-danger' : ''}`}
                  onClick={props.onAccept}
                  disabled={!props.canAccept}
                  data-testid="accept"
                >
                  {props.acceptLabel}
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}

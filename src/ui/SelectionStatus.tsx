/**
 * 底部「选区状态栏」+ 识别详情浮层。
 *
 * 这是产品核心卖点之一的展示面：让用户随时看到「模型看到的到底是什么」——
 * 精确字符数、词数、行号、块类型、代码围栏语言、截断英文单词、Markdown 标记不平衡等。
 */
import type { EditorRangeInfo, EditorSelectionInfo } from './types';
import { BLOCK_LABELS, formatCount } from './labels';
import { clipMiddle } from './utils';

export interface SelectionStatusProps {
  selection: EditorSelectionInfo | null;
  docText: string;
  docStats: { chars: number; words: number; lines: number };
  busy: boolean;
  detailOpen: boolean;
  isMac: boolean;
  onToggleDetail: () => void;
  onOpenCommand: () => void;
  onExpand: (unit: 'word' | 'line' | 'paragraph' | 'block') => void;
}

function Badge({ tone, children }: { tone?: 'warn' | 'muted' | 'code'; children: string }) {
  return <span className={`badge${tone ? ` badge-${tone}` : ''}`}>{children}</span>;
}

function Summary({ selection }: { selection: EditorSelectionInfo }) {
  const primary = selection.ranges[0];
  if (!primary) return null;
  const analysis = primary.analysis;
  if (analysis.chars === 0) {
    return (
      <>
        <span className="status-pos">
          第 {selection.cursor.line} 行 · 第 {selection.cursor.col} 列
        </span>
        <span className="status-sep" aria-hidden="true">
          /
        </span>
        <span>{BLOCK_LABELS[analysis.blockKind]}</span>
        <Badge tone="muted">光标位置 · 将插入</Badge>
      </>
    );
  }
  return (
    <>
      <span className="status-pos">
        第 {analysis.startLine}
        {analysis.endLine !== analysis.startLine ? `–${analysis.endLine}` : ''} 行
      </span>
      <span className="status-sep" aria-hidden="true">
        /
      </span>
      <span>{formatCount(analysis.chars)} 字</span>
      <span className="status-sep" aria-hidden="true">
        /
      </span>
      <span>{formatCount(analysis.words)} 词</span>
      <span className="status-sep" aria-hidden="true">
        /
      </span>
      <span>{BLOCK_LABELS[analysis.blockKind]}</span>
    </>
  );
}

function Badges({ analysis }: { analysis: EditorRangeInfo['analysis'] }) {
  const badges: Array<{ tone?: 'warn' | 'muted' | 'code'; text: string }> = [];
  if (analysis.blockKind === 'code') {
    badges.push({ tone: 'code', text: analysis.codeFenceLang ? `代码 · ${analysis.codeFenceLang}` : '代码块' });
  }
  if (analysis.spansMultipleBlocks) badges.push({ tone: 'muted', text: '跨块' });
  if (analysis.startsMidWord || analysis.endsMidWord) badges.push({ tone: 'warn', text: '截断英文单词' });
  if (analysis.delimiterWarnings.length) badges.push({ tone: 'warn', text: '标记不平衡' });
  if (analysis.startsMidLine && analysis.endsMidLine && analysis.chars > 0 && analysis.chars < 60) {
    badges.push({ tone: 'muted', text: '行内片段' });
  }
  return (
    <>
      {badges.map((badge) => (
        <Badge key={badge.text} tone={badge.tone}>
          {badge.text}
        </Badge>
      ))}
    </>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CheckRow({ label, ok, hint }: { label: string; ok: boolean; hint: boolean }) {
  return (
    <div className={`check-row${ok ? '' : ' check-warn'}`}>
      <span className="check-mark" aria-hidden="true">
        {ok ? '✓' : '⚠'}
      </span>
      <span>{label}</span>
      {hint ? <span className="check-hint">{ok ? '完整' : '需要注意'}</span> : null}
    </div>
  );
}

function RangeDetail({
  range,
  primary,
  docText,
  onExpand,
}: {
  range: EditorRangeInfo;
  primary: boolean;
  docText: string;
  onExpand: SelectionStatusProps['onExpand'];
}) {
  const analysis = range.analysis;
  const selectionText = docText.slice(range.from, range.to);
  return (
    <section className="range-detail" aria-label={primary ? '主选区识别' : `第 ${range.index + 1} 处选区识别`}>
      <header className="range-detail-head">
        <h3>
          第 {range.index + 1} 处
          {primary ? <span className="primary-tag">主选区</span> : null}
        </h3>
        <span className="range-offset">
          偏移 {range.from}–{range.to}
        </span>
      </header>
      <dl className="fact-grid">
        <FactRow label="字符" value={`${formatCount(analysis.chars)} 字`} />
        <FactRow label="词" value={`${formatCount(analysis.words)} 词`} />
        <FactRow label="行" value={`${analysis.startLine}–${analysis.endLine} 行`} />
        <FactRow label="块类型" value={BLOCK_LABELS[analysis.blockKind]} />
        {analysis.codeFenceLang ? <FactRow label="代码语言" value={analysis.codeFenceLang} /> : null}
        <FactRow label="边界" value={analysis.startsMidLine ? '行中开始' : '行首开始'} />
        <FactRow label="结束" value={analysis.endsMidLine ? '行中结束' : '行尾结束'} />
        <FactRow label="跨块" value={analysis.spansMultipleBlocks ? '是' : '否'} />
      </dl>

      <div className="boundary-preview" aria-label="选区边界">
        <span className="boundary-before">{analysis.boundary.before || '（文档开头）'}</span>
        <span className="boundary-selection">{clipMiddle(selectionText, 160) || '（空选区）'}</span>
        <span className="boundary-after">{analysis.boundary.after || '（文档末尾）'}</span>
      </div>

      <div className="checks">
        <CheckRow label="起始于完整单词" ok={!analysis.startsMidWord} hint />
        <CheckRow label="结束于完整单词" ok={!analysis.endsMidWord} hint />
        <CheckRow label="Markdown 标记成对" ok={analysis.delimiterWarnings.length === 0} hint />
      </div>

      {analysis.delimiterWarnings.length ? (
        <ul className="mini-warnings">
          {analysis.delimiterWarnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      ) : null}

      {analysis.suggestions.length ? (
        <ul className="suggestions">
          {analysis.suggestions.map((suggestion) => (
            <li key={suggestion}>{suggestion}</li>
          ))}
        </ul>
      ) : null}

      <div className="expand-row" role="group" aria-label="扩展选区">
        <span className="expand-label">扩展选区</span>
        <button type="button" className="chip chip-mini" onClick={() => onExpand('word')}>
          整词
        </button>
        <button type="button" className="chip chip-mini" onClick={() => onExpand('line')}>
          整行
        </button>
        <button type="button" className="chip chip-mini" onClick={() => onExpand('paragraph')}>
          整段
        </button>
        <button type="button" className="chip chip-mini" onClick={() => onExpand('block')}>
          整块
        </button>
      </div>
    </section>
  );
}

export function SelectionStatus(props: SelectionStatusProps) {
  const { selection, docText, docStats, busy, detailOpen, isMac } = props;
  const primary = selection?.ranges[0] ?? null;
  const isEmpty = !primary || primary.analysis.chars === 0;
  const multi = (selection?.ranges.length ?? 0) > 1;

  return (
    <footer className="statusbar" data-testid="selection-status">
      <div className="status-left">
        {multi ? (
          <span className="multi-note">
            已选 {selection?.ranges.length} 处 · 主选区优先，逐个处理
          </span>
        ) : null}
        {selection && primary ? (
          <>
            <Summary selection={selection} />
            <Badges analysis={primary.analysis} />
          </>
        ) : (
          <span className="status-muted">正在载入编辑器…</span>
        )}
      </div>

      <div className="status-center" aria-hidden="true">
        <span>全文 {formatCount(docStats.chars)} 字</span>
        <span className="status-sep">/</span>
        <span>{formatCount(docStats.lines)} 行</span>
      </div>

      <div className="status-right">
        <button
          type="button"
          className={`status-btn${detailOpen ? ' is-active' : ''}`}
          onClick={props.onToggleDetail}
          aria-expanded={detailOpen}
          aria-label="查看选区识别详情"
          data-testid="toggle-selection-detail"
        >
          识别详情
        </button>
        <button
          type="button"
          className="ai-trigger"
          onClick={props.onOpenCommand}
          disabled={busy}
          aria-label={isEmpty ? '在光标处让 AI 插入文字' : '让 AI 修改当前选区'}
          data-testid="open-command"
        >
          <span className="ai-trigger-glyph" aria-hidden="true">
            ✦
          </span>
          <span>{isEmpty ? '在此插入' : 'AI 修改'}</span>
          <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>

      {detailOpen && primary ? (
        <div className="detail-pop" role="dialog" aria-label="选区识别详情" data-testid="selection-detail">
          <header className="detail-head">
            <div>
              <h2>选区识别</h2>
              <p>本地确定性计算，模型看到的就是这些事实。</p>
            </div>
            <button type="button" className="icon-btn" onClick={props.onToggleDetail} aria-label="关闭识别详情">
              ✕
            </button>
          </header>
          <div className="detail-body">
            {(selection?.ranges ?? []).map((range) => (
              <RangeDetail
                key={`${range.from}-${range.to}-${range.index}`}
                range={range}
                primary={range.index === 0}
                docText={docText}
                onExpand={props.onExpand}
              />
            ))}
          </div>
        </div>
      ) : null}
    </footer>
  );
}

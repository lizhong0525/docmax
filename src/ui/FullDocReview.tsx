/**
 * 全文修改 · 审查修改（逐处审批）面板。
 *
 * 与普通选区审阅不同：全文修改会产生整篇新文本，因此这里把改动拆成可独立
 * 批准的 hunk（行级差异），用两栏 before/after、状态徽章、审批进度条做可视化；
 * 只有「已批准」的 hunk 会进入最终文本，未审批/已拒绝的保持原文。
 */
import { useEffect, useMemo, useState } from 'react';
import { applyReviewDecisions, buildReviewModel, makeReviewSummary, type ReviewDecision, type ReviewHunk } from '../core/review';
import { promptPresetLabel } from '../core/presets';
import type { EditSessionState } from './types';
import { IconClose } from './Icons';
import { formatCount, modelLabel } from './labels';
import { oneLine } from './utils';

export interface FullDocReviewProps {
  open: boolean;
  before: string | null;
  after: string | null;
  state: EditSessionState;
  onClose: () => void;
  onApply: (finalText: string, summary: ReturnType<typeof makeReviewSummary>) => void;
  onRejectAll: (summary: ReturnType<typeof makeReviewSummary>) => void;
}

const DECISION_LABEL: Record<ReviewDecision, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
};

const KIND_LABEL: Record<ReviewHunk['kind'], string> = {
  add: '新增',
  delete: '删除',
  change: '改写',
};

const MAX_RENDER_HUNKS = 400;

function LineBlock({
  text,
  startLine,
  tone,
  emptyLabel,
}: {
  text: string;
  startLine: number;
  tone: 'old' | 'new';
  emptyLabel: string;
}) {
  if (!text) {
    return <div className={`review-hunk-empty review-hunk-${tone}`}>{emptyLabel}</div>;
  }
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return (
    <div className={`review-hunk-code review-hunk-${tone}`}>
      {lines.map((line, index) => (
        <div className="review-hunk-line" key={`${startLine}-${index}`}>
          <span className="review-hunk-ln" aria-hidden="true">
            {startLine + index}
          </span>
          <span className="review-hunk-text">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function FullDocReview(props: FullDocReviewProps) {
  const { open, before, after, state } = props;
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({});
  const [pendingWarning, setPendingWarning] = useState(false);

  const model = useMemo(
    () => (before !== null && after !== null && before !== after ? buildReviewModel(before, after) : null),
    [before, after],
  );

  useEffect(() => {
    setDecisions({});
    setPendingWarning(false);
  }, [before, after]);

  const counts = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    if (!model) return { approved, rejected, pending: 0 };
    for (const hunk of model.hunks) {
      const decision = decisions[hunk.id] ?? 'pending';
      if (decision === 'approved') approved += 1;
      else if (decision === 'rejected') rejected += 1;
    }
    return { approved, rejected, pending: model.hunks.length - approved - rejected };
  }, [model, decisions]);

  if (!open || !model || model.hunks.length === 0) return null;

  const total = model.hunks.length;
  const renderedHunks = model.hunks.slice(0, MAX_RENDER_HUNKS);
  const noApproved = counts.approved === 0;

  const setAll = (decision: ReviewDecision) => {
    const next: Record<string, ReviewDecision> = {};
    for (const hunk of model.hunks) next[hunk.id] = decision;
    setDecisions(next);
    setPendingWarning(false);
  };

  const decide = (hunkId: string, decision: ReviewDecision) => {
    setDecisions((previous) => {
      const current = previous[hunkId] ?? 'pending';
      return { ...previous, [hunkId]: current === decision ? 'pending' : decision };
    });
    setPendingWarning(false);
  };

  const apply = () => {
    if (noApproved) return;
    if (counts.pending > 0 && !pendingWarning) {
      setPendingWarning(true);
      return;
    }
    const finalText = applyReviewDecisions(model, decisions);
    const summary = makeReviewSummary(model, decisions, finalText);
    props.onApply(finalText, summary);
  };

  const rejectAll = () => {
    const rejected: Record<string, ReviewDecision> = {};
    for (const hunk of model.hunks) rejected[hunk.id] = 'rejected';
    const summary = makeReviewSummary(model, rejected, model.before);
    props.onRejectAll(summary);
  };

  const progressApproved = total ? (counts.approved / total) * 100 : 0;
  const progressRejected = total ? (counts.rejected / total) * 100 : 0;

  return (
    <div className="full-review-layer" data-testid="full-review">
      <section className="full-review-card" role="dialog" aria-modal="true" aria-label="全文修改审查审批">
        <header className="full-review-head">
          <div className="full-review-heading">
            <span className="review-eyebrow">全文修改 · 审查修改</span>
            <h2>
              审批修改 <span className="full-review-count">（{total} 处变更）</span>
            </h2>
            <p className="full-review-sub" title={state.instruction}>
              指令：{oneLine(state.instruction || '（使用提示词模式默认任务）', 72)} · {modelLabel(state.model)} ·{' '}
              {promptPresetLabel(state.presetId)}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭审查修改" data-testid="full-review-close">
            <IconClose />
          </button>
        </header>

        <div className="full-review-stats">
          <div className="full-review-stat full-review-stat-approved">
            <strong>{counts.approved}</strong>
            <span>已批准</span>
          </div>
          <div className="full-review-stat full-review-stat-rejected">
            <strong>{counts.rejected}</strong>
            <span>已拒绝</span>
          </div>
          <div className="full-review-stat full-review-stat-pending">
            <strong>{counts.pending}</strong>
            <span>待审批</span>
          </div>
          <div className="full-review-bar" aria-label={`审批进度：已批准 ${counts.approved}，已拒绝 ${counts.rejected}，待审批 ${counts.pending}`}>
            <span className="full-review-bar-approved" style={{ width: `${progressApproved}%` }} />
            <span className="full-review-bar-rejected" style={{ width: `${progressRejected}%` }} />
          </div>
          <div className="full-review-bulk">
            <button type="button" className="status-btn" onClick={() => setAll('approved')} data-testid="review-approve-all">
              全部批准
            </button>
            <button type="button" className="status-btn" onClick={() => setAll('rejected')} data-testid="review-reject-all">
              全部拒绝
            </button>
            <button type="button" className="status-btn" onClick={() => setAll('pending')} data-testid="review-reset">
              重置
            </button>
          </div>
        </div>

        <div className="full-review-body" data-testid="review-hunk-list">
          <div className="full-review-cols-head" aria-hidden="true">
            <span>原文</span>
            <span>建议修改</span>
          </div>
          {renderedHunks.map((hunk, index) => {
            const decision = decisions[hunk.id] ?? 'pending';
            return (
              <article
                key={hunk.id}
                className={`review-hunk review-hunk-${decision}`}
                data-testid={`review-hunk-${index + 1}`}
                data-decision={decision}
              >
                <header className="review-hunk-head">
                  <span className="review-hunk-index">第 {index + 1} 处</span>
                  <span className={`review-hunk-kind review-hunk-kind-${hunk.kind}`}>{KIND_LABEL[hunk.kind]}</span>
                  <span className="review-hunk-lines">
                    原第 {hunk.oldStartLine} 行 · 新第 {hunk.newStartLine} 行
                  </span>
                  <span className={`review-hunk-status review-status-${decision}`}>{DECISION_LABEL[decision]}</span>
                </header>
                <div className="review-hunk-pair">
                  <LineBlock text={hunk.oldText} startLine={hunk.oldStartLine} tone="old" emptyLabel="（无原文，新增内容）" />
                  <LineBlock text={hunk.newText} startLine={hunk.newStartLine} tone="new" emptyLabel="（无新内容，删除）" />
                </div>
                <footer className="review-hunk-actions">
                  <span className="review-hunk-delta">
                    {hunk.kind === 'change'
                      ? `${formatCount(hunk.oldText.length)} → ${formatCount(hunk.newText.length)} 字符`
                      : hunk.kind === 'add'
                        ? `新增 ${formatCount(hunk.newText.length)} 字符`
                        : `删除 ${formatCount(hunk.oldText.length)} 字符`}
                  </span>
                  <button
                    type="button"
                    className={`status-btn review-approve-btn${decision === 'approved' ? ' is-active' : ''}`}
                    onClick={() => decide(hunk.id, 'approved')}
                    aria-pressed={decision === 'approved'}
                    data-testid={`review-approve-${index + 1}`}
                  >
                    ✓ 批准
                  </button>
                  <button
                    type="button"
                    className={`status-btn review-reject-btn${decision === 'rejected' ? ' is-active' : ''}`}
                    onClick={() => decide(hunk.id, 'rejected')}
                    aria-pressed={decision === 'rejected'}
                    data-testid={`review-reject-${index + 1}`}
                  >
                    ✕ 拒绝
                  </button>
                </footer>
              </article>
            );
          })}
          {model.hunks.length > renderedHunks.length ? (
            <p className="full-review-more">
              差异较多，当前显示前 {renderedHunks.length} 处；批量操作仍会作用于全部 {model.hunks.length} 处修改。
            </p>
          ) : null}
        </div>

        <footer className="full-review-foot">
          <div className="full-review-foot-info">
            <strong>审批结果</strong>
            <span>
              同意 {counts.approved} 处，拒绝 {counts.rejected} 处，未审批 {counts.pending} 处；未审批和已拒绝的修改会保留原文。
            </span>
            {pendingWarning && counts.pending > 0 ? (
              <span className="full-review-warning" role="alert" data-testid="review-pending-warning">
                还有 {counts.pending} 处未审批，将按「保留原文」处理；再次点击应用确认。
              </span>
            ) : null}
          </div>
          <div className="full-review-foot-actions">
            <button type="button" className="btn btn-ghost" onClick={props.onClose}>
              返回普通审阅
            </button>
            <button type="button" className="btn btn-ghost review-reject-all" onClick={rejectAll} data-testid="review-reject-all-confirm">
              拒绝全文修改
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={apply}
              disabled={noApproved}
              data-testid="review-apply"
              title={noApproved ? '请先批准至少一处修改' : '只应用已批准的修改'}
            >
              {pendingWarning && counts.pending > 0 ? `确认应用 ${counts.approved} 处` : `应用 ${counts.approved} 处已批准修改`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

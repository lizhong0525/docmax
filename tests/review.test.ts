import { describe, expect, it } from 'vitest';
import { applyReviewDecisions, buildReviewModel, makeReviewSummary, type ReviewDecision } from '../src/core/review';

function approveAll(model: ReturnType<typeof buildReviewModel>): Record<string, ReviewDecision> {
  const decisions: Record<string, ReviewDecision> = {};
  for (const hunk of model.hunks) decisions[hunk.id] = 'approved';
  return decisions;
}

describe('全文修改 · 审查模型', () => {
  it('相同文本没有 hunk', () => {
    const model = buildReviewModel('a\nb\n', 'a\nb\n');
    expect(model.hunks).toHaveLength(0);
    expect(applyReviewDecisions(model, {})).toBe('a\nb\n');
  });

  it('改写行聚合为一个 change hunk，批准后等于 after', () => {
    const before = '标题\n\n第一段内容。\n第二段内容。\n';
    const after = '标题\n\n第一段内容（更正式）。\n第二段内容。\n';
    const model = buildReviewModel(before, after);
    expect(model.hunks).toHaveLength(1);
    expect(model.hunks[0].kind).toBe('change');
    expect(model.hunks[0].oldStartLine).toBe(3);
    const decisions = approveAll(model);
    expect(applyReviewDecisions(model, decisions)).toBe(after);
    expect(applyReviewDecisions(model, {})).toBe(before);
  });

  it('多 hunk 可部分批准：未批准/拒绝的 hunk 保留原文', () => {
    const before = '第一行\n第二行\n第三行\n第四行\n';
    const after = '第一行（改）\n第二行\n第三行（改）\n第四行\n';
    const model = buildReviewModel(before, after);
    expect(model.hunks).toHaveLength(2);
    const decisions: Record<string, ReviewDecision> = {
      [model.hunks[0].id]: 'approved',
      [model.hunks[1].id]: 'rejected',
    };
    const result = applyReviewDecisions(model, decisions);
    expect(result).toBe('第一行（改）\n第二行\n第三行\n第四行\n');
    expect(result).not.toBe(before);
    expect(result).not.toBe(after);
  });

  it('新增 / 删除行也能独立审批', () => {
    const before = '保留 A\n删除这一行\n保留 B\n';
    const after = '保留 A\n保留 B\n新增一行\n';
    const model = buildReviewModel(before, after);
    expect(model.hunks.some((hunk) => hunk.kind === 'delete' || hunk.kind === 'add' || hunk.kind === 'change')).toBe(true);
    const all = applyReviewDecisions(model, approveAll(model));
    expect(all).toBe(after);
    const none = applyReviewDecisions(model, {});
    expect(none).toBe(before);
    const approvedIds = new Set(model.hunks.filter((hunk) => hunk.kind !== 'delete').map((hunk) => hunk.id));
    const decisions: Record<string, ReviewDecision> = {};
    for (const hunk of model.hunks) decisions[hunk.id] = approvedIds.has(hunk.id) ? 'approved' : 'rejected';
    const partial = applyReviewDecisions(model, decisions);
    expect(partial).toContain('删除这一行');
    expect(partial).toContain('新增一行');
  });

  it('统计审批数量与结果字符数', () => {
    const before = 'a\nb\nc\n';
    const after = 'A\nb\nC\n';
    const model = buildReviewModel(before, after);
    const decisions: Record<string, ReviewDecision> = {};
    model.hunks.forEach((hunk, index) => {
      decisions[hunk.id] = index === 0 ? 'approved' : 'pending';
    });
    const finalText = applyReviewDecisions(model, decisions);
    const summary = makeReviewSummary(model, decisions, finalText);
    expect(summary.total).toBe(2);
    expect(summary.approved).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.rejected).toBe(0);
    expect(summary.resultChars).toBe(finalText.length);
    expect(summary.decisions[0].decision).toBe('approved');
  });

  it('全文大量行：批准全部严格等于 after', () => {
    const before = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行原始内容`).join('\n') + '\n';
    const after = Array.from({ length: 200 }, (_, i) =>
      i % 7 === 0 ? `第 ${i + 1} 行改写后的内容` : `第 ${i + 1} 行原始内容`,
    ).join('\n') + '\n';
    const model = buildReviewModel(before, after);
    expect(model.hunks.length).toBeGreaterThan(10);
    expect(applyReviewDecisions(model, approveAll(model))).toBe(after);
    expect(applyReviewDecisions(model, {})).toBe(before);
  });
});

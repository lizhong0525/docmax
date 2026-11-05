/**
 * 全文修改的「审查修改」数据模型。
 *
 * 把整篇 before → after 的改动按行聚合成可独立审批的 hunk：
 * - 每个 hunk 保存原文/建议文本、起止行号与类型（新增/删除/改写）；
 * - 审批时可以逐处批准或拒绝；未审批的 hunk 在应用时按原文保留；
 * - 用纯函数实现，便于单测与在 UI 里实时重建最终文本。
 */
import { diffLines } from 'diff';

export type ReviewHunkKind = 'add' | 'delete' | 'change';

export interface ReviewHunk {
  /** 稳定 id：h1、h2…（按文档顺序） */
  id: string;
  kind: ReviewHunkKind;
  /** 原文起始行（1-based；纯新增时为插入位置） */
  oldStartLine: number;
  /** 建议文本起始行（1-based；纯删除时为位置） */
  newStartLine: number;
  oldLines: string[];
  newLines: string[];
  oldText: string;
  newText: string;
}

export interface ReviewModel {
  before: string;
  after: string;
  hunks: ReviewHunk[];
  addedChars: number;
  removedChars: number;
  addedLines: number;
  removedLines: number;
}

export type ReviewDecision = 'pending' | 'approved' | 'rejected';

export interface ReviewSummary {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  /** 应用后文档的字符数 */
  resultChars: number;
  /** 每处 hunk 的精简审批记录，写入留痕（避免整篇文本重复） */
  decisions: Array<{
    id: string;
    kind: ReviewHunkKind;
    oldStartLine: number;
    newStartLine: number;
    decision: ReviewDecision;
    oldChars: number;
    newChars: number;
  }>;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 按行比较 before/after，聚合连续删除+新增为一个可审批 hunk */
export function buildReviewModel(before: string, after: string): ReviewModel {
  if (before === after) {
    return { before, after, hunks: [], addedChars: 0, removedChars: 0, addedLines: 0, removedLines: 0 };
  }
  const parts = diffLines(before, after);
  const hunks: ReviewHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let addedChars = 0;
  let removedChars = 0;
  let addedLines = 0;
  let removedLines = 0;
  let current: { oldText: string; newText: string; oldStartLine: number; newStartLine: number } | null = null;

  const flush = (): void => {
    if (!current) return;
    const oldText = current.oldText;
    const newText = current.newText;
    if (!oldText && !newText) {
      current = null;
      return;
    }
    hunks.push({
      id: `h${hunks.length + 1}`,
      kind: !oldText ? 'add' : !newText ? 'delete' : 'change',
      oldStartLine: current.oldStartLine,
      newStartLine: current.newStartLine,
      oldLines: splitLines(oldText),
      newLines: splitLines(newText),
      oldText,
      newText,
    });
    current = null;
  };

  for (const part of parts) {
    if (part.removed || part.added) {
      if (!current) {
        current = { oldText: '', newText: '', oldStartLine: oldLine, newStartLine: newLine };
      }
      const value = part.value;
      if (part.removed) {
        current.oldText += value;
        removedChars += value.length;
        removedLines += lineCount(value);
        oldLine += lineCount(value);
      } else {
        current.newText += value;
        addedChars += value.length;
        addedLines += lineCount(value);
        newLine += lineCount(value);
      }
      continue;
    }
    flush();
    const count = lineCount(part.value);
    oldLine += count;
    newLine += count;
  }
  flush();
  return { before, after, hunks, addedChars, removedChars, addedLines, removedLines };
}

/**
 * 根据审批结果重建最终文本。
 * 只有明确 approved 的 hunk 采用新文本；pending / rejected / 未知 id 都保留原文。
 */
export function applyReviewDecisions(
  model: ReviewModel,
  decisions: Readonly<Record<string, ReviewDecision>>,
): string {
  if (model.hunks.length === 0) return model.before;
  const parts = diffLines(model.before, model.after);
  let result = '';
  let hunkIndex = 0;
  let group: { oldText: string; newText: string } | null = null;

  const flush = (): void => {
    if (!group) return;
    const hunk = model.hunks[hunkIndex];
    hunkIndex += 1;
    const decision = hunk ? decisions[hunk.id] : undefined;
    const approved = decision === 'approved';
    result += approved ? group.newText : group.oldText;
    group = null;
  };

  for (const part of parts) {
    if (part.removed || part.added) {
      if (!group) group = { oldText: '', newText: '' };
      if (part.removed) group.oldText += part.value;
      else group.newText += part.value;
      continue;
    }
    flush();
    result += part.value;
  }
  flush();
  return result;
}

export function makeReviewSummary(model: ReviewModel, decisions: Record<string, ReviewDecision>, finalText: string): ReviewSummary {
  const counts = { approved: 0, rejected: 0, pending: 0 };
  const detail = model.hunks.map((hunk) => {
    const decision = decisions[hunk.id] ?? 'pending';
    counts[decision] += 1;
    return {
      id: hunk.id,
      kind: hunk.kind,
      oldStartLine: hunk.oldStartLine,
      newStartLine: hunk.newStartLine,
      decision,
      oldChars: hunk.oldText.length,
      newChars: hunk.newText.length,
    };
  });
  return {
    total: model.hunks.length,
    ...counts,
    resultChars: finalText.length,
    decisions: detail,
  };
}

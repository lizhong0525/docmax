/**
 * 差异计算（供 UI 做「修改前 / 修改后」审阅）。
 *
 * 中文没有空格，纯按空白分词会把整句当成一个 token，diff 会退化成整段替换。
 * 这里用 Intl.Segmenter 做词级切分（含中文分词），并把空白、换行、标点单独成 token，
 * 使差异高亮足够细，同时保持较低的计算成本。
 */
import { diffArrays } from 'diff';

export type DiffSegmentType = 'equal' | 'removed' | 'added';

export interface DiffSegment {
  type: DiffSegmentType;
  text: string;
}

export interface DiffResult {
  segments: DiffSegment[];
  removedChars: number;
  addedChars: number;
  /** 是否完全相同 */
  identical: boolean;
}

type Segmenter = new (locale: string, options: { granularity: 'word' | 'grapheme' }) => {
  segment(input: string): Iterable<{ segment: string }>;
};

function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const SegmenterCtor = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  // 按行切分，保留换行 token
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (idx > 0) tokens.push('\n');
    if (!line) return;
    if (SegmenterCtor) {
      try {
        const seg = new SegmenterCtor('zh', { granularity: 'word' });
        for (const { segment } of seg.segment(line)) {
          // 每个 segment 独立成为 token：中文没有空格，若把非空白 segment 累积
          // 到下一个空白才输出，整行会退化成一个 token，diff 就变成整行替换。
          tokens.push(segment);
        }
        return;
      } catch {
        // fall through
      }
    }
    // 退化：按字符 + 空白切分
    for (const ch of line) {
      if (/^\s+$/.test(ch)) tokens.push(ch);
      else tokens.push(ch);
    }
  });
  return tokens;
}

export function computeDiff(before: string, after: string): DiffResult {
  if (before === after) {
    return { segments: before ? [{ type: 'equal', text: before }] : [], removedChars: 0, addedChars: 0, identical: true };
  }
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  const parts = diffArrays(beforeTokens, afterTokens);
  const segments: DiffSegment[] = [];
  let removedChars = 0;
  let addedChars = 0;
  const push = (type: DiffSegmentType, text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };
  for (const part of parts) {
    const text = part.value.join('');
    if (part.added) {
      addedChars += text.length;
      push('added', text);
    } else if (part.removed) {
      removedChars += text.length;
      push('removed', text);
    } else {
      push('equal', text);
    }
  }
  return { segments, removedChars, addedChars, identical: false };
}

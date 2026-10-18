/**
 * 选区快照与本地（确定性）选区识别。
 *
 * 这是「最完善的选区识别」的第一层：不依赖模型，本地立刻算出选区的精确边界、
 * Markdown 块类型、是否位于代码块内、是否截断英文单词、标记是否不平衡等。
 * 这些事实会：1) 显示在 UI 里让用户确认模型看到的是什么；2) 作为结构化提示
 * 发给模型，让模型不会误判选区边界。
 */
import type { BlockKind, LocalSelectionAnalysis, RangeSnapshot } from './types';

export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const WORD_CHAR = /[A-Za-z0-9_]/;
const LATIN_WORD_CHAR = /[A-Za-z0-9_'’]/;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function lineStartAt(doc: string, pos: number): number {
  const idx = doc.lastIndexOf('\n', Math.max(0, pos - 1));
  return idx < 0 ? 0 : idx + 1;
}

/** 返回 pos 所在行的结束位置（不含换行符；行尾即文档末尾时返回 doc.length） */
export function lineEndAt(doc: string, pos: number): number {
  const idx = doc.indexOf('\n', pos);
  return idx < 0 ? doc.length : idx;
}

export function lineNumberAt(doc: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < doc.length; i++) if (doc[i] === '\n') line++;
  return line;
}

interface LineInfo {
  text: string;
  /** 去掉行首缩进后的文本 */
  trimmed: string;
  isFence: boolean;
  fenceChar: '`' | '~' | null;
  fenceLang: string | null;
}

function inspectLine(line: string): LineInfo {
  const trimmed = line.trim();
  const fence = trimmed.match(/^(`{3,}|~{3,})\s*([a-zA-Z0-9_+.-]*)/);
  return {
    text: line,
    trimmed,
    isFence: !!fence,
    fenceChar: fence ? (fence[1][0] as '`' | '~') : null,
    fenceLang: fence && fence[2] ? fence[2] : null,
  };
}

interface FenceState {
  inside: boolean;
  lang: string | null;
  char: '`' | '~' | null;
}

/** 计算某个 offset 之前的代码围栏状态（offset 位于围栏行本身上时，inside 为该行之前的状态） */
function fenceStateBefore(doc: string, offset: number): FenceState {
  const state: FenceState = { inside: false, lang: null, char: null };
  let lineStart = 0;
  while (lineStart < offset) {
    let lineEnd = doc.indexOf('\n', lineStart);
    if (lineEnd < 0 || lineEnd >= offset) lineEnd = Math.min(offset, doc.length);
    const info = inspectLine(doc.slice(lineStart, lineEnd));
    if (info.isFence) {
      if (!state.inside) {
        state.inside = true;
        state.lang = info.fenceLang;
        state.char = info.fenceChar;
      } else if (state.char === info.fenceChar) {
        state.inside = false;
        state.lang = null;
        state.char = null;
      }
    }
    if (lineEnd >= offset) break;
    lineStart = lineEnd + 1;
  }
  return state;
}

function lineBlockKind(doc: string, lineStart: number, lineEnd: number, fence: FenceState): BlockKind {
  if (fence.inside) return 'code';
  const raw = doc.slice(lineStart, lineEnd);
  const t = raw.trim();
  if (!t) return 'empty';
  if (/^(`{3,}|~{3,})/.test(t)) return 'code';
  if (/^#{1,6}(\s|$)/.test(t)) return 'heading';
  if (/^([-*+]|\d{1,9}[.)])(\s|$)/.test(t)) return 'list';
  if (/^>/.test(t)) return 'blockquote';
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return 'hr';
  if (/^<[a-zA-Z!/?]/.test(t)) return 'html';
  // 表格分隔行本身（| --- | --- |）也要识别为表格
  if (t.includes('|') && /^\|?[\s:|-]+\|?$/.test(t) && /-{3,}/.test(t)) return 'table';
  if (isTableLine(doc, lineStart, lineEnd)) return 'table';
  return 'paragraph';
}

function isTableLine(doc: string, lineStart: number, lineEnd: number): boolean {
  const line = doc.slice(lineStart, lineEnd).trim();
  if (!line.includes('|')) return false;
  // 向下看一行：数据行紧跟分隔行
  const nextStart = lineEnd + 1;
  if (nextStart < doc.length) {
    let nextEnd = doc.indexOf('\n', nextStart);
    if (nextEnd < 0) nextEnd = doc.length;
    const next = doc.slice(nextStart, nextEnd).trim();
    if (/^\|?[\s:|-]+\|?$/.test(next) && next.includes('-')) return true;
  }
  // 向上找表格块起点：同一表格块内任意一行是分隔行即判定为表格
  let start = lineStart;
  for (let i = 0; i < 50 && start > 0; i++) {
    const prevEnd = start - 1;
    const prevStart = doc.lastIndexOf('\n', prevEnd - 1) + 1;
    const prev = doc.slice(prevStart, prevEnd).trim();
    if (!prev || !prev.includes('|')) break;
    if (/^\|?[\s:|-]+\|?$/.test(prev) && prev.includes('-')) return true;
    start = prevStart;
  }
  return false;
}

/** Markdown frontmatter 区间（文档以 --- 开头且存在闭合行） */
function frontmatterRange(doc: string): { start: number; end: number } | null {
  if (!doc.startsWith('---')) return null;
  const firstLineEnd = doc.indexOf('\n');
  if (firstLineEnd < 0) return null;
  if (doc.slice(0, firstLineEnd).trim() !== '---') return null;
  let pos = firstLineEnd + 1;
  for (let i = 0; i < 200 && pos < doc.length; i++) {
    const end = doc.indexOf('\n', pos);
    const lineEnd = end < 0 ? doc.length : end;
    const line = doc.slice(pos, lineEnd).trim();
    if (line === '---' || line === '...') return { start: 0, end: lineEnd };
    pos = lineEnd + 1;
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  if (!matches) return 0;
  let words = 0;
  for (const m of matches) {
    words += CJK_CHAR.test(m) ? 1 : 1;
  }
  return words;
}

/** 本地选区识别：确定性、无模型依赖 */
export function analyzeSelection(doc: string, from: number, to: number, index = 0): LocalSelectionAnalysis {
  const safeFrom = Math.max(0, Math.min(from, doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length));
  const text = doc.slice(safeFrom, safeTo);
  const chars = text.length;
  const lines = chars === 0 ? 0 : text.split('\n').length;
  const startLine = lineNumberAt(doc, safeFrom);
  const endLine = chars === 0 ? startLine : lineNumberAt(doc, Math.max(safeFrom, safeTo - 1));

  const fenceBefore = fenceStateBefore(doc, safeFrom);
  const selLineStart = lineStartAt(doc, safeFrom);
  const selLineEnd = lineEndAt(doc, safeFrom);
  const selLineTrim = doc.slice(selLineStart, selLineEnd).trim();

  // 选区结束位置所在行（用于确定块类型与是否行中结束）
  const endPos = safeTo > safeFrom ? safeTo - 1 : safeTo;
  const endFence = fenceStateBefore(doc, endPos);
  const endLineStart = lineStartAt(doc, endPos);
  const endLineEnd = lineEndAt(doc, endPos);

  let blockKind: BlockKind;
  if (chars === 0) {
    blockKind = fenceBefore.inside ? 'code' : lineBlockKind(doc, selLineStart, selLineEnd, fenceBefore);
  } else if (fenceBefore.inside && endFence.inside) {
    blockKind = 'code';
  } else if (fenceBefore.inside || endFence.inside) {
    blockKind = 'code';
  } else {
    const startKind = lineBlockKind(doc, selLineStart, selLineEnd, fenceBefore);
    const endKind = lineBlockKind(doc, endLineStart, endLineEnd, endFence);
    blockKind = startKind === endKind ? startKind : startKind === 'empty' ? endKind : startKind;
  }

  // frontmatter 覆盖：文档头部 --- 区间内一律视为 frontmatter
  const frontmatter = frontmatterRange(doc);
  if (frontmatter && safeFrom >= frontmatter.start && safeTo <= frontmatter.end) {
    blockKind = 'frontmatter';
  }

  // 是否跨多个块：扫描选区覆盖的行，块类型出现两种以上
  const touchedKinds = new Set<BlockKind>();
  if (chars > 0) {
    let lineStart = selLineStart;
    while (lineStart < safeTo) {
      let lineEnd = doc.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = doc.length;
      const fenceAt = fenceStateBefore(doc, lineStart);
      const kind = lineBlockKind(doc, lineStart, Math.min(lineEnd, doc.length), fenceAt);
      if (kind !== 'empty') touchedKinds.add(kind);
      if (lineEnd >= safeTo) break;
      lineStart = lineEnd + 1;
    }
  }
  const spansMultipleBlocks = blockKind === 'frontmatter' ? false : touchedKinds.size > 1;

  // 边界字/词判断
  const beforeChar = safeFrom > 0 ? doc[safeFrom - 1] : '';
  const firstChar = safeFrom < doc.length ? doc[safeFrom] : '';
  const lastChar = safeFrom < safeTo ? doc[safeTo - 1] : '';
  const afterChar = safeTo < doc.length ? doc[safeTo] : '';
  const startsMidWord = !!beforeChar && !!firstChar && WORD_CHAR.test(beforeChar) && WORD_CHAR.test(firstChar);
  const endsMidWord = !!lastChar && !!afterChar && WORD_CHAR.test(lastChar) && WORD_CHAR.test(afterChar);
  const startsMidLine = /[^\s]/.test(doc.slice(selLineStart, safeFrom));
  const endsMidLine = /[^\s]/.test(doc.slice(safeTo, endLineEnd)) && safeTo > safeFrom;

  // Markdown 标记不平衡检查（选区本身）
  const delimiterWarnings: string[] = [];
  if (blockKind !== 'code') {
    const boldCount = countOccurrences(text, '**');
    const singleStar = countOccurrences(text.replace(/\*\*/g, ''), '*');
    const backtickCount = countOccurrences(text.replace(/```/g, ''), '`');
    const openBracket = countOccurrences(text, '[');
    const closeBracket = countOccurrences(text, ']');
    if (boldCount % 2 === 1) delimiterWarnings.push('加粗标记 ** 数量不成对');
    if (singleStar % 2 === 1) delimiterWarnings.push('斜体标记 * 数量不成对');
    if (backtickCount % 2 === 1) delimiterWarnings.push('行内代码反引号数量不成对');
    if (openBracket !== closeBracket) delimiterWarnings.push('链接方括号 [ ] 数量不成对');
  } else if (text.includes('```')) {
    const fenceCount = countOccurrences(text, '```');
    if (fenceCount % 2 === 1) delimiterWarnings.push('选区内代码围栏不成对');
  }

  const suggestions: string[] = [];
  if (startsMidWord || endsMidWord) suggestions.push('选区截断了英文单词，建议扩展到完整单词');
  if (spansMultipleBlocks) suggestions.push('选区跨多个 Markdown 块，模型会保持各块结构');
  if (blockKind === 'code') suggestions.push('选区位于代码块内，模型只修改代码内容');
  if (startsMidLine && endsMidLine && chars > 0 && chars < 60) suggestions.push('选区是行内片段，模型会输出自然衔接的替换片段');
  if (chars > 3000) suggestions.push('选区较长，可考虑“局部精准修改”模式以降低延迟');

  return {
    index,
    chars,
    words: countWords(text),
    lines,
    blockKind,
    codeFenceLang: fenceBefore.inside ? fenceBefore.lang : selLineTrim.match(/^(`{3,}|~{3,})\s*([a-zA-Z0-9_+.-]*)/)?.[2] || null,
    startsMidWord,
    endsMidWord,
    startsMidLine,
    endsMidLine,
    delimiterWarnings,
    spansMultipleBlocks,
    suggestions,
    startLine,
    endLine,
    boundary: {
      before: doc.slice(Math.max(0, safeFrom - 12), safeFrom),
      after: doc.slice(safeTo, Math.min(doc.length, safeTo + 12)),
    },
  };
}

export interface RawSelection {
  from: number;
  to: number;
  anchor?: number;
  head?: number;
}

/** 构造选区快照（携带精确原文、指纹与前后文） */
export function buildRangeSnapshot(
  doc: string,
  sel: RawSelection,
  index: number,
  contextChars: number,
): RangeSnapshot {
  const from = Math.max(0, Math.min(sel.from, doc.length));
  const to = Math.max(from, Math.min(sel.to, doc.length));
  const text = doc.slice(from, to);
  // 上下文按整行扩展，避免把半行发给模型
  const beforeLine = lineStartAt(doc, from);
  const beforeStart = Math.max(0, beforeLine - Math.max(0, contextChars));
  const afterLineEnd = lineEndAt(doc, to);
  const afterEnd = Math.min(doc.length, afterLineEnd + Math.max(0, contextChars));
  return {
    index,
    from,
    to,
    anchor: sel.anchor ?? from,
    head: sel.head ?? to,
    text,
    hash: fnv1a32(text),
    before: doc.slice(beforeStart, from),
    after: doc.slice(to, afterEnd),
  };
}

/** 校验快照是否仍然有效（文档未被修改过该区间） */
export function isSnapshotFresh(doc: string, range: Pick<RangeSnapshot, 'from' | 'to' | 'text'>): boolean {
  if (range.from < 0 || range.to > doc.length || range.from > range.to) return false;
  return doc.slice(range.from, range.to) === range.text;
}

export type ExpandUnit = 'word' | 'line' | 'paragraph' | 'block';

/** 智能扩展选区：双击/快捷键之外，给用户一个“扩大选区到自然边界”的能力 */
export function expandRange(doc: string, from: number, to: number, unit: ExpandUnit): { from: number; to: number } {
  let start = Math.max(0, Math.min(from, doc.length));
  let end = Math.max(start, Math.min(to, doc.length));

  if (unit === 'word') {
    while (start > 0 && WORD_CHAR.test(doc[start - 1])) start--;
    while (end < doc.length && WORD_CHAR.test(doc[end])) end++;
    return { from: start, to: end };
  }
  if (unit === 'line') {
    return { from: lineStartAt(doc, start), to: lineEndAt(doc, Math.max(start, end)) };
  }
  // paragraph / block：扩展到空行或结构块边界
  const baseLine = lineStartAt(doc, start);
  const fence = fenceStateBefore(doc, start);
  let s = baseLine;
  if (!fence.inside) {
    while (s > 0) {
      const prevEnd = s - 1;
      const prevStart = lineStartAt(doc, prevEnd);
      const prevLine = doc.slice(prevStart, prevEnd).trim();
      if (!prevLine) break;
      const prevKind = lineBlockKind(doc, prevStart, prevEnd, fenceStateBefore(doc, prevStart));
      const curKind = lineBlockKind(doc, baseLine, lineEndAt(doc, start), fence);
      if (unit === 'block' && prevKind !== curKind) break;
      if (unit === 'paragraph' && /^(#{1,6}\s|>|([-*+]|\d{1,9}[.)])\s)/.test(prevLine)) break;
      s = prevStart;
    }
  }
  let e = lineEndAt(doc, Math.max(start, end));
  if (!fence.inside) {
    while (e < doc.length) {
      const nextStart = e + 1;
      const nextEnd = lineEndAt(doc, nextStart);
      const nextLine = doc.slice(nextStart, nextEnd).trim();
      if (!nextLine) break;
      const nextKind = lineBlockKind(doc, nextStart, nextEnd, fenceStateBefore(doc, nextStart));
      const curKind = blockKindAt(doc, start);
      if (unit === 'block' && nextKind !== curKind) break;
      if (unit === 'paragraph' && /^(#{1,6}\s|>|([-*+]|\d{1,9}[.)])\s)/.test(nextLine)) break;
      e = nextEnd;
    }
  }
  return { from: s, to: e };
}

function blockKindAt(doc: string, pos: number): BlockKind {
  const lineStart = lineStartAt(doc, pos);
  const lineEnd = lineEndAt(doc, pos);
  return lineBlockKind(doc, lineStart, lineEnd, fenceStateBefore(doc, pos));
}

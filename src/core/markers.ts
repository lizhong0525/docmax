/**
 * 模型输出协议标记（sentinel）。
 *
 * 为什么要 per-request 标记：文档内容本身可能包含 "<<<EDIT>>>" 这类字符串
 * （例如文档在讨论本工具）。一旦发生碰撞，就为本次请求生成带随机后缀的标记，
 * 避免解析错位，也降低文档内伪造标记带来的注入风险。
 */

export interface Markers {
  analysisStart: string;
  analysisEnd: string;
  editStart: string;
  editEnd: string;
  findStart: string;
  findAllStart: string;
  replaceStart: string;
  blockEnd: string;
  answerStart: string;
  answerEnd: string;
  /** null 表示使用默认标记；否则为随机后缀 */
  nonce: string | null;
}

const BASE: Markers = {
  analysisStart: '<<<ANALYSIS>>>',
  analysisEnd: '<<<END_ANALYSIS>>>',
  editStart: '<<<EDIT>>>',
  editEnd: '<<<END_EDIT>>>',
  findStart: '<<<FIND>>>',
  findAllStart: '<<<FIND_ALL>>>',
  replaceStart: '<<<REPLACE>>>',
  blockEnd: '<<<END>>>',
  answerStart: '<<<ANSWER>>>',
  answerEnd: '<<<END_ANSWER>>>',
  nonce: null,
};

const ALL_MARKER_VALUES = [
  BASE.analysisStart,
  BASE.analysisEnd,
  BASE.editStart,
  BASE.editEnd,
  BASE.findStart,
  BASE.findAllStart,
  BASE.replaceStart,
  BASE.blockEnd,
  BASE.answerStart,
  BASE.answerEnd,
];

function randomHex(bytes: number): string {
  const g = globalThis as { crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const arr = new Uint8Array(bytes);
    g.crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 2 + bytes * 2);
}

/** 若文本（文档/指令/上下文）包含任何默认标记，则返回带随机后缀的标记集合 */
export function createMarkers(collisionTexts: string[]): Markers {
  const joined = collisionTexts.join('\n');
  if (!ALL_MARKER_VALUES.some((m) => joined.includes(m))) {
    return { ...BASE };
  }
  const nonce = randomHex(4);
  const suffix = (m: string) => m.replace(/>>>$/, `:${nonce}>>>`);
  return {
    analysisStart: suffix(BASE.analysisStart),
    analysisEnd: suffix(BASE.analysisEnd),
    editStart: suffix(BASE.editStart),
    editEnd: suffix(BASE.editEnd),
    findStart: suffix(BASE.findStart),
    findAllStart: suffix(BASE.findAllStart),
    replaceStart: suffix(BASE.replaceStart),
    blockEnd: suffix(BASE.blockEnd),
    answerStart: suffix(BASE.answerStart),
    answerEnd: suffix(BASE.answerEnd),
    nonce,
  };
}

/** 从任意文本中移除分析块（用于无标记时的兜底提取） */
export function stripAnalysisBlock(raw: string, markers: Markers): string {
  const start = raw.indexOf(markers.analysisStart);
  if (start < 0) return raw;
  const end = raw.indexOf(markers.analysisEnd, start);
  if (end < 0) return raw;
  return raw.slice(0, start) + raw.slice(end + markers.analysisEnd.length);
}

/** 去掉恰好一个首尾换行（模型习惯把内容放在标记的下一行） */
export function stripOuterNewlines(s: string): string {
  let out = s;
  if (out.startsWith('\r\n')) out = out.slice(2);
  else if (out.startsWith('\n')) out = out.slice(1);
  if (out.endsWith('\r\n')) out = out.slice(0, -2);
  else if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

/** 去掉包裹内容的 markdown 代码围栏（仅在确定是“包裹”而非内容本身时使用） */
export function stripWrapperFence(text: string): { text: string; stripped: boolean } {
  const lines = text.split('\n');
  if (lines.length < 2) return { text, stripped: false };
  const first = lines[0].trim();
  if (!/^```[a-zA-Z0-9_+.-]*$/.test(first)) return { text, stripped: false };
  // 找到结尾围栏
  let end = lines.length - 1;
  while (end > 0 && lines[end].trim() === '') end--;
  if (end <= 0) return { text, stripped: false };
  if (lines[end].trim() !== '```') return { text, stripped: false };
  const inner = lines.slice(1, end).join('\n');
  return { text: inner, stripped: true };
}

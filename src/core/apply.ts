/**
 * 修改校验与应用引擎 —— 全系统最关键的安全层。
 *
 * 核心原则：模型输出永远是「不可信输入」。任何内容在变成可应用的提案之前必须：
 *  1) 被结构化解析（parse.ts）；
 *  2) 若是 surgical 模式，锚点必须在选区内被真实找到（exact → 空白灵活 → 行级模糊）；
 *  3) 通过结构校验（Markdown 围栏/标记/表格/边界）；
 *  4) 在应用前再次与文档快照逐字比对，避免用户中途编辑导致错位。
 *
 * 任何一步失败都返回诊断信息，服务端据此触发一次「修复重试」，绝不静默应用。
 */
import { diffChars } from 'diff';
import { stripWrapperFence } from './markers';
import type { ParsedEditBlock, ParseResult } from './parse';
import type {
  AppliedEdit,
  ApplyResult,
  ApplyStrategy,
  EditProposal,
  EditRequest,
  EditStats,
  LocalSelectionAnalysis,
  ProposalOp,
  ProposalWarning,
  RangeSnapshot,
  Timings,
  Usage,
} from './types';
import { lineStartAt, lineEndAt, lineNumberAt } from './selection';

/* ------------------------------------------------------------------ */
/* 锚点匹配                                                            */
/* ------------------------------------------------------------------ */

export interface AnchorMatch {
  start: number;
  end: number;
  strategy: 'exact' | 'flexible-whitespace' | 'fuzzy-line';
  score?: number;
}

export interface AnchorFailure {
  reason: 'not-found' | 'ambiguous';
  occurrences: number;
  candidates: string[];
}

export type AnchorResult = { ok: true; match: AnchorMatch } | { ok: false; failure: AnchorFailure };

function collectOccurrences(haystack: string, needle: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push({ start: i, end: i + needle.length });
    from = i + Math.max(1, needle.length);
  }
  return out;
}

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const parts = diffChars(a, b);
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.value.length;
  return (2 * same) / (a.length + b.length);
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function buildCandidates(haystack: string, find: string, limit = 3): string[] {
  const findLines = find.split('\n').map(normalizeLine).filter(Boolean);
  const hayLines = haystack.split('\n');
  const scored = hayLines
    .map((line, i) => ({ line, i, score: findLines.length ? Math.max(...findLines.map((f) => diceSimilarity(f, normalizeLine(line)))) : 0 }))
    .filter((x) => x.line.trim().length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => `第 ${x.i + 1} 行: ${x.line.length > 160 ? x.line.slice(0, 160) + '…' : x.line}`);
  return scored;
}

/** 空白灵活匹配：把空白差异视为等价 */
function flexibleWhitespaceMatches(haystack: string, find: string): Array<{ start: number; end: number }> {
  const tokens = find.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = tokens.map(escape).join('\\s+');
  const re = new RegExp(pattern, 'g');
  const out: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length > 2) break;
    re.lastIndex = m.index + Math.max(1, m[0].length);
  }
  return out;
}

/** 忽略所有空白后匹配（处理 CJK 空格插入/删除），返回原始坐标 */
function compactMatches(haystack: string, find: string): Array<{ start: number; end: number }> {
  const compactFind = find.replace(/\s+/g, '');
  if (compactFind.length < 3) return [];
  let compactHay = '';
  const map: number[] = [];
  for (let i = 0; i < haystack.length; i++) {
    if (/\s/.test(haystack[i])) continue;
    compactHay += haystack[i];
    map.push(i);
  }
  const positions: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const idx = compactHay.indexOf(compactFind, from);
    if (idx < 0) break;
    const start = map[idx];
    const end = map[idx + compactFind.length - 1] + 1;
    positions.push({ start, end });
    if (positions.length > 2) break;
    from = idx + Math.max(1, compactFind.length);
  }
  return positions;
}

function fuzzyLineMatches(haystack: string, find: string): Array<{ start: number; end: number; score: number }> {
  const findLines = find.split('\n');
  const findNorm = findLines.map(normalizeLine);
  const nonEmptyFind = findNorm.filter(Boolean);
  if (!nonEmptyFind.length) return [];
  const hayLines: Array<{ text: string; start: number; end: number }> = [];
  let pos = 0;
  for (const line of haystack.split('\n')) {
    hayLines.push({ text: line, start: pos, end: pos + line.length });
    pos += line.length + 1;
  }
  const results: Array<{ start: number; end: number; score: number }> = [];
  const sizes = findLines.length === 1 ? [1] : [findLines.length - 1, findLines.length, findLines.length + 1];
  for (const size of sizes) {
    if (size < 1) continue;
    for (let i = 0; i + size <= hayLines.length; i++) {
      const windowLines = hayLines.slice(i, i + size);
      const windowNorm = windowLines.map((l) => normalizeLine(l.text));
      const nonEmptyWindow = windowNorm.filter(Boolean);
      if (!nonEmptyWindow.length) continue;
      // 行数不同则按较短者对齐计算（多/少一行视为部分缺失）
      const n = Math.min(nonEmptyWindow.length, nonEmptyFind.length);
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += diceSimilarity(nonEmptyFind[k], nonEmptyWindow[k]);
      }
      const score = sum / Math.max(nonEmptyWindow.length, nonEmptyFind.length);
      if (score > 0.86) {
        results.push({
          start: windowLines[0].start,
          end: windowLines[windowLines.length - 1].end,
          score,
        });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const second = results[1];
  if (!best) return [];
  if (second && best.score - second.score < 0.05) return []; // 太接近，模糊匹配不安全
  return [best];
}

/**
 * 在选区文本中寻找模型给出的锚点。
 * 逐层放宽：精确 → 空白灵活 → 去空白 → 行级模糊；任何出现多次的匹配都判为歧义。
 */
export function matchAnchor(haystack: string, find: string, opts: { allowFuzzy?: boolean } = {}): AnchorResult {
  const raw = find;
  if (!raw.trim()) {
    return { ok: false, failure: { reason: 'not-found', occurrences: 0, candidates: [] } };
  }

  const exact = collectOccurrences(haystack, raw);
  if (exact.length === 1) return { ok: true, match: { ...exact[0], strategy: 'exact' } };
  if (exact.length > 1) {
    return { ok: false, failure: { reason: 'ambiguous', occurrences: exact.length, candidates: buildCandidates(haystack, raw) } };
  }

  const flexible = flexibleWhitespaceMatches(haystack, raw);
  if (flexible.length === 1) return { ok: true, match: { ...flexible[0], strategy: 'flexible-whitespace' } };
  if (flexible.length > 1) {
    return { ok: false, failure: { reason: 'ambiguous', occurrences: flexible.length, candidates: buildCandidates(haystack, raw) } };
  }

  const compact = compactMatches(haystack, raw);
  if (compact.length === 1) return { ok: true, match: { ...compact[0], strategy: 'flexible-whitespace' } };
  if (compact.length > 1) {
    return { ok: false, failure: { reason: 'ambiguous', occurrences: compact.length, candidates: buildCandidates(haystack, raw) } };
  }

  if (opts.allowFuzzy !== false) {
    const fuzzy = fuzzyLineMatches(haystack, raw);
    if (fuzzy.length === 1) return { ok: true, match: { ...fuzzy[0], strategy: 'fuzzy-line' } };
  }

  return { ok: false, failure: { reason: 'not-found', occurrences: 0, candidates: buildCandidates(haystack, raw) } };
}

/* ------------------------------------------------------------------ */
/* surgical（FIND/REPLACE）应用                                        */
/* ------------------------------------------------------------------ */

export interface SurgicalFailure {
  blockIndex: number;
  find: string;
  kind: 'find' | 'find-all';
  reason: 'not-found' | 'ambiguous' | 'overlap' | 'empty-anchor';
  occurrences: number;
  candidates: string[];
}

export interface SurgicalResult {
  ok: boolean;
  newText: string;
  applied: AppliedEdit[];
  failures: SurgicalFailure[];
}

export function applySurgicalEdits(
  rangeText: string,
  blocks: ParsedEditBlock[],
  opts: { allowFuzzy?: boolean } = {},
): SurgicalResult {
  interface Resolved {
    start: number;
    end: number;
    replace: string;
    edit: AppliedEdit;
  }
  const resolved: Resolved[] = [];
  const failures: SurgicalFailure[] = [];

  blocks.forEach((block, blockIndex) => {
    const line = lineNumberAt(rangeText, 0);
    if (block.kind === 'find-all') {
      const occurrences = collectOccurrences(rangeText, block.find);
      if (!occurrences.length) {
        failures.push({
          blockIndex,
          find: block.find,
          kind: block.kind,
          reason: 'not-found',
          occurrences: 0,
          candidates: buildCandidates(rangeText, block.find),
        });
        return;
      }
      for (const occ of occurrences) {
        resolved.push({
          start: occ.start,
          end: occ.end,
          replace: block.replace,
          edit: { find: block.find, replace: block.replace, strategy: 'exact', line: lineNumberAt(rangeText, occ.start) },
        });
      }
      return;
    }
    const result = matchAnchor(rangeText, block.find, opts);
    if (!result.ok) {
      failures.push({
        blockIndex,
        find: block.find,
        kind: block.kind,
        reason: result.failure.reason === 'ambiguous' ? 'ambiguous' : 'not-found',
        occurrences: result.failure.occurrences,
        candidates: result.failure.candidates,
      });
      return;
    }
    resolved.push({
      start: result.match.start,
      end: result.match.end,
      replace: block.replace,
      edit: {
        find: block.find,
        replace: block.replace,
        strategy: result.match.strategy,
        line: lineNumberAt(rangeText, result.match.start),
      },
    });
  });

  if (failures.length) {
    return { ok: false, newText: rangeText, applied: [], failures };
  }

  // 重叠检测
  resolved.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const cur = resolved[i];
    if (cur.start < prev.end) {
      return {
        ok: false,
        newText: rangeText,
        applied: resolved.map((r) => r.edit),
        failures: [
          {
            blockIndex: -1,
            find: cur.edit.find,
            kind: 'find',
            reason: 'overlap',
            occurrences: 1,
            candidates: [prev.edit.find, cur.edit.find],
          },
        ],
      };
    }
  }

  let newText = rangeText;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    newText = newText.slice(0, r.start) + r.replace + newText.slice(r.end);
  }
  return { ok: true, newText, applied: resolved.map((r) => r.edit), failures: [] };
}

/* ------------------------------------------------------------------ */
/* 格式化清洁与结构校验                                                */
/* ------------------------------------------------------------------ */

const PREAMBLE_RE = /^(好的|当然|没问题|以下是|这是|修改后|Here(?:'s| is)|Sure)[^\n]{0,40}[:：]\s*$/i;

export function sanitizeReplacement(
  rawText: string,
  oldText: string,
  analysis: LocalSelectionAnalysis,
  sanitize: boolean,
): { text: string; warnings: ProposalWarning[] } {
  let text = rawText;
  const warnings: ProposalWarning[] = [];
  text = text.replace(/\r\n/g, '\n');
  if (!sanitize) return { text, warnings };

  const codeLike = analysis.blockKind === 'code' || /^\s*(```|~~~)/.test(oldText);
  if (!codeLike) {
    const fence = stripWrapperFence(text);
    if (fence.stripped) {
      text = fence.text;
      warnings.push({ code: 'format-sanitized', severity: 'info', message: '已自动移除模型包裹在内容外的代码围栏' });
    }
  }
  // 去掉模型常见的“以下是修改后的内容：”前言（仅当首行很短且以冒号结尾）
  const lines = text.split('\n');
  if (lines.length > 1 && PREAMBLE_RE.test(lines[0].trim())) {
    text = lines.slice(1).join('\n');
    warnings.push({ code: 'format-sanitized', severity: 'info', message: '已自动移除模型的前言说明' });
  }
  return { text, warnings };
}

function isBalanced(text: string, token: string): boolean {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(token, from);
    if (i < 0) break;
    count++;
    from = i + token.length;
  }
  return count % 2 === 0;
}

export function validateReplacement(
  oldText: string,
  newText: string,
  analysis: LocalSelectionAnalysis,
  mode: 'rewrite' | 'surgical' | 'insert',
  context?: { before: string; after: string },
): ProposalWarning[] {
  const warnings: ProposalWarning[] = [];
  if (mode !== 'insert' && oldText === newText) {
    warnings.push({ code: 'no-change', severity: 'info', message: '模型认为无需修改（结果与原文一致）' });
    return warnings;
  }
  if (mode !== 'insert' && oldText.trim() && !newText.trim()) {
    warnings.push({ code: 'empty-result', severity: 'warn', message: '模型返回了空内容，接受后会删除该选区' });
  }

  const oldStartsWithFence = /^\s*(```|~~~)/.test(oldText);
  if (analysis.blockKind === 'code' || oldStartsWithFence) {
    if (oldStartsWithFence && !/^\s*(```|~~~)/.test(newText)) {
      warnings.push({ code: 'fence-imbalance', severity: 'warn', message: '原文以代码围栏开头，替换结果没有围栏，可能破坏代码块' });
    } else {
      const fences = (newText.match(/^\s*(```|~~~)/gm) || []).length;
      if (fences % 2 === 1) warnings.push({ code: 'fence-imbalance', severity: 'warn', message: '替换结果中的代码围栏数量为奇数' });
    }
  } else {
    const fences = (newText.match(/^\s*(```|~~~)/gm) || []).length;
    if (fences % 2 === 1) warnings.push({ code: 'fence-imbalance', severity: 'warn', message: '替换结果引入了不完整的代码围栏' });
  }

  const oldHeading = oldText.match(/^\s*(#{1,6})\s/);
  if (oldHeading && !newText.match(/^\s*#{1,6}\s/)) {
    warnings.push({ code: 'heading-marker-dropped', severity: 'warn', message: '原文是标题，替换结果丢失了标题标记' });
  }
  const oldList = oldText.match(/^(\s*)([-*+]|\d{1,9}[.)])\s/);
  if (oldList && !newText.match(/^\s*([-*+]|\d{1,9}[.)])\s/)) {
    warnings.push({ code: 'list-marker-dropped', severity: 'warn', message: '原文是列表项，替换结果丢失了列表标记' });
  }
  const oldQuote = /^\s*>/.test(oldText);
  if (oldQuote && !/^\s*>/.test(newText)) {
    warnings.push({ code: 'delimiter-imbalance', severity: 'warn', message: '原文是引用块，替换结果丢失了引用标记' });
  }
  if (analysis.blockKind === 'table') {
    const lines = newText.split('\n').filter((l) => l.trim());
    if (lines.some((l) => !l.includes('|'))) {
      warnings.push({ code: 'table-structure', severity: 'warn', message: '原文是表格，替换结果中存在不含 | 的行，表格结构可能被破坏' });
    }
  }
  if (analysis.blockKind !== 'code') {
    if (!isBalanced(newText, '**') && isBalanced(oldText, '**')) {
      warnings.push({ code: 'delimiter-imbalance', severity: 'warn', message: '替换结果中的加粗标记 ** 不成对' });
    }
    const oldBackticks = (oldText.match(/`/g) || []).length;
    const newBackticks = (newText.match(/`/g) || []).length;
    if (oldBackticks % 2 === 0 && newBackticks % 2 === 1) {
      warnings.push({ code: 'delimiter-imbalance', severity: 'warn', message: '替换结果中的行内代码反引号不成对' });
    }
  }
  if (analysis.startsMidLine && /^[\n ]/.test(newText) && !/^[\n ]/.test(oldText)) {
    warnings.push({ code: 'whitespace-boundary', severity: 'warn', message: '选区从行中间开始，替换结果以空白开头可能造成多余空格' });
  }
  if (analysis.startsMidWord || analysis.endsMidWord) {
    warnings.push({
      code: 'selection-mid-word',
      severity: 'info',
      message: '选区截断了英文单词，请确认替换结果与上下文拼接后是正确的单词',
    });
  }

  // 上下文泄漏：模型有时会"贴心地"把选区前后文一起返回，这会导致重复内容
  if (context) {
    const beforeProbe = context.before.trim().slice(-80);
    const afterProbe = context.after.trim().slice(0, 80);
    if (beforeProbe.length >= 40 && newText.includes(beforeProbe)) {
      warnings.push({
        code: 'context-leak',
        severity: 'error',
        message: '替换结果中包含选区之前的上下文原文，应用后会出现重复内容，请勿直接接受。',
      });
    }
    if (afterProbe.length >= 40 && newText.includes(afterProbe)) {
      warnings.push({
        code: 'context-leak',
        severity: 'error',
        message: '替换结果中包含选区之后的上下文原文，应用后会出现重复内容，请勿直接接受。',
      });
    }
  }

  // 长度比例异常：与指令无关的巨幅增删值得人工多看一眼
  if (mode !== 'insert' && oldText.length >= 20) {
    const ratio = newText.length / oldText.length;
    if (ratio > 4 || ratio < 0.15) {
      warnings.push({
        code: 'length-ratio',
        severity: 'warn',
        message: `替换结果长度是原文的 ${ratio.toFixed(1)} 倍，幅度较大，请确认符合指令预期。`,
      });
    } else if (ratio > 2.5 || ratio < 0.4) {
      warnings.push({
        code: 'length-ratio',
        severity: 'info',
        message: `替换结果长度是原文的 ${ratio.toFixed(1)} 倍。`,
      });
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export function computeStats(oldText: string, newText: string): EditStats {
  const parts = diffChars(oldText, newText);
  let removedChars = 0;
  let addedChars = 0;
  for (const p of parts) {
    if (p.removed) removedChars += p.value.length;
    else if (p.added) addedChars += p.value.length;
  }
  return { oldChars: oldText.length, newChars: newText.length, removedChars, addedChars };
}

/* ------------------------------------------------------------------ */
/* 提案构建                                                            */
/* ------------------------------------------------------------------ */

export interface RepairHint {
  reason: 'anchor-not-found' | 'anchor-ambiguous' | 'anchor-overlap' | 'format-issue';
  message: string;
}

export interface BuildProposalInput {
  request: EditRequest;
  parsed: ParseResult;
  localAnalyses: LocalSelectionAnalysis[];
  usage: Usage;
  timings: Timings;
  sanitize: boolean;
  allowFuzzy: boolean;
}

export interface BuildProposalResult {
  proposal: EditProposal | null;
  repair: RepairHint | null;
}

function warningFromIssue(issue: string): ProposalWarning {
  return { code: 'other', severity: 'info', message: issue };
}

export function buildProposal(input: BuildProposalInput): BuildProposalResult {
  const { request, parsed, localAnalyses, usage, timings, sanitize, allowFuzzy } = input;
  const range = request.ranges[0];
  if (!range) return { proposal: null, repair: { reason: 'format-issue', message: '请求缺少选区快照' } };
  const local = localAnalyses[0] ?? {
    index: 0,
    chars: range.text.length,
    words: 0,
    lines: 0,
    blockKind: 'paragraph' as const,
    codeFenceLang: null,
    startsMidWord: false,
    endsMidWord: false,
    startsMidLine: false,
    endsMidLine: false,
    delimiterWarnings: [],
    spansMultipleBlocks: false,
    suggestions: [],
    startLine: 1,
    endLine: 1,
    boundary: { before: '', after: '' },
  };
  const warnings: ProposalWarning[] = [];
  if (parsed.truncated) {
    warnings.push({
      code: 'truncated',
      severity: 'error',
      message: '模型输出被截断（缺少结束标记），内容可能不完整。可重试或改用其他模式。',
    });
  }
  if (parsed.missingSentinels) {
    warnings.push({
      code: 'missing-sentinels',
      severity: 'warn',
      message: '模型未按协议输出标记，已按整段替换兜底处理，请仔细检查差异。',
    });
  }
  for (const issue of parsed.issues) warnings.push(warningFromIssue(issue));

  // ask 模式：不产生文档修改
  if (request.options.mode === 'ask') {
    const proposal: EditProposal = {
      requestId: request.requestId,
      docRev: request.docRev,
      mode: 'ask',
      model: request.options.model,
      analysis: parsed.analysis,
      localAnalyses,
      ops: [],
      warnings,
      truncated: parsed.truncated,
      usage,
      timings,
      raw: parsed.raw.slice(0, 20_000),
    };
    return { proposal, repair: null };
  }

  let newText: string;
  let strategy: ApplyStrategy;
  let edits: AppliedEdit[] | undefined;

  if (request.options.mode === 'surgical' && parsed.edits.length > 0) {
    const result = applySurgicalEdits(range.text, parsed.edits, { allowFuzzy });
    if (!result.ok) {
      const parts: string[] = [];
      const ambiguous = result.failures.some((f) => f.reason === 'ambiguous');
      const overlap = result.failures.some((f) => f.reason === 'overlap');
      for (const f of result.failures.slice(0, 4)) {
        if (f.reason === 'overlap') {
          parts.push(`第 ${f.blockIndex + 1} 个块的修改目标与其它块重叠：${JSON.stringify(f.candidates)}`);
        } else if (f.reason === 'ambiguous') {
          parts.push(
            `第 ${f.blockIndex + 1} 个 FIND 在选区内出现 ${f.occurrences} 次，无法确定替换哪一处：${JSON.stringify(f.find.slice(0, 120))}。请让 FIND 包含更多前后文，或改用 FIND_ALL。`,
          );
        } else {
          parts.push(
            `第 ${f.blockIndex + 1} 个 FIND 在选区中找不到：${JSON.stringify(f.find.slice(0, 160))}。选区内相似的行：${f.candidates.join(' | ') || '（无）'}`,
          );
        }
      }
      const hint: RepairHint = {
        reason: overlap ? 'anchor-overlap' : ambiguous ? 'anchor-ambiguous' : 'anchor-not-found',
        message: parts.join('\n'),
      };
      return { proposal: null, repair: hint };
    }
    const sanitized = sanitizeReplacement(result.newText, range.text, local, sanitize);
    newText = sanitized.text;
    warnings.push(...sanitized.warnings);
    strategy = result.applied.some((e) => e.strategy !== 'exact') ? 'search-replace-flexible' : 'search-replace-exact';
    edits = result.applied;
    if (result.applied.some((e) => e.strategy === 'fuzzy-line')) {
      warnings.push({ code: 'fuzzy-match', severity: 'warn', message: '部分锚点使用了模糊匹配定位，请核对差异位置是否正确' });
    }
  } else if (request.options.mode === 'surgical') {
    // 没有任何 FIND 块：
    // - 若模型给了兜底内容，按整段替换处理；
    // - 若输出为空，视为「无需修改」，保留原文（不能把选区删掉）。
    if (!parsed.content.trim()) {
      newText = range.text;
      strategy = 'unchanged';
      warnings.push({ code: 'no-change', severity: 'info', message: '模型未返回任何修改（无需改动）' });
    } else {
      const sanitized = sanitizeReplacement(parsed.content, range.text, local, sanitize);
      newText = sanitized.text;
      warnings.push(...sanitized.warnings);
      strategy = 'fallback-whole-replace';
      warnings.push({
        code: 'fallback-whole-replace',
        severity: 'warn',
        message: '模型没有返回 FIND/REPLACE 块，已按整段替换处理',
      });
    }
  } else {
    const sanitized = sanitizeReplacement(parsed.content, range.text, local, sanitize);
    newText = sanitized.text;
    warnings.push(...sanitized.warnings);
    strategy = request.options.mode === 'insert' ? 'insert' : 'rewrite';
  }

  warnings.push(
    ...validateReplacement(range.text, newText, local, request.options.mode as 'rewrite' | 'surgical' | 'insert', {
      before: range.before,
      after: range.after,
    }),
  );

  const op: ProposalOp = {
    rangeId: range.index,
    from: range.from,
    to: range.to,
    oldText: range.text,
    newText,
    strategy,
    edits,
    stats: computeStats(range.text, newText),
  };

  const proposal: EditProposal = {
    requestId: request.requestId,
    docRev: request.docRev,
    mode: request.options.mode,
    model: request.options.model,
    analysis: parsed.analysis,
    localAnalyses,
    ops: [op],
    warnings: dedupeWarnings(warnings),
    truncated: parsed.truncated,
    usage,
    timings,
    raw: parsed.raw.slice(0, 20_000),
  };
  return { proposal, repair: null };
}

function dedupeWarnings(warnings: ProposalWarning[]): ProposalWarning[] {
  const seen = new Set<string>();
  const out: ProposalWarning[] = [];
  for (const w of warnings) {
    const key = `${w.code}|${w.message}|${w.rangeId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 应用提案                                                            */
/* ------------------------------------------------------------------ */

/** 在应用前逐字校验快照，防止模型耗时期间文档被修改导致错位 */
export function applyProposal(docText: string, proposal: EditProposal): ApplyResult {
  return applyProposals(docText, [proposal]);
}

export function applyProposals(docText: string, proposals: EditProposal[]): ApplyResult & { ranges?: Array<{ from: number; to: number }> } {
  const ops: ProposalOp[] = [];
  for (const p of proposals) for (const op of p.ops) ops.push(op);
  ops.sort((a, b) => a.from - b.from);
  for (const op of ops) {
    if (op.from < 0 || op.to > docText.length || op.from > op.to) {
      return { ok: false, error: '选区偏移超出文档范围，文档可能已被修改，请重新生成。', docText };
    }
    if (docText.slice(op.from, op.to) !== op.oldText) {
      return { ok: false, error: '选区内容已变化（文档在生成期间被修改），请重新生成修改。', docText };
    }
  }
  for (let i = 1; i < ops.length; i++) {
    if (ops[i].from < ops[i - 1].to) {
      return { ok: false, error: '多个修改目标区间重叠，无法应用。', docText };
    }
  }
  let out = docText;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    out = out.slice(0, op.from) + op.newText + out.slice(op.to);
  }
  const ranges = ops.map((op) => ({ from: op.from, to: op.from + op.newText.length }));
  return { ok: true, docText: out, ranges };
}

/** 选区快照完整性检查（服务端收到请求时使用） */
export function validateRequestSnapshot(docText: string, range: RangeSnapshot): string | null {
  if (range.from < 0 || range.to > docText.length || range.from > range.to) return '选区范围非法';
  const actual = docText.slice(range.from, range.to);
  if (actual !== range.text) return '选区快照与文档不一致';
  return null;
}

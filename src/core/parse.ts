/**
 * 流式解析模型输出。
 *
 * 设计目标：
 * 1. 严格标记为主：正常输出必须按 markers.ts 的协议包裹，解析由此确定性完成。
 * 2. 容错为备：模型偶尔会省略块结束标记、多写前言/围栏、或完全不用标记。
 *    解析器必须能识别这些情况并给出结构化结果（truncated / missingSentinels /
 *    issues），交由 apply.ts 做校验与修复，而不是静默应用半截内容。
 * 3. 增量：rewrite/insert 模式边流边发 delta；surgical 模式整段生成，结束时解析。
 */
import { stripAnalysisBlock, stripOuterNewlines, type Markers } from './markers';
import type { EditMode, ModelAnalysis } from './types';

export interface ParsedEditBlock {
  kind: 'find' | 'find-all';
  find: string;
  replace: string;
}

export interface ParseResult {
  analysis: ModelAnalysis | null;
  /** rewrite / insert 的替换文本（已去掉首尾各一个换行） */
  content: string;
  /** surgical 模式的 FIND/REPLACE 块 */
  edits: ParsedEditBlock[];
  /** ask 模式的回答 */
  answer: string;
  /** 输出被截断（缺少结束标记） */
  truncated: boolean;
  /** 完全没有找到预期标记，content/answer 为兜底提取的全文 */
  missingSentinels: boolean;
  hasEditBlock: boolean;
  raw: string;
  issues: string[];
}

export interface StreamParserOptions {
  mode: EditMode;
  markers: Markers;
  /** 是否要求模型输出 analysis 块 */
  expectAnalysis: boolean;
  onAnalysis?: (analysis: ModelAnalysis) => void;
  /** rewrite / insert 的增量文本 */
  onDelta?: (text: string) => void;
  /** surgical 模式（或调试）的原始输出增量 */
  onRaw?: (text: string) => void;
}

type Phase = 'seek' | 'edit' | 'answer' | 'surgical' | 'done';

function safeJsonParse(text: string): ModelAnalysis | null {
  let s = text.trim();
  if (!s) return null;
  // 去掉模型可能加的代码围栏
  const fence = s.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  const attempts: string[] = [s];
  // 提取最外层大括号
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(s.slice(first, last + 1));
  // 去掉尾逗号
  for (const candidate of attempts) {
    try {
      const val = JSON.parse(candidate);
      if (val && typeof val === 'object' && !Array.isArray(val)) return val as ModelAnalysis;
    } catch {
      // ignore
    }
  }
  try {
    const cleaned = attempts[0].replace(/,\s*([}\]])/g, '$1');
    const val = JSON.parse(cleaned);
    if (val && typeof val === 'object' && !Array.isArray(val)) return val as ModelAnalysis;
  } catch {
    // ignore
  }
  return { raw: s.slice(0, 500) };
}

/** 解析 surgical 输出中的 FIND/REPLACE 块，容忍缺失的 <<<END>>> 终止标记。 */
export function parseSurgicalBlocks(inner: string, markers: Markers): { blocks: ParsedEditBlock[]; issues: string[] } {
  const issues: string[] = [];
  const blocks: ParsedEditBlock[] = [];

  type Token = { pos: number; kind: 'find' | 'find-all' | 'replace' | 'end'; length: number };
  const tokens: Token[] = [];
  const pushAll = (marker: string, kind: Token['kind']) => {
    let from = 0;
    for (;;) {
      const i = inner.indexOf(marker, from);
      if (i < 0) break;
      tokens.push({ pos: i, kind, length: marker.length });
      from = i + marker.length;
    }
  };
  pushAll(markers.findStart, 'find');
  pushAll(markers.findAllStart, 'find-all');
  pushAll(markers.replaceStart, 'replace');
  pushAll(markers.blockEnd, 'end');
  tokens.sort((a, b) => a.pos - b.pos);

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind !== 'find' && t.kind !== 'find-all') {
      i++;
      continue;
    }
    // 找到紧随其后的 REPLACE
    let replaceIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].kind === 'replace') {
        replaceIdx = j;
        break;
      }
      if (tokens[j].kind === 'find' || tokens[j].kind === 'find-all') break;
    }
    if (replaceIdx < 0) {
      issues.push(`第 ${blocks.length + 1} 个 FIND 块缺少 REPLACE 标记，已跳过`);
      i++;
      continue;
    }
    const findBodyStart = t.pos + t.length;
    const findBodyEnd = tokens[replaceIdx].pos;
    const replaceBodyStart = tokens[replaceIdx].pos + tokens[replaceIdx].length;
    // 替换内容结束于下一个块起点 / END 标记 / 文本末尾
    let replaceBodyEnd = inner.length;
    let consumed = replaceIdx + 1;
    for (let j = replaceIdx + 1; j < tokens.length; j++) {
      const tk = tokens[j];
      if (tk.kind === 'find' || tk.kind === 'find-all') {
        replaceBodyEnd = tk.pos;
        consumed = j;
        break;
      }
      if (tk.kind === 'end') {
        replaceBodyEnd = tk.pos;
        consumed = j + 1;
        break;
      }
    }
    const find = stripOuterNewlines(inner.slice(findBodyStart, findBodyEnd));
    const replace = stripOuterNewlines(inner.slice(replaceBodyStart, replaceBodyEnd));
    if (!find) {
      issues.push(`第 ${blocks.length + 1} 个 FIND 块内容为空，已跳过`);
    } else {
      blocks.push({ kind: t.kind === 'find' ? 'find' : 'find-all', find, replace });
    }
    i = Math.max(consumed, i + 1);
  }
  return { blocks, issues };
}

export class StreamParser {
  private buf = '';
  private raw = '';
  private phase: Phase;
  private analysis: ModelAnalysis | null = null;
  private content = '';
  private answer = '';
  private editStarted = false;
  private answerStarted = false;
  private foundEditEnd = false;
  private foundAnswerEnd = false;
  private foundEditStart = false;
  private foundAnswerStart = false;
  private issues: string[] = [];
  private opts: StreamParserOptions;
  /** 是否已处理完 ANALYSIS 块（或确认不等待它） */
  private analysisHandled: boolean;
  private analysisMissingReported = false;

  constructor(opts: StreamParserOptions) {
    this.opts = opts;
    // 统一从 seek 开始：ANALYSIS 是可选的，若它出现在正文标记之前就先解析；
    // 若模型跳过 ANALYSIS 直接给正文，也能立刻切换，不会卡死等待。
    this.phase = 'seek';
    this.analysisHandled = !opts.expectAnalysis;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.raw += chunk;
    this.buf += chunk;
    this.pump();
  }

  private pump(): void {
    const { markers, mode, expectAnalysis } = this.opts;
    for (;;) {
      if (this.phase === 'seek') {
        if (expectAnalysis && !this.analysisHandled) {
          const aStart = this.buf.indexOf(markers.analysisStart);
          const editPosForAnalysis = this.buf.indexOf(markers.editStart);
          const answerPosForAnalysis = mode === 'ask' ? this.buf.indexOf(markers.answerStart) : -1;
          const structuralPositions = [editPosForAnalysis, answerPosForAnalysis].filter((i) => i >= 0);
          const firstStructural = structuralPositions.length ? Math.min(...structuralPositions) : -1;
          if (aStart >= 0 && (firstStructural < 0 || aStart < firstStructural)) {
            const aEnd = this.buf.indexOf(markers.analysisEnd, aStart + markers.analysisStart.length);
            if (aEnd < 0) {
              if (firstStructural >= 0 || this.buf.length > 200_000) {
                this.issues.push('模型输出的 ANALYSIS 块不完整，已忽略');
                this.analysisHandled = true;
                this.buf = this.buf.slice(0, aStart) + this.buf.slice(aStart + markers.analysisStart.length);
                continue;
              }
              return;
            }
            const inner = this.buf.slice(aStart + markers.analysisStart.length, aEnd);
            this.analysis = safeJsonParse(inner);
            if (this.analysis) this.opts.onAnalysis?.(this.analysis);
            this.buf = this.buf.slice(aEnd + markers.analysisEnd.length);
            this.analysisHandled = true;
            continue;
          }
          if (firstStructural < 0) {
            if (this.buf.length > 200_000) {
              this.analysisHandled = true;
              continue;
            }
            if (this.buf.length > 64_000) this.buf = this.buf.slice(-1_000);
            return;
          }
          // 正文标记先出现：模型跳过了 ANALYSIS，直接进入正文解析
          this.analysisHandled = true;
          if (!this.analysisMissingReported) {
            this.analysisMissingReported = true;
            this.issues.push('模型未输出 ANALYSIS 块（不影响正文）');
          }
        }

        if (mode === 'surgical') {
          // surgical 模式不需要逐字预览，但可以把原始输出增量交给上层显示进度
          if (this.buf) {
            this.opts.onRaw?.(this.buf);
            this.buf = '';
          }
          this.phase = 'surgical';
          return;
        }
        const editPos = this.buf.indexOf(markers.editStart);
        const answerPos = mode === 'ask' ? this.buf.indexOf(markers.answerStart) : -1;
        const candidates: Array<{ pos: number; kind: 'edit' | 'answer' }> = [];
        if (editPos >= 0) candidates.push({ pos: editPos, kind: 'edit' });
        if (answerPos >= 0) candidates.push({ pos: answerPos, kind: 'answer' });
        if (!candidates.length) {
          if (this.buf.length > 64_000) this.buf = this.buf.slice(-1000);
          return;
        }
        candidates.sort((a, b) => a.pos - b.pos);
        const chosen = candidates[0];
        this.buf = this.buf.slice(chosen.pos + (chosen.kind === 'edit' ? markers.editStart.length : markers.answerStart.length));
        if (chosen.kind === 'edit') {
          this.foundEditStart = true;
          this.phase = 'edit';
        } else {
          this.foundAnswerStart = true;
          this.phase = 'answer';
        }
        continue;
      }

      if (this.phase === 'surgical') {
        // 等待 finish() 做完整解析
        return;
      }

      if (this.phase === 'edit') {
        if (!this.editStarted) {
          // 静默去掉紧跟标记的一个换行
          if (this.buf.startsWith('\r')) {
            if (this.buf.length < 2) return;
            if (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2);
            else this.buf = this.buf.slice(1);
          } else if (this.buf.startsWith('\n')) {
            this.buf = this.buf.slice(1);
          }
          if (!this.buf) return;
          this.editStarted = true;
        }
        const end = this.buf.indexOf(markers.editEnd);
        if (end >= 0) {
          const piece = this.buf.slice(0, end);
          if (piece) {
            this.content += piece;
            this.opts.onDelta?.(piece);
          }
          this.buf = this.buf.slice(end + markers.editEnd.length);
          this.foundEditEnd = true;
          this.phase = 'done';
          continue;
        }
        // 保留可能构成结束标记的前缀，避免把标记的一部分当内容发出去
        const hold = markers.editEnd.length;
        if (this.buf.length > hold) {
          const safe = this.buf.slice(0, this.buf.length - hold + 1);
          this.content += safe;
          this.opts.onDelta?.(safe);
          this.buf = this.buf.slice(safe.length);
        }
        return;
      }

      if (this.phase === 'answer') {
        if (!this.answerStarted) {
          if (this.buf.startsWith('\r')) {
            if (this.buf.length < 2) return;
            if (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2);
            else this.buf = this.buf.slice(1);
          } else if (this.buf.startsWith('\n')) {
            this.buf = this.buf.slice(1);
          }
          if (!this.buf) return;
          this.answerStarted = true;
        }
        const end = this.buf.indexOf(markers.answerEnd);
        if (end >= 0) {
          const piece = this.buf.slice(0, end);
          if (piece) {
            this.answer += piece;
            this.opts.onDelta?.(piece);
          }
          this.buf = this.buf.slice(end + markers.answerEnd.length);
          this.foundAnswerEnd = true;
          this.phase = 'done';
          continue;
        }
        const hold = markers.answerEnd.length;
        if (this.buf.length > hold) {
          const safe = this.buf.slice(0, this.buf.length - hold + 1);
          this.answer += safe;
          this.opts.onDelta?.(safe);
          this.buf = this.buf.slice(safe.length);
        }
        return;
      }

      // done
      return;
    }
  }

  /**
   * 结束解析。
   * finishReason 来自上游：'length' 表示截断（绝不静默应用）；
   * 'stop' 表示模型自然结束，此时即使缺少结束标记，内容通常也是完整的
   * （标记缺失而非内容截断，会给出 issue 提示）。
   */
  finish(meta: { finishReason?: string | null } = {}): ParseResult {
    const { markers, mode } = this.opts;
    const finishReason = meta.finishReason ?? null;
    const missingEndMarker = (): boolean => {
      if (finishReason === 'length') return true;
      if (finishReason === 'stop') return false;
      return true;
    };
    const issues = [...this.issues];
    let analysis = this.analysis;
    let content = '';
    let edits: ParsedEditBlock[] = [];
    let answer = '';
    let truncated = false;
    let missingSentinels = false;
    let hasEditBlock = false;

    if (!analysis) {
      // 分析块可能在 surgical 模式没有被增量解析；统一从 raw 兜底提取
      const s = this.raw.indexOf(markers.analysisStart);
      if (s >= 0) {
        const e = this.raw.indexOf(markers.analysisEnd, s + markers.analysisStart.length);
        if (e >= 0) analysis = safeJsonParse(this.raw.slice(s + markers.analysisStart.length, e));
      }
    }

    if (mode === 'surgical') {
      const cleaned = stripAnalysisBlock(this.raw, markers);
      const start = cleaned.indexOf(markers.editStart);
      if (start >= 0) {
        hasEditBlock = true;
        const bodyStart = start + markers.editStart.length;
        const end = cleaned.indexOf(markers.editEnd, bodyStart);
        const inner = end >= 0 ? cleaned.slice(bodyStart, end) : cleaned.slice(bodyStart);
        if (end < 0) {
          truncated = missingEndMarker();
          if (!truncated) issues.push('模型自然结束但缺少 END_EDIT 标记（内容按完整处理）');
        }
        const parsed = parseSurgicalBlocks(inner, markers);
        edits = parsed.blocks;
        issues.push(...parsed.issues);
        if (!edits.length) {
          const fallback = stripOuterNewlines(inner);
          if (fallback.trim()) {
            content = fallback;
            issues.push('模型未返回 FIND/REPLACE 块，已按整段替换处理');
          }
        }
      } else {
        const fallback = stripOuterNewlines(cleaned);
        if (fallback.trim()) {
          content = fallback;
          missingSentinels = true;
          issues.push('模型输出缺少 EDIT 标记，已按整段替换兜底提取');
        }
      }
    } else if (mode === 'ask') {
      if (this.foundAnswerStart) {
        answer = stripOuterNewlines(this.foundAnswerEnd ? this.answer : this.answer + this.buf);
        if (!this.foundAnswerEnd) {
          truncated = missingEndMarker();
          if (!truncated) issues.push('模型自然结束但缺少 END_ANSWER 标记（内容按完整处理）');
        }
      } else {
        const cleaned = stripAnalysisBlock(this.raw, markers);
        answer = stripOuterNewlines(cleaned);
        missingSentinels = answer.trim().length > 0;
        if (missingSentinels) issues.push('模型输出缺少 ANSWER 标记，已按纯文本兜底提取');
      }
    } else {
      if (this.foundEditStart) {
        content = stripOuterNewlines(this.foundEditEnd ? this.content : this.content + this.buf);
        if (!this.foundEditEnd) {
          truncated = missingEndMarker();
          if (!truncated) issues.push('模型自然结束但缺少 END_EDIT 标记（内容按完整处理）');
        }
      } else {
        const cleaned = stripAnalysisBlock(this.raw, markers);
        content = stripOuterNewlines(cleaned);
        missingSentinels = content.trim().length > 0;
        if (missingSentinels) issues.push('模型输出缺少 EDIT 标记，已按整段替换兜底提取');
      }
    }

    return {
      analysis,
      content,
      edits,
      answer,
      truncated,
      missingSentinels,
      hasEditBlock,
      raw: this.raw,
      issues,
    };
  }
}

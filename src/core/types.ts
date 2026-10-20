/**
 * DocMax 核心类型 —— 客户端与服务端共享的唯一契约。
 *
 * 设计要点：
 * - 选区（RangeSnapshot）是「带快照的精确区间」：from/to 为 UTF-16 偏移，
 *   同时携带当时的原文 text 与前后文 before/after。服务端只用快照工作，
 *   客户端在应用结果前再次校验快照，因此模型耗时期间文档被修改也不会错位。
 * - 提案（EditProposal）是「已通过服务端校验、可直接应用」的修改结果，
 *   绝不包含未经验证的模型原文。
 */
import type { PromptPresetId } from './presets';

export type ModelId = 'deepseek-flash' | 'deepseek-v4-pro';

/** 思考强度：off = 关闭思考模式（最快），其余为 reasoning_effort */
export type ThinkingLevel = 'off' | 'low' | 'high' | 'max';

/**
 * 编辑模式：
 * - rewrite  : 模型重写整个选区（默认，流式可见，应用 100% 精确）
 * - surgical : 模型返回选区内的 FIND/REPLACE 块（适合大选区/机械替换，省 token）
 * - insert   : 空选区（光标）处插入文字
 * - ask      : 只回答关于选区的问题（解释/审查），不改文档
 */
export type EditMode = 'rewrite' | 'surgical' | 'insert' | 'ask';

/** 选区块级类型（本地确定性识别，用于提示模型与 UI 展示） */
export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'table'
  | 'code'
  | 'blockquote'
  | 'hr'
  | 'frontmatter'
  | 'html'
  | 'empty';

/** 本地选区识别结果：确定性的事实，发给模型作为「选区上下文」，并在 UI 中展示。 */
export interface LocalSelectionAnalysis {
  index: number;
  /** UTF-16 字符数 */
  chars: number;
  /** CJK 字符按字计数，拉丁词按词计数 */
  words: number;
  lines: number;
  blockKind: BlockKind;
  /** 若选区位于代码块内，给出围栏语言；位于围栏行本身时为 null */
  codeFenceLang: string | null;
  /** 选区是否起始于某个拉丁单词中间 */
  startsMidWord: boolean;
  /** 选区是否结束于某个拉丁单词中间 */
  endsMidWord: boolean;
  /** 选区是否从行中间开始（同一行前面还有非空白内容） */
  startsMidLine: boolean;
  /** 选区是否在行中间结束 */
  endsMidLine: boolean;
  /** 选区与 Markdown 强调/链接等标记的边界是否不平衡 */
  delimiterWarnings: string[];
  /** 选区是否跨越多个块 */
  spansMultipleBlocks: boolean;
  /** 给用户的建议（例如“建议扩展到整词”） */
  suggestions: string[];
  /** 选区在整篇文档中的位置（行号从 1 开始） */
  startLine: number;
  endLine: number;
  /** 选区前后紧邻的少量字符，用于 UI 展示边界 */
  boundary: { before: string; after: string };
}

/** 发送给服务端的选区快照 */
export interface RangeSnapshot {
  index: number;
  from: number;
  to: number;
  anchor: number;
  head: number;
  /** doc.slice(from, to) 的原文 */
  text: string;
  /** text 的指纹（fnv1a32），用于应用前校验 */
  hash: string;
  /** 选区内每个字符串化参数的指纹已含在 hash 中，此处为上下文 */
  before: string;
  after: string;
}

/** 请求选项 */
export interface EditOptions {
  model: ModelId;
  thinking: ThinkingLevel;
  mode: EditMode;
  /** 系统内置提示词模式（决定任务的系统级规则） */
  presetId: PromptPresetId;
  /** 是否让模型先输出一段结构化识别结果（analysis） */
  analysis: boolean;
  /** 选区前后各取多少字符作为上下文 */
  contextChars: number;
  /** 超过该字符数时自动切换 surgical（autoMode 生效时） */
  maxRewriteChars: number;
  /** 发送整篇文档的上限；超过则改发大纲 + 选区附近摘录 */
  maxDocumentChars: number;
  /** 是否自动清理模型常见的格式噪音（包裹围栏、前后缀说明） */
  sanitizeFormat: boolean;
  /** 输出语言偏好，例如 zh-CN / en；空则跟随原文与指令 */
  language: string | null;
}

/** 客户端 -> 服务端：一次编辑请求 */
export interface EditRequest {
  requestId: string;
  /** 客户端文档修订号（仅用于追踪，服务端不做强校验） */
  docRev: number;
  /** 文档全文（服务端用于上下文与校验） */
  docText: string;
  docTitle: string;
  /** 目前每次请求只含 1 个选区；多选区由客户端并行多次请求 */
  ranges: RangeSnapshot[];
  instruction: string;
  options: EditOptions;
}

/** 模型输出的「识别」结果（可选） */
export interface ModelAnalysis {
  kind?: string;
  language?: string;
  summary?: string;
  confidence?: number;
  [key: string]: unknown;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
}

export interface Timings {
  startedAt: number;
  firstContentMs?: number;
  finishedAt?: number;
  totalMs?: number;
  attempts: number;
  repairs: number;
}

/** 单次修改的统计 */
export interface EditStats {
  oldChars: number;
  newChars: number;
  removedChars: number;
  addedChars: number;
}

export type ApplyStrategy =
  | 'rewrite'
  | 'insert'
  | 'search-replace-exact'
  | 'search-replace-flexible'
  | 'search-replace-fuzzy'
  | 'fallback-whole-replace'
  | 'unchanged';

export interface AppliedEdit {
  find: string;
  replace: string;
  strategy: 'exact' | 'flexible-whitespace' | 'fuzzy-line';
  /** 匹配命中的 1-based 行号（相对选区起始行），用于 UI 展示 */
  line?: number;
}

export type WarningSeverity = 'info' | 'warn' | 'error';

export interface ProposalWarning {
  code:
    | 'truncated'
    | 'missing-sentinels'
    | 'format-sanitized'
    | 'no-change'
    | 'empty-result'
    | 'fence-imbalance'
    | 'delimiter-imbalance'
    | 'heading-marker-dropped'
    | 'list-marker-dropped'
    | 'table-structure'
    | 'whitespace-boundary'
    | 'ambiguous-anchor'
    | 'fuzzy-match'
    | 'fallback-whole-replace'
    | 'repair-applied'
    | 'selection-mid-word'
    | 'outside-context-risk'
    | 'context-leak'
    | 'length-ratio'
    | 'model-analysis-mismatch'
    | 'other';
  severity: WarningSeverity;
  message: string;
  rangeId?: number;
}

/** 一个选区对应的操作（当前总是 replace；插入即替换空区间） */
export interface ProposalOp {
  rangeId: number;
  /** 以 from/to 定位目标区间（与请求快照一致） */
  from: number;
  to: number;
  /** 发送请求时该区间的原文，应用前再次比对，保证不快照错位 */
  oldText: string;
  /** 该区间的新文本 */
  newText: string;
  strategy: ApplyStrategy;
  edits?: AppliedEdit[];
  stats: EditStats;
}

/** 服务端校验后、等待用户确认的提案 */
export interface EditProposal {
  requestId: string;
  docRev: number;
  mode: EditMode;
  model: ModelId;
  analysis: ModelAnalysis | null;
  localAnalyses: LocalSelectionAnalysis[];
  ops: ProposalOp[];
  warnings: ProposalWarning[];
  truncated: boolean;
  usage: Usage;
  timings: Timings;
  /** 模型原始输出（调试用，可能被截断到 20000 字符） */
  raw?: string;
}

/** 服务端 -> 客户端 SSE 事件 */
export type ServerEvent =
  | {
      type: 'meta';
      requestId: string;
      docRev: number;
      model: ModelId;
      mode: EditMode;
      localAnalyses: LocalSelectionAnalysis[];
      startedAt: number;
    }
  | {
      type: 'status';
      phase: 'connecting' | 'thinking' | 'streaming' | 'validating' | 'repairing' | 'done';
      note?: string;
      attempt?: number;
    }
  | { type: 'reasoning'; delta: string }
  | { type: 'analysis'; analysis: ModelAnalysis }
  /** rewrite/insert：增量替换文本（按选区 id） */
  | { type: 'delta'; rangeId: number; text: string }
  /** 模型原始输出增量（surgical/调试展示用） */
  | { type: 'raw'; delta: string }
  /** ask 模式的回答增量 */
  | { type: 'answer'; delta: string }
  | { type: 'proposal'; proposal: EditProposal }
  | { type: 'error'; code: string; message: string; detail?: string; retryable: boolean }
  | { type: 'done'; requestId: string; usage: Usage; timings: Timings };

/** 应用提案的结果 */
export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** 应用后的新文档 */
  docText: string;
}

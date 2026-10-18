/**
 * UI 层内部类型：编辑器快照、命令条草稿上下文、一次 AI 会话的状态机。
 *
 * 注意：这些类型只服务于界面；与核心引擎的契约（EditRequest / EditProposal 等）
 * 一律从 src/core/types.ts 引入，不在这里重新定义。
 */
import type {
  EditProposal,
  LocalSelectionAnalysis,
  ModelAnalysis,
  ModelId,
  RangeSnapshot,
  ThinkingLevel,
  Timings,
  Usage,
} from '../core/types';

export type ThemeMode = 'light' | 'dark';

/** 本地服务 / API Key 健康状态 */
export type HealthState = 'checking' | 'ok' | 'nokey' | 'offline';

/** 命令条里用户选择的模式（auto 由 UI 按选区大小解析） */
export type ModeChoice = 'auto' | 'rewrite' | 'surgical';

export interface RawRange {
  from: number;
  to: number;
  anchor: number;
  head: number;
}

/** 编辑器上报的单个选区（已附带本地确定性识别结果） */
export interface EditorRangeInfo extends RawRange {
  /** 在所有选区中的顺序：0 为主选区，其余按文档顺序 */
  index: number;
  analysis: LocalSelectionAnalysis;
}

export interface EditorSelectionInfo {
  ranges: EditorRangeInfo[];
  /** 主选区在 ranges 中的下标（当前实现里主选区恒定排 0） */
  primaryIndex: number;
  cursor: { line: number; col: number };
  /** 选区末尾在视口中的坐标（用于浮动 AI 按钮定位），不可见时为 null */
  coords: { left: number; top: number; bottom: number } | null;
}

/** 命令条打开时冻结的发送上下文（before / selection / after 预览用） */
export interface DraftRange extends RawRange {
  index: number;
  analysis: LocalSelectionAnalysis;
  snapshot: RangeSnapshot;
}

export interface DraftContext {
  ranges: DraftRange[];
  docChars: number;
  docLines: number;
  docTitle: string;
}

export interface RunParams {
  instruction: string;
  model: ModelId;
  thinking: ThinkingLevel;
  modeChoice: ModeChoice;
  ask: boolean;
}

export type StreamPhase = 'connecting' | 'thinking' | 'streaming' | 'validating' | 'repairing' | 'done';

export type SessionStatus = 'idle' | 'running' | 'review' | 'error';

export interface SessionError {
  code: string;
  message: string;
  /** 面向用户的中文补充说明（由错误码映射） */
  hint?: string;
  detail?: string;
  retryable: boolean;
}

export interface EditSessionState {
  status: SessionStatus;
  phase: StreamPhase | null;
  phaseNote: string | null;
  attempt: number;
  instruction: string;
  model: ModelId;
  thinking: ThinkingLevel;
  modeChoice: ModeChoice;
  ask: boolean;
  /** 多选区串行处理的进度 */
  batch: { current: number; total: number };
  reasoning: string;
  analysis: ModelAnalysis | null;
  /** rewrite / insert 的流式替换文本 */
  streamText: string;
  /** surgical 模式下的模型原始输出 */
  rawText: string;
  /** ask 模式下的回答 */
  answer: string;
  proposals: EditProposal[];
  error: SessionError | null;
  startedAt: number;
  elapsedMs: number;
  finishedMs: number | null;
  usage: Usage | null;
  timings: Timings | null;
  /** 生成期间文档或选区被改动：提案已过期，禁止应用 */
  stale: boolean;
  staleReason: string | null;
  /** truncated 为 error 级警告，需要用户二次确认 */
  truncatedConfirm: boolean;
  applying: boolean;
  requestCount: number;
}

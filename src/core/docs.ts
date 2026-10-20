/**
 * 文档库（Document Library）共享契约。
 *
 * 每个文档在磁盘上拥有独立子文件夹：
 *   <dataDir>/docs/<docId>/
 *     document.md      当前内容
 *     meta.json        标题 / 时间 / 版本数 / 字符数
 *     audit.jsonl      追加式留痕（AI 提案、接受/拒绝、保存、回滚…）
 *     revisions/       不可变版本快照，000001.md、000002.md …
 *     revisions.json   版本元数据
 *
 * 所有写操作由服务端串行化并原子落盘；客户端只通过 /api/docs 访问。
 */

/** 文档摘要（列表用） */
export interface DocSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
  chars: number;
  /** 文档文件夹的绝对路径（便于用户去资源管理器查看） */
  folder: string;
}

/** 文档详情 */
export interface DocDetail extends DocSummary {
  content: string;
}

/** 版本来源 */
export type RevisionSource =
  | 'create'
  | 'manual-save'
  | 'auto-save'
  | 'ai-accept'
  | 'ai-append'
  | 'import-docx'
  | 'import-markdown'
  | 'restore'
  | 'unknown';

/** 版本元数据 */
export interface RevisionSummary {
  rev: number;
  createdAt: string;
  source: RevisionSource;
  chars: number;
  hash: string;
  /** 用户可读的说明，例如「AI 修订：润色」「恢复自 v3」 */
  note: string;
}

/** 留痕事件类型 */
export type AuditEventType =
  | 'doc-created'
  | 'doc-saved'
  | 'doc-renamed'
  | 'doc-deleted'
  | 'doc-opened'
  | 'ai-proposal'
  | 'ai-accepted'
  | 'ai-rejected'
  | 'docx-imported'
  | 'markdown-imported'
  | 'version-restored';

/** 留痕事件（追加式，不修改历史） */
export interface AuditEvent {
  id: string;
  type: AuditEventType;
  at: string;
  /** 该事件产生/关联的版本号（没有内容变化的事件为空） */
  rev?: number;
  /** 简短可读说明 */
  summary: string;
  /** 详细上下文（指令、模型、选区、前后文本等，服务端会限制长度） */
  detail?: Record<string, unknown>;
}

/** 历史接口返回值 */
export interface DocHistory {
  docId: string;
  events: AuditEvent[];
  revisions: RevisionSummary[];
}

/** 新建文档 */
export interface CreateDocInput {
  title: string;
  content?: string;
}

/** 保存文档 */
export interface SaveDocInput {
  content: string;
  title?: string;
  source?: RevisionSource;
  note?: string;
  /** 附加到留痕事件的细节（服务端会截断过长字符串） */
  detail?: Record<string, unknown>;
}

/** 追加一条非内容型留痕事件 */
export interface AuditEventInput {
  type: AuditEventType;
  summary: string;
  detail?: Record<string, unknown>;
  rev?: number;
}

/** GET /api/docs */
export interface DocListResponse {
  docs: DocSummary[];
  /** 文档库根目录绝对路径 */
  root: string;
  /** 单文档内容上限（字符） */
  maxChars: number;
}

/** 通用错误 */
export interface DocErrorResponse {
  code: string;
  error: string;
}

/** 保存/删除等操作返回 */
export interface SaveDocResponse {
  doc: DocSummary;
  revision: RevisionSummary | null;
  /** 内容与标题都没变化时为 true（不会产生新版本） */
  unchanged: boolean;
}

export const DOC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function isDocId(value: unknown): value is string {
  return typeof value === 'string' && DOC_ID_PATTERN.test(value) && !value.includes('..');
}

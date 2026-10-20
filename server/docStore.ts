/**
 * 文档库文件存储。
 *
 * 每个文档一个子文件夹（见 src/core/docs.ts 顶部注释）：
 *   docs/<id>/document.md
 *   docs/<id>/meta.json
 *   docs/<id>/audit.jsonl        ← 追加式留痕，永不修改历史行
 *   docs/<id>/revisions/000001.md
 *   docs/<id>/revisions.json
 *
 * 设计原则：
 * - 内容变化才产生新版本；标题变化只记留痕，不产生版本；
 * - 所有写操作按文档串行执行，文件采用「临时文件 + rename」原子替换；
 * - 删除文档只移动到 trash/，保留全部留痕，不做物理删除；
 * - 审计事件里的长文本（选区/前后文）会被截断，避免 meta/审计无限膨胀。
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from './config';
import {
  isDocId,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventType,
  type CreateDocInput,
  type DocDetail,
  type DocHistory,
  type DocSummary,
  type RevisionSource,
  type RevisionSummary,
  type SaveDocInput,
  type SaveDocResponse,
} from '../src/core/docs';

const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_JSON = 24_000;
const MAX_DETAIL_STRING = 4_000;
const MAX_AUDIT_EVENTS = 100_000;

const SAVE_EVENT: Record<RevisionSource, AuditEventType> = {
  create: 'doc-created',
  'manual-save': 'doc-saved',
  'auto-save': 'doc-saved',
  'ai-accept': 'ai-accepted',
  'ai-append': 'ai-accepted',
  'import-docx': 'docx-imported',
  'import-markdown': 'markdown-imported',
  restore: 'version-restored',
  unknown: 'doc-saved',
};

const SOURCE_NOTE: Record<RevisionSource, string> = {
  create: '创建文档',
  'manual-save': '手动保存',
  'auto-save': '自动保存',
  'ai-accept': 'AI 修订已接受',
  'ai-append': 'AI 内容已追加',
  'import-docx': '导入 Word 文档',
  'import-markdown': '导入 Markdown 文件',
  restore: '恢复历史版本',
  unknown: '保存',
};

export class DocStoreError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface DocMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revisionCount: number;
  chars: number;
  lastHash: string;
}

const locks = new Map<string, Promise<unknown>>();

function docsDir(): string {
  return join(config.dataDir, 'docs');
}

function trashDir(): string {
  return join(config.dataDir, 'trash');
}

export function ensureDocStore(): void {
  mkdirSync(docsDir(), { recursive: true });
  mkdirSync(trashDir(), { recursive: true });
}

function validateId(id: string): string {
  if (!isDocId(id)) throw new DocStoreError('bad-doc-id', '文档 id 不合法。', 400);
  const folder = resolve(docsDir(), id);
  const root = resolve(docsDir());
  if (folder !== root && !folder.startsWith(root + sep)) {
    throw new DocStoreError('bad-doc-id', '文档路径越界。', 400);
  }
  return folder;
}

function folderOf(id: string): string {
  return validateId(id);
}

function ensureFolder(id: string): string {
  const folder = folderOf(id);
  if (!existsSync(folder)) throw new DocStoreError('doc-not-found', '文档不存在或已被删除。', 404);
  return folder;
}

function writeAtomic(target: string, content: string): void {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, target);
}

function writeJsonAtomic(target: string, value: unknown): void {
  writeAtomic(target, JSON.stringify(value, null, 2));
}

function readJson<T>(target: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function nowIso(): string {
  return new Date().toISOString();
}

function revisionFile(rev: number): string {
  return `${String(rev).padStart(6, '0')}.md`;
}

function safeTitle(title: unknown, fallback = '未命名文档'): string {
  if (typeof title !== 'string') return fallback;
  const trimmed = title.replace(/[\r\n\t]+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_CHARS) : fallback;
}

function safeSource(source: unknown): RevisionSource {
  if (typeof source === 'string' && source in SOURCE_NOTE) return source as RevisionSource;
  return 'unknown';
}

/** 详情里的长字符串截断，避免审计/版本元数据无界膨胀 */
function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[nested]';
  if (typeof value === 'string') {
    if (value.length <= MAX_DETAIL_STRING) return value;
    return `${value.slice(0, MAX_DETAIL_STRING)}\n…（已截断 ${value.length - MAX_DETAIL_STRING} 字符）`;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDetail(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = sanitizeDetail(item, depth + 1);
    }
    return out;
  }
  return value;
}

function serializeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const sanitized = sanitizeDetail(detail) as Record<string, unknown>;
  const json = JSON.stringify(sanitized);
  if (json.length <= MAX_DETAIL_JSON) return sanitized;
  return { truncated: true, preview: json.slice(0, MAX_DETAIL_JSON) };
}

function makeEvent(type: AuditEventType, summary: string, detail?: Record<string, unknown>, rev?: number): AuditEvent {
  const event: AuditEvent = {
    id: `evt-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    type,
    at: nowIso(),
    summary: summary.slice(0, 500),
  };
  if (typeof rev === 'number') event.rev = rev;
  const safe = serializeDetail(detail);
  if (safe) event.detail = safe;
  return event;
}

function appendEvent(id: string, event: AuditEvent): void {
  const file = join(ensureFolder(id), 'audit.jsonl');
  appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function readAudit(id: string): AuditEvent[] {
  const file = join(folderOf(id), 'audit.jsonl');
  if (!existsSync(file)) return [];
  const events: AuditEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditEvent;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.type === 'string') events.push(parsed);
    } catch {
      // 单行损坏不影响其余留痕
    }
    if (events.length > MAX_AUDIT_EVENTS) events.shift();
  }
  return events;
}

function readRevisions(id: string): RevisionSummary[] {
  return readJson<RevisionSummary[]>(join(folderOf(id), 'revisions.json'), []);
}

function writeRevisions(id: string, revisions: RevisionSummary[]): void {
  writeJsonAtomic(join(folderOf(id), 'revisions.json'), revisions);
}

function readMeta(id: string): DocMeta {
  const folder = ensureFolder(id);
  const meta = readJson<DocMeta | null>(join(folder, 'meta.json'), null);
  if (!meta || meta.id !== id) throw new DocStoreError('doc-corrupt', '文档元数据缺失或损坏。', 500);
  return meta;
}

function toSummary(meta: DocMeta): DocSummary {
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    revisionCount: meta.revisionCount,
    chars: meta.chars,
    folder: folderOf(meta.id),
  };
}

function withLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

function uniqueDocId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `doc-${stamp}-${randomBytes(3).toString('hex')}`;
    if (!existsSync(join(docsDir(), id))) return id;
  }
  throw new DocStoreError('id-exhausted', '无法生成文档 id。', 500);
}

export function listDocs(): DocSummary[] {
  ensureDocStore();
  const result: DocSummary[] = [];
  for (const name of readdirSync(docsDir(), { withFileTypes: true })) {
    if (!name.isDirectory() || !isDocId(name.name)) continue;
    try {
      result.push(toSummary(readMeta(name.name)));
    } catch {
      // 损坏/残留目录跳过，列表不应因单个文档失败
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createDoc(input: CreateDocInput): DocDetail {
  ensureDocStore();
  const title = safeTitle(input.title);
  const content = typeof input.content === 'string' ? input.content : '';
  if (content.length > config.limits.maxDocumentChars) {
    throw new DocStoreError('document-too-large', `文档超过上限（${config.limits.maxDocumentChars} 字符）。`, 413);
  }
  const id = uniqueDocId();
  const folder = join(docsDir(), id);
  mkdirSync(join(folder, 'revisions'), { recursive: true });
  writeAtomic(join(folder, 'document.md'), content);

  const now = nowIso();
  const meta: DocMeta = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    revisionCount: 1,
    chars: content.length,
    lastHash: contentHash(content),
  };
  writeJsonAtomic(join(folder, 'meta.json'), meta);
  writeAtomic(join(folder, 'revisions', revisionFile(1)), content);
  const revision: RevisionSummary = {
    rev: 1,
    createdAt: now,
    source: 'create',
    chars: content.length,
    hash: contentHash(content),
    note: '创建文档',
  };
  writeRevisions(id, [revision]);
  appendEvent(
    id,
    makeEvent(
      'doc-created',
      `创建文档「${title}」`,
      { title, chars: content.length, folder },
      1,
    ),
  );
  return { ...toSummary(meta), content };
}

export function getDoc(id: string): DocDetail {
  const meta = readMeta(id);
  const content = readFileSync(join(folderOf(id), 'document.md'), 'utf8');
  return { ...toSummary(meta), content };
}

export async function saveDoc(id: string, input: SaveDocInput): Promise<SaveDocResponse> {
  return withLock(id, () => {
    const meta = readMeta(id);
    const folder = folderOf(id);
    const previous = readFileSync(join(folder, 'document.md'), 'utf8');
    const content = typeof input.content === 'string' ? input.content : null;
    if (content === null) throw new DocStoreError('bad-content', '缺少文档内容。', 400);
    if (content.length > config.limits.maxDocumentChars) {
      throw new DocStoreError('document-too-large', `文档超过上限（${config.limits.maxDocumentChars} 字符）。`, 413);
    }
    const nextTitle = input.title === undefined ? meta.title : safeTitle(input.title, meta.title);
    const contentChanged = content !== previous;
    const titleChanged = nextTitle !== meta.title;
    if (!contentChanged && !titleChanged) {
      return { doc: toSummary(meta), revision: null, unchanged: true };
    }

    let revision: RevisionSummary | null = null;
    if (contentChanged) {
      const rev = meta.revisionCount + 1;
      const source = safeSource(input.source);
      const createdAt = nowIso();
      writeAtomic(join(folder, 'revisions', revisionFile(rev)), content);
      writeAtomic(join(folder, 'document.md'), content);
      meta.revisionCount = rev;
      meta.chars = content.length;
      meta.lastHash = contentHash(content);
      meta.updatedAt = createdAt;
      const revisions = readRevisions(id);
      revision = {
        rev,
        createdAt,
        source,
        chars: content.length,
        hash: contentHash(content),
        note: (input.note && input.note.trim().slice(0, 240)) || SOURCE_NOTE[source],
      };
      revisions.push(revision);
      writeRevisions(id, revisions);
      appendEvent(
        id,
        makeEvent(
          SAVE_EVENT[source],
          `v${rev} ${revision.note}`,
          {
            ...(input.detail ?? {}),
            source,
            chars: content.length,
            beforeChars: previous.length,
            hash: revision.hash,
          },
          rev,
        ),
      );
    }
    if (titleChanged) {
      const previousTitle = meta.title;
      meta.title = nextTitle;
      meta.updatedAt = nowIso();
      appendEvent(
        id,
        makeEvent('doc-renamed', `重命名为「${nextTitle}」`, { from: previousTitle, to: nextTitle }),
      );
    }
    writeJsonAtomic(join(folder, 'meta.json'), meta);
    return { doc: toSummary(meta), revision, unchanged: false };
  });
}

export function appendAudit(id: string, input: AuditEventInput): AuditEvent {
  readMeta(id);
  if (!input || typeof input.type !== 'string' || typeof input.summary !== 'string') {
    throw new DocStoreError('bad-event', '留痕事件缺少 type/summary。', 400);
  }
  const allowed: AuditEventType[] = [
    'doc-created',
    'doc-saved',
    'doc-renamed',
    'doc-deleted',
    'doc-opened',
    'ai-proposal',
    'ai-accepted',
    'ai-rejected',
    'docx-imported',
    'markdown-imported',
    'version-restored',
  ];
  if (!allowed.includes(input.type)) throw new DocStoreError('bad-event-type', '未知的留痕事件类型。', 400);
  const event = makeEvent(input.type, input.summary, input.detail, input.rev);
  appendEvent(id, event);
  return event;
}

export function getHistory(id: string): DocHistory {
  readMeta(id);
  return { docId: id, events: readAudit(id), revisions: readRevisions(id) };
}

export function getRevisionContent(id: string, rev: number): { rev: number; content: string } {
  if (!Number.isInteger(rev) || rev < 1) throw new DocStoreError('bad-revision', '版本号不合法。', 400);
  const meta = readMeta(id);
  if (rev > meta.revisionCount) throw new DocStoreError('revision-not-found', '版本不存在。', 404);
  const file = join(folderOf(id), 'revisions', revisionFile(rev));
  if (!existsSync(file)) throw new DocStoreError('revision-not-found', '版本文件不存在。', 404);
  return { rev, content: readFileSync(file, 'utf8') };
}

export async function restoreRevision(id: string, rev: number): Promise<SaveDocResponse> {
  const { content } = getRevisionContent(id, rev);
  return saveDoc(id, {
    content,
    source: 'restore',
    note: `恢复自 v${rev}`,
    detail: { restoredFrom: rev },
  });
}

export async function renameDoc(id: string, title: string): Promise<DocSummary> {
  return withLock(id, () => {
    const meta = readMeta(id);
    const nextTitle = safeTitle(title, meta.title);
    if (nextTitle === meta.title) return toSummary(meta);
    const previousTitle = meta.title;
    meta.title = nextTitle;
    meta.updatedAt = nowIso();
    writeJsonAtomic(join(folderOf(id), 'meta.json'), meta);
    appendEvent(id, makeEvent('doc-renamed', `重命名为「${nextTitle}」`, { from: previousTitle, to: nextTitle }));
    return toSummary(meta);
  });
}

export function deleteDoc(id: string): { id: string; trashedTo: string } {
  const meta = readMeta(id);
  const folder = folderOf(id);
  const target = join(trashDir(), `${id}-${Date.now()}`);
  appendEvent(id, makeEvent('doc-deleted', `删除文档「${meta.title}」`, { title: meta.title, trashedTo: target }));
  mkdirSync(trashDir(), { recursive: true });
  renameSync(folder, target);
  return { id, trashedTo: target };
}

export function docFolder(id: string): string {
  return folderOf(id);
}

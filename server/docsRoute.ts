/**
 * /api/docs —— 文档库 API。
 *
 * 每个文档一个子文件夹（document.md / meta.json / audit.jsonl / revisions/），
 * 支持新建、列表、打开、保存（产生版本）、重命名、删除（移入 trash）、
 * 历史留痕、版本内容、回滚、追加审计事件、在资源管理器中打开文件夹。
 */
import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config } from './config';
import {
  DocStoreError,
  appendAudit,
  createDoc,
  deleteDoc,
  docFolder,
  getDoc,
  getHistory,
  getRevisionContent,
  listDocs,
  renameDoc,
  restoreRevision,
  saveDoc,
  ensureDocStore,
} from './docStore';
import type { AuditEventInput, CreateDocInput, SaveDocInput } from '../src/core/docs';

const TITLE_MAX = 200;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, error: message });
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof DocStoreError) {
    fail(res, error.status, error.code, error.message);
    return;
  }
  console.error('[docs] 未处理错误:', error);
  fail(res, 500, 'internal-error', '文档库操作失败，请稍后重试。');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function parseRev(value: unknown): number | null {
  const rev = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(rev) && rev > 0 ? rev : null;
}

export const docsRouter = Router();

docsRouter.get('/', (_req, res) => {
  try {
    ensureDocStore();
    res.json({
      docs: listDocs(),
      root: join(config.dataDir, 'docs'),
      maxChars: config.limits.maxDocumentChars,
    });
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.post('/', (req, res) => {
  try {
    const body = parseBody(req);
    const title = asString(body.title).trim();
    if (!title) {
      fail(res, 400, 'empty-title', '请填写文档标题。');
      return;
    }
    if (title.length > TITLE_MAX) {
      fail(res, 400, 'title-too-long', `标题不能超过 ${TITLE_MAX} 字。`);
      return;
    }
    const input: CreateDocInput = { title, content: asString(body.content) };
    const doc = createDoc(input);
    res.status(201).json({ doc });
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.get('/:id', (req, res) => {
  try {
    res.json({ doc: getDoc(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.put('/:id', async (req, res) => {
  try {
    const body = parseBody(req);
    if (typeof body.content !== 'string') {
      fail(res, 400, 'bad-content', '缺少文档内容。');
      return;
    }
    const input: SaveDocInput = {
      content: body.content,
      title: body.title === undefined ? undefined : asString(body.title),
      source: typeof body.source === 'string' ? (body.source as SaveDocInput['source']) : 'manual-save',
      note: asString(body.note),
      detail: body.detail && typeof body.detail === 'object' ? (body.detail as Record<string, unknown>) : undefined,
    };
    const result = await saveDoc(req.params.id, input);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.patch('/:id', async (req, res) => {
  try {
    const body = parseBody(req);
    const title = asString(body.title).trim();
    if (!title) {
      fail(res, 400, 'empty-title', '请填写文档标题。');
      return;
    }
    if (title.length > TITLE_MAX) {
      fail(res, 400, 'title-too-long', `标题不能超过 ${TITLE_MAX} 字。`);
      return;
    }
    res.json({ doc: await renameDoc(req.params.id, title) });
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.delete('/:id', (req, res) => {
  try {
    res.json({ ok: true, ...deleteDoc(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.get('/:id/history', (req, res) => {
  try {
    res.json(getHistory(req.params.id));
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.get('/:id/revisions/:rev', (req, res) => {
  try {
    const rev = parseRev(req.params.rev);
    if (rev === null) {
      fail(res, 400, 'bad-revision', '版本号不合法。');
      return;
    }
    res.json(getRevisionContent(req.params.id, rev));
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.post('/:id/restore', async (req, res) => {
  try {
    const body = parseBody(req);
    const rev = parseRev(body.rev);
    if (rev === null) {
      fail(res, 400, 'bad-revision', '版本号不合法。');
      return;
    }
    res.json(await restoreRevision(req.params.id, rev));
  } catch (error) {
    handleError(res, error);
  }
});

docsRouter.post('/:id/audit', (req, res) => {
  try {
    const body = parseBody(req);
    const input: AuditEventInput = {
      type: body.type as AuditEventInput['type'],
      summary: asString(body.summary),
      detail: body.detail && typeof body.detail === 'object' ? (body.detail as Record<string, unknown>) : undefined,
      rev: parseRev(body.rev) ?? undefined,
    };
    res.status(201).json({ event: appendAudit(req.params.id, input) });
  } catch (error) {
    handleError(res, error);
  }
});

/** 在系统文件管理器中打开该文档的子文件夹（仅本机可用） */
docsRouter.post('/:id/reveal', (req, res) => {
  try {
    getDoc(req.params.id);
    const folder = docFolder(req.params.id);
    const platform = process.platform;
    const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [folder], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true, folder });
  } catch (error) {
    handleError(res, error);
  }
});

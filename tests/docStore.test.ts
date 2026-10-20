/**
 * 服务端文档库：子文件夹、版本快照、追加式留痕。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dataDir: string;
let store: typeof import('../server/docStore');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'docmax-store-'));
  process.env.DOCMAX_DATA_DIR = dataDir;
  const { vi } = await import('vitest');
  vi.resetModules();
  store = await import('../server/docStore');
});

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DOCMAX_DATA_DIR;
});

describe('文档库文件布局', () => {
  it('新建文档 → 独立子文件夹 + 首版本 + 创建留痕', () => {
    const doc = store.createDoc({ title: '测试文档', content: '# 标题\n\n第一段。\n' });
    expect(doc.title).toBe('测试文档');
    expect(doc.revisionCount).toBe(1);
    expect(doc.chars).toBe('# 标题\n\n第一段。\n'.length);
    const folder = join(dataDir, 'docs', doc.id);
    expect(existsSync(join(folder, 'document.md'))).toBe(true);
    expect(existsSync(join(folder, 'meta.json'))).toBe(true);
    expect(existsSync(join(folder, 'audit.jsonl'))).toBe(true);
    expect(existsSync(join(folder, 'revisions', '000001.md'))).toBe(true);
    expect(readFileSync(join(folder, 'document.md'), 'utf8')).toContain('第一段');
    const history = store.getHistory(doc.id);
    expect(history.events[0].type).toBe('doc-created');
    expect(history.revisions.map((r) => r.rev)).toEqual([1]);
  });

  it('保存内容产生新版本；内容相同不产生版本', async () => {
    const doc = store.createDoc({ title: '版本测试', content: 'v1' });
    const first = await store.saveDoc(doc.id, { content: 'v2', source: 'auto-save', detail: { reason: '测试' } });
    expect(first.unchanged).toBe(false);
    expect(first.revision?.rev).toBe(2);
    expect(first.revision?.source).toBe('auto-save');
    const second = await store.saveDoc(doc.id, { content: 'v2', source: 'auto-save' });
    expect(second.unchanged).toBe(true);
    expect(second.revision).toBeNull();
    const detail = store.getDoc(doc.id);
    expect(detail.revisionCount).toBe(2);
    expect(detail.content).toBe('v2');
    const history = store.getHistory(doc.id);
    expect(history.events.some((e) => e.type === 'doc-saved' && e.rev === 2)).toBe(true);
  });

  it('重命名只写留痕、不产生版本', async () => {
    const doc = store.createDoc({ title: '旧标题', content: 'x' });
    const renamed = await store.renameDoc(doc.id, '新标题');
    expect(renamed.title).toBe('新标题');
    expect(renamed.revisionCount).toBe(1);
    const history = store.getHistory(doc.id);
    expect(history.events.some((e) => e.type === 'doc-renamed')).toBe(true);
  });

  it('回滚历史版本：生成新版本且内容等于旧版本', async () => {
    const doc = store.createDoc({ title: '回滚', content: '第一版内容' });
    await store.saveDoc(doc.id, { content: '第二版内容', source: 'manual-save' });
    await store.saveDoc(doc.id, { content: '第三版内容', source: 'manual-save' });
    const restored = await store.restoreRevision(doc.id, 1);
    expect(restored.revision?.source).toBe('restore');
    expect(restored.revision?.rev).toBe(4);
    expect(store.getDoc(doc.id).content).toBe('第一版内容');
    const history = store.getHistory(doc.id);
    expect(history.events.some((e) => e.type === 'version-restored')).toBe(true);
    expect(store.getRevisionContent(doc.id, 1).content).toBe('第一版内容');
  });

  it('AI 提案/拒绝等非内容事件可追加并出现在历史中', () => {
    const doc = store.createDoc({ title: 'AI 留痕', content: '原文' });
    store.appendAudit(doc.id, {
      type: 'ai-proposal',
      summary: 'AI 提案：润色',
      detail: { instruction: '润色', model: 'deepseek-flash', presetId: 'default', before: '原文', after: '新文' },
    });
    store.appendAudit(doc.id, { type: 'ai-rejected', summary: '用户拒绝了提案', detail: { reason: '不满意' } });
    const history = store.getHistory(doc.id);
    expect(history.events.map((e) => e.type)).toContain('ai-proposal');
    expect(history.events.at(-1)?.type).toBe('ai-rejected');
    expect(history.events.find((e) => e.type === 'ai-proposal')?.detail?.presetId).toBe('default');
  });

  it('删除文档只移入 trash，留痕随文件夹保留', () => {
    const doc = store.createDoc({ title: '删除测试', content: '内容' });
    const deleted = store.deleteDoc(doc.id);
    expect(existsSync(join(dataDir, 'docs', doc.id))).toBe(false);
    expect(existsSync(deleted.trashedTo)).toBe(true);
    expect(existsSync(join(deleted.trashedTo, 'audit.jsonl'))).toBe(true);
    expect(store.listDocs().some((d) => d.id === doc.id)).toBe(false);
    expect(readdirSync(join(dataDir, 'trash'))).toContain(`${doc.id}-${deleted.trashedTo.split('-').at(-1)}`);
  });

  it('拒绝路径穿越与非法 id', () => {
    expect(() => store.getDoc('../escape')).toThrow();
    expect(() => store.getDoc('..')).toThrow();
  });

  it('列表按更新时间倒序并返回文件夹绝对路径', async () => {
    const a = store.createDoc({ title: '列表 A', content: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = store.createDoc({ title: '列表 B', content: 'b' });
    const docs = store.listDocs();
    const ids = docs.map((d) => d.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(docs.find((d) => d.id === b.id)?.folder).toBe(join(dataDir, 'docs', b.id));
  });
});

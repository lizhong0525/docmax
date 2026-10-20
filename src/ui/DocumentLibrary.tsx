/**
 * 文档库：新建 / 打开 / 重命名 / 删除（移入回收站）/ 打开子文件夹。
 */
import { useEffect, useMemo, useState } from 'react';
import type { DocSummary } from '../core/docs';
import { IconClose, IconFolder } from './Icons';

export interface DocumentLibraryProps {
  open: boolean;
  docs: DocSummary[];
  activeDocId: string | null;
  root: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (title: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReveal: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DocumentLibrary(props: DocumentLibraryProps) {
  const { open, docs, activeDocId } = props;
  const [newTitle, setNewTitle] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewTitle('');
    setEditingId(null);
    setBusyId(null);
  }, [open]);

  const activeDoc = useMemo(() => docs.find((doc) => doc.id === activeDocId) ?? null, [docs, activeDocId]);

  if (!open) return null;

  const run = async (id: string | null, fn: () => Promise<void>): Promise<void> => {
    setBusyId(id ?? 'new');
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const create = async (): Promise<void> => {
    const title = newTitle.trim() || `未命名文档 ${new Date().toLocaleDateString('zh-CN')}`;
    await run(null, async () => {
      await props.onCreate(title);
      setNewTitle('');
    });
  };

  const startRename = (doc: DocSummary): void => {
    setEditingId(doc.id);
    setEditTitle(doc.title);
    setError(null);
  };

  const commitRename = async (doc: DocSummary): Promise<void> => {
    const title = editTitle.trim();
    if (!title || title === doc.title) {
      setEditingId(null);
      return;
    }
    await run(doc.id, async () => {
      await props.onRename(doc.id, title);
      setEditingId(null);
    });
  };

  const confirmDelete = async (doc: DocSummary): Promise<void> => {
    const ok = window.confirm(`删除「${doc.title}」？\n\n文档会移入数据目录的 trash/ 回收站，历史版本与留痕都会保留，不会物理删除。`);
    if (!ok) return;
    await run(doc.id, async () => {
      await props.onDelete(doc.id);
    });
  };

  const copyRoot = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.root);
      setError(null);
    } catch {
      setError('复制路径失败，请手动选择路径。');
    }
  };

  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="lib-card" role="dialog" aria-modal="true" aria-label="文档库" data-testid="doc-library">
        <header className="lib-head">
          <div>
            <h2>文档库</h2>
            <p className="lib-sub">
              每个文档一个子文件夹：<code>document.md</code> + <code>revisions/</code> + <code>audit.jsonl</code>
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭文档库">
            <IconClose />
          </button>
        </header>

        <div className="lib-path" title={props.root}>
          <span className="lib-path-label">数据目录</span>
          <code data-testid="docs-root">{props.root || '（连接中…）'}</code>
          <button type="button" className="link-btn" onClick={() => void copyRoot()} disabled={!props.root}>
            复制路径
          </button>
          <button type="button" className="link-btn" onClick={() => void props.onRefresh()} disabled={props.loading}>
            刷新
          </button>
        </div>

        <div className="lib-new">
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (busyId === null) void create();
              }
            }}
            placeholder="新文档标题，例如：项目周报"
            aria-label="新文档标题"
            data-testid="new-doc-title"
            maxLength={200}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={busyId !== null}
            data-testid="new-doc"
          >
            <IconFolder />
            新建文档
          </button>
        </div>

        {error ? (
          <p className="lib-error" role="alert" data-testid="doc-library-error">
            {error}
          </p>
        ) : null}

        <div className="lib-list" data-testid="doc-list">
          {props.loading ? <p className="lib-empty">正在加载文档…</p> : null}
          {!props.loading && docs.length === 0 ? <p className="lib-empty">还没有文档。输入标题并点「新建文档」。</p> : null}
          {docs.map((doc) => {
            const isActive = doc.id === activeDocId;
            return (
              <div
                key={doc.id}
                className={`lib-row${isActive ? ' is-active' : ''}`}
                data-testid={`doc-row-${doc.id}`}
                data-doc-id={doc.id}
              >
                <button
                  type="button"
                  className="lib-open"
                  onClick={() => void run(doc.id, () => props.onOpen(doc.id))}
                  disabled={busyId !== null}
                  data-testid={`open-doc-${doc.id}`}
                  title={doc.folder}
                >
                  <span className="lib-doc-icon" aria-hidden="true">
                    #
                  </span>
                  <span className="lib-doc-main">
                    {editingId === doc.id ? (
                      <input
                        className="lib-rename-input"
                        value={editTitle}
                        autoFocus
                        onChange={(event) => setEditTitle(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void commitRename(doc);
                          }
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                        maxLength={200}
                        data-testid="rename-input"
                      />
                    ) : (
                      <span className="lib-doc-title">{doc.title}</span>
                    )}
                    <span className="lib-doc-meta">
                      {formatTime(doc.updatedAt)} · {doc.chars.toLocaleString('zh-CN')} 字 · v{doc.revisionCount}
                      {isActive ? ' · 当前文档' : ''}
                    </span>
                  </span>
                </button>
                <div className="lib-row-actions">
                  {editingId === doc.id ? (
                    <>
                      <button type="button" className="link-btn" onClick={() => void commitRename(doc)} disabled={busyId !== null}>
                        保存
                      </button>
                      <button type="button" className="link-btn" onClick={() => setEditingId(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="link-btn" onClick={() => startRename(doc)} disabled={busyId !== null}>
                        重命名
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => void run(doc.id, () => props.onReveal(doc.id))}
                        disabled={busyId !== null}
                        title="在资源管理器中打开该文档的子文件夹"
                      >
                        文件夹
                      </button>
                      <button type="button" className="link-btn link-danger" onClick={() => void confirmDelete(doc)} disabled={busyId !== null}>
                        删除
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <footer className="lib-foot">
          <span>
            {activeDoc ? `当前：${activeDoc.title}` : '未打开文档'} · 删除仅移入 <code>trash/</code>，全程留痕
          </span>
          <span>共 {docs.length} 个文档</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * 审阅 / 留痕面板：
 * - 时间线展示该文档的完整审计事件（创建、保存、AI 提案/接受/拒绝、重命名、导入、回滚…）
 * - 事件可按版本查看差异（对比上一版本），或回滚到任意历史版本
 * - 可导出完整留痕 JSON
 */
import { useEffect, useMemo, useState } from 'react';
import type { AuditEvent, AuditEventType, DocHistory, RevisionSummary } from '../core/docs';
import { docApi } from './docApi';
import { DiffView } from './DiffView';
import { IconClose } from './Icons';

export interface HistoryPanelProps {
  open: boolean;
  docId: string | null;
  docTitle: string;
  /** 变化时自动刷新（保存 / 接受 AI 后递增） */
  refreshKey: number;
  onClose: () => void;
  onRestored: (content: string, rev: number) => void;
}

type Filter = 'all' | 'ai' | 'versions';

const EVENT_META: Record<AuditEventType, { icon: string; label: string; tone: string }> = {
  'doc-created': { icon: '✦', label: '创建', tone: 'create' },
  'doc-saved': { icon: '💾', label: '保存', tone: 'save' },
  'doc-renamed': { icon: '✎', label: '重命名', tone: 'meta' },
  'doc-deleted': { icon: '🗑', label: '删除', tone: 'danger' },
  'doc-opened': { icon: '↗', label: '打开', tone: 'meta' },
  'ai-proposal': { icon: '🤖', label: 'AI 提案', tone: 'ai' },
  'ai-accepted': { icon: '✅', label: 'AI 已接受', tone: 'ai-accept' },
  'ai-rejected': { icon: '✕', label: 'AI 已拒绝', tone: 'ai-reject' },
  'docx-imported': { icon: '⤓', label: '导入 Word', tone: 'import' },
  'markdown-imported': { icon: '⤓', label: '导入 Markdown', tone: 'import' },
  'version-restored': { icon: '↺', label: '回滚版本', tone: 'restore' },
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function stringField(detail: Record<string, unknown> | undefined, key: string): string {
  const value = detail?.[key];
  return typeof value === 'string' ? value : '';
}

function short(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { open, docId } = props;
  const [history, setHistory] = useState<DocHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyRev, setBusyRev] = useState<number | null>(null);
  const [diff, setDiff] = useState<{
    rev: number;
    before: string;
    after: string;
    beforeLabel: string;
    afterLabel: string;
  } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const loadHistory = async (): Promise<void> => {
    if (!docId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await docApi.history(docId);
      setHistory(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !docId) return;
    setHistory(null);
    setDiff(null);
    setDiffError(null);
    setExpanded(null);
    setFilter('all');
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docId, props.refreshKey]);

  const revisionMap = useMemo(() => {
    const map = new Map<number, RevisionSummary>();
    for (const revision of history?.revisions ?? []) map.set(revision.rev, revision);
    return map;
  }, [history]);

  const events = useMemo(() => {
    const list = [...(history?.events ?? [])].reverse();
    if (filter === 'ai') return list.filter((event) => event.type.startsWith('ai-'));
    if (filter === 'versions') return list.filter((event) => typeof event.rev === 'number');
    return list;
  }, [history, filter]);

  if (!open) return null;

  const loadDiff = async (rev: number): Promise<void> => {
    if (!docId) return;
    setDiffError(null);
    setBusyRev(rev);
    try {
      const current = await docApi.revision(docId, rev);
      let before = '';
      let beforeLabel = '（文档开头）';
      if (rev > 1) {
        before = (await docApi.revision(docId, rev - 1)).content;
        beforeLabel = `v${rev - 1}`;
      }
      setDiff({ rev, before, after: current.content, beforeLabel, afterLabel: `v${rev}` });
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRev(null);
    }
  };

  const restore = async (rev: number): Promise<void> => {
    if (!docId) return;
    const ok = window.confirm(`回滚到 v${rev}？\n\n当前内容会先作为新版本保留（不会丢失），回滚本身也会写入留痕。`);
    if (!ok) return;
    setBusyRev(rev);
    setError(null);
    try {
      const result = await docApi.restore(docId, rev);
      const detail = await docApi.get(docId);
      props.onRestored(detail.doc.content, result.revision?.rev ?? rev);
      await loadHistory();
      setDiff(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRev(null);
    }
  };

  const downloadAudit = (): void => {
    if (!history) return;
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${props.docTitle || 'docmax'}-留痕-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const renderEventDetail = (event: AuditEvent) => {
    const detail = event.detail;
    const instruction = stringField(detail, 'instruction');
    const model = stringField(detail, 'model');
    const preset = stringField(detail, 'presetId');
    const mode = stringField(detail, 'mode');
    const before = stringField(detail, 'before');
    const after = stringField(detail, 'after');
    const source = stringField(detail, 'source');
    return (
      <div className="audit-detail">
        <div className="audit-detail-meta">
          {instruction ? <span title={instruction}>指令：{short(instruction, 60)}</span> : null}
          {model ? <span>模型：{model}</span> : null}
          {preset ? <span>提示词：{preset}</span> : null}
          {mode ? <span>模式：{mode}</span> : null}
          {source ? <span>来源：{source}</span> : null}
          {typeof event.rev === 'number' ? <span>版本：v{event.rev}</span> : null}
        </div>
        {before || after ? (
          <div className="audit-diff">
            <div className="audit-diff-labels">
              <span>修改前</span>
              <span>修改后</span>
            </div>
            <DiffView before={before} after={after} />
          </div>
        ) : null}
        {typeof event.rev === 'number' ? (
          <div className="audit-actions">
            <button
              type="button"
              className="link-btn"
              onClick={() => void loadDiff(event.rev as number)}
              disabled={busyRev !== null}
              data-testid={`audit-diff-${event.rev}`}
            >
              {busyRev === event.rev ? '加载中…' : '对比版本内容'}
            </button>
            <button
              type="button"
              className="link-btn link-danger"
              onClick={() => void restore(event.rev as number)}
              disabled={busyRev !== null}
              data-testid={`audit-restore-${event.rev}`}
            >
              回滚到 v{event.rev}
            </button>
            {revisionMap.get(event.rev) ? <span className="audit-note">{revisionMap.get(event.rev)?.note}</span> : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="history-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <aside className="history-panel" role="dialog" aria-modal="true" aria-label="审阅与留痕" data-testid="history-panel">
        <header className="history-head">
          <div>
            <span className="review-eyebrow">审阅 · 留痕</span>
            <h2>{props.docTitle || '当前文档'}</h2>
            <p className="history-sub">
              {history ? `${history.events.length} 条事件 · ${history.revisions.length} 个版本 · 全程追加式记录` : '加载中…'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭审阅面板">
            <IconClose />
          </button>
        </header>

        <div className="history-toolbar">
          <div className="history-filters" role="group" aria-label="留痕筛选">
            {(
              [
                ['all', '全部'],
                ['ai', 'AI 修改'],
                ['versions', '版本'],
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`chip${filter === value ? ' is-active' : ''}`}
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                data-testid={`history-filter-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="history-toolbar-actions">
            <button type="button" className="link-btn" onClick={() => void loadHistory()} disabled={loading}>
              刷新
            </button>
            <button type="button" className="link-btn" onClick={downloadAudit} disabled={!history}>
              导出留痕 JSON
            </button>
          </div>
        </div>

        {error ? (
          <p className="history-error" role="alert" data-testid="history-error">
            {error}
          </p>
        ) : null}
        {diffError ? <p className="history-error">{diffError}</p> : null}

        {diff ? (
          <div className="history-diff-panel" data-testid="history-diff">
            <div className="history-diff-head">
              <strong>
                版本对比：{diff.beforeLabel} → {diff.afterLabel}
              </strong>
              <button type="button" className="link-btn" onClick={() => setDiff(null)}>
                收起
              </button>
            </div>
            <DiffView before={diff.before} after={diff.after} />
          </div>
        ) : null}

        <div className="history-body" data-testid="history-list">
          {loading && !history ? <p className="history-empty">正在加载留痕…</p> : null}
          {!loading && history && events.length === 0 ? <p className="history-empty">没有匹配的留痕事件。</p> : null}
          {events.map((event) => {
            const meta = EVENT_META[event.type] ?? { icon: '•', label: event.type, tone: 'meta' };
            const expandedHere = expanded === event.id;
            const hasDetail = Boolean(event.detail && Object.keys(event.detail).length > 0);
            return (
              <article key={event.id} className={`audit-item audit-${meta.tone}`} data-testid={`audit-${event.type}`}>
                <button
                  type="button"
                  className="audit-summary"
                  onClick={() => setExpanded(expandedHere ? null : event.id)}
                  aria-expanded={expandedHere}
                >
                  <span className="audit-icon" aria-hidden="true">
                    {meta.icon}
                  </span>
                  <span className="audit-main">
                    <span className="audit-line">
                      <span className="audit-type">{meta.label}</span>
                      <span className="audit-text">{event.summary}</span>
                      {typeof event.rev === 'number' ? <span className="audit-rev">v{event.rev}</span> : null}
                    </span>
                    <span className="audit-time">{formatDateTime(event.at)}</span>
                  </span>
                  <span className={`audit-chevron${expandedHere ? ' is-open' : ''}`} aria-hidden="true">
                    ⌄
                  </span>
                </button>
                {expandedHere ? (
                  hasDetail || typeof event.rev === 'number' ? renderEventDetail(event) : <p className="audit-detail-empty">无更多详情</p>
                ) : null}
              </article>
            );
          })}
        </div>

        <footer className="history-foot">
          <span>留痕包括：AI 提案 / 接受 / 拒绝、每次保存、版本回滚、重命名、导入、删除。</span>
        </footer>
      </aside>
    </div>
  );
}

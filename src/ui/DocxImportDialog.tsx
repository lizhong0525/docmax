/**
 * DOCX 导入确认浮层：展示转换摘要、警告与 Markdown 预览，用户确认后替换当前文档。
 */
import { useEffect, useMemo, useRef } from 'react';
import { formatBytes, type DocxImportResult } from './docxImport';
import { IconClose } from './Icons';

export type DocxImportPhase = 'converting' | 'ready' | 'error';

export interface DocxImportState {
  phase: DocxImportPhase;
  fileName: string;
  result: DocxImportResult | null;
  error: string | null;
}

export interface DocxImportDialogProps {
  state: DocxImportState;
  maxBytes: number;
  hasExistingDoc: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}

const PREVIEW_LINES = 28;

function previewText(markdown: string): { text: string; truncated: boolean } {
  const lines = markdown.split('\n');
  if (lines.length <= PREVIEW_LINES) return { text: markdown, truncated: false };
  return { text: lines.slice(0, PREVIEW_LINES).join('\n'), truncated: true };
}

export function DocxImportDialog({ state, maxBytes, hasExistingDoc, onCancel, onConfirm, onRetry }: DocxImportDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const ready = state.phase === 'ready' && state.result;

  useEffect(() => {
    if (ready) confirmRef.current?.focus();
  }, [ready]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const preview = useMemo(() => (state.result ? previewText(state.result.markdown) : null), [state.result]);

  return (
    <div
      className="overlay"
      role="presentation"
      data-testid="docx-import-dialog"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div className="docx-card" role="dialog" aria-modal="true" aria-label="导入 Word 文档">
        <header className="docx-head">
          <div>
            <h2>导入 Word 文档</h2>
            <p className="docx-file" data-testid="docx-import-file">
              {state.fileName}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="关闭导入窗口">
            <IconClose />
          </button>
        </header>

        {state.phase === 'converting' ? (
          <div className="docx-body docx-loading" data-testid="docx-import-loading">
            <span className="docx-spinner" aria-hidden="true" />
            <p>正在解析 Word 文档并转换为 Markdown…</p>
          </div>
        ) : null}

        {state.phase === 'error' ? (
          <div className="docx-body">
            <p className="docx-error" role="alert" data-testid="docx-import-error">
              {state.error || '导入失败，请重试。'}
            </p>
            <p className="docx-hint">支持 .docx（Word 2007+），大小不超过 {formatBytes(maxBytes)}。</p>
          </div>
        ) : null}

        {ready && state.result ? (
          <div className="docx-body">
            <div className="docx-stats" data-testid="docx-import-stats">
              {[
                ['标题', state.result.stats.headings],
                ['段落', state.result.stats.paragraphs],
                ['列表项', state.result.stats.listItems],
                ['表格', state.result.stats.tables],
                ['代码块', state.result.stats.codeBlocks],
                ['图片占位', state.result.stats.images],
                ['字符', state.result.stats.chars],
              ].map(([label, value]) => (
                <span className="docx-stat" key={String(label)}>
                  <em>{label}</em>
                  <strong>{value}</strong>
                </span>
              ))}
              <span className="docx-size">{formatBytes(state.result.stats.sourceBytes)}</span>
            </div>

            {state.result.warnings.length ? (
              <ul className="docx-warnings" data-testid="docx-import-warnings">
                {state.result.warnings.map((warning) => (
                  <li key={warning.code + warning.message}>{warning.message}</li>
                ))}
              </ul>
            ) : null}

            <p className="docx-hint">
              图片不会导出，已用可读的占位符替代（<code>&gt; [图片占位 N：…]</code>）；表格、标题、列表、链接按 Word 样式转换。
            </p>

            <div className="docx-preview-label">
              Markdown 预览{preview?.truncated ? `（前 ${PREVIEW_LINES} 行）` : ''}
            </div>
            <pre className="docx-preview" data-testid="docx-import-preview">
              {preview?.text ?? ''}
            </pre>

            {hasExistingDoc ? (
              <p className="docx-warning-replace">
                导入会创建为新文档，当前文档会完整保留在文档库中（含版本与留痕）。
              </p>
            ) : null}

            <div className="docx-actions">
              <button type="button" className="btn btn-ghost" onClick={onCancel} data-testid="docx-import-cancel">
                取消
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="btn btn-primary"
                onClick={onConfirm}
                data-testid="docx-import-confirm"
              >
                创建新文档并打开
              </button>
            </div>
          </div>
        ) : null}

        {state.phase === 'error' ? (
          <div className="docx-actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel} data-testid="docx-import-cancel">
              关闭
            </button>
            <button type="button" className="btn btn-primary" onClick={onRetry} data-testid="docx-import-retry">
              重试
            </button>
          </div>
        ) : null}

        {state.phase === 'converting' ? (
          <div className="docx-actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel} data-testid="docx-import-cancel">
              取消
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

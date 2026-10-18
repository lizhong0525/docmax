/**
 * Markdown 渲染：marked + DOMPurify。
 * 编辑器的预览模式与「解释」模式的回答都用同一套渲染，保证样式一致。
 */
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface MarkdownPreviewProps {
  docText: string;
  /** 外层容器 class，默认 prose */
  className?: string;
  /** 用于测试定位，默认 preview */
  testId?: string;
}

export function MarkdownPreview({ docText, className = 'prose', testId = 'preview' }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    if (!docText.trim()) return '';
    try {
      const raw = marked.parse(docText, { async: false, gfm: true, breaks: false }) as string;
      return DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'iframe', 'form', 'input'],
        FORBID_ATTR: ['style', 'onerror', 'onload'],
      });
    } catch {
      return '<p class="preview-error">渲染失败，请检查 Markdown 语法。</p>';
    }
  }, [docText]);

  if (!html) {
    return (
      <div className="preview-empty" aria-live="polite">
        文档还是空的。切回编辑，写点什么吧。
      </div>
    );
  }

  return <article className={className} data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />;
}

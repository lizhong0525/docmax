/**
 * CodeMirror 6 视觉主题：颜色全部走 CSS 变量，让浅色 / 深色由 styles.css 统一控制。
 * 这里只负责「正文排版 + 语法高亮语气」，不做任何装饰性花活。
 */
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export function buildEditorTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        color: 'var(--ink)',
        backgroundColor: 'transparent',
        height: '100%',
        fontSize: 'var(--editor-font-size, 17.5px)',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-serif)',
        lineHeight: '1.8',
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '28px var(--editor-gutter, 56px) 140px',
      },
      '.cm-content': {
        padding: '0',
        caretColor: 'var(--accent)',
      },
      '.cm-line': {
        padding: '0',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeft: '2px solid var(--accent)',
      },
      '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: 'var(--selection)',
        },
      '.cm-placeholder': {
        color: 'var(--muted)',
        fontStyle: 'italic',
      },
      '.cm-gutters': {
        display: 'none',
      },
      '.cm-panels': {
        backgroundColor: 'var(--paper)',
        color: 'var(--ink)',
      },
      '.cm-tooltip': {
        border: '1px solid var(--rule)',
        backgroundColor: 'var(--paper)',
        color: 'var(--ink)',
      },
      '.cm-activeLine': {
        backgroundColor: 'transparent',
      },
      '.cm-matchingBracket': {
        backgroundColor: 'var(--selection)',
        outline: '1px solid var(--rule)',
      },
    },
    { dark },
  );
}

/**
 * Markdown 高亮语气：标题加粗放大、强调用斜体、标记符号压暗、行内代码用等宽。
 * 保持单一强调色 —— 只有链接和光标使用 accent。
 */
export function buildEditorHighlight() {
  return HighlightStyle.define([
    { tag: t.heading1, color: 'var(--ink)', fontWeight: '700', fontSize: '1.44em', lineHeight: '1.45' },
    { tag: t.heading2, color: 'var(--ink)', fontWeight: '700', fontSize: '1.24em', lineHeight: '1.5' },
    { tag: t.heading3, color: 'var(--ink)', fontWeight: '650', fontSize: '1.1em' },
    { tag: t.heading4, color: 'var(--ink)', fontWeight: '650' },
    { tag: t.heading5, color: 'var(--ink)', fontWeight: '600' },
    { tag: t.heading6, color: 'var(--muted)', fontWeight: '600' },
    { tag: t.strong, color: 'var(--ink)', fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px' },
    { tag: t.url, color: 'var(--muted)' },
    { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
    { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--code-ink)' },
    { tag: t.processingInstruction, color: 'var(--syntax-mark)' },
    { tag: t.contentSeparator, color: 'var(--syntax-mark)' },
    { tag: t.escape, color: 'var(--syntax-mark)' },
    { tag: t.invalid, color: 'var(--danger)' },
  ]);
}

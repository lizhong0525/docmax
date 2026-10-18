/**
 * DOCX → Markdown 转换器（服务端，纯确定性，不经过模型）。
 *
 * 工程选择：
 * - 用 mammoth 把 .docx 的**语义**（样式、标题层级、列表、表格、脚注、链接）转成干净 HTML，
 *   而不是自己解析 OOXML（Word 的 XML 极其复杂，自研成本高且易漏）。
 * - 再用 turndown + GFM 插件把 HTML 转成 Markdown；mammoth 自带的 Markdown 输出已废弃，
 *   官方也推荐"HTML + 独立转 Markdown 库"。
 * - 图片不导出：Word 里的图片以二进制嵌入，转成 base64 会让 md 体积爆炸；这里只做**占位符**，
 *   并统计数量；转换过程不读取图片字节（更快、更省内存）。
 * - 表格：Word 表格通常没有标记表头行（w:tblHeader），GFM 表格必须有表头；
 *   有 th 时用第一行做表头，否则生成空表头，保证数据行不丢失。
 * - 安全：禁用外部文件访问（mammoth 默认）、过滤 javascript:/data: 等危险链接协议。
 */
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export type DocxErrorCode = 'not-docx' | 'too-large' | 'empty-document' | 'conversion-failed';

export class DocxConversionError extends Error {
  code: DocxErrorCode;
  status: number;
  detail?: string;

  constructor(code: DocxErrorCode, message: string, status: number, detail?: string) {
    super(message);
    this.name = 'DocxConversionError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface DocxImageInfo {
  index: number;
  contentType: string;
  alt: string | null;
}

export interface DocxConversionWarning {
  code: string;
  message: string;
}

export interface DocxConversionStats {
  paragraphs: number;
  headings: number;
  listItems: number;
  tables: number;
  images: number;
  codeBlocks: number;
  chars: number;
  words: number;
  sourceBytes: number;
  markdownChars: number;
}

export interface DocxConversionResult {
  markdown: string;
  title: string | null;
  stats: DocxConversionStats;
  warnings: DocxConversionWarning[];
  images: DocxImageInfo[];
}

export interface ConvertDocxOptions {
  fileName?: string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Word 里常见等宽字体：整段都是等宽字体时视为代码块 */
const MONOSPACE_FONTS = new Set([
  'consolas',
  'courier',
  'courier new',
  'menlo',
  'monaco',
  'sf mono',
  'source code pro',
  'fira code',
  'jetbrains mono',
  'cascadia code',
  'cascadia mono',
  'lucida console',
  'monospace',
  '等距更纱黑体',
  '更纱黑体',
]);

/**
 * 自定义样式映射：在 mammoth 默认映射之外补充 Word 常见样式，
 * 尤其是中文版 Word 的本地化样式名与代码/引用样式。
 */
const STYLE_MAP = [
  // 文档标题 / 副标题（mammoth 默认不映射 Title）
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='标题'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='副标题'] => h2:fresh",
  // 中文标题层级（部分中文模板使用本地化名称）
  "p[style-name='标题 1'] => h1:fresh",
  "p[style-name='标题 2'] => h2:fresh",
  "p[style-name='标题 3'] => h3:fresh",
  "p[style-name='标题 4'] => h4:fresh",
  "p[style-name='标题 5'] => h5:fresh",
  "p[style-name='标题 6'] => h6:fresh",
  // 引用样式
  "p[style-name='Quote'] => blockquote",
  "p[style-name='Intense Quote'] => blockquote",
  "p[style-name='引用'] => blockquote",
  // 代码样式（含等宽字体自动识别后注入的 Code 样式）
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='代码'] => pre:separator('\\n')",
  "p[style-name='Code Block'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "p[style-name='Preformatted Text'] => pre:separator('\\n')",
].join('\n');

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function countWords(text: string): number {
  const matches = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu,
  );
  return matches ? matches.length : 0;
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** 提取文本，同时把 <br> 转为换行（代码块里的软换行） */
function textContentWithBreaks(node: any): string {
  let out = '';
  for (const child of Array.from(node.childNodes ?? []) as any[]) {
    if (!child) continue;
    if (child.nodeName === 'BR') out += '\n';
    else if (child.nodeType === 3) out += child.nodeValue ?? '';
    else out += textContentWithBreaks(child);
  }
  return out;
}

function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  if (value.startsWith('#')) return true;
  const lower = value.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:') || lower.startsWith('file:')) {
    return false;
  }
  return true;
}

function buildTurndown(images: DocxImageInfo[]): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '  \n',
  });
  service.use(gfm);

  // 图片：不导出二进制，统一替换为可读占位符（是否保留由用户决定）
  service.addRule('docmaxImage', {
    filter: 'img',
    replacement: (_content, node: any) => {
      const src = String(node.getAttribute('src') ?? '');
      const alt = String(node.getAttribute('alt') ?? '').trim();
      if (src.startsWith('docmax-img:')) {
        const rest = src.slice('docmax-img:'.length);
        const [indexRaw, contentTypeRaw] = rest.split(':');
        const index = Number(indexRaw) || images.length;
        let contentType = 'image';
        try {
          contentType = decodeURIComponent(contentTypeRaw ?? '') || 'image';
        } catch {
          contentType = contentTypeRaw || 'image';
        }
        const altPart = alt ? `，替代文字「${alt}」` : '';
        return `\n\n> [图片占位 ${index}：${contentType}${altPart}，未导出图片文件]\n\n`;
      }
      if (src && isSafeHref(src)) return alt ? `![${alt}](${src})` : `![]( ${src} )`;
      return `\n\n> [图片占位：无法读取图片${alt ? `（${alt}）` : ''}]\n\n`;
    },
  });

  // 链接：过滤危险协议，避免把 docx 里的恶意链接带进 Markdown
  service.addRule('docmaxLink', {
    filter: 'a',
    replacement: (content, node: any) => {
      const href = String(node.getAttribute('href') ?? '').trim();
      const text = content.trim();
      if (!href || !isSafeHref(href)) return text;
      const title = node.getAttribute('title');
      const label = text || href;
      return title ? `[${label}](${href} "${title}")` : `[${label}](${href})`;
    },
  });

  // 下划线在 Markdown 中没有语义，保留文字
  service.addRule('docmaxUnderline', {
    filter: 'u',
    replacement: (content) => content,
  });

  // 表格：优先把第一行当表头；若 Word 没有标记表头，生成空表头，保证数据不丢
  service.addRule('docmaxTable', {
    filter: 'table',
    replacement: (_content, node: any) => {
      const rows: any[] = Array.from(node.rows ?? []);
      if (!rows.length) return '';
      const cellToMarkdown = (cell: any): string => {
        try {
          const inner = service.turndown(cell.innerHTML ?? '');
          return escapeCell(inner);
        } catch {
          return escapeCell(String(cell.textContent ?? ''));
        }
      };
      const headerRow = rows[0];
      const headerCells: any[] = Array.from(headerRow.cells ?? []);
      const isHeader = headerCells.length > 0 && headerCells.every((cell) => String(cell.nodeName).toUpperCase() === 'TH');
      const header = isHeader ? headerCells.map(cellToMarkdown) : headerCells.map(() => '');
      const dataRows = (isHeader ? rows.slice(1) : rows).map((row) => Array.from(row.cells ?? []).map(cellToMarkdown));
      const columnCount = Math.max(header.length, ...dataRows.map((cells) => cells.length), 1);
      const pad = (cells: string[]) => {
        const out = cells.slice(0, columnCount);
        while (out.length < columnCount) out.push('');
        return out;
      };
      const lines: string[] = [];
      lines.push(`| ${pad(header).join(' | ')} |`);
      lines.push(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`);
      for (const row of dataRows) lines.push(`| ${pad(row).join(' | ')} |`);
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });

  // 代码块：保留原文（包括缩进与换行），不额外转义
  service.addRule('docmaxPre', {
    filter: 'pre',
    replacement: (_content, node: any) => {
      const raw = textContentWithBreaks(node).replace(/\r\n/g, '\n').replace(/\n+$/, '');
      if (!raw.trim()) return '';
      const maxTicks = Math.max(3, ...(raw.match(/`+/g) ?? []).map((ticks: string) => ticks.length + 1));
      const fence = '`'.repeat(maxTicks);
      return `\n\n${fence}\n${raw}\n${fence}\n\n`;
    },
  });

  return service;
}

/** 把 mammoth 输出的 HTML 中常见 Word 噪音清理掉（HTML 层面的最后一道处理） */
function tidyHtml(html: string): string {
  return html
    .replace(/<a\s+id="[^"]*"\s*><\/a>/gi, '')
    .replace(/<a\s+name="[^"]*"\s*><\/a>/gi, '')
    .replace(/<\/?o:p[^>]*>/gi, '') // Word 的 o:p 标签
    .replace(/<span[^>]*>\s*<\/span>/gi, '');
}

function tidyMarkdown(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
  // 行尾多余空格（保留两个空格表示硬换行的语义）
  text = text
    .split('\n')
    .map((line) => (line.endsWith('  ') ? line : line.replace(/[ \t]+$/, '')))
    .join('\n');
  // 列表标记后只保留一个空格（turndown 有时会输出 "-   item" 这类多余空格）
  text = text
    .split('\n')
    .map((line) => line.replace(/^(\s*(?:[-*+]|\d{1,9}[.)]))\s{2,}(\S)/, '$1 $2'))
    .join('\n');
  // 压缩连续空行
  text = text.replace(/\n{3,}/g, '\n\n');
  // 空标题/空引用行清理
  text = text
    .split('\n')
    .filter((line) => !/^#{1,6}\s*$/.test(line.trim()) && line.trim() !== '>')
    .join('\n');
  return `${text.trim()}\n`;
}

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
  return match ? match[1].trim() : null;
}

/**
 * 把 .docx 二进制转换为 Markdown。
 * 转换失败会抛出 DocxConversionError（带 HTTP 状态建议）。
 */
export async function convertDocxToMarkdown(
  buffer: Buffer,
  options: ConvertDocxOptions = {},
): Promise<DocxConversionResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!buffer || buffer.length === 0) {
    throw new DocxConversionError('empty-document', '文件为空，无法转换。', 400);
  }
  if (buffer.length > maxBytes) {
    throw new DocxConversionError(
      'too-large',
      `文件超过大小上限（${(maxBytes / 1024 / 1024).toFixed(0)} MB）。`,
      413,
    );
  }
  // docx 本质是 zip：以 PK 开头。提前给出明确错误，避免 mammoth 抛底层异常
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new DocxConversionError('not-docx', '这不是有效的 .docx 文件（文件内容不是 Word 文档）。', 400);
  }

  const images: DocxImageInfo[] = [];
  const warnings: DocxConversionWarning[] = [];

  let html: string;
  let messages: Array<{ type: string; message: string }> = [];
  try {
    const transforms = (mammoth as unknown as { transforms?: any }).transforms;
    const transformDocument = transforms
      ? transforms.paragraph((paragraph: any) => {
          try {
            const runs: any[] = transforms.getDescendantsOfType(paragraph, 'run');
            if (
              runs.length > 0 &&
              runs.every((run) => run.font && MONOSPACE_FONTS.has(String(run.font).toLowerCase()))
            ) {
              return { ...paragraph, styleName: 'Code', styleId: 'Code' };
            }
          } catch {
            // 转换失败时保持原样
          }
          return paragraph;
        })
      : undefined;

    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: STYLE_MAP,
        includeDefaultStyleMap: true,
        // 文档内嵌样式映射不参与（避免文档自带映射影响转换的确定性）
        includeEmbeddedStyleMap: false,
        externalFileAccess: false,
        ignoreEmptyParagraphs: true,
        ...(transformDocument ? { transformDocument } : {}),
        convertImage: mammoth.images.imgElement(async (image) => {
          const index = images.length + 1;
          images.push({ index, contentType: image.contentType || 'image', alt: null });
          return {
            src: `docmax-img:${index}:${encodeURIComponent(image.contentType || 'image')}`,
          };
        }),
      },
    );
    html = result.value;
    messages = result.messages as Array<{ type: string; message: string }>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DocxConversionError('not-docx', '无法解析该 Word 文档，请确认文件未损坏且为 .docx 格式。', 422, detail);
  }

  const turndown = buildTurndown(images);
  let markdown: string;
  try {
    markdown = turndown.turndown(tidyHtml(html));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DocxConversionError('conversion-failed', 'Word 文档转换失败，请尝试另存为 .docx 后重试。', 500, detail);
  }
  markdown = tidyMarkdown(markdown);

  const headings = (html.match(/<h[1-6][\s>]/gi) ?? []).length;
  const paragraphs = (html.match(/<p[\s>]/gi) ?? []).length;
  const listItems = (html.match(/<li[\s>]/gi) ?? []).length;
  const tables = (html.match(/<table[\s>]/gi) ?? []).length;
  const codeBlocks = (html.match(/<pre[\s>]/gi) ?? []).length;

  if (!markdown.trim()) {
    throw new DocxConversionError('empty-document', '文档中没有可转换为 Markdown 的文本内容。', 422);
  }

  if (images.length) {
    warnings.push({
      code: 'images-placeholder',
      message: `文档包含 ${images.length} 张图片，已用占位符替代（未导出图片文件）。`,
    });
  }
  const warningMessages = messages.filter((message) => message.type === 'warning' || message.type === 'error');
  for (const message of warningMessages.slice(0, 8)) {
    warnings.push({ code: message.type === 'error' ? 'mammoth-error' : 'mammoth-warning', message: message.message });
  }
  if (warningMessages.length > 8) {
    warnings.push({ code: 'mammoth-warning-more', message: `还有 ${warningMessages.length - 8} 条转换提示未显示。` });
  }

  const fallbackTitle = options.fileName
    ? options.fileName.replace(/\.docx$/i, '').replace(/[_-]+/g, ' ').trim()
    : null;
  const title = extractTitle(markdown) || fallbackTitle || null;

  return {
    markdown,
    title,
    images,
    warnings,
    stats: {
      paragraphs,
      headings,
      listItems,
      tables,
      images: images.length,
      codeBlocks,
      chars: markdown.length,
      words: countWords(markdown),
      sourceBytes: buffer.length,
      markdownChars: markdown.length,
    },
  };
}

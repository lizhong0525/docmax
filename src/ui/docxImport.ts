/**
 * DOCX 导入（前端部分）：选择 .docx 文件 → 上传到本地服务 /api/import/docx → 拿到 Markdown。
 * 转换全部在服务端完成（mammoth + turndown），浏览器不解析 OOXML；图片不导出，只保留占位符。
 */
export interface DocxImageInfo {
  index: number;
  contentType: string;
  alt: string | null;
}

export interface DocxImportStats {
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

export interface DocxImportWarning {
  code: string;
  message: string;
}

export interface DocxImportResult {
  markdown: string;
  title: string | null;
  stats: DocxImportStats;
  warnings: DocxImportWarning[];
  images: DocxImageInfo[];
}

export class DocxImportError extends Error {
  code: string;
  status: number;
  detail?: string;

  constructor(message: string, code = 'import-failed', status = 0, detail?: string) {
    super(message);
    this.name = 'DocxImportError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

interface FsPickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<Array<{ getFile(): Promise<File> }>>;
}

const pickerWindow = window as unknown as FsPickerWindow;

const DOCX_TYPES = [
  {
    description: 'Word 文档',
    accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
  },
];

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** 选择本地 .docx；用户取消返回 null */
export async function pickDocxFile(): Promise<File | null> {
  if (pickerWindow.showOpenFilePicker) {
    try {
      const handles = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: DOCX_TYPES,
        excludeAcceptAllOption: false,
      });
      const handle = handles?.[0];
      if (!handle) return null;
      return await handle.getFile();
    } catch (error) {
      if (isAbortError(error)) return null;
      // 权限被拒 / 浏览器不支持：继续走 input 兜底
    }
  }
  return pickWithInput();
}

interface DocxApiResponse extends Partial<DocxImportResult> {
  code?: string;
  error?: string;
  detail?: string;
}

/** 上传并转换；失败抛出带中文提示的 DocxImportError */
export async function importDocx(file: File): Promise<DocxImportResult> {
  let response: Response;
  try {
    response = await fetch(`/api/import/docx?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: {
        'Content-Type':
          file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      body: file,
    });
  } catch (error) {
    throw new DocxImportError(
      `无法连接本地服务：${error instanceof Error ? error.message : String(error)}`,
      'network-error',
      0,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  let body: DocxApiResponse | null = null;
  if (contentType.includes('application/json')) {
    body = (await response.json().catch(() => null)) as DocxApiResponse | null;
  }
  if (!response.ok) {
    const fallback =
      response.status === 413
        ? '文件超过大小上限。'
        : `导入失败（HTTP ${response.status}）。`;
    throw new DocxImportError(body?.error || fallback, body?.code || 'http-error', response.status, body?.detail);
  }
  if (!body || typeof body.markdown !== 'string') {
    throw new DocxImportError('服务端返回了无法识别的转换结果。', 'bad-response', response.status);
  }
  return {
    markdown: body.markdown,
    title: body.title ?? null,
    stats: body.stats as DocxImportStats,
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
    images: Array.isArray(body.images) ? body.images : [],
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

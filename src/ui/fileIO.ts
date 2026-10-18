/**
 * 本地文件读写：优先 File System Access API（Chrome / Edge），
 * 不支持或被拒绝时退化为 <input type=file> 打开 / 下载保存。
 */
export interface FsWritable {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface FsFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritable>;
}

interface FsPickerWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<FsFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FsFileHandle>;
}

const pickerWindow = window as unknown as FsPickerWindow;

const FILE_TYPES = [
  {
    description: 'Markdown 文档',
    accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.txt'] },
  },
];

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function titleFromFileName(name: string): string {
  return name.replace(/\.(md|markdown|mdown|txt)$/i, '') || '未命名文档';
}

export interface OpenFileResult {
  title: string;
  text: string;
  handle: FsFileHandle | null;
}

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.mdown,.txt,text/markdown,text/plain';
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

/** 打开本地 Markdown；用户取消返回 null */
export async function openMarkdownFile(): Promise<OpenFileResult | null> {
  if (pickerWindow.showOpenFilePicker) {
    try {
      const handles = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      const handle = handles?.[0];
      if (!handle) return null;
      const file = await handle.getFile();
      return {
        title: titleFromFileName(handle.name || file.name),
        text: normalizeNewlines(await file.text()),
        handle,
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      // 权限被拒 / 浏览器不支持：继续走 input 兜底
    }
  }
  const file = await pickWithInput();
  if (!file) return null;
  return {
    title: titleFromFileName(file.name),
    text: normalizeNewlines(await file.text()),
    handle: null,
  };
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface SaveFileResult {
  handle: FsFileHandle | null;
  fileName: string;
  downloaded: boolean;
}

/**
 * 保存 Markdown。
 * - existing 非空且未要求另存：原地写入；
 * - 否则走 showSaveFilePicker（如果支持），最后兜底为下载。
 */
export async function saveMarkdownFile(
  existing: FsFileHandle | null,
  fileName: string,
  text: string,
  options: { saveAs?: boolean } = {},
): Promise<SaveFileResult | null> {
  if (existing && !options.saveAs) {
    try {
      const writable = await existing.createWritable();
      await writable.write(text);
      await writable.close();
      return { handle: existing, fileName: existing.name || fileName, downloaded: false };
    } catch (error) {
      if (isAbortError(error)) return null;
      // 句柄失效（文件被移动 / 权限被收回）：继续走另存流程
    }
  }

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: FILE_TYPES,
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { handle, fileName: handle.name || fileName, downloaded: false };
    } catch (error) {
      if (isAbortError(error)) return null;
    }
  }

  downloadText(fileName, text);
  return { handle: null, fileName, downloaded: true };
}

export function isFileSystemAccessSupported(): boolean {
  return typeof pickerWindow.showOpenFilePicker === 'function';
}

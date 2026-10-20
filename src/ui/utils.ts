/**
 * 纯函数小工具：截断预览、文档统计、文件名、时间格式。
 */
import { SAMPLE_DOC, SAMPLE_TITLE } from './sample';

const CJK_WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(CJK_WORD);
  return matches ? matches.length : 0;
}

export function docStats(text: string): { chars: number; words: number; lines: number } {
  return {
    chars: text.length,
    words: countWords(text),
    lines: text ? text.split('\n').length : 0,
  };
}

/** 中间截断：保留首尾，适合展示长选区 */
export function clipMiddle(text: string, max = 160): string {
  if (text.length <= max) return text;
  const half = Math.max(1, Math.floor(max / 2));
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

/** 尾部截断：保留开头，适合 before 上下文（要紧挨选区） */
export function clipTail(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `… ${text.slice(-max)}`;
}

/** 头部截断：保留开头，适合 after 上下文 */
export function clipHead(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} …`;
}

export function fileNameFor(title: string): string {
  const base = (title || '未命名文档').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 80);
  return `${base || '未命名文档'}.md`;
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 单行化并截断（标题、指令回显用） */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface StoredDoc {
  title: string;
  text: string;
  updatedAt: number;
}

const DOC_KEY = 'docmax:doc:v1';
const THEME_KEY = 'docmax:theme:v1';
const PREFS_KEY = 'docmax:prefs:v1';

export function loadStoredDoc(): StoredDoc | null {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDoc>;
    if (typeof parsed.text !== 'string') return null;
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : SAMPLE_TITLE,
      text: parsed.text,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function storeDoc(doc: StoredDoc): void {
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(doc));
  } catch {
    // 存储满/隐私模式：忽略，自动保存只是便利功能
  }
}

export function initialDocument(): { title: string; text: string; restored: boolean } {
  const stored = loadStoredDoc();
  if (stored && stored.text.trim()) {
    return { title: stored.title, text: stored.text, restored: true };
  }
  return { title: SAMPLE_TITLE, text: SAMPLE_DOC, restored: false };
}

export function loadTheme(): 'light' | 'dark' | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

export interface StoredPrefs {
  model?: 'deepseek-flash' | 'deepseek-v4-pro';
  thinking?: 'off' | 'low' | 'high' | 'max';
  presetId?: string;
}

export function loadPrefs(): StoredPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredPrefs;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function storePrefs(prefs: StoredPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

/* ---------------- 文档库（当前打开文档 id） ---------------- */

const ACTIVE_DOC_KEY = 'docmax:active-doc:v1';

export function loadActiveDocId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_DOC_KEY);
  } catch {
    return null;
  }
}

export function storeActiveDocId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_DOC_KEY, id);
    else localStorage.removeItem(ACTIVE_DOC_KEY);
  } catch {
    // ignore
  }
}

/** 是否是用户可编辑的焦点目标（用于全局 Ctrl+Z 让位给输入框原生撤销） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

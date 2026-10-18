/**
 * 服务端配置：读取 .env / 环境变量。API Key 只在服务端使用，绝不下发到浏览器。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelId, ThinkingLevel } from '../src/core/types';
import { APP_VERSION, DEFAULT_LIMITS } from '../src/core/protocol';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析（不引入 dotenv 依赖） */
function loadDotEnv(): void {
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

function pickModel(value: string | undefined): ModelId {
  return value === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash';
}

export const config = {
  version: APP_VERSION,
  port: Number(process.env.PORT || 5199),
  host: process.env.HOST || '127.0.0.1',
  isProduction: process.argv.includes('--prod') || process.env.NODE_ENV === 'production',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  defaultModel: pickModel(process.env.DOCMAX_MODEL),
  defaultThinking: (process.env.DOCMAX_THINKING as ThinkingLevel) || 'off',
  /** 单次请求总超时 */
  requestTimeoutMs: Number(process.env.DOCMAX_TIMEOUT_MS || 180_000),
  /** 上游首个字节超时 */
  connectTimeoutMs: Number(process.env.DOCMAX_CONNECT_TIMEOUT_MS || 30_000),
  maxRepairs: 1,
  limits: {
    ...DEFAULT_LIMITS,
    maxSelectionChars: Number(process.env.DOCMAX_MAX_SELECTION || DEFAULT_LIMITS.maxSelectionChars),
    maxDocumentChars: Number(process.env.DOCMAX_MAX_DOCUMENT || DEFAULT_LIMITS.maxDocumentChars),
  },
} as const;

export function hasApiKey(): boolean {
  return !!config.apiKey && !config.apiKey.startsWith('sk-xxxxxxxx');
}

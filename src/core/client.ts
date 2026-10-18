/**
 * 浏览器端 API 客户端：向本地服务端发起编辑请求，消费 SSE 流。
 * 服务端的流事件定义见 types.ts 的 ServerEvent。
 */
import type { EditProposal, EditRequest, EditOptions, ServerEvent, Usage, Timings } from './types';
import type { PublicConfig } from './protocol';

export interface StreamHandlers {
  onMeta?: (event: Extract<ServerEvent, { type: 'meta' }>) => void;
  onStatus?: (event: Extract<ServerEvent, { type: 'status' }>) => void;
  onReasoning?: (delta: string) => void;
  onAnalysis?: (analysis: Extract<ServerEvent, { type: 'analysis' }>['analysis']) => void;
  onDelta?: (delta: string) => void;
  onRaw?: (delta: string) => void;
  onAnswer?: (delta: string) => void;
  onProposal?: (proposal: EditProposal) => void;
  onError?: (error: { code: string; message: string; detail?: string; retryable: boolean }) => void;
  onDone?: (info: { usage: Usage; timings: Timings }) => void;
}

export interface StreamOutcome {
  ok: boolean;
  proposal?: EditProposal;
  answer?: string;
  error?: { code: string; message: string; detail?: string; retryable: boolean };
}

function isServerEvent(value: unknown): value is ServerEvent {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

/** 发起一次流式编辑请求；abort signal 可随时中断（服务端会中止上游请求） */
export async function streamEdit(
  request: EditRequest,
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal?.aborted) return { ok: false, error: { code: 'aborted', message: '已取消', retryable: true } };
    const error = { code: 'network-error', message: `无法连接本地服务：${message}`, retryable: true };
    handlers.onError?.(error);
    return { ok: false, error };
  }

  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    let message = `请求失败（HTTP ${response.status}）`;
    let code = 'http-error';
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      if (body.code) code = body.code;
    } catch {
      try {
        const text = await response.text();
        if (text) message = text.slice(0, 300);
      } catch {
        // ignore
      }
    }
    const error = { code, message, retryable: response.status >= 500 || response.status === 429 };
    handlers.onError?.(error);
    return { ok: false, error };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const error = { code: 'no-body', message: '服务端未返回数据流', retryable: true };
    handlers.onError?.(error);
    return { ok: false, error };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let proposal: EditProposal | undefined;
  let answer = '';
  let error: StreamOutcome['error'];
  let doneMeta: { usage: Usage; timings: Timings } | undefined;

  const handleEvent = (event: ServerEvent) => {
    switch (event.type) {
      case 'meta':
        handlers.onMeta?.(event);
        break;
      case 'status':
        handlers.onStatus?.(event);
        break;
      case 'reasoning':
        handlers.onReasoning?.(event.delta);
        break;
      case 'analysis':
        handlers.onAnalysis?.(event.analysis);
        break;
      case 'delta':
        handlers.onDelta?.(event.text);
        break;
      case 'raw':
        handlers.onRaw?.(event.delta);
        break;
      case 'answer':
        answer += event.delta;
        handlers.onAnswer?.(event.delta);
        break;
      case 'proposal':
        proposal = event.proposal;
        handlers.onProposal?.(event.proposal);
        break;
      case 'error':
        error = { code: event.code, message: event.message, detail: event.detail, retryable: event.retryable };
        handlers.onError?.(error);
        break;
      case 'done':
        doneMeta = { usage: event.usage, timings: event.timings };
        handlers.onDone?.(doneMeta);
        break;
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const parsed: unknown = JSON.parse(data);
            if (isServerEvent(parsed)) handleEvent(parsed);
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, proposal, answer, error: { code: 'aborted', message: '已取消', retryable: true } };
    }
    const message = err instanceof Error ? err.message : String(err);
    error = { code: 'stream-error', message: `数据流中断：${message}`, retryable: true };
    handlers.onError?.(error);
    return { ok: false, proposal, answer, error };
  }

  if (error) return { ok: false, proposal, answer, error };
  if (!proposal && !answer && !doneMeta) {
    const fallback = { code: 'empty-stream', message: '服务端没有返回结果，请重试', retryable: true };
    handlers.onError?.(fallback);
    return { ok: false, error: fallback };
  }
  return { ok: true, proposal, answer };
}

export async function fetchHealth(): Promise<{ ok: boolean; version: string; hasApiKey: boolean; model: string }> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean; version: string; hasApiKey: boolean; model: string };
}

export async function fetchConfig(): Promise<PublicConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PublicConfig;
}

/** 默认选项（UI 与测试共用） */
export function defaultEditOptions(partial: Partial<EditOptions> = {}): EditOptions {
  return {
    model: 'deepseek-flash',
    thinking: 'off',
    mode: 'rewrite',
    analysis: true,
    contextChars: 800,
    maxRewriteChars: 4_000,
    maxDocumentChars: 20_000,
    sanitizeFormat: true,
    language: null,
    ...partial,
  };
}

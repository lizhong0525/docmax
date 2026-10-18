/**
 * DeepSeek Chat Completions 流式客户端（OpenAI 兼容格式）。
 *
 * 关键点：
 * - thinking 关闭时传 {"thinking":{"type":"disabled"}}，追求编辑器内的低延迟；
 *   需要更高质量时用 reasoning_effort = low/high/max。
 * - 流式返回 content 与 reasoning_content 两类增量，分别转发。
 * - 上游错误转换成可读的中文错误码，前端据此提示（余额不足 / Key 错误 / 限流等）。
 */
import { config } from './config';
import type { ModelId, ThinkingLevel, Usage } from '../src/core/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  model: ModelId;
  messages: ChatMessage[];
  thinking: ThinkingLevel;
  maxTokens: number;
  signal: AbortSignal;
}

export interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  usage?: Usage;
  finishReason?: string | null;
}

export class DeepSeekError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  detail?: string;

  constructor(code: string, message: string, status = 0, retryable = false, detail?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function mapHttpError(status: number, bodyText: string): DeepSeekError {
  let detail = bodyText.slice(0, 800);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; type?: string; code?: string } | string };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // preserve raw text
  }
  switch (status) {
    case 401:
      return new DeepSeekError('invalid-api-key', 'DeepSeek API Key 无效或未配置，请检查 .env 中的 DEEPSEEK_API_KEY。', status, false, detail);
    case 402:
      return new DeepSeekError('insufficient-balance', 'DeepSeek 账户余额不足，请充值后重试。', status, false, detail);
    case 422:
    case 400:
      return new DeepSeekError('bad-request', '请求参数被 DeepSeek 拒绝，请稍后重试。', status, false, detail);
    case 429:
      return new DeepSeekError('rate-limited', 'DeepSeek 接口限流，请稍后重试。', status, true, detail);
    default:
      return new DeepSeekError('upstream-error', `DeepSeek 服务异常（HTTP ${status}），请稍后重试。`, status, status >= 500, detail);
  }
}

/** 逐块产出模型输出；调用方负责解析与校验 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatStreamChunk, void, unknown> {
  if (!config.apiKey) {
    throw new DeepSeekError('missing-api-key', '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中填写。', 0, false);
  }
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    max_tokens: opts.maxTokens,
    stream_options: { include_usage: true },
  };
  if (opts.thinking === 'off') {
    body.thinking = { type: 'disabled' };
  } else {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = opts.thinking;
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DeepSeekError('network-error', `无法连接 DeepSeek 接口：${message}`, 0, true);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw mapHttpError(response.status, text);
  }
  if (!response.body) throw new DeepSeekError('no-body', 'DeepSeek 返回了空响应', response.status, true);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: Usage | undefined;
  for (;;) {
    let read: { done: boolean; value?: Uint8Array };
    try {
      read = await reader.read();
    } catch (err) {
      if (opts.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      throw new DeepSeekError('stream-error', `DeepSeek 数据流中断：${message}`, 0, true);
    }
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        let parsed: {
          choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          } | null;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        const contentDelta = choice?.delta?.content ?? undefined;
        const reasoningDelta = choice?.delta?.reasoning_content ?? undefined;
        if (parsed.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
            promptCacheHitTokens: parsed.usage.prompt_cache_hit_tokens,
            promptCacheMissTokens: parsed.usage.prompt_cache_miss_tokens,
            reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
          };
        }
        if (contentDelta || reasoningDelta || choice?.finish_reason) {
          yield { contentDelta: contentDelta ?? undefined, reasoningDelta: reasoningDelta ?? undefined, usage, finishReason: choice?.finish_reason ?? null };
        }
      }
    }
  }
}

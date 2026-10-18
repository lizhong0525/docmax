/**
 * 单元测试：浏览器端 SSE 客户端 client.ts（用真实 streamEdit，仅替换网络边界 fetch）
 * 覆盖：事件分发、跨 chunk 的 SSE 分帧、proposal/answer 结果、错误路径、请求体。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultEditOptions, fetchConfig, fetchHealth, streamEdit, type StreamHandlers } from '../src/core/client';
import { encodePing, encodeSse } from '../src/core/protocol';
import type { EditProposal, EditRequest, ServerEvent } from '../src/core/types';

function sseBody(events: ServerEvent[], opts: { chunkSize?: number; ping?: boolean } = {}): ReadableStream<Uint8Array> {
  const text = (opts.ping ? encodePing() : '') + events.map(encodeSse).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const size = opts.chunkSize ?? bytes.length;
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

function sseResponse(events: ServerEvent[], opts: { chunkSize?: number; ping?: boolean } = {}): Response {
  return new Response(sseBody(events, opts), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function makeRequest(partial: Partial<EditRequest> = {}): EditRequest {
  return {
    requestId: 'req-test',
    docRev: 3,
    docText: '# 标题\n\n第一段原文。\n',
    docTitle: 'test.md',
    ranges: [
      { index: 0, from: 7, to: 12, anchor: 7, head: 12, text: '第一段原文', hash: 'abc', before: '# 标题\n\n', after: '。\n' },
    ],
    instruction: '润色',
    options: defaultEditOptions(),
    ...partial,
  };
}

const proposal: EditProposal = {
  requestId: 'req-test',
  docRev: 3,
  mode: 'rewrite',
  model: 'deepseek-flash',
  analysis: { kind: 'paragraph' },
  localAnalyses: [],
  ops: [
    {
      rangeId: 0,
      from: 7,
      to: 12,
      oldText: '第一段原文',
      newText: '第一段改后',
      strategy: 'rewrite',
      stats: { oldChars: 5, newChars: 5, removedChars: 0, addedChars: 0 },
    },
  ],
  warnings: [],
  truncated: false,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  timings: { startedAt: 1, attempts: 1, repairs: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('defaultEditOptions', () => {
  it('默认值符合产品约定', () => {
    expect(defaultEditOptions()).toMatchObject({
      model: 'deepseek-flash',
      thinking: 'off',
      mode: 'rewrite',
      analysis: true,
      contextChars: 800,
      maxRewriteChars: 4000,
      maxDocumentChars: 20000,
      sanitizeFormat: true,
      language: null,
    });
  });

  it('支持局部覆盖', () => {
    const opts = defaultEditOptions({ mode: 'surgical', model: 'deepseek-v4-pro', thinking: 'low' });
    expect(opts.mode).toBe('surgical');
    expect(opts.model).toBe('deepseek-v4-pro');
    expect(opts.thinking).toBe('low');
    expect(opts.contextChars).toBe(800);
  });
});

describe('streamEdit：正常流', () => {
  it('分发全部事件并返回 proposal（SSE 跨 chunk 分帧也能正确解析）', async () => {
    const events: ServerEvent[] = [
      { type: 'meta', requestId: 'req-test', docRev: 3, model: 'deepseek-flash', mode: 'rewrite', localAnalyses: [], startedAt: 1 },
      { type: 'status', phase: 'connecting' },
      { type: 'analysis', analysis: { kind: 'paragraph' } },
      { type: 'delta', rangeId: 0, text: '第一段' },
      { type: 'delta', rangeId: 0, text: '改后' },
      { type: 'proposal', proposal },
      { type: 'status', phase: 'done' },
      { type: 'done', requestId: 'req-test', usage: proposal.usage, timings: proposal.timings },
    ];
    const fetchMock = vi.fn(async () => sseResponse(events, { chunkSize: 7, ping: true }));
    vi.stubGlobal('fetch', fetchMock);

    const seen = {
      meta: 0,
      statuses: [] as string[],
      deltas: [] as string[],
      analysis: 0,
      proposal: null as EditProposal | null,
      done: 0,
    };
    const handlers: StreamHandlers = {
      onMeta: () => seen.meta++,
      onStatus: (e) => seen.statuses.push(e.phase),
      onAnalysis: () => seen.analysis++,
      onDelta: (t) => seen.deltas.push(t),
      onProposal: (p) => (seen.proposal = p),
      onDone: () => seen.done++,
    };

    const outcome = await streamEdit(makeRequest(), handlers);

    expect(outcome.ok).toBe(true);
    expect(outcome.proposal).toEqual(proposal);
    expect(seen.meta).toBe(1);
    expect(seen.statuses).toEqual(['connecting', 'done']);
    expect(seen.deltas.join('')).toBe('第一段改后');
    expect(seen.analysis).toBe(1);
    expect(seen.proposal).toEqual(proposal);
    expect(seen.done).toBe(1);
    // 请求确实发到 /api/edit，且 body 是原始请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/edit');
    expect(JSON.parse(init.body as string)).toEqual(makeRequest());
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('ask 模式累积 answer 增量', async () => {
    const events: ServerEvent[] = [
      { type: 'answer', delta: '这是' },
      { type: 'answer', delta: '一段解释。' },
      { type: 'done', requestId: 'r', usage: proposal.usage, timings: proposal.timings },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events, { chunkSize: 5 })));
    const outcome = await streamEdit(makeRequest({ options: defaultEditOptions({ mode: 'ask' }) }));
    expect(outcome.ok).toBe(true);
    expect(outcome.answer).toBe('这是一段解释。');
    expect(outcome.proposal).toBeUndefined();
  });
});

describe('streamEdit：错误路径', () => {
  it('上游 error 事件 → ok=false 且携带错误码', async () => {
    const events: ServerEvent[] = [
      { type: 'status', phase: 'connecting' },
      { type: 'error', code: 'rate-limited', message: '接口限流', retryable: true },
      { type: 'done', requestId: 'r', usage: proposal.usage, timings: proposal.timings },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
    const onError = vi.fn();
    const outcome = await streamEdit(makeRequest(), { onError });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ code: 'rate-limited', message: '接口限流', retryable: true });
    expect(onError).toHaveBeenCalled();
  });

  it('HTTP 500 JSON → ok=false，使用服务端错误信息，retryable=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'internal-error', error: '服务端错误：boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const outcome = await streamEdit(makeRequest());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ code: 'internal-error', message: '服务端错误：boom', retryable: true });
  });

  it('HTTP 400 非 SSE → retryable=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'stale-selection', error: '选区快照与文档不一致' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const outcome = await streamEdit(makeRequest());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ code: 'stale-selection', retryable: false });
  });

  it('网络层异常 → network-error 且回调 onError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const onError = vi.fn();
    const outcome = await streamEdit(makeRequest(), { onError });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('network-error');
    expect(outcome.error?.message).toContain('ECONNREFUSED');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('数据流中断 → stream-error，保留已收到的事件', async () => {
    let delivered = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(encodeSse({ type: 'delta', rangeId: 0, text: '部分' })));
          return;
        }
        controller.error(new Error('socket hang up'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const deltas: string[] = [];
    const outcome = await streamEdit(makeRequest(), { onDelta: (t) => deltas.push(t) });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('stream-error');
    expect(deltas).toEqual(['部分']);
  });

  it('空流（没有任何事件）→ empty-stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([])));
    const outcome = await streamEdit(makeRequest());
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('empty-stream');
  });

  it('服务端返回 HTML 而不是 JSON 时也能给出可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })),
    );
    const outcome = await streamEdit(makeRequest());
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('http-error');
    expect(outcome.error?.message).toContain('Bad Gateway');
  });
});

describe('fetchHealth / fetchConfig', () => {
  it('解析健康检查响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, version: '0.1.0', hasApiKey: true, model: 'deepseek-flash' }), { status: 200 })),
    );
    await expect(fetchHealth()).resolves.toMatchObject({ ok: true, hasApiKey: true, model: 'deepseek-flash' });
  });

  it('健康检查失败时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    await expect(fetchHealth()).rejects.toThrow('HTTP 500');
  });

  it('解析公开配置响应', async () => {
    const config = {
      hasApiKey: true,
      defaultModel: 'deepseek-flash',
      defaultThinking: 'off',
      models: [],
      limits: {
        maxSelectionChars: 200000,
        maxDocumentChars: 400000,
        maxInstructionChars: 4000,
        maxContextChars: 4000,
        defaultContextChars: 800,
        defaultMaxRewriteChars: 4000,
      },
      version: '0.1.0',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(config), { status: 200 })));
    await expect(fetchConfig()).resolves.toEqual(config);
  });
});

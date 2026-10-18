/**
 * API 层契约自检：请求校验、错误码、模式归一化、SSE 事件齐全性。
 * 用法：服务已启动后 `node node_modules/tsx/dist/cli.mjs scripts/api-check.ts`
 */
import { buildRangeSnapshot } from '../src/core/selection';
import { defaultEditOptions } from '../src/core/client';
import type { ServerEvent } from '../src/core/types';

const BASE = process.env.DOCMAX_URL || 'http://127.0.0.1:5199';
let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}`, detail ?? '');
  }
}

async function post(body: unknown): Promise<{ status: number; json?: any; text?: string; contentType: string | null }> {
  const res = await fetch(`${BASE}/api/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type');
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, contentType };
}

function makeRequest(overrides: Record<string, unknown> = {}, rangeOverride: Record<string, unknown> = {}) {
  const doc = '# 标题\n\n这是一段测试文字，用于验证 API 校验。\n';
  const from = doc.indexOf('这是一段');
  const to = from + '这是一段测试文字'.length;
  const range = { ...buildRangeSnapshot(doc, { from, to }, 0, 800), ...rangeOverride };
  return {
    requestId: crypto.randomUUID(),
    docRev: 1,
    docText: doc,
    docTitle: 'api-check.md',
    instruction: '把这句话改得更简洁。',
    ranges: [range],
    options: defaultEditOptions(),
    ...overrides,
  };
}

async function readSse(res: Response): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          events.push(JSON.parse(line.slice(5).trim()) as ServerEvent);
        } catch {
          // ignore
        }
      }
    }
  }
  return events;
}

async function main(): Promise<void> {
  console.log('\n[1] 基础端点');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json() as Promise<any>);
  check('GET /api/health', health.ok === true && typeof health.hasApiKey === 'boolean', health);
  const config = await fetch(`${BASE}/api/config`).then((r) => r.json() as Promise<any>);
  check('GET /api/config 含模型与限额', Array.isArray(config.models) && config.models.length >= 1 && !!config.limits, config);
  const notFound = await fetch(`${BASE}/api/nope`).then((r) => r.status);
  check('未知 API 返回 404', notFound === 404, notFound);

  console.log('\n[2] 非法请求校验');
  const badJson = await post('{not json');
  check('非法 JSON → 400', badJson.status === 400, badJson);
  const missingInstruction = await post(makeRequest({ instruction: '  ' }));
  check('空指令 → 400 empty-instruction', missingInstruction.status === 400 && missingInstruction.json?.code === 'empty-instruction', missingInstruction.json);
  const staleHash = await post(makeRequest({}, { hash: 'deadbeef' }));
  check('指纹不匹配 → 400 hash-mismatch', staleHash.status === 400 && staleHash.json?.code === 'hash-mismatch', staleHash.json);
  const staleText = await post(makeRequest({}, { text: '被篡改的选区文字' }));
  check('选区快照与文档不符 → 409 stale-selection', staleText.status === 409 && staleText.json?.code === 'stale-selection', staleText.json);
  const twoRanges = await post(makeRequest({ ranges: [makeRequest().ranges[0], makeRequest().ranges[0]] }));
  check('多选区直接请求 → 400', twoRanges.status === 400, twoRanges.json);
  const docTooLargeRequest = makeRequest({ docText: 'x'.repeat(500_000) });
  const docTooLarge = await post(docTooLargeRequest);
  check('超大文档 → 413', docTooLarge.status === 413, docTooLarge.json);

  console.log('\n[3] 模式归一化（空选区 rewrite → insert）');
  const doc = '# 标题\n\n正文开始。\n';
  const at = doc.indexOf('正文');
  const emptyRange = buildRangeSnapshot(doc, { from: at, to: at }, 0, 800);
  const insertReq = {
    requestId: crypto.randomUUID(),
    docRev: 1,
    docText: doc,
    docTitle: 'insert.md',
    instruction: '在光标处插入一句简短的过渡句。',
    ranges: [emptyRange],
    options: defaultEditOptions({ mode: 'rewrite' }),
  };
  const insertRes = await fetch(`${BASE}/api/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(insertReq) });
  const insertEvents = await readSse(insertRes);
  const meta = insertEvents.find((e) => e.type === 'meta');
  check('空选区 rewrite 被归一化为 insert', !!meta && meta.type === 'meta' && meta.mode === 'insert', meta);
  const proposal = insertEvents.find((e) => e.type === 'proposal');
  check('收到 proposal 且可插入', !!proposal && proposal.type === 'proposal' && proposal.proposal.ops.length === 1, proposal);
  const phases = insertEvents.filter((e) => e.type === 'status').map((e) => (e.type === 'status' ? e.phase : ''));
  check('SSE 阶段完整（connecting→streaming→validating→done）', ['connecting', 'streaming', 'validating', 'done'].every((p) => phases.includes(p as never)), phases);

  console.log('\n[4] 客户端中止');
  const ac = new AbortController();
  const pending = fetch(`${BASE}/api/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeRequest()),
    signal: ac.signal,
  });
  ac.abort();
  try {
    await pending;
    check('中止后客户端收到 AbortError', false);
  } catch (err) {
    check('中止后客户端收到 AbortError', err instanceof Error && err.name === 'AbortError', String(err));
  }

  console.log(failures === 0 ? '\n✅ API 自检全部通过' : `\n❌ ${failures} 项失败`);
  process.exitCode = failures ? 1 : 0;
}

await main();

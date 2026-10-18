/**
 * 模式冒烟测试：surgical（局部精准修改）、insert（空选区插入）、ask（解释）。
 * 用法：先启动 dev server，再 `node node_modules/tsx/dist/cli.mjs scripts/smoke-modes.ts`
 */
import { applyProposal } from '../src/core/apply';
import { buildRangeSnapshot } from '../src/core/selection';
import { defaultEditOptions } from '../src/core/client';
import type { EditProposal, ServerEvent } from '../src/core/types';

const BASE = process.env.DOCMAX_URL || 'http://127.0.0.1:5199';

const LONG_DOC = `# 风险评估记录

## 记录

${Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 条：本次迭代的风险评估结论为低风险，但仍需持续关注风险评估的覆盖范围。`).join('\n')}

## 结论

整体可控。
`;

interface CaseResult {
  name: string;
  proposal: EditProposal | null;
  answer: string;
  error: string | null;
  elapsed: number;
  phases: string[];
}

async function runCase(
  name: string,
  doc: string,
  from: number,
  to: number,
  instruction: string,
  opts: { mode: 'surgical' | 'insert' | 'ask'; model?: 'deepseek-flash' | 'deepseek-v4-pro' },
): Promise<CaseResult> {
  const snapshot = buildRangeSnapshot(doc, { from, to }, 0, 800);
  const request = {
    requestId: crypto.randomUUID(),
    docRev: 1,
    docText: doc,
    docTitle: 'test.md',
    instruction,
    ranges: [snapshot],
    options: defaultEditOptions({
      mode: opts.mode,
      model: opts.model ?? 'deepseek-flash',
      thinking: 'off',
      maxRewriteChars: 4000,
    }),
  };
  const started = Date.now();
  const res = await fetch(`${BASE}/api/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const phases: string[] = [];
  let proposal: EditProposal | null = null;
  let answer = '';
  let error: string | null = null;
  if (!res.ok || !res.body) {
    return { name, proposal, answer, error: `HTTP ${res.status}: ${await res.text()}`, elapsed: Date.now() - started, phases };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as ServerEvent;
        if (event.type === 'status') phases.push(event.phase);
        if (event.type === 'analysis') phases.push(`analysis:${JSON.stringify(event.analysis.kind)}`);
        if (event.type === 'proposal') proposal = event.proposal;
        if (event.type === 'answer') answer += event.delta;
        if (event.type === 'error') error = `${event.code}: ${event.message}`;
      }
    }
  }
  return { name, proposal, answer, error, elapsed: Date.now() - started, phases };
}

function verifyOutsideUntouched(doc: string, from: number, to: number, appliedDoc: string, newText: string): boolean {
  const prefix = doc.slice(0, from);
  const suffix = doc.slice(to);
  return appliedDoc === prefix + newText + suffix;
}

async function main(): Promise<void> {
  const longFrom = LONG_DOC.indexOf('第 1 条');
  const longTo = LONG_DOC.indexOf('\n\n## 结论');
  const longSelection = LONG_DOC.slice(longFrom, longTo);

  // A. surgical：长选区，机械替换关键词
  const a = await runCase('surgical-长选区替换关键词', LONG_DOC, longFrom, longTo, '只把选区内每一处的“风险评估”替换成“风险研判”，其他文字一律不要改。', {
    mode: 'surgical',
  });
  console.log('\n=== A surgical ===', a.elapsed + 'ms', a.phases.join(' → '));
  if (a.error) console.log('ERROR', a.error);
  if (a.proposal) {
    const op = a.proposal.ops[0];
    console.log('strategy=', op.strategy, 'edits=', op.edits?.length, 'warnings=', a.proposal.warnings.map((w) => w.code + ':' + w.severity));
    console.log('newText 前 80 字:', JSON.stringify(op.newText.slice(0, 80)));
    const applied = applyProposal(LONG_DOC, a.proposal);
    console.log('可应用=', applied.ok, applied.error ?? '');
    if (applied.ok) {
      console.log('选区外未变=', verifyOutsideUntouched(LONG_DOC, longFrom, longTo, applied.docText, op.newText));
      console.log('原文“风险评估”出现次数=', (longSelection.match(/风险评估/g) || []).length, '→ 新文本=', (op.newText.match(/风险研判/g) || []).length, '旧词残留=', (op.newText.match(/风险评估/g) || []).length);
    }
  }

  // B. insert：空选区插入
  const insertAt = LONG_DOC.indexOf('## 结论');
  const b = await runCase('insert-空选区插入', LONG_DOC, insertAt, insertAt, '在这里插入一句结论说明：本次评估没有发现高风险项。保持 Markdown 格式。', { mode: 'insert' });
  console.log('\n=== B insert ===', b.elapsed + 'ms', b.phases.join(' → '));
  if (b.error) console.log('ERROR', b.error);
  if (b.proposal) {
    const op = b.proposal.ops[0];
    console.log('strategy=', op.strategy, 'newText=', JSON.stringify(op.newText));
    const applied = applyProposal(LONG_DOC, b.proposal);
    console.log('可应用=', applied.ok);
  }

  // C. ask：解释选区
  const askFrom = LONG_DOC.indexOf('第 1 条');
  const askTo = LONG_DOC.indexOf('\n', askFrom);
  const c = await runCase('ask-解释选区', LONG_DOC, askFrom, askTo, '用一句话说明这条记录在文档中的作用。', { mode: 'ask' });
  console.log('\n=== C ask ===', c.elapsed + 'ms', c.phases.join(' → '));
  if (c.error) console.log('ERROR', c.error);
  console.log('answer=', JSON.stringify(c.answer.slice(0, 200)));

  // D. surgical 无需修改
  const dFrom = LONG_DOC.indexOf('整体可控。');
  const dTo = dFrom + '整体可控。'.length;
  const d = await runCase('surgical-无需修改', LONG_DOC, dFrom, dTo, '只检查错别字；如果没有错别字，不要做任何改动。', { mode: 'surgical' });
  console.log('\n=== D no-op ===', d.elapsed + 'ms', d.phases.join(' → '));
  if (d.error) console.log('ERROR', d.error);
  if (d.proposal) {
    console.log('strategy=', d.proposal.ops[0].strategy, 'newText===old=', d.proposal.ops[0].newText === '整体可控。', 'warnings=', d.proposal.warnings.map((w) => w.code));
  }
}

await main();

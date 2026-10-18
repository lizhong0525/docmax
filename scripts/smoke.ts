/**
 * 本地端到端冒烟测试：直接调用运行中的 DocMax 服务 /api/edit，
 * 校验提案结构，并用核心 applyProposal 在本地文档上应用，验证选区外文字未被改动。
 *
 * 用法：启动 `pnpm dev` 后运行 `pnpm tsx scripts/smoke.ts`
 */
import { applyProposal } from '../src/core/apply';
import { buildRangeSnapshot, analyzeSelection } from '../src/core/selection';
import { defaultEditOptions } from '../src/core/client';
import type { EditProposal, ServerEvent } from '../src/core/types';

const BASE = process.env.DOCMAX_URL || 'http://127.0.0.1:5199';

const DOC = `# 项目周报

## 本周进展

我们完成了编辑器的**选区识别**模块，并开始接入模型能力。整体进度符合预期，但还有一些细节需要打磨。

## 下周计划

- 完成流式输出的 UI
- 补充自动化测试
- 和设计同学对齐视觉稿

## 风险

目前主要风险是模型返回格式不稳定，需要加入校验和重试机制。
`;

const SELECTION = '我们完成了编辑器的**选区识别**模块，并开始接入模型能力。整体进度符合预期，但还有一些细节需要打磨。';
const INSTRUCTION = '润色这段话，保持原意，更简洁专业。';

function buildRequest() {
  const from = DOC.indexOf(SELECTION);
  const to = from + SELECTION.length;
  const snapshot = buildRangeSnapshot(DOC, { from, to }, 0, 800);
  return {
    requestId: crypto.randomUUID(),
    docRev: 1,
    docText: DOC,
    docTitle: '项目周报.md',
    instruction: INSTRUCTION,
    ranges: [snapshot],
    options: defaultEditOptions({ mode: 'rewrite', model: 'deepseek-flash', thinking: 'off' }),
  };
}

async function main(): Promise<void> {
  const request = buildRequest();
  const local = analyzeSelection(DOC, request.ranges[0].from, request.ranges[0].to, 0);
  console.log('本地选区识别:', {
    chars: local.chars,
    words: local.words,
    blockKind: local.blockKind,
    startsMidLine: local.startsMidLine,
    endsMidLine: local.endsMidLine,
  });

  const started = Date.now();
  const res = await fetch(`${BASE}/api/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  console.log('HTTP', res.status, res.headers.get('content-type'));
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }

  let buffer = '';
  let proposal: EditProposal | null = null;
  let answer = '';
  let error: string | null = null;
  const statuses: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
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
        switch (event.type) {
          case 'status':
            statuses.push(event.phase);
            break;
          case 'analysis':
            console.log('模型识别:', event.analysis);
            break;
          case 'answer':
            answer += event.delta;
            break;
          case 'proposal':
            proposal = event.proposal;
            break;
          case 'error':
            error = `${event.code}: ${event.message}`;
            break;
          default:
            break;
        }
      }
    }
  }

  console.log('阶段:', statuses.join(' → '));
  console.log('耗时:', Date.now() - started, 'ms');
  if (error) {
    console.error('错误:', error);
    process.exit(1);
  }
  if (answer) console.log('回答:', answer);
  if (!proposal) {
    console.error('没有收到提案');
    process.exit(1);
  }
  console.log('提案策略:', proposal.ops[0]?.strategy);
  console.log('警告:', proposal.warnings.map((w) => `[${w.severity}] ${w.message}`));
  console.log('用量:', proposal.usage);
  console.log('\n--- 修改前 ---\n' + SELECTION);
  console.log('\n--- 修改后 ---\n' + proposal.ops[0].newText);

  const applied = applyProposal(DOC, proposal);
  if (!applied.ok) {
    console.error('应用失败:', applied.error);
    process.exit(1);
  }
  const before = request.ranges[0].before;
  const after = request.ranges[0].after;
  const newFrom = request.ranges[0].from;
  const expectedPrefix = DOC.slice(0, newFrom);
  if (!applied.docText.startsWith(expectedPrefix)) {
    console.error('选区之前的内容被改动！');
    process.exit(1);
  }
  if (!applied.docText.includes(after) || !applied.docText.includes(before)) {
    console.error('选区之外的内容被改动！');
    process.exit(1);
  }
  console.log('\n✅ 选区外内容未被改动；应用后文档长度', applied.docText.length);
}

await main();

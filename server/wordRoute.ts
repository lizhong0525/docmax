/**
 * Word 插件专用接口：POST /api/word/edit
 *
 * 为什么需要它：Word VBA 无法方便地消费 SSE，也没有 CodeMirror 的 UTF-16 偏移模型；
 * 它只需要「把选中的文字按指令改写，返回替换文本」。这个接口在服务端复用完整的
 * 编辑流水线（提示词、流式解析、校验、自动修复），但把结果聚合成一次性 JSON 返回。
 *
 * 请求体：
 * {
 *   "instruction": "润色这段话",
 *   "mode": "rewrite" | "ask",
 *   "model": "deepseek-flash" | "deepseek-v4-pro",
 *   "thinking": "off" | "low" | "high" | "max",
 *   "docTitle": "xxx.docx",
 *   "selection": { "text": "...", "before": "...", "after": "..." }
 * }
 *
 * 响应（HTTP 200；业务错误用 ok=false）：
 * {
 *   "ok": true,
 *   "newText": "...",            // rewrite 模式：应替换选区的文本
 *   "answer": "...",             // ask 模式：回答
 *   "analysisSummary": "...",    // 模型识别摘要
 *   "warningCount": 0,
 *   "hasErrorWarning": false,
 *   "truncated": false,
 *   "warnings": [{ "code": "...", "severity": "info", "message": "..." }],
 *   "model": "deepseek-flash",
 *   "latencyMs": 1234,
 *   "usage": { ... }
 * }
 */
import type { Request, Response } from 'express';
import { config, hasApiKey } from './config';
import { executeEdit } from './editRoute';
import { fnv1a32 } from '../src/core/selection';
import { getPromptPreset } from '../src/core/presets';
import type {
  EditMode,
  EditRequest,
  ModelId,
  RangeSnapshot,
  ServerEvent,
  ThinkingLevel,
} from '../src/core/types';

const VALID_MODELS: ModelId[] = ['deepseek-flash', 'deepseek-v4-pro'];
const VALID_THINKING: ThinkingLevel[] = ['off', 'low', 'high', 'max'];

function fail(res: Response, code: string, message: string): void {
  res.json({ ok: false, code, error: message });
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Word 用 \r 表示段落、\a 表示单元格结束；统一成 Markdown 友好的换行 */
function normalizeWordText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u000b/g, '\n') // 手动换行
    .replace(/\u0007/g, ' ') // 单元格结束符
    .replace(/\u000c/g, '\n'); // 分页符
}

export async function handleWordEdit(req: Request, res: Response): Promise<void> {
  if (!hasApiKey()) {
    fail(res, 'missing-api-key', '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中配置并重启服务。');
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const selection = (body.selection ?? {}) as Record<string, unknown>;
  const instruction = asString(body.instruction).trim();
  const mode: EditMode = body.mode === 'ask' ? 'ask' : 'rewrite';
  const preset = getPromptPreset(body.presetId);
  const selectionText = normalizeWordText(asString(selection.text));

  if (!instruction && (preset.id === 'default' || mode === 'ask')) {
    fail(res, 'empty-instruction', '请先输入修改指令。');
    return;
  }
  if (!selectionText.trim()) {
    fail(res, 'empty-selection', '请先在 Word 中选中要处理的文字。');
    return;
  }
  if (selectionText.length > config.limits.maxSelectionChars) {
    fail(res, 'selection-too-large', `选中的文字超过上限（${config.limits.maxSelectionChars} 字符）。`);
    return;
  }

  const before = normalizeWordText(asString(selection.before)).slice(-800);
  const after = normalizeWordText(asString(selection.after)).slice(0, 800);
  // 用「前后文 + 选区」构造一个自洽的局部文档：服务端不知道 Word 的真实偏移，
  // 也不需要知道——它只负责产出替换文本，应用由 VBA 在 Word 里完成。
  const contextDoc = `${before}${selectionText}${after}`;
  const from = before.length;
  const to = from + selectionText.length;
  const range: RangeSnapshot = {
    index: 0,
    from,
    to,
    anchor: from,
    head: to,
    text: selectionText,
    hash: fnv1a32(selectionText),
    before,
    after,
  };

  const model = VALID_MODELS.includes(body.model as ModelId) ? (body.model as ModelId) : config.defaultModel;
  const thinking = VALID_THINKING.includes(body.thinking as ThinkingLevel)
    ? (body.thinking as ThinkingLevel)
    : 'off';
  const request: EditRequest = {
    requestId: `word-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    docRev: 0,
    docText: contextDoc,
    docTitle: asString(body.docTitle),
    ranges: [range],
    instruction: instruction || preset.defaultInstruction,
    options: {
      model,
      thinking,
      mode,
      presetId: preset.id,
      analysis: true,
      contextChars: 800,
      maxRewriteChars: 4000,
      maxDocumentChars: 20_000,
      sanitizeFormat: true,
      language: null,
    },
  };

  const startedAt = Date.now();
  const events: ServerEvent[] = [];
  try {
    await executeEdit(request, (event) => events.push(event), AbortSignal.timeout(config.requestTimeoutMs));
  } catch (err) {
    fail(res, 'internal-error', err instanceof Error ? err.message : String(err));
    return;
  }

  const proposal = events.find((event) => event.type === 'proposal');
  const answer = events
    .filter((event): event is Extract<ServerEvent, { type: 'answer' }> => event.type === 'answer')
    .map((event) => event.delta)
    .join('');
  const errorEvent = events.find((event): event is Extract<ServerEvent, { type: 'error' }> => event.type === 'error');
  const usageEvent = events.find((event): event is Extract<ServerEvent, { type: 'done' }> => event.type === 'done');

  if (errorEvent) {
    fail(res, errorEvent.code, errorEvent.message);
    return;
  }

  const latencyMs = Date.now() - startedAt;
  if (mode === 'ask') {
    if (!answer.trim()) {
      fail(res, 'empty-answer', '模型没有返回回答，请重试。');
      return;
    }
    res.json({
      ok: true,
      answer,
      newText: '',
      analysisSummary: '',
      warningCount: 0,
      hasErrorWarning: false,
      truncated: false,
      warnings: [],
      model,
      latencyMs,
      usage: usageEvent?.usage ?? null,
    });
    return;
  }

  if (!proposal) {
    fail(res, 'no-proposal', '模型没有返回可用的修改结果，请重试。');
    return;
  }
  const op = proposal.proposal.ops[0];
  if (!op) {
    fail(res, 'no-proposal', '模型没有返回可用的修改结果，请重试。');
    return;
  }
  const warnings = proposal.proposal.warnings;
  res.json({
    ok: true,
    newText: op.newText,
    answer: '',
    analysisSummary: proposal.proposal.analysis?.summary ?? '',
    warningCount: warnings.length,
    hasErrorWarning: warnings.some((warning) => warning.severity === 'error'),
    truncated: proposal.proposal.truncated,
    warnings: warnings.map((warning) => ({ code: warning.code, severity: warning.severity, message: warning.message })),
    model,
    latencyMs,
    usage: proposal.proposal.usage,
  });
}

/**
 * POST /api/edit —— 核心编辑接口（SSE）。
 *
 * 完整流水线：
 *   校验请求与选区快照
 *   → 本地选区识别（确定性）
 *   → 构建提示词（含哨兵标记）
 *   → 流式调用 DeepSeek（转发 reasoning / delta）
 *   → 流式解析结构
 *   → 服务端校验/锚点匹配 → 失败则带诊断信息修复重试一次
 *   → 输出已校验提案（proposal），由客户端展示差异并决定是否接受
 */
import type { Request, Response } from 'express';
import { config, hasApiKey } from './config';
import { DeepSeekError, streamChat, type ChatMessage } from './deepseek';
import { analyzeSelection, fnv1a32 } from '../src/core/selection';
import { createMarkers } from '../src/core/markers';
import { StreamParser, type ParseResult } from '../src/core/parse';
import { buildProposal, validateRequestSnapshot, type RepairHint } from '../src/core/apply';
import { buildRepairMessage, buildSystemPrompt, buildUserPrompt } from '../src/core/prompt';
import { getPromptPreset } from '../src/core/presets';
import { encodePing, encodeSse } from '../src/core/protocol';
import type { EditMode, EditRequest, ServerEvent, Timings, Usage } from '../src/core/types';

const VALID_MODES: EditMode[] = ['rewrite', 'surgical', 'insert', 'ask'];
const VALID_THINKING = ['off', 'low', 'high', 'max'];
const VALID_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

interface ValidationError {
  status: number;
  code: string;
  message: string;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** 请求校验：所有限制在服务端再检查一遍（前端限制只是体验优化） */
export function validateEditRequest(body: unknown): { request?: EditRequest; error?: ValidationError } {
  if (!body || typeof body !== 'object') return { error: { status: 400, code: 'bad-request', message: '请求体必须是 JSON 对象' } };
  const b = body as Partial<EditRequest>;
  if (typeof b.requestId !== 'string' || !b.requestId) return { error: { status: 400, code: 'bad-request', message: '缺少 requestId' } };
  if (typeof b.docText !== 'string') return { error: { status: 400, code: 'bad-request', message: '缺少 docText' } };

  const rawOptions = (b.options ?? {}) as EditRequest['options'];
  const preset = getPromptPreset(rawOptions.presetId);
  const requestedMode: EditMode = VALID_MODES.includes(rawOptions.mode) ? rawOptions.mode : 'rewrite';
  const instructionText = typeof b.instruction === 'string' ? b.instruction.trim() : '';
  if (!instructionText) {
    // 选了非默认提示词模式时可以不写指令（使用该模式的默认指令）；解释模式仍需要问题
    if (requestedMode === 'ask' || preset.id === 'default') {
      return { error: { status: 400, code: 'empty-instruction', message: '指令不能为空' } };
    }
  }
  if (!Array.isArray(b.ranges) || b.ranges.length !== 1) {
    return { error: { status: 400, code: 'bad-ranges', message: '每次请求必须包含且仅包含一个选区快照' } };
  }
  const range = b.ranges[0];
  if (
    !range ||
    typeof range.from !== 'number' ||
    typeof range.to !== 'number' ||
    typeof range.text !== 'string' ||
    typeof range.hash !== 'string' ||
    typeof range.before !== 'string' ||
    typeof range.after !== 'string'
  ) {
    return { error: { status: 400, code: 'bad-ranges', message: '选区快照字段不完整' } };
  }
  if (b.docText.length > config.limits.maxDocumentChars) {
    return {
      error: { status: 413, code: 'document-too-large', message: `文档超过上限（${config.limits.maxDocumentChars} 字符），请拆分后编辑。` },
    };
  }
  if (range.text.length > config.limits.maxSelectionChars) {
    return {
      error: { status: 413, code: 'selection-too-large', message: `选区超过上限（${config.limits.maxSelectionChars} 字符），请缩小选区。` },
    };
  }
  if (instructionText.length > config.limits.maxInstructionChars) {
    return { error: { status: 413, code: 'instruction-too-long', message: `指令超过上限（${config.limits.maxInstructionChars} 字符）。` } };
  }
  const snapshotError = validateRequestSnapshot(b.docText, range as EditRequest['ranges'][number]);
  if (snapshotError) return { error: { status: 409, code: 'stale-selection', message: snapshotError } };
  if (fnv1a32(range.text) !== range.hash) {
    return { error: { status: 400, code: 'hash-mismatch', message: '选区指纹不匹配，请重新生成请求。' } };
  }
  const mode = VALID_MODES.includes(rawOptions.mode) ? rawOptions.mode : 'rewrite';
  const thinking = VALID_THINKING.includes(rawOptions.thinking) ? rawOptions.thinking : 'off';
  const model = VALID_MODELS.includes(rawOptions.model) ? rawOptions.model : config.defaultModel;
  const resolvedMode: EditMode =
    mode === 'ask' ? 'ask' : range.text.length === 0 ? (mode === 'surgical' ? 'insert' : mode === 'insert' ? 'insert' : 'insert') : mode === 'insert' ? 'rewrite' : mode;
  const finalInstruction = instructionText || preset.defaultInstruction;
  const request: EditRequest = {
    requestId: b.requestId,
    docRev: typeof b.docRev === 'number' ? b.docRev : 0,
    docText: b.docText,
    docTitle: typeof b.docTitle === 'string' ? b.docTitle : '',
    ranges: [range as EditRequest['ranges'][number]],
    instruction: finalInstruction,
    options: {
      model: model as EditRequest['options']['model'],
      thinking: thinking as EditRequest['options']['thinking'],
      mode: resolvedMode,
      presetId: preset.id,
      analysis: rawOptions.analysis !== false,
      contextChars: clamp(rawOptions.contextChars ?? config.limits.defaultContextChars, 0, config.limits.maxContextChars, config.limits.defaultContextChars),
      maxRewriteChars: clamp(rawOptions.maxRewriteChars ?? config.limits.defaultMaxRewriteChars, 200, config.limits.maxSelectionChars, config.limits.defaultMaxRewriteChars),
      maxDocumentChars: clamp(rawOptions.maxDocumentChars ?? 20_000, 1_000, config.limits.maxDocumentChars, 20_000),
      sanitizeFormat: rawOptions.sanitizeFormat !== false,
      language: typeof rawOptions.language === 'string' && rawOptions.language.trim() ? rawOptions.language.trim() : null,
    },
  };
  return { request };
}

function mergeUsage(target: Usage, next: Usage | undefined): void {
  if (!next) return;
  target.promptTokens += next.promptTokens;
  target.completionTokens += next.completionTokens;
  target.totalTokens += next.totalTokens;
  target.promptCacheHitTokens = (target.promptCacheHitTokens ?? 0) + (next.promptCacheHitTokens ?? 0);
  target.promptCacheMissTokens = (target.promptCacheMissTokens ?? 0) + (next.promptCacheMissTokens ?? 0);
  if (next.reasoningTokens) target.reasoningTokens = (target.reasoningTokens ?? 0) + next.reasoningTokens;
}

export interface EditRunStats {
  attempts: number;
  repairs: number;
  usage: Usage;
  truncatedLastAttempt: boolean;
}

/**
 * 执行一次编辑（可独立于 Express 调用，便于测试）。
 * send 用于推送 SSE 事件；signal 中止时结束。
 */
export async function executeEdit(
  request: EditRequest,
  send: (event: ServerEvent) => void,
  signal: AbortSignal,
  stats?: EditRunStats,
): Promise<void> {
  const startedAt = Date.now();
  const range = request.ranges[0];
  const mode = request.options.mode;
  const local = analyzeSelection(request.docText, range.from, range.to, 0);
  const markers = createMarkers([request.docText, request.instruction, range.before, range.after]);
  const promptOptions = { markers, mode, analysis: request.options.analysis, presetId: request.options.presetId };

  const timings: Timings = { startedAt, attempts: 0, repairs: 0 };
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  send({
    type: 'meta',
    requestId: request.requestId,
    docRev: request.docRev,
    model: request.options.model,
    mode,
    localAnalyses: [local],
    startedAt,
  });

  const systemPrompt = buildSystemPrompt(mode, markers, request.options.analysis, request.options.presetId);
  const userPrompt = buildUserPrompt(request, [local], promptOptions);
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  let messages = baseMessages;
  let previousRaw = '';

  const maxAttempts = 1 + config.maxRepairs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return;
    timings.attempts = attempt + 1;
    if (stats) stats.attempts = attempt + 1;
    let firstContentSeen = false;
    let finishReason: string | null = null;
    send({ type: 'status', phase: attempt === 0 ? 'connecting' : 'repairing', note: attempt === 0 ? undefined : '正在根据校验结果修复格式…', attempt: attempt + 1 });

    const parser = new StreamParser({
      mode,
      markers,
      expectAnalysis: request.options.analysis,
      onAnalysis: (analysis) => send({ type: 'analysis', analysis }),
      onDelta: (text) => {
        if (mode === 'ask') send({ type: 'answer', delta: text });
        else send({ type: 'delta', rangeId: range.index, text });
      },
      onRaw: (text) => send({ type: 'raw', delta: text }),
    });

    let streamedContent = false;
    try {
      // 不传 max_tokens：输出长度交给模型/服务端默认上限，避免长文被中途截断
      const iterator = streamChat({
        model: request.options.model,
        messages,
        thinking: request.options.thinking,
        signal,
      });
      for await (const chunk of iterator) {
        if (signal.aborted) return;
        if (chunk.usage) {
          mergeUsage(usage, chunk.usage);
          if (stats) stats.usage = usage;
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.reasoningDelta) send({ type: 'reasoning', delta: chunk.reasoningDelta });
        if (chunk.contentDelta) {
          if (!firstContentSeen) {
            firstContentSeen = true;
            timings.firstContentMs = Date.now() - startedAt;
            send({ type: 'status', phase: 'streaming', attempt: attempt + 1 });
          }
          streamedContent = true;
          parser.push(chunk.contentDelta);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      const deepseekError = err instanceof DeepSeekError ? err : null;
      send({
        type: 'error',
        code: deepseekError?.code ?? 'upstream-error',
        message: deepseekError?.message ?? (err instanceof Error ? err.message : String(err)),
        detail: deepseekError?.detail,
        retryable: deepseekError?.retryable ?? true,
      });
      timings.finishedAt = Date.now();
      timings.totalMs = timings.finishedAt - startedAt;
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }

    if (finishReason === 'content_filter' || finishReason === 'insufficient_system_resource') {
      send({
        type: 'error',
        code: finishReason,
        message: finishReason === 'content_filter' ? '模型因内容安全策略停止输出，请调整内容后重试。' : '模型资源不足，本次输出不完整，请重试。',
        retryable: finishReason === 'insufficient_system_resource',
      });
      timings.finishedAt = Date.now();
      timings.totalMs = timings.finishedAt - startedAt;
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }

    const parsed: ParseResult = parser.finish({ finishReason });
    previousRaw = parsed.raw;
    if (!streamedContent && !parsed.raw.trim()) {
      send({ type: 'error', code: 'empty-completion', message: '模型没有返回任何内容，请重试。', retryable: true });
      timings.finishedAt = Date.now();
      timings.totalMs = timings.finishedAt - startedAt;
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }

    send({ type: 'status', phase: 'validating' });
    const localAnalyses = [local];
    const result = buildProposal({
      request,
      parsed,
      localAnalyses,
      usage,
      timings,
      sanitize: request.options.sanitizeFormat,
      allowFuzzy: true,
    });

    if (result.proposal && !(parsed.truncated && !result.proposal.ops.length)) {
      // 截断的提案仍会返回，但携带 error 级警告；是否应用由用户决定
      if (!parsed.truncated) {
        timings.finishedAt = Date.now();
        timings.totalMs = timings.finishedAt - startedAt;
        result.proposal.usage = usage;
        result.proposal.timings = timings;
        send({ type: 'proposal', proposal: result.proposal });
        send({ type: 'status', phase: 'done' });
        send({ type: 'done', requestId: request.requestId, usage, timings });
        return;
      }
    }

    const repairHint: RepairHint | null = result.repair;
    const truncated = parsed.truncated;
    if (attempt + 1 < maxAttempts) {
      const reason = repairHint?.message
        ?? (truncated
          ? '上一次输出在结束标记之前被截断，内容不完整。请重新输出完整内容；如果内容较长，请让表达更凝练，或减少 FIND 块数量。'
          : '上一次输出未通过校验，请重新输出。');
      console.log(
        `[edit] ${request.requestId} 第 ${attempt + 1} 次输出未通过校验（truncated=${truncated} finish=${finishReason ?? 'n/a'}），原因: ${reason.slice(0, 300).replace(/\n/g, ' | ')}`,
      );
      timings.repairs++;
      if (stats) stats.repairs = timings.repairs;
      const repairMessage = buildRepairMessage(request, parsed, reason, promptOptions);
      messages = [
        ...baseMessages,
        { role: 'assistant', content: previousRaw.slice(0, 32_000) || '（无输出）' },
        { role: 'user', content: repairMessage },
      ];
      send({ type: 'status', phase: 'repairing', note: '校验未通过，正在自动修复…', attempt: attempt + 2 });
      continue;
    }

    // 最后一次尝试仍失败：把带警告的提案返回（若有），否则报错
    if (result.proposal) {
      timings.finishedAt = Date.now();
      timings.totalMs = timings.finishedAt - startedAt;
      result.proposal.usage = usage;
      result.proposal.timings = timings;
      send({ type: 'proposal', proposal: result.proposal });
      send({ type: 'status', phase: 'done', note: '校验未完全通过，请检查差异后再决定是否接受' });
      send({ type: 'done', requestId: request.requestId, usage, timings });
      return;
    }
    send({
      type: 'error',
      code: 'apply-failed',
      message: repairHint?.message ?? '模型输出无法通过校验，请重试或换一种指令表达。',
      retryable: true,
    });
    timings.finishedAt = Date.now();
    timings.totalMs = timings.finishedAt - startedAt;
    send({ type: 'done', requestId: request.requestId, usage, timings });
    return;
  }
}

/** Express 处理器：建立 SSE 连接并驱动 executeEdit */
export async function handleEdit(req: Request, res: Response): Promise<void> {
  if (!hasApiKey()) {
    res.status(503).json({ code: 'missing-api-key', error: '服务端未配置 DEEPSEEK_API_KEY，请在项目根目录的 .env 中填写后重启服务。' });
    return;
  }
  const { request, error } = validateEditRequest(req.body);
  if (error || !request) {
    res.status(error?.status ?? 400).json({ code: error?.code ?? 'bad-request', error: error?.message ?? '请求无效' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const abortController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = AbortSignal.any([abortController.signal, timeoutSignal]);
  let closed = false;
  // 注意：Node 16+ 的 req 'close' 表示请求体接收完成（不是连接断开），
  // 必须监听 res 的 close 才能正确感知客户端中止。
  const onClose = () => {
    closed = true;
    abortController.abort();
  };
  res.on('close', onClose);

  let terminalSent = false;
  const send = (event: ServerEvent) => {
    if (closed || res.writableEnded) return;
    if (event.type === 'proposal' || event.type === 'error' || event.type === 'done') terminalSent = true;
    try {
      res.write(encodeSse(event));
    } catch {
      closed = true;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try {
      res.write(encodePing());
    } catch {
      closed = true;
    }
  }, 15_000);

  const logStart = Date.now();
  const stats: EditRunStats = { attempts: 0, repairs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, truncatedLastAttempt: false };
  try {
    await executeEdit(request, send, signal, stats);
    if (!terminalSent && !closed && timeoutSignal.aborted) {
      send({
        type: 'error',
        code: 'timeout',
        message: `本次生成超时（${Math.round(config.requestTimeoutMs / 1000)} 秒）。请重试，或缩小选区/换用更快的模型。`,
        retryable: true,
      });
      send({
        type: 'done',
        requestId: request.requestId,
        usage: stats.usage,
        timings: { startedAt: logStart, attempts: stats.attempts, repairs: stats.repairs },
      });
    }
  } catch (err) {
    if (!signal.aborted) {
      const deepseekError = err instanceof DeepSeekError ? err : null;
      console.error('[edit] executeEdit 异常:', err);
      send({
        type: 'error',
        code: deepseekError?.code ?? 'internal-error',
        message: deepseekError?.message ?? (err instanceof Error ? err.message : String(err)),
        detail: deepseekError?.detail,
        retryable: deepseekError?.retryable ?? true,
      });
    }
  } finally {
    clearInterval(heartbeat);
    const elapsed = Date.now() - logStart;
    if (request) {
      console.log(
        `[edit] ${request.requestId} mode=${request.options.mode} model=${request.options.model} sel=${request.ranges[0].text.length}chars ` +
          `attempts=${stats.attempts} repairs=${stats.repairs} tokens=${stats.usage.totalTokens} time=${elapsed}ms`,
      );
    }
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

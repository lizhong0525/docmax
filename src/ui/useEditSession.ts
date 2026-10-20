/**
 * 一次 AI 修改会话的状态机：负责流式请求、事件累积、多选区串行处理与错误收口。
 *
 * 这里刻意不做任何文档 dispatch —— 流式输出只进入 React 状态，
 * 真正改文档只发生在用户点「接受」时（见 App.tsx 的 accept）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultEditOptions, streamEdit, type StreamHandlers } from '../core/client';
import { buildRangeSnapshot } from '../core/selection';
import type { EditMode, EditProposal, EditRequest, Timings, Usage } from '../core/types';
import type { EditSessionState, RawRange, RunParams, SessionError } from './types';

const DEFAULT_MAX_REWRITE_CHARS = 4_000;

export interface SessionContext {
  docText: string;
  docTitle: string;
  docRev: number;
  /** 主选区优先的顺序 */
  ranges: RawRange[];
}

export const INITIAL_SESSION: EditSessionState = {
  status: 'idle',
  phase: null,
  phaseNote: null,
  attempt: 1,
  instruction: '',
  model: 'deepseek-flash',
  thinking: 'off',
  modeChoice: 'auto',
  ask: false,
  presetId: 'default',
  batch: { current: 0, total: 0 },
  reasoning: '',
  analysis: null,
  streamText: '',
  rawText: '',
  answer: '',
  proposals: [],
  error: null,
  startedAt: 0,
  elapsedMs: 0,
  finishedMs: null,
  usage: null,
  timings: null,
  stale: false,
  staleReason: null,
  truncatedConfirm: false,
  applying: false,
  requestCount: 0,
};

const ERROR_HINTS: Record<string, string> = {
  'missing-api-key': '请在项目根目录 .env 中配置 DEEPSEEK_API_KEY，然后重启本地服务。',
  'invalid-api-key': 'API Key 无效，请检查 .env 中的 DEEPSEEK_API_KEY。',
  'insufficient-balance': 'DeepSeek 账户余额不足，请充值后重试。',
  'rate-limited': '请求过于频繁（限流），稍等片刻再试。',
  'stale-selection': '文档或选区已变化，请重新生成修改。',
  'apply-failed': '模型输出未通过校验，可重试或换一种指令表达。',
  'network-error': '无法连接本地服务，请确认服务正在运行。',
  'empty-completion': '模型没有返回内容，请重试。',
  'content_filter': '内容被安全策略拦截，请调整文字后重试。',
  'insufficient_system_resource': '模型资源不足，本次输出不完整，请重试。',
  aborted: '已取消本次生成。',
};

function localizeError(error: {
  code: string;
  message: string;
  detail?: string;
  retryable: boolean;
}): SessionError {
  const hint = ERROR_HINTS[error.code];
  return {
    code: error.code,
    message: error.message || hint || '请求失败，请重试。',
    hint: hint && hint !== error.message ? hint : undefined,
    detail: error.detail,
    retryable: error.retryable,
  };
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** 解析本次请求真正使用的模式（与命令条里展示的解析保持一致） */
export function resolveRequestMode(params: RunParams, selectionChars: number): EditMode {
  if (params.ask) return 'ask';
  if (selectionChars === 0) return 'insert';
  if (params.modeChoice === 'surgical') return 'surgical';
  if (params.modeChoice === 'rewrite') return 'rewrite';
  return selectionChars > DEFAULT_MAX_REWRITE_CHARS ? 'surgical' : 'rewrite';
}

interface PendingDeltas {
  reasoning: string;
  stream: string;
  raw: string;
  answer: string;
}

function emptyPending(): PendingDeltas {
  return { reasoning: '', stream: '', raw: '', answer: '' };
}

function mergeUsage(target: Usage, next: Usage | undefined): Usage {
  if (!next) return target;
  return {
    promptTokens: target.promptTokens + next.promptTokens,
    completionTokens: target.completionTokens + next.completionTokens,
    totalTokens: target.totalTokens + next.totalTokens,
    promptCacheHitTokens: (target.promptCacheHitTokens ?? 0) + (next.promptCacheHitTokens ?? 0),
    promptCacheMissTokens: (target.promptCacheMissTokens ?? 0) + (next.promptCacheMissTokens ?? 0),
    reasoningTokens: (target.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  };
}

const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const MAX_ACCUMULATED = 240_000;
function capText(text: string, max = MAX_ACCUMULATED): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export interface EditSessionApi {
  state: EditSessionState;
  start: (params: RunParams, context: SessionContext) => void;
  abort: () => void;
  reset: () => void;
}

export function useEditSession(): EditSessionApi {
  const [state, setState] = useState<EditSessionState>(INITIAL_SESSION);
  const stateRef = useRef(state);
  stateRef.current = state;

  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingDeltas>(emptyPending());
  const flushTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const startedAtRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      if (elapsedTimerRef.current) window.clearInterval(elapsedTimerRef.current);
    };
  }, []);

  const stopTimers = useCallback(() => {
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const patch = useCallback((partial: Partial<EditSessionState>) => {
    if (!mountedRef.current) return;
    setState((previous) => ({ ...previous, ...partial }));
  }, []);

  const pushDelta = useCallback(
    (kind: keyof PendingDeltas, delta: string) => {
      if (!delta) return;
      const pending = pendingRef.current;
      pending[kind] = capText(pending[kind] + delta);
      if (flushTimerRef.current) return;
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        const current = pendingRef.current;
        if (!current.reasoning && !current.stream && !current.raw && !current.answer) return;
        pendingRef.current = emptyPending();
        if (!mountedRef.current) return;
        setState((previous) => ({
          ...previous,
          reasoning: capText(previous.reasoning + current.reasoning),
          streamText: capText(previous.streamText + current.stream),
          rawText: capText(previous.rawText + current.raw),
          answer: capText(previous.answer + current.answer),
        }));
      }, 66);
    },
    [],
  );

  const flushDeltas = useCallback(() => {
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const current = pendingRef.current;
    pendingRef.current = emptyPending();
    if (!current.reasoning && !current.stream && !current.raw && !current.answer) return;
    if (!mountedRef.current) return;
    setState((previous) => ({
      ...previous,
      reasoning: capText(previous.reasoning + current.reasoning),
      streamText: capText(previous.streamText + current.stream),
      rawText: capText(previous.rawText + current.raw),
      answer: capText(previous.answer + current.answer),
    }));
  }, []);

  const reset = useCallback(() => {
    stopTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = emptyPending();
    setState(INITIAL_SESSION);
  }, [stopTimers]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    (params: RunParams, context: SessionContext) => {
      if (stateRef.current.status === 'running') return;
      if (!context.ranges.length) return;
      // 解释模式只处理主选区：回答不需要逐段执行
      const ranges = params.ask ? context.ranges.slice(0, 1) : context.ranges;
      const startedAt = Date.now();
      startedAtRef.current = startedAt;
      const abortController = new AbortController();
      abortRef.current = abortController;
      pendingRef.current = emptyPending();

      setState({
        ...INITIAL_SESSION,
        status: 'running',
        phase: 'connecting',
        instruction: params.instruction,
        model: params.model,
        thinking: params.thinking,
        modeChoice: params.modeChoice,
        ask: params.ask,
        presetId: params.presetId,
        batch: { current: 1, total: ranges.length },
        startedAt,
        elapsedMs: 0,
        requestCount: ranges.length,
      });

      if (elapsedTimerRef.current) window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = window.setInterval(() => {
        if (!mountedRef.current) return;
        setState((previous) =>
          previous.status === 'running' ? { ...previous, elapsedMs: Date.now() - startedAt } : previous,
        );
      }, 200);

      const run = async () => {
        const collected: EditProposal[] = [];
        let usage = EMPTY_USAGE;
        let timings: Timings | null = null;
        let firstError: SessionError | null = null;

        for (let index = 0; index < ranges.length; index++) {
          if (abortController.signal.aborted) break;
          const raw = ranges[index];
          const snapshot = buildRangeSnapshot(context.docText, raw, index, defaultEditOptions().contextChars);
          const mode = resolveRequestMode(params, snapshot.text.length);
          const options = defaultEditOptions({
            model: params.model,
            thinking: params.thinking,
            mode,
            presetId: params.presetId,
          });
          const request: EditRequest = {
            requestId: newRequestId(),
            docRev: context.docRev,
            docText: context.docText,
            docTitle: context.docTitle,
            ranges: [snapshot],
            instruction: params.instruction,
            options,
          };

          pendingRef.current = emptyPending();
          patch({
            batch: { current: index + 1, total: ranges.length },
            phase: 'connecting',
            phaseNote: null,
            attempt: 1,
            reasoning: '',
            streamText: '',
            rawText: '',
            answer: '',
            analysis: null,
          });

          const handlers: StreamHandlers = {
            onStatus: (event) => {
              patch({
                phase: event.phase,
                phaseNote: event.note ?? null,
                attempt: event.attempt ?? stateRef.current.attempt,
              });
            },
            onReasoning: (delta) => pushDelta('reasoning', delta),
            onAnalysis: (analysis) => patch({ analysis }),
            onDelta: (delta) => pushDelta('stream', delta),
            onRaw: (delta) => pushDelta('raw', delta),
            onAnswer: (delta) => pushDelta('answer', delta),
            onDone: (info) => {
              usage = mergeUsage(usage, info.usage);
              timings = info.timings;
              patch({ usage, timings });
            },
          };

          let outcome;
          try {
            outcome = await streamEdit(request, handlers, abortController.signal);
          } catch (error) {
            outcome = {
              ok: false,
              error: {
                code: 'unexpected-error',
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
              },
            };
          }
          flushDeltas();

          if (outcome.proposal) {
            collected.push(outcome.proposal);
            patch({
              proposals: [...collected],
              analysis: outcome.proposal.analysis ?? stateRef.current.analysis,
            });
          }

          if (!outcome.ok) {
            const mapped = localizeError(
              outcome.error ?? { code: 'unknown', message: '请求失败，请重试。', retryable: true },
            );
            if (mapped.code === 'aborted' || abortController.signal.aborted) {
              firstError = mapped;
            } else {
              firstError = mapped;
            }
            break;
          }

          if (!outcome.proposal && !params.ask) {
            firstError = {
              code: 'no-proposal',
              message: '服务端没有返回可应用的修改，请重试。',
              retryable: true,
            };
            break;
          }
        }

        if (!mountedRef.current) return;
        stopTimers();
        const elapsed = Date.now() - startedAt;

        if (abortController.signal.aborted) {
          setState(INITIAL_SESSION);
          return;
        }

        const status: EditSessionState['status'] =
          collected.length > 0 ? (firstError ? 'error' : 'review') : 'error';
        setState((previous) => ({
          ...previous,
          status,
          phase: firstError && collected.length === 0 ? previous.phase : 'done',
          elapsedMs: elapsed,
          finishedMs: elapsed,
          usage,
          timings: timings ?? previous.timings,
          error: firstError,
          proposals: collected,
          applying: false,
        }));
      };

      void run();
    },
    [flushDeltas, patch, pushDelta, stopTimers],
  );

  return useMemo(() => ({ state, start, abort, reset }), [state, start, abort, reset]);
}

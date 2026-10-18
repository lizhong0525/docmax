/**
 * 底部指令条（Ctrl/⌘+K）。
 *
 * - 快捷标签填充指令；「解释」标签切换到 ask（只回答，不改文档）。
 * - 模型 / 思考强度 / 修改模式可覆盖；自动模式按选区长度解析。
 * - 提交前可展开查看真实会发送的选区快照（before / selection / after 截断预览）。
 * - Enter 提交、Shift+Enter 换行、Esc 关闭；IME 组合输入时 Enter 不会误提交。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelId, ThinkingLevel } from '../core/types';
import type { DraftContext, HealthState, ModeChoice, RunParams } from './types';
import { MODEL_OPTIONS, THINKING_OPTIONS, MODE_CHOICE_LABELS, describeMode, formatCount, BLOCK_LABELS } from './labels';
import { clipHead, clipMiddle, clipTail } from './utils';

const PRESETS: Array<{ id: string; label: string; instruction: string; ask?: boolean }> = [
  { id: 'polish', label: '润色', instruction: '润色这段话，保持原意，让表达更自然、准确。' },
  { id: 'concise', label: '更简洁', instruction: '让这段文字更简洁，删掉冗余，保留关键信息。' },
  { id: 'expand', label: '扩写', instruction: '扩写这段文字，补充必要的细节，但不要偏离原意。' },
  { id: 'shorten', label: '缩写', instruction: '把这段文字压缩得更短，保留核心信息。' },
  { id: 'rewrite', label: '改写', instruction: '改写这段话，换一种表达方式，保持原意。' },
  { id: 'translate', label: '翻译', instruction: '把这段文字翻译成地道的英文。' },
  { id: 'fix', label: '修正', instruction: '修正这段文字中的错别字、标点和语法问题。' },
  { id: 'explain', label: '解释', instruction: '解释这段文字的含义和结构，不需要修改文档。', ask: true },
];

export interface CommandBarProps {
  open: boolean;
  draft: DraftContext | null;
  busy: boolean;
  hasApiKey: boolean;
  serviceState: HealthState;
  defaults: { model: ModelId; thinking: ThinkingLevel; modeChoice: ModeChoice };
  limits: {
    maxSelectionChars: number;
    maxInstructionChars: number;
    maxDocumentChars: number;
    defaultMaxRewriteChars: number;
  };
  isMac: boolean;
  onClose: () => void;
  onSubmit: (params: RunParams) => void;
}

export function CommandBar(props: CommandBarProps) {
  const { open, draft, busy } = props;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [instruction, setInstruction] = useState('');
  const [model, setModel] = useState<ModelId>(props.defaults.model);
  const [thinking, setThinking] = useState<ThinkingLevel>(props.defaults.thinking);
  const [modeChoice, setModeChoice] = useState<ModeChoice>(props.defaults.modeChoice);
  const [ask, setAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInstruction('');
    setModel(props.defaults.model);
    setThinking(props.defaults.thinking);
    setModeChoice(props.defaults.modeChoice);
    setAsk(false);
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
    // defaults 只在打开面板时取一次，避免用户输入过程中被外部状态重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalChars = useMemo(
    () => (draft ? draft.ranges.reduce((sum, range) => sum + range.analysis.chars, 0) : 0),
    [draft],
  );
  const isEmpty = totalChars === 0;
  const primary = draft?.ranges[0] ?? null;
  const rangeCount = draft?.ranges.length ?? 0;

  const resolvedMode = useMemo(() => {
    if (ask) return 'ask';
    if (isEmpty) return 'insert';
    if (modeChoice === 'rewrite') return 'rewrite';
    if (modeChoice === 'surgical') return 'surgical';
    return (primary?.analysis.chars ?? 0) > props.limits.defaultMaxRewriteChars ? 'surgical' : 'rewrite';
  }, [ask, isEmpty, modeChoice, primary, props.limits.defaultMaxRewriteChars]);

  const selectionLimitExceeded = totalChars > props.limits.maxSelectionChars;
  const instructionLimitExceeded = instruction.length > props.limits.maxInstructionChars;
  const submitDisabled =
    busy ||
    !instruction.trim() ||
    !props.hasApiKey ||
    selectionLimitExceeded ||
    instructionLimitExceeded;

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setInstruction(preset.instruction);
    setAsk(!!preset.ask);
    setError(null);
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(preset.instruction.length, preset.instruction.length);
  };

  const submit = () => {
    const text = instruction.trim();
    if (busy) return;
    if (!text) {
      setError('先写一句指令，或点一个快捷标签');
      textareaRef.current?.focus();
      return;
    }
    if (!props.hasApiKey) {
      setError('服务端未配置 API Key。请在项目根目录 .env 中填写 DEEPSEEK_API_KEY 后重启服务。');
      return;
    }
    if (selectionLimitExceeded) {
      setError(`选区共 ${formatCount(totalChars)} 字，超过单次上限 ${formatCount(props.limits.maxSelectionChars)} 字。`);
      return;
    }
    if (instructionLimitExceeded) {
      setError(`指令超过 ${formatCount(props.limits.maxInstructionChars)} 字上限，请精简。`);
      return;
    }
    setError(null);
    props.onSubmit({ instruction: text, model, thinking, modeChoice, ask });
  };

  if (!open) return null;

  return (
    <div
      className="command-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className="command-bar"
        role="dialog"
        aria-label="AI 指令条"
        data-testid="command-bar"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div className="command-context">
          <span className="command-context-title">
            {isEmpty ? '在光标处插入' : rangeCount > 1 ? `修改 ${rangeCount} 处选区` : '修改选区'}
          </span>
          <span className="command-context-meta">
            {isEmpty
              ? '没有选中文字，将让模型插入新内容'
              : `${formatCount(totalChars)} 字${primary ? ` · ${BLOCK_LABELS[primary.analysis.blockKind]}` : ''}`}
            {rangeCount > 1 ? ` · 共 ${rangeCount} 处，按主选区优先逐个处理` : ''}
          </span>
          <button type="button" className="icon-btn command-close" onClick={props.onClose} aria-label="关闭指令条">
            ✕
          </button>
        </div>

        <div className="command-chips" role="group" aria-label="快捷指令">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`chip${instruction === preset.instruction ? ' is-active' : ''}`}
              onClick={() => applyPreset(preset)}
              aria-pressed={instruction === preset.instruction}
              data-testid={`chip-${preset.id}`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <textarea
          ref={textareaRef}
          className="command-input"
          data-testid="command-input"
          rows={2}
          value={instruction}
          placeholder={isEmpty ? '描述你想插入的内容，例如：写一段关于「克制」的开头' : '告诉 DeepSeek 你想怎么改，例如：润色这段话，保持原意'}
          onChange={(event) => {
            setInstruction(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              // IME 组合输入中的 Enter 是确认候选词，不能当作提交
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              submit();
            }
          }}
          aria-label="AI 指令"
        />

        {ask ? (
          <div className="ask-note" data-testid="ask-note">
            <span>解释模式：只返回回答，不会修改文档。</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAsk(false);
                setInstruction('');
                textareaRef.current?.focus();
              }}
            >
              取消解释
            </button>
          </div>
        ) : null}

        <details className="payload" data-testid="payload-preview">
          <summary>查看将发送的选区快照</summary>
          <div className="payload-body">
            <p className="payload-lead">
              只发送以下选区信息、选区前后上下文与文档全文，用于精确修改与校验。当前文档{' '}
              {formatCount(draft?.docChars ?? 0)} 字 · {formatCount(draft?.docLines ?? 0)} 行。
            </p>
            {(draft?.ranges ?? []).map((range) => (
              <div className="payload-range" key={range.index}>
                <div className="payload-range-head">
                  第 {range.index + 1} 处 · {BLOCK_LABELS[range.analysis.blockKind]} · {formatCount(range.analysis.chars)} 字 · 第{' '}
                  {range.analysis.startLine}–{range.analysis.endLine} 行
                </div>
                <div className="payload-block">
                  <span className="payload-label">before</span>
                  <pre>{clipTail(range.snapshot.before, 120) || '（文档开头）'}</pre>
                </div>
                <div className="payload-block payload-block-selection">
                  <span className="payload-label">selection</span>
                  <pre>{clipMiddle(range.snapshot.text, 260) || '（空选区 → 插入）'}</pre>
                </div>
                <div className="payload-block">
                  <span className="payload-label">after</span>
                  <pre>{clipHead(range.snapshot.after, 120) || '（文档末尾）'}</pre>
                </div>
              </div>
            ))}
            <p className="payload-foot">
              hash {draft?.ranges.map((range) => range.snapshot.hash).join(' · ') || '—'} · 应用前会再次校验快照
            </p>
          </div>
        </details>

        <div className="command-options">
          <label className="field">
            <span>模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value as ModelId)} data-testid="select-model">
              {MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.hint}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>思考</span>
            <select
              value={thinking}
              onChange={(event) => setThinking(event.target.value as ThinkingLevel)}
              data-testid="select-thinking"
            >
              {THINKING_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.hint}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>模式</span>
            <select
              value={modeChoice}
              onChange={(event) => setModeChoice(event.target.value as ModeChoice)}
              data-testid="select-mode"
            >
              <option value="auto">自动 · 按选区长度</option>
              <option value="rewrite">整体重写</option>
              <option value="surgical">局部精准修改</option>
            </select>
          </label>
          <div className="resolved-mode" data-testid="resolved-mode">
            <span className="resolved-label">{MODE_CHOICE_LABELS[modeChoice]}</span>
            <span>{describeMode(resolvedMode)}</span>
          </div>
        </div>

        {draft && draft.docChars > props.limits.maxDocumentChars ? (
          <p className="command-warning">文档较长（超过 {formatCount(props.limits.maxDocumentChars)} 字），服务端会改用大纲 + 摘录作为上下文。</p>
        ) : null}
        {props.serviceState === 'nokey' ? (
          <p className="command-warning command-warning-error">
            服务端未配置 DEEPSEEK_API_KEY，AI 修改不可用。请在 .env 中配置后重启服务。
          </p>
        ) : null}
        {props.serviceState === 'offline' ? (
          <p className="command-warning">无法连接本地服务（/api/health）。提交后会给出具体错误。</p>
        ) : null}
        {error ? (
          <p className="command-warning command-warning-error" role="alert" data-testid="command-error">
            {error}
          </p>
        ) : null}

        <div className="command-foot">
          <span className="command-hint">
            <kbd>Enter</kbd> 提交 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>Esc</kbd> 取消
          </span>
          <div className="command-actions">
            <button type="button" className="btn btn-ghost" onClick={props.onClose} data-testid="command-cancel">
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={submitDisabled}
              data-testid="command-submit"
              aria-label={ask ? '提交解释请求' : '提交修改请求'}
            >
              {busy ? '生成中…' : ask ? '让 DeepSeek 解释' : '让 DeepSeek 修改'}
              <kbd>{props.isMac ? '↵' : 'Enter'}</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

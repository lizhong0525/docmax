/**
 * 系统内置提示词模式 + 无输出限制（不发送 max_tokens）的单元测试。
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_PRESETS,
  DEFAULT_PRESET_ID,
  getPromptPreset,
  isPromptPresetId,
} from '../src/core/presets';
import { buildSystemPrompt, buildUserPrompt } from '../src/core/prompt';
import { createMarkers } from '../src/core/markers';
import { buildRangeSnapshot } from '../src/core/selection';
import { defaultEditOptions } from '../src/core/client';
import type { EditRequest } from '../src/core/types';
import { buildChatRequestBody } from '../server/deepseek';
import { validateEditRequest } from '../server/editRoute';

function makeRequest(overrides: Partial<EditRequest['options']> = {}, instruction = '润色这段话'): EditRequest {
  const doc = '# 标题\n\n这是一段用于测试的示例文字，内容可能写了一半。\n';
  const from = doc.indexOf('这是一段');
  const to = doc.indexOf('。', from) + 1;
  const range = buildRangeSnapshot(doc, { from, to }, 0, 200);
  return {
    requestId: 'test-request',
    docRev: 1,
    docText: doc,
    docTitle: 'test.md',
    ranges: [range],
    instruction,
    options: defaultEditOptions({ mode: 'rewrite', ...overrides }),
  };
}

describe('提示词模式目录', () => {
  it('包含默认模式与「结构重写·括号补全」模式', () => {
    expect(PROMPT_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(PROMPT_PRESETS[0].id).toBe(DEFAULT_PRESET_ID);
    const ids = PROMPT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const structure = getPromptPreset('structure-fill');
    expect(structure.label).toContain('结构');
    expect(structure.rules).toContain('（需补充：');
    expect(structure.rules).toContain('不要编造事实');
    expect(structure.rules).toContain('保留段落顺序');
  });

  it('每个模式都有规则、默认指令、说明', () => {
    for (const preset of PROMPT_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(8);
      expect(preset.rules.length).toBeGreaterThan(20);
      expect(preset.defaultInstruction.length).toBeGreaterThan(0);
    }
  });

  it('非法 id 回退到默认模式', () => {
    expect(isPromptPresetId('structure-fill')).toBe(true);
    expect(isPromptPresetId('nope')).toBe(false);
    expect(getPromptPreset('nope').id).toBe(DEFAULT_PRESET_ID);
    expect(getPromptPreset(undefined).id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('提示词构建包含所选模式', () => {
  it('系统提示词在编辑模式包含模式规则，解释模式忽略模式', () => {
    const markers = createMarkers([]);
    const rewrite = buildSystemPrompt('rewrite', markers, true, 'structure-fill');
    expect(rewrite).toContain('结构重写（缺失处用括号补全）');
    expect(rewrite).toContain('（需补充：');
    const ask = buildSystemPrompt('ask', markers, true, 'structure-fill');
    expect(ask).not.toContain('结构重写（缺失处用括号补全）');
    expect(ask).toContain(markers.answerStart);
  });

  it('用户提示词包含 prompt_mode 区块（编辑模式）', () => {
    const markers = createMarkers([]);
    const request = makeRequest({ presetId: 'structure-fill' });
    const prompt = buildUserPrompt(request, [
      {
        index: 0,
        chars: request.ranges[0].text.length,
        words: 10,
        lines: 1,
        blockKind: 'paragraph',
        codeFenceLang: null,
        startsMidWord: false,
        endsMidWord: false,
        startsMidLine: false,
        endsMidLine: false,
        delimiterWarnings: [],
        spansMultipleBlocks: false,
        suggestions: [],
        startLine: 3,
        endLine: 3,
        boundary: { before: '', after: '' },
      },
    ], { markers, mode: 'rewrite', analysis: true, presetId: 'structure-fill' });
    expect(prompt).toContain('<prompt_mode>');
    expect(prompt).toContain('结构重写 · 括号补全');
    expect(prompt).toContain('<selection>');
  });
});

describe('请求校验：提示词模式与空指令', () => {
  it('非默认模式 + 空指令：使用模式默认指令', () => {
    const request = makeRequest({ presetId: 'structure-fill', mode: 'rewrite' }, '');
    const result = validateEditRequest(request);
    expect(result.error).toBeUndefined();
    expect(result.request?.options.presetId).toBe('structure-fill');
    expect(result.request?.instruction).toBe(getPromptPreset('structure-fill').defaultInstruction);
  });

  it('默认模式 + 空指令：仍然报错', () => {
    const request = makeRequest({ presetId: 'default' }, '   ');
    const result = validateEditRequest(request);
    expect(result.error?.code).toBe('empty-instruction');
  });

  it('非法预设 id 回退为默认', () => {
    const request = makeRequest({ presetId: 'not-a-preset' as never });
    const result = validateEditRequest(request);
    expect(result.request?.options.presetId).toBe(DEFAULT_PRESET_ID);
  });
});

describe('DeepSeek 请求体不设置输出上限', () => {
  it('不包含 max_tokens / max_completion_tokens', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: 'off',
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('思考模式参数正确（不影响输出上限字段）', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: 'high',
    });
    expect(body.reasoning_effort).toBe('high');
    expect(body).not.toHaveProperty('max_tokens');
  });
});

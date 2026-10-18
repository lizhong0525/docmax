/**
 * 单元测试：客户端/服务端共享协议 protocol.ts
 */
import { describe, expect, it } from 'vitest';
import { APP_VERSION, DEFAULT_LIMITS, MODELS, encodePing, encodeSse, publicConfig } from '../src/core/protocol';
import type { ServerEvent } from '../src/core/types';

describe('encodeSse', () => {
  it('按 SSE 规范编码：data: <json> + 空行', () => {
    const event: ServerEvent = { type: 'status', phase: 'streaming', attempt: 2 };
    const encoded = encodeSse(event);
    expect(encoded).toBe(`data: ${JSON.stringify(event)}\n\n`);
    expect(encoded.endsWith('\n\n')).toBe(true);
    // 能被逐行解析
    const lines = encoded.split('\n').filter((l) => l.startsWith('data:'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice(5).trim())).toEqual(event);
  });
});

describe('encodePing', () => {
  it('心跳是 SSE 注释行，客户端应忽略', () => {
    expect(encodePing()).toBe(': ping\n\n');
  });
});

describe('MODELS / DEFAULT_LIMITS', () => {
  it('提供 flash 与 v4-pro 两个模型', () => {
    expect(MODELS.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    for (const m of MODELS) {
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutput).toBeGreaterThan(0);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('默认限制满足编辑器上限', () => {
    expect(DEFAULT_LIMITS.maxSelectionChars).toBeGreaterThanOrEqual(100_000);
    expect(DEFAULT_LIMITS.maxDocumentChars).toBeGreaterThanOrEqual(DEFAULT_LIMITS.maxSelectionChars);
    expect(DEFAULT_LIMITS.defaultContextChars).toBeLessThanOrEqual(DEFAULT_LIMITS.maxContextChars);
  });
});

describe('publicConfig', () => {
  it('hasApiKey 透传，版本号一致', () => {
    const config = publicConfig(true);
    expect(config.hasApiKey).toBe(true);
    expect(config.version).toBe(APP_VERSION);
    expect(config.defaultModel).toBe('deepseek-flash');
    expect(config.defaultThinking).toBe('off');
    expect(config.models).toBe(MODELS);
  });

  it('未配置 Key 时 hasApiKey=false，且可指定默认模型', () => {
    const config = publicConfig(false, 'deepseek-v4-pro');
    expect(config.hasApiKey).toBe(false);
    expect(config.defaultModel).toBe('deepseek-v4-pro');
  });
});

/**
 * 单元测试：协议标记 markers.ts
 * 覆盖：默认标记、文档碰撞时生成 nonce 标记、去分析块、去外层换行、剥离包裹围栏。
 */
import { describe, expect, it } from 'vitest';
import { createMarkers, stripAnalysisBlock, stripOuterNewlines, stripWrapperFence } from '../src/core/markers';

const DEFAULT_MARKERS = {
  analysisStart: '<<<ANALYSIS>>>',
  analysisEnd: '<<<END_ANALYSIS>>>',
  editStart: '<<<EDIT>>>',
  editEnd: '<<<END_EDIT>>>',
  findStart: '<<<FIND>>>',
  findAllStart: '<<<FIND_ALL>>>',
  replaceStart: '<<<REPLACE>>>',
  blockEnd: '<<<END>>>',
  answerStart: '<<<ANSWER>>>',
  answerEnd: '<<<END_ANSWER>>>',
};

const ALL_DEFAULT_VALUES = Object.values(DEFAULT_MARKERS);

describe('createMarkers', () => {
  it('没有碰撞时返回默认标记', () => {
    expect(createMarkers([])).toEqual({ ...DEFAULT_MARKERS, nonce: null });
    expect(createMarkers(['普通文档内容，没有特殊记号'])).toEqual({ ...DEFAULT_MARKERS, nonce: null });
  });

  it.each(ALL_DEFAULT_VALUES)('文本包含 %s 时切换到 nonce 标记', (marker) => {
    const markers = createMarkers(['文档里提到了', marker]);
    expect(markers.nonce).not.toBeNull();
    expect(markers.nonce).toMatch(/^[0-9a-f]{8}$/);
    for (const [key, value] of Object.entries(DEFAULT_MARKERS)) {
      const actual = markers[key as keyof typeof DEFAULT_MARKERS];
      expect(actual).not.toBe(value);
      expect(actual).toContain(markers.nonce!);
      expect(actual.startsWith(value.slice(0, -3))).toBe(true);
      expect(actual.endsWith('>>>')).toBe(true);
    }
  });

  it('检查所有碰撞文本（文档/指令/上下文）而非仅第一个', () => {
    expect(createMarkers(['doc', 'instruction', '', '<<<FIND>>>']).nonce).not.toBeNull();
  });

  it('两次调用生成的 nonce 标记不同（不会全局复用非随机标记）', () => {
    const a = createMarkers(['<<<EDIT>>>']);
    const b = createMarkers(['<<<EDIT>>>']);
    expect(a.editStart).not.toBe(b.editStart);
  });
});

describe('stripOuterNewlines', () => {
  it('去掉恰好一个首尾换行', () => {
    expect(stripOuterNewlines('\n内容\n')).toBe('内容');
    expect(stripOuterNewlines('\r\n内容\r\n')).toBe('内容');
  });

  it('只去一层，不吞掉内容本身的首尾空行', () => {
    expect(stripOuterNewlines('\n\n内容\n\n')).toBe('\n内容\n');
  });

  it('没有换行时保持不变', () => {
    expect(stripOuterNewlines('内容')).toBe('内容');
    expect(stripOuterNewlines('')).toBe('');
    expect(stripOuterNewlines('\n')).toBe('');
  });
});

describe('stripAnalysisBlock', () => {
  const markers = createMarkers([]);

  it('移除完整分析块，保留前后内容', () => {
    const raw = '前言\n<<<ANALYSIS>>>\n{"kind":"x"}\n<<<END_ANALYSIS>>>\n正文';
    expect(stripAnalysisBlock(raw, markers)).toBe('前言\n\n正文');
  });

  it('没有分析块时原样返回', () => {
    expect(stripAnalysisBlock('纯文本', markers)).toBe('纯文本');
  });

  it('分析块不完整（缺结束标记）时原样返回', () => {
    const raw = '<<<ANALYSIS>>>\n{"kind":"x"}\n正文';
    expect(stripAnalysisBlock(raw, markers)).toBe(raw);
  });
});

describe('stripWrapperFence', () => {
  it('移除包裹整个内容的代码围栏（含语言标记）', () => {
    expect(stripWrapperFence('```markdown\n# 标题\n正文\n```')).toEqual({ text: '# 标题\n正文', stripped: true });
  });

  it('允许围栏前后存在空行', () => {
    expect(stripWrapperFence('```\n内容\n\n```')).toEqual({ text: '内容\n', stripped: true });
  });

  it('内容本身不是纯包裹时不剥离', () => {
    const raw = '第一行\n```js\ncode\n```\n最后一行';
    expect(stripWrapperFence(raw)).toEqual({ text: raw, stripped: false });
  });

  it('只有一行时绝不剥离', () => {
    expect(stripWrapperFence('```')).toEqual({ text: '```', stripped: false });
    expect(stripWrapperFence('普通一行')).toEqual({ text: '普通一行', stripped: false });
  });

  it('结尾不是围栏时不剥离', () => {
    const raw = '```\n内容\n尾部说明';
    expect(stripWrapperFence(raw)).toEqual({ text: raw, stripped: false });
  });
});

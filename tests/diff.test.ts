/**
 * 单元测试：差异计算 diff.ts
 * 覆盖：相同文本、中文/英文/emoji/标点/多行的 token diff、统计、reconstruct 性质。
 */
import { describe, expect, it } from 'vitest';
import { computeDiff, type DiffSegment } from '../src/core/diff';

/** 用 equal+removed 还原 before，用 equal+added 还原 after */
function reconstruct(segments: DiffSegment[]): { before: string; after: string } {
  let before = '';
  let after = '';
  for (const seg of segments) {
    if (seg.type === 'equal') {
      before += seg.text;
      after += seg.text;
    } else if (seg.type === 'removed') {
      before += seg.text;
    } else {
      after += seg.text;
    }
  }
  return { before, after };
}

describe('computeDiff：相同与空文本', () => {
  it('完全相同的文本 → identical=true 且只有一个 equal 段', () => {
    const r = computeDiff('同样的中文与 English', '同样的中文与 English');
    expect(r.identical).toBe(true);
    expect(r.segments).toEqual([{ type: 'equal', text: '同样的中文与 English' }]);
    expect(r.removedChars).toBe(0);
    expect(r.addedChars).toBe(0);
  });

  it('两个空串 → identical=true、无段', () => {
    const r = computeDiff('', '');
    expect(r).toEqual({ segments: [], removedChars: 0, addedChars: 0, identical: true });
  });

  it('从空到有内容 → 全部 added', () => {
    const r = computeDiff('', '新增内容');
    expect(r.identical).toBe(false);
    expect(r.addedChars).toBe(4);
    expect(r.removedChars).toBe(0);
    expect(reconstruct(r.segments)).toEqual({ before: '', after: '新增内容' });
  });
});

describe('computeDiff：token 粒度', () => {
  it('英文按词 diff，而不是整行替换', () => {
    const r = computeDiff('The quick brown fox', 'The quick red fox');
    expect(r.identical).toBe(false);
    expect(r.segments).toEqual([
      { type: 'equal', text: 'The quick ' },
      { type: 'removed', text: 'brown' },
      { type: 'added', text: 'red' },
      { type: 'equal', text: ' fox' },
    ]);
    expect(r.removedChars).toBe(5);
    expect(r.addedChars).toBe(3);
  });

  it('中文按词 diff（Intl.Segmenter），不是整句替换', () => {
    const r = computeDiff('这是一个测试', '这是一个简单的测试');
    expect(r.identical).toBe(false);
    expect(r.segments).toEqual([
      { type: 'equal', text: '这是一个' },
      { type: 'added', text: '简单的' },
      { type: 'equal', text: '测试' },
    ]);
    expect(r.removedChars).toBe(0);
    expect(r.addedChars).toBe(3);
  });

  it('中文标点变化只高亮标点本身', () => {
    const r = computeDiff('你好，世界。', '你好，世界！');
    expect(r.segments).toEqual([
      { type: 'equal', text: '你好，世界' },
      { type: 'removed', text: '。' },
      { type: 'added', text: '！' },
    ]);
  });

  it('中英混排：只高亮真正变化的词', () => {
    const r = computeDiff('中文 mixed English 混排', '中文 Mixed English 混排文本');
    expect(reconstruct(r.segments)).toEqual({
      before: '中文 mixed English 混排',
      after: '中文 Mixed English 混排文本',
    });
    expect(r.segments.some((s) => s.type === 'removed' && s.text === 'mixed')).toBe(true);
    expect(r.segments.some((s) => s.type === 'added' && s.text === 'Mixed')).toBe(true);
  });

  it('行首补列表标记：只把新增的 "- " 标为 added', () => {
    const r = computeDiff('列表项一\n- 列表项二', '- 列表项一\n- 列表项二');
    expect(r.segments).toEqual([
      { type: 'added', text: '- ' },
      { type: 'equal', text: '列表项一\n- 列表项二' },
    ]);
  });

  it('emoji 作为独立 token 处理', () => {
    const r = computeDiff('👍 好的', '👎 好的');
    expect(reconstruct(r.segments)).toEqual({ before: '👍 好的', after: '👎 好的' });
    expect(r.segments.some((s) => s.type === 'removed' && s.text === '👍')).toBe(true);
    expect(r.segments.some((s) => s.type === 'added' && s.text === '👎')).toBe(true);
    expect(r.segments.some((s) => s.type === 'equal' && s.text.includes('好的'))).toBe(true);
  });

  it('保留换行 token，多行修改可精确定位到行', () => {
    const r = computeDiff('第一行\n第二行\n第三行', '第一行\n改过的第二行\n第三行');
    expect(reconstruct(r.segments)).toEqual({
      before: '第一行\n第二行\n第三行',
      after: '第一行\n改过的第二行\n第三行',
    });
    expect(r.segments[0]).toEqual({ type: 'equal', text: '第一行\n' });
    // 相邻同类型 segment 会被合并（渲染需要），因此只断言“新增的词语”被单独标出
    expect(r.segments.some((s) => s.type === 'added' && s.text.includes('改过的'))).toBe(true);
    expect(r.removedChars).toBe(0);
  });
});

describe('computeDiff：reconstruct 性质（任意修改都要能还原两侧）', () => {
  const cases: Array<[string, string]> = [
    ['这是一个测试', '这是一个简单的测试'],
    ['你好，世界。', '你好，世界！'],
    ['中文 mixed English 混排', '中文 Mixed English 混排文本'],
    ['没有变化的部分很长很长，只改一个字：好', '没有变化的部分很长很长，只改一个字：差'],
    ['列表项一\n- 列表项二', '- 列表项一\n- 列表项二'],
    ['**加粗**与`代码`', '**加粗文字**与`代码片段`'],
    ['  缩进前导空格', '缩进前导空格'],
    ['a'.repeat(300), 'a'.repeat(150) + 'b'.repeat(150)],
  ];

  it.each(cases)('reconstruct: %j → %j', (before, after) => {
    const r = computeDiff(before, after);
    expect(reconstruct(r.segments)).toEqual({ before, after });
    expect(r.identical).toBe(false);
    expect(r.removedChars).toBe([...r.segments].filter((s) => s.type === 'removed').reduce((n, s) => n + s.text.length, 0));
    expect(r.addedChars).toBe([...r.segments].filter((s) => s.type === 'added').reduce((n, s) => n + s.text.length, 0));
  });
});

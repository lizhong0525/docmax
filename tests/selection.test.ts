/**
 * 单元测试：选区快照与本地确定性识别 selection.ts
 * 覆盖：块类型识别（标题/列表/引用/代码/表格/hr/html）、CJK 与英文边界、
 * 词数、行中/词中判断、分隔符告警、跨块判断、expandRange、快照 hash 与上下位校验。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeSelection,
  buildRangeSnapshot,
  expandRange,
  fnv1a32,
  isSnapshotFresh,
  lineEndAt,
  lineNumberAt,
  lineStartAt,
} from '../src/core/selection';

const DOC = `# 标题

第一段**加粗**文字。

- 列表项一
- 列表项二

> 引用

\`\`\`js
const a = 1;
\`\`\`

| A | B |
| --- | --- |
| 1 | 2 |
`;

const rangeOf = (s: string, from = 0): [number, number] => {
  const i = DOC.indexOf(s, from);
  if (i < 0) throw new Error(`DOC 中找不到 ${JSON.stringify(s)}`);
  return [i, i + s.length];
};
const analyze = (s: string, from = 0) => {
  const [a, b] = rangeOf(s, from);
  return analyzeSelection(DOC, a, b, 0);
};

describe('行定位函数', () => {
  const doc = 'abc\ndefg\n\nhi';
  it('lineStartAt / lineEndAt / lineNumberAt', () => {
    expect(lineStartAt(doc, 0)).toBe(0);
    expect(lineStartAt(doc, 2)).toBe(0);
    expect(lineStartAt(doc, 4)).toBe(4);
    expect(lineStartAt(doc, 10)).toBe(10);
    // 文档末尾（pos===length）属于最后一个换行之后的行
    expect(lineStartAt(doc, 12)).toBe(10);
    expect(lineEndAt(doc, 0)).toBe(3);
    expect(lineEndAt(doc, 4)).toBe(8);
    expect(lineEndAt(doc, 10)).toBe(12);
    expect(lineEndAt(doc, 12)).toBe(12);
    expect(lineNumberAt(doc, 0)).toBe(1);
    expect(lineNumberAt(doc, 4)).toBe(2);
    expect(lineNumberAt(doc, 9)).toBe(3);
    expect(lineNumberAt(doc, 10)).toBe(4);
    expect(lineNumberAt(doc, 11)).toBe(4);
  });
});

describe('fnv1a32', () => {
  it('空串与固定指纹', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('hello')).not.toBe(fnv1a32('hellO'));
  });

  it('中英文都产生稳定 8 位十六进制指纹', () => {
    expect(fnv1a32('中文选区')).toBe(fnv1a32('中文选区'));
    expect(fnv1a32('中文选区')).not.toBe(fnv1a32('中文选区 '));
    expect(fnv1a32('中文选区')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('analyzeSelection：Markdown 块识别', () => {
  it('标题 → heading', () => {
    const a = analyze('# 标题');
    expect(a.blockKind).toBe('heading');
    expect(a.startsMidLine).toBe(false);
    expect(a.endsMidLine).toBe(false);
    expect(a.chars).toBe(4);
    expect(a.startLine).toBe(1);
    expect(a.endLine).toBe(1);
  });

  it('段落 → paragraph', () => {
    const a = analyze('第一段**加粗**文字。');
    expect(a.blockKind).toBe('paragraph');
    expect(a.startsMidLine).toBe(false);
    expect(a.endsMidLine).toBe(false);
    expect(a.startsMidWord).toBe(false);
    expect(a.endsMidWord).toBe(false);
  });

  it('无序列表 → list', () => {
    expect(analyze('- 列表项一').blockKind).toBe('list');
  });

  it('有序列表 → list', () => {
    const doc = '1. 第一步\n2. 第二步\n';
    const a = analyzeSelection(doc, 0, 8, 0);
    expect(a.blockKind).toBe('list');
  });

  it('引用块 → blockquote', () => {
    expect(analyze('> 引用').blockKind).toBe('blockquote');
  });

  it('代码块内部 → code，并给出来源语言', () => {
    const a = analyze('const a = 1;');
    expect(a.blockKind).toBe('code');
    expect(a.codeFenceLang).toBe('js');
    expect(a.suggestions.some((s) => s.includes('代码块'))).toBe(true);
  });

  it('完整围栏代码块 → code', () => {
    const a = analyze('```js\nconst a = 1;\n```');
    expect(a.blockKind).toBe('code');
    expect(a.codeFenceLang).toBe('js');
    expect(a.lines).toBe(3);
  });

  it('表格表头行 → table', () => {
    expect(analyze('| A | B |').blockKind).toBe('table');
  });

  it('整张表格 → table', () => {
    const a = analyze('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(a.blockKind).toBe('table');
    expect(a.lines).toBe(3);
  });

  it('水平分割线 → hr', () => {
    const doc = '上文\n\n---\n\n下文\n';
    const i = doc.indexOf('---');
    expect(analyzeSelection(doc, i, i + 3, 0).blockKind).toBe('hr');
  });

  it('HTML 块 → html', () => {
    const doc = '<div class="x">内容</div>\n';
    expect(analyzeSelection(doc, 0, doc.trim().length, 0).blockKind).toBe('html');
  });

  it('空选区在空行上 → empty，chars/lines 为 0', () => {
    const doc = '第一段\n\n第二段\n';
    const cursor = doc.indexOf('\n\n') + 1;
    const a = analyzeSelection(doc, cursor, cursor, 0);
    expect(a.chars).toBe(0);
    expect(a.lines).toBe(0);
    expect(a.blockKind).toBe('empty');
    expect(a.words).toBe(0);
  });

  it('空选区在标题行 → heading（插入模式下用于给模型块上下文）', () => {
    const a = analyzeSelection(DOC, 0, 0, 0);
    expect(a.chars).toBe(0);
    expect(a.blockKind).toBe('heading');
  });

  it('跨标题与段落的多块选区 → spansMultipleBlocks=true', () => {
    const doc = '# 标题\n\n正文段落。\n';
    const a = analyzeSelection(doc, 0, doc.length, 0);
    expect(a.spansMultipleBlocks).toBe(true);
    expect(a.startLine).toBe(1);
    expect(a.endLine).toBe(3);
  });

  it('单个段落内选区不跨块', () => {
    const a = analyze('第一段**加粗**文字。');
    expect(a.spansMultipleBlocks).toBe(false);
  });
});

describe('analyzeSelection：frontmatter 识别', () => {
  const FM = `---\ntitle: 我的文档\ntags: [a, b]\n---\n\n正文第一段。\n`;
  const fmEnd = FM.indexOf('\n---\n') + 4;

  it('整段 frontmatter → frontmatter，且不判为跨块', () => {
    const a = analyzeSelection(FM, 0, fmEnd, 0);
    expect(a.blockKind).toBe('frontmatter');
    expect(a.spansMultipleBlocks).toBe(false);
    expect(a.chars).toBe(32);
    expect(a.lines).toBe(4);
    expect(a.startLine).toBe(1);
    expect(a.endLine).toBe(4);
  });

  it('frontmatter 内部单行 → frontmatter', () => {
    const a = analyzeSelection(FM, FM.indexOf('title'), FM.indexOf('tags') - 1, 0);
    expect(a.blockKind).toBe('frontmatter');
    expect(a.startLine).toBe(2);
    expect(a.spansMultipleBlocks).toBe(false);
  });

  it('frontmatter 之后的正文 → paragraph', () => {
    const start = FM.indexOf('正文第一段');
    expect(analyzeSelection(FM, start, start + 6, 0).blockKind).toBe('paragraph');
  });

  it('文档中部的 --- 不误判为 frontmatter（仍是 hr）', () => {
    const doc = '上文\n\n---\n\n下文\n';
    const i = doc.indexOf('---');
    expect(analyzeSelection(doc, i, i + 3, 0).blockKind).toBe('hr');
  });

  it('未闭合的头部 --- 不误判为 frontmatter', () => {
    const doc = '---\n没有闭合\n\n正文\n';
    expect(analyzeSelection(doc, 0, 3, 0).blockKind).toBe('hr');
  });
});

describe('analyzeSelection：表格块内任意行都能识别', () => {
  const TABLE = `| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n`;

  it('整张表格 → table', () => {
    expect(analyzeSelection(TABLE, 0, TABLE.indexOf('\n\nafter'), 0).blockKind).toBe('table');
  });

  it('表格数据行 → table（不是 paragraph）', () => {
    const start = TABLE.indexOf('| 1 | 2 |');
    expect(analyzeSelection(TABLE, start, start + 9, 0).blockKind).toBe('table');
  });

  it('表格最后一行（后面没有分隔行）→ table', () => {
    const doc = '| A |\n| --- |\n| 1 |';
    const start = doc.lastIndexOf('| 1 |');
    expect(analyzeSelection(doc, start, start + 5, 0).blockKind).toBe('table');
  });

  it('表格分隔行位于表格块内部（当前限制：仅选分隔行会被识别为 paragraph）', () => {
    // 已知限制：单独选中分隔行时无法仅凭该行判断所属表格（上/下扫描都不命中分隔行特征）。
    // 整表选择与数据行选择均正确（见上）。这里锁定现状，避免回归为 hr。
    const start = TABLE.indexOf('| --- | --- |');
    expect(analyzeSelection(TABLE, start, start + 13, 0).blockKind).not.toBe('hr');
  });
});

describe('analyzeSelection：代码围栏边界', () => {
  const CODE = '```js\nconst a = 1;\n```\n';

  it('整段围栏（含开头围栏行）→ code 且不判为跨块', () => {
    const a = analyzeSelection(CODE, 0, CODE.indexOf('\n```\n') + 4, 0);
    expect(a.blockKind).toBe('code');
    expect(a.codeFenceLang).toBe('js');
    expect(a.spansMultipleBlocks).toBe(false);
    expect(a.lines).toBe(3);
  });

  it('只选中开头围栏行也识别为 code', () => {
    const a = analyzeSelection(CODE, 0, 5, 0);
    expect(a.blockKind).toBe('code');
  });

  it('围栏内代码行 → code', () => {
    const start = CODE.indexOf('const');
    expect(analyzeSelection(CODE, start, start + 12, 0)).toMatchObject({ blockKind: 'code', codeFenceLang: 'js' });
  });
});

describe('analyzeSelection：CJK / 英文边界判断', () => {
  it('英文单词中间开始/结束', () => {
    const s = 'hello world';
    expect(analyzeSelection(s, 1, 5, 0)).toMatchObject({ startsMidWord: true, endsMidWord: false });
    expect(analyzeSelection(s, 0, 3, 0)).toMatchObject({ startsMidWord: false, endsMidWord: true });
    expect(analyzeSelection(s, 0, 5, 0)).toMatchObject({ startsMidWord: false, endsMidWord: false });
    expect(analyzeSelection(s, 1, 4, 0)).toMatchObject({ startsMidWord: true, endsMidWord: true });
  });

  it('数字与下划线也视为单词字符', () => {
    const s = 'abc123_def';
    expect(analyzeSelection(s, 3, 6, 0)).toMatchObject({ startsMidWord: true, endsMidWord: true });
  });

  it('CJK 字符之间不判为截断单词', () => {
    const s = '这是中文内容';
    expect(analyzeSelection(s, 2, 4, 0)).toMatchObject({ startsMidWord: false, endsMidWord: false });
  });

  it('中英文混排边界：截断英文单词才告警', () => {
    const s = '使用 CodeMirror 编辑器';
    const start = s.indexOf('CodeMirror') + 4; // 词中间
    const a = analyzeSelection(s, start, start + 4, 0);
    expect(a.startsMidWord).toBe(true);
    expect(a.suggestions.some((x) => x.includes('英文单词'))).toBe(true);
  });

  it('行中开始/结束判断', () => {
    const s = 'abc def';
    expect(analyzeSelection(s, 4, 7, 0)).toMatchObject({ startsMidLine: true, endsMidLine: false });
    expect(analyzeSelection(s, 0, 3, 0)).toMatchObject({ startsMidLine: false, endsMidLine: true });
    expect(analyzeSelection(s, 0, 7, 0)).toMatchObject({ startsMidLine: false, endsMidLine: false });
  });
});

describe('analyzeSelection：词数统计', () => {
  it('中文按字计数', () => {
    expect(analyzeSelection('你好世界', 0, 4, 0).words).toBe(4);
  });

  it('英文按词计数', () => {
    expect(analyzeSelection('Hello world', 0, 11, 0).words).toBe(2);
  });

  it('中英混排分别计数', () => {
    expect(analyzeSelection('中文 mixed English 混排', 0, 22, 0).words).toBe(6);
  });

  it('连字符英文视为一个词', () => {
    expect(analyzeSelection('state-of-the-art', 0, 17, 0).words).toBe(1);
  });
});

describe('analyzeSelection：分隔符告警与边界预览', () => {
  it('标记不成对时给出 delimiterWarnings', () => {
    const s = '这里有 **加粗 和 *斜体 与 `代码 和 [链接';
    const a = analyzeSelection(s, 0, s.length, 0);
    expect(a.delimiterWarnings.length).toBeGreaterThanOrEqual(3);
    expect(a.delimiterWarnings.join(' ')).toContain('加粗');
    expect(a.delimiterWarnings.join(' ')).toContain('斜体');
    expect(a.delimiterWarnings.join(' ')).toContain('反引号');
    expect(a.delimiterWarnings.join(' ')).toContain('方括号');
  });

  it('代码块内不检查强调标记', () => {
    const doc = '```\n**not bold** `x`\n```\n';
    const a = analyzeSelection(doc, 4, doc.indexOf('```', 4), 0);
    expect(a.blockKind).toBe('code');
    expect(a.delimiterWarnings).toEqual([]);
  });

  it('boundary 给出前后各最多 12 个字符', () => {
    const a = analyze('第一段**加粗**文字。');
    expect(a.boundary.before).toBe('# 标题\n\n');
    expect(a.boundary.before.length).toBeLessThanOrEqual(12);
    expect(a.boundary.after.length).toBeLessThanOrEqual(12);
    expect(a.boundary.after.startsWith('\n\n- 列表项一')).toBe(true);
  });

  it('越界的 from/to 会被安全钳制', () => {
    const doc = 'abc';
    const a = analyzeSelection(doc, -10, 999, 0);
    expect(a.chars).toBe(3);
    expect(a.startLine).toBe(1);
    expect(a.blockKind).toBe('paragraph');
  });

  it('长选区给出“可考虑局部精准修改”建议', () => {
    const long = '长'.repeat(3001);
    const a = analyzeSelection(long, 0, long.length, 0);
    expect(a.suggestions.some((s) => s.includes('局部精准修改'))).toBe(true);
  });
});

describe('buildRangeSnapshot / isSnapshotFresh', () => {
  const doc = 'l1\nl2 abc def\nl3\n';

  it('快照携带精确原文与指纹', () => {
    const snap = buildRangeSnapshot(doc, { from: 6, to: 9 }, 0, 0);
    expect(snap).toMatchObject({ index: 0, from: 6, to: 9, text: 'abc', anchor: 6, head: 9 });
    expect(snap.hash).toBe(fnv1a32('abc'));
    expect(isSnapshotFresh(doc, snap)).toBe(true);
  });

  it('保留显式 anchor/head', () => {
    const snap = buildRangeSnapshot(doc, { from: 6, to: 9, anchor: 9, head: 6 }, 3, 0);
    expect(snap.anchor).toBe(9);
    expect(snap.head).toBe(6);
    expect(snap.index).toBe(3);
  });

  it('contextChars=0 时上下只取所在行内的内容', () => {
    const snap = buildRangeSnapshot(doc, { from: 6, to: 9 }, 0, 0);
    expect(snap.before).toBe('l2 ');
    expect(snap.after).toBe(' def');
  });

  it('contextChars>0 时按字符数向外扩展（跨行）', () => {
    const snap = buildRangeSnapshot(doc, { from: 6, to: 9 }, 0, 2);
    expect(snap.before).toBe('1\nl2 ');
    expect(snap.after).toBe(' def\nl');
  });

  it('from/to 越界会钳制到文档范围', () => {
    const snap = buildRangeSnapshot('abc', { from: -5, to: 100 }, 0, 10);
    expect(snap).toMatchObject({ from: 0, to: 3, text: 'abc' });
    expect(snap.hash).toBe(fnv1a32('abc'));
  });

  it('isSnapshotFresh：内容变化、越界、from>to 都判为过期', () => {
    const snap = buildRangeSnapshot(doc, { from: 6, to: 9 }, 0, 0);
    expect(isSnapshotFresh('l1\nl2 abc def\nl3\n', snap)).toBe(true);
    expect(isSnapshotFresh('l1\nl2 abX def\nl3\n', snap)).toBe(false);
    expect(isSnapshotFresh('l1\nl2 def\n', snap)).toBe(false);
    expect(isSnapshotFresh(doc, { from: 6, to: 999, text: 'abc' })).toBe(false);
    expect(isSnapshotFresh(doc, { from: 9, to: 6, text: '' })).toBe(false);
  });
});

describe('expandRange：智能扩展选区', () => {
  it('word：扩展到完整单词（含边界）', () => {
    expect(expandRange('hello world', 1, 4, 'word')).toEqual({ from: 0, to: 5 });
    expect(expandRange('hello world', 0, 5, 'word')).toEqual({ from: 0, to: 5 });
    expect(expandRange('hello world', 6, 11, 'word')).toEqual({ from: 6, to: 11 });
  });

  it('line：扩展到整行', () => {
    const doc = 'line one\nline two';
    expect(expandRange(doc, 2, 4, 'line')).toEqual({ from: 0, to: 8 });
  });

  it('paragraph：扩展到空行分隔的整段', () => {
    const doc = '第一段第一行\n第一段第二行\n\n第二段第一行\n\n# 标题\n';
    const start = doc.indexOf('第一段第二') + 2;
    expect(expandRange(doc, start, start + 2, 'paragraph')).toEqual({ from: 0, to: doc.indexOf('\n\n') });
  });

  it('block：列表项扩展到整个列表块', () => {
    const doc = '前言\n\n- 一\n- 二\n- 三\n\n结尾\n';
    const start = doc.indexOf('- 二') + 2;
    const range = expandRange(doc, start, start + 1, 'block');
    expect(doc.slice(range.from, range.to)).toBe('- 一\n- 二\n- 三');
  });

  it('block：标题不会吞掉后续段落', () => {
    const doc = '# 标题\n\n正文段落。\n';
    const start = doc.indexOf('标题');
    expect(expandRange(doc, start, start + 2, 'block')).toEqual({ from: 0, to: doc.indexOf('\n') });
  });

  it('代码块内不做段落扩展（避免破坏围栏）', () => {
    const doc = '```\nline1\nline2\n```\n';
    const start = doc.indexOf('line2');
    expect(expandRange(doc, start, start + 2, 'paragraph')).toEqual({ from: start, to: start + 5 });
  });
});

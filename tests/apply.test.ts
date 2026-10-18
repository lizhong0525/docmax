/**
 * 单元测试：修改校验与应用引擎 apply.ts
 * 覆盖：锚点分层匹配、surgical 应用（重叠/FIND_ALL/找不到/歧义）、
 * 替换净化与结构校验（含 context-leak / length-ratio / 去重）、
 * 提案构建、快照过期与多提案应用、统计。
 */
import { describe, expect, it } from 'vitest';
import {
  applyProposal,
  applyProposals,
  applySurgicalEdits,
  buildProposal,
  computeStats,
  matchAnchor,
  sanitizeReplacement,
  validateReplacement,
  validateRequestSnapshot,
} from '../src/core/apply';
import { analyzeSelection } from '../src/core/selection';
import type { ParseResult } from '../src/core/parse';
import type { EditMode, EditProposal, EditRequest, LocalSelectionAnalysis, RangeSnapshot } from '../src/core/types';

const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
const timings = { startedAt: 0, attempts: 1, repairs: 0 };

function localOf(text: string): LocalSelectionAnalysis {
  return analyzeSelection(text, 0, text.length, 0);
}

function warningCodes(warnings: Array<{ code: string }>): string[] {
  return warnings.map((w) => w.code);
}

/* ------------------------------------------------------------------ */
/* matchAnchor                                                         */
/* ------------------------------------------------------------------ */

describe('matchAnchor：分层锚点匹配', () => {
  it('精确唯一匹配', () => {
    const r = matchAnchor('第一段。我们完成了模块。', '第一段');
    expect(r).toEqual({ ok: true, match: { start: 0, end: 3, strategy: 'exact' } });
  });

  it('精确匹配出现多次 → 歧义，并给出候选行', () => {
    const hay = '第一段。我们完成了模块。\n\n第二段：我们完成了模块。';
    const r = matchAnchor(hay, '我们完成了模块');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('ambiguous');
    expect(r.failure.occurrences).toBe(2);
    expect(r.failure.candidates.length).toBeGreaterThan(0);
    expect(r.failure.candidates[0]).toMatch(/^第 \d+ 行:/);
  });

  it('找不到 → not-found（带相似行候选）', () => {
    const r = matchAnchor('abcdef', '完全不存在的内容');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('not-found');
    expect(r.failure.occurrences).toBe(0);
    expect(r.failure.candidates.length).toBeGreaterThan(0);
  });

  it('空白差异视为等价（flexible-whitespace）', () => {
    const r = matchAnchor('Hello   world\nnext', 'Hello world');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match.strategy).toBe('flexible-whitespace');
    expect('Hello   world\nnext'.slice(r.match.start, r.match.end)).toBe('Hello   world');
  });

  it('中文允许空格差异（去空白匹配）', () => {
    const r = matchAnchor('我们 完成了 编辑器 模块', '我们完成了编辑器模块');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match.strategy).toBe('flexible-whitespace');
    expect(r.match.end - r.match.start).toBe(13);
  });

  it('空白灵活匹配出现多次仍判歧义', () => {
    const r = matchAnchor('a  b\na  b', 'a b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('ambiguous');
  });

  it('行级模糊匹配（少量错字/漏字）', () => {
    const hay = 'The quick brown fox jumps over the lazy dog';
    const r = matchAnchor(hay, 'The quick brown fox jump over the lazy dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match.strategy).toBe('fuzzy-line');
  });

  it('allowFuzzy=false 时不做行级模糊匹配', () => {
    const hay = 'The quick brown fox jumps over the lazy dog';
    const r = matchAnchor(hay, 'The quick brown fox jump over the lazy dog', { allowFuzzy: false });
    expect(r.ok).toBe(false);
  });

  it('模糊匹配存在两个几乎相同候选时拒绝（安全性优先）', () => {
    const hay = '今天天气非常好。\n\n今天天气非常好。';
    const r = matchAnchor(hay, '今天天气非常好了');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.reason).toBe('not-found');
  });

  it('空 FIND 直接判失败，不误匹配', () => {
    const r = matchAnchor('abc', '   ');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.occurrences).toBe(0);
    expect(r.failure.candidates).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* applySurgicalEdits                                                  */
/* ------------------------------------------------------------------ */

describe('applySurgicalEdits', () => {
  const RANGE = 'Alice likes apples. Bob likes apples. Carol likes pears.';

  it('精确替换单个锚点并返回 applied 元信息', () => {
    const r = applySurgicalEdits(RANGE, [{ kind: 'find', find: 'Carol', replace: 'Caroline' }]);
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('Alice likes apples. Bob likes apples. Caroline likes pears.');
    expect(r.applied).toEqual([{ find: 'Carol', replace: 'Caroline', strategy: 'exact', line: 1 }]);
    expect(r.failures).toEqual([]);
  });

  it('多块按位置正确应用（降序替换不破坏坐标）', () => {
    const r = applySurgicalEdits(RANGE, [
      { kind: 'find', find: 'Alice', replace: 'A' },
      { kind: 'find', find: 'pears', replace: 'oranges' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('A likes apples. Bob likes apples. Carol likes oranges.');
    expect(r.applied).toHaveLength(2);
  });

  it('FIND_ALL 替换所有出现位置', () => {
    const r = applySurgicalEdits(RANGE, [{ kind: 'find-all', find: 'likes', replace: 'loves' }]);
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('Alice loves apples. Bob loves apples. Carol loves pears.');
    expect(r.applied).toHaveLength(3);
  });

  it('FIND_ALL 一处都找不到 → not-found', () => {
    const r = applySurgicalEdits(RANGE, [{ kind: 'find-all', find: 'zzz', replace: 'X' }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ kind: 'find-all', reason: 'not-found', occurrences: 0 });
  });

  it('锚点出现多次 → 歧义失败', () => {
    const r = applySurgicalEdits(RANGE, [{ kind: 'find', find: 'likes', replace: 'loves' }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ reason: 'ambiguous', occurrences: 3 });
  });

  it('锚点找不到 → not-found，并带相似行诊断', () => {
    const r = applySurgicalEdits(RANGE, [{ kind: 'find', find: 'Dave', replace: 'D' }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]?.reason).toBe('not-found');
    expect(r.failures[0]?.candidates.length).toBeGreaterThan(0);
  });

  it('两个修改目标重叠 → overlap 失败且不应用任何改动', () => {
    const r = applySurgicalEdits('abcdefgh', [
      { kind: 'find', find: 'abcd', replace: '1' },
      { kind: 'find', find: 'cdef', replace: '2' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.newText).toBe('abcdefgh');
    expect(r.failures[0]?.reason).toBe('overlap');
  });

  it('相邻（不重叠）的两个修改可以应用', () => {
    const r = applySurgicalEdits('abcdefgh', [
      { kind: 'find', find: 'abcd', replace: '1' },
      { kind: 'find', find: 'efgh', replace: '2' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.newText).toBe('12');
  });

  it('多行选区中的行号相对选区起始行计算（1-based）', () => {
    const text = '第一行：旧文字\n第二行：重复内容';
    const r = applySurgicalEdits(text, [{ kind: 'find', find: '重复内容', replace: '新内容' }]);
    expect(r.ok).toBe(true);
    expect(r.applied[0]?.line).toBe(2);
    expect(r.newText).toBe('第一行：旧文字\n第二行：新内容');
  });

  it('空锚点不会匹配整段', () => {
    const r = applySurgicalEdits('abc', [{ kind: 'find', find: '   ', replace: 'x' }]);
    expect(r.ok).toBe(false);
    expect(r.newText).toBe('abc');
  });
});

/* ------------------------------------------------------------------ */
/* sanitizeReplacement                                                 */
/* ------------------------------------------------------------------ */

describe('sanitizeReplacement', () => {
  const paragraph = localOf('原文一段');

  it('剥离模型包裹在外层的代码围栏并给出 info 警告', () => {
    const r = sanitizeReplacement('```markdown\n新内容\n```', '原文一段', paragraph, true);
    expect(r.text).toBe('新内容');
    expect(warningCodes(r.warnings)).toContain('format-sanitized');
  });

  it('剥离“以下是修改后的内容：”前言', () => {
    const r = sanitizeReplacement('以下是修改后的内容：\n新内容', '原文一段', paragraph, true);
    expect(r.text).toBe('新内容');
    expect(r.warnings.some((w) => w.message.includes('前言'))).toBe(true);
  });

  it('sanitize=false 时不剥离，但 CRLF 仍归一化', () => {
    const r = sanitizeReplacement('```\n第一行\r\n第二行\n```', '原文一段', paragraph, false);
    expect(r.text).toBe('```\n第一行\n第二行\n```');
    expect(r.warnings).toEqual([]);
  });

  it('代码块内容不会被误剥围栏', () => {
    const oldCode = '```js\nconst a = 1;\n```';
    const analysis = localOf(oldCode);
    expect(analysis.blockKind).toBe('code');
    const r = sanitizeReplacement('```js\nconst b = 2;\n```', oldCode, analysis, true);
    expect(r.text).toBe('```js\nconst b = 2;\n```');
    expect(r.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* validateReplacement                                                 */
/* ------------------------------------------------------------------ */

describe('validateReplacement：结构校验', () => {
  const para = (text: string, newText: string) => validateReplacement(text, newText, localOf(text), 'rewrite');

  it('没有变化 → no-change info', () => {
    const warnings = para('相同内容', '相同内容');
    expect(warnings).toEqual([expect.objectContaining({ code: 'no-change', severity: 'info' })]);
  });

  it('insert 模式相同文本不算 no-change', () => {
    const warnings = validateReplacement('', '', localOf(''), 'insert');
    expect(warnings).toEqual([]);
  });

  it('清空选区 → empty-result warn', () => {
    expect(para('旧内容', '')).toContainEqual(expect.objectContaining({ code: 'empty-result', severity: 'warn' }));
  });

  it('标题标记丢失 → heading-marker-dropped', () => {
    expect(warningCodes(para('# 标题', '标题'))).toContain('heading-marker-dropped');
  });

  it('列表标记丢失 → list-marker-dropped', () => {
    expect(warningCodes(para('- 项目', '项目'))).toContain('list-marker-dropped');
  });

  it('引用标记丢失 → delimiter-imbalance', () => {
    expect(warningCodes(para('> 引用', '引用'))).toContain('delimiter-imbalance');
  });

  it('表格结构破坏 → table-structure', () => {
    const oldTable = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const analysis = localOf(oldTable);
    expect(analysis.blockKind).toBe('table');
    const warnings = validateReplacement(oldTable, 'a b\n1 2', analysis, 'rewrite');
    expect(warningCodes(warnings)).toContain('table-structure');
  });

  it('奇数代码围栏 → fence-imbalance', () => {
    expect(warningCodes(para('普通文本', '```\ncode'))).toContain('fence-imbalance');
  });

  it('代码选区丢失开头围栏 → fence-imbalance', () => {
    const oldCode = '```js\nconst a = 1;\n```';
    const warnings = validateReplacement(oldCode, 'const a = 1;', localOf(oldCode), 'rewrite');
    expect(warnings.some((w) => w.code === 'fence-imbalance' && w.message.includes('没有围栏'))).toBe(true);
  });

  it('加粗标记不成对 → delimiter-imbalance', () => {
    expect(para('**粗体**', '**粗体')).toContainEqual(expect.objectContaining({ code: 'delimiter-imbalance', message: expect.stringContaining('加粗') }));
  });

  it('行内代码反引号不成对 → delimiter-imbalance', () => {
    expect(para('`code`', '`code')).toContainEqual(expect.objectContaining({ code: 'delimiter-imbalance', message: expect.stringContaining('反引号') }));
  });

  it('行中开头却返回前导空白 → whitespace-boundary', () => {
    const doc = 'abc def';
    const analysis = analyzeSelection(doc, 4, 7, 0);
    expect(analysis.startsMidLine).toBe(true);
    const warnings = validateReplacement('def', ' def', analysis, 'rewrite');
    expect(warningCodes(warnings)).toContain('whitespace-boundary');
  });

  it('选区截断英文单词 → selection-mid-word info', () => {
    const doc = 'hello world';
    const analysis = analyzeSelection(doc, 1, 5, 0);
    const warnings = validateReplacement('ello', 'ello!', analysis, 'rewrite');
    expect(warningCodes(warnings)).toContain('selection-mid-word');
  });

  it('上下文泄漏：替换结果包含选区前文 → context-leak error', () => {
    const before = '前'.repeat(50);
    const after = '后'.repeat(50);
    const oldText = '中间段落文字内容';
    const warnings = validateReplacement(oldText, '中间段落文字内容' + before, localOf(oldText), 'rewrite', { before, after });
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'context-leak', severity: 'error', message: expect.stringContaining('选区之前') }),
    );
  });

  it('上下文泄漏：替换结果包含选区后文 → context-leak error', () => {
    const before = '前'.repeat(50);
    const after = '后'.repeat(50);
    const oldText = '中间段落文字内容';
    const warnings = validateReplacement(oldText, '改后内容' + after, localOf(oldText), 'rewrite', { before, after });
    expect(warnings.some((w) => w.code === 'context-leak' && w.message.includes('选区之后'))).toBe(true);
  });

  it('上下文过短（<40 字符）不触发 context-leak', () => {
    const warnings = validateReplacement('原文', '新文', localOf('原文'), 'rewrite', { before: '短前文', after: '短后文' });
    expect(warningCodes(warnings)).not.toContain('context-leak');
  });

  it('长度比例过大 → length-ratio warn', () => {
    const oldText = '这是一段超过二十个字符的原文内容用于测试长度比例';
    const newText = oldText.repeat(5);
    const warnings = validateReplacement(oldText, newText, localOf(oldText), 'rewrite');
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'length-ratio', severity: 'warn' }));
  });

  it('长度比例极端缩小 → length-ratio warn', () => {
    const oldText = '这是一段超过二十个字符的原文内容用于测试长度比例';
    const warnings = validateReplacement(oldText, '短', localOf(oldText), 'rewrite');
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'length-ratio', severity: 'warn' }));
  });

  it('干净的同长度改写不产生结构警告', () => {
    const oldText = '这段文字需要被润色一下';
    const warnings = validateReplacement(oldText, '这段文字需要被润色一遍', localOf(oldText), 'rewrite');
    expect(warnings.filter((w) => w.severity !== 'info' || w.code === 'length-ratio')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* computeStats                                                        */
/* ------------------------------------------------------------------ */

describe('computeStats', () => {
  it('中文插入一个逗号', () => {
    expect(computeStats('你好世界', '你好，世界')).toEqual({ oldChars: 4, newChars: 5, removedChars: 0, addedChars: 1 });
  });

  it('英文插入一个单词', () => {
    expect(computeStats('hello world', 'hello brave world')).toMatchObject({ oldChars: 11, newChars: 17, removedChars: 0, addedChars: 6 });
  });

  it('从空插入', () => {
    expect(computeStats('', 'abc')).toEqual({ oldChars: 0, newChars: 3, removedChars: 0, addedChars: 3 });
  });

  it('删除内容', () => {
    expect(computeStats('要删掉的内容', '')).toMatchObject({ oldChars: 6, newChars: 0, removedChars: 6, addedChars: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* buildProposal                                                       */
/* ------------------------------------------------------------------ */

const DOC = '第一段原文。\n\n第二段原文。';

function rangeAt(doc: string, from: number, to: number, before = '', after = ''): RangeSnapshot {
  const text = doc.slice(from, to);
  return {
    index: 0,
    from,
    to,
    anchor: from,
    head: to,
    text,
    hash: 'unused',
    before,
    after,
  };
}

function makeRequest(partial: Partial<EditRequest> & { docText: string; from: number; to: number }): EditRequest {
  const { docText, from, to, ...rest } = partial;
  const range = rangeAt(docText, from, to, partial.ranges?.[0]?.before ?? '', partial.ranges?.[0]?.after ?? '');
  return {
    requestId: 'req-1',
    docRev: 1,
    docText,
    docTitle: 'test.md',
    ranges: [range],
    instruction: '修改这段文字',
    options: {
      model: 'deepseek-flash',
      thinking: 'off',
      mode: 'rewrite',
      analysis: true,
      contextChars: 800,
      maxRewriteChars: 4000,
      maxDocumentChars: 20000,
      sanitizeFormat: true,
      language: null,
    },
    ...rest,
  };
}

function parsed(partial: Partial<ParseResult>): ParseResult {
  return {
    analysis: null,
    content: '',
    edits: [],
    answer: '',
    truncated: false,
    missingSentinels: false,
    hasEditBlock: false,
    raw: '',
    issues: [],
    ...partial,
  };
}

function build(
  request: EditRequest,
  parseResult: ParseResult,
  opts: { sanitize?: boolean; allowFuzzy?: boolean } = {},
) {
  const local = analyzeSelection(request.docText, request.ranges[0].from, request.ranges[0].to, 0);
  return buildProposal({
    request,
    parsed: parseResult,
    localAnalyses: [local],
    usage,
    timings,
    sanitize: opts.sanitize ?? true,
    allowFuzzy: opts.allowFuzzy ?? true,
  });
}

describe('buildProposal：rewrite / insert', () => {
  it('rewrite 生成可直接应用的 op', () => {
    const request = makeRequest({ docText: DOC, from: 0, to: 6, options: { ...makeRequest({ docText: DOC, from: 0, to: 6 }).options, mode: 'rewrite' } });
    const { proposal, repair } = build(request, parsed({ content: '改写后的第一段。' }));
    expect(repair).toBeNull();
    expect(proposal).not.toBeNull();
    const op = proposal!.ops[0];
    expect(op).toMatchObject({ rangeId: 0, from: 0, to: 6, oldText: '第一段原文。', newText: '改写后的第一段。', strategy: 'rewrite' });
    expect(op.stats).toMatchObject({ oldChars: 6 });
    expect(proposal).toMatchObject({ mode: 'rewrite', model: 'deepseek-flash', usage, timings });
    expect(proposal!.warnings).toEqual([]);
  });

  it('rewrite 结果与原文一致 → 带 no-change 警告', () => {
    const request = makeRequest({ docText: DOC, from: 0, to: 6 });
    const { proposal } = build(request, parsed({ content: '第一段原文。' }));
    expect(warningCodes(proposal!.warnings)).toContain('no-change');
  });

  it('insert 模式策略为 insert，oldText 为空', () => {
    const request = makeRequest({
      docText: DOC,
      from: 0,
      to: 0,
      options: { ...makeRequest({ docText: DOC, from: 0, to: 0 }).options, mode: 'insert' },
    });
    const { proposal } = build(request, parsed({ content: '插入的开头。' }));
    expect(proposal!.ops[0]).toMatchObject({ from: 0, to: 0, oldText: '', newText: '插入的开头。', strategy: 'insert' });
  });

  it('rewrite 模型外层围栏被净化并记录 info 警告', () => {
    const request = makeRequest({ docText: DOC, from: 0, to: 6 });
    const { proposal } = build(request, parsed({ content: '```\n改写后的第一段。\n```' }));
    expect(proposal!.ops[0].newText).toBe('改写后的第一段。');
    expect(warningCodes(proposal!.warnings)).toContain('format-sanitized');
  });

  it('解析截断 → truncated error 级警告仍返回提案', () => {
    const request = makeRequest({ docText: DOC, from: 0, to: 6 });
    const { proposal } = build(request, parsed({ content: '半截内容', truncated: true }));
    expect(proposal).not.toBeNull();
    expect(proposal!.warnings).toContainEqual(expect.objectContaining({ code: 'truncated', severity: 'error' }));
  });

  it('缺少哨兵标记 → missing-sentinels 警告', () => {
    const request = makeRequest({ docText: DOC, from: 0, to: 6 });
    const { proposal } = build(request, parsed({ content: '改写后的第一段。', missingSentinels: true }));
    expect(warningCodes(proposal!.warnings)).toContain('missing-sentinels');
  });
});

describe('buildProposal：surgical', () => {
  const surgRequest = (from: number, to: number, docText = DOC) =>
    makeRequest({
      docText,
      from,
      to,
      options: { ...makeRequest({ docText, from, to }).options, mode: 'surgical' as EditMode },
    });

  it('锚点命中 → search-replace-exact，输出替换后的选区文本', () => {
    const { proposal, repair } = build(
      surgRequest(0, 6),
      parsed({ edits: [{ kind: 'find', find: '第一段', replace: '首段' }], hasEditBlock: true }),
    );
    expect(repair).toBeNull();
    const op = proposal!.ops[0];
    expect(op.newText).toBe('首段原文。');
    expect(op.strategy).toBe('search-replace-exact');
    expect(op.edits).toEqual([{ find: '第一段', replace: '首段', strategy: 'exact', line: 1 }]);
  });

  it('锚点含糊 → 返回 repair 诊断（anchor-ambiguous），不生成提案', () => {
    const request = surgRequest(0, 6, '重复重复');
    request.ranges[0] = rangeAt('重复重复', 0, 4);
    const { proposal, repair } = build(request, parsed({ edits: [{ kind: 'find', find: '重复', replace: 'X' }], hasEditBlock: true }));
    expect(proposal).toBeNull();
    expect(repair?.reason).toBe('anchor-ambiguous');
    expect(repair?.message).toContain('出现 2 次');
  });

  it('锚点找不到 → repair anchor-not-found，包含相似行诊断', () => {
    const { proposal, repair } = build(
      surgRequest(0, 6),
      parsed({ edits: [{ kind: 'find', find: '完全不存在', replace: 'X' }], hasEditBlock: true }),
    );
    expect(proposal).toBeNull();
    expect(repair?.reason).toBe('anchor-not-found');
    expect(repair?.message).toContain('找不到');
  });

  it('锚点重叠 → repair anchor-overlap', () => {
    const doc = 'abcdefgh';
    const request = surgRequest(0, 8, doc);
    const { proposal, repair } = build(
      request,
      parsed({
        edits: [
          { kind: 'find', find: 'abcd', replace: '1' },
          { kind: 'find', find: 'cdef', replace: '2' },
        ],
        hasEditBlock: true,
      }),
    );
    expect(proposal).toBeNull();
    expect(repair?.reason).toBe('anchor-overlap');
  });

  it('空白灵活匹配的策略标记为 search-replace-flexible', () => {
    const doc = 'alpha   beta';
    const request = surgRequest(0, doc.length, doc);
    const { proposal } = build(request, parsed({ edits: [{ kind: 'find', find: 'alpha beta', replace: 'gamma' }], hasEditBlock: true }));
    expect(proposal!.ops[0].strategy).toBe('search-replace-flexible');
    expect(proposal!.ops[0].newText).toBe('gamma');
  });

  it('行级模糊匹配会在提案中标记 fuzzy-match', () => {
    const doc = 'The quick brown fox jumps over the lazy dog';
    const request = surgRequest(0, doc.length, doc);
    const { proposal } = build(
      request,
      parsed({ edits: [{ kind: 'find', find: 'The quick brown fox jump over the lazy dog', replace: 'New sentence.' }], hasEditBlock: true }),
    );
    expect(proposal!.ops[0].edits?.[0]?.strategy).toBe('fuzzy-line');
    expect(warningCodes(proposal!.warnings)).toContain('fuzzy-match');
  });

  it('没有 FIND 块且内容为空 → unchanged（不删除选区）', () => {
    const { proposal } = build(surgRequest(0, 6), parsed({ hasEditBlock: true }));
    expect(proposal!.ops[0]).toMatchObject({ newText: '第一段原文。', strategy: 'unchanged' });
    expect(warningCodes(proposal!.warnings)).toContain('no-change');
  });

  it('没有 FIND 块但有兜底内容 → fallback-whole-replace + 警告', () => {
    const { proposal } = build(surgRequest(0, 6), parsed({ content: '整段替换文本', hasEditBlock: true }));
    expect(proposal!.ops[0]).toMatchObject({ newText: '整段替换文本', strategy: 'fallback-whole-replace' });
    expect(warningCodes(proposal!.warnings)).toContain('fallback-whole-replace');
  });
});

describe('buildProposal：ask / 警告去重 / 上下文泄漏', () => {
  it('ask 模式不产生 ops，保留回答原文', () => {
    const request = makeRequest({
      docText: DOC,
      from: 0,
      to: 6,
      options: { ...makeRequest({ docText: DOC, from: 0, to: 6 }).options, mode: 'ask' as EditMode },
    });
    const { proposal, repair } = build(request, parsed({ answer: '这段文字在描述第一段。', raw: 'RAW' }));
    expect(repair).toBeNull();
    expect(proposal!.ops).toEqual([]);
    expect(proposal!.mode).toBe('ask');
    expect(proposal!.raw).toBe('RAW');
  });

  it('重复 issue 生成的警告会被去重', () => {
    const request = makeRequest({ docText: DOC, from: 0, to: 6 });
    const { proposal } = build(request, parsed({ content: '改写内容', issues: ['同一诊断', '同一诊断', '另一诊断'] }));
    const others = proposal!.warnings.filter((w) => w.code === 'other');
    expect(others.map((w) => w.message)).toEqual(['同一诊断', '另一诊断']);
  });

  it('替换结果包含上下文 → context-leak error 级警告进入提案', () => {
    const before = '前'.repeat(50);
    const docText = before + DOC;
    const request = makeRequest({
      docText,
      from: before.length,
      to: before.length + 6,
      ranges: [rangeAt(docText, before.length, before.length + 6, before, '')],
    });
    const { proposal } = build(request, parsed({ content: '第一段原文。' + before }));
    expect(proposal!.warnings).toContainEqual(expect.objectContaining({ code: 'context-leak', severity: 'error' }));
  });
});

/* ------------------------------------------------------------------ */
/* applyProposal / applyProposals / validateRequestSnapshot             */
/* ------------------------------------------------------------------ */

function proposalFor(doc: string, from: number, to: number, newText: string, index = 0): EditProposal {
  const range = rangeAt(doc, from, to);
  range.index = index;
  const request: EditRequest = {
    requestId: `req-${index}`,
    docRev: 1,
    docText: doc,
    docTitle: '',
    ranges: [range],
    instruction: 'x',
    options: {
      model: 'deepseek-flash',
      thinking: 'off',
      mode: 'rewrite',
      analysis: true,
      contextChars: 0,
      maxRewriteChars: 4000,
      maxDocumentChars: 20000,
      sanitizeFormat: true,
      language: null,
    },
  };
  const local = analyzeSelection(doc, from, to, 0);
  const result = buildProposal({
    request,
    parsed: parsed({ content: newText }),
    localAnalyses: [local],
    usage,
    timings,
    sanitize: true,
    allowFuzzy: true,
  });
  return result.proposal!;
}

describe('applyProposal / applyProposals', () => {
  it('应用单个提案并返回新文档与替换后范围', () => {
    const p = proposalFor(DOC, 0, 6, '改写后的第一段。');
    const result = applyProposals(DOC, [p]);
    expect(result.ok).toBe(true);
    expect(result.docText).toBe('改写后的第一段。\n\n第二段原文。');
    expect(result.ranges).toEqual([{ from: 0, to: 8 }]);
  });

  it('快照过期（选区内容已变）→ 拒绝应用并给出明确错误', () => {
    const p = proposalFor(DOC, 0, 6, '改写后的第一段。');
    const result = applyProposal('X' + DOC, p);
    expect(result.ok).toBe(false);
    expect(result.docText).toBe('X' + DOC);
    expect(result.error).toContain('选区内容已变化');
  });

  it('偏移越界 → 拒绝应用', () => {
    const p = proposalFor(DOC, 0, 6, '改写');
    const broken: EditProposal = { ...p, ops: [{ ...p.ops[0], from: 500, to: 500, oldText: '' }] };
    const result = applyProposal(DOC, broken);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超出文档范围');
  });

  it('多个提案按位置降序应用，结果正确', () => {
    const p1 = proposalFor(DOC, 0, 6, '第一段改写。', 0);
    const p2 = proposalFor(DOC, 8, 14, '第二段改写。', 1);
    const result = applyProposals(DOC, [p2, p1]);
    expect(result.ok).toBe(true);
    expect(result.docText).toBe('第一段改写。\n\n第二段改写。');
    expect(result.ranges).toHaveLength(2);
  });

  it('多提案区间重叠 → 拒绝应用', () => {
    const p1 = proposalFor(DOC, 0, 6, 'A', 0);
    const p2 = proposalFor(DOC, 0, 6, 'B', 1);
    const result = applyProposals(DOC, [p1, p2]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('重叠');
  });

  it('空选区插入（from===to）可以应用', () => {
    const doc = '插入位置。';
    const p = (() => {
      const range = rangeAt(doc, 0, 0);
      const request: EditRequest = {
        requestId: 'r',
        docRev: 1,
        docText: doc,
        docTitle: '',
        ranges: [range],
        instruction: 'x',
        options: {
          model: 'deepseek-flash',
          thinking: 'off',
          mode: 'insert',
          analysis: true,
          contextChars: 0,
          maxRewriteChars: 4000,
          maxDocumentChars: 20000,
          sanitizeFormat: true,
          language: null,
        },
      };
      return buildProposal({
        request,
        parsed: parsed({ content: '前缀' }),
        localAnalyses: [analyzeSelection(doc, 0, 0, 0)],
        usage,
        timings,
        sanitize: true,
        allowFuzzy: true,
      }).proposal!;
    })();
    const result = applyProposal(doc, p);
    expect(result.ok).toBe(true);
    expect(result.docText).toBe('前缀插入位置。');
  });

  it('ask 提案（无 ops）应用后文档不变', () => {
    const p = proposalFor(DOC, 0, 6, 'x');
    const ask: EditProposal = { ...p, mode: 'ask', ops: [] };
    const result = applyProposal(DOC, ask);
    expect(result).toEqual({ ok: true, docText: DOC, ranges: [] });
  });

  it('文档末尾替换不越界', () => {
    const p = proposalFor(DOC, 8, DOC.length, '结尾改写。');
    const result = applyProposal(DOC, p);
    expect(result.ok).toBe(true);
    expect(result.docText).toBe('第一段原文。\n\n结尾改写。');
  });
});

describe('validateRequestSnapshot', () => {
  it('快照一致 → null', () => {
    const snap = rangeAt(DOC, 0, 6);
    expect(validateRequestSnapshot(DOC, snap)).toBeNull();
  });

  it('内容不一致 → 错误信息', () => {
    const snap = rangeAt(DOC, 0, 6);
    expect(validateRequestSnapshot('X' + DOC, snap)).toBe('选区快照与文档不一致');
  });

  it('范围非法 → 错误信息', () => {
    expect(validateRequestSnapshot(DOC, rangeAt(DOC, 0, 6))).toBeNull();
    expect(validateRequestSnapshot('abc', rangeAt('abc', 2, 2))).toBeNull();
    expect(
      validateRequestSnapshot(DOC, { ...rangeAt(DOC, 0, 6), to: 9999 }),
    ).toBe('选区范围非法');
    expect(validateRequestSnapshot(DOC, { ...rangeAt(DOC, 0, 6), from: 5, to: 2 })).toBe('选区范围非法');
  });
});

/**
 * 单元测试：流式解析器 parse.ts
 *
 * 覆盖：
 *  - 同一段模型输出按任意粒度分块喂入，解析结果必须一致（逐字符 / 随机分块）
 *  - rewrite / insert / ask / surgical 四种模式
 *  - ANALYSIS 可选：缺失、不完整、带围栏 JSON、尾逗号
 *  - 容错：surgical 块缺 <<<END>>>、缺 REPLACE、FIND_ALL、无标记兜底
 *  - 截断语义：finishReason='length' vs 'stop' vs 未知
 *  - nonce 标记（文档碰撞）
 */
import { describe, expect, it } from 'vitest';
import { StreamParser, parseSurgicalBlocks, type ParseResult } from '../src/core/parse';
import { createMarkers, type Markers } from '../src/core/markers';
import type { EditMode } from '../src/core/types';

const markers = createMarkers([]);

const A = '<<<ANALYSIS>>>\n{"kind":"paragraph","language":"zh","summary":"润色"}\n<<<END_ANALYSIS>>>\n';

interface ParseOptions {
  mode: EditMode;
  expectAnalysis?: boolean;
  finishReason?: string | null;
  markers?: Markers;
}

function parseOnce(raw: string, opts: ParseOptions, chunks: number[]): ParseResult {
  const parser = new StreamParser({
    mode: opts.mode,
    markers: opts.markers ?? markers,
    expectAnalysis: opts.expectAnalysis ?? true,
    onDelta: () => {},
    onRaw: () => {},
    onAnalysis: () => {},
  });
  let offset = 0;
  for (const size of chunks) {
    if (offset >= raw.length) break;
    parser.push(raw.slice(offset, offset + size));
    offset += size;
  }
  if (offset < raw.length) parser.push(raw.slice(offset));
  return parser.finish({ finishReason: opts.finishReason });
}

/** 可比较的解析结果（raw 不参与比较，其余全部比较） */
function comparable(r: ParseResult) {
  const { raw: _raw, ...rest } = r;
  return rest;
}

/** 用固定种子生成随机分块大小，保证可重复 */
function seededChunkSizes(length: number, seed: number): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const sizes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    const size = 1 + (next() % 7);
    sizes.push(Math.min(size, remaining));
    remaining -= size;
  }
  return sizes;
}

const CORPUS: Array<{ name: string; raw: string; opts: ParseOptions }> = [
  {
    name: 'rewrite（含 analysis、CJK、多行）',
    raw: `${A}<<<EDIT>>>\n改写后的第一段。\n\n第二段内容保持不变。\n<<<END_EDIT>>>`,
    opts: { mode: 'rewrite', finishReason: 'stop' },
  },
  {
    name: 'insert（空选区插入）',
    raw: `${A}<<<EDIT>>>\n插入的一句话。\n<<<END_EDIT>>>`,
    opts: { mode: 'insert', finishReason: 'stop' },
  },
  {
    name: 'rewrite（不要求 analysis）',
    raw: `<<<EDIT>>>\n普通替换文本 with English words\n<<<END_EDIT>>>`,
    opts: { mode: 'rewrite', expectAnalysis: false, finishReason: 'stop' },
  },
  {
    name: 'rewrite 截断（无 END_EDIT，finishReason=length）',
    raw: `${A}<<<EDIT>>>\n这段输出在半句话处被截`,
    opts: { mode: 'rewrite', finishReason: 'length' },
  },
  {
    name: 'rewrite 无标记兜底',
    raw: `${A}模型直接输出了正文，完全没有标记。`,
    opts: { mode: 'rewrite', finishReason: 'stop' },
  },
  {
    name: 'ask 回答',
    raw: `${A}<<<ANSWER>>>\n这是一个**解释**：选区说的是一段测试。\n<<<END_ANSWER>>>`,
    opts: { mode: 'ask', finishReason: 'stop' },
  },
  {
    name: 'surgical 多个 FIND / FIND_ALL 块',
    raw: `${A}<<<EDIT>>>\n<<<FIND>>>\n提前两个字\n<<<REPLACE>>>\n提前两个词\n<<<END>>>\n<<<FIND_ALL>>>\n模块\n<<<REPLACE>>>\n组件\n<<<END>>>\n<<<END_EDIT>>>`,
    opts: { mode: 'surgical', finishReason: 'stop' },
  },
  {
    name: 'surgical 截断（无 END_EDIT，finishReason=length）',
    raw: `${A}<<<EDIT>>>\n<<<FIND>>>\n旧文字\n<<<REPLACE>>>\n新文字\n<<<END>>>`,
    opts: { mode: 'surgical', finishReason: 'length' },
  },
  {
    name: 'surgical 无标记',
    raw: `${A}完全没有按格式输出。`,
    opts: { mode: 'surgical', finishReason: 'stop' },
  },
  {
    name: 'CRLF 行尾',
    raw: '<<<ANALYSIS>>>\r\n{"kind":"paragraph"}\r\n<<<END_ANALYSIS>>>\r\n<<<EDIT>>>\r\n内容行一\r\n内容行二\r\n<<<END_EDIT>>>',
    opts: { mode: 'rewrite', finishReason: 'stop' },
  },
];

describe('StreamParser：任意分块流式一致性', () => {
  for (const item of CORPUS) {
    it(item.name, () => {
      const baseline = comparable(parseOnce(item.raw, item.opts, [item.raw.length]));
      // 逐字符
      expect(comparable(parseOnce(item.raw, item.opts, new Array(item.raw.length).fill(1)))).toEqual(baseline);
      // 固定小块
      expect(comparable(parseOnce(item.raw, item.opts, new Array(Math.ceil(item.raw.length / 3)).fill(3)))).toEqual(baseline);
      // 随机分块（多组种子）
      for (const seed of [1, 7, 42, 123456]) {
        expect(comparable(parseOnce(item.raw, item.opts, seededChunkSizes(item.raw.length, seed)))).toEqual(baseline);
      }
    });
  }

  it('raw 字段累积完整输出，与分块无关', () => {
    const raw = CORPUS[0].raw;
    const a = parseOnce(raw, CORPUS[0].opts, [raw.length]);
    const b = parseOnce(raw, CORPUS[0].opts, seededChunkSizes(raw.length, 99));
    expect(a.raw).toBe(raw);
    expect(b.raw).toBe(raw);
  });
});

describe('StreamParser：rewrite / insert 基本解析', () => {
  it('rewrite 解析 analysis 与替换内容', () => {
    const r = parseOnce(`${A}<<<EDIT>>>\n你好，世界。\n<<<END_EDIT>>>`, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.analysis).toEqual({ kind: 'paragraph', language: 'zh', summary: '润色' });
    expect(r.content).toBe('你好，世界。');
    expect(r.truncated).toBe(false);
    expect(r.missingSentinels).toBe(false);
    expect(r.edits).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('去掉紧跟 EDIT 标记的一个换行，但保留内容内部换行', () => {
    const r = parseOnce(`${A}<<<EDIT>>>\n第一行\n第二行\n<<<END_EDIT>>>`, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.content).toBe('第一行\n第二行');
  });

  it('onDelta 增量拼接后与 content 一致（去掉首尾各一个换行）', () => {
    const deltas: string[] = [];
    const raw = `${A}<<<EDIT>>>\n流式内容第一段\n\n第二段\n<<<END_EDIT>>>`;
    const parser = new StreamParser({ mode: 'rewrite', markers, expectAnalysis: true, onDelta: (t) => deltas.push(t) });
    for (let i = 0; i < raw.length; i++) parser.push(raw[i]);
    const r = parser.finish({ finishReason: 'stop' });
    expect(deltas.join('')).toBe('流式内容第一段\n\n第二段\n');
    expect(r.content).toBe('流式内容第一段\n\n第二段');
  });

  it('insert 模式与 rewrite 走同一内容通道', () => {
    const r = parseOnce(`${A}<<<EDIT>>>\n插入文字\n<<<END_EDIT>>>`, { mode: 'insert', finishReason: 'stop' }, [1000]);
    expect(r.content).toBe('插入文字');
    expect(r.truncated).toBe(false);
  });

  it('CRLF 输出归一化：内容无多余 \\r', () => {
    const raw = '<<<EDIT>>>\r\n内容行一\r\n内容行二\r\n<<<END_EDIT>>>';
    const r = parseOnce(raw, { mode: 'rewrite', expectAnalysis: false, finishReason: 'stop' }, [2]);
    expect(r.content).toBe('内容行一\r\n内容行二');
    expect(r.truncated).toBe(false);
  });
});

describe('StreamParser：ANALYSIS 可选', () => {
  it('缺少 ANALYSIS 块时仍能解析正文，并给出 issue，不产生 missingSentinels', () => {
    const r = parseOnce('<<<EDIT>>>\n你好\n<<<END_EDIT>>>', { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.content).toBe('你好');
    expect(r.analysis).toBeNull();
    expect(r.missingSentinels).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.issues.some((i) => i.includes('未输出 ANALYSIS'))).toBe(true);
  });

  it('缺少 ANALYSIS 且缺 END_EDIT：finishReason=length 时仍判截断', () => {
    const r = parseOnce('<<<EDIT>>>\n半截内容', { mode: 'rewrite', finishReason: 'length' }, [1000]);
    expect(r.content).toBe('半截内容');
    expect(r.truncated).toBe(true);
  });

  it('ANALYSIS 块不完整（有开始无结束）但有正文时忽略并继续', () => {
    const raw = '<<<ANALYSIS>>>\n{"kind":"parag<<<EDIT>>>\n正文内容\n<<<END_EDIT>>>';
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.content).toBe('正文内容');
    expect(r.analysis).toBeNull();
    expect(r.issues.some((i) => i.includes('ANALYSIS 块不完整'))).toBe(true);
  });

  it('analysis 允许 ```json 围栏', () => {
    const raw = '<<<ANALYSIS>>>\n```json\n{"kind":"list","confidence":0.9}\n```\n<<<END_ANALYSIS>>>\n<<<EDIT>>>\nx\n<<<END_EDIT>>>';
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.analysis).toEqual({ kind: 'list', confidence: 0.9 });
  });

  it('analysis 容忍尾逗号', () => {
    const raw = '<<<ANALYSIS>>>\n{"kind":"table",}\n<<<END_ANALYSIS>>>\n<<<EDIT>>>\nx\n<<<END_EDIT>>>';
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.analysis).toEqual({ kind: 'table' });
  });

  it('analysis 非法 JSON 时保留原文片段而不是崩溃', () => {
    const raw = '<<<ANALYSIS>>>\n不是 JSON\n<<<END_ANALYSIS>>>\n<<<EDIT>>>\nx\n<<<END_EDIT>>>';
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.analysis).toEqual({ raw: '不是 JSON' });
  });

  it('不要求 analysis 时不等待 ANALYSIS 标记（纯内容开头也能立即解析）', () => {
    const raw = '<<<EDIT>>>\n内容\n<<<END_EDIT>>>';
    const r = parseOnce(raw, { mode: 'rewrite', expectAnalysis: false, finishReason: 'stop' }, [1]);
    expect(r.content).toBe('内容');
    expect(r.analysis).toBeNull();
    expect(r.issues).toEqual([]);
  });
});

describe('StreamParser：截断与结束标记语义（finish_reason）', () => {
  const raw = `${A}<<<EDIT>>>\n内容写到一半`;

  it("finishReason='length' → truncated=true（即使有内容）", () => {
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: 'length' }, [1000]);
    expect(r.truncated).toBe(true);
    expect(r.content).toBe('内容写到一半');
  });

  it("finishReason='stop' 且缺 END_EDIT → 视为完整，只给 info issue", () => {
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('内容写到一半');
    expect(r.issues.some((i) => i.includes('自然结束但缺少 END_EDIT'))).toBe(true);
  });

  it('finishReason 未知（null）时保守判为截断', () => {
    const r = parseOnce(raw, { mode: 'rewrite', finishReason: null }, [1000]);
    expect(r.truncated).toBe(true);
  });

  it('缺 END_EDIT 时不丢缓冲区内容', () => {
    const raw2 = `${A}<<<EDIT>>>\n这是一段完整但缺少结束标记的内容，不能丢字。`;
    for (const size of [1, 2, 5, 13]) {
      const r = parseOnce(raw2, { mode: 'rewrite', finishReason: 'length' }, [size]);
      expect(r.content).toBe('这是一段完整但缺少结束标记的内容，不能丢字。');
    }
  });

  it('ask 模式缺 END_ANSWER 的自然结束语义', () => {
    const rawAsk = `${A}<<<ANSWER>>>\n回答写到自然结束`;
    const stopped = parseOnce(rawAsk, { mode: 'ask', finishReason: 'stop' }, [1000]);
    expect(stopped.answer).toBe('回答写到自然结束');
    expect(stopped.truncated).toBe(false);
    const cut = parseOnce(rawAsk, { mode: 'ask', finishReason: 'length' }, [1000]);
    expect(cut.truncated).toBe(true);
  });
});

describe('StreamParser：surgical 容错', () => {
  const surg = (body: string) => `${A}<<<EDIT>>>\n${body}\n<<<END_EDIT>>>`;

  it('正常解析 FIND / FIND_ALL 块', () => {
    const raw = surg(
      '<<<FIND>>>\n旧文字\n<<<REPLACE>>>\n新文字\n<<<END>>>\n<<<FIND_ALL>>>\n重复\n<<<REPLACE>>>\n替换\n<<<END>>>',
    );
    const r = parseOnce(raw, { mode: 'surgical', finishReason: 'stop' }, [1000]);
    expect(r.edits).toEqual([
      { kind: 'find', find: '旧文字', replace: '新文字' },
      { kind: 'find-all', find: '重复', replace: '替换' },
    ]);
    expect(r.hasEditBlock).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.missingSentinels).toBe(false);
  });

  it('FIND 块缺少 <<<END>>> 终止标记时仍能解析', () => {
    const raw = surg('<<<FIND>>>\n旧文字\n<<<REPLACE>>>\n新文字');
    const r = parseOnce(raw, { mode: 'surgical', finishReason: 'stop' }, [2]);
    expect(r.edits).toEqual([{ kind: 'find', find: '旧文字', replace: '新文字' }]);
    expect(r.truncated).toBe(false);
  });

  it('FIND 缺少 REPLACE 标记：跳过该块并报 issue，其余块正常解析', () => {
    const raw = surg('<<<FIND>>>\n旧文字\n<<<FIND>>>\n第二段\n<<<REPLACE>>>\n新文字\n<<<END>>>');
    const r = parseOnce(raw, { mode: 'surgical', finishReason: 'stop' }, [3]);
    expect(r.edits).toEqual([{ kind: 'find', find: '第二段', replace: '新文字' }]);
    expect(r.issues.some((i) => i.includes('缺少 REPLACE'))).toBe(true);
  });

  it('FIND 内容为空时跳过并报 issue', () => {
    const { blocks, issues } = parseSurgicalBlocks('<<<FIND>>>\n<<<REPLACE>>>\nx\n<<<END>>>', markers);
    expect(blocks).toEqual([]);
    expect(issues.some((i) => i.includes('内容为空'))).toBe(true);
  });

  it('多做 FIND 块之间用 END / 下一个 FIND 定界，支持多行替换', () => {
    const { blocks } = parseSurgicalBlocks(
      '\n<<<FIND>>>\n第一行\n第二行\n<<<REPLACE>>>\n新一\n新二\n<<<END>>>\n<<<FIND>>>\n第三处\n<<<REPLACE>>>\n新三\n<<<END>>>\n',
      markers,
    );
    expect(blocks).toEqual([
      { kind: 'find', find: '第一行\n第二行', replace: '新一\n新二' },
      { kind: 'find', find: '第三处', replace: '新三' },
    ]);
  });

  it('surgical 没有 FIND 块但有兜底文本 → content 兜底并给 issue', () => {
    const r = parseOnce(surg('整段替换文本'), { mode: 'surgical', finishReason: 'stop' }, [1000]);
    expect(r.edits).toEqual([]);
    expect(r.content).toBe('整段替换文本');
    expect(r.hasEditBlock).toBe(true);
    expect(r.issues.some((i) => i.includes('未返回 FIND/REPLACE'))).toBe(true);
  });

  it('surgical 空 EDIT 块 → 无内容、无改动、无 missingSentinels', () => {
    const r = parseOnce(surg(''), { mode: 'surgical', finishReason: 'stop' }, [1000]);
    expect(r.edits).toEqual([]);
    expect(r.content).toBe('');
    expect(r.hasEditBlock).toBe(true);
    expect(r.missingSentinels).toBe(false);
  });

  it('surgical 完全无标记 → 兜底 content + missingSentinels', () => {
    const r = parseOnce(`${A}随便输出`, { mode: 'surgical', finishReason: 'stop' }, [1000]);
    expect(r.missingSentinels).toBe(true);
    expect(r.content).toBe('随便输出');
    expect(r.issues.some((i) => i.includes('缺少 EDIT 标记'))).toBe(true);
  });

  it('surgical 缺 END_EDIT：finishReason=length 判截断但保留已解析的块', () => {
    const raw = `${A}<<<EDIT>>>\n<<<FIND>>>\n旧文字\n<<<REPLACE>>>\n新文字\n<<<END>>>`;
    const r = parseOnce(raw, { mode: 'surgical', finishReason: 'length' }, [1]);
    expect(r.edits).toEqual([{ kind: 'find', find: '旧文字', replace: '新文字' }]);
    expect(r.truncated).toBe(true);
  });
});

describe('StreamParser：无标记兜底（rewrite / ask）', () => {
  it('rewrite 完全无标记 → 全文兜底 + missingSentinels + issue', () => {
    const r = parseOnce('模型直接给了正文。', { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.content).toBe('模型直接给了正文。');
    expect(r.missingSentinels).toBe(true);
    expect(r.issues.some((i) => i.includes('缺少 EDIT 标记'))).toBe(true);
  });

  it('ask 完全无标记 → 全文兜底为 answer', () => {
    const r = parseOnce('这是一段解释。', { mode: 'ask', finishReason: 'stop' }, [1000]);
    expect(r.answer).toBe('这是一段解释。');
    expect(r.content).toBe('');
    expect(r.missingSentinels).toBe(true);
  });

  it('空输出 → 所有字段为空且不误报', () => {
    const r = parseOnce('', { mode: 'rewrite', finishReason: 'stop' }, [1]);
    expect(r.content).toBe('');
    expect(r.missingSentinels).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('前置寒暄文本不会进入内容（标记前内容被丢弃）', () => {
    const r = parseOnce(`好的，我来修改。\n${A}<<<EDIT>>>\n正文\n<<<END_EDIT>>>`, { mode: 'rewrite', finishReason: 'stop' }, [1000]);
    expect(r.content).toBe('正文');
    expect(r.missingSentinels).toBe(false);
  });
});

describe('StreamParser：nonce 标记（文档碰撞）', () => {
  const collisionMarkers = createMarkers(['文档里提到 <<<EDIT>>> 和 <<<END_EDIT>>> 标记']);

  it('collision 时使用带随机后缀的标记，且能正确解析对应输出', () => {
    expect(collisionMarkers.nonce).toBeTruthy();
    expect(collisionMarkers.editStart).not.toBe('<<<EDIT>>>');
    expect(collisionMarkers.editStart).toContain(collisionMarkers.nonce!);
    const raw = `${collisionMarkers.editStart}\n新内容\n${collisionMarkers.editEnd}`;
    const r = parseOnce(raw, { mode: 'rewrite', expectAnalysis: false, finishReason: 'stop', markers: collisionMarkers }, [2]);
    expect(r.content).toBe('新内容');
    expect(r.missingSentinels).toBe(false);
  });

  it('nonce 输出中恰好包含默认标记文本时不会被误截断', () => {
    const raw = `${collisionMarkers.editStart}\n内容里可以聊 <<<EDIT>>> 这个话题\n${collisionMarkers.editEnd}`;
    const r = parseOnce(raw, { mode: 'rewrite', expectAnalysis: false, finishReason: 'stop', markers: collisionMarkers }, [1]);
    expect(r.content).toBe('内容里可以聊 <<<EDIT>>> 这个话题');
  });
});

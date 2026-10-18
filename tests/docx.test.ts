/**
 * DOCX → Markdown 转换器单元测试。
 *
 * 夹具由 tests/fixtures/generate_fixtures.py（python-docx）生成并提交，
 * 这里只读二进制，不依赖 Python 运行时。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertDocxToMarkdown, DocxConversionError } from '../server/docx';

const fixture = (name: string): Buffer => readFileSync(resolve('tests/fixtures/docx', name));

describe('convertDocxToMarkdown：基础文档', () => {
  it('标题、段落、粗体、斜体', async () => {
    const result = await convertDocxToMarkdown(fixture('basic.docx'), { fileName: 'basic.docx' });
    expect(result.title).toBe('DocMax 导入测试');
    expect(result.markdown).toContain('# DocMax 导入测试');
    expect(result.markdown).toContain('**粗体文字**');
    expect(result.markdown).toContain('*斜体文字*');
    expect(result.markdown).not.toMatch(/<p>|<strong>|<em>/);
  });

  it('列表：无序与有序都转换为标准 Markdown 标记', async () => {
    const { markdown } = await convertDocxToMarkdown(fixture('basic.docx'));
    expect(markdown).toContain('- 无序列表第一项');
    expect(markdown).toContain('- 无序列表第二项（含粗体）');
    expect(markdown).toMatch(/\n1\. 有序列表第一项/);
    expect(markdown).toMatch(/\n2\. 有序列表第二项/);
    // 不应出现 turndown 偶发的 "-\s{2,}"
    expect(markdown).not.toMatch(/^- {2,}\S/m);
  });

  it('表格：Word 未标记表头时生成空表头且保留全部数据行', async () => {
    const { markdown, stats } = await convertDocxToMarkdown(fixture('basic.docx'));
    expect(stats.tables).toBe(1);
    expect(markdown).toMatch(/\n\|(\s*\|)+\n\|( --- \|)+\n/);
    expect(markdown).toContain('| 姓名 | 角色 | 备注 |');
    expect(markdown).toContain('| 张三 | 产品 | 负责需求 |');
  });

  it('表格：Word 标记了表头行时使用第一行作为表头', async () => {
    const { markdown } = await convertDocxToMarkdown(fixture('table-header.docx'));
    expect(markdown).toContain('| 列 A | 列 B |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| a1 | b1 |');
    expect(markdown).toContain('| a2 | b2 |');
  });

  it('代码块：等宽字体段落 + 软换行转换为围栏代码块', async () => {
    const { markdown, stats } = await convertDocxToMarkdown(fixture('basic.docx'));
    expect(stats.codeBlocks).toBeGreaterThanOrEqual(1);
    expect(markdown).toContain('const answer: number = 42;');
    expect(markdown).toMatch(/```\n[\s\S]*const answer: number = 42;[\s\S]*\n```/);
    expect(markdown).toContain('function add(a: number, b: number) {');
    expect(markdown).toContain('  return a + b;');
  });

  it('引用块与链接', async () => {
    const { markdown } = await convertDocxToMarkdown(fixture('basic.docx'));
    expect(markdown).toContain('> 引用块里的观点：编辑工具不应该打断写作。');
    expect(markdown).toContain('[DeepSeek API 文档](https://api-docs.deepseek.com/)');
  });

  it('标题层级（无 Title 样式）', async () => {
    const { markdown, stats } = await convertDocxToMarkdown(fixture('headings.docx'));
    expect(markdown).toContain('# 一级标题 A');
    expect(markdown).toContain('## 二级标题 A.1');
    expect(markdown).toContain('### 三级标题 A.1.1');
    expect(stats.headings).toBe(3);
  });

  it('统计与结尾换行', async () => {
    const result = await convertDocxToMarkdown(fixture('basic.docx'));
    expect(result.stats.paragraphs).toBeGreaterThan(5);
    expect(result.stats.listItems).toBe(4);
    expect(result.stats.words).toBeGreaterThan(50);
    expect(result.stats.sourceBytes).toBeGreaterThan(1000);
    expect(result.markdown.endsWith('\n')).toBe(true);
    expect(result.markdown).not.toMatch(/\n{3,}/);
  });

  it('两次转换结果确定一致', async () => {
    const a = await convertDocxToMarkdown(fixture('basic.docx'));
    const b = await convertDocxToMarkdown(fixture('basic.docx'));
    expect(a.markdown).toBe(b.markdown);
  });
});

describe('convertDocxToMarkdown：图片占位', () => {
  it('图片不导出二进制，替换为带编号的占位符并给出警告', async () => {
    const result = await convertDocxToMarkdown(fixture('images.docx'), { fileName: 'images.docx' });
    expect(result.stats.images).toBe(2);
    expect(result.markdown).toContain('> [图片占位 1：image/png，未导出图片文件]');
    expect(result.markdown).toContain('> [图片占位 2：image/png，未导出图片文件]');
    expect(result.markdown).not.toContain('data:image');
    expect(result.warnings.some((warning) => warning.code === 'images-placeholder')).toBe(true);
    // 图片前后的文字顺序必须保持
    const previewIndex = result.markdown.indexOf('下面是一张示意图');
    const placeholder1 = result.markdown.indexOf('图片占位 1');
    const captionIndex = result.markdown.indexOf('图片说明：这是图 1');
    expect(previewIndex).toBeGreaterThan(-1);
    expect(placeholder1).toBeGreaterThan(previewIndex);
    expect(captionIndex).toBeGreaterThan(placeholder1);
  });
});

describe('convertDocxToMarkdown：安全与错误处理', () => {
  it('过滤 javascript: 危险链接，保留正常链接', async () => {
    const { markdown } = await convertDocxToMarkdown(fixture('unsafe-link.docx'));
    expect(markdown).not.toContain('javascript:');
    expect(markdown).toContain('恶意链接');
    expect(markdown).toContain('[示例站点](https://example.com/)');
  });

  it('非 zip 文件 → not-docx（HTTP 400）', async () => {
    await expect(convertDocxToMarkdown(Buffer.from('hello world'))).rejects.toMatchObject({
      code: 'not-docx',
      status: 400,
    });
  });

  it('空文件 → empty-document（HTTP 400）', async () => {
    await expect(convertDocxToMarkdown(Buffer.alloc(0))).rejects.toMatchObject({
      code: 'empty-document',
      status: 400,
    });
  });

  it('超过大小上限 → too-large（HTTP 413）', async () => {
    await expect(convertDocxToMarkdown(fixture('basic.docx'), { maxBytes: 100 })).rejects.toMatchObject({
      code: 'too-large',
      status: 413,
    });
  });

  it('空 Word 文档 → empty-document（HTTP 422）', async () => {
    try {
      await convertDocxToMarkdown(fixture('empty.docx'));
      throw new Error('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(DocxConversionError);
      expect((error as DocxConversionError).code).toBe('empty-document');
      expect((error as DocxConversionError).status).toBe(422);
    }
  });
});

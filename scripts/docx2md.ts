/**
 * 独立 CLI：把 .docx 转成 Markdown（不经过模型、不依赖浏览器/服务）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/docx2md.ts input.docx
 *   node node_modules/tsx/dist/cli.mjs scripts/docx2md.ts input.docx -o output.md
 *   node node_modules/tsx/dist/cli.mjs scripts/docx2md.ts input.docx --json
 *
 * 默认输出到 stdout；转换统计与图片占位提示输出到 stderr，方便管道使用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { convertDocxToMarkdown, DocxConversionError } from '../server/docx';

interface CliArgs {
  input?: string;
  output?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--out' || arg === '-o') args.output = argv[++i];
    else if (arg.startsWith('--out=')) args.output = arg.slice('--out='.length);
    else if (!arg.startsWith('-') && !args.input) args.input = arg;
  }
  return args;
}

function usage(): void {
  console.error(`DocMax docx2md —— 把 Word 文档转成 Markdown

用法：
  node node_modules/tsx/dist/cli.mjs scripts/docx2md.ts <input.docx> [选项]

选项：
  -o, --out <file>   写入指定文件（缺省输出到 stdout）
      --json         输出包含统计与警告的 JSON
  -h, --help         显示帮助

说明：图片不会导出，统一替换为可读的占位符（> [图片占位 N：...]）。`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    usage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const inputPath = resolve(args.input);
  let buffer: Buffer;
  try {
    buffer = readFileSync(inputPath);
  } catch (err) {
    console.error(`无法读取文件：${inputPath}（${err instanceof Error ? err.message : String(err)}）`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await convertDocxToMarkdown(buffer, { fileName: basename(inputPath) });
    if (args.json) {
      const payload = JSON.stringify(result, null, 2);
      if (args.output) writeFileSync(resolve(args.output), payload, 'utf8');
      else process.stdout.write(payload + '\n');
    } else if (args.output) {
      const outputPath = resolve(args.output);
      writeFileSync(outputPath, result.markdown, 'utf8');
      console.error(`✅ 已写入 ${outputPath}（${result.stats.markdownChars} 字符）`);
    } else {
      process.stdout.write(result.markdown);
    }
    const stats = result.stats;
    console.error(
      `统计：标题 ${stats.headings} · 段落 ${stats.paragraphs} · 列表项 ${stats.listItems} · 表格 ${stats.tables} · ` +
        `代码块 ${stats.codeBlocks} · 图片 ${stats.images} · ${stats.chars} 字符`,
    );
    for (const warning of result.warnings) console.error(`⚠️  ${warning.message}`);
  } catch (err) {
    if (err instanceof DocxConversionError) {
      console.error(`转换失败（${err.code}）：${err.message}${err.detail ? `\n${err.detail}` : ''}`);
    } else {
      console.error('转换失败：', err);
    }
    process.exitCode = 1;
  }
}

void main();

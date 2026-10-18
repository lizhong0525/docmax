/**
 * 由 README.md 生成 HTML 项目主页（GitHub Pages 入口页）。
 *
 * README 是唯一内容源：改完 README 运行 `pnpm landing`，输出 docs/index.html。
 * 生成时做三件事：
 *  1) 路径改写：docs/screenshots/ → screenshots/（HTML 位于 docs/ 下）；
 *     .md 链接 → GitHub blob URL；
 *  2) 为标题注入 GitHub 风格锚点 id（保证 README 内的 #anchor 与页面一致）；
 *  3) 套用与编辑器一致的编辑部风格模板（纸感、衬线、朱砂强调色、深色模式）。
 *
 * 同时做自检：截图文件必须存在、不允许残留 docs/ 相对图片路径。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { marked } from 'marked';

const ROOT = resolve('.');
const README = resolve('README.md');
const OUT = resolve('docs/index.html');
const REPO = 'lizhong0525/docmax';
const REPO_URL = `https://github.com/${REPO}`;
const BLOB = `https://github.com/${REPO}/blob/main`;
const PAGES_URL = 'https://lizhong0525.github.io/docmax/';

/** GitHub 风格 heading 锚点（空格逐个替换为 -，与 GitHub 生成规则保持一致） */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/** 把 README 中只适合 GitHub 的相对链接改写成 HTML 页面可用的形式 */
function rewriteLinks(markdown: string): string {
  let text = markdown;
  // 图片与文件链接：docs/screenshots/ → screenshots/（页面就在 docs/ 下）
  text = text.replace(/\]\(docs\/screenshots\//g, '](screenshots/');
  // Markdown 文档链接 → GitHub blob
  text = text.replace(/\]\((\.\.\/)?(\.research\/|docs\/)?([A-Za-z0-9_./-]+\.md)(#[^)]+)?\)/g, (match, _up, folder, file, anchor) => {
    const path = `${folder ?? ''}${file}`;
    // 只在非绝对链接时改写
    if (path.startsWith('http')) return match;
    return `](${BLOB}/${path}${anchor ?? ''})`;
  });
  return text;
}

/** 给 h2/h3 注入 GitHub 风格 id，并返回 h2 目录 */
function injectHeadingIds(html: string): { html: string; nav: Array<{ id: string; text: string }> } {
  const nav: Array<{ id: string; text: string }> = [];
  const used = new Map<string, number>();
  const result = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_match, level: string, inner: string) => {
    const text = stripTags(inner);
    const base = slugify(text);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    if (level === '2') nav.push({ id, text });
    return `<h${level} id="${escapeHtml(id)}">${inner}</h${level}>`;
  });
  return { html: result, nav };
}

function build(): void {
  const raw = readFileSync(README, 'utf8');
  // 去掉 README 顶部（标题、徽章、首图），这些由 hero 区呈现；从第一个 ## 开始渲染
  const start = raw.indexOf('\n## ');
  if (start < 0) throw new Error('README 中找不到 "## " 章节');
  const bodyMarkdown = raw.slice(start + 1);
  const rendered = marked.parse(rewriteLinks(bodyMarkdown), { gfm: true, async: false }) as string;
  const { html: bodyHtml, nav } = injectHeadingIds(rendered);

  // 自检：页面引用的截图必须存在
  const missing: string[] = [];
  for (const match of bodyHtml.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const src = match[1];
    if (/^https?:/.test(src)) continue;
    if (!existsSync(resolve('docs', src))) missing.push(src);
  }
  if (missing.length) throw new Error(`页面引用了不存在的图片：${missing.join(', ')}`);
  if (/src="docs\//.test(bodyHtml)) throw new Error('页面中残留 docs/ 相对图片路径，请检查 rewriteLinks');

  const navHtml = nav.map((item) => `<a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a>`).join('\n        ');
  const generatedAt = new Date().toISOString().slice(0, 10);

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="description" content="DocMax：本地运行的极简 Markdown 编辑器，接入 DeepSeek，精确选区识别与替换修改，支持 Word 导入。" />
<title>DocMax · 极简 Markdown 编辑器 · DeepSeek 选区编辑</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231b1a18'/%3E%3Ctext x='16' y='23' font-size='19' text-anchor='middle' fill='%23e8e2d6'%3E%E2%9C%A6%3C/text%3E%3C/svg%3E" />
<style>
  :root {
    --font-ui: 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
    --font-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', SimSun, serif;
    --font-mono: 'Cascadia Mono', Consolas, 'SFMono-Regular', monospace;
    --canvas: #ece8df; --paper: #faf8f2; --paper-deep: #f3efe5;
    --ink: #211f1b; --ink-soft: #3b3832; --muted: #726b5f; --faint: #999183;
    --rule: #d8d0c2; --rule-strong: #c2b8a7;
    --accent: #a8402b; --accent-ink: #8d3524; --accent-soft: #f0e0d8;
    --code-bg: #f1ece1; --code-ink: #3f3a32;
    --shadow: 0 1px 2px rgba(33,31,27,.05); --shadow-lift: 0 18px 42px -18px rgba(33,31,27,.32);
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #121110; --paper: #191816; --paper-deep: #1f1d1a;
      --ink: #e8e2d7; --ink-soft: #d3ccc0; --muted: #9a9285; --faint: #7c7468;
      --rule: #322e28; --rule-strong: #453f36;
      --accent: #d97a5f; --accent-ink: #e4927a; --accent-soft: #33231e;
      --code-bg: #201e1a; --code-ink: #d8d1c3;
      --shadow: 0 1px 2px rgba(0,0,0,.35); --shadow-lift: 0 18px 42px -18px rgba(0,0,0,.7);
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--canvas); color: var(--ink);
    font-family: var(--font-ui); font-size: 16px; line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { color: var(--accent-ink); }
  code, kbd, pre { font-family: var(--font-mono); }
  .top {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 18px;
    padding: 12px clamp(18px, 5vw, 48px);
    background: color-mix(in srgb, var(--paper) 92%, transparent);
    border-bottom: 1px solid var(--rule);
    backdrop-filter: blur(6px);
  }
  .brand {
    font-family: var(--font-serif); font-weight: 600; font-size: 19px;
    color: var(--ink); text-decoration: none; letter-spacing: .01em; white-space: nowrap;
  }
  .brand .mark { color: var(--accent); }
  .top-links { display: flex; gap: 16px; margin-left: auto; flex-wrap: wrap; font-size: 13px; }
  .top-links a { color: var(--muted); text-decoration: none; }
  .top-links a:hover { color: var(--ink); }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 clamp(18px, 5vw, 48px); }
  .hero {
    display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    gap: clamp(28px, 5vw, 64px); align-items: center;
    padding: clamp(40px, 7vw, 88px) 0 clamp(28px, 5vw, 56px);
  }
  .eyebrow {
    margin: 0 0 14px; font-size: 12px; letter-spacing: .18em; text-transform: uppercase;
    color: var(--accent); font-weight: 600;
  }
  .hero h1 {
    margin: 0; font-family: var(--font-serif); font-weight: 600;
    font-size: clamp(44px, 7vw, 76px); line-height: 1.02; letter-spacing: -.01em;
  }
  .lede {
    margin: 18px 0 0; font-family: var(--font-serif);
    font-size: clamp(19px, 2.4vw, 25px); line-height: 1.5; color: var(--ink);
  }
  .sub { margin: 14px 0 0; max-width: 34em; color: var(--muted); font-size: 15px; }
  .cta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 9px 16px; border: 1px solid var(--rule-strong); border-radius: 2px;
    font-size: 13.5px; text-decoration: none; color: var(--ink); background: var(--paper);
    transition: border-color .15s ease, background .15s ease;
  }
  .btn:hover { border-color: var(--ink-soft); color: var(--ink); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff8f2; }
  .btn.primary:hover { background: var(--accent-ink); color: #fff8f2; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 0; padding: 0; list-style: none; }
  .chips li {
    font-size: 12px; color: var(--muted); padding: 3px 10px;
    border: 1px solid var(--rule); border-radius: 999px; background: var(--paper-deep);
  }
  .hero-shot { margin: 0; }
  .hero-shot img {
    display: block; width: 100%; height: auto; border: 1px solid var(--rule-strong);
    border-top: 2px solid var(--accent); border-radius: 2px;
    box-shadow: var(--shadow-lift); background: var(--paper);
  }
  .hero-shot figcaption { margin-top: 10px; font-size: 12px; color: var(--faint); text-align: right; }
  .section-nav {
    display: flex; gap: 6px 14px; flex-wrap: wrap;
    padding: 14px 0 18px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
    font-size: 13px;
  }
  .section-nav a { color: var(--muted); text-decoration: none; white-space: nowrap; }
  .section-nav a:hover { color: var(--accent); }
  .prose { max-width: 860px; margin: 0 auto; padding: clamp(28px, 5vw, 56px) 0 72px; }
  .prose h2 {
    margin: 64px 0 18px; padding-top: 26px; border-top: 1px solid var(--rule);
    font-family: var(--font-serif); font-size: clamp(24px, 3vw, 31px); font-weight: 600; line-height: 1.25;
  }
  .prose h2:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .prose h3 { margin: 34px 0 12px; font-family: var(--font-serif); font-size: 20px; font-weight: 600; }
  .prose p { margin: 14px 0; color: var(--ink-soft); }
  .prose strong { color: var(--ink); }
  .prose ul, .prose ol { padding-left: 1.35em; color: var(--ink-soft); }
  .prose li { margin: 6px 0; }
  .prose li::marker { color: var(--accent); }
  .prose blockquote {
    margin: 20px 0; padding: 10px 18px; border-left: 3px solid var(--accent);
    background: var(--paper-deep); color: var(--muted);
  }
  .prose table {
    width: 100%; border-collapse: collapse; margin: 22px 0; font-size: 14.5px;
    background: var(--paper); border: 1px solid var(--rule);
  }
  .prose th, .prose td { padding: 9px 13px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  .prose th { background: var(--paper-deep); font-weight: 600; color: var(--ink); white-space: nowrap; }
  .prose tr:last-child td { border-bottom: none; }
  .prose code:not(pre code) {
    background: var(--code-bg); color: var(--code-ink); padding: 1px 5px;
    border-radius: 2px; font-size: .9em;
  }
  .prose pre {
    margin: 22px 0; padding: 16px 18px; overflow: auto;
    background: var(--code-bg); border: 1px solid var(--rule); border-radius: 2px;
    font-size: 13px; line-height: 1.7;
  }
  .prose pre code { background: none; padding: 0; }
  .prose img {
    display: block; max-width: 100%; height: auto; margin: 20px auto;
    border: 1px solid var(--rule-strong); border-radius: 2px; background: var(--paper);
    box-shadow: var(--shadow);
  }
  .prose hr { border: none; border-top: 1px solid var(--rule); margin: 40px 0; }
  .prose a { overflow-wrap: anywhere; }
  footer {
    border-top: 1px solid var(--rule); background: var(--paper);
    padding: 30px clamp(18px, 5vw, 48px) 48px;
  }
  footer .inner {
    max-width: 1120px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 10px 26px;
    align-items: baseline; font-size: 13px; color: var(--muted);
  }
  footer a { color: var(--muted); }
  footer .generated { margin-left: auto; color: var(--faint); font-size: 12px; }
  @media (max-width: 860px) {
    .hero { grid-template-columns: minmax(0, 1fr); padding-top: 34px; }
    .hero h1 { font-size: clamp(42px, 12vw, 60px); }
    .prose h2 { scroll-margin-top: 64px; }
    .prose table { display: block; overflow-x: auto; white-space: nowrap; }
  }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
</style>
</head>
<body id="top">
  <header class="top">
    <a class="brand" href="#top"><span class="mark">✦</span> DocMax</a>
    <nav class="top-links" aria-label="页面导航">
      <a href="${REPO_URL}">GitHub</a>
      <a href="#快速开始">快速开始</a>
      <a href="${BLOB}/DESIGN.md">设计说明</a>
      <a href="#验证结果">验证结果</a>
    </nav>
  </header>

  <main class="wrap">
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">Markdown · DeepSeek · Local-first</p>
        <h1>DocMax</h1>
        <p class="lede">把 DeepSeek 变成「只改你选中那段字」的编辑引擎。</p>
        <p class="sub">
          本地运行的极简 Markdown 编辑器：精确选区识别、流式生成、词级 diff 审阅、一步撤销；
          内置 Word 导入（docx → Markdown）。默认配置下一次段落修改约 1 秒、成本约 $0.0002。
        </p>
        <div class="cta">
          <a class="btn primary" href="${REPO_URL}">查看 GitHub 仓库</a>
          <a class="btn" href="#快速开始">快速开始</a>
          <a class="btn" href="${BLOB}/DESIGN.md">设计说明</a>
        </div>
        <ul class="chips">
          <li>Node ≥ 22</li>
          <li>DeepSeek V4.1 Flash</li>
          <li>251 单元测试</li>
          <li>11 E2E</li>
          <li>本地优先</li>
        </ul>
      </div>
      <figure class="hero-shot">
        <img src="screenshots/03-review-diff.png" alt="DocMax 审阅面板：本地识别、模型识别与词级差异" />
        <figcaption>审查每次修改：本地识别 + 模型识别 + 词级 diff</figcaption>
      </figure>
    </section>

    <nav class="section-nav" aria-label="章节">
        ${navHtml}
    </nav>

    <article class="prose">
${bodyHtml}
    </article>
  </main>

  <footer>
    <div class="inner">
      <span>DocMax · 极简 Markdown 编辑器</span>
      <a href="${REPO_URL}">GitHub 仓库</a>
      <a href="${REPO_URL}/issues">问题反馈</a>
      <a href="${PAGES_URL}">GitHub Pages</a>
      <span class="generated">由 README.md 自动生成 · ${generatedAt}</span>
    </div>
  </footer>
</body>
</html>
`;

  writeFileSync(OUT, html, 'utf8');
  console.log(`✅ 已生成 ${OUT}（${(html.length / 1024).toFixed(1)} KB，${nav.length} 个章节，${(bodyHtml.match(/<img/g) ?? []).length} 张图）`);
  console.log(`   预览：直接打开 docs/index.html，或 \`python -m http.server -d docs 8080\` → http://127.0.0.1:8080/`);
}

build();

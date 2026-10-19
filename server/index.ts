/**
 * DocMax 本地服务：一个进程同时提供 API 与前端。
 * - 开发模式（pnpm dev）：Vite middleware 提供 HMR
 * - 生产模式（pnpm start）：服务 dist 静态文件
 */
import express from 'express';
import { join } from 'node:path';
import { config, hasApiKey, PROJECT_ROOT } from './config';
import { handleEdit } from './editRoute';
import { handleWordEdit } from './wordRoute';
import { convertDocxToMarkdown, DocxConversionError } from './docx';
import { publicConfig } from '../src/core/protocol';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: config.version,
    hasApiKey: hasApiKey(),
    model: config.defaultModel,
    mode: config.isProduction ? 'production' : 'development',
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/config', (_req, res) => {
  res.json(publicConfig(hasApiKey(), config.defaultModel));
});

app.post('/api/edit', (req, res) => {
  void handleEdit(req, res);
});

/**
 * Word 插件专用：一次性 JSON 返回（VBA 无法消费 SSE）。
 * 复用 /api/edit 的完整编辑流水线；详细契约见 server/wordRoute.ts。
 */
app.post('/api/word/edit', (req, res) => {
  void handleWordEdit(req, res);
});

const DOCX_MIME = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
];

/**
 * DOCX → Markdown 导入。
 * 请求体为 .docx 原始二进制（application/vnd.openxmlformats-... 或 octet-stream），
 * 文件名通过 query ?name= 传入（仅用于兜底标题与提示）。
 */
app.post('/api/import/docx', express.raw({ type: DOCX_MIME, limit: config.docxMaxBytes }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ code: 'missing-file', error: '缺少 .docx 文件内容（请以二进制方式上传）。' });
      return;
    }
    const fileName = typeof req.query.name === 'string' ? req.query.name : '';
    const result = await convertDocxToMarkdown(req.body, { fileName, maxBytes: config.docxMaxBytes });
    console.log(
      `[docx] ${fileName || '(未命名)'} ${req.body.length}B → ${result.markdown.length} 字符, ` +
        `标题=${result.stats.headings} 表格=${result.stats.tables} 图片=${result.stats.images} 列表项=${result.stats.listItems}`,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof DocxConversionError) {
      res.status(err.status).json({ code: err.code, error: err.message, detail: err.detail });
      return;
    }
    console.error('[docx] 转换异常:', err);
    res.status(500).json({ code: 'internal-error', error: 'docx 转换失败，请稍后重试。' });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ code: 'not-found', error: 'API 不存在' });
});

async function mountFrontend(): Promise<void> {
  if (config.isProduction) {
    const dist = join(PROJECT_ROOT, 'dist');
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      res.sendFile(join(dist, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
    return;
  }
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(PROJECT_ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

// 统一错误处理（JSON 解析失败、请求体超限、处理函数抛错等）
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  const isJsonParseError = err instanceof SyntaxError && (err as SyntaxError & { type?: string }).type === 'entity.parse.failed';
  if (isJsonParseError) {
    if (!res.headersSent) res.status(400).json({ code: 'bad-json', error: '请求体不是合法 JSON。' });
    return;
  }
  if (status === 413) {
    if (!res.headersSent) {
      res.status(413).json({
        code: 'payload-too-large',
        error: `文件超过大小上限（${(config.docxMaxBytes / 1024 / 1024).toFixed(0)} MB）。`,
      });
    }
    return;
  }
  console.error('[server] 未处理的错误:', err);
  if (!res.headersSent) {
    res.status(status >= 400 && status < 600 ? status : 500).json({ code: 'internal-error', error: `服务端错误：${message}` });
  } else if (!res.writableEnded) {
    res.end();
  }
});

await mountFrontend();

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log('');
  console.log('  DocMax · 极简 Markdown 编辑器');
  console.log(`  ${url}`);
  console.log(`  模式: ${config.isProduction ? 'production' : 'development'}   模型: ${config.defaultModel}`);
  console.log(`  API Key: ${hasApiKey() ? '已配置' : '未配置（请在 .env 中设置 DEEPSEEK_API_KEY）'}`);
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用。请设置 PORT 环境变量或关闭占用进程。`);
  } else {
    console.error('[server] 启动失败:', err);
  }
  process.exitCode = 1;
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[server] 收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}

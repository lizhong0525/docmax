/**
 * DocMax 本地服务：一个进程同时提供 API 与前端。
 * - 开发模式（pnpm dev）：Vite middleware 提供 HMR
 * - 生产模式（pnpm start）：服务 dist 静态文件
 */
import express from 'express';
import { join } from 'node:path';
import { config, hasApiKey, PROJECT_ROOT } from './config';
import { handleEdit } from './editRoute';
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

// 统一错误处理（JSON 解析失败、处理函数抛错等）
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[server] 未处理的错误:', err);
  if (!res.headersSent) {
    res.status(500).json({ code: 'internal-error', error: `服务端错误：${message}` });
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

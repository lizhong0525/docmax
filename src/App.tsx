/**
 * UI 入口占位。真正的界面由 UI 模块实现（src/ui/*）。
 * 这个占位文件只保证脚手架可运行，方便并行开发时随时启动服务做接口验证。
 */
import { useEffect, useState } from 'react';

const SAMPLE = `# 欢迎使用 DocMax

这是一个**极简 Markdown 编辑器**，深度接入 DeepSeek 模型。

选中任意文字，按下 ⌘K / Ctrl+K，告诉模型你想怎么改。

- 支持精确选区识别
- 支持差异审阅与一键撤销
`;

export function App() {
  const [health, setHealth] = useState<string>('检查中…');
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => setHealth(data.hasApiKey ? `服务正常 · ${data.model}` : '服务正常 · 未配置 API Key'))
      .catch(() => setHealth('服务未连接'));
  }, []);
  return (
    <main style={{ fontFamily: 'ui-serif, Georgia, serif', maxWidth: 720, margin: '0 auto', padding: 48 }}>
      <h1>DocMax</h1>
      <p style={{ opacity: 0.7 }}>{health}</p>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f4ef', padding: 24, borderRadius: 12 }}>{SAMPLE}</pre>
      <p style={{ opacity: 0.5 }}>界面开发中…</p>
    </main>
  );
}

# DocMax

极简 Markdown 编辑器，把 DeepSeek 变成「只改你选中那段字」的编辑引擎。

选中文字 → 说一句怎么改 → 模型流式返回 → 词级差异审阅 → 接受（一步撤销）/ 放弃。
默认配置下，一次段落修改约 **1 秒**、成本约 **$0.0002**。

```
选中文字  ──►  Ctrl/⌘ K  ──►  「润色这段话，更简洁专业」
                                   │
                                   ▼
              DeepSeek V4.1 Flash（流式，本地服务代理）
                                   │
                                   ▼
      服务端：结构解析 → 校验 → 失败自动修复 → 提案（proposal）
                                   │
                                   ▼
      词级 diff + 分级警告 → 接受（单个事务，Ctrl+Z 一步撤销）/ 放弃
```

## 为什么是它

- **选区精确**：选区以「偏移 + 原文 + 指纹 + 前后文」快照传给模型；应用前再次比对，模型思考期间你继续编辑也不会错位。
- **默认整选区替换**：没有「搜索锚点幻觉」；长选区/机械替换才切换为带分层匹配与唯一性约束的锚点补丁。
- **模型输出永不直接信任**：哨兵协议 + 流式容错解析 + 截断/泄漏/结构校验 + 一次自动修复重试。
- **识别看得见**：本地确定性识别（块类型、代码围栏、词边界、标记平衡）+ 模型识别（kind/language/summary）都展示在界面上。
- **本地优先**：Node 服务持有 API Key，文档不上传第三方；浏览器直接读写本地文件。

设计与工程取舍详见 [DESIGN.md](./DESIGN.md)。

## 快速开始

需要 Node.js ≥ 22（开发时用 Node 24 验证）。

```bash
pnpm install                # 或 npm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
pnpm dev                    # http://127.0.0.1:5199
```

`.env`：

```ini
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com   # 可选
PORT=5199                                    # 可选
DOCMAX_MODEL=deepseek-flash                  # 可选：deepseek-flash | deepseek-v4-pro
```

生产运行：

```bash
pnpm build
pnpm start                  # 服务 dist/ + API，同样一个端口
```

## 使用

- 选中任意文字 → 出现「✦ AI 修改」浮标，或按 `Ctrl/⌘ K`
- 输入指令，或用快捷 chips：润色 / 更简洁 / 扩写 / 缩写 / 改写 / 翻译 / 修正 / 解释
- 审阅面板会显示：模型识别、流式结果、词级 diff、警告（截断、上下文泄漏、结构破坏等）
- `Ctrl/⌘ Enter` 接受，`Esc` 放弃；接受后 `Ctrl/⌘ Z` 一步撤销
- `Ctrl/⌘ O` 打开本地 `.md`，`Ctrl/⌘ S` 保存，`Ctrl/⌘ P` 预览
- 文档自动保存在浏览器 localStorage

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式（Vite HMR + API，单端口） |
| `pnpm start` | 生产模式（需先 `pnpm build`） |
| `pnpm typecheck` | 前端 + 服务端 TypeScript 检查 |
| `pnpm test` | vitest 单元测试（核心解析/匹配/校验/选区） |
| `pnpm eval` | 真实 DeepSeek 端到端评测（需服务已启动），报告输出到 `.research/eval-report.md` |
| `pnpm e2e` | Playwright 浏览器端到端测试（需服务已启动） |
| `node node_modules/tsx/dist/cli.mjs scripts/smoke.ts` | 端到端冒烟（rewrite） |
| `node node_modules/tsx/dist/cli.mjs scripts/smoke-modes.ts` | 端到端冒烟（surgical / insert / ask / no-op） |

## 项目结构

```
src/core/          前后端共享的纯 TS 核心
  types.ts         唯一契约：选区快照、请求/提案、SSE 事件
  selection.ts     选区快照 + 本地确定性识别（块类型/围栏/词边界/标记平衡）
  markers.ts       哨兵标记（含逐请求随机后缀的碰撞/注入防护）
  prompt.ts        系统/用户/修复提示词
  parse.ts         流式容错解析器（rewrite/surgical/ask，处理截断与缺标记）
  apply.ts         分层锚点匹配、结构校验、提案构建、应用前快照校验
  diff.ts          CJK 友好的词级 diff
  protocol.ts      SSE 编码、公开配置
  client.ts        浏览器端 SSE 客户端
server/            Node/Express 服务（唯一持有 API Key 的进程）
  deepseek.ts      DeepSeek 流式客户端 + 错误映射
  editRoute.ts     /api/edit：校验 → 提示词 → 流式 → 校验 → 修复 → 提案
  index.ts         单进程：API + Vite middleware / dist 静态文件
src/ui/            React + CodeMirror 6 界面
tests/             vitest 单元测试
e2e/               Playwright 测试
scripts/           冒烟与评测脚本
```

## 安全与隐私

- API Key 只存在于服务端 `.env`（已 gitignore），不会下发到浏览器；
- 服务默认只监听 `127.0.0.1`；
- 文档内容仅发送给 DeepSeek API，不经过其他第三方；
- 文档内容被视为数据，提示词明确防注入；每请求随机哨兵进一步降低协议伪造风险。

## 验证结果（2026-10-18 实测）

| 项目 | 结果 |
| --- | --- |
| 核心单元测试 | **236 / 236 通过**（解析器任意分块流式一致性、分层锚点匹配、选区识别、diff、客户端 SSE） |
| 真实模型评测 | **30 / 30 通过**（rewrite / surgical / insert / ask；≥4000 字长选区、注入文本、表格/代码/frontmatter、翻译/扩缩写…） |
| 应用安全性 | **选区外零改动率 100%**，提案可应用率 100%，结构校验 100% |
| 延迟 | 总延迟 avg **1.05s** / p50 849ms / p95 2.92s；首字 avg 780ms |
| 成本 | 30 次真实编辑共约 **$0.0038**（缓存命中时，约 $0.00013/次） |
| E2E（真实 Chrome + 真实 DeepSeek） | **7 / 7 通过**：接受 → 文本变化 → Ctrl+Z 精确恢复；拒绝 → 不变；空选区插入；预览；窄屏 |
| UI 验收 | **52 / 52 断言通过**，20 张截图，0 console error / 0 pageerror |

完整数据与可复跑命令见 [`.research/eval-report.md`](.research/eval-report.md)、[`.research/verification-report.md`](.research/verification-report.md)、[`.artifacts/ui-verification.md`](.artifacts/ui-verification.md)。

```powershell
# 单元测试
node node_modules/vitest/vitest.mjs run
# 真实模型评测（需服务已启动，约 40–60s，成本约 $0.004）
node node_modules/tsx/dist/cli.mjs scripts/eval.ts
# Playwright E2E（需服务已启动）
node node_modules/@playwright/test/cli.js test
```

## 已知限制

- 多选区目前逐个串行处理，尚未合并为一次请求；
- surgical 模式遇到选区内大量重复短句时可能触发一次自动修复重试（已有 `FIND_ALL` 支持）；
- 仅针对 DeepSeek Chat Completions 兼容接口实现（模型名可配）；
- 协同编辑 / 云同步未实现（本地优先是有意选择）。

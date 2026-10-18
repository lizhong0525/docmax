# DocMax 编辑器 UI 验收报告

> 本报告由 `.artifacts/ui-verification.md` 复制而来（`.artifacts/` 不入版本库）。
> 关键截图已复制到 `docs/screenshots/`：01-initial.png、02-command-payload.png、03-review-diff.png、04-dark.png、05-narrow-command.png、06-empty-document.png；下文引用的其余原图仍位于本机 `.artifacts/screenshots/`。

- 日期：2026-10-18
- 验收人：ui-dev（UI 负责人）
- 运行环境：Windows / Node v24.19.0 / 本地服务 `http://127.0.0.1:5199`（Lead 的 dev server，未自行启动/重启）
- 浏览器：系统 Chrome（Playwright `chromium.launch({ channel: 'chrome' })`）
- 真实模型：DeepSeek（服务端 `/api/edit`，健康检查返回 `hasApiKey: true`，`model: deepseek-flash`）
- 结论：**52/52 断言通过；5 次真实 DeepSeek 调用全部成功（约 1.07–2.41s）；0 控制台错误、0 pageerror、0 意外页面重载。**

## 1. 复现命令

```powershell
# 类型检查（0 错误）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# UI 真实验收（需要 5199 服务在跑；会真实调用 DeepSeek，约 2–3 分钟）
node .artifacts/ui-verify.mjs
```

- 结果 JSON：`.artifacts/ui-verify-results.json`（逐条断言、真实 AI 耗时、截图清单）
- 截图目录：`.artifacts/screenshots/`（20 张）
- 脚本说明：按独立 section 组织（每个 section 独立浏览器上下文、干净 localStorage）；若 dev server HMR / 服务重启导致页面意外重载，会自动重试该 section。最终一次运行未发生重载。

## 2. 必交截图（(a)–(e) 已全部包含）

| 要求 | 截图 | 说明 |
| --- | --- | --- |
| (a) 空文档初始态 | `.artifacts/screenshots/16-desktop-empty-document.png` | 清空后占位提示「从这里开始写…」、状态栏「全文 0 字 / 0 行 · 光标位置 · 将插入」 |
| (b) 命令条展开态 | `.artifacts/screenshots/04-desktop-command-payload.png`（payload 展开）<br>`.artifacts/screenshots/05-desktop-command-filled.png`（填入指令） | 8 个快捷标签、模型/思考/模式选择、before/selection/after 快照预览、Enter/Shift+Enter/Esc 提示 |
| (c) 审阅面板含 diff | `.artifacts/screenshots/07-desktop-review.png` | 阶段（连接→思考→生成→校验）、本地识别、模型识别、词级删除/新增 diff、token/首字时延、接受/拒绝 |
| (d) 深色模式 | `.artifacts/screenshots/13-desktop-dark.png`<br>`.artifacts/screenshots/14-desktop-preview-dark.png` | 纸感深色（#121110 canvas / #191816 paper）、衬线正文、单一朱砂强调色 |
| (e) 窄屏 <600px | `.artifacts/screenshots/17-narrow-initial.png`<br>`.artifacts/screenshots/18-narrow-selection.png`<br>`.artifacts/screenshots/19-narrow-command.png`<br>`.artifacts/screenshots/20-narrow-review.png` | 480×900：无横向溢出、指令条全宽、审阅面板全宽 |

### 全部截图

| 文件 | 内容 |
| --- | --- |
| `01-desktop-initial.png` | 桌面 1440×900 初始态（示例文档） |
| `02-desktop-selection.png` | 键盘选中中文段落：选区高亮 + 浮动「✦ AI 修改」+ 状态栏识别 |
| `03-desktop-selection-detail.png` | 「识别详情」popover：字符/词/行、块类型、边界、完整单词、标记成对、扩展选区 |
| `04-desktop-command-payload.png` | Ctrl+K 指令条 + 发送前 payload 快照展开 |
| `05-desktop-command-filled.png` | 「润色」标签填入指令，自动模式解析为「整体重写」 |
| `06-desktop-streaming.png` | 真实流式生成中（面板已出现、接受未就绪） |
| `07-desktop-review.png` | 审阅态：diff + 本地识别 + 模型识别 + token |
| `08-desktop-accepted.png` | 接受后：文档已变、光标在替换末尾、toast「已应用修改 · Ctrl+Z 可撤销」 |
| `09-desktop-undo.png` | 一次 Ctrl+Z 后完全恢复原文 |
| `10-desktop-rejected.png` | 拒绝后文档不变 + toast「已拒绝，文档未修改」 |
| `11-desktop-stale.png` | 生成期间改文档 → 「提案已过期」横幅 + 接受被禁用（改为重新生成） |
| `12-desktop-ask.png` | ask 解释模式：Markdown 渲染的回答、复制回答、无接受/拒绝按钮 |
| `13-desktop-dark.png` | 深色模式 |
| `14-desktop-preview-dark.png` | 深色模式 + Ctrl+P Markdown 预览（标题/表格/引用/代码块） |
| `15-desktop-help.png` | Ctrl+/ 快捷键帮助 |
| `16-desktop-empty-document.png` | 空文档初始态 |
| `17-narrow-initial.png` | 480×900 初始态 |
| `18-narrow-selection.png` | 窄屏键盘选中 + 状态栏 |
| `19-narrow-command.png` | 窄屏指令条全宽（480px 占满） |
| `20-narrow-review.png` | 窄屏审阅（全宽）→ 拒绝后文本不变 |

## 3. 真实 DeepSeek 修改测试结果

| # | 场景 | 结果 | 端到端耗时 |
| --- | --- | --- | --- |
| 1 | 选中中文段落（42 字）→ Ctrl+K →「润色」→ 接受 | 生成成功；diff 2 处删除 / 2 处新增（如「待」→「待在」，「应该待」→「应该待在」）；接受后文本变化；**一次 Ctrl+Z 精确恢复原文**；光标落在替换末尾 | 1116 ms |
| 2 | 同上 →「更简洁」→ 拒绝 | 生成成功；拒绝后文档逐字不变；面板关闭并提示 | 1086 ms |
| 3 | 同上 →「润色」→ 生成期间在选区内插入「测」 | 自动标记「提案已过期」；接受按钮被替换为「重新生成」；重新生成基于当前选区发起新请求；撤销测试输入后恢复原文 | 1188 ms |
| 4 | 同上 →「解释」（ask 模式） | 流式回答 + Markdown 渲染；不出现接受/拒绝；「复制回答」「完成」可用；关闭后文档不变 | 2411 ms |
| 5 | 窄屏 480×900：选中列表项 →「润色」→ 拒绝 | 生成成功、审阅面板全宽不溢出、拒绝后文档不变 | 1072 ms |

关键断言（全部 PASS）：

- 选区识别：状态栏显示 `第 3 行 / 42 字 / 30 词 / 段落`；识别详情含 `块类型 / 完整单词 / Markdown 标记成对`。
- payload：真实发送前可见 `BEFORE / SELECTION / AFTER` 与 8 位快照 `hash`。
- 审阅：本地识别（确定性）与模型识别（`kind/language/summary`）分区展示；词级 diff 同时含删除与新增；显示 `tokens / 首字延迟`。
- 接受：文档变化、提示可撤销、光标移动；单次 `Ctrl+Z` 完全恢复（单个 CodeMirror transaction）。
- 拒绝：文档不变、面板关闭。
- 过期：文档被改动后自动标记过期，禁止直接接受；快照校验在 `applyProposals` 内再次逐字比对。
- ask：只显示回答，无接受/拒绝。
- 外观：深色切换生效（body 背景 `rgb(236,232,223) → rgb(18,17,16)`）；Ctrl+P 预览含 `<h1>/<table>`；Esc 关闭帮助。
- 无障碍：所有可见 `<button>` 都有可访问名称。
- 环境：0 控制台错误、0 pageerror、0 意外重载。

## 4. 需求对照（task-1 第 1–10 条）

| # | 需求 | 实现要点 |
| --- | --- | --- |
| 1 | 极简 Markdown 编辑器 | CodeMirror 6：`markdown()` 高亮 + 行内历史 undo/redo + `indentWithTab`；衬线正文、列宽居中、纸面卡片；light/dark；无渐变/玻璃态 |
| 2 | 选区识别展示 | 状态栏实时字符/词/行/块类型/代码围栏/截断单词/标记不平衡徽标；「识别详情」popover 含边界预览、检查项、建议、扩选（整词/整行/整段/整块）；指令条内可展开 payload before/selection/after 截断预览 + hash |
| 3 | 指令入口 | 选中后浮动「✦ AI 修改」；Ctrl/⌘+K 底部指令条；8 个 chips（润色/更简洁/扩写/缩写/改写/翻译/修正/解释）；模型 Flash/V4 Pro、思考 off/low/high、模式 自动/整体重写/局部精准修改；Enter 提交、Shift+Enter 换行、Esc 关闭；IME 组合输入时 Enter 不误提交 |
| 4 | 流式请求与审阅 | 使用 `core/client.streamEdit`；阶段条（连接/思考/生成/校验/修复 + 尝试次数）；流式文本、reasoning（可折叠）、模型识别、`analysis` 事件；完成后 `computeDiff` 词级 diff；warnings 按 info/warn/error 分级（error 红色，需二次确认）；no-change 禁止接受 |
| 5 | 应用与撤销 | 请求开始时用 `buildRangeSnapshot` 锁定快照；流式期间**零文档 dispatch**；接受前 `applyProposals` 逐字校验（失败提示「文档已变化，请重新生成」并显示过期横幅）；单个 transaction 应用所有 changes + selection，光标移到替换末尾，一次 Ctrl+Z 完整回滚；IME 组合期间拒绝接受；预览等非编辑 dispatch 不存在（未使用预览 decoration，避免历史污染） |
| 6 | 多选区 | CM6 `selection.ranges` 全量上报；主选区优先、其余按文档顺序**串行**逐个请求；审阅区合并展示多处提案；接受时一个 transaction 应用全部；explain/ask 只处理主选区并在 UI 说明。旧实现中若只处理主选区会明确提示（当前实现已覆盖多选区，提示语在状态栏「已选 N 处 · 主选区优先，逐个处理」） |
| 7 | 文件 | Ctrl+O：File System Access API（Chrome/Edge），失败/取消回退 `<input type=file>`；Ctrl+S 有 handle 原地写、否则 showSaveFilePicker/下载；Ctrl+Shift+S 另存；标题可编辑；localStorage 自动保存（600ms 防抖）+ 首次示例文档；打开新文件时 `setState` 重建文档并清空历史（避免 Ctrl+Z 回到上一份文档） |
| 8 | 预览 | Ctrl+P 切换 marked + DOMPurify 渲染；标题/列表/引用/表格/代码块样式干净；与编辑区同源文档 |
| 9 | 快捷键 | Ctrl/⌘+K 指令、Ctrl+Enter 接受、Ctrl+Z 撤销、Esc 取消/关闭/中止生成、Ctrl+O/S/Shift+S/P、Ctrl+/ 帮助；非编辑焦点时 Ctrl+Z 自动聚焦编辑器后再撤销 |
| 10 | 无障碍与响应式 | 所有按钮 aria-label；`:focus-visible` 统一 2px 强调色 outline；`aria-live` 播报生成状态与 toast；窄屏（≤640px）指令条/审阅面板全宽，`prefers-reduced-motion` 降级动画；480×900 实测无横向溢出 |

## 5. 设计说明（编辑部气质）

- 色板：纸感浅色 `canvas #ECE8DF / paper #FAF8F2 / ink #211F1B`，深色 `#121110 / #191816 / #E8E2D7`；单一朱砂强调色 `#A8402B`（深色 `#D97A5F`）。
- 字体：UI 用系统无衬线（Segoe UI / 微软雅黑），正文用衬线（Iowan/Palatino/Georgia + 宋体回退），元数据用等宽（Cascadia/Consolas），形成「稿纸 + 校样」的编辑部气质。
- 签名元素：右侧「校样栏」——审阅面板用细线分隔、等宽眉题、朱砂标记；diff 采用删除线（红）与下划线（朱砂）模拟校对符号。
- 无渐变、无玻璃态、无 AI 紫；所有动效克制（面板 180ms 进入、光标闪烁），并尊重 reduced-motion。

## 6. 已知限制与说明

1. **truncated / error 级警告二次确认**：代码路径已实现（`severity === 'error'` 首次点击只进入确认态、按钮变「确认接受」，并显示红色提示），但服务端真实调用未产生截断输出，自动化用例无法稳定触发，故未纳入 e2e 断言。
2. **多选区**：已实现「主选区优先 + 串行请求 + 合并审阅 + 单 transaction 应用」，但 Playwright 中构造 CM6 多 ranges 的可靠性一般，未纳入自动化断言（单选区主链路已充分验证）。
3. **文件打开/保存**：File System Access 需要真实用户手势与原生文件选择框，无法在 headless e2e 中自动化；代码路径（打开、原地保存、另存、下载兜底、权限失败回退）已实现，未做自动化断言。
4. **长文档压力**：未做 >2 万字性能压测；当前实现选择分析为 O(doc) 并在选区/文档更新时 rAF 合并，预览与统计有 220ms 防抖，自动保存 600ms 防抖，未观察到卡顿。
5. **Ctrl+Z 语义**：接受修改是单个 transaction，一次 Ctrl+Z 完整回滚；打开新文件会主动清空 undo 历史（这是有意设计，避免跨文档撤销）。
6. 验收期间未修改 `src/core/**`、`server/**`、`package.json`、`tsconfig*`、`vite.config.ts`；未执行任何 `pnpm install/add`；未做 git commit；未重启/停止 Lead 的 5199 服务。
7. 截图与结果中的界面时间戳来自测试当天，示例文本由首次打开的内置示例文档提供；验收脚本每个 section 使用干净 localStorage，因此互不污染。

## 7. 交付文件

- 界面代码：`src/ui/**`（15 个文件：编辑器封装/主题/选区状态/指令条/审阅面板/diff/预览/文件 IO/帮助/图标/类型/工具/session hook/示例文档/labels）
- 入口与样式：`src/App.tsx`、`src/styles.css`、`src/main.tsx`（未改 core/server）
- 验收脚本：`.artifacts/ui-verify.mjs`；结果：`.artifacts/ui-verify-results.json`；截图：`.artifacts/screenshots/`


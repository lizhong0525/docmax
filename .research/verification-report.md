# DocMax 验证报告（阶段 1–4）

- 验证人：verifier（task-2）
- 时间：2026-10-18（Asia/Singapore）
- 环境：Windows / Node 24.19.0 / TypeScript 5.9.3 / vitest 5.0.5 / @playwright/test 1.64.1（channel: chrome）
- 服务：Lead 管理的 DocMax dev server `http://127.0.0.1:5199`（真实 DeepSeek，API Key 已配置；验证过程未直连 DeepSeek API、未读取 `.env`）
- 结论：**三个阶段全部通过**。单元测试 236/236、真实模型评测 30/30（连跑两轮稳定）、Playwright E2E 7/7、tsc 两个配置均 0 错误。

---

## 一、验证总览

| 阶段 | 内容 | 结果 | 命令（可直接复现） |
| --- | --- | --- | --- |
| 1 | 核心引擎单元测试（8 个测试文件） | **236 passed / 236**，退出码 0 | `node node_modules/vitest/vitest.mjs run` |
| 2 | 真实模型评测（30 用例，SSE 经本地服务） | **30 passed / 30（100%）**，两轮一致 | `node node_modules/tsx/dist/cli.mjs scripts/eval.ts` |
| 3 | Playwright E2E（真实浏览器 + 真实模型） | **7 passed / 7**，退出码 0 | `node node_modules/@playwright/test/cli.js test` |
| 4 | 类型检查 | `tsc -p tsconfig.json` 与 `tsc -p tsconfig.server.json` 均 0 错误 | 见下 |

```powershell
# 类型检查（两个项目都在 package.json 的 typecheck 里）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit        # src（UI + core）
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit # server/scripts/tests/core
```

测试配置：
- `vitest.config.ts`：node 环境，只收集 `tests/**/*.test.ts`（排除 `e2e/**`，避免 vitest 误跑 Playwright 用例）。
- `playwright.config.ts`：不配置 `webServer`（复用 5199），`channel: 'chrome'`，单 worker 串行，JSON 结果写 `.artifacts/e2e-results.json`。

---

## 二、阶段 1：核心单元测试（236 用例）

全部测试真实调用 `src/core/**` 源码，未 mock 核心逻辑（仅 `tests/client.test.ts` 在 fetch 边界做网络桩，用于验证 SSE 分帧/错误分支）。

| 文件 | 用例数 | 覆盖要点 |
| --- | --- | --- |
| `tests/parse.test.ts` | 43 | 任意分块（逐字符/固定块/4 组随机种子）流式一致性；rewrite/insert/ask/surgical；缺 ANALYSIS、ANALYSIS 不完整、analysis 围栏 JSON/尾逗号/非法 JSON；缺 `<<<END>>>`、缺 REPLACE、FIND_ALL、空 FIND；无标记兜底；`finishReason='length'/'stop'/null` 截断语义；缺 END 不丢缓冲区；nonce 标记解析与默认标记文本共存 |
| `tests/apply.test.ts` | 75 | matchAnchor 分层（精确/空白灵活/去空白/行级模糊/歧义/多义/空锚点）；applySurgicalEdits（多块、FIND_ALL、找不到、歧义、重叠、相邻、行号）；sanitizeReplacement；validateReplacement 全部 warning（含 context-leak、length-ratio、白空格边界、截断单词）；buildProposal（rewrite/surgical/ask、repair 诊断 anchor-not-found/ambiguous/overlap、警告去重）；applyProposal/applyProposals（快照过期、越界、重叠、多提案、空选区插入、ask 无 ops）；computeStats；validateRequestSnapshot |
| `tests/selection.test.ts` | 56 | 行定位；fnv1a32；块识别（heading/list/blockquote/code/table/hr/html/frontmatter/empty）；表格数据行与整表；代码围栏整段/内部/开头行；`startsMidWord/endsMidWord/startsMidLine/endsMidLine`；CJK/英文词数；分隔符告警；boundary；越界钳制；`buildRangeSnapshot` 上下文与 hash；`isSnapshotFresh`；`expandRange` word/line/paragraph/block（含代码块内不扩展） |
| `tests/diff.test.ts` | 18 | 相同/空文本；中文词级（不再整句替换）、英文词级、emoji、中文标点、中英混排、多行换行 token、行首列表标记新增；reconstruct 性质（equal+removed==before、equal+added==after）与字符统计 |
| `tests/client.test.ts` | 14 | true SSE 客户端：事件分发、跨 chunk 分帧（7 字节切片 + ping）、proposal/answer 聚合、请求体透传、error 事件、HTTP 500/409、网络异常、流中断保留已收事件、空流、HTML 502 可读错误、fetchHealth/fetchConfig |
| `tests/markers.test.ts` | 18 | 默认标记、10 种默认标记碰撞均生成 nonce 标记、两次 nonce 不同；stripOuterNewlines/stripAnalysisBlock/stripWrapperFence 边界 |
| `tests/protocol.test.ts` | 12 | SSE 编码格式、ping 注释、模型/限制常量、publicConfig |

---

## 三、阶段 2：真实模型评测（30 用例，100% 通过）

详细指标与逐用例表格见 [`eval-report.md`](./eval-report.md)，原始数据见 [`.artifacts/eval-results.json`](../.artifacts/eval-results.json)。本节只摘录关键结论。

### 3.1 指标（第二轮，最终状态）

| 指标 | 数值 |
| --- | --- |
| 用例 / 通过 | 30 / **30（100%）** |
| 提案成功率 / 可应用率 | 100% / 100% |
| **选区外零改动率** | **100%** |
| 结构校验通过率 / 语义期望通过率 | 100% / 100% |
| 自动修复（repairs） | 0 例（本轮未触发；修复路径由单测覆盖） |
| 截断提案 / 评测层重试 | 0 / 0 |
| 总延迟 avg / p50 / p95 / max | **1.10s / 971ms / 2.68s / 3.76s** |
| 首字延迟 avg / p50 / p95 | **833ms / 826ms / 1.05s** |
| tokens（prompt/completion/total） | 42,321 / 3,125 / 45,446 |
| prompt cache | hit 37,120 / miss 5,201（**命中率 87.7%**） |
| 估算成本 | **$0.0038 总 / $0.00013 每例** |

按模式：rewrite 22 例（avg 1.04s，p95 1.35s）、surgical 5 例（avg 1.07s）、ask 2 例（avg 1.99s）、insert 1 例（730ms）。v4-pro + thinking low 单例总延迟 5.38s（首字 911ms），显著慢于 flash；长选区（6100 字）surgical 1.16s / rewrite 1.55s。

**prompt cache 的实测价值**：首轮（服务刚重启、cache 冷）hit 12,672 / 42,321（29.9%），估算成本 $0.0100；第二轮（cache 热）hit 37,120（87.7%），估算成本 $0.0038 —— 同一套用例成本差 2.6 倍。报告中的成本按用户给定的输入/输出单价假设（可用 `DOCMAX_PRICE_*` 覆盖），仅作趋势参考。

### 3.2 用例覆盖（全部真实调用本地服务）

段落润色、行内半句、列表块、标题、无需修改（no-change）、提示词注入（选中文本内藏“忽略以上指令”→ 输出未含注入 payload）、中译英/英译中、扩写、缩写、emoji+中文标点、英文润色、英文行内片段、代码块修复（围栏语义保持）、表格改写（行数/`|` 结构）、surgical 单处最小修改、surgical FIND_ALL、**surgical 长选区 6100 字错别字修复**、**rewrite 超长选区长文压缩**、空选区插入、模糊指令、surgical 歧义锚点（第二处同名短语）、surgical 引号规范化、frontmatter 字段、引用块、v4-pro+thinking、ask 解释段落、ask 解释代码、英文拼写纠错、中文引号/省略号规范化。

### 3.3 评测端校验方法（不是“看模型输出像不像”）

1. 用 `src/core/apply.ts` 的 `applyProposal` 在**评测端独立**再次校验快照并应用；比较应用后文档的 `[0, op.from)` 与 `(op.from+newText.length, …)` 是否与原文逐字一致 → 选区外零改动率。
2. 用 `analyzeSelection` 的块类型做**确定性结构校验**：标题标记不得丢失、列表标记不得丢失、表格每行必须含 `|`、代码围栏奇偶/不得包裹非代码选区、frontmatter 必须保留 YAML 键、行内片段不得返回换行。
3. 用例级语义期望：包含/不包含串、变更幅度（扩写变长、缩写 ≤60 字、长选区压缩 <50%、错别字数量下降等）。
4. 可重试错误（5xx/流中断）记录事件序列后重试一次；本轮未触发。
5. 失败会保留事件序列、warnings、attempts/repairs、原始输出片段到 JSON 与报告第五节；本轮无失败案例。

---

## 四、阶段 3：Playwright E2E（7/7 通过，11.7s）

全部用例打开真实页面、真实输入/键盘操作、真实提交到 5199（服务端调用真实 DeepSeek），串行执行。

| # | 用例 | 断言要点 | 耗时 |
| --- | --- | --- | --- |
| 1 | 页面加载 / 健康 / 编辑器可用 | 品牌标题、`DeepSeek 就绪`、编辑器与状态栏可见、键盘输入后字数更新、无资源 404 控制台错误 | 759ms |
| 2 | 预览切换 | `toggle-preview` → `preview` 渲染 `h1`；返回编辑 | 909ms |
| 3 | 选区识别状态栏 | 三击选中整行 → 状态栏含字符数与「段落」；打开「识别详情」popover 含块类型 | 744ms |
| 4 | **接受 → 文本变化 → Ctrl+Z 恢复** | 真实 AI 提案 → `diff`/「词级差异」可见 → 接受后面板关闭、首行被替换、第二段与结尾换行逐字不变 → 点编辑器后 Ctrl+Z **精确恢复**到请求前全文 | 2.1s |
| 5 | **拒绝 → 文档不变** | 真实提案 → 点「拒绝」→ 编辑器文本与请求前完全一致 | 2.5s |
| 6 | **空选区插入** | Ctrl+End + Ctrl+K（命令条提示「在光标处插入」）→ 真实插入 → 接受后文档变长、原文前缀不变 → Ctrl+Z 精确恢复 | 2.6s |
| 7 | 窄屏响应式 | 520px 视口下 Ctrl+K 命令条可见且宽度 >460px，截图留档，Esc/取消可关闭 | 1.1s |

关键交互细节（已固化为测试）：命令条打开**不能先点击编辑器**（会折叠三击选区）；接受后 Ctrl+Z 前需先点编辑器让 CodeMirror 取得焦点；模型判定「无需修改」时接受按钮 disabled（`无需修改`），E2E 因此使用明显需要润色的文本并在 `waitForProposal` 等待按钮可点。

### 截图（`.artifacts/`）

| 文件 | 内容 |
| --- | --- |
| `e2e-load-desktop.png` | 桌面首屏（1440×900，整页） |
| `e2e-selection-status.png` | 键盘选中整行后的状态栏识别信息 |
| `e2e-selection-detail.png` | 「识别详情」popover |
| `e2e-review.png` | 真实模型返回后的审阅面板（词级 diff、选区识别、warnings） |
| `e2e-accepted.png` | 接受修改后的文档 |
| `e2e-undo-restored.png` | Ctrl+Z 恢复后的文档 |
| `e2e-insert-review.png` | 空选区插入的审阅面板 |
| `e2e-preview.png` | Markdown 预览 |
| `e2e-narrow-command.png` | 520px 窄屏命令条 |

运行原始日志：`.artifacts/e2e-run.log`；JSON 结果：`.artifacts/e2e-results.json`（stats：expected 7 / unexpected 0 / flaky 0）。

---

## 五、验证中发现并已修复的核心问题（时间线）

| # | 问题 | 最小复现 | 状态 |
| --- | --- | --- | --- |
| 1 | `StreamParser` 在 `expectAnalysis=true` 但模型未输出 ANALYSIS 块时永远停在 analysis 相位：`finish()` 把整段 raw（含 `<<<EDIT>>>` 标记）当 content 兜底、且无法判截断 | `new StreamParser({mode:'rewrite',expectAnalysis:true,...})` push `<<<EDIT>>>\n你好\n<<<END_EDIT>>>` → content 含标记而非 `你好` | 已由 Lead 修复（ANALYSIS 可选、正文先到即切换、不完整块忽略），`tests/parse.test.ts`「ANALYSIS 可选」组已覆盖 |
| 2 | `diff.ts` 中文整行退化成 1 个 token → 词级 diff 变成整句红绿 | `computeDiff('这是一个测试','这是一个简单的测试')` 曾输出整段 removed/added | 已修复（每个 Segmenter segment 独立 token），现输出 equal'这是一个'+added'简单的'+equal'测试' |
| 3 | `selection.ts` 缺 frontmatter 块识别（`BlockKind` 有该类型但从不返回） | 文档头部 `---…---` 整段选中曾是 'hr'，单行曾是 'paragraph' | 已修复（`frontmatterRange`），单测已覆盖整段/单行/正文/未闭合场景 |
| 4 | 表格数据行识别为 paragraph | 表格第 3 行 `\| 1 \| 2 \|` 曾返回 paragraph | 已修复（上下扫描同表格块），单测覆盖数据行/最后一行/分隔行不误判 hr |
| 5 | 整段代码围栏选中被误报 `spansMultipleBlocks=true` | 选中含开头 ```js 的整段围栏 | 已修复，单测覆盖 `spansMultipleBlocks=false` |

验证过程中另修正了**测试自身**的问题（非产品 bug）：`openCommandBar` 点击编辑器会折叠选区、E2E 曾用过于“完美”的文本导致模型返回 no-change、行定位断言对文档末尾语义写错等，均已修正。

---

## 六、已知限制与风险

1. **已修复（报告定稿后由 Lead 修复）**：仅选中表格分隔行（`| --- | --- |` 单独一行）时 `blockKind` 曾为 `paragraph`；现已在线识别中特判为 `table`（整表/数据行此前已正确），`tests/selection.test.ts` 保留“非 hr”断言防回归。
2. **真实模型评测的固有波动**：30 用例连跑两轮均 100%，但单例延迟/prompt cache 命中率受网络、缓存状态影响波动明显（两轮成本差 2.6 倍）；`deepseek-v4-pro` 只覆盖 1 例。
3. **自动修复路径未被真实模型触发**：本轮 30 例均一次通过（0 repairs）。repair 分支（anchor-not-found/ambiguous/overlap + 二次生成）由 `tests/apply.test.ts` 的 buildProposal 单测覆盖，但“真实模型收到 repair 提示后能否改对”缺少真实样本，属剩余风险。
4. **模糊锚点路径**在真实评测中未被显著触发（模型基本逐字复制 FIND）；`matchAnchor` 的空白灵活/去空白/行级模糊/歧义安全拒绝均由单测覆盖。
5. **E2E 依赖真实模型输出语义**：接受路径要求模型确实给出修改（选用了明显有问题的文本）；若未来模型行为变化给出 no-change，测试会以“accept 不可用”失败而不是误报通过。E2E 通过 `.cm-line` 读取编辑器可见行，仅适用于短文档（当前 E2E 文档均 ≤4 行）。
6. **成本估算为假设价目**：输入 cache-miss $0.28/M、cache-hit $0.028/M、输出 $0.42/M（可用 `DOCMAX_PRICE_*` 覆盖），非 DeepSeek 实际账单。
7. **验证范围**：未做视觉像素级回归、未做文件打开/保存（File System Access API）与多选区 E2E；这些不在 task-2 验收清单内（UI 任务由 ui-dev/Lead 负责）。
8. **环境事件记录**：20:44 左右 node_modules/.pnpm 被清空，起因是我误运行了一次 `pnpm exec tsx …`（pnpm 触发重装并清理 modules 目录）；已即时报告 Lead 并恢复。此后所有命令一律用 `node node_modules/...` 二进制、不再运行任何 pnpm 命令。评测数字均来自恢复后的正常环境。

---

## 七、可重复运行清单

```powershell
# 0）前置：5199 服务健康（Lead 管理，勿自行启动/停止）
#    期望返回 {"ok":true,"hasApiKey":true,...}

# 1）单元测试（约 0.3s）
node node_modules/vitest/vitest.mjs run

# 2）真实模型评测（约 40-60s，30 次真实请求，成本约 $0.004）
node node_modules/tsx/dist/cli.mjs scripts/eval.ts
# 只看用例、不调模型：
node node_modules/tsx/dist/cli.mjs scripts/eval.ts --dry
# 只跑部分用例：
node node_modules/tsx/dist/cli.mjs scripts/eval.ts --only=1,18,19

# 3）E2E（约 12s，含 3 次真实模型调用；需要 Chrome + 5199）
node node_modules/@playwright/test/cli.js test

# 4）类型检查
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
```

产物：`.research/eval-report.md`、`.research/verification-report.md`、`.artifacts/eval-results.json`、`.artifacts/e2e-results.json`、`.artifacts/e2e-*.png`、`.artifacts/unit-tests.log`、`.artifacts/e2e-run.log`。

---

## 八、验收结论

对照 task-2 验收标准：

- [x] 阶段 1：parse/apply/selection/diff（及 markers/protocol/client）单测覆盖全部指定场景，真实调用源码，**236/236 全绿**。
- [x] 阶段 2：`scripts/eval.ts` 经 5199 跑 **30 个真实模型用例**（覆盖任务清单全部场景，含 >4000 字长选区、注入、空选区、ask、超长选区、歧义锚点），用 `apply.ts` 验证可应用 + 选区外零改动 + 结构校验；输出报告与 JSON，指标含成功率/零改动率/p50/p95/首字延迟/修复率/token/成本；**30/30 通过**，未为通过率放宽 prompt 或改写指令。
- [x] 阶段 3：`playwright.config.ts` 不配 webServer、复用 5199、channel chrome；**7/7 E2E 通过**（接受→变化、Ctrl+Z→精确恢复、拒绝→不变、空选区插入、预览、状态栏识别、窄屏），截图齐全。
- [x] 阶段 4：本报告；未修改 `src/**`、`server/**`、`package.json`；发现的问题均以最小复现报给 Lead 并由 Lead 修复，未自行改核心代码。
- [x] 未读取 `.env`、未直连 DeepSeek API、未启动/停止 5199 服务、未执行 git commit。

---

## 九、Lead 复跑记录（报告定稿后）

- 21:06 重启 5199 加载最终代码后完整复跑：
  - `tsc -p tsconfig.json` / `tsc -p tsconfig.server.json`：均 0 错误
  - vitest：**236 passed**
  - `scripts/api-check.ts`：API 契约自检全部通过（非法 JSON/空指令/哈希不符/过期快照/多选区/超大文档/模式归一化/中止）
  - `scripts/eval.ts`：**30/30（100%）**，选区外零改动率 100%，延迟 avg 1.05s / p50 849ms / p95 2.92s，首字 avg 780ms，成本 $0.0038（cache 命中 36,992）
  - Playwright E2E：**7/7 passed**（13.3s，真实 DeepSeek）
  - 生产构建：`vite build` 成功，`pnpm start` 生产模式页面与 API 冒烟通过
- 报告定稿后的唯一产品修正：单独的表格分隔行 `blockKind` → `table`（见第六节第 1 条）。
- 报告定稿后新增功能「DOCX → Markdown 导入」：新增 15 个转换器单测（总单测 251）、4 个 docx E2E（总 E2E 11）、API 自检 7 项；实现与设计见 [README](../README.md#从-word-导入docx--markdown) 与 [DESIGN](../DESIGN.md#7-docx--markdown-导入)。


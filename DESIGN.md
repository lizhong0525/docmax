# DocMax · 设计说明

> 一个本地运行的极简 Markdown 编辑器，把 DeepSeek 变成「只改你选中那段字」的编辑引擎。
> 本文说明为什么这样选载体、为什么用这套编辑协议，以及每一步如何保证「模型不可能改错地方」。

---

## 1. 目标拆解

用户的需求可以拆成三层，难度递增：

| 层级 | 要求 | 真正难的地方 |
| --- | --- | --- |
| L1 | 接入 DeepSeek 的 Markdown 编辑器 | 基本工程：编辑、保存、预览、流式 |
| L2 | **最完善的模型文字选择识别** | 让模型准确知道「哪段字被选中、边界在哪、它是什么结构」，且用户能看见模型看到的东西 |
| L3 | **替换修改** | 把模型输出**安全、精确、可审阅、可撤销**地写回**恰好那个区间**，失败可诊断可修复 |

绝大多数「AI 编辑器」停留在 L1+L2 的一半：让模型返回一段文本，然后整段替换或猜位置。DocMax 的设计重点在 L2/L3 的工程化：

- 选区以**快照 + 指纹**传输，模型耗时期间用户改了文档也不会错位；
- 默认**整选区替换**（无锚点可幻觉），大选区/机械修改才用**锚点补丁**（有分层匹配与唯一性约束）；
- 模型输出永远视为**不可信输入**，必须通过结构解析 → 校验 → 修复重试才能变成「提案」；
- 提案先审阅（词级 diff + 分级警告），接受时**一次事务应用 = 一步撤销**；
- 模型「识别」被拆成两层：**本地确定性识别**（块类型、代码围栏、英文词边界、Markdown 标记平衡）+ **模型结构化识别**（analysis JSON），两者都展示给用户。

---

## 2. 载体选择：为什么是「本地 Web 应用」

候选方案与结论：

| 载体 | 优点 | 致命缺点 | 结论 |
| --- | --- | --- | --- |
| 纯网页 SaaS | 跨平台 | API Key 必须放云端或暴露在浏览器；文档要上传 | ❌ 隐私与密钥风险 |
| 桌面应用（Electron/Tauri） | 文件系统体验好 | 打包/分发/升级成本高；核心能力与网页版相同 | ❌ 收益不抵成本 |
| DeepSeek Harness 插件 | 与宿主集成 | 绑定特定 Agent 环境，换机器/换场景不可用 | ❌ 耦合过深 |
| **本地 Web 应用（Node 服务 + 浏览器 UI）** | 一条命令启动；浏览器就是 UI；服务端持有 API Key；直接读写本地文件（File System Access API）；CodeMirror 6 提供工业级选区/事务/撤销模型；可用 Playwright 做真实端到端验证 | 需要本机有 Node | ✅ **采用** |

架构：

```
浏览器 (React 19 + CodeMirror 6)
   │  /api/edit  (POST + SSE，本地回环)
   ▼
Node 服务 (Express 5)
   ├─ 请求校验 / 选区快照校验 / 限额
   ├─ 本地选区识别（确定性）
   ├─ 提示词构建（哨兵协议）
   ├─ DeepSeek 流式调用（OpenAI 兼容）
   ├─ 流式解析 → 校验 → 修复重试 → 提案
   └─ Vite（开发 HMR）/ dist 静态文件（生产）
```

一个**单进程**同时提供 API 与前端：`pnpm dev` 开发、`pnpm start` 生产，没有端口代理，没有额外服务。

---

## 3. 核心协议：选区 → 模型 → 可安全应用的提案

### 3.1 选区快照（Selection Snapshot）

```ts
{ from, to,          // UTF-16 偏移（与 CodeMirror 一致）
  text,              // doc.slice(from, to) 原文
  hash,              // fnv1a32(text) 指纹
  before, after }    // 按整行扩展的前后文（默认各 800 字符）
```

安全属性：

1. 服务端收到请求先校验 `docText.slice(from,to) === text` 与指纹；
2. 模型返回后，客户端在应用前**再次**用 `applyProposal()` 比对文档原文，不一致就报「文档已变化，请重新生成」；
3. 因此「模型思考期间用户继续编辑」不会造成错位覆盖——这是 AI 编辑器最常见的严重 bug 之一。

### 3.2 提示词：把边界变成机器可验证的事实

每条用户消息包含（顺序兼顾 KV cache：稳定的文档在前，易变的选区/指令在后）：

```
<document>…（≤20k 字符发全文，否则发标题大纲）…</document>
<selection_meta>{行号范围、文档总长、选区长度}</selection_meta>
<local_analysis>{块类型、是否代码块、是否截断英文词、标记不平衡…}</local_analysis>
<before>…只读上下文…</before>
<selection>…精确选区原文…</selection>
<after>…只读上下文…</after>
<instruction>…用户指令…</instruction>
```

- `before/after` 解决了「选中半句话/半个词」时替换必须与上下文自然衔接的问题；
- `local_analysis` 是**本地确定性识别**的结果，模型不用猜「这是什么块、是不是代码」；
- 文档内容明确声明为**数据而非指令**，配合每请求随机后缀哨兵，降低文档内容伪造协议标记的注入风险。

### 3.3 输出协议：哨兵包裹 + 结构化识别

```
<<<ANALYSIS>>>
{"kind":"paragraph","language":"zh","summary":"润色本周进展段落，保持原意"}
<<<END_ANALYSIS>>>
<<<EDIT>>>
（替换整个选区的新文本；surgical 模式下为多个 FIND/REPLACE 块）
<<<END_EDIT>>>
```

- 哨兵由 `<<<…>>>` 组成，普通 Markdown 文档几乎不可能自然出现；一旦检测到文档/指令中包含哨兵，就为本请求生成**带随机后缀的哨兵**（`<<<EDIT:7f3a>>>`），解析器随之切换；
- `ANALYSIS` 让模型先「说出它识别到了什么」，UI 展示给用户，也用于发现模型误解选区；
- 流式解析器（`src/core/parse.ts`）**不假设输出完美**：允许缺失结束标记、多写前言、包裹代码围栏、完全不用标记；所有异常都变成结构化标记（`truncated` / `missingSentinels` / `issues`），交给下一层处理，绝不静默应用半截内容。

### 3.4 两种编辑模式（研究结论 + 实测选择）

| 模式 | 何时用 | 应用可靠性 | 流式体验 | 成本 |
| --- | --- | --- | --- | --- |
| **rewrite**（整选区替换，默认） | 选区 ≤ 4000 字符、润色/改写/翻译/扩写/缩写/修正 | **100% 精确**：替换区间由程序确定，模型没有「找位置」的机会 | 好（边生成边展示） | 输出 ≈ 选区大小 |
| **surgical**（选区内 FIND/REPLACE 锚点补丁） | 长选区（>4000 字符）、机械替换（“把所有 X 改成 Y”）、只改局部 | 依赖锚点匹配，但有分层匹配 + 唯一性约束 + 修复重试 | 一般（整段生成后解析） | 输出小，延迟低 |

这一选择有明确的外部证据支持：Aider 的实验显示模型对行号/ diff 运算很不可靠，而基于「整段重写」的 whole-file 格式正确率最高；search/replace 的失败集中在空白、引号、换行漂移。对本产品来说，选区通常只有一两段话，**整段替换没有任何锚点风险**，是最优默认；只有当选区大到重写不划算时，锚点补丁的收益才超过其风险。

surgical 的锚点匹配是**分层**的，绝不「第一次匹配就应用」：

1. 精确匹配（选区内唯一）；
2. 空白灵活匹配（`\s+` 归一）；
3. 去掉全部空白后匹配（处理 CJK 空格插入/删除，带坐标映射）；
4. 行级相似度模糊匹配（Dice 相似度 ≥ 0.86，且与第二候选差距 ≥ 0.05，否则判歧义）；
5. 任何出现多次的锚点都判**歧义**，不猜；
6. 多个块重叠 → 拒绝；
7. 全部失败 → 把「精确诊断 + 选区内相似行」送回模型做一次**修复重试**（实测长表格/重复行场景下一次修复即可成功）。

### 3.5 校验阶梯（模型输出 → 提案）

`src/core/apply.ts` 在生成提案前逐项检查：

| 检查 | 处理 |
| --- | --- |
| 传输 `finish_reason` | `length` = 截断（error 级警告，必须用户显式确认）；`content_filter`/资源不足 = 直接报错 |
| 哨兵/结构 | 缺失则兜底 + 警告；截断不允许静默应用 |
| 代码围栏策略 | 仅当选区本身不是代码块时剥离模型包裹的围栏；代码选区保留围栏内容 |
| 上下文泄漏 | 替换结果包含 ≥40 字符的 before/after 原文 → **error**（防「贴心地」把上下文带回来造成重复） |
| 空结果 / 无改动 | 警告；无改动禁用「接受」 |
| Markdown 结构 | 标题/列表/引用标记丢失、表格行无 `|`、围栏/加粗/行内代码不成对 → 警告 |
| 边界 | 行中选区、英文词中间截断 → 提示拼接正确性 |
| 长度比例 | 与原文比例异常（>4× 或 <0.15×）→ 警告 |

### 3.6 审阅与撤销

- 流式文本只存在于 UI 状态，**绝不 dispatch 文档变更**（避免 Ctrl+Z 逐 token 回退）；
- 完成后展示词级 diff（中文用 `Intl.Segmenter` 分词，空白/换行/标点单独成 token）；
- 接受 = 一个 CodeMirror transaction（changes + selection），因此 **Ctrl+Z 一步撤销**；
- 请求发起时锁定选区快照；若期间文档被修改，应用前校验失败 → 提示重新生成。

---

## 4. DeepSeek 接入细节（2026-10 实测）

| 项目 | 取值 | 依据 |
| --- | --- | --- |
| 模型 | `deepseek-flash`（默认，V4.1-Flash）/ `deepseek-v4-pro`（更强） | `GET /models` + 官方文档 |
| 上下文 / 输出上限 | 1M / 384K | 同上 |
| 思考模式 | 默认**开启**且 effort=high；编辑器默认 `thinking:{type:"disabled"}`，可切 low/high/max | 官方 thinking mode 文档 + 实测（开启后首字延迟 3–7s） |
| 流式 | SSE，`content` 与 `reasoning_content` 分离，末块带 `usage`（`stream_options.include_usage`） | 实测 |
| 参数 | thinking 模式忽略 temperature；`max_tokens` 自适应（≈选区长度 × 1.25，下限 1024） | 官方文档 + 实测 |

实测延迟（本机，真实网络）：

| 配置 | 首字 | 总耗时 | 备注 |
| --- | --- | --- | --- |
| flash + 思考关闭 | 0.5–0.8s | 0.8–1.3s | 默认配置，段落级编辑 |
| flash + effort low | 0.5–1.2s | 1.0–1.5s | 质量略升，偶尔有推理 token |
| v4-pro + effort low | 3–7s | 3–7s | 「深度模式」，复杂改写 |
| 服务端端到端（含校验/提案） | ~0.6s | **0.9–1.1s** | 925 prompt + 77 completion tokens |

成本（flash 非高峰）：约 `$0.15/M` 输入 + `$0.6/M` 输出；一次段落润色 ≈ 1000 tokens ≈ **$0.0002**，可忽略不计，**延迟才是约束**。

### 评估过但未采用的方案

- **Prefix completion + stop 序列**（`/beta`，assistant 前缀强制输出、stop 终止）：实测可用且 thinking 关闭/低都正常（首字 100–280ms、总耗时 0.7–1.5s），能消除前言。但没有采用，原因：
  1. 它要求「无 ANALYSIS 块」的单一输出流，与本产品的模型识别展示冲突；
  2. stop 命中与模型自然结束都表现为 `finish_reason:"stop"`，无法区分「完整」与「忘记结束标记」，会和现有截断检测语义打架；
  3. 它是 Beta 接口，而 envelope 协议实测格式遵循率 100%，解析器已能容忍前言/围栏/缺标记。
  保留为未来 A/B 的备选（可作为失败后的 fallback 协议）。
- **JSON mode 输出正文**：官方文档提示可能返回空 content，且 Markdown 转义会引入额外错误，弃用。
- **FIM 补全**：上限 4K、非思考模式、没有指令通道，只能续写不能「按指令改写」，不适用。

---

## 5. 「最完善的选区识别」到底做了哪些事

1. **精确边界**：UTF-16 偏移 + 原文 + 指纹 + 快照校验，不会错位。
2. **本地识别**（`src/core/selection.ts`，无模型、即时）：
   - 块类型：标题 / 列表 / 表格 / 代码块 / 引用 / 分隔线 / frontmatter / 段落；
   - 代码围栏语言、是否位于围栏内、围栏是否成对；
   - 是否从英文单词中间开始/结束、是否行中开始/结束、是否跨多个块；
   - `**`、`*`、`` ` ``、`[ ]` 等标记是否平衡；
   - CJK 按字、拉丁按词的计数；
   - 智能扩展选区（词 / 行 / 段落 / 块）。
3. **上下文**：按整行扩展的前后文，避免把半行发给模型；长文档改发标题大纲 + 选区附近内容。
4. **模型识别**：`ANALYSIS` 块返回 `kind/language/summary`，在 UI 中展示「模型识别」；独立「解释选区」模式（ask）可以只让模型阅读并回答，不改文档。
5. **注入防护**：逐请求随机哨兵 + 系统提示声明文档为数据 + 上下文泄漏校验。

**设计取舍**：不做「选区自动扩展/对齐」，因为那会改变用户的选择意图；只做提示与一键扩展按钮。选区取的是 CodeMirror 的精确 state，不做 DOM/预览侧的文本映射（避免双源真相）。

---

## 6. 验证策略与实测结果

| 层 | 方式 | 结果 |
| --- | --- | --- |
| 核心解析/匹配/校验 | vitest 单元测试（任意分块流式一致性、分层锚点、歧义/重叠/过期、块识别、diff、SSE 客户端） | **236 / 236 通过** |
| 真实模型 | 端到端评测脚本（30 场景：段落/行内/列表/表格/代码/标题/翻译/长选区/无需修改/注入/emoji/插入/ask/歧义锚点…） | **30 / 30 通过**；提案可应用率 100%，**选区外零改动率 100%**，结构校验 100%，一次通过 0 修复 |
| 浏览器交互 | Playwright + 系统 Chrome（真实 DeepSeek 调用） | **7 / 7 通过**（接受→变化→Ctrl+Z 精确恢复、拒绝、插入、预览、窄屏） |
| UI 细节 | 52 条独立断言 + 20 张截图（识别详情、payload、流式、过期、ask、深色、空文档、无障碍） | **52 / 52 通过**，0 console error / 0 pageerror |

延迟（30 例真实请求，deepseek-flash + 思考关闭）：总延迟 **avg 1.05s / p50 849ms / p95 2.92s**，首字 avg 780ms；30 次编辑的 token 成本约 **$0.0038**（prompt cache 热：命中 36,992 tokens，占 87%）。冷 cache 时约 $0.0100——缓存命中让同一套用例成本相差约 2.6 倍。

评测不是「看输出像不像」：评测端用 `applyProposal` 独立二次校验并应用，逐字比较选区块内外文本；结构校验基于确定性的 Markdown 规则；语义期望按用例断言。**验收红线：任何一次应用都不得改动选区外的字符**——30 个真实用例全部满足，并由 `applyProposal` 的快照校验在应用时再次保证。

产物：[`eval-report.md`](./.research/eval-report.md)、[`verification-report.md`](./.research/verification-report.md)、[`ui-verification.md`](./.artifacts/ui-verification.md)。

---

## 7. DOCX → Markdown 导入

需求：把 `.docx` 转成可继续编辑的 Markdown。图片「不方便就占位或不保留」——本实现选择**占位符**（可读、可删除、不引入二进制）。

### 7.1 载体与库选型

| 方案 | 结论 |
| --- | --- |
| 纯前端解析 OOXML | ❌ 浏览器要引入完整 docx 解析器，包体与复杂度高，且 Node 端无法复用 |
| 自研 OOXML → Markdown | ❌ OOXML 的样式/编号/表格/脚注极其繁琐，维护成本远超收益 |
| pandoc / LibreOffice | ❌ 本机未安装，且引入外部二进制依赖会破坏「一条命令启动」的部署模型 |
| **mammoth（docx → 语义 HTML）+ turndown（HTML → Markdown）** | ✅ 业界成熟组合：mammoth 理解 Word 语义（标题样式、列表、表格、脚注、链接），turndown + GFM 插件负责 Markdown 输出；mammoth 自带的 Markdown 输出已废弃，官方也推荐这条链路 |
| 服务端转换 vs 浏览器转换 | ✅ **服务端**：前端只上传二进制，转换器（Node + mammoth）不在浏览器 bundle 内，逻辑可单测、可 CLI 复用、有统一大小/安全限制 |

### 7.2 流水线

```
校验（zip magic PK、大小上限、空文件）
  → mammoth.convertToHtml（自定义 styleMap + 等宽字体识别 → 代码块）
  → HTML 清理（Word 噪音 <o:p>、空锚点）
  → turndown + GFM（图片占位、安全链接过滤、自定义表格与代码块规则）
  → Markdown 清理（空白、列表标记间距、连续空行）
  → 统计 + 警告（图片数量、mammoth 提示）
```

关键设计：

- **语义优先**：标题按 Word 样式层级映射，而不是猜字号；中文 Word 的本地化样式名（`标题 1`、`引号`、`代码`）与英文样式名都映射；整段等宽字体（Consolas/Courier New…）识别为代码块，段内软换行保留为换行。
- **表格**：Word 大多没有标记表头（`w:tblHeader`）。GFM 表格必须有表头：有 `th` 时用第一行做表头，否则生成**空表头**并保留全部数据行——宁可表头空白，也不丢数据；转换器自带的 Markdown 里能直接看到结果并可自行调整。
- **图片占位**：mammoth 的自定义 `convertImage` 不读取图片字节（省内存），只产生 `> [图片占位 N：image/png，未导出图片文件]`；UI 明确提示图片不导出。避免 base64 内联造成几十 MB 的 Markdown。
- **安全**：`externalFileAccess: false`（防止 docx 引用外部文件）、不信任文档内嵌样式映射、链接协议过滤（丢弃 `javascript:`/`data:`/`file:` 等）、25 MB 大小上限；输出只有 Markdown，预览端再做 HTML 净化。
- **可复现测试**：测试夹具由 `tests/fixtures/generate_fixtures.py`（python-docx）生成并提交，Node 测试不依赖 Python。

### 7.3 验证

- 15 个转换器单测（标题/列表/表格/代码/图片/安全链接/错误码/确定性）；
- API 自检覆盖 `/api/import/docx` 的 200/400/413 路径；
- 4 个 Playwright E2E：导入→摘要→预览→确认替换、取消不变、图片占位提示、非 docx 错误处理。

### 7.4 已知限制

纯手工排版的“伪标题”按普通段落处理；合并单元格展平；页眉页脚/批注/修订痕迹不导出；脚注会变成文末链接列表；纸张分栏等信息丢失。对「先转成可编辑的 Markdown 再让 DeepSeek 精修」这个目标，这些取舍是合理的。

## 8. Word 加载项（在 Word 内直接选区编辑）

需求：不离开 Word 就能对选中文字做 AI 改写/润色/解释。

### 8.1 载体选型

| 方案 | 结论 |
| --- | --- |
| Office JS 加载项（现代 Web Add-in） | 需要 HTTPS 托管 + 开发证书信任 + manifest 旁加载；安装步骤多，还要处理 HTTPS→HTTP 本地 API 的混合内容问题 |
| VSTO / COM 加载项 | 需要 .NET/Visual Studio 构建、注册表/安装器，部署成本高 |
| **Word VBA 模板加载项（.dotm）** | ✅ 复制到 `%APPDATA%\Microsoft\Word\STARTUP` 即安装（无需管理员）；桌面 Word 原生支持；离线可审计；可直接 HTTP 访问本机服务 |
| Word 宏（Normal.dotm 里放宏） | ❌ 污染用户全局模板，升级/卸载麻烦 |
| 复制到剪贴板 → Web 编辑器 → 粘贴回来 | ❌ 正是要消除的割裂流程 |

### 8.2 架构

```
Word 功能区「DocMax」选项卡（customUI.xml）
   → VBA 模块 DocMax.bas（读取 Selection、前后文，JSON 编码，UTF-8 HTTP）
   → POST http://127.0.0.1:5199/api/word/edit（一次性 JSON）
   → 服务端复用 /api/edit 同一套流水线（本地识别 → 提示词 → DeepSeek → 解析 → 校验 → 自动修复）
   → 返回 { ok, newText, warnings, truncated, analysisSummary, latencyMs }
   → VBA 预览确认框 → 替换 Selection.Range（保留段落/单元格结束符）→ Ctrl+Z 可撤销
```

关键工程点：

- **偏移问题不存在**：Word 的 `Range.Start/End` 与 JS 的 UTF-16 偏移在 emoji、域代码上不完全一致。加载项不传偏移，只传「选区文本 + 前后文」；服务端用 `before + selection + after` 构造局部文档，复用现有提示词/校验/修复，最后只返回替换文本，由 VBA 在自己捕获的 Range 上应用。
- **VBA 无法消费 SSE**：新增 `POST /api/word/edit` 聚合 SSE 事件为一次 JSON（`server/wordRoute.ts`），错误也以 `{ok:false, code, error}` 返回，便于 VBA 解析。
- **UTF-8 中文**：VBA 字符串是 UTF-16，HTTP 请求/响应用 ADODB.Stream 显式做 UTF-8 编解码，避免中文乱码。
- **安全**：加载项只请求 `127.0.0.1`；没有外部文件访问；所有代码在仓库中可审计；替换前必须用户确认，Word 原生撤销兜底。
- **自动启动服务**：服务未运行时，VBA 通过 `WScript.Shell` 隐藏调用 `scripts/start-docmax.ps1 -NoBrowser` 并轮询健康检查，用户不需要开终端。

### 8.3 构建、安装与验证

- `word-addin/build.ps1`：用 Word COM 创建隐藏空白文档，写入 VBA（构建时替换项目路径占位符），另存为 `.dotm`，再向 OOXML 包注入 `customUI/customUI.xml` 与关系/内容类型；构建期间临时开启「信任对 VBA 工程对象模型的访问」，结束后恢复。
- `word-addin/install.ps1`：构建（可选）→ 复制到 Word STARTUP → 确保本地服务运行 → 用隐藏 Word 实例验证。
- `word-addin/test.ps1`：隐藏 Word 运行两个自检宏：`DocMaxSelfTest`（API 链路）与 `DocMaxSelfTestDocument`（隐藏临时文档里选中文字 → 请求 → 替换选区 → 检查结果），不触碰用户正在编辑的文档。
- 实测：VBA 编译通过；两个自检均返回 OK；一次改写端到端约 0.7–1.0s。

### 8.4 限制

仅 Windows 桌面版 Word；依赖宏信任设置（STARTUP 模板通常自动加载，异常时需检查信任中心）；Ribbon 按钮文本为中文；不处理 Word Online；超长选区（>20 万字符）拒绝；预览确认框最多展示 900 字符（完整结果仍会应用）。

## 9. Windows 安装包

目标：给没有 Node.js 环境的 Windows 用户一个「下一步下一步就装好」的安装包，包含 Web 编辑器、本地服务与 Word 加载项。

### 9.1 方案选型

| 方案 | 结论 |
| --- | --- |
| 绿色 ZIP + install.ps1 | 简单，但需要用户解压/右键运行脚本，体验不像安装包 |
| IExpress（Windows 自带 SFX） | 无需外部工具，但可定制性差、SED 构建在当前环境失败、无标准卸载器 |
| **NSIS 3（MUI2）** | ✅ 标准 Windows 安装器：安装向导、开始菜单/桌面快捷方式、注册卸载信息、原生 uninstaller；`RequestExecutionLevel user` 可无管理员安装 |
| Electron/Tauri 重写外壳 | ❌ 现有架构就是本地 Web 服务，没必要整体重写 |

NSIS 便携版由构建脚本在首次构建时下载到 `installer/tools`（不提交仓库），后续离线可用。安装器用 `SetCompressor /SOLID lzma` 压缩内置的 Node 运行时，最终约 23 MB。

### 9.2 自包含运行时

```
installer/staging/
  node.exe            复制自本机 Node（含 NODE-LICENSE.txt）
  server.mjs          esbuild 打包 server/index.ts（ESM 单文件，external: vite）
  dist/               Vite 生产构建（前端静态资源）
  word-addin/DocMax.dotm
  launch-docmax.vbs   隐藏启动本地服务并打开浏览器
  stop-docmax.ps1     卸载/升级前停止本地服务
  assets/docmax.ico  快捷方式与安装器图标
  README.txt
```

关键点：

- **不打包 node_modules**：esbuild 把服务端及其依赖打成一个 `server.mjs`（约 2.7 MB）；CJS 依赖在 ESM 产物中需要 `createRequire`，构建时注入 banner 解决 `Dynamic require of "tty"` 问题。
- **Node 运行时**直接随包分发（约 93 MB，LZMA 压缩后安装包 23 MB），安装后无需用户安装 Node。
- **根目录定位**：安装版由启动器设置 `DOCMAX_ROOT=安装目录`，`server/config.ts` 优先读取该环境变量；源码模式仍退回项目根目录。
- **启动器**（VBS）先检查 `/api/health`：服务已在运行则直接开浏览器；否则隐藏启动 `node.exe server.mjs --prod` 并轮询就绪，最多 60s，失败弹窗并给出日志路径。

### 9.3 安装器行为

- 按用户安装到 `%LOCALAPPDATA%\DocMax`，`RequestExecutionLevel user`（无 UAC）；
- 自定义向导页输入 DeepSeek API Key（可留空），写入安装目录 `.env`；升级安装检测到已有 `.env` 时保留原配置；
- 桌面 + 开始菜单快捷方式（VBS 启动，无控制台窗口）；
- 检测 Word（注册表 App Paths）后把 `DocMax.dotm` 复制到 Word STARTUP；
- 写 `HKCU\...\Uninstall\DocMax`，支持「设置 → 应用」标准卸载；QuietUninstallString 支持静默卸载；
- 卸载器：先经 `stop-docmax.ps1` 停止本地服务 → 备份 `.env` 到 `%USERPROFILE%\DocMax.env.bak` → 删除快捷方式、Word 加载项、注册表与安装目录。
- 自动化测试开关：`DOCMAX_INSTALL_TEST=1`（不写快捷方式/Word/注册表）、`DOCMAX_API_KEY`（免交互填 Key）、`/D=<dir>` 覆盖安装目录。

### 9.4 验证

- staging 内 `node.exe server.mjs --prod` 冒烟：健康检查、首页 200、`/api/word/edit` 真实 DeepSeek 调用通过；
- 静默测试安装到临时目录：文件/`.env`/卸载器齐全 → 安装版应用启动并完成真实 AI 请求 → `uninstall.exe /S` 完全删除目录；
- 正式安装到 `%LOCALAPPDATA%\DocMax`：快捷方式、注册表卸载项、Word 加载项均就位；通过安装版启动器启动，健康检查显示 `version=0.2.0`、`mode=production`，页面 200；
- 安装版 Word 加载项自检（API + 隐藏文档选区替换）通过。

### 9.5 限制

仅 Windows x64；未代码签名（SmartScreen 可能提示）；安装包版本需与项目源码同步（`installer:build` 自动读取 `package.json` 版本）；对已有旧安装升级时会停止旧服务再覆盖安装。

## 10. 已知限制与后续方向

- 多选区目前串行逐区处理（v1：主选区优先），并行 + 合并为一个事务是可做的下一步；
- surgical 模式对「同一短句在选区内重复」仍可能触发一次修复重试（已有 FIND_ALL 支持，长重复文本一次通过率待评测数据）；
- 前缀补全（Beta）可作为失败兜底协议；
- 图片输入（flash 支持 vision）可用于「拍照/截图转 Markdown」，但超出当前范围；
- 协同编辑/云同步未做（本地优先是有意选择）。

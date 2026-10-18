# DocMax 真实模型评测报告（阶段 2）

- 生成时间：2026-10-18T13:06:52.226Z
- 服务地址：http://127.0.0.1:5199
- 核心版本：0.1.0
- 用例数：30（默认模型 deepseek-flash，thinking off；v4-pro 用例单独标注）
- 运行方式：`node node_modules/tsx/dist/cli.mjs scripts/eval.ts`（可重复运行，顺序请求真实服务）

## 一、总览指标

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 用例总数 | 30 | 覆盖 rewrite / surgical / insert / ask 四种模式 |
| 通过 | 30（100.0%） | 应用成功 + 选区外零改动 + 结构校验 + 语义期望全部满足 |
| 提案成功率 | 100.0% | 收到可用提案（或 ask 回答）的比例 |
| 提案可应用率 | 100.0% | applyProposal 校验通过（快照一致、无越界/重叠） |
| 选区外零改动率 | 100.0% | 应用后选区之前/之后内容逐字一致 |
| 结构校验通过率 | 100.0% | 标题/列表/表格/代码围栏/frontmatter/行内片段结构保持 |
| 语义期望通过率 | 100.0% | 用例级包含/不包含/变更幅度等检查 |
| 自动修复率 | 0.0%（0 例） | 服务端首次校验失败后触发修复重试 |
| 截断提案数 | 0 | truncated=true 的提案（error 级警告，需人工确认） |
| 评测层重试 | 0 例 | 网络/流中断等可重试错误后的自动重试次数 |

## 二、延迟指标

| 指标 | 总延迟 | 首字延迟* |
| --- | --- | --- |
| 平均 | 1.05s | 780ms |
| p50 | 849ms | 726ms |
| p95 | 2.92s | 1.24s |
| 最大 | 4.28s | — |

\* 首字延迟 = 从请求发出到收到第一个模型内容事件（delta / answer / raw）的时间；surgical 模式的 raw 事件在生成阶段即可见。

### 按模式分组

| 模式 | 用例数 | 通过 | 平均总延迟 | p50 | p95 | 平均首字 |
| --- | --- | --- | --- | --- | --- | --- |
| rewrite | 22 | 22 | 1.02s | 849ms | 1.32s | 791ms |
| ask | 2 | 2 | 2.09s | 1.25s | 2.92s | 838ms |
| surgical | 5 | 5 | 854ms | 787ms | 1.10s | 715ms |
| insert | 1 | 1 | 805ms | 805ms | 805ms | 747ms |

## 三、Token 与成本估算

| 指标 | 数值 |
| --- | --- |
| prompt tokens | 42,321 |
| completion tokens | 3,054 |
| total tokens | 45,375 |
| prompt cache hit | 36,992（命中率 87.4%） |
| prompt cache miss | 5,329 |
| reasoning tokens | 178 |
| 估算总成本 | $0.0038（平均 $0.00013/例） |

> 成本估算基准：按输入 cache-miss $0.28/M、cache-hit $0.028/M、输出 $0.42/M 估算（可用 DOCMAX_PRICE_* 环境变量覆盖）。实际计费以 DeepSeek 账单为准。

## 四、用例明细

| # | 用例 | 模式 | 选区 | 状态 | 策略 | warnings | 总延迟 | 首字 | attempts/repairs | tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 段落润色（周报段落） | rewrite | 51字/paragraph | ✅ pass | rewrite | 0 | 1.32s | 1.31s | 1/0 | 999 |
| 2 | 行内半句改写 | rewrite | 8字/paragraph | ✅ pass | rewrite | 0 | 888ms | 862ms | 1/0 | 998 |
| 3 | 列表块改写（保留列表结构） | rewrite | 35字/list | ✅ pass | rewrite | 1 条 | 1.05s | 656ms | 1/0 | 1063 |
| 4 | 标题改写（保留标题层级） | rewrite | 7字/heading | ✅ pass | rewrite | 0 | 763ms | 726ms | 1/0 | 996 |
| 5 | 无需修改（只检查错别字） | rewrite | 29字/paragraph | ✅ pass | rewrite | 1 条 | 947ms | 909ms | 1/0 | 1009 |
| 6 | 提示词注入（选中文本内藏指令） | rewrite | 58字/paragraph | ✅ pass | rewrite | 0 | 1.01s | 972ms | 1/0 | 892 |
| 7 | 翻译（中译英，保留 Markdown） | rewrite | 51字/paragraph | ✅ pass | rewrite | 1 条 | 872ms | 694ms | 1/0 | 1010 |
| 8 | 扩写（1 句扩成 2-3 句） | rewrite | 8字/paragraph | ✅ pass | rewrite | 0 | 1.01s | 670ms | 1/0 | 1046 |
| 9 | 缩写（压到 40 字以内） | rewrite | 51字/paragraph | ✅ pass | rewrite | 0 | 597ms | 541ms | 1/0 | 1007 |
| 10 | ask 解释选区 | ask | 29字/paragraph | ✅ pass | answer | 0 | 2.92s | 954ms | 1/0 | 1275 |
| 11 | emoji 与中文标点（句号→感叹号） | rewrite | 21字/paragraph | ✅ pass | rewrite | 0 | 849ms | 828ms | 1/0 | 893 |
| 12 | 英文润色（onboarding 段落） | rewrite | 81字/paragraph | ✅ pass | rewrite | 0 | 943ms | 904ms | 1/0 | 896 |
| 13 | 英文行内片段改写 | rewrite | 18字/paragraph | ✅ pass | rewrite | 0 | 659ms | 631ms | 1/0 | 884 |
| 14 | 代码块修复（保留代码围栏语义） | rewrite | 109字/code | ✅ pass | rewrite | 0 | 601ms | 501ms | 1/0 | 967 |
| 15 | 表格改写（结构保持） | rewrite | 98字/table | ✅ pass | rewrite | 0 | 889ms | 843ms | 1/0 | 1003 |
| 16 | surgical 局部精准修改（单处） | surgical | 51字/paragraph | ✅ pass | search-replace-exact | 0 | 991ms | 912ms | 1/0 | 1271 |
| 17 | surgical FIND_ALL（同词多处替换） | surgical | 30字/paragraph | ✅ pass | search-replace-exact | 0 | 775ms | 671ms | 1/0 | 1139 |
| 18 | surgical 长选区（>4000 字）错别字修复 | surgical | 6100字/heading | ✅ pass | search-replace-exact | 0 | 1.10s | 827ms | 1/0 | 8671 |
| 19 | rewrite 超长选区（>4000 字）压缩 | rewrite | 6100字/heading | ✅ pass | rewrite | 1 条 | 1.18s | 899ms | 1/0 | 8369 |
| 20 | 空选区插入（光标处） | insert | 0字/paragraph | ✅ pass | insert | 0 | 805ms | 747ms | 1/0 | 1010 |
| 21 | 模糊指令（“让它更好”） | rewrite | 29字/paragraph | ✅ pass | rewrite | 0 | 829ms | 748ms | 1/0 | 986 |
| 22 | surgical 歧义锚点（第二处同名短语） | surgical | 55字/paragraph | ✅ pass | search-replace-exact | 0 | 620ms | 500ms | 1/0 | 1181 |
| 23 | surgical 引号规范化（锚点逐字复制） | surgical | 13字/paragraph | ✅ pass | search-replace-exact | 0 | 787ms | 665ms | 1/0 | 1166 |
| 24 | frontmatter 字段改写（YAML 保持） | rewrite | 10字/frontmatter | ✅ pass | rewrite | 0 | 810ms | 781ms | 1/0 | 900 |
| 25 | 引用块改写（保留 > 标记） | rewrite | 37字/blockquote | ✅ pass | rewrite | 0 | 750ms | 719ms | 1/0 | 880 |
| 26 | v4-pro + thinking low（复杂润色） | rewrite | 51字/paragraph | ✅ pass | rewrite | 0 | 4.28s | 1.24s | 1/0 | 1194 |
| 27 | ask 解释代码 | ask | 109字/code | ✅ pass | answer | 0 | 1.25s | 722ms | 1/0 | 1048 |
| 28 | 英文拼写纠错 | rewrite | 9字/paragraph | ✅ pass | rewrite | 0 | 598ms | 596ms | 1/0 | 845 |
| 29 | 翻译（英译中） | rewrite | 81字/paragraph | ✅ pass | rewrite | 1 条 | 735ms | 670ms | 1/0 | 884 |
| 30 | 中文标点规范化（引号/省略号） | rewrite | 42字/paragraph | ✅ pass | rewrite | 0 | 787ms | 718ms | 1/0 | 893 |

## 五、失败与诊断

全部用例通过，无失败案例。

## 六、方法与限制

- 每个用例都真实调用本机服务 `POST /api/edit`（SSE），由服务端调用真实 DeepSeek；未直连 DeepSeek API、未读取 `.env`。
- 提案校验在评测端独立完成：用 `src/core/apply.ts` 的 `applyProposal` 再次校验快照并应用，比较选区前后文本是否逐字一致（selection 外零改动）。
- 结构校验基于本地 `analyzeSelection` 的块类型，以及标题/列表/表格/围栏/frontmatter 的确定性规则；语义检查为用例级期望（包含/不包含/变更幅度），不是人工评审。
- 样本量有限（30 例、单次运行），延迟受网络与模型负载影响；成本为按公开价目估算。
- 已知限制：模糊锚点路径主要由单元测试覆盖，真实模型多数会逐字复制 FIND；仅选中表格分隔行时 `blockKind` 曾在报告中记为 paragraph，报告定稿后已由 Lead 修复为 `table`。

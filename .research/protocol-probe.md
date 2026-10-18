# 协议实测记录（2026-10-18）

本文件记录设计决策背后的实测数据，供复核。脚本位于 `.probe/`（未纳入版本控制）。所有请求走 `https://api.deepseek.com`，key 为本地 `.dsh` 凭据中的 DeepSeek key。

## 1. Envelope 协议（最终采用）的格式遵循率

系统提示 + 用户上下文 + `<<<ANALYSIS>>>`/`<<<EDIT>>>` 包裹，真实文档片段 4 个用例（段落润色、行内片段、列表、surgical 无改动）。

| 配置 | 格式遵循 | 首字 | 总耗时 |
| --- | --- | --- | --- |
| flash + thinking disabled | 4/4 | 530–836ms | 835–1298ms |
| flash + effort low | 4/4 | 493–1191ms | 1027–1472ms |
| v4-pro + effort low | 3/4 | 3058–6529ms | 3494–9692ms |

结论：flash + 关闭思考 = 编辑器默认；pro = 「深度模式」。v4-pro 唯一失败为长列表输出格式异常，已被 repair 逻辑覆盖（生产链路会自动重试一次）。

## 2. 边界对抗用例

| 用例 | 结果 |
| --- | --- |
| 选区跨 Markdown 列表重写 | ✅ 保持列表结构 |
| 代码块选区重写 | ✅ 保留 ```ts 围栏（sanitize 只在选区非代码块时剥离围栏） |
| 表格加行 | ✅ 表格结构正确 |
| 英文翻译 | ✅ |
| 选区含提示注入文本（“忽略之前指令…”） | ✅ 未执行注入，按润色处理（另有随机哨兵 + 系统提示双保险） |
| 截断（max_tokens 很小） | ✅ 无 END 标记 + finish_reason=length，可 100% 检测 |
| 半词选择（`fox` in `foxes`） | ⚠️ 模型返回 `vixen`，与 `es` 拼接会出错；已通过本地 `startsMidWord/endsMidWord` 识别 + 提示词要求 + UI 提示缓解（产品不自动扩展选区，尊重用户选择） |

## 3. surgical（FIND/REPLACE）失败模式实测

- 模型**经常省略 `<<<END>>>` 块终止标记**（24 个块中全部省略）→ 解析器必须容忍，以「下一个 FIND」为块边界。
- 长重复文本（20 行 × 2 处 “风险评估”）初次生成 40 个 FIND 块，`max_tokens=4000` 时被截断 → 服务端应检测截断并重试。正式实现中增加了 `FIND_ALL` 协议说明，重测：**一次生成成功、40 处全部替换、选区外零改动，耗时 1.38s**（此前需要一次 repair，2.07s）。
- 重复锚点必须判歧义：模型给出的 FIND 若在选区内出现多次且未用 FIND_ALL，服务端拒绝并带着「相似行」诊断重试一次。
- 长选区 surgical 比 rewrite 快：2209 字符选区 surgical 991ms / 95 completion tokens，rewrite 3381ms / 1106 completion tokens。

## 4. Prefix completion + stop 序列（评估后未采用为默认）

`POST https://api.deepseek.com/beta/chat/completions`，最后一条 assistant `{prefix:true, content:"<<<EDIT>>>\n"}`，`stop:["\n<<<END_EDIT>>>"]`。

| 配置 | 结果 |
| --- | --- |
| flash + thinking disabled | ✅ 兼容，总耗时 980ms，首字 281ms |
| flash + effort low | ✅ 兼容，总耗时 714ms，首字 121ms |
| v4-pro + thinking disabled | ✅ 兼容，总耗时 1560ms |
| 截断检测 | ✅ finish_reason=length |

未采用原因（见 DESIGN.md §4）：
1. prefix 模式无法携带 ANALYSIS 块（本产品需要展示模型识别结果）；
2. `finish_reason=stop` 无法区分「stop 序列命中」与「模型自然结束」，会与缺标记检测冲突；
3. beta 接口 + envelope 协议实测已 100% 遵循（小样本），解析器容错足以覆盖前言/围栏/缺标记。
保留为未来失败兜底协议的候选。

## 5. 其他实测

- `stream_options.include_usage: true` 在流末 chunk 返回 usage ✅；prompt cache 命中信息可用（重复请求文档前缀时 hit 768 / miss 157 tokens）。
- thinking 模式流式返回 `reasoning_content`，与 `content` 分离 ✅。
- 本机一次段落润色：925 prompt + 77 completion tokens ≈ $0.0002（flash 非高峰价）。

## 6. 服务端端到端（含解析/校验/提案）

| 场景 | 总耗时 | tokens |
| --- | --- | --- |
| rewrite 段落 51 字符 | 909ms | 1002 |
| rewrite 729 字符 | 1927ms | 1993 |
| rewrite 2209 字符 | 3381ms | 4483 |
| surgical 2209 字符 | 991ms | 3741（含整段选区 prompt） |
| insert（空选区） | 771ms | — |
| ask（解释） | 1106ms | — |

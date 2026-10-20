/**
 * 系统内置提示词模式（Prompt Presets）。
 *
 * 与「快速指令」（润色/扩写/翻译等文字指令）不同，这里是**系统级任务设定**：
 * 会追加到系统提示词里，决定模型「以什么方式」完成任务。用户可自由组合：
 *   - 提示词模式：默认 / 结构重写 / 精简 / 扩写 / 正式 / 通俗 / 校对 / 结构化 / 翻译
 *   - 指令：额外告诉模型具体要改什么（可留空，留空时使用该模式的默认指令）
 *
 * 这些规则是产品的一部分，放在共享 core 中，服务端/Word 插件/评测共用同一份。
 */

export type PromptPresetId =
  | 'default'
  | 'structure-fill'
  | 'concise'
  | 'expand'
  | 'formal'
  | 'casual'
  | 'proofread'
  | 'structured'
  | 'translate-en'
  | 'translate-zh';

export interface PromptPreset {
  id: PromptPresetId;
  /** 界面显示名 */
  label: string;
  /** 一句话说明（界面提示） */
  description: string;
  /** 追加到系统提示词的任务规则 */
  rules: string;
  /** 指令留空时使用的默认指令 */
  defaultInstruction: string;
  /** 是否适用于「解释（ask）」模式；默认 false，ask 模式忽略预设 */
  appliesToAsk?: boolean;
}

export const DEFAULT_PRESET_ID: PromptPresetId = 'default';

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'default',
    label: '默认编辑',
    description: '按指令直接修改；保留原文信息、语气与 Markdown 结构。',
    defaultInstruction: '按下面的要求修改选中的文字，保持原意与结构。',
    rules: `当前任务模式：默认编辑。
- 在不改变原文事实、数字、专有名词、结论与 Markdown 结构的前提下，按用户指令改进表达。
- 指令没有明确要求时，优先保留原文的信息密度与语气，不擅自增删内容。`,
  },
  {
    id: 'structure-fill',
    label: '结构重写 · 括号补全',
    description: '按原文结构骨架重写；信息缺失处不编造，用（需补充：…）标注。',
    defaultInstruction: '按照原文的结构重写这段内容；信息不完整或有缺失的地方，用（需补充：…）标注需要补充什么。',
    rules: `当前任务模式：结构重写（缺失处用括号补全）。
- 以 <selection> 原有的结构为骨架重写：保留段落顺序、标题层级、列表项数量与层级、表格行列结构、引用与代码块位置；不得把结构化内容压成一段。
- 原文中信息不完整、缺失、含糊、只有占位符或写到一半的地方，不要编造事实：在对应位置写出中文圆括号说明，指出需要补充什么。格式为：（需补充：……）或（待确认：……），每处缺口只写一个括号说明，括号内容要具体、可执行。
- 原文已有的信息必须保留（可以改写措辞、重组顺序）；不得删除要点、数字、专有名词、链接或引用。
- 括号说明属于输出内容的一部分；只输出重写后的选区，不要额外解释。`,
  },
  {
    id: 'concise',
    label: '精简压缩',
    description: '删冗余、去口水话，保留事实、结论与结构。',
    defaultInstruction: '在不丢失关键信息的前提下，把这段文字压缩得更简洁紧凑。',
    rules: `当前任务模式：精简压缩。
- 在不丢失事实、数字、结论、专有名词与 Markdown 结构的前提下压缩表达，删除口水话、重复、空泛修饰与过度解释。
- 能删就删，但不能改变原意或删除要点；保留原文语言与语气。`,
  },
  {
    id: 'expand',
    label: '扩写补全',
    description: '补充细节、解释与过渡，使内容完整；不编造数据。',
    defaultInstruction: '在保持原意的前提下扩写这段内容，补充必要的细节、解释或例子。',
    rules: `当前任务模式：扩写补全。
- 围绕原文已有的论点与信息补充细节、解释、例子或过渡，使内容更完整、可读。
- 不得改变原意、不得编造无法核实的数据或事实；保持 Markdown 结构与段落顺序；只做必要的扩写，不要用废话拉长。`,
  },
  {
    id: 'formal',
    label: '正式 / 学术',
    description: '改为正式、专业、克制的书面表达。',
    defaultInstruction: '把这段文字改成正式、专业的书面表达，保持原意。',
    rules: `当前任务模式：正式 / 学术表达。
- 改为正式、专业、克制的书面中文：避免口语、网络用语、感叹号、第一人称情绪化表达与模糊措辞；术语统一、句式完整。
- 不改变事实、数字、专有名词与结构；不新增原文没有的结论。`,
  },
  {
    id: 'casual',
    label: '通俗解释',
    description: '用更口语、易懂的方式重写，保留全部关键信息。',
    defaultInstruction: '用更通俗易懂的方式重写这段文字，必要时解释术语。',
    rules: `当前任务模式：通俗表达。
- 用更自然、易懂的口语化表达重写，必要时用简单解释或类比说明术语；保留全部关键信息与结构。
- 不要变成聊天，不要添加与内容无关的寒暄。`,
  },
  {
    id: 'proofread',
    label: '最小校对',
    description: '只修错别字、标点、语法；不润色、不改结构。',
    defaultInstruction: '只修正这段文字中的错别字、标点与语法问题，做最小必要修改。',
    rules: `当前任务模式：最小校对。
- 只做最小必要修改：修正错别字、标点、语法、术语不一致、明显语病与格式错误。
- 不得润色风格、不得增删信息、不得改变结构或语气；没有需要修改的地方就原样输出。`,
  },
  {
    id: 'structured',
    label: '结构化整理',
    description: '整理成清晰的标题 / 列表 / 表格；不增删信息。',
    defaultInstruction: '在不改变事实与信息量的前提下，把这段内容整理成更清晰的 Markdown 结构。',
    rules: `当前任务模式：结构化整理。
- 在不改变事实与信息量的前提下，把内容整理成清晰的 Markdown 结构：适当使用标题、项目符号、编号或表格。
- 原文结构已经清楚时保留原结构；不要为了结构化而新增或丢失信息。`,
  },
  {
    id: 'translate-en',
    label: '翻译成英文',
    description: '翻译为自然英文，保留 Markdown 结构、术语与数字。',
    defaultInstruction: '把这段文字翻译成自然、准确的英文，保留 Markdown 结构。',
    rules: `当前任务模式：翻译为英文。
- 把选区翻译成自然、准确的英文；保留 Markdown 结构、列表/表格/代码块、专有名词、数字与链接。
- 不增删信息、不解释、不加译注（原文括号内的说明除外）；使用领域通行术语。`,
  },
  {
    id: 'translate-zh',
    label: '翻译成中文',
    description: '翻译为自然中文，保留 Markdown 结构、术语与数字。',
    defaultInstruction: '把这段文字翻译成自然、准确的中文，保留 Markdown 结构。',
    rules: `当前任务模式：翻译为中文。
- 把选区翻译成自然、准确的中文；保留 Markdown 结构、列表/表格/代码块、专有名词、数字与链接。
- 不增删信息、不解释、不加译注（原文括号内的说明除外）；使用领域通行术语。`,
  },
];

const PRESET_MAP = new Map<string, PromptPreset>(PROMPT_PRESETS.map((preset) => [preset.id, preset]));

export function isPromptPresetId(value: unknown): value is PromptPresetId {
  return typeof value === 'string' && PRESET_MAP.has(value);
}

/** 非法/缺失的 id 一律回退到默认模式，保证服务端永远有可用规则 */
export function getPromptPreset(id: unknown): PromptPreset {
  if (typeof id === 'string') {
    const found = PRESET_MAP.get(id);
    if (found) return found;
  }
  return PRESET_MAP.get(DEFAULT_PRESET_ID) as PromptPreset;
}

/** 给 UI/日志用的简短模式名 */
export function promptPresetLabel(id: unknown): string {
  return getPromptPreset(id).label;
}

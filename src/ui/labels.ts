/**
 * 界面文案与枚举标签：统一中文措辞，避免散落在组件里。
 */
import type { BlockKind, EditMode, ModelId, ThinkingLevel } from '../core/types';
import type { ModeChoice, StreamPhase } from './types';

export const BLOCK_LABELS: Record<BlockKind, string> = {
  paragraph: '段落',
  heading: '标题',
  list: '列表',
  table: '表格',
  code: '代码块',
  blockquote: '引用',
  hr: '分隔线',
  frontmatter: 'Frontmatter',
  html: 'HTML',
  empty: '空白',
};

export const MODEL_OPTIONS: Array<{ id: ModelId; label: string; hint: string }> = [
  { id: 'deepseek-flash', label: 'Flash', hint: '低延迟' },
  { id: 'deepseek-v4-pro', label: 'V4 Pro', hint: '慢，但更准' },
];

export const MODEL_LABELS: Record<ModelId, string> = {
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
};

export const THINKING_OPTIONS: Array<{ id: ThinkingLevel; label: string; hint: string }> = [
  { id: 'off', label: '不思考', hint: '最快' },
  { id: 'low', label: '轻思考', hint: '更稳' },
  { id: 'high', label: '深思考', hint: '最慢' },
];

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '不思考',
  low: '轻思考',
  high: '深思考',
  max: '深思考',
};

export const MODE_CHOICE_LABELS: Record<ModeChoice, string> = {
  auto: '自动',
  rewrite: '整体重写',
  surgical: '局部精准修改',
};

export const MODE_LABELS: Record<EditMode, string> = {
  rewrite: '整体重写',
  surgical: '局部精准修改',
  insert: '插入',
  ask: '解释',
};

export const PHASE_LABELS: Record<StreamPhase, string> = {
  connecting: '连接',
  thinking: '思考',
  streaming: '生成',
  validating: '校验',
  repairing: '修复',
  done: '完成',
};

export const PHASE_ORDER: StreamPhase[] = ['connecting', 'thinking', 'streaming', 'validating'];

export const SEVERITY_LABELS = {
  info: '提示',
  warn: '注意',
  error: '风险',
} as const;

/** 给用户看的模式解析说明（命令条里显示「这次会怎么改」） */
export function describeMode(mode: EditMode): string {
  switch (mode) {
    case 'insert':
      return '在光标处插入';
    case 'surgical':
      return '局部精准修改（FIND/REPLACE，适合长选区）';
    case 'ask':
      return '只解释，不修改文档';
    default:
      return '整体重写选区';
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${seconds} 秒`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('zh-CN');
}

export function modelLabel(model: ModelId | null | undefined): string {
  return model ? MODEL_LABELS[model] ?? model : '—';
}

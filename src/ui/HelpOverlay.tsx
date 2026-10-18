/**
 * 快捷键帮助浮层。
 */
import { useEffect, useRef } from 'react';

export interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
  isMac: boolean;
}

const GROUPS: Array<{ title: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    title: 'AI',
    items: [
      { keys: ['Mod', 'K'], label: '打开指令条 / 修改选区' },
      { keys: ['Enter'], label: '提交指令' },
      { keys: ['Shift', 'Enter'], label: '指令内换行' },
      { keys: ['Mod', 'Enter'], label: '接受当前修改' },
      { keys: ['Esc'], label: '取消 / 关闭浮层 / 中止生成' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: ['Mod', 'Z'], label: '撤销（包括一次应用的全部修改）' },
      { keys: ['Mod', 'Shift', 'Z'], label: '重做' },
      { keys: ['Tab'], label: '缩进' },
    ],
  },
  {
    title: '文件与视图',
    items: [
      { keys: ['Mod', 'O'], label: '打开 Markdown 文件' },
      { keys: [], label: '导入 Word（.docx → Markdown，工具栏按钮）' },
      { keys: ['Mod', 'S'], label: '保存' },
      { keys: ['Mod', 'Shift', 'S'], label: '另存为' },
      { keys: ['Mod', 'P'], label: '切换预览' },
      { keys: ['Mod', '/'], label: '快捷键帮助' },
    ],
  },
];

export function HelpOverlay({ open, onClose, isMac }: HelpOverlayProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="help-card" role="dialog" aria-modal="true" aria-label="快捷键帮助" data-testid="help-overlay">
        <header className="help-head">
          <h2>快捷键</h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="关闭快捷键帮助">
            ✕
          </button>
        </header>
        <div className="help-groups">
          {GROUPS.map((group) => (
            <section className="help-group" key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div className="help-row" key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>
                      {item.keys.map((key) => (
                        <kbd key={key}>{key === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : key}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="help-note">对选区应用修改后，一次撤销即可完整回退。</p>
      </div>
    </div>
  );
}

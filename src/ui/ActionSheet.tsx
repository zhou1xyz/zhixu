/**
 * ActionSheet —— 底部动作面板
 *
 * 手机上点「⋯」从底部滑出，列出一组操作（编辑、标记等待、删除等）。
 * 桌面上同一个组件也能用，只是从底部弹出。
 */
import { useEffect } from 'react';

export interface ActionItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface ActionSheetProps {
  title: string;
  actions: ActionItem[];
  onClose: () => void;
}

/** 移动端底部动作面板：从底部滑出，点击遮罩或取消关闭 */
export function ActionSheet({ title, actions, onClose }: ActionSheetProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/40"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-t-2xl border-t border-[var(--color-border)] bg-[var(--color-card)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <p className="truncate text-sm font-medium text-[var(--color-text)]">{title}</p>
        </div>
        <div className="flex flex-col p-2">
          {actions.map((action: ActionItem) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                action.onSelect();
                onClose();
              }}
              className={`tap-target flex items-center rounded-lg px-4 py-3 text-left text-[15px] transition hover:bg-[var(--color-card-muted)] ${
                action.danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="border-t border-[var(--color-border)] p-2">
          <button
            type="button"
            onClick={onClose}
            className="tap-target w-full rounded-lg px-4 py-3 text-[15px] font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

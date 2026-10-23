/**
 * Modal —— 通用弹窗外壳
 *
 * 只负责：遮罩、居中容器、标题栏、关闭按钮、Esc 关闭。
 * 具体内容由调用方通过 children 传进来。
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, description, onClose, children }: ModalProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 px-3 py-6 backdrop-blur-[2px] sm:px-4 sm:py-12"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="my-auto w-full max-w-[500px] border bg-[var(--color-card)] shadow-xl"
        style={{ borderRadius: 'var(--radius-card)', borderColor: 'var(--color-border)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
            {description !== undefined && (
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded-md px-2 py-1 text-[var(--color-text-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-text-secondary)]"
            aria-label="关闭弹窗"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-5 sm:px-6">{children}</div>
      </div>
    </div>
  );
}

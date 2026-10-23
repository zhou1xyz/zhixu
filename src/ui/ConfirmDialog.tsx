/**
 * ConfirmDialog —— 危险操作的二次确认框
 *
 * 删除这类不可撤销的动作，必须再问一次。
 */
interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4"
      role="presentation"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm border bg-[var(--color-card)] p-5 shadow-xl"
        style={{ borderRadius: 'var(--radius-card)', borderColor: 'var(--color-border)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-10 rounded-lg bg-[var(--color-danger)] px-4 text-sm font-medium text-white transition hover:bg-[var(--color-danger)] disabled:opacity-60"
          >
            {busy ? busyLabel ?? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

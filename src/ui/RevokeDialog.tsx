/**
 * RevokeDialog —— 从「等待中」收回任务的弹窗
 *
 * 收回后任务状态回到「待处理」，重新进入排期。
 * 收回原因可填可不填，会记进流转历史。
 */
import { useState } from 'react';
import type { Task } from '../types';

interface RevokeDialogProps {
  task: Task;
  onConfirm: (note: string | null) => Promise<void>;
  onCancel: () => void;
}

/** 从等待中收回：任务回到待处理，可附一句说明 */
export function RevokeDialog({ task, onConfirm, onCancel }: RevokeDialogProps) {
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/40 px-4" role="presentation" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`收回：${task.title}`}
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[var(--color-text)]">收回这个任务</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          「{task.title}」将回到待处理，重新进入排期。
        </p>
        <label className="mt-3 flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]">
          收回原因（可选）
          <textarea
            rows={3}
            placeholder="例如：对方已回复，需要我这边继续推进"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-h-[72px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-brand)]"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void onConfirm(note.trim() === '' ? null : note.trim());
            }}
            className="h-10 min-w-[88px] rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-70"
          >
            {saving ? '处理中…' : '收回'}
          </button>
        </div>
      </div>
    </div>
  );
}

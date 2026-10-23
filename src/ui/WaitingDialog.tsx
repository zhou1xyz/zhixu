/**
 * WaitingDialog —— 标记「等待中」的弹窗
 *
 * 用于「这件事现在不在我手上，等别人处理」的场景。
 * 催办日期是必填项：系统会在那天把任务顶到页面提醒你跟进。
 */
import { useEffect, useState } from 'react';
import type { Task } from '../types';

interface WaitingDialogProps {
  task: Task;
  onConfirm: (remindDate: string, note: string | null) => Promise<void>;
  onCancel: () => void;
}

function todayPlus(days: number): string {
  const d: Date = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 标记“等待中”：必须给出催办日期，让系统知道什么时候提醒你跟进 */
export function WaitingDialog({ task, onConfirm, onCancel }: WaitingDialogProps) {
  const [remindDate, setRemindDate] = useState<string>(task.remindDate ?? todayPlus(3));
  const [note, setNote] = useState<string>(task.waitingNote ?? '');
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !saving) onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, saving]);

  async function handleSubmit(): Promise<void> {
    if (saving) return;
    if (remindDate === '') {
      setError('请选择催办日期');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onConfirm(remindDate, note.trim() === '' ? null : note.trim());
    } catch (e: unknown) {
      setSaving(false);
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[65] flex items-end justify-center bg-slate-900/40 px-0 sm:items-center sm:px-4"
      role="presentation"
      onClick={() => { if (!saving) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`标记等待：${task.title}`}
        className="w-full rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-2xl sm:max-w-[520px] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--color-text)]">
            标记为等待中：<span className="wrap-anywhere">{task.title}</span>
          </h2>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            这个任务暂时不在你手上，等别人处理。系统会在催办日期提醒你跟进。
          </p>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]">
            催办日期
            <input
              type="date"
              value={remindDate}
              onChange={(e) => setRemindDate(e.target.value)}
              className="h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-brand)]"
            />
            <span className="text-xs font-normal text-[var(--color-text-muted)]">
              到期未收回，列表顶部会提示你。
            </span>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]">
            等待备注（可选）
            <textarea
              rows={3}
              placeholder="等谁？等什么？例如：已发给张总审批，等他签字"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="min-h-[80px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-brand)]"
            />
          </label>

          {error !== '' && (
            <p className="rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3.5">
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
            onClick={() => { void handleSubmit(); }}
            className="h-10 min-w-[104px] rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-70"
          >
            {saving ? '保存中…' : '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}

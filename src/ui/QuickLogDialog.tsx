/**
 * QuickLogDialog —— 快速记一笔进展
 *
 * 为什么单独做一个：记进展是高频动作，如果每次都要求打开完整的任务编辑弹窗，
 * 步骤太多（点行 → 找到记录区块 → 点添加 → 写 → 存）。
 * 这个弹窗只做一件事：写一句话，选个类型，存。
 *
 * 入口在任务行的动作面板里，点「记一笔进展」直接弹出。
 */

import { useEffect, useState } from 'react';
import type { Task, TaskLogKind } from '../types';

const KIND_OPTIONS: { value: TaskLogKind; label: string; active: string }[] = [
  { value: 'note', label: '记录', active: 'bg-[var(--color-card-muted)] text-[var(--color-text)]' },
  { value: 'contact', label: '沟通', active: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  { value: 'waiting', label: '等回复', active: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300' },
  { value: 'issue', label: '发现问题', active: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' },
  { value: 'progress', label: '有进展', active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
];

interface QuickLogDialogProps {
  task: Task;
  onSave: (content: string, kind: TaskLogKind) => Promise<void>;
  onCancel: () => void;
}

export function QuickLogDialog({ task, onSave, onCancel }: QuickLogDialogProps) {
  const [content, setContent] = useState<string>('');
  const [kind, setKind] = useState<TaskLogKind>('note');
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !saving) {
        onCancel();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, saving]);

  async function handleSave(): Promise<void> {
    const text: string = content.trim();
    if (text === '' || saving) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(text, kind);
    } catch (e: unknown) {
      setSaving(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className="fixed inset-0 z-[65] flex items-end justify-center bg-slate-900/40 px-0 sm:items-center sm:px-4"
      role="presentation"
      onClick={() => {
        if (!saving) {
          onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="记一笔进展"
        className="w-full rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-2xl sm:max-w-[520px] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--color-text)]">记一笔进展</h2>
          <p className="mt-1 wrap-anywhere text-xs text-[var(--color-text-muted)]">
            {task.title}
          </p>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-wrap gap-1.5">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setKind(option.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  kind === option.value
                    ? option.active + ' ring-1 ring-inset ring-current'
                    : 'bg-[var(--color-card-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <textarea
            autoFocus
            rows={4}
            placeholder="跟谁沟通了？卡在哪？有什么新进展？"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-brand)]"
          />

          {error !== '' && (
            <p className="rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
              {error}
            </p>
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
            disabled={saving || content.trim() === ''}
            onClick={() => {
              void handleSave();
            }}
            className="h-10 min-w-[88px] rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition disabled:opacity-50"
          >
            {saving ? '保存中…' : '记一笔'}
          </button>
        </div>
      </div>
    </div>
  );
}

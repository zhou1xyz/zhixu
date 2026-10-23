/**
 * CompleteDialog —— 完成任务时弹出的独立窗口
 *
 * 为什么不用行内表单：在表格行里展开输入框会把整行撑高、打乱列对齐。
 * 独立弹窗不占用列表空间，布局永远稳定。
 *
 * 窗口内容（从上到下）：
 *   1. 完成标准（如果设过）—— 提醒你核对，满足条件了再勾完成
 *   2. 工时结算：系统自动算，默认只读，可手动修正
 *      （净工时 = 现在 − 开工时刻 − 累计等待；旧任务无起点时用预估工期兜底）
 *   3. 复盘备注（可留空，支持几百字）
 */
import { useEffect, useState } from 'react';
import type { Task } from '../types';

interface CompleteDialogProps {
  task: Task;
  onConfirm: (actualHours: number | null, completionNote: string | null) => Promise<void>;
  onCancel: () => void;
}

/** 完成任务的独立弹窗：实际耗时 + 复盘备注，绝不侵入表格行内布局 */
export function CompleteDialog({ task, onConfirm, onCancel }: CompleteDialogProps) {
  // 起点到底用哪个：优先真实开工时刻，其次录入时刻。
  // 都没有说明是 v5.0 之前的老任务，只能退回预估工期。
  const spanStartRaw: string | null = task.firstStartedAt ?? task.createdAt ?? null;
  const spanStartMs: number = spanStartRaw !== null ? Date.parse(spanStartRaw) : Number.NaN;
  const waitingHours: number = task.waitingHours ?? 0;
  const hasSpan: boolean = Number.isFinite(spanStartMs);
  const elapsedHours: number = hasSpan ? Math.max(0, (Date.now() - spanStartMs) / 3600000) : 0;
  const autoWorkHours: number = hasSpan
    ? Math.max(0, elapsedHours - waitingHours)
    : Math.max(0, task.estimatedHours);

  // 净工时完全由系统算，不接受手动填写：手填的数没有依据，只会污染排期。
  const netWorkHours: number = autoWorkHours;
  const [note, setNote] = useState<string>(task.completionNote ?? '');
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !saving) {
        onCancel();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    const prev: string = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [onCancel, saving]);

  async function handleSubmit(): Promise<void> {
    if (saving) {
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onConfirm(
        Math.round(netWorkHours * 1000) / 1000,
        note.trim() === '' ? null : note.trim(),
      );
    } catch (e: unknown) {
      setSaving(false);
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
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
        aria-label={`完成：${task.title}`}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-2xl sm:max-w-[560px] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--color-text)]">
            完成：<span className="wrap-anywhere">{task.title}</span>
          </h2>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            记录实际耗时和复盘备注，方便以后回看。
          </p>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {typeof task.doneCriteria === 'string' && task.doneCriteria.trim() !== '' && (
            <div className="rounded-lg border border-amber-200 bg-[var(--color-warning-soft)] px-4 py-3">
              <p className="text-xs font-semibold text-[var(--color-warning-text)]">完成标准</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--color-text)]">
                {task.doneCriteria}
              </p>
              <p className="mt-2 text-xs font-medium text-[var(--color-warning-text)]">
                请确认你是否已经满足了上述完成标准。
              </p>
            </div>
          )}

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card-muted)] px-4 py-3">
            <p className="text-xs font-semibold text-[var(--color-text-muted)]">工时结算</p>
            {hasSpan ? (
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-[11px] text-[var(--color-text-muted)]">总跨度</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-[var(--color-text-secondary)]">
                    {elapsedHours.toFixed(1)} h
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--color-text-muted)]">其中等待</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-violet-600 dark:text-violet-400">
                    {waitingHours.toFixed(1)} h
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--color-text-muted)]">净工作</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-[var(--color-brand)]">
                    {autoWorkHours.toFixed(1)} h
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                这条任务是自动计时上线前录入的，没有起点记录，按预估工期 {task.estimatedHours} h 结算。
              </p>
            )}
            <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
              等待时间不算占用——那段时间你在干别的活。只有净工作时长会占住排期。
            </p>
          </div>

          <p className="text-xs leading-5 text-[var(--color-text-muted)]">
            净工时按系统记录的时间自动计算，不可手动修改。如果你的实际情况和这个数对不上，
            多半是任务状态没有及时切换（比如做完了没点完成、开始等了没点等待中）。
          </p>

          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]">
            完成结果 / 复盘备注
            <textarea
              rows={6}
              placeholder="这个任务最终的结果是什么？交付了什么？遇到的坑和下次怎么改？"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="min-h-[140px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 text-sm leading-6 text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
            />
            <span className="text-xs font-normal text-[var(--color-text-muted)]">
              可写几百字；保存后列表里只显示 📄 图标，点任务行查看全文。
            </span>
          </label>

          {error !== '' && (
            <p className="rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">
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
            disabled={saving}
            onClick={() => {
              void handleSubmit();
            }}
            className="h-10 min-w-[104px] rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-70"
          >
            {saving ? '保存中…' : '确认完成'}
          </button>
        </div>
      </div>
    </div>
  );
}

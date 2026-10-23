/**
 * TodayPanel —— 今日事项
 *
 * 只显示「排期落在今天、且状态是待办」的任务，按开始时间升序。
 * 为什么按排期而不是按截止日期：排期才是「今天该做什么」的答案，
 * 截止日期只说明最晚什么时候交。
 *
 * 为什么不设无限高度：当天任务量会变，区高跟着变会让下面的总览区位置
 * 每天都不一样。固定最大高度 + 内部滚动，整页结构才稳。
 */

import type { Task } from '../types';
import type { ScheduledItem } from '../../shared/scheduler.ts';
import { CATEGORY_BADGE, CATEGORY_LABELS } from './category';

interface TodayPanelProps {
  tasks: Task[];
  scheduledById: Map<string, ScheduledItem>;
  onOpenActions: (task: Task) => void;
  todayKey: string;
}

/** 今天有几条排期落在这个日期上（YYYY-MM-DD，本地时区） */
export function isToday(iso: string, todayKey: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return false;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === todayKey;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TodayPanel({ tasks, scheduledById, onOpenActions, todayKey }: TodayPanelProps) {
  const rows = tasks
    .filter((t: Task) => t.status === 'todo' || t.status === undefined)
    .map((t: Task) => ({ task: t, item: scheduledById.get(t.id) }))
    .filter((r) => r.item !== undefined && isToday(r.item.startAt, todayKey))
    .sort((a, b) => Date.parse((a.item as ScheduledItem).startAt) - Date.parse((b.item as ScheduledItem).startAt));

  return (
    <section
      className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-card)]"
      style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--color-text)]">
            今日事项
            <span className="rounded-full bg-[var(--color-brand-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-brand)]">
              {rows.length}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">今天排期要做的，按开始时间排</p>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[var(--color-text-muted)]">
          今天没有排期的任务。要么已经做完，要么排期落在了后面的日子。
        </p>
      ) : (
        <ul className="max-h-[360px] divide-y divide-[var(--color-border)] overflow-y-auto">
          {rows.map(({ task, item }) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpenActions(task)}
                className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-[var(--color-card-muted)]"
              >
                <span className="w-[92px] shrink-0 text-xs tabular-nums text-[var(--color-text-secondary)]">
                  {clock((item as ScheduledItem).startAt)} → {clock((item as ScheduledItem).endAt)}
                </span>
                <span className="wrap-anywhere min-w-0 flex-1 text-sm text-[var(--color-text)]">
                  {task.title}
                </span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${CATEGORY_BADGE[task.category]}`}>
                  {CATEGORY_LABELS[task.category]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

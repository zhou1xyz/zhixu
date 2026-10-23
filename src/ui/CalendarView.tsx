/**
 * CalendarView —— 周历视图
 *
 * 回答看板回答不了的问题：「时间都去哪了」。
 * 数据零新增：直接复用排期结果（scheduledById），只是换一种呈现。
 *
 * 设计红线（有意为之，不是没做）：
 *  - 不做拖拽改期。排期是算法算出来的，允许拖动会让人以为能手动
 *    干预时间，破坏整个系统的可信度。点任务块 → 弹详情，只看不挪。
 *  - 等待中的任务不上日历。它们没有时间归属，硬塞进去会污染视图；
 *    挂起区才是它们的专属位置。
 */

import { useMemo, useState } from 'react';
import type { Task } from '../../shared/types.ts';
import type { ScheduledItem } from '../../shared/scheduler.ts';
import { STATUS_LABELS } from './format.ts';

const DAY_MS: number = 24 * 60 * 60 * 1000;

const WEEKDAY_LABELS: string[] = ['一', '二', '三', '四', '五', '六', '日'];

/** 上海时区的「今日 YYYY-MM-DD」，与 App 的 todayKey 同口径 */
export function shanghaiDateKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** 上海时区某天的 0 点（毫秒）。用 getDateTimePart 拼接避免时区偏移坑 */
function shanghaiDayStart(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+08:00`);
}

interface CellItem {
  task: Task;
  item: ScheduledItem;
  /** 该任务在本格内展示的起止（已裁剪到当天） */
  fromMin: number;
  toMin: number;
}

interface CalendarViewProps {
  tasks: Task[];
  scheduledById: Map<string, ScheduledItem>;
  onOpenActions: (task: Task) => void;
  todayKey: string;
}

export function CalendarView({ tasks, scheduledById, onOpenActions, todayKey }: CalendarViewProps) {
  // 锚点：今天。前后翻周只动这个锚点
  const [anchorMs, setAnchorMs] = useState<number>(() => shanghaiDayStart(Date.now()));
  const [weekOffset, setWeekOffset] = useState<number>(0);

  const weekStartMs: number = useMemo(() => {
    // 周一为一周之首；shanghaiDayStart 返回的是周一 0 点再加偏移
    const base = anchorMs + weekOffset * 7 * DAY_MS;
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' })
      .format(new Date(base));
    const shift: Record<string, number> = { Mon: 0, Tue: -1, Wed: -2, Thu: -3, Fri: -4, Sat: -5, Sun: -6 };
    return base + (shift[weekday] ?? 0) * DAY_MS;
  }, [anchorMs, weekOffset]);

  const days: CellItem[][] = useMemo(() => {
    const taskById: Map<string, Task> = new Map(tasks.map((t: Task) => [t.id, t]));
    const result: CellItem[][] = [];
    for (let i = 0; i < 7; i += 1) {
      const dayStart: number = weekStartMs + i * DAY_MS;
      const dayEnd: number = dayStart + DAY_MS;
      const cell: CellItem[] = [];
      for (const [taskId, item] of scheduledById) {
        const task: Task | undefined = taskById.get(taskId);
        if (!task || task.status === 'waiting') continue;
        const start: number = Date.parse(item.startAt);
        const end: number = Date.parse(item.endAt);
        if (end <= dayStart || start >= dayEnd) continue;
        cell.push({
          task,
          item,
          fromMin: Math.max(0, Math.floor((Math.max(start, dayStart) - dayStart) / 60000)),
          toMin: Math.min(DAY_MS, Math.ceil((Math.min(end, dayEnd) - dayStart) / 60000)),
        });
      }
      // 按当天开始时间升序
      cell.sort((a, b) => a.fromMin - b.fromMin || a.toMin - b.toMin);
      result.push(cell);
    }
    return result;
  }, [tasks, scheduledById, weekStartMs]);

  const weekLabel: string = useMemo(() => {
    const fmt = (ms: number): string =>
      new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
        .format(new Date(ms))
        .replace('/', '月') + '日';
    return `${fmt(weekStartMs)} — ${fmt(weekStartMs + 6 * DAY_MS)}`;
  }, [weekStartMs]);

  return (
    <section
      className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-card)]"
      style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">
          周历 <span className="ml-1 font-normal text-[var(--color-text-muted)]">{weekLabel}</span>
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="上一周"
            onClick={() => setWeekOffset((w: number) => w - 1)}
            className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => {
              setWeekOffset(0);
              setAnchorMs(shanghaiDayStart(Date.now()));
            }}
            className="tap-target rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
          >
            本周
          </button>
          <button
            type="button"
            aria-label="下一周"
            onClick={() => setWeekOffset((w: number) => w + 1)}
            className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
          >
            ›
          </button>
        </div>
      </header>

      {/* 桌面：7 列网格；手机：横向滚动，每列固定 150px */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[900px] grid-cols-7 max-lg:min-w-[1050px]">
          {WEEKDAY_LABELS.map((label: string, i: number) => {
            const dayMs: number = weekStartMs + i * DAY_MS;
            const key: string = shanghaiDateKey(dayMs);
            const isToday: boolean = key === todayKey;
            const isWeekend: boolean = i >= 5;
            return (
              <div
                key={key}
                className={`flex min-h-[220px] flex-col gap-1.5 border-r border-[var(--color-border)] p-2 last:border-r-0 ${
                  isWeekend ? 'bg-[var(--color-card-muted)]' : ''
                }`}
              >
                <div className="flex items-baseline justify-between px-0.5">
                  <span
                    className={`text-xs font-medium ${
                      isToday ? 'text-[var(--color-accent)]' : isWeekend ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    周{label}
                  </span>
                  <span
                    className={`text-[11px] tabular-nums ${
                      isToday
                        ? 'font-semibold text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)]'
                    }`}
                  >
                    {new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(
                      new Date(dayMs),
                    )}
                  </span>
                </div>

                {days[i].length === 0 ? (
                  <span className="px-0.5 text-[11px] text-[var(--color-text-muted)]">—</span>
                ) : (
                  days[i].map(({ task, item, fromMin, toMin }: CellItem) => {
                    const done: boolean = task.status === 'done';
                    const startHHmm: string = `${String(Math.floor(fromMin / 60)).padStart(2, '0')}:${String(fromMin % 60).padStart(2, '0')}`;
                    const hours: number = Math.max(1, Math.round((toMin - fromMin) / 60));
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onOpenActions(task)}
                        title={`${task.title}｜${STATUS_LABELS[task.status] ?? task.status}｜${startHHmm} 起`}
                        className={`rounded-md border px-1.5 py-1 text-left text-[11px] leading-snug transition hover:brightness-95 ${
                          done
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
                            : item.isOverdue
                              ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
                              : 'border-[var(--color-border)] bg-[var(--color-card-muted)] text-[var(--color-text)]'
                        } ${done ? 'opacity-75' : ''}`}
                      >
                        <span className="block truncate font-medium">{task.title}</span>
                        <span className="block tabular-nums opacity-70">
                          {startHHmm} · {hours}h
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]">
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm border border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950" />
          已完成
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950" />
          已超期未完成
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm border border-[var(--color-border)] bg-[var(--color-card-muted)]" />
          进行中 / 未开始
        </span>
        <span className="ml-auto">等待中的任务不占用日历</span>
      </footer>
    </section>
  );
}

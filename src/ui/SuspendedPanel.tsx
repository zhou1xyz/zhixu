/**
 * SuspendedPanel —— 挂起中（等待他人）的任务
 *
 * 放在看板右侧的窄栏里。挂起区要回答两个问题：
 *   1. 我在等谁？（waitingNote 里存的原话）
 *   2. 等了多久？（waitingHours 累计值 + 本次等待起点）
 *
 * 为什么按等待时长倒序：等最久的最可能需要催，理应排在最上面。
 * 超过 24 小时标红——那已经不是正常等待，是该主动去推了。
 */

import type { Task } from '../types';

interface SuspendedPanelProps {
  tasks: Task[];
  onOpenActions: (task: Task) => void;
  now: number;
}

/** 已等待的小时数：累计值 + 本次尚未结算的部分 */
function waitingOf(task: Task, now: number): number {
  const base = typeof task.waitingHours === 'number' ? task.waitingHours : 0;
  let live = 0;
  if (typeof task.history === 'string' && task.history !== '') {
    try {
      const log = JSON.parse(task.history) as { at: string; to: string }[];
      const last = log.length > 0 ? log[log.length - 1] : null;
      if (last !== null && last.to === 'waiting') {
        const entered = Date.parse(last.at);
        if (Number.isFinite(entered) && now > entered) {
          live = (now - entered) / 3600000;
        }
      }
    } catch {
      // 历史记录损坏就当没有，不让一块脏数据把整个看板拖垮
    }
  }
  return base + live;
}

function duration(hours: number): string {
  if (hours < 1) {
    return `${Math.round(hours * 60)} 分钟`;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)} 小时`;
  }
  return `${Math.floor(hours / 24)} 天 ${Math.round(hours % 24)} 小时`;
}

export function SuspendedPanel({ tasks, onOpenActions, now }: SuspendedPanelProps) {
  const rows = tasks
    .filter((t: Task) => t.status === 'waiting')
    .map((t: Task) => ({ task: t, hours: waitingOf(t, now) }))
    .sort((a, b) => b.hours - a.hours);

  return (
    <section
      className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-card)]"
      style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
    >
      <header className="border-b border-[var(--color-border)] px-4 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
          挂起中
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            {rows.length}
          </span>
        </h2>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">在等别人，不在你手上</p>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">没有挂起的任务</p>
      ) : (
        <ul className="max-h-[280px] divide-y divide-[var(--color-border)] overflow-y-auto">
          {rows.map(({ task, hours }) => {
            const critical: boolean = hours >= 24;
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => onOpenActions(task)}
                  className="w-full px-4 py-3 text-left transition hover:bg-[var(--color-card-muted)]"
                >
                  <p className="wrap-anywhere text-sm font-medium text-[var(--color-text)]">{task.title}</p>
                  {typeof task.waitingNote === 'string' && task.waitingNote !== '' && (
                    <p className="wrap-anywhere mt-1 text-xs text-[var(--color-text-secondary)]">
                      {task.waitingNote}
                    </p>
                  )}
                  <p className={`mt-1 text-xs tabular-nums ${critical ? 'font-medium text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
                    已等 {duration(hours)}
                    {typeof task.remindDate === 'string' && task.remindDate !== '' && (
                      <span className="ml-2">· 催办 {task.remindDate.slice(5)}</span>
                    )}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

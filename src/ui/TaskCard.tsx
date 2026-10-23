/**
 * TaskCard —— 移动端任务卡片
 *
 * 窄屏时替代表格的一种渲染形态。信息顺序：
 *   复选框 + 标题 + 更多按钮 → 类别/状态标签 → 工期 → 计划时间 → 截止日期
 *
 * 它只负责展示，点击通过回调交给上层处理。
 */
import type { Task } from '../types';
import type { ScheduledItem } from '../../shared/scheduler.ts';
import { CATEGORY_BADGE, CATEGORY_LABELS } from './category';

export type StatusKind = 'normal' | 'overdue' | 'compressed' | 'done' | 'waiting';

export interface StatusView {
  kind: StatusKind;
  label: string;
  className: string;
}

export interface TaskRowView {
  task: Task;
  depth: number;
  isParent: boolean;
  hasChildren: boolean;
  rollupStart: string | null;
  rollupEnd: string | null;
  rollupHours: number;
  descendantCount: number;
  rollupDeadline: string | null;
  status: StatusView;
  collapsed: boolean;
}

interface TaskCardProps {
  row: TaskRowView;
  item: ScheduledItem | undefined;
  onToggleCollapse: (id: string) => void;
  onOpenActions: (task: Task) => void;
  onToggleDone: (task: Task) => void;
}

const DATE_FMT: Intl.DateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_ONLY: Intl.DateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 排期时间：显示 月-日 时:分，跨日时带出日期差 */
function formatSlot(iso: string | null): { text: string; dayOffset: number } | null {
  if (iso === null) {
    return null;
  }
  const date: Date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return { text: DATE_FMT.format(date), dayOffset: 0 };
}

function formatDeadline(deadline: string | null): string | null {
  if (deadline === null || deadline === '') {
    return null;
  }
  const match: RegExpMatchArray | null = deadline.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match !== null) {
    const d: Date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return DATE_ONLY.format(d);
  }
  const parsed: Date = new Date(deadline);
  return Number.isNaN(parsed.getTime()) ? deadline : DATE_ONLY.format(parsed);
}

/** 起止落在不同日期时，结束时间补上日期 */
function slotRange(start: string | null, end: string | null): string | null {
  const s = formatSlot(start);
  const e = formatSlot(end);
  if (s === null || e === null) {
    return null;
  }
  const sd: Date = new Date(start as string);
  const ed: Date = new Date(end as string);
  const sameDay: boolean =
    sd.getFullYear() === ed.getFullYear() &&
    sd.getMonth() === ed.getMonth() &&
    sd.getDate() === ed.getDate();
  return sameDay ? `${s.text} – ${e.text}` : `${s.text} – ${DATE_FMT.format(ed)}`;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2 text-[13px] leading-5">
      <dt className="w-[4.5rem] shrink-0 text-[var(--color-text-muted)]">{label}</dt>
      <dd className="wrap-anywhere min-w-0 flex-1 text-[var(--color-text-secondary)]">{value}</dd>
    </div>
  );
}

/** 移动端任务卡片：按 复选框/标题/更多 → 分类与状态 → 工期 → 计划时间 → 截止 的顺序排布 */
export function TaskCard({
  row,
  item,
  onToggleCollapse,
  onOpenActions,
  onToggleDone,
}: TaskCardProps) {
  const task: Task = row.task;
  const done: boolean = task.isCompleted === true;

  const planText: string | null = row.isParent
    ? slotRange(row.rollupStart, row.rollupEnd)
    : done
      ? null
      : slotRange(item?.startAt ?? null, item?.endAt ?? null);

  const workText: string = row.isParent
    ? `${row.rollupHours}h（合计 ${row.descendantCount} 项）`
    : task.minHours !== task.estimatedHours
      ? `${task.estimatedHours}h（最短 ${task.minHours}h）`
      : `${task.estimatedHours}h`;

  const deadlineText: string | null = formatDeadline(
    row.isParent ? row.rollupDeadline : task.deadline,
  );

  return (
    <li className="list-none" style={{ paddingLeft: row.depth * 12 }}>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-3">
        {/* 第一行：复选框 / 标题 / 更多 */}
        <div className="flex items-start gap-1">
          <button
            type="button"
            aria-label={done ? '标记为未完成' : '标记为完成'}
            aria-pressed={done}
            onClick={() => onToggleDone(task)}
            className="tap-target -ml-1 mt-0.5 flex shrink-0 items-center justify-center rounded-lg"
          >
            <span
              aria-hidden="true"
              className={`flex h-5 w-5 items-center justify-center rounded border-2 text-xs ${
                done
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                  : 'border-[var(--color-border-strong)] bg-transparent'
              }`}
            >
              {done ? '✓' : ''}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onOpenActions(task)}
            className="wrap-anywhere min-w-0 flex-1 self-center rounded-md py-1 text-left text-[15px] font-medium leading-6 transition active:opacity-70"
          >
            <span className={done ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text)]'}>
              {task.title}
            </span>
            {row.hasChildren && (
              <span
                role="button"
                tabIndex={0}
                aria-label={row.collapsed ? '展开子任务' : '收起子任务'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse(task.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    onToggleCollapse(task.id);
                  }
                }}
                className="ml-1.5 inline-flex h-6 w-6 items-center justify-center rounded align-middle text-[var(--color-text-muted)]"
              >
                {row.collapsed ? '▸' : '▾'}
              </span>
            )}
          </button>

        </div>

        {/* 第二行：分类 / 状态 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[2.25rem]">
          {task.category !== undefined && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                CATEGORY_BADGE[task.category]
              }`}
            >
              {CATEGORY_LABELS[task.category]}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${row.status.className}`}
          >
            {row.status.label}
          </span>
        </div>

        {/* 第三～五类：工期 / 计划时间 / 截止 */}
        <dl className="mt-2 flex flex-col gap-0.5 border-t border-[var(--color-border)] pt-2 pl-[2.25rem]">
          <MetaRow label="预计工期" value={workText} />
          <MetaRow label="计划时间" value={planText ?? (done ? '已完成，无待排时段' : '尚未排期')} />
          <MetaRow label="截止日期" value={deadlineText ?? '—'} />
        </dl>

        {done && task.completionNote !== null &&
          task.completionNote !== undefined && task.completionNote !== '' && (
            <p className="mt-2 rounded-lg bg-[var(--color-card-muted)] px-2.5 py-2 text-[13px] leading-5 text-[var(--color-text-secondary)]">
              {task.completionNote}
            </p>
          )}

      </div>
    </li>
  );
}

/**
 * TaskTable —— 任务列表（桌面表格 + 移动卡片）
 *
 * 两种形态共用同一份 rows 数据，只是渲染方式不同：
 *   - 宽屏（lg 以上）用表格，信息密度高
 *   - 窄屏用卡片，触控更好点
 *
 * 这里还负责几件聚合展示的事：
 *   - 父子任务缩进、折叠
 *   - 父任务的工期/截止日期/时间段由子任务汇总
 *   - 已完成任务单独沉到底部折叠区
 *   - 顶部统计通过 onStats 上报给 App，保证统计和列表口径一致
 *
 * 注意：这个组件不做任何数据写入，所有操作都通过回调交给 App。
 */
import { useEffect, useState } from 'react';
import type { Task } from '../types';
import type { ScheduledItem } from '../../shared/scheduler.ts';
import type { TaskLog } from '../types';
import { CATEGORY_BADGE, CATEGORY_LABELS } from './category';
import { TaskCard } from './TaskCard';
import { CompleteDialog } from './CompleteDialog';
import type { TaskRowView } from './TaskCard';
import { formatStamp } from './format';

interface TaskTableProps {
  tasks: Task[];
  scheduledById: Map<string, ScheduledItem>;
  onOpenActions: (task: Task) => void;
  /** 每个任务最新一条过程记录，用于在行内显示最近进展 */
  latestLogs?: Map<string, TaskLog>;
  /** 把实际渲染的行数上报给父组件，统计与列表共用同一口径 */
  onVisibleCount?: (count: number) => void;
  /** 上报顶部统计数字：全部/已排期/已完成，全部取自同一份 tasks */
  onComplete: (
    id: string,
    isCompleted: boolean,
    actualHours: number | null,
    scheduledStartAt: string | null,
    completionNote: string | null,
  ) => Promise<void>;
}

type StatusKind = 'normal' | 'overdue' | 'compressed' | 'done' | 'waiting';

interface StatusView {
  kind: StatusKind;
  label: string;
  className: string;
}

const STATUS_STYLES: Record<StatusKind, string> = {
  normal: 'bg-[var(--color-success-soft)] text-[var(--color-success-text)] ring-emerald-500/30',
  overdue: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-red-600/20',
  compressed: 'bg-[var(--color-warning-soft)] text-[var(--color-warning-text)] ring-amber-600/20',
  done: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  waiting: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-400/30',
};

/** 截止日期按当天 23:59:59 结束（与 scheduler 口径一致） */
/**
 * 截止日期换算成当天最后一刻，用于判断这个任务排得晚不晚。
 * 口径和 scheduler 保持一致：写 10-22 表示 22 号 23:59 前完成都不算超期。
 */
function deadlineEndOf(deadline: string): number {
  const match: RegExpMatchArray | null = deadline.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match === null) {
    const parsed: number = Date.parse(deadline);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  }
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
    999,
  ).getTime();
}

const STATUS_STYLES_DONE: StatusView = {
  kind: 'done',
  label: '已完成',
  className: STATUS_STYLES.done,
};

/**
 * 表格里的时间段显示。空值统一显示成破折号，
 * 具体格式化交给共用的 formatStamp，避免三处各写一套。
 */
function formatSlot(iso: string | null): string {
  if (iso === null || iso === '') {
    return '—';
  }
  const text = formatStamp(iso);
  return Number.isNaN(new Date(iso).getTime()) ? '—' : text;
}

/**
 * 排期时间列的内容：合并显示"开始 → 结束"。
 *
 * 为什么合并：原本两列各 112px，合计占 224px 却只装了两个时间点。
 * 合成一列后省下的宽度留给标题，长标题不用挤成三行。
 */
/**
 * 截止日期只保留"月-日"。
 * 年份在这张表里几乎不变，占着宽度反而不如让标题多一点空间。
 * 数据本身仍是完整日期，只影响显示。
 */
function shortDate(value: string | null): string {
  if (value === null || value === '') {
    return '—';
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m === null ? value : `${m[2]}-${m[3]}`;
}

function planRange(row: Row, item: ScheduledItem | undefined, done: boolean): string {
  if (row.isParent) {
    if (row.rollupStart === null || row.rollupEnd === null) {
      return '—';
    }
    return `${formatSlot(row.rollupStart)} → ${formatSlot(row.rollupEnd)}`;
  }
  if (done || item === undefined) {
    return '—';
  }
  return `${formatSlot(item.startAt)} → ${formatSlot(item.endAt)}`;
}

/**
 * 根据任务状态和排期结果，决定这一行显示什么标签、什么颜色。
 *
 * 优先顺序（前面的优先）：
 *   等待中 > 已完成 > 未排期 > 超期 > 已压缩 > 正常
 *
 * 为什么等待中排最前：等待中的任务本来就不该有排期，
 * 显示"未排期"会让人以为出了问题。
 */
function statusOf(task: Task, item: ScheduledItem | undefined): StatusView {
  if (task.status === 'waiting') {
    return {
      kind: 'waiting',
      label: '等待中',
      className: STATUS_STYLES.waiting,
    };
  }
  if (task.status === 'done' || task.isCompleted === true) {
    return { kind: 'done', label: '已完成', className: STATUS_STYLES.done };
  }
  if (item === undefined) {
    return {
      kind: 'normal',
      label: '未排期',
      className: 'bg-[var(--color-card-muted)] text-[var(--color-text-muted)] ring-slate-500/20',
    };
  }
  if (item.isOverdue) {
    return { kind: 'overdue', label: '超期', className: STATUS_STYLES.overdue };
  }
  if (item.isCompressed) {
    return { kind: 'compressed', label: '已压缩', className: STATUS_STYLES.compressed };
  }
  return { kind: 'normal', label: '正常', className: STATUS_STYLES.normal };
}

interface Aggregate {
  start: string | null;
  end: string | null;
  overdue: boolean;
  compressed: boolean;
  totalHours: number;
  descendantCount: number;
  latestDeadline: string | null;
}

interface Row {
  task: Task;
  depth: number;
  isParent: boolean;
  hasChildren: boolean;
  /** 父任务由子任务拼出来的时间段与聚合信息 */
  rollupStart: string | null;
  rollupEnd: string | null;
  rollupOverdue: boolean;
  rollupCompressed: boolean;
  rollupHours: number;
  descendantCount: number;
  rollupDeadline: string | null;
}

const INDENT_PX: number = 24;

export function TaskTable({ tasks, scheduledById, onOpenActions, onComplete, onVisibleCount, latestLogs }: TaskTableProps) {
  const [completingTask, setCompletingTask] = useState<Task | null>(null);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set<string>());
  const [doneOpen, setDoneOpen] = useState<boolean>(false);

  const completedCount: number = tasks.filter(
    (task: Task) => task.isCompleted === true,
  ).length;

  const childrenByParent: Map<string, Task[]> = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId !== null && task.parentId !== '') {
      const list: Task[] = childrenByParent.get(task.parentId) ?? [];
      list.push(task);
      childrenByParent.set(task.parentId, list);
    }
  }

  // 根任务：没有父任务，或父任务已不存在（兜底，避免任务从列表里凭空消失）
  const existingIds: Set<string> = new Set<string>(tasks.map((t: Task) => t.id));
  const roots: Task[] = tasks.filter(
    (task: Task) =>
      task.parentId === null ||
      task.parentId === '' ||
      !existingIds.has(task.parentId),
  );

  /** 排期起点（毫秒）。父任务取子任务里最早的开始时间；没有排期的返回 null */
/**
 * 取任务的"时间轴位置"，用于排序。
 *
 * 父任务没有自己的排期，但子任务有，所以统一用 rollup 算出的
 * 最早开始时间，这样父任务会自然落在它第一个子任务的位置上。
 */
  function sortKeyOf(task: Task): number | null {
    const start: string | null = rollup(task).start;
    if (start === null) {
      return null;
    }
    const ms: number = Date.parse(start);
    return Number.isNaN(ms) ? null : ms;
  }

  /** 时间轴排序：有排期的按开始时间升序在前，没排期的沉底；同时刻用截止日期、标题兜底 */
  function compareTimeline(a: Task, b: Task): number {
    const ka: number | null = sortKeyOf(a);
    const kb: number | null = sortKeyOf(b);
    if (ka !== null && kb !== null && ka !== kb) {
      return ka - kb;
    }
    if (ka === null && kb !== null) {
      return 1;
    }
    if (ka !== null && kb === null) {
      return -1;
    }
    const da: number = a.deadline ? deadlineEndOf(a.deadline) : Number.POSITIVE_INFINITY;
    const db: number = b.deadline ? deadlineEndOf(b.deadline) : Number.POSITIVE_INFINITY;
    if (da !== db) {
      return da - db;
    }
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  }

  /** 子任务同一规则：先按排期，再按开始日期、截止日期、标题 */
  function compareChildren(a: Task, b: Task): number {
    const ka: number | null = sortKeyOf(a);
    const kb: number | null = sortKeyOf(b);
    if (ka !== null && kb !== null && ka !== kb) {
      return ka - kb;
    }
    if (ka === null && kb !== null) {
      return 1;
    }
    if (ka !== null && kb === null) {
      return -1;
    }
    const sa: string = a.startDate ?? '9999-12-31';
    const sb: string = b.startDate ?? '9999-12-31';
    if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
    const da: number = a.deadline ? deadlineEndOf(a.deadline) : Number.POSITIVE_INFINITY;
    const db: number = b.deadline ? deadlineEndOf(b.deadline) : Number.POSITIVE_INFINITY;
    if (da !== db) {
      return da - db;
    }
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  }

/**
 * 递归汇总一个任务及其所有后代的情况。
 *
 * 叶子任务：直接用它的排期结果。
 * 父任务：把子任务的结果合并 ——
 *   开始取最早的，结束取最晚的，工期相加，
 *   截止日期取最晚的，超期/压缩只要有一个子任务命中就算命中。
 *
 * 这就是"父任务自己不占时间、由子任务拼出时间段"的实现。
 */
  function rollup(task: Task): Aggregate {
    const kids: Task[] = childrenByParent.get(task.id) ?? [];
    if (kids.length === 0) {
      const item: ScheduledItem | undefined = scheduledById.get(task.id);
      return {
        start: item?.startAt ?? null,
        end: item?.endAt ?? null,
        overdue: item?.isOverdue === true,
        compressed: item?.isCompressed === true,
        totalHours: task.estimatedHours,
        descendantCount: 1,
        latestDeadline: task.deadline,
      };
    }
    let minStart: number = Number.POSITIVE_INFINITY;
    let maxEnd: number = Number.NEGATIVE_INFINITY;
    let overdue: boolean = false;
    let compressed: boolean = false;
    let totalHours: number = 0;
    let descendantCount: number = 0;
    let latestDeadline: string | null = null;
    for (const kid of kids) {
      const sub = rollup(kid);
      if (sub.start !== null) {
        minStart = Math.min(minStart, Date.parse(sub.start));
      }
      if (sub.end !== null) {
        maxEnd = Math.max(maxEnd, Date.parse(sub.end));
      }
      overdue = overdue || sub.overdue;
      compressed = compressed || sub.compressed;
      totalHours += sub.totalHours;
      descendantCount += sub.descendantCount;
      if (
        sub.latestDeadline !== null &&
        sub.latestDeadline !== '' &&
        (latestDeadline === null || sub.latestDeadline > latestDeadline)
      ) {
        latestDeadline = sub.latestDeadline;
      }
    }
    return {
      start: Number.isFinite(minStart) ? new Date(minStart).toISOString() : null,
      end: Number.isFinite(maxEnd) ? new Date(maxEnd).toISOString() : null,
      overdue,
      compressed,
      totalHours,
      descendantCount,
      latestDeadline,
    };
  }

  const rows: Row[] = [];
/**
 * 把任务树拍平成一行行，供表格渲染。
 *
 * 递归展开：先放父任务，再按层级放子任务。
 * 已经折叠的父任务，子任务不会被展开 —— 这就是折叠功能的实现。
 *
 * depth 用来控制缩进，每深一层缩进一级。
 */
  function pushRow(task: Task, depth: number): void {
    const kids: Task[] = childrenByParent.get(task.id) ?? [];
    const aggregate = rollup(task);
    rows.push({
      task,
      depth,
      isParent: kids.length > 0,
      hasChildren: kids.length > 0,
      rollupStart: aggregate.start,
      rollupEnd: aggregate.end,
      rollupOverdue: aggregate.overdue,
      rollupCompressed: aggregate.compressed,
      rollupHours: aggregate.totalHours,
      descendantCount: aggregate.descendantCount,
      rollupDeadline: aggregate.latestDeadline,
    });
    if (kids.length > 0 && !collapsed.has(task.id)) {
      // 子任务也按时间排，否则父任务下面照样是乱的
      for (const kid of [...kids].sort(compareChildren)) {
        pushRow(kid, depth + 1);
      }
    }
  }
  // 根任务按时间轴排序：排期早的在上，没排期的沉底
  for (const root of [...roots].sort(compareTimeline)) {
    pushRow(root, 0);
  }

  // 防止出现重复行（同一任务被多条路径引用）
  const seenRowIds: Set<string> = new Set<string>();
  const visibleRows: Row[] = rows.filter((row: Row) => {
    if (seenRowIds.has(row.task.id)) {
      return false;
    }
    seenRowIds.add(row.task.id);
    return true;
  });

  // 已完成区：只收“整棵子树都已完成”的顶层任务，避免父子被拆到两个区
/**
 * 判断一个任务及其整棵子树是否都已完成。
 *
 * 为什么要整棵：如果父任务未完成、子任务完成，
 * 直接把子任务沉到"已完成区"会让父子被拆到两个区域，看着像数据丢了。
 * 所以只有整棵都完成，才整体沉下去。
 */
  function isSubtreeDone(task: Task): boolean {
    if (task.isCompleted !== true) {
      return false;
    }
    const kids: Task[] = childrenByParent.get(task.id) ?? [];
    return kids.every((kid: Task) => isSubtreeDone(kid));
  }

  const activeRows: Row[] = visibleRows.filter(
    (row: Row) => row.depth > 0 || !isSubtreeDone(row.task),
  );
  const doneRootRows: Row[] = visibleRows.filter(
    (row: Row) => row.depth === 0 && isSubtreeDone(row.task),
  );
  const doneCount: number = doneRootRows.reduce(
    (acc: number, row: Row) => acc + 1 + row.descendantCount,
    0,
  );

  function toggleCollapse(id: string): void {
    setCollapsed((prev: Set<string>) => {
      const next: Set<string> = new Set<string>(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (tasks.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
        还没有任务，点右上角「+ 新增任务」开始。
      </div>
    );
  }

  function startCompleting(task: Task): void {
    setCompletingTask(task);
  }

  async function uncomplete(task: Task): Promise<void> {
    await onComplete(task.id, false, task.actualHours ?? null, task.scheduledStartAt ?? null, task.completionNote ?? null);
  }

  // 桌面表格与移动卡片共用同一份 rows / 回调，只切渲染形态
  const viewRows: TaskRowView[] = visibleRows.map((row: Row) => {
    const task: Task = row.task;
    const item: ScheduledItem | undefined = scheduledById.get(task.id);
    const done: boolean = task.isCompleted === true;
    let status: StatusView;
    if (row.isParent) {
      const rollupEndMs: number = row.rollupEnd !== null ? Date.parse(row.rollupEnd) : Number.NaN;
      const deadlineMs: number =
        row.rollupDeadline !== null && row.rollupDeadline !== ''
          ? deadlineEndOf(row.rollupDeadline)
          : Number.NaN;
      if (done) {
        status = STATUS_STYLES_DONE;
      } else if (
        row.rollupOverdue ||
        (Number.isFinite(rollupEndMs) && Number.isFinite(deadlineMs) && rollupEndMs > deadlineMs)
      ) {
        status = { kind: 'overdue', label: '超期', className: STATUS_STYLES.overdue };
      } else if (row.rollupCompressed) {
        status = { kind: 'compressed', label: '已压缩', className: STATUS_STYLES.compressed };
      } else if (row.rollupStart !== null) {
        status = { kind: 'normal', label: '进行中', className: STATUS_STYLES.normal };
      } else {
        status = {
          kind: 'normal',
          label: '未排期',
          className: 'bg-[var(--color-card-muted)] text-[var(--color-text-muted)] ring-slate-500/20',
        };
      }
    } else {
      status = statusOf(task, item);
    }
    return {
      task,
      depth: row.depth,
      isParent: row.isParent,
      hasChildren: row.hasChildren,
      rollupStart: row.rollupStart,
      rollupEnd: row.rollupEnd,
      rollupHours: row.rollupHours,
      descendantCount: row.descendantCount,
      rollupDeadline: row.rollupDeadline,
      status,
      collapsed: collapsed.has(task.id),
    };
  });

  useEffect(() => {
    onVisibleCount?.(activeRows.length);
  }, [activeRows.length, onVisibleCount]);

  return (
    <div>
      {completingTask !== null && (
        <CompleteDialog
          task={completingTask}
          onConfirm={async (hours: number | null, note: string | null) => {
            const target: Task = completingTask;
            const existing: ScheduledItem | undefined = scheduledById.get(target.id);
            await onComplete(target.id, true, hours, existing?.startAt ?? null, note);
            setCompletingTask(null);
          }}
          onCancel={() => setCompletingTask(null)}
        />
      )}
      <ul className="lg:hidden">
        {viewRows.filter((row: TaskRowView) => row.depth > 0 || !isSubtreeDone(row.task)).map((row: TaskRowView) => (
          <TaskCard
            key={row.task.id}
            row={row}
            item={scheduledById.get(row.task.id)}
            onToggleCollapse={toggleCollapse}
            onOpenActions={onOpenActions}
            onToggleDone={(task: Task) => {
              if (task.isCompleted === true) {
                void uncomplete(task);
              } else {
                startCompleting(task);
              }
            }}
          />
        ))}
      </ul>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full table-fixed text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs font-medium text-[var(--color-text-muted)]">
              <th className="w-9 px-2 py-2.5" />
              <th className="w-auto px-2 py-2.5 font-medium">标题</th>
              <th className="w-[120px] min-w-[120px] shrink-0 whitespace-nowrap px-2 py-2.5 font-medium">预计工期</th>
              <th className="w-[92px] min-w-[92px] shrink-0 whitespace-nowrap px-2 py-2.5 font-medium">截止日期</th>
              <th className="w-[150px] min-w-[150px] shrink-0 whitespace-nowrap px-2 py-2.5 font-medium">排期时间</th>
              <th className="w-[68px] shrink-0 whitespace-nowrap px-2 py-2.5 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {activeRows.map((row: Row, index: number) => {
              const task: Task = row.task;
              const done: boolean = task.isCompleted === true;
              const item: ScheduledItem | undefined = scheduledById.get(task.id);
              const parentStatus: StatusView = (() => {
                if (done) {
                  return STATUS_STYLES_DONE;
                }
                const rollupEndMs: number =
                  row.rollupEnd !== null ? Date.parse(row.rollupEnd) : Number.NaN;
                const deadlineMs: number =
                  row.rollupDeadline !== null && row.rollupDeadline !== ''
                    ? deadlineEndOf(row.rollupDeadline)
                    : Number.NaN;
                if (
                  row.rollupOverdue ||
                  (Number.isFinite(rollupEndMs) && Number.isFinite(deadlineMs) && rollupEndMs > deadlineMs)
                ) {
                  return { kind: 'overdue', label: '超期', className: STATUS_STYLES.overdue };
                }
                if (row.rollupCompressed) {
                  return { kind: 'compressed', label: '已压缩', className: STATUS_STYLES.compressed };
                }
                if (row.rollupStart !== null) {
                  return { kind: 'normal', label: '进行中', className: STATUS_STYLES.normal };
                }
                return { kind: 'normal', label: '未排期', className: 'bg-[var(--color-card-muted)] text-[var(--color-text-muted)] ring-slate-500/20' };
              })();
              const status: StatusView = row.isParent ? parentStatus : statusOf(task, item);
              const editing: boolean = false;
              return (
                <tr
                  key={task.id}
                  onClick={() => onOpenActions(task)}
                  className={`cursor-pointer border-b border-[var(--color-border)] transition-colors last:border-0 hover:bg-[var(--color-brand-soft)]/60 ${
                    index % 2 === 1 ? 'bg-[var(--color-card-muted)]/50' : ''
                  }${
                    task.status === 'waiting' &&
                    typeof task.remindDate === 'string' &&
                    task.remindDate !== '' &&
                    task.remindDate <= new Date().toISOString().slice(0, 10)
                      ? ' bg-violet-50/60 dark:bg-violet-950/30'
                      : ''
                  }`}
                >
                  <td className="w-9 shrink-0 pl-3 pr-1 py-4 align-middle">
                    <input
                      type="checkbox"
                      checked={done}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        if (done) {
                          void uncomplete(task);
                        } else {
                          startCompleting(task);
                        }
                      }}
                      className="h-4 w-4 cursor-pointer rounded border-[var(--color-border-strong)] text-[var(--color-brand)] accent-sky-600 focus:ring-sky-200"
                    />
                  </td>
                  <td
                    className="w-auto px-2 py-4 align-middle"
                    style={{
                      paddingLeft: row.depth > 0 ? 8 + row.depth * INDENT_PX : 8,
                    }}
                  >
                    <div
                      className="flex min-w-0 items-center gap-1"
                      style={
                        row.depth > 0
                          ? {
                              borderLeft: '2px solid var(--color-border)',
                              paddingLeft: 10,
                              marginLeft: 4,
                            }
                          : undefined
                      }
                    >
                    {row.hasChildren && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollapse(task.id);
                        }}
                        className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-text-secondary)]"
                        aria-label={collapsed.has(task.id) ? '展开子任务' : '收起子任务'}
                      >
                        {collapsed.has(task.id) ? '▸' : '▾'}
                      </button>
                    )}
                    <p
                      className={`min-w-0 flex-1 wrap-anywhere break-words text-[13.5px] font-medium leading-6 ${
                        done ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text)]'
                      }`}
                    >
                      {task.title}
                    </p>
                    {typeof task.doneCriteria === 'string' &&
                      task.doneCriteria.trim() !== '' && (
                        <span
                          title={'完成标准：' + task.doneCriteria}
                          aria-label="有完成标准"
                          className="shrink-0 cursor-help text-xs leading-none"
                        >
                          ✅
                        </span>
                      )}
                    {done &&
                      typeof task.completionNote === 'string' &&
                      task.completionNote.trim() !== '' && (
                        <span
                          title="有完成复盘，点击任务行查看"
                          aria-label="有完成复盘"
                          className="shrink-0 cursor-help text-xs leading-none"
                        >
                          📄
                        </span>
                      )}
                    </div>
                    {latestLogs !== undefined && latestLogs.get(task.id) !== undefined && (
                      <p
                        className="mt-1 line-clamp-1 text-xs leading-5 text-[var(--color-text-muted)]"
                        title={latestLogs.get(task.id)?.content}
                        style={{ paddingLeft: row.hasChildren ? 20 : 0 }}
                      >
                        <span aria-hidden="true">📝 </span>
                        {latestLogs.get(task.id)?.content}
                      </p>
                    )}
                    {task.category !== undefined && task.category !== 'any' && (
                      <div className="mt-1 flex flex-wrap gap-1" style={{ paddingLeft: row.hasChildren ? 20 : 0 }}>
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                            CATEGORY_BADGE[task.category]
                          }`}
                        >
                          {CATEGORY_LABELS[task.category]}
                        </span>
                      </div>
                    )}
                    {!editing && done && task.actualHours !== null && task.actualHours !== undefined && (
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                        实际耗时 {task.actualHours}h
                      </p>
                    )}
                  </td>
                  <td className="w-[120px] min-w-[120px] shrink-0 whitespace-nowrap px-2 py-4 align-middle text-xs text-[var(--color-text-muted)]">
                    {row.isParent ? (
                      // 父任务汇总：小时和子任务数分两行。
                      // 以前挤在一行，内容宽度超过列宽，会盖到右边截止日期列上。
                      <span className="block leading-4">
                        <span className="block">总计 {row.rollupHours}h</span>
                        <span className="block text-[11px] text-[var(--color-text-muted)]">
                          {row.descendantCount} 个子任务
                        </span>
                      </span>
                    ) : (
                      <span>{task.estimatedHours}h</span>
                    )}
                  </td>
                  <td className="w-[120px] min-w-[120px] shrink-0 whitespace-nowrap px-2 py-4 align-middle text-xs text-[var(--color-text-muted)]">
                    {shortDate(row.isParent ? row.rollupDeadline : (task.deadline ?? null))}
                  </td>
                  <td className="w-[150px] min-w-[150px] shrink-0 whitespace-nowrap px-2 py-4 align-middle text-xs text-[var(--color-text-secondary)]">
                    {planRange(row, item, done)}
                  </td>
                  <td className="w-[68px] min-w-[68px] shrink-0 whitespace-nowrap py-4 pl-4 pr-3 align-middle">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </td>

                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {doneRootRows.length > 0 && (
        <div className="border-t border-[var(--color-border)]">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={(e) => {
              e.stopPropagation();
              setDoneOpen((prev: boolean) => !prev);
            }}
            className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-card-muted)]"
          >
            <span>已完成 {doneCount} 项</span>
            <span aria-hidden="true">{doneOpen ? '▾' : '▸'}</span>
          </button>

          {doneOpen && (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-left text-sm">
                <tbody>
                  {doneRootRows.map((row: Row) => {
                    const task: Task = row.task;
                    const note = task.completionNote;
                    return (
                      <tr
                        key={task.id}
                        onClick={() => onOpenActions(task)}
                        className="cursor-pointer border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-card-muted)]"
                      >
                        <td className="w-9 py-4 pl-3 pr-1 align-middle">
                          <input
                            type="checkbox"
                            checked
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => {
                              void uncomplete(task);
                            }}
                            className="h-4 w-4 cursor-pointer rounded accent-sky-600"
                          />
                        </td>
                        <td className="px-2 py-4 align-middle">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="wrap-anywhere text-[13.5px] font-medium leading-6 text-[var(--color-text-muted)] line-through">
                              {task.title}
                            </span>
                            {note !== null && note !== undefined && note.trim() !== '' && (
                              <span
                                title="有完成复盘，点击任务行查看"
                                aria-label="有完成复盘"
                                className="shrink-0 cursor-help text-xs leading-none"
                              >
                                📄
                              </span>
                            )}
                            {note !== null && note !== undefined && note.trim() !== '' && (
                              <span className="truncate text-xs text-[var(--color-text-muted)] opacity-70">
                                {note}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="w-[120px] shrink-0 whitespace-nowrap px-2 py-4 align-middle text-xs text-[var(--color-text-muted)]">
                          {task.actualHours !== null && task.actualHours !== undefined
                            ? '实际 ' + task.actualHours + 'h'
                            : '预计 ' + task.estimatedHours + 'h'}
                        </td>
                        <td className="w-[68px] shrink-0 whitespace-nowrap px-2 py-4 align-middle text-xs">
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300">
                            已完成
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-muted)]">
        <span>总任务数：{visibleRows.length}</span>
        <span>已完成：{completedCount}</span>
      </div>
    </div>
  );
}

/**
 * App.tsx —— 页面装配层
 * ======================
 *
 * 职责边界（刻意保持简单）：
 *   - 决定「现在显示哪个页面」（任务看板 / 时间设置）
 *   - 决定「弹窗开着还是关着」
 *   - 把 repository 的读写函数包一层，每次操作后刷新数据
 *
 * 它**不负责**：
 *   - 数据怎么加载（在 hooks/useTaskData.ts）
 *   - 排期怎么算（在 shared/scheduler.ts，前后端共用）
 *   - 表格 / 卡片长什么样（在 ui/ 下各组件）
 *
 * 所以改界面样式，通常不用动这个文件；改数据结构，才需要来这里改连线。
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  AvailabilityTemplate,
  Dependency,
  Task,
  TaskLogKind,
} from './types';
import {
  addAvailability,
  addDependency,
  addTask,
  deleteAvailability,
  deleteDependency,
  deleteTask,
  updateTask,
  completeTask,
  reopenTask,
  markWaiting,
  revokeWaiting,
  exportAllData,
  fetchSchedule,
  listTaskLogs,
  addTaskLog,
  deleteTaskLog,
} from './data/repository';
import type { ScheduleResult, ScheduledItem } from '../shared/scheduler.ts';
import { TaskTable } from './ui/TaskTable';
import { TodayPanel } from './ui/TodayPanel';
import { SuspendedPanel } from './ui/SuspendedPanel';
import { DependencyList } from './ui/DependencyList';
import { SettingsView } from './ui/SettingsView';
import { useTaskData } from './hooks/useTaskData';
import { useDialogs } from './hooks/useDialogs';
import { AppDialogs } from './ui/AppDialogs';
import { AppShell } from './ui/AppShell';
import type { View, NavItem } from './ui/AppShell';
import { CalendarView } from './ui/CalendarView';
import { applyTheme, readStoredTheme } from './ui/theme';
import type { ThemeMode } from './ui/theme';



const APP_VERSION: string = 'v5.3.1';

const NAV_ITEMS: NavItem[] = [
  { id: 'board', label: '任务', hint: '任务与依赖' },
  { id: 'calendar', label: '日历', hint: '周视图排期分布' },
  { id: 'settings', label: '时间', hint: '每周可用时间' },
];



function PrimaryButton({
  onClick,
  children,
  disabled = false,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[var(--color-brand)] active:bg-[var(--color-brand)] disabled:cursor-not-allowed disabled:bg-[var(--color-border)] disabled:text-[var(--color-text-muted)] disabled:shadow-none"
    >
      {children}
    </button>
  );
}



interface EmptyTasksProps {
  hasAvailability: boolean;
  onAdd: () => void;
  onGotoSettings: () => void;
}

function EmptyTasks({ hasAvailability, onAdd, onGotoSettings }: EmptyTasksProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-brand-soft)] text-[var(--color-brand)]">
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </div>
      <div>
        <p className="text-base font-medium text-[var(--color-text)]">先从一件想做的事开始</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-text-muted)]">
          添加任务，填写预计耗时和截止日期。知序会结合你的可用时间与任务依赖，协助你安排执行顺序。
        </p>
      </div>
      {hasAvailability ? (
        <button
          type="button"
          onClick={onAdd}
          className="mt-1 inline-flex h-10 items-center rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:bg-[var(--color-brand)]"
        >
          新增任务
        </button>
      ) : (
        <div className="mt-1 flex flex-col items-center gap-2">
          <p className="text-sm text-[var(--color-warning-text)]">
            还没有设置可用时间，排期暂时无法计算。
          </p>
          <button
            type="button"
            onClick={onGotoSettings}
            className="inline-flex h-10 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-text)] transition hover:bg-[var(--color-card-muted)]"
          >
            去设置可用时间
          </button>
        </div>
      )}
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>('board');
  // 数据加载与刷新统一交给 hook，App 只关心怎么展示
  const { tasks, dependencies, availability, latestLogs, loading, loadError, refresh, retry } = useTaskData();
  // 弹窗开关集中到 useDialogs，App 只负责编排
  const dialogs = useDialogs();
  // App 自己只用到「新增任务」这一个开关；其余全部通过 dialogs 对象传给 AppDialogs
  // App 自己只用到这两个开关；其余全部通过 dialogs 对象交给 AppDialogs
  const { setShowTaskModal, setActionTask, setShowDependencyModal } = dialogs;
  const [depsOpen, setDepsOpen] = useState<boolean>(false);
  // 全部任务默认收起：它是查漏补缺用的，不该占着首屏
  const [allTasksOpen, setAllTasksOpen] = useState<boolean>(false);
  // 顶部统计。
  // 为什么在 App 里算而不是听表格上报：总览区默认收起，表格根本不挂载，
  // 靠它上报就永远拿不到数。统计口径必须独立于「某个组件有没有渲染」。
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 有效依赖：两端任务都存在的才计数，与 DependencyList 的过滤口径一致
  const taskIds: Set<string> = useMemo(
    () => new Set<string>(tasks.map((task: Task) => task.id)),
    [tasks],
  );
  const validDependencyCount: number = useMemo(
    () =>
      dependencies.filter(
        (dep: Dependency) =>
          taskIds.has(dep.fromTaskId) && taskIds.has(dep.toTaskId),
      ).length,
    [dependencies, taskIds],
  );


  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [scheduleResult, setScheduleResult] = useState<ScheduleResult>({
    status: 'ok',
    entries: [],
    scheduled: [],
  });
  const [scheduleError, setScheduleError] = useState<string>('');

  // 数据变化后向后端要一份新排期。
  // 算法在后端：小程序 / App / 桌面端将来共用同一套逻辑，不会算出不同结果。
  // 用标志位防止快速连续操作时旧响应覆盖新响应。
  useEffect(() => {
    let cancelled: boolean = false;
    void (async () => {
      try {
        const result: ScheduleResult = (await fetchSchedule()) as ScheduleResult;
        if (cancelled) {
          return;
        }
        setScheduleResult(result);
        setScheduleError('');
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        setScheduleResult({ status: 'ok', entries: [], scheduled: [] });
        setScheduleError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tasks, dependencies, availability]);

  const scheduledById: Map<string, ScheduledItem> = useMemo(() => {
    const map: Map<string, ScheduledItem> = new Map<string, ScheduledItem>();
    if (scheduleResult.status === 'ok') {
      for (const item of scheduleResult.scheduled) {
        map.set(item.taskId, item);
      }
    }
    return map;
  }, [scheduleResult]);

  // 顶部统计：口径独立于组件渲染，直接由数据算出
  //   - 全部任务：列表里所有任务（含等待中、已完成）
  //   - 已排期：状态为待办且排期表里有它的位置
  //   - 等待中：等待他人处理，不占排期时间
  //   - 已完成：已点过完成
  const listStats: { total: number; scheduled: number; waiting: number; completed: number } = useMemo(() => {
    let scheduled = 0;
    let waiting = 0;
    let completed = 0;
    for (const task of tasks) {
      if (task.isCompleted === true || task.status === 'done') {
        completed += 1;
      } else if (task.status === 'waiting') {
        waiting += 1;
      } else if (scheduledById.has(task.id)) {
        scheduled += 1;
      }
    }
    return { total: tasks.length, scheduled, waiting, completed };
  }, [tasks, scheduledById]);

  async function handleAddTask(task: Task): Promise<void> {
    await addTask(task);
    await refresh();
  }

  async function handleUpdateTask(
    id: string,
    updates: Partial<Omit<Task, 'id'>>,
  ): Promise<void> {
    await updateTask(id, updates);
    await refresh();
  }

  async function handleDeleteTask(id: string): Promise<void> {
    await deleteTask(id);
    await refresh();
  }

  async function handleCompleteTask(
    id: string,
    isCompleted: boolean,
    actualHours: number | null,
    scheduledStartAt: string | null,
    completionNote: string | null,
  ): Promise<void> {
    if (isCompleted) {
      await completeTask(id, actualHours, scheduledStartAt, completionNote);
    } else {
      await reopenTask(id);
    }
    await refresh();
  }

  async function handleAddDependency(dep: Dependency): Promise<void> {
    await addDependency(dep);
    await refresh();
  }

  async function handleDeleteDependency(id: string): Promise<void> {
    await deleteDependency(id);
    await refresh();
  }

  async function handleAddAvailabilityMany(
    items: AvailabilityTemplate[],
  ): Promise<void> {
    for (const item of items) {
      await addAvailability(item);
    }
    await refresh();
  }

  async function handleDeleteAvailabilityMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      await deleteAvailability(id);
    }
    await refresh();
  }

  async function handleDeleteAvailability(id: string): Promise<void> {
    await deleteAvailability(id);
    await refresh();
  }

  // 等待中且催办日期已到的任务：顶部预警 + 列表高亮
  const overdueWaiting: Task[] = useMemo(() => {
    const today: string = new Date().toISOString().slice(0, 10);
    return tasks.filter(
      (task: Task) =>
        task.status === 'waiting' &&
        typeof task.remindDate === 'string' &&
        task.remindDate !== '' &&
        task.remindDate <= today,
    );
  }, [tasks]);

  // 今日分区用：本地时区的今天的日期键（YYYY-MM-DD）
  const todayKey: string = (() => {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  const globalWarning: string = (() => {
    if (scheduleError !== '') {
      return scheduleError;
    }
    if (tasks.length > 0 && availability.length === 0) {
      return '还没有设置可用时间，暂时无法排期。请到「设置」里添加可用的时间段。';
    }
    if (scheduleResult.status === 'unreachable') {
      const names: string = scheduleResult.conflictTaskIds
        .map((id: string) => tasks.find((task: Task) => task.id === id)?.title ?? id)
        .join('、');
      return `有任务装不进任何可用时间块，排期未完成：${names}。请检查工期是否过长或可用时间是否太少。`;
    }
    return '';
  })();

  return (
    <AppShell
      view={view}
      onViewChange={setView}
      theme={theme}
      onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      navItems={NAV_ITEMS}
      version={APP_VERSION}
    >
          {globalWarning !== '' && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning-text)]"
            >
              <span className="mt-0.5 shrink-0" aria-hidden="true">⚠</span>
              <span>{globalWarning}</span>
            </div>
          )}
          {overdueWaiting.length > 0 && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800 dark:border-violet-400/30 dark:bg-violet-950 dark:text-violet-300"
            >
              <span className="mt-0.5 shrink-0" aria-hidden="true">⏰</span>
              <span>
                {overdueWaiting.length} 个等待中的任务到了催办日期：
                <span className="font-medium">
                  {overdueWaiting.map((t: Task) => t.title).join('、')}
                </span>
                。可以收回自己处理，或把催办日期往后推。
              </span>
            </div>
          )}
          {loading ? (
            <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
              <div className="h-8 w-40 animate-pulse rounded bg-[var(--color-border)]" />
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
                <div className="h-64 animate-pulse rounded-xl bg-[var(--color-card)] shadow-sm" />
                <div className="h-40 animate-pulse rounded-xl bg-[var(--color-card)] shadow-sm" />
              </div>
              <p className="text-sm text-[var(--color-text-muted)]">正在加载数据…</p>
            </div>
          ) : loadError !== '' ? (
            <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-5 py-4 text-sm text-[var(--color-danger)]">
              无法连接数据服务：{loadError}
              <button
                type="button"
                onClick={() => {
                  retry();
                }}
                className="ml-2 underline underline-offset-2"
              >
                重试
              </button>
            </div>
          ) : view === 'calendar' ? (
            <div className="flex flex-col gap-5">
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold tracking-tight text-[var(--color-text)] md:text-2xl">
                  周历
                </h2>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                    className="tap-target flex h-9 w-9 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
                  >
                    <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                  </button>
                </div>
              </header>
              <CalendarView
                tasks={tasks}
                scheduledById={scheduledById}
                onOpenActions={(task: Task) => setActionTask(task)}
                todayKey={todayKey}
              />
            </div>
          ) : view === 'board' ? (
            <div className="flex flex-col gap-5">
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold tracking-tight text-[var(--color-text)] md:text-2xl">
                  任务看板
                </h2>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
                    className="tap-target flex h-9 w-9 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
                  >
                    <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void exportAllData();
                    }}
                    aria-label="导出备份"
                    className="tap-target flex h-9 items-center rounded-lg px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
                  >
                    导出
                  </button>
                </div>
              </header>

              {/* 四格统计：全部 / 已排期 / 等待中 / 已完成。
                  四个数加不齐是正常的——已排期只算待办里有排期的，
                  等待中的既不算排期也不算完成，这是口径本身决定的。 */}
              <dl className="grid grid-cols-4 gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-2.5">
                <div className="flex flex-col items-center">
                  <dt className="text-[11px] text-[var(--color-text-muted)]">全部</dt>
                  <dd className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{listStats.total}</dd>
                </div>
                <div className="flex flex-col items-center border-l border-[var(--color-border)]">
                  <dt className="text-[11px] text-[var(--color-text-muted)]">已排期</dt>
                  <dd className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{listStats.scheduled}</dd>
                </div>
                <div className="flex flex-col items-center border-l border-[var(--color-border)]">
                  <dt className="text-[11px] text-[var(--color-text-muted)]">等待中</dt>
                  <dd className="text-lg font-semibold tabular-nums text-violet-600 dark:text-violet-400">{listStats.waiting}</dd>
                </div>
                <div className="flex flex-col items-center border-l border-[var(--color-border)]">
                  <dt className="text-[11px] text-[var(--color-text-muted)]">已完成</dt>
                  <dd className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{listStats.completed}</dd>
                </div>
              </dl>

              <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <TodayPanel
                    tasks={tasks}
                    scheduledById={scheduledById}
                    onOpenActions={(task: Task) => setActionTask(task)}
                    todayKey={todayKey}
                  />

                  <section
                    className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-card)]"
                    style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
                  >
                    <button
                      type="button"
                      aria-expanded={allTasksOpen}
                      onClick={() => setAllTasksOpen((prev: boolean) => !prev)}
                      className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-[var(--color-card-muted)]"
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-semibold text-[var(--color-text)]">全部任务</span>
                          <span className="rounded-full bg-[var(--color-card-muted)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
                            {tasks.length} 条
                          </span>
                        </span>
                        <span className="mt-0.5 block text-sm text-[var(--color-text-muted)]">
                          {availability.length === 0
                            ? '尚未设置可用时间，排期暂时无法计算'
                            : allTasksOpen
                              ? '每行显示自动排期结果，点击一行可编辑'
                              : '查漏补缺用，默认收起'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowTaskModal(true);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              setShowTaskModal(true);
                            }
                          }}
                          className="rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
                        >
                          + 新增任务
                        </span>
                        <span aria-hidden="true" className="text-[var(--color-text-muted)]">
                          {allTasksOpen ? '▾' : '▸'}
                        </span>
                      </span>
                    </button>

                    {allTasksOpen && (
                      tasks.length === 0 ? (
                        <EmptyTasks
                          hasAvailability={availability.length > 0}
                          onAdd={() => setShowTaskModal(true)}
                          onGotoSettings={() => setView('settings')}
                        />
                      ) : (
                        <TaskTable
                          tasks={tasks}
                          scheduledById={scheduledById}
                          onOpenActions={(task: Task) => setActionTask(task)}
                          onComplete={handleCompleteTask}
                          latestLogs={latestLogs}
                        />
                      )
                    )}
                  </section>
                </div>

                <div className="flex min-w-0 flex-col gap-5">
                  <SuspendedPanel
                    tasks={tasks}
                    onOpenActions={(task: Task) => setActionTask(task)}
                    now={Date.now()}
                  />
                <section
                  className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-card)]"
                  style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
                >
                  <button
                    type="button"
                    aria-expanded={depsOpen}
                    onClick={() => setDepsOpen((prev: boolean) => !prev)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--color-card-muted)] md:px-5"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="text-base font-semibold text-[var(--color-text)]">依赖关系</span>
                        <span className="rounded-full bg-[var(--color-card-muted)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
                          {validDependencyCount} 条
                        </span>
                      </span>
                      <span className="mt-0.5 block text-sm text-[var(--color-text-muted)]">
                        {validDependencyCount === 0
                          ? '尚未设置任务之间的先后顺序'
                          : '约定任务之间的先后顺序'}
                      </span>
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-[var(--color-text-muted)]">
                      {depsOpen ? '▾' : '▸'}
                    </span>
                  </button>

                  {depsOpen && (
                    <div className="border-t border-[var(--color-border)]">
                      <div className="flex justify-end px-3 pt-2">
                        <PrimaryButton
                          onClick={() => setShowDependencyModal(true)}
                          disabled={tasks.length < 2}
                          title={tasks.length < 2 ? '至少需要两个任务才能建立依赖' : undefined}
                        >
                          + 新增依赖
                        </PrimaryButton>
                      </div>
                      <div className="px-3 py-2">
                        {tasks.length < 2 ? (
                          <p className="px-1 py-3 text-sm text-[var(--color-text-muted)]">
                            {tasks.length === 0
                              ? '先添加任务，再来约定它们之间的先后顺序。'
                              : '至少要有两个任务才能建立依赖。'}
                          </p>
                        ) : (
                          <DependencyList
                            dependencies={dependencies}
                            tasks={tasks}
                            onDelete={handleDeleteDependency}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </section>
                </div>
              </div>
            </div>
          ) : (
            <SettingsView
              availability={availability}
              onAddMany={handleAddAvailabilityMany}
              onDeleteMany={handleDeleteAvailabilityMany}
              onDelete={handleDeleteAvailability}
            />
          )}
      <AppDialogs
        dialogs={dialogs}
        tasks={tasks}
        dependencies={dependencies}
        scheduledById={scheduledById}
        onAddTask={handleAddTask}
        onUpdateTask={handleUpdateTask}
        onDeleteTask={handleDeleteTask}
        onCompleteTask={handleCompleteTask}
        onAddDependency={handleAddDependency}
        onRefresh={refresh}
        onLoadLogs={listTaskLogs}
        onAddLog={async (taskId: string, content: string, kind: TaskLogKind): Promise<void> => {
          await addTaskLog(taskId, content, kind);
        }}
        onDeleteLog={async (id: string): Promise<void> => {
          await deleteTaskLog(id);
        }}
        onMarkWaiting={async (id: string, remindDate: string, note: string | null): Promise<void> => {
          await markWaiting(id, remindDate, note);
        }}
        onRevokeWaiting={async (id: string, note: string | null): Promise<void> => {
          await revokeWaiting(id, note);
        }}
      />
    </AppShell>
  );
}

export default App;

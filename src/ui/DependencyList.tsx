/**
 * DependencyList —— 依赖关系列表
 *
 * 展示「A → B（依赖类型）」。
 * 两端任务只要有一端不存在（孤儿依赖），这一行直接隐藏，不显示裸 UUID。
 */
import type { Dependency, Task } from '../types';
import { DEPENDENCY_TYPE_LABELS } from './DependencyForm';

interface DependencyListProps {
  dependencies: Dependency[];
  tasks: Task[];
  onDelete: (id: string) => void;
}

export function DependencyList({ dependencies, tasks, onDelete }: DependencyListProps) {
  const titleById = new Map<string, string>(
    tasks.map((task: Task) => [task.id, task.title]),
  );

  // 防御：任一端任务已不存在（孤儿依赖）时直接隐藏，不显示 UUID
  const visible: Dependency[] = dependencies.filter(
    (dep: Dependency) =>
      titleById.has(dep.fromTaskId) && titleById.has(dep.toTaskId),
  );

  if (visible.length === 0) {
    return (
      <p className="px-1 py-4 text-sm text-[var(--color-text-muted)]">
        还没有依赖。两条任务之间可以约定先后顺序。
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {visible.map((dep: Dependency) => (
        <li
          key={dep.id}
          className="group flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--color-card-muted)]"
        >
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate text-[var(--color-text)]">
              {titleById.get(dep.fromTaskId)}
            </span>
            <span className="shrink-0 text-[var(--color-border-strong)]">→</span>
            <span className="truncate text-[var(--color-text)]">
              {titleById.get(dep.toTaskId)}
            </span>
            <span className="shrink-0 rounded bg-[var(--color-card-muted)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-text-secondary)]">
              {DEPENDENCY_TYPE_LABELS[dep.type] ?? dep.type}
            </span>
            {dep.lagDays > 0 && (
              <span className="shrink-0 rounded bg-[var(--color-card-muted)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]">
                +{dep.lagDays}天
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDelete(dep.id)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] opacity-0 transition hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus:opacity-100 group-hover:opacity-100"
          >
            删除
          </button>
        </li>
      ))}
    </ul>
  );
}

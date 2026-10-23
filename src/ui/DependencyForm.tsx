/**
 * DependencyForm —— 新增依赖的表单
 *
 * 四种依赖：FS（完成-开始）、SS（开始-开始）、FF（完成-完成）、SF（开始-完成）。
 * 外加一个 lag 天数，表示前者完成后还要等几天。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Dependency, DependencyType, Task } from '../types';
import { newId } from './id';

interface DependencyFormProps {
  tasks: Task[];
  onAdd: (dep: Dependency) => Promise<void>;
  onDone?: () => void;
}

const fieldClass: string =
  'h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-text)] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100';

const labelClass: string = 'flex flex-col gap-1.5 text-xs font-medium text-[var(--color-text-muted)]';

export const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  fs: 'FS 完成-开始',
  ss: 'SS 开始-开始',
  ff: 'FF 完成-完成',
  sf: 'SF 开始-完成',
};

export function DependencyForm({ tasks, onAdd, onDone }: DependencyFormProps) {
  const [fromTaskId, setFromTaskId] = useState<string>('');
  const [toTaskId, setToTaskId] = useState<string>('');
  const [lagDays, setLagDays] = useState<string>('0');
  const [type, setType] = useState<DependencyType>('fs');
  const [error, setError] = useState<string>('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const lag: number = Number(lagDays);

    if (fromTaskId === '' || toTaskId === '') {
      setError('请选择前置任务和后继任务');
      return;
    }
    if (fromTaskId === toTaskId) {
      setError('前置任务和后继任务不能是同一个');
      return;
    }
    if (!Number.isFinite(lag) || lag < 0) {
      setError('lag 天数必须是不小于 0 的数字');
      return;
    }

    setError('');
    await onAdd({
      id: newId(),
      fromTaskId,
      toTaskId,
      type,
      lagDays: lag,
    });
    setFromTaskId('');
    setToTaskId('');
    setLagDays('0');
    setType('fs');
    onDone?.();
  }

  if (tasks.length < 2) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-text-muted)]">
          至少需要两个任务才能建立依赖。先去右边新增任务。
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onDone?.()}
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
          >
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <label className={labelClass}>
          前置任务
          <select
            className={fieldClass}
            value={fromTaskId}
            onChange={(e) => setFromTaskId(e.target.value)}
          >
            <option value="">请选择</option>
            {tasks.map((task: Task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          后继任务
          <select
            className={fieldClass}
            value={toTaskId}
            onChange={(e) => setToTaskId(e.target.value)}
          >
            <option value="">请选择</option>
            {tasks.map((task: Task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={labelClass}>
        依赖类型
        <select
          className={fieldClass}
          value={type}
          onChange={(e) => setType(e.target.value as DependencyType)}
        >
          {(['fs', 'ss', 'ff', 'sf'] as DependencyType[]).map((value: DependencyType) => (
            <option key={value} value={value}>
              {DEPENDENCY_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        lag 天数
        <input
          className={fieldClass}
          type="number"
          min="0"
          value={lagDays}
          onChange={(e) => setLagDays(e.target.value)}
        />
      </label>
      {error !== '' && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onDone?.()}
          className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
        >
          取消
        </button>
        <button
          type="submit"
          className="h-9 rounded-md bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:bg-[var(--color-brand)]"
        >
          新增依赖
        </button>
      </div>
    </form>
  );
}

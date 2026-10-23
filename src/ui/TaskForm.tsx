/**
 * TaskForm —— 新增 / 编辑任务的表单
 *
 * 同一个组件两种模式：
 *   - 不传 editing：新增模式，提交后清空表单
 *   - 传 editing：编辑模式，预填原有值，按钮变「保存」，左下角出现「删除任务」
 *
 * 校验都在这里做（标题必填、工期为正、最短工期不能大于预计工期），
 * 校验通过才调外部传入的 onAdd / onUpdate。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Category, Task } from '../types';
import { CATEGORY_LABELS } from './category';
import { ConfirmDialog } from './ConfirmDialog';
import { newId } from './id';

interface TaskFormProps {
  tasks: Task[];
  onAdd: (task: Task) => Promise<void>;
  onDone?: () => void;
  /** 传入则是编辑模式：预填该任务，保存时回调 onUpdate */
  editing?: Task;
  onUpdate?: (id: string, updates: Partial<Omit<Task, 'id'>>) => Promise<void>;
  /** 编辑模式下传入则在左下角显示删除按钮 */
  onDelete?: (id: string) => Promise<void>;
}

const inputClass: string =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] focus:border-sky-500 focus:ring-2 focus:ring-sky-100 disabled:bg-[var(--color-card-muted)] disabled:text-[var(--color-text-muted)]';

const labelClass: string = 'flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]';

const hintClass: string = 'text-xs font-normal text-[var(--color-text-muted)]';


export function TaskForm({ tasks, onAdd, onDone, editing, onUpdate, onDelete }: TaskFormProps) {
  const isEdit: boolean = editing !== undefined;
  const [title, setTitle] = useState<string>(editing?.title ?? '');
  const [parentId, setParentId] = useState<string>(editing?.parentId ?? '');
  const [category, setCategory] = useState<Category>(editing?.category ?? 'any');
  const [estimatedHours, setEstimatedHours] = useState<string>(
    editing !== undefined ? String(editing.estimatedHours) : '',
  );
  const [minHours, setMinHours] = useState<string>(
    editing !== undefined ? String(editing.minHours) : '',
  );
  const [deadline, setDeadline] = useState<string>(editing?.deadline ?? '');
  const [startDate, setStartDate] = useState<string>(editing?.startDate ?? '');
  const [completionNote, setCompletionNote] = useState<string>(editing?.completionNote ?? '');
  const [doneCriteria, setDoneCriteria] = useState<string>(editing?.doneCriteria ?? '');
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const isSubtask: boolean = parentId !== '';

  // 父任务候选：未完成的一级任务，编辑时排除自己
  const parentCandidates: Task[] = tasks.filter(
    (task: Task) =>
      !task.isCompleted &&
      (task.parentId === null || task.parentId === '') &&
      task.id !== editing?.id,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) {
      return;
    }
    if (title.trim() === '') {
      setError('标题不能为空');
      return;
    }

    const estimated: number = Number(estimatedHours);
    const min: number = Number(minHours);
    if (!Number.isFinite(estimated) || estimated <= 0) {
      setError('预计耗时必须是大于 0 的数字');
      return;
    }
    if (!Number.isFinite(min) || min <= 0) {
      setError('单次最短安排必须是大于 0 的数字');
      return;
    }
    if (min > estimated) {
      setError('单次最短安排不能大于预计耗时');
      return;
    }

    setError('');
    setSaving(true);
    try {
      if (isEdit && editing !== undefined && onUpdate !== undefined) {
        await onUpdate(editing.id, {
          title: title.trim(),
          parentId: parentId === '' ? null : parentId,
          category,
          estimatedHours: estimated,
          minHours: min,
          deadline: deadline === '' ? null : deadline,
          startDate: startDate === '' ? null : startDate,
          completionNote: completionNote.trim() === '' ? null : completionNote.trim(),
          doneCriteria: doneCriteria.trim() === '' ? null : doneCriteria.trim(),
        });
      } else {
        await onAdd({
          id: newId(),
          title: title.trim(),
          parentId: parentId === '' ? null : parentId,
          estimatedHours: estimated,
          minHours: min,
          deadline: deadline === '' ? null : deadline,
          startDate: startDate === '' ? null : startDate,
          doneCriteria: doneCriteria.trim() === '' ? null : doneCriteria.trim(),
          actualHours: null,
          isCompleted: false,
          status: 'todo',
          category,
        });
      }
      setSaving(false);
      onDone?.();
    } catch (e: unknown) {
      setSaving(false);
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(): Promise<void> {
    if (onDelete === undefined || editing === undefined) {
      return;
    }
    setDeleting(true);
    try {
      await onDelete(editing.id);
      setDeleting(false);
      onDone?.();
    } catch (e: unknown) {
      setDeleting(false);
      setConfirmDelete(false);
      setError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className={labelClass}>
        标题
        <input
          className={inputClass}
          autoFocus
          disabled={saving || deleting}
          placeholder="比如：修改机电验收报告"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className={labelClass}>
        父任务（可选）
        <select
          className={inputClass}
          disabled={saving || deleting}
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">独立任务</option>
          {parentCandidates.map((task: Task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        任务类别
        <select
          className={inputClass}
          disabled={saving || deleting}
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
        >
          {(['any', 'work', 'personal'] as Category[]).map((value: Category) => (
            <option key={value} value={value}>
              {CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      {isSubtask && (
        <p className="rounded-md bg-[var(--color-brand-soft)] px-3 py-2 text-xs text-[var(--color-brand)]">
          这是子任务：工期和截止日期只影响它自己。父任务的工期 = 所有子任务工期之和。
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={labelClass}>
          预计耗时（小时）
          <input
            className={inputClass}
            type="number"
            step="0.5"
            min="0"
            placeholder="4"
            disabled={saving || deleting}
            value={estimatedHours}
            onChange={(e) => setEstimatedHours(e.target.value)}
          />
          <span className={hintClass}>正常情况下大概需要多久。</span>
        </label>
        <label className={labelClass}>
          单次最短安排（小时）
          <input
            className={inputClass}
            type="number"
            step="0.5"
            min="0"
            placeholder="2"
            disabled={saving || deleting}
            value={minHours}
            onChange={(e) => setMinHours(e.target.value)}
          />
          <span className={hintClass}>时间不够时会压到这个时长，不能大于预计耗时。</span>
        </label>
      </div>
      <label className={labelClass}>
        最早开始日期（可选）
        <input
          className={inputClass}
          type="date"
          disabled={saving || deleting}
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <span className={hintClass}>这一天之前不会安排这个任务；留空表示随时可以开始。</span>
      </label>
      <label className={labelClass}>
        截止日期
        <input
          className={inputClass}
          type="date"
          disabled={saving || deleting}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
        <span className={hintClass}>留空表示没有硬性期限，排期不会被压得更紧。</span>
      </label>
      <label className={labelClass}>
        完成标准（可选）
        <textarea
          rows={3}
          disabled={saving || deleting}
          placeholder="满足什么条件，这个任务才算真正完成？"
          value={doneCriteria}
          onChange={(e) => setDoneCriteria(e.target.value)}
          className="min-h-[80px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
        />
        <span className={hintClass}>勾选完成时，系统会先把这条标准摆出来让你核对。</span>
      </label>

      {isEdit && editing !== undefined && editing.isCompleted === true && (
        <label className={labelClass}>
          完成结果 / 复盘备注
          <textarea
            rows={10}
            disabled={saving || deleting}
            placeholder="这个任务最终的结果是什么？交付了什么？遇到的坑和下次怎么改？"
            value={completionNote}
            onChange={(e) => setCompletionNote(e.target.value)}
            className="min-h-[220px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 text-sm leading-6 text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
          />
          <span className={hintClass}>
            复盘时回看用，可以写几百字。保存后列表里只显示 📄 图标，点任务行查看全文。
          </span>
        </label>
      )}

      {error !== '' && (
        <p className="rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}
      <div className="mt-1 flex items-center justify-between gap-2">
        <div>
          {isEdit && onDelete !== undefined && editing !== undefined && (
            <button
              type="button"
              disabled={saving || deleting}
              onClick={() => setConfirmDelete(true)}
              className="h-10 rounded-lg border border-[var(--color-danger)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-danger)] transition hover:bg-[var(--color-danger-soft)] disabled:opacity-50"
            >
              删除任务
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving || deleting}
            onClick={() => onDone?.()}
            className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving || deleting}
            className="h-10 min-w-[88px] rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:bg-[var(--color-brand)] disabled:opacity-70"
          >
            {saving ? '保存中…' : isEdit ? '保存' : '新增任务'}
          </button>
        </div>
      </div>

      {confirmDelete && editing !== undefined && (
        <ConfirmDialog
          title="删除这个任务？"
          message={`「${editing.title}」将被删除。与它相关的依赖会一并清理，它下面的子任务会变成独立任务。`}
          confirmLabel="删除"
          busyLabel="删除中…"
          busy={deleting}
          onConfirm={() => {
            void handleDelete();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </form>
  );
}

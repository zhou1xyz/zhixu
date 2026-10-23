/**
 * AvailabilityForm —— 单条可用时间的表单
 *
 * 注意：设置页现在用的是 AvailabilityWeek（支持批量），
 * 这个组件保留作为简单的单条录入能力，导出的 WEEKDAY_LABELS 也被其他文件引用。
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AvailabilityTemplate, Category } from '../types';
import { CATEGORY_LABELS } from './category';
import { newId } from './id';

export const WEEKDAY_LABELS: string[] = [
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日',
];

interface AvailabilityFormProps {
  onAdd: (avail: AvailabilityTemplate) => Promise<void>;
}

const fieldClass: string =
  'h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100';

const labelClass: string = 'flex flex-col gap-1.5 text-xs font-medium text-slate-500';

export function AvailabilityForm({ onAdd }: AvailabilityFormProps) {
  const [weekday, setWeekday] = useState<string>('0');
  const [startTime, setStartTime] = useState<string>('19:00');
  const [endTime, setEndTime] = useState<string>('22:00');
  const [category, setCategory] = useState<Category>('any');
  const [error, setError] = useState<string>('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (startTime === '' || endTime === '') {
      setError('请填写开始时间和结束时间');
      return;
    }
    if (endTime <= startTime) {
      setError('结束时间必须晚于开始时间');
      return;
    }

    setError('');
    await onAdd({
      id: newId(),
      weekday: Number(weekday),
      startTime,
      endTime,
      category,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <label className={labelClass}>
          星期几
          <select
            className={fieldClass}
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
          >
            {WEEKDAY_LABELS.map((label: string, index: number) => (
              <option key={label} value={String(index)}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          开始时间
          <input
            className={fieldClass}
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </label>
        <label className={labelClass}>
          结束时间
          <input
            className={fieldClass}
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </label>
      </div>
      <label className={labelClass}>
        时间类别
        <select
          className={fieldClass}
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
      {error !== '' && <p className="text-xs text-red-600">{error}</p>}
      <button
        type="submit"
        className="h-9 self-end rounded-md bg-sky-600 px-4 text-sm font-medium text-white transition hover:bg-sky-700"
      >
        添加时间
      </button>
    </form>
  );
}

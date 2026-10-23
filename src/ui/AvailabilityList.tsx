/**
 * AvailabilityList —— 可用时间的扁平静态列表
 *
 * 设置页已改用 AvailabilityWeek（周视图），这里保留作为简单展示。
 */
import type { AvailabilityTemplate } from '../types';
import { WEEKDAY_LABELS } from './AvailabilityForm';
import { CATEGORY_BADGE, CATEGORY_LABELS } from './category';

interface AvailabilityListProps {
  availability: AvailabilityTemplate[];
  onDelete: (id: string) => void;
}

export function AvailabilityList({ availability, onDelete }: AvailabilityListProps) {
  if (availability.length === 0) {
    return (
      <p className="px-1 py-4 text-sm text-neutral-400">
        还没有设置可用时间。先告诉我你哪些时段能干活。
      </p>
    );
  }

  const sorted: AvailabilityTemplate[] = [...availability].sort(
    (a: AvailabilityTemplate, b: AvailabilityTemplate) =>
      a.weekday - b.weekday || a.startTime.localeCompare(b.startTime),
  );

  return (
    <ul className="divide-y divide-neutral-100">
      {sorted.map((slot: AvailabilityTemplate) => (
        <li
          key={slot.id}
          className="group flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-neutral-50"
        >
          <span className="text-sm text-neutral-700">
            <span className="font-medium">
              {WEEKDAY_LABELS[slot.weekday] ?? slot.weekday}
            </span>
            <span className="ml-2 text-neutral-500">
              {slot.startTime} – {slot.endTime}
            </span>
            <span
              className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                CATEGORY_BADGE[slot.category ?? 'any']
              }`}
            >
              {CATEGORY_LABELS[slot.category ?? 'any']}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onDelete(slot.id)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
          >
            删除
          </button>
        </li>
      ))}
    </ul>
  );
}

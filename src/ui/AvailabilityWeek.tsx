/**
 * AvailabilityWeek —— 每周可用时间的配置界面
 *
 * 按周一到周日逐行展示，每行可以有多条不重叠的时间段。
 * 支持：批量选多个星期一起加、把某天复制到其他天、清空某天。
 *
 * 冲突规则：同一天时间重叠时拦截，勾选「覆盖」才会先删旧段再写新段。
 */
import { useState } from 'react';
import type { AvailabilityTemplate, Category } from '../types';
import { CATEGORY_BADGE, CATEGORY_LABELS } from './category';
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

interface AvailabilityWeekProps {
  /** 现有时间块（扁平结构，一天可以有多条） */
  availability: AvailabilityTemplate[];
  onAddMany: (items: AvailabilityTemplate[]) => Promise<void>;
  /** 批量删除（覆盖时先删后加） */
  onDeleteMany: (ids: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

interface RuleDraft {
  startTime: string;
  endTime: string;
  category: Category;
  weekdays: number[];
  overwrite: boolean;
}

const fieldClass: string =
  'h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-text)] outline-none transition hover:border-[var(--color-border-strong)] focus:border-sky-500 focus:ring-2 focus:ring-sky-100';

const labelClass: string = 'flex flex-col gap-1.5 text-sm font-medium text-[var(--color-text)]';

const PRESETS: { label: string; weekdays: number[] }[] = [
  { label: '工作日', weekdays: [0, 1, 2, 3, 4] },
  { label: '周末', weekdays: [5, 6] },
  { label: '每天', weekdays: [0, 1, 2, 3, 4, 5, 6] },
];

function isSameMinutes(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart === bStart && aEnd === bEnd;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  // 字符串 HH:mm 可直接比较先后
  return aStart < bEnd && bStart < aEnd;
}

export function AvailabilityWeek({
  availability,
  onAddMany,
  onDeleteMany,
  onDelete,
}: AvailabilityWeekProps) {
  const [draft, setDraft] = useState<RuleDraft>({
    startTime: '09:00',
    endTime: '18:00',
    category: 'any',
    weekdays: [0, 1, 2, 3, 4],
    overwrite: false,
  });
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [copyFrom, setCopyFrom] = useState<number>(-1);
  const [copyTo, setCopyTo] = useState<number[]>([]);
  const [confirmClear, setConfirmClear] = useState<{ weekday: number } | null>(null);

  const byWeekday: Map<number, AvailabilityTemplate[]> = new Map<number, AvailabilityTemplate[]>();
  for (let day = 0; day < 7; day += 1) {
    byWeekday.set(day, []);
  }
  for (const slot of availability) {
    const list: AvailabilityTemplate[] = byWeekday.get(slot.weekday) ?? [];
    list.push(slot);
    byWeekday.set(slot.weekday, list);
  }
  for (const list of byWeekday.values()) {
    list.sort((a: AvailabilityTemplate, b: AvailabilityTemplate) => a.startTime.localeCompare(b.startTime));
  }

  function toggleWeekday(day: number): void {
    setDraft((prev: RuleDraft) => {
      const has: boolean = prev.weekdays.includes(day);
      const next: number[] = has
        ? prev.weekdays.filter((d: number) => d !== day)
        : [...prev.weekdays, day].sort((a: number, b: number) => a - b);
      return { ...prev, weekdays: next };
    });
    setError('');
  }

  async function handleSubmit(): Promise<void> {
    if (draft.weekdays.length === 0) {
      setError('请至少选择一个星期');
      return;
    }
    if (draft.startTime === '' || draft.endTime === '') {
      setError('请填写开始时间和结束时间');
      return;
    }
    if (draft.endTime <= draft.startTime) {
      setError('结束时间必须晚于开始时间');
      return;
    }

    // 冲突检查：同一天已有时间段与新区间重叠（时间重叠即可，类别不参与判断）
    const conflicts: number[] = draft.weekdays.filter((day: number) =>
      (byWeekday.get(day) ?? []).some((slot: AvailabilityTemplate) =>
        overlaps(draft.startTime, draft.endTime, slot.startTime, slot.endTime),
      ),
    );
    if (conflicts.length > 0 && !draft.overwrite) {
      setError(
        `${conflicts.map((d: number) => WEEKDAY_LABELS[d]).join('、')} 当天已有重叠的时间段。勾选“覆盖当天重叠时间段”后再提交。`,
      );
      return;
    }

    setSaving(true);
    setError('');
    try {
      // 覆盖模式：先删掉同一天与新区间重叠的旧段，再写入新段（不碰不重叠的段）
      if (draft.overwrite) {
        const overlapIds: string[] = [];
        for (const day of draft.weekdays) {
          for (const slot of byWeekday.get(day) ?? []) {
            if (overlaps(draft.startTime, draft.endTime, slot.startTime, slot.endTime)) {
              overlapIds.push(slot.id);
            }
          }
        }
        if (overlapIds.length > 0) {
          await onDeleteMany(overlapIds);
        }
      }

      const toAdd: AvailabilityTemplate[] = draft.weekdays.map((day: number) => ({
        id: newId(),
        weekday: day,
        startTime: draft.startTime,
        endTime: draft.endTime,
        category: draft.category,
      }));
      await onAddMany(toAdd);
      setNotice(
        `已应用到：${draft.weekdays.map((d: number) => WEEKDAY_LABELS[d]).join('、')}`,
      );
      setDraft((prev: RuleDraft) => ({ ...prev, overwrite: false }));
    } catch (e: unknown) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy(): Promise<void> {
    const source: AvailabilityTemplate[] = byWeekday.get(copyFrom) ?? [];
    if (source.length === 0 || copyTo.length === 0) {
      return;
    }
    setError('');
    try {
      const toAdd: AvailabilityTemplate[] = [];
      for (const day of copyTo) {
        const existing: AvailabilityTemplate[] = byWeekday.get(day) ?? [];
        for (const slot of source) {
          const dup: boolean = existing.some(
            (item: AvailabilityTemplate) =>
              isSameMinutes(item.startTime, item.endTime, slot.startTime, slot.endTime) &&
              item.category === slot.category,
          );
          if (!dup) {
            toAdd.push({
              id: newId(),
              weekday: day,
              startTime: slot.startTime,
              endTime: slot.endTime,
              category: slot.category,
            });
          }
        }
      }
      if (toAdd.length === 0) {
        setNotice('目标日期已存在相同的时间段，没有新增。');
      } else {
        await onAddMany(toAdd);
        setNotice(
          `已把${WEEKDAY_LABELS[copyFrom]}的安排复制到：${copyTo
            .map((d: number) => WEEKDAY_LABELS[d])
            .join('、')}`,
        );
      }
      setCopyFrom(-1);
      setCopyTo([]);
    } catch (e: unknown) {
      setError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleClearDay(day: number): Promise<void> {
    const list: AvailabilityTemplate[] = byWeekday.get(day) ?? [];
    for (const slot of list) {
      await onDelete(slot.id);
    }
    setConfirmClear(null);
    setNotice(`已清空 ${WEEKDAY_LABELS[day]} 的全部时间段`);
  }

  const emptyDays: number[] = [0, 1, 2, 3, 4, 5, 6].filter(
    (day: number) => (byWeekday.get(day) ?? []).length === 0,
  );

  return (
    <div className="flex flex-col gap-4">
      {emptyDays.length === 7 && (
        <p className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning-text)]">
          还没有任何可用时间。先在下方选择星期和时段，任务才有地方排。
        </p>
      )}

      {/* 周视图 */}
      <ul className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4, 5, 6].map((day: number) => {
          const list: AvailabilityTemplate[] = byWeekday.get(day) ?? [];
          return (
            <li
              key={day}
              className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex w-full items-center gap-2 sm:w-24 sm:shrink-0">
                <span className="text-sm font-medium text-[var(--color-text)]">{WEEKDAY_LABELS[day]}</span>
                <span className="text-xs text-[var(--color-text-muted)]">({list.length})</span>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                {list.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((prev: RuleDraft) => ({ ...prev, weekdays: [day] }));
                      setNotice('');
                    }}
                    className="self-start rounded-md border border-dashed border-[var(--color-border-strong)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition hover:border-sky-400 hover:text-[var(--color-brand)]"
                  >
                    + 添加时间
                  </button>
                ) : (
                  list.map((slot: AvailabilityTemplate) => (
                    <div
                      key={slot.id}
                      className="group flex items-center justify-between gap-2 rounded-md bg-[var(--color-card-muted)] px-3 py-1.5"
                    >
                      <span className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text)]">
                        <span className="font-medium tabular-nums">
                          {slot.startTime} – {slot.endTime}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                            CATEGORY_BADGE[slot.category ?? 'any']
                          }`}
                        >
                          {CATEGORY_LABELS[slot.category ?? 'any']}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setDraft({
                              startTime: slot.startTime,
                              endTime: slot.endTime,
                              category: slot.category ?? 'any',
                              weekdays: [day],
                              overwrite: true,
                            });
                            setNotice(`已载入 ${WEEKDAY_LABELS[day]} ${slot.startTime}–${slot.endTime}，改完点“应用到所选日期”即生成新时间段`);
                          }}
                          className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-card)] hover:text-[var(--color-text)]"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void onDelete(slot.id);
                          }}
                          className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                        >
                          删除
                        </button>
                      </span>
                    </div>
                  ))
                )}
              </div>
              {list.length > 0 && (
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCopyFrom(day);
                      setCopyTo([]);
                      setNotice('');
                    }}
                    className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-text)]"
                  >
                    复制到…
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear({ weekday: day })}
                    className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                  >
                    清空
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* 复制面板 */}
      {copyFrom >= 0 && (
        <div className="rounded-lg border border-[var(--color-brand)] bg-[var(--color-brand-soft)] px-4 py-3">
          <p className="text-sm text-[var(--color-brand)]">
            把 <span className="font-medium">{WEEKDAY_LABELS[copyFrom]}</span> 的
            {(byWeekday.get(copyFrom) ?? []).length} 个时间段复制到：
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[0, 1, 2, 3, 4, 5, 6]
              .filter((day: number) => day !== copyFrom)
              .map((day: number) => {
                const checked: boolean = copyTo.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() =>
                      setCopyTo((prev: number[]) =>
                        prev.includes(day)
                          ? prev.filter((d: number) => d !== day)
                          : [...prev, day].sort((a: number, b: number) => a - b),
                      )
                    }
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                      checked
                        ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                        : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-secondary)] hover:border-[var(--color-brand)]'
                    }`}
                  >
                    {WEEKDAY_LABELS[day]}
                  </button>
                );
              })}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={copyTo.length === 0}
              onClick={() => {
                void handleCopy();
              }}
              className="h-9 rounded-lg bg-[var(--color-brand)] px-3 text-sm font-medium text-white transition hover:bg-[var(--color-brand)] disabled:bg-[var(--color-border)] disabled:text-[var(--color-text-muted)]"
            >
              复制
            </button>
            <button
              type="button"
              onClick={() => {
                setCopyFrom(-1);
                setCopyTo([]);
              }}
              className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 批量添加 / 编辑表单 */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-4">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">添加时间段</h3>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          一次选中多个星期，提交后同时生效。同一天可以有多个不重叠的时间段。
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {PRESETS.map((preset: { label: string; weekdays: number[] }) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setDraft((prev: RuleDraft) => ({ ...prev, weekdays: preset.weekdays }))}
              className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-brand)] hover:text-[var(--color-brand)]"
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDraft((prev: RuleDraft) => ({ ...prev, weekdays: [] }))}
            className="rounded-md px-2.5 py-1 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-text-secondary)]"
          >
            清空选择
          </button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {WEEKDAY_LABELS.map((label: string, day: number) => {
            const checked: boolean = draft.weekdays.includes(day);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={checked}
                onClick={() => toggleWeekday(day)}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  checked
                    ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                    : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-secondary)] hover:border-[var(--color-brand)]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={labelClass}>
            开始时间
            <input
              className={fieldClass}
              type="time"
              value={draft.startTime}
              onChange={(e) => setDraft((prev: RuleDraft) => ({ ...prev, startTime: e.target.value }))}
            />
          </label>
          <label className={labelClass}>
            结束时间
            <input
              className={fieldClass}
              type="time"
              value={draft.endTime}
              onChange={(e) => setDraft((prev: RuleDraft) => ({ ...prev, endTime: e.target.value }))}
            />
          </label>
          <label className={labelClass}>
            时间类别
            <select
              className={fieldClass}
              value={draft.category}
              onChange={(e) =>
                setDraft((prev: RuleDraft) => ({ ...prev, category: e.target.value as Category }))
              }
            >
              {(['any', 'work', 'personal'] as Category[]).map((value: Category) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={draft.overwrite}
            onChange={(e) => setDraft((prev: RuleDraft) => ({ ...prev, overwrite: e.target.checked }))}
            className="h-4 w-4 accent-sky-600"
          />
          覆盖：删除所选日期里与新区间重叠的旧时间段，再写入新的
        </label>

        {error !== '' && (
          <p className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        )}
        {notice !== '' && (
          <p className="mt-3 rounded-md bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success-text)]" role="status">
            {notice}
          </p>
        )}

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              void handleSubmit();
            }}
            className="h-10 min-w-[120px] rounded-lg bg-[var(--color-brand)] px-4 text-sm font-medium text-white transition hover:bg-[var(--color-brand)] disabled:opacity-70"
          >
            {saving ? '保存中…' : '应用到所选日期'}
          </button>
        </div>
      </div>

      {confirmClear !== null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4"
          onClick={() => setConfirmClear(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-[var(--color-text)]">清空这一天的安排？</h3>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              将删除 {WEEKDAY_LABELS[confirmClear.weekday]} 的全部
              {(byWeekday.get(confirmClear.weekday) ?? []).length} 个时间段，其他日期不受影响。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmClear(null)}
                className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card-muted)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleClearDay(confirmClear.weekday);
                }}
                className="h-10 rounded-lg bg-[var(--color-danger)] px-4 text-sm font-medium text-white transition hover:bg-[var(--color-danger)]"
              >
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

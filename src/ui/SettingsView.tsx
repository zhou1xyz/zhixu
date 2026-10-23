/**
 * SettingsView —— "时间"页面
 *
 * 只负责渲染「每周可用时间」的配置界面。
 * 数据从外部传入，改动通过回调通知外层去调接口，这个组件本身不碰数据库。
 *
 * 传入：
 *   availability  已有的时间块
 *   onAddMany     批量新增
 *   onDeleteMany  批量删除（覆盖某天时用）
 *   onDelete      单条删除
 */

import type { AvailabilityTemplate } from '../types';
import { AvailabilityWeek } from './AvailabilityWeek';

interface SettingsViewProps {
  availability: AvailabilityTemplate[];
  onAddMany: (items: AvailabilityTemplate[]) => Promise<void>;
  onDeleteMany: (ids: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function SettingsView({
  availability,
  onAddMany,
  onDeleteMany,
  onDelete,
}: SettingsViewProps) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-[var(--color-text)]">
          可用时间设置
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          排期仅安排在你设定的可用时间内。让事务有序，让生活自洽。
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-5">
        <section
          className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-card)]"
          style={{ borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)' }}
        >
          <div className="border-b border-[var(--color-border)] px-5 py-4 md:px-6">
            <h3 className="text-base font-semibold text-[var(--color-text)]">每周可用时间</h3>
            <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
              共 {availability.length} 个时间段，按星期重复生效
            </p>
          </div>
          <div className="px-4 py-4 sm:px-5">
            <AvailabilityWeek
              availability={availability}
              onAddMany={onAddMany}
              onDeleteMany={onDeleteMany}
              onDelete={onDelete}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

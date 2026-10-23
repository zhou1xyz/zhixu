/**
 * 类别相关的展示约定
 *
 * 三种类别：工作 / 生活 / 不限。
 * 标签颜色统一在这里定义，避免各处写一遍。
 */
import type { Category } from '../types';

export const CATEGORY_LABELS: Record<Category, string> = {
  any: '不限',
  work: '工作',
  personal: '生活',
};

/** 类别徽标：浅色/深色都要能看清，用蓝/绿两套成对色 */
export const CATEGORY_BADGE: Record<Category, string> = {
  any: 'bg-[var(--color-card-muted)] text-[var(--color-text-secondary)] ring-[var(--color-border-strong)]/40',
  work: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/30',
  personal:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
};

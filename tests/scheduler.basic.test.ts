/**
 * 排期算法测试
 *
 * 说明：这些测试固定了"当前时间"，所以结果是完全确定的。
 * 跑法：npm test
 *
 * 时间换算：北京时间 = UTC + 8 小时。
 * 下面 T(日, 时, 分) 用来把北京时间转成 UTC 时间戳。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../shared/scheduler.ts';
import type {
  AvailabilityTemplate,
  Dependency,
  Task,
} from '../src/types/index.ts';

/** 把北京时间的某天某时某分转成时间戳（UTC） */
function T(day: number, hour: number, minute: number = 0): number {
  // 2026 年 10 月
  return Date.UTC(2026, 9, day, hour - 8, minute, 0);
}

/** 构造一个可用时间块 */
function av(
  weekday: number,
  startTime: string,
  endTime: string,
  category: 'work' | 'personal' | 'any' = 'any',
): AvailabilityTemplate {
  return { id: `av-${weekday}-${startTime}`, weekday, startTime, endTime, category };
}

/** 构造一个任务，只写测试关心的字段 */
function mk(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    parentId: null,
    estimatedHours: 1,
    minHours: 1,
    deadline: null,
    actualHours: null,
    isCompleted: false,
    category: 'any',
    status: 'todo',
    ...partial,
  };
}

/** 把排期结果格式化成「月-日 时:分」，方便断言 */
function fmt(iso: string): string {
  const d = new Date(iso);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

/** 取出某个任务在结果里的时间区间 */
function slotOf(result: ReturnType<typeof schedule>, taskId: string): { start: string; end: string } | null {
  if (result.status !== 'ok') {
    return null;
  }
  const item = result.scheduled.find((s) => s.taskId === taskId);
  return item ? { start: fmt(item.startAt), end: fmt(item.endAt) } : null;
}

// 2026-10-20 是周二（weekday=1），10-21 周三（2），10-22 周四（3）
const WEEKDAY_TUE = 1;
const WEEKDAY_WED = 2;
const WEEKDAY_THU = 3;
const WEEKDAY_SAT = 5;
const WEEKDAY_SUN = 6;

describe('基础排期', () => {
  test('单个任务落在当天可用块的起点', () => {
    const avail = [av(WEEKDAY_TUE, '09:00', '18:00')];
    const result = schedule([mk({ id: 'a', title: 'A', estimatedHours: 2 })], [], avail, {
      now: T(20, 8),
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(slotOf(result, 'a'), { start: '10-20 09:00', end: '10-20 11:00' });
  });

  test('当前时间在块中间时，从当前时间开始而不是块起点', () => {
    const avail = [av(WEEKDAY_TUE, '09:00', '18:00')];
    const result = schedule([mk({ id: 'a', title: 'A', estimatedHours: 2 })], [], avail, {
      now: T(20, 13, 2),
    });
    assert.deepEqual(slotOf(result, 'a'), { start: '10-20 13:02', end: '10-20 15:02' });
  });

  test('当天剩余时间不够时顺延到下一个可用日', () => {
    // 周二只有 3 小时且任务不允许压缩（最小=4h），必须顺延到周三
    const avail = [av(WEEKDAY_TUE, '09:00', '12:00'), av(WEEKDAY_WED, '09:00', '18:00')];
    const result = schedule(
      [mk({ id: 'a', title: 'A', estimatedHours: 4, minHours: 4 })],
      [],
      avail,
      {
      now: T(20, 8),
    });
    assert.deepEqual(slotOf(result, 'a'), { start: '10-21 09:00', end: '10-21 13:00' });
  });

  test('任务不能被拆到两天，必须落在一个连续块内', () => {
    // 每天只有 2 小时，任务 3 小时 → 必须找一天有 3 小时以上的
    // 周二周三各 2 小时都不够且不允许压缩；周四 9 小时才行
    const avail = [
      av(WEEKDAY_TUE, '09:00', '11:00'),
      av(WEEKDAY_WED, '09:00', '11:00'),
      av(WEEKDAY_THU, '09:00', '18:00'),
    ];
    const result = schedule(
      [mk({ id: 'a', title: 'A', estimatedHours: 3, minHours: 3 })],
      [],
      avail,
      {
      now: T(20, 8),
    });
    assert.deepEqual(slotOf(result, 'a'), { start: '10-22 09:00', end: '10-22 12:00' });
  });

  test('完全没有可用时间时返回不可达', () => {
    const result = schedule([mk({ id: 'a', title: 'A' })], [], [], { now: T(20, 8) });
    assert.equal(result.status, 'unreachable');
  });

  test('输出顺序与任务输入顺序无关，按优先级排', () => {
    // 两个无依赖任务，截止日期早的优先
    const avail = [av(WEEKDAY_TUE, '09:00', '18:00')];
    const late = mk({ id: 'late', title: '晚截止', estimatedHours: 2, deadline: '2026-10-25' });
    const early = mk({ id: 'early', title: '早截止', estimatedHours: 2, deadline: '2026-10-21' });
    const result = schedule([late, early], [], avail, { now: T(20, 8) });
    assert.deepEqual(slotOf(result, 'early'), { start: '10-20 09:00', end: '10-20 11:00' });
    assert.deepEqual(slotOf(result, 'late'), { start: '10-20 11:00', end: '10-20 13:00' });
  });
});

/**
 * 排期算法测试：依赖、压缩、类别、已完成占用、最早开始日期
 *
 * 所有用例都固定了"当前时间"，结果为确定的。
 * 北京时间 = UTC + 8 小时；T(日, 时, 分) 负责转换。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../shared/scheduler.ts';
import type {
  AvailabilityTemplate,
  Dependency,
  DependencyType,
  Task,
  TaskStatus,
} from '../src/types/index.ts';

function T(day: number, hour: number, minute: number = 0): number {
  return Date.UTC(2026, 9, day, hour - 8, minute, 0);
}

function av(
  weekday: number,
  startTime: string,
  endTime: string,
  category: 'work' | 'personal' | 'any' = 'any',
): AvailabilityTemplate {
  return { id: `av-${weekday}-${startTime}-${category}`, weekday, startTime, endTime, category };
}

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

function dep(
  fromTaskId: string,
  toTaskId: string,
  type: DependencyType = 'fs',
  lagDays = 0,
): Dependency {
  return { id: `dep-${fromTaskId}-${toTaskId}`, fromTaskId, toTaskId, type, lagDays };
}

function fmt(iso: string): string {
  const bj = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

function slotOf(
  result: ReturnType<typeof schedule>,
  taskId: string,
): { start: string; end: string } | null {
  if (result.status !== 'ok') {
    return null;
  }
  const item = result.scheduled.find((s) => s.taskId === taskId);
  return item ? { start: fmt(item.startAt), end: fmt(item.endAt) } : null;
}

function itemOf(result: ReturnType<typeof schedule>, taskId: string) {
  return result.status === 'ok' ? result.scheduled.find((s) => s.taskId === taskId) : undefined;
}

// 2026-10-20 周二 = 1
const TUE = 1;
const WED = 2;
const THU = 3;

// 每天 09:00-18:00 的宽窗口，避免顺延干扰依赖断言
const WIDE = [av(TUE, '09:00', '18:00'), av(WED, '09:00', '18:00'), av(THU, '09:00', '18:00')];

describe('四种依赖关系', () => {
  test('FS 完成-开始：后继在前者结束后开始', () => {
    const result = schedule(
      [mk({ id: 'A', title: 'A' }), mk({ id: 'B', title: 'B' })],
      [dep('A', 'B', 'fs')],
      WIDE,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-20 09:00', end: '10-20 10:00' });
    assert.deepEqual(slotOf(result, 'B'), { start: '10-20 10:00', end: '10-20 11:00' });
  });

  test('FS + lag 1 天：后继推迟到次日同一时刻', () => {
    const result = schedule(
      [mk({ id: 'A', title: 'A' }), mk({ id: 'B', title: 'B' })],
      [dep('A', 'B', 'fs', 1)],
      WIDE,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'B'), { start: '10-21 10:00', end: '10-21 11:00' });
  });

  test('SS 开始-开始：两者可同时开始，但单线程下后者被挤到前者结束', () => {
    // A 1h，B 1h。B 允许和 A 同时开始，但时间被 A 占住，只能等 A 结束
    const result = schedule(
      [mk({ id: 'A', title: 'A' }), mk({ id: 'B', title: 'B' })],
      [dep('A', 'B', 'ss')],
      WIDE,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-20 09:00', end: '10-20 10:00' });
    assert.deepEqual(slotOf(result, 'B'), { start: '10-20 10:00', end: '10-20 11:00' });
  });

  test('FF 完成-完成：后者最晚完成时间不早于前者', () => {
    // A 2h（09:00-11:00），B 3h。B 开始 >= A 结束 - B 工期 = 11:00 - 3h = 08:00，
    // 但当前时间是 08:00 且被 A 占用，所以 B 排在 A 之后
    const result = schedule(
      [mk({ id: 'A', title: 'A', estimatedHours: 2 }), mk({ id: 'B', title: 'B', estimatedHours: 3 })],
      [dep('A', 'B', 'ff')],
      WIDE,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'B'), { start: '10-20 11:00', end: '10-20 14:00' });
  });

  test('SF 开始-完成：后者须在前者开始后完成', () => {
    // A 1h，B 2h。B 开始 >= A 开始(09:00) - 2h = 07:00，被当前时间和 A 占用挤到 10:00
    const result = schedule(
      [mk({ id: 'A', title: 'A' }), mk({ id: 'B', title: 'B', estimatedHours: 2 })],
      [dep('A', 'B', 'sf')],
      WIDE,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'B'), { start: '10-20 10:00', end: '10-20 12:00' });
  });

  test('循环依赖直接报错，不返回排期', () => {
    assert.throws(
      () =>
        schedule(
          [mk({ id: 'A', title: 'A' }), mk({ id: 'B', title: 'B' })],
          [dep('A', 'B'), dep('B', 'A')],
          WIDE,
          { now: T(20, 8) },
        ),
      /循环依赖/,
    );
  });
});

describe('压缩模式', () => {
  test('当天放不下完整工期，压缩到最小工期塞进去', () => {
    // 周二 09:00-12:00 共 3h，任务 4h 最短 3h → 压成 3h
    const avail = [av(TUE, '09:00', '12:00')];
    const result = schedule(
      [mk({ id: 'A', title: 'A', estimatedHours: 4, minHours: 3 })],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-20 09:00', end: '10-20 12:00' });
    assert.equal(itemOf(result, 'A')?.isCompressed, true);
    assert.equal(itemOf(result, 'A')?.scheduledHours, 3);
  });

  test('压缩后仍放不下才顺延', () => {
    const avail = [av(TUE, '09:00', '12:00'), av(WED, '09:00', '18:00')];
    const result = schedule(
      [mk({ id: 'A', title: 'A', estimatedHours: 4, minHours: 4 })],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-21 09:00', end: '10-21 13:00' });
    assert.equal(itemOf(result, 'A')?.isCompressed, false);
  });
});

describe('类别隔离', () => {
  const avail = [
    av(TUE, '09:00', '12:00', 'work'),
    av(TUE, '19:00', '22:00', 'personal'),
  ];

  test('工作任务只进工作块', () => {
    const result = schedule(
      [mk({ id: 'A', title: 'A', category: 'work', estimatedHours: 2 })],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-20 09:00', end: '10-20 11:00' });
  });

  test('生活任务只进生活块', () => {
    const result = schedule(
      [mk({ id: 'A', title: 'A', category: 'personal', estimatedHours: 2 })],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-20 19:00', end: '10-20 21:00' });
  });

  test('不限任务优先占用专属块之前的时间顺序', () => {
    const result = schedule(
      [mk({ id: 'A', title: 'A', category: 'any', estimatedHours: 1 })],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-20 09:00', end: '10-20 10:00' });
  });
});

describe('状态与时间轴', () => {
  test('等待中的任务不参与排期，也不占时间', () => {
    const avail = [av(TUE, '09:00', '12:00')];
    const result = schedule(
      [
        mk({ id: 'W', title: '等待中', status: 'waiting' as TaskStatus, estimatedHours: 2 }),
        mk({ id: 'T', title: '待处理', estimatedHours: 2 }),
      ],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.equal(slotOf(result, 'W'), null);
    // 待处理任务从 09:00 开始，没有被等待中任务挤走
    assert.deepEqual(slotOf(result, 'T'), { start: '10-20 09:00', end: '10-20 11:00' });
  });

  test('已完成任务不占未来时间', () => {
    const avail = [av(TUE, '09:00', '12:00')];
    const result = schedule(
      [
        mk({
          id: 'D',
          title: '已完成',
          status: 'done' as TaskStatus,
          isCompleted: true,
          actualHours: 1,
          // 没有锁定开始时间 → 视作过去已完成
        }),
        mk({ id: 'T', title: '待处理', estimatedHours: 2 }),
      ],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'T'), { start: '10-20 09:00', end: '10-20 11:00' });
  });
});

describe('最早开始日期', () => {
  test('设置最早开始日期后，任务不会排到那一天之前', () => {
    const avail = WIDE;
    const result = schedule(
      [mk({ id: 'A', title: 'A', estimatedHours: 2, startDate: '2026-10-22' })],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.deepEqual(slotOf(result, 'A'), { start: '10-22 09:00', end: '10-22 11:00' });
  });
});

describe('父子任务', () => {
  test('父任务不占时间，子任务正常排期', () => {
    const avail = [av(TUE, '09:00', '18:00')];
    const result = schedule(
      [
        mk({ id: 'P', title: '父', estimatedHours: 0 }),
        mk({ id: 'C', title: '子', parentId: 'P', estimatedHours: 2 }),
      ],
      [],
      avail,
      { now: T(20, 8) },
    );
    assert.equal(slotOf(result, 'P'), null);
    assert.deepEqual(slotOf(result, 'C'), { start: '10-20 09:00', end: '10-20 11:00' });
  });
});

describe('互不重叠', () => {
  test('多个任务排完后两两不重叠', () => {
    const avail = [av(TUE, '09:00', '18:00')];
    const tasks = [
      mk({ id: 'a', title: 'a', estimatedHours: 1.5 }),
      mk({ id: 'b', title: 'b', estimatedHours: 2 }),
      mk({ id: 'c', title: 'c', estimatedHours: 1 }),
    ];
    const result = schedule(tasks, [], avail, { now: T(20, 8) });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') {
      return;
    }
    const sorted = [...result.scheduled].sort(
      (x, y) => new Date(x.startAt).getTime() - new Date(y.startAt).getTime(),
    );
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(
        new Date(sorted[i].startAt).getTime() >= new Date(sorted[i - 1].endAt).getTime(),
        `第 ${i} 个任务与上一个重叠`,
      );
    }
  });
});

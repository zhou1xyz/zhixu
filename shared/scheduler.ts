/**
 * 排期算法（纯函数）
 * ================
 *
 * 输入：任务列表、依赖关系、每周可用时间
 * 输出：每个任务的具体开始时间和结束时间
 *
 * 为什么是纯函数：同样的输入永远得出同样的结果，不读写数据库、不依赖真实时钟
 * （时钟通过 options.now 传入）。好处是测试可以直接固定时间点断言，
 * 出了问题也能一模一样地复现。
 *
 * 整体流程（runForward 里按顺序执行）：
 *   1. 拓扑排序：按依赖排出合法顺序；发现循环依赖直接抛错
 *   2. 第一遍：把「已完成」的任务按真实耗时占住时间线（只避让，不抬高别人的起点）
 *   3. 第二遍：给每个「待处理」任务找最早能放下的空位
 *   4. 外层包装：如果结果超期，就把超期任务压到最小工期重排，直到没有新超期
 *
 * 几条贯穿全局的规则：
 *   - 一个人单线程：任何两个任务的时段都不能重叠（occupied 占用表）
 *   - 任务不能拆：必须完整落在一个连续可用块内
 *   - 状态隔离：waiting / done 完全不参与排期，不占时间
 *   - 时区固定：所有"几点几分"都按 Asia/Shanghai 解释，不跟设备时区走
 */

import type {
  AvailabilityTemplate,
  Category,
  Dependency,
  ScheduleEntry,
  Task,
} from './types.ts';

export type ScheduleResult =
  | { status: 'not_implemented' }
  | { status: 'ok'; entries: ScheduleEntry[]; scheduled: ScheduledItem[] }
  | { status: 'unreachable'; conflictTaskIds: string[] };

const MINUTE_MS: number = 60 * 1000;

/** 支持的依赖类型 */
const DEPENDENCY_TYPES: string[] = ['fs', 'ss', 'ff', 'sf'];
const DAY_MS: number = 24 * 60 * MINUTE_MS;

/** 排期所在时区（不随浏览器/手机时区变化） */
const TIME_ZONE: string = 'Asia/Shanghai';

/** 任务排期的最早参考时间；单元测试可传入固定值 */
export interface ScheduleOptions {
  now?: number;
}

/**
 * 取某个时间戳对应的「星期几」，按 UTC 计算。
 * 用法约定：传进来的 timestamp 已经是某个本地日期的 0 点，
 * 所以它的 UTC 星期几就等于本地星期几。
 * 返回 0=周日，1=周一 … 6=周六（和 JavaScript 原生一致）。
 */
function globalWeekday(timestamp: number): number {
  return new Date(timestamp).getUTCDay();
}

let offsetFormatter: Intl.DateTimeFormat | null = null;

/**
 * 拿一个按排期时区格式化时间的工具，首次调用时创建并缓存。
 *
 * 为什么要 try/catch：某些精简运行环境不支持 timeZone 参数，
 * 会直接抛错。退化成"用系统本地时区"总比崩溃好。
 */
function getFormatter(): Intl.DateTimeFormat {
  if (offsetFormatter === null) {
    try {
      offsetFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      offsetFormatter = new Intl.DateTimeFormat('en-US', {
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  }
  return offsetFormatter;
}

interface LocalWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * 把时间戳翻译成排期时区下的「墙上时间」：年月日时分秒。
 *
 * 例：ts 表示 UTC 2026-10-20 01:00 → 北京时间 09:00，
 * 返回 { year: 2026, month: 10, day: 20, hour: 9, minute: 0 }。
 *
 * 注意 hour 要 % 24：Intl 在 hour12:false 下偶尔会给出 24 点表示午夜。
 */
function wallClockAt(timestamp: number): LocalWallClock {
  const parts: Intl.DateTimeFormatPart[] = getFormatter().formatToParts(
    new Date(timestamp),
  );
  const values: Map<string, number> = new Map<string, number>();
  for (const part of parts) {
    if (part.type !== 'literal') {
      values.set(part.type, Number(part.value));
    }
  }
  return {
    year: values.get('year') ?? 1970,
    month: values.get('month') ?? 1,
    day: values.get('day') ?? 1,
    hour: (values.get('hour') ?? 0) % 24,
    minute: values.get('minute') ?? 0,
    second: values.get('second') ?? 0,
  };
}

/** 某时刻在排期时区里的 UTC 偏移（毫秒） */
/**
 * 算出某一刻排期时区相对 UTC 的偏移（毫秒）。
 *
 * 做法：把这个时刻的「墙上时间」当成 UTC 重新拼一次，减去原始时间戳，
 * 差值就是偏移量。北京固定 +8 小时，但这样写能自动适配任何时区。
 */
function zoneOffsetAt(timestamp: number): number {
  const clock: LocalWallClock = wallClockAt(timestamp);
  const wallAsUtc: number = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return wallAsUtc - Math.floor(timestamp / 1000) * 1000;
}

/** 排期时区里某个本地自然日的 0 点（时间戳） */
/**
 * 把「第几天」换算成那一天 0 点的时间戳（排期时区）。
 *
 * 为什么要减 offset：先把本地日期当成 UTC 0 点，再减掉时区偏移，
 * 结果才是真正的那天 0 点。这一步是后面所有"几点几分"计算的地基。
 */
function dayStart(dayNumber: number): number {
  const utcDate: Date = new Date(dayNumber * DAY_MS);
  const year: number = utcDate.getUTCFullYear();
  const month: number = utcDate.getUTCMonth();
  const day: number = utcDate.getUTCDate();
  const naive: number = Date.UTC(year, month, day);
  const offset: number = zoneOffsetAt(naive);
  return naive - offset;
}

/** 排期时区里的本地自然日序号（相对 1970-01-01） */
function dayNumberOf(timestamp: number): number {
  const clock: LocalWallClock = wallClockAt(timestamp);
  return Math.round(Date.UTC(clock.year, clock.month - 1, clock.day) / DAY_MS);
}

/**
 * 解析 "09:00" 这种时间字符串，拆成小时和分钟两个数字。
 * 格式不对时直接抛错——宁可报错，也不要拿一个错的时间去排期。
 */
function parseHM(value: string): { hour: number; minute: number } {
  const pieces: string[] = value.split(':');
  const hour: number = Number(pieces[0]);
  const minute: number = Number(pieces[1]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`可用时间格式不正确：${value}`);
  }
  return { hour, minute };
}

/** 某本地日期的某个时刻（HH:mm）对应的时间戳 */
/**
 * 某天 0 点 + 几点几分 → 具体时间戳。
 *
 * 为什么直接从 naive 起步：dayStartMs 已经是「本地 0 点的时间戳」，
 * 所以 naive（0 点 + 时分）就是正确的时刻，不需要再减时区偏移。
 *
 * 为什么还要循环修正：时区偏移本身取决于算出来的这个时刻，
 * 而算这个时刻又需要偏移量，属于互相依赖。迭代两次足够收敛
 * （本项目时区没有夏令时，实际第一次就准）。
 *
 * 教训（2026-10-23）：旧版先 subtract 一次偏移再修正，修正循环只对
 * 钟点负责、不对日期负责，结果修到了「前一天的同一钟点」，
 * 周末任务全部被排到当天 00:00。
 */
function atTime(dayStartMs: number, hour: number, minute: number): number {
  const naive: number = dayStartMs + hour * 60 * MINUTE_MS + minute * MINUTE_MS;
  const expectedClockMs: number = hour * 60 * MINUTE_MS + minute * MINUTE_MS;
  // 处理夏令时切换那种偏移变化；本项目时区没有夏令时，保持简单
  let candidate: number = naive;
  for (let i = 0; i < 2; i += 1) {
    const clock: LocalWallClock = wallClockAt(candidate);
    const actualClockMs: number =
      clock.hour * 60 * MINUTE_MS + clock.minute * MINUTE_MS;
    candidate += expectedClockMs - actualClockMs;
  }
  return candidate;
}

interface Slot {
  start: number;
  end: number;
  category: Category;
}

/** 任务类别能否使用该时间块：同类别或任一方为 any */
function categoryMatches(taskCategory: Category | undefined, slotCategory: Category | undefined): boolean {
  const t: Category = taskCategory ?? 'any';
  const s: Category = slotCategory ?? 'any';
  if (t === 'any' || s === 'any') {
    return true;
  }
  return t === s;
}

interface DaySlots {
  start: number;
  weekday: number;
  slots: Slot[];
}

function buildDaySlots(cache: Map<number, DaySlots>, dayNumber: number, availability: AvailabilityTemplate[]): DaySlots {
  const cached: DaySlots | undefined = cache.get(dayNumber);
  if (cached !== undefined) {
    return cached;
  }
  const start: number = dayStart(dayNumber);
  const weekday: number = globalWeekday(start);
  const slots: Slot[] = [];
  for (const item of availability) {
    if (item.weekday !== weekday) {
      continue;
    }
    const from: { hour: number; minute: number } = parseHM(item.startTime);
    const to: { hour: number; minute: number } = parseHM(item.endTime);
    const slotStart: number = atTime(start, from.hour, from.minute);
    const slotEnd: number = atTime(start, to.hour, to.minute);
    if (slotEnd <= slotStart) {
      continue;
    }
    slots.push({
      start: slotStart,
      end: slotEnd,
      category: item.category ?? 'any',
    });
  }
  slots.sort((a: Slot, b: Slot) => a.start - b.start);
  const result: DaySlots = { start, weekday, slots };
  cache.set(dayNumber, result);
  return result;
}

/**
 * 严格对齐可用时间块：开始时间要么正好是某个块的开头，
 * 要么是块内可以完整放下整个工期的位置；跨块/越界一律不允许。
 */
interface OccupiedBlock {
  start: number;
  end: number;
}

/** 先把已占用块按开始时间排序（插入时保持有序） */
function insertBlock(blocks: OccupiedBlock[], block: OccupiedBlock): void {
  let index: number = blocks.length;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].start > block.start) {
      index = i;
      break;
    }
  }
  blocks.splice(index, 0, block);
}

function deadlineRank(task: Task): number {
  if (task.deadline === null || task.deadline === '') {
    return Number.POSITIVE_INFINITY;
  }
  const value: number = deadlineEnd(task.deadline);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

/** 可排任务之间的优先级：deadline 升序 → estimatedHours 升序 */
function comparePriority(a: Task, b: Task): number {
  const rankA: number = deadlineRank(a);
  const rankB: number = deadlineRank(b);
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }
  if (a.estimatedHours !== b.estimatedHours) {
    return a.estimatedHours - b.estimatedHours;
  }
  return 0;
}

/**
 * 拓扑排序：排出「谁必须先做」的合法顺序。
 *
 * 用经典的 Kahn 算法：
 *   1. 先找出所有没有前置任务的任务，放进待处理队列
 *   2. 每次取出一个，把它的后继任务的"剩余前置数"减一
 *   3. 减到 0 说明前置都排完了，可以进队列
 *
 * 队列按「截止日期近 → 工期短」排序，保证紧急或轻量的任务先占位。
 *
 * 如果最后排出来的数量少于任务总数，说明存在环（A 等 B、B 又等 A），
 * 直接抛错，绝不硬排一个错误的顺序。
 */
function topologicalOrder(tasks: Task[], dependencies: Dependency[]): Task[] {
  const taskById: Map<string, Task> = new Map<string, Task>();
  for (const task of tasks) {
    taskById.set(task.id, task);
  }

  const inDegree: Map<string, number> = new Map<string, number>();
  const successors: Map<string, string[]> = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    successors.set(task.id, []);
  }

  const seenPairs: Set<string> = new Set<string>();
  for (const dep of dependencies) {
    if (!taskById.has(dep.fromTaskId) || !taskById.has(dep.toTaskId)) {
      continue;
    }
    if (DEPENDENCY_TYPES.indexOf(dep.type) === -1) {
      continue;
    }
    const key: string = `${dep.fromTaskId}->${dep.toTaskId}`;
    if (seenPairs.has(key)) {
      continue;
    }
    seenPairs.add(key);
    successors.get(dep.fromTaskId)?.push(dep.toTaskId);
    inDegree.set(dep.toTaskId, (inDegree.get(dep.toTaskId) ?? 0) + 1);
  }

  // 同时可排的任务按 deadline、工期排序，保证短任务、紧急任务先占时间
  const ready: Task[] = tasks
    .filter((task: Task) => (inDegree.get(task.id) ?? 0) === 0)
    .sort(comparePriority);

  const ordered: string[] = [];
  while (ready.length > 0) {
    const current: Task = ready.shift() as Task;
    ordered.push(current.id);
    for (const nextId of successors.get(current.id) ?? []) {
      const remaining: number = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, remaining);
      if (remaining === 0) {
        const nextTask: Task | undefined = taskById.get(nextId);
        if (nextTask !== undefined) {
          ready.push(nextTask);
          ready.sort(comparePriority);
        }
      }
    }
  }

  if (ordered.length !== tasks.length) {
    const circular: string[] = tasks
      .filter((task: Task) => !ordered.includes(task.id))
      .map((task: Task) => task.id);
    throw new Error(`存在循环依赖，无法排期：${circular.join(', ')}`);
  }

  const result: Task[] = [];
  for (const id of ordered) {
    const task: Task | undefined = taskById.get(id);
    if (task !== undefined) {
      result.push(task);
    }
  }
  return result;
}

export interface ScheduledItem {
  taskId: string;
  startAt: string;
  endAt: string;
  isOverdue: boolean;
  isCompressed: boolean;
  /** 本次实际采用的工期（小时）：压缩过就小于 estimatedHours */
  scheduledHours: number;
}

type CompressedIds = Set<string>;

/** 已完成任务的真实结束时刻与其计划开始时刻 */
interface CompletedInfo {
  plannedStart: number;
  realEnd: number;
}

/** 单个可用时间块里某个空位的计算方式 */
interface Placement {
  start: number;
  end: number;
  hours: number;
  compressed: boolean;
}

interface FitRequest {
  task: Task;
  notBefore: number;
  /** 是否允许在本块内先尝试压缩到 minHours 再顺延 */
  allowShrink: boolean;
}

function hoursToMs(hours: number): number {
  return Math.max(0, hours) * 60 * MINUTE_MS;
}

/**
 * 在某个可用块内，扣除已占用时段后，找一个能放下该任务的空位。
 * allowShrink 时：放不下完整工期，但 minHours 能放下，就压缩到能放下的最大时长。
 */
/**
 * 在【一个】可用块内找空位。
 *
 * 思路：把这块时间看成一条线段，已占用的时段是线段上的障碍。
 * 从头往后扫，每两段障碍之间的空隙就是一个候选空位。
 *
 * 三种结果：
 *   - 空隙够放完整工期 → 直接用
 *   - 不够，但够放最短工期，且允许压缩 → 压缩后塞进去
 *   - 都不行 → 返回 null，交给上层换块或换天
 *
 * 特别注意：这里绝不把一个任务拆到两个空隙里，必须完整落在一段内。
 */
function findFreePlacement(
  slot: Slot,
  blocks: OccupiedBlock[],
  request: FitRequest,
): Placement | null {
  const estimated: number = Math.max(0, request.task.estimatedHours);
  const minHours: number = Math.min(estimated, Math.max(0, request.task.minHours));
  const neededFull: number = Math.max(hoursToMs(estimated), MINUTE_MS);
  const neededMin: number = Math.max(hoursToMs(minHours), MINUTE_MS);

  let cursor: number = Math.max(slot.start, request.notBefore);
  for (let i = 0; i <= blocks.length; i += 1) {
    const block: OccupiedBlock | undefined = blocks[i];
    const segmentEnd: number = block === undefined ? slot.end : Math.min(block.start, slot.end);
    if (segmentEnd > cursor) {
      const available: number = segmentEnd - cursor;
      if (available >= neededFull) {
        return { start: cursor, end: cursor + hoursToMs(estimated), hours: estimated, compressed: false };
      }
      if (request.allowShrink && available >= neededMin && minHours < estimated) {
        return { start: cursor, end: cursor + available, hours: available / (60 * MINUTE_MS), compressed: true };
      }
    }
    if (block === undefined) {
      break;
    }
    if (block.end > cursor) {
      cursor = block.end;
    }
    if (cursor >= slot.end) {
      break;
    }
  }
  return null;
}

/** 从最早起点开始遍历可用时间块，逐块尝试放下任务 */
function findPlacementInDay(
  day: DaySlots,
  blocks: OccupiedBlock[],
  request: FitRequest,
  onlyExactCategory: boolean,
): Placement | null {
  for (const slot of day.slots) {
    if (slot.end <= request.notBefore) {
      continue;
    }
    if (!categoryMatches(request.task.category, slot.category)) {
      continue;
    }
    // 精确优先轮：只接受和任务类别完全一致的时间块
    if (onlyExactCategory && slot.category !== request.task.category) {
      continue;
    }
    const placement: Placement | null = findFreePlacement(slot, blocks, request);
    if (placement !== null) {
      return placement;
    }
  }
  return null;
}

/**
 * 找空位：分两轮。
 * 第一轮只找与任务类别完全一致的块（work→work、personal→personal），
 * 第二轮才允许使用 any 块。这样白天的专属块永远优先于晚上的通用块。
 * 占用检查始终使用全局占用表，保证任何类别之间都不会重叠。
 */
/**
 * 跨多天、分两轮找空位。
 *
 * 为什么要分两轮：工作任务的候选块既有「工作专属」又有「不限」。
 * 如果只按时间顺序扫，晚上的"不限"块可能先于白天的工作块被选中，
 * 结果白天闲着、晚上干活。所以：
 *   第一轮：只接受类别完全一致的块（工作→工作，生活→生活）
 *   第二轮：才放开到"不限"块
 *
 * 最多往后找 366 天，防止极端配置（比如全年没空）时死循环。
 */
function findPlacement(
  availability: AvailabilityTemplate[],
  cache: Map<number, DaySlots>,
  blocks: OccupiedBlock[],
  request: FitRequest,
): Placement | null {
  const firstDay: number = dayNumberOf(request.notBefore);
  const taskCategory: Category = request.task.category ?? 'any';
  const rounds: boolean[] = taskCategory === 'any' ? [false] : [true, false];

  for (const onlyExact of rounds) {
    for (let offset = 0; offset <= 366; offset += 1) {
      const dayNumber: number = firstDay + offset;
      const day: DaySlots = buildDaySlots(cache, dayNumber, availability);
      const placement: Placement | null = findPlacementInDay(day, blocks, request, onlyExact);
      if (placement !== null) {
        return placement;
      }
    }
  }

  return null;
}

/**
 * 跑一遍前向排期（不含"超期再压缩"的外层循环）。
 *
 * 分两遍处理：
 *
 *   第一遍 —— 只有 status='done' 的任务参与
 *     按「完成时锁定的开始时间 + 实际耗时」算出它真实占掉的时间段。
 *     目的：后来的任务不能排进这段已发生的时间里。
 *     但如果这段早就过去了（结束时间早于现在），就不占未来时间。
 *
 *   第二遍 —— 只有 status='todo' 的任务参与
 *     逐个找最早能放下的空位。起点取以下四者的最晚值：
 *       当前时间、最早开始日期、依赖推导出的时刻、已占用表
 *     waiting（等别人）和 done 都不参与，完全不占时间。
 *
 * 遇到放不下的任务立即返回 unreachable，由 UI 提示用户调整。
 */
function runForward(
  tasks: Task[],
  dependencies: Dependency[],
  availability: AvailabilityTemplate[],
  now: number,
  compressed: CompressedIds,
): ScheduleResult {
  if (tasks.length === 0) {
    return { status: 'ok', entries: [], scheduled: [] };
  }

  const orderedTasks: Task[] = topologicalOrder(tasks, dependencies);
  const slotCache: Map<number, DaySlots> = new Map<number, DaySlots>();

  const finishedAt: Map<string, number> = new Map<string, number>();
  const entries: ScheduleEntry[] = [];
  const scheduled: ScheduledItem[] = [];

  // 单线程：所有已占用的时间块。任何任务都只能排在这些块之外。
  const occupied: OccupiedBlock[] = [];

  const taskById: Map<string, Task> = new Map<string, Task>();
  for (const task of tasks) {
    taskById.set(task.id, task);
  }

  // 父任务（有子任务的节点）只作为分组容器：不占时间块、不参与排期，
  // 它的时间段由子任务拼出来，由 UI 层计算展示。
  const parentIds: Set<string> = new Set<string>();
  for (const task of tasks) {
    if (task.parentId !== null && task.parentId !== '') {
      parentIds.add(task.parentId);
    }
  }

  const plannedStartAt: Map<string, number> = new Map<string, number>();

  // ---- 第一遍：已完成任务按真实耗时占住时间线（全局生效，与依赖无关） ----
  const completed: Map<string, CompletedInfo> = new Map<string, CompletedInfo>();
  for (const task of orderedTasks) {
    if (parentIds.has(task.id)) {
      continue;
    }
    if (task.status !== 'done') {
      continue;
    }
    // v5.0：占用时长只认净工作时长，不再用 actualHours。
    // 为什么：actualHours 是「从开工到完成」的总跨度，里面可能含大量等待
    // （函件放在别人桌上等签字）。等待时间本人是空闲的，不该挡住别的任务。
    // 优先级：workHours（系统结算）> actualHours - waitingHours（历史数据）> 预估工期
    const rawHours: number =
      typeof task.actualHours === 'number' && Number.isFinite(task.actualHours)
        ? Math.max(0, task.actualHours)
        : Math.max(0, task.estimatedHours);
    const waiting: number =
      typeof task.waitingHours === 'number' && Number.isFinite(task.waitingHours)
        ? Math.max(0, task.waitingHours)
        : 0;
    const spentHours: number =
      typeof task.workHours === 'number' && Number.isFinite(task.workHours)
        ? Math.max(0, task.workHours)
        : Math.max(0, rawHours - waiting);
    // 已完成任务占的一定是【过去】，绝不能侵占未来。
    //
    // 为什么不能用 scheduledStartAt + 净工时：
    // scheduledStartAt 记的是「那一刻它在排期表里的位置」，未开工就点完成时
    // 这个位置可能是明天甚至下周。拿它当初点，再加上几小时净工时，
    // 就会把整块未来时间标成"已占用"，后面所有任务被迫继续往后推。
    //
    // 正确做法：以完成时刻为锚，往前倒推净工时。区间永远闭合在过去，
    // 今天的活只影响今天，不会把明天吃掉。
    const finishedAtMs: number =
      typeof task.scheduledStartAt === 'string' && task.scheduledStartAt !== ''
        ? Date.parse(task.scheduledStartAt)
        : Number.NaN;
    // 完成时刻取 completedAt（服务端在状态转向 done 时盖章的唯一真实值）。
    // 绝不能退回用 scheduledStartAt：那是排期计划开始时间，未开工就点完成时
    // 它指向未来，会把还没到来的时段标成已占用。
    // 历史数据没有 completedAt 时才用 scheduledStartAt 兜底，且强制不晚于 now。
    const completedAtMs: number =
      typeof task.completedAt === 'string' && task.completedAt !== ''
        ? Date.parse(task.completedAt)
        : Number.NaN;
    const fallbackMs: number = Number.isFinite(finishedAtMs) ? finishedAtMs : Number.NaN;
    const rawEnd: number = Number.isFinite(completedAtMs)
      ? completedAtMs
      : Number.isFinite(fallbackMs)
        ? fallbackMs
        : now;
    const anchorEnd: number = Math.min(rawEnd, now);
    const realEnd: number = anchorEnd;
    const plannedStart: number = Math.max(0, realEnd - hoursToMs(spentHours));
    const info: CompletedInfo = { plannedStart, realEnd };
    completed.set(task.id, info);
    finishedAt.set(task.id, realEnd);
    plannedStartAt.set(task.id, plannedStart);

    if (realEnd > now) {
      insertBlock(occupied, { start: Math.max(now, plannedStart), end: realEnd });
    }
  }



  // ---- 第二遍：未完成任务逐个排期 ----
  for (const task of orderedTasks) {
    if (parentIds.has(task.id)) {
      continue;
    }
    // 只排待处理任务：等待中（依赖他人）与已完成都完全剔除，不占任何时间
    if (task.status !== undefined && task.status !== 'todo') {
      continue;
    }
    if (task.status === undefined && task.isCompleted === true) {
      continue;
    }

    // 起点：现在。已完成任务占住的时间块会通过 occupied 自动避开，
    // 但它的结束时刻不会抬高其他任务的起点（否则晚上做的事会污染白天排期）。
    let notBefore: number = now;
    // 最早开始日期：这一天 00:00 之前不允许排
    if (typeof task.startDate === 'string' && task.startDate !== '') {
      // 用 dayStart 把「本地日期」换算成时间戳，避免在这里写死 +08:00
      const parts: number[] = task.startDate.split('-').map((v: string) => Number(v));
      const dayNumber: number = Math.round(
        Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS,
      );
      const parsed: number = dayStart(dayNumber);
      if (Number.isFinite(parsed) && parsed > notBefore) {
        notBefore = parsed;
      }
    }


    // 依赖约束：四种类型统一换算成「后继任务的最早开始时间」
    for (const dep of dependencies) {
      if (dep.toTaskId !== task.id) {
        continue;
      }
      const predecessor: Task | undefined = taskById.get(dep.fromTaskId);
      if (predecessor === undefined) {
        continue;
      }

      const predStart: number | undefined = plannedStartAt.get(dep.fromTaskId);
      const predEnd: number | undefined =
        completed.get(dep.fromTaskId)?.realEnd ?? finishedAt.get(dep.fromTaskId);
      const lagMs: number =
        (Number.isFinite(dep.lagDays) && dep.lagDays > 0 ? dep.lagDays : 0) * DAY_MS;

      // 后继任务自身的工期（压缩前），用于 FF / SF 反推开始时间
      const successorHours: number = Math.max(0, task.estimatedHours);
      const successorMs: number = hoursToMs(successorHours);

      let anchor: number | undefined;
      switch (dep.type) {
        case 'fs':
          anchor = predEnd;
          break;
        case 'ss':
          anchor = predStart;
          break;
        case 'ff':
          anchor = predEnd;
          break;
        case 'sf':
          anchor = predStart;
          break;
        default:
          anchor = undefined;
      }
      if (anchor === undefined) {
        continue;
      }

      let candidate: number = anchor + lagMs;
      if (dep.type === 'ff' || dep.type === 'sf') {
        candidate -= successorMs;
      }
      if (candidate > notBefore) {
        notBefore = candidate;
      }
    }

    // 先试完整工期，放不下时在同一天的空位里压缩，仍放不下才顺延
    const placement: Placement | null = findPlacement(availability, slotCache, occupied, {
      task,
      notBefore,
      allowShrink: true,
    });

    if (placement === null) {
      return { status: 'unreachable', conflictTaskIds: [task.id] };
    }

    const isShrunkByFit: boolean = placement.compressed;
    if (isShrunkByFit || compressed.has(task.id)) {
      compressed.add(task.id);
    }

    finishedAt.set(task.id, placement.end);
    plannedStartAt.set(task.id, placement.start);
    insertBlock(occupied, { start: placement.start, end: placement.end });

    const startAt: string = new Date(placement.start).toISOString();
    const endAt: string = new Date(placement.end).toISOString();
    const isOverdue: boolean =
      task.deadline !== null && task.deadline !== ''
        ? placement.end > deadlineEnd(task.deadline)
        : false;

    entries.push({
      id: `${task.id}-${placement.start}`,
      taskId: task.id,
      startAt,
      endAt,
    });
    scheduled.push({
      taskId: task.id,
      startAt,
      endAt,
      isOverdue,
      isCompressed: compressed.has(task.id),
      scheduledHours: placement.hours,
    });
  }

  return { status: 'ok', entries, scheduled };
}

/** 压缩：把超期任务的工期压到 minHours，然后整体重排；仍超期则保留并继续标记超期 */
/**
 * 对外入口：算排期，必要时自动压缩。
 *
 * 流程：
 *   1. 先完整排一遍
 *   2. 如果有任务超期，把它们的工期压到最小工期再整体重排
 *   3. 重复，直到没有新的可压缩任务为止
 *
 * 为什么整体重排而不是局部调整：工期一变，后面任务的位置全都会变，
 * 局部挪动容易排出重叠或空洞，整体重算最可靠。
 *
 * 压到最小仍超期的任务保留结果并标记 isOverdue=true，
 * 让 UI 用红字提醒，而不是把问题藏起来。
 *
 * options.now 只在测试时传，生产环境不传就用真实当前时间。
 */
export function schedule(
  tasks: Task[],
  dependencies: Dependency[],
  availability: AvailabilityTemplate[],
  options?: ScheduleOptions,
): ScheduleResult {
  const now: number = options?.now ?? Date.now();
  const compressed: CompressedIds = new Set<string>();

  let result: ScheduleResult = runForward(tasks, dependencies, availability, now, compressed);
  if (result.status !== 'ok') {
    return result;
  }

  for (let round = 0; round < tasks.length + 1; round += 1) {
    const overdueIds: string[] = result.scheduled
      .filter((item: ScheduledItem) => item.isOverdue)
      .map((item: ScheduledItem) => item.taskId);

    const newlyCompressed: string[] = [];
    for (const id of overdueIds) {
      if (compressed.has(id)) {
        continue;
      }
      const task: Task | undefined = tasks.find((item: Task) => item.id === id);
      if (task === undefined) {
        continue;
      }
      const minHours: number = Math.max(0, task.minHours);
      if (minHours < Math.max(0, task.estimatedHours)) {
        compressed.add(id);
        newlyCompressed.push(id);
      }
    }

    if (newlyCompressed.length === 0) {
      break;
    }

    result = runForward(tasks, dependencies, availability, now, compressed);
    if (result.status !== 'ok') {
      return result;
    }
  }

  return result;
}

/** 截止日期按当天结束时刻算：deadline 当天 23:59:59.999 之前完成都不算超期 */
function deadlineEnd(deadline: string): number {
  const match: RegExpMatchArray | null = deadline.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match === null) {
    const parsed: number = Date.parse(deadline);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  }
  const year: number = Number(match[1]);
  const month: number = Number(match[2]);
  const day: number = Number(match[3]);
  return atTime(dayStart(Math.round(Date.UTC(year, month - 1, day) / DAY_MS)), 23, 59) + 59 * 1000 + 999;
}

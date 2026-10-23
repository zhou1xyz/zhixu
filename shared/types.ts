/**
 * 全站类型定义（唯一来源）
 *
 * 前后端共用这一份。以前 src/types/index.ts 有一份副本，加字段要改两处，
 * 迟早会不一致，所以合并到这里——改字段只改这一个文件。
 *
 * 这里的字段必须和数据库表结构一一对应。
 * 加字段时：先改这里，再改 server/index.js 的建表语句和读写映射。
 */
export type Category = 'work' | 'personal' | 'any';

/** 任务状态：待处理 / 等待中（依赖他人） / 已完成 */
export type TaskStatus = 'todo' | 'waiting' | 'done';

/** 状态流转记录（存为 JSON 文本） */
export interface TaskHistoryEntry {
  at: string;
  from: TaskStatus | null;
  to: TaskStatus;
  note?: string | null;
}

export interface Task {
  id: string;
  title: string;
  parentId: string | null;
  estimatedHours: number;
  minHours: number;
  deadline: string | null;
  actualHours?: number | null;
  isCompleted: boolean;
  /** 完成时锁定当时的排期开始时间（ISO），用来还原真实时间线 */
  scheduledStartAt?: string | null;
  /** v5.0：录入时刻，任务生命的起点（系统写入，不接受外部传值） */
  createdAt?: string | null;
  /** v5.2：完成时刻，服务端在状态转向 done 时盖章。排期占位以它为锚往前倒推 */
  completedAt?: string | null;
  /** v5.0：第一次离开「等待中」的时刻，真正的开工点 */
  firstStartedAt?: string | null;
  /** v5.0：累计等待时长（小时），进出等待时由服务端累加 */
  waitingHours?: number | null;
  /** v5.0：净工作时长（小时），完成时结算，排期占位用它 */
  workHours?: number | null;
  /** 最早开始日期（YYYY-MM-DD）：这一天之前不排 */
  startDate?: string | null;
  /** 完成标准：满足什么条件才算真正完成 */
  doneCriteria?: string | null;
  status: TaskStatus;
  /** 等待中时的催办日期（YYYY-MM-DD） */
  remindDate?: string | null;
  /** 等待中的备注，例如交给了谁 */
  waitingNote?: string | null;
  /** 流转历史，JSON 文本 */
  history?: string | null;
  /** 完成结果 / 复盘备注 */
  completionNote?: string | null;
  category: Category;
}

/** FS 完成-开始 / SS 开始-开始 / FF 完成-完成 / SF 开始-完成 */
export type DependencyType = 'fs' | 'ss' | 'ff' | 'sf';

export interface Dependency {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: DependencyType;
  lagDays: number;
}

export interface AvailabilityTemplate {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  category: Category;
}

export interface ScheduleEntry {
  id: string;
  taskId: string;
  startAt: string;
  endAt: string;
}

export interface TaskTemplate {
  id: string;
  name: string;
}

/** 过程记录的类型标签 */
export type TaskLogKind = 'note' | 'contact' | 'waiting' | 'issue' | 'progress';

/** 过程记录：人手动写的一句话，按类型归档 */
export interface TaskLog {
  id: string;
  taskId: string;
  createdAt: string;
  kind: TaskLogKind;
  content: string;
}

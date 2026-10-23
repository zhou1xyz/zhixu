/**
 * 类型定义的转发入口
 *
 * 真正的定义在 shared/types.ts（前后端共用一份）。
 * 这里只是为了让前端代码继续用 '../types' 这个短路径，
 * 不再保存任何独立定义——否则就成了第二份真相。
 */
export type {
  Category,
  TaskStatus,
  TaskHistoryEntry,
  Task,
  DependencyType,
  Dependency,
  AvailabilityTemplate,
  ScheduleEntry,
  TaskTemplate,
  TaskLogKind,
  TaskLog,
} from '../../shared/types.ts';

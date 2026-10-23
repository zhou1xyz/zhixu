/**
 * useTaskData：
 * 把「从后端取数 + 增删改后刷新」这套逻辑从 App.tsx 里抽出来。
 *
 * 为什么要抽：App.tsx 之前有 800 多行，一半都是在管数据加载和刷新，
 * 混在界面代码里既难读也难改。抽出来后，App 只管「界面上放什么」。
 */

import { useCallback, useEffect, useState } from 'react';
import type { AvailabilityTemplate, Dependency, Task, TaskLog } from '../types';
import {
  fetchAll,
  listLatestLogs,
  purgeOrphanChildren,
  purgeOrphanDependencies,
} from '../data/repository';

export interface TaskDataState {
  /** 全部任务（含已完成、等待中） */
  tasks: Task[];
  /** 全部依赖 */
  dependencies: Dependency[];
  /** 每周可用时间 */
  availability: AvailabilityTemplate[];
  /** 每个任务最新的一条过程记录，任务列表用来显示"最近进展" */
  latestLogs: Map<string, TaskLog>;
  /** 首次加载中 */
  loading: boolean;
  /** 加载失败的原始信息，空字符串表示正常 */
  loadError: string;
  /** 重新从后端拉一遍数据 */
  refresh: () => Promise<void>;
  /** 清空错误并重试 */
  retry: () => void;
}

export function useTaskData(): TaskDataState {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [availability, setAvailability] = useState<AvailabilityTemplate[]>([]);
  const [latestLogs, setLatestLogs] = useState<Map<string, TaskLog>>(new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>('');

  /**
   * 拉取数据。
   * 每次都先做两步清理，保证界面上的任务数和数据库里的行数一一对应：
   *   1. 删掉两端任务都不存在的依赖（孤儿依赖）
   *   2. 把父任务已删除的子任务提升为顶级任务（孤儿任务）
   */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      await purgeOrphanDependencies();
      await purgeOrphanChildren();
      const data = await fetchAll();
      // 顺带拉一次"每个任务最新一条记录"，列表里显示最近进展用
      try {
        const rows: TaskLog[] = await listLatestLogs();
        const map: Map<string, TaskLog> = new Map();
        for (const row of rows) {
          map.set(row.taskId, row);
        }
        setLatestLogs(map);
      } catch {
        // 记录拉取失败不影响主流程，列表只是少显示一行
      }
      setTasks(data.tasks);
      setDependencies(data.dependencies);
      setAvailability(data.availability);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const retry = useCallback((): void => {
    setLoadError('');
    setLoading(true);
    void refresh();
  }, [refresh]);

  return { tasks, dependencies, availability, latestLogs, loading, loadError, refresh, retry };
}

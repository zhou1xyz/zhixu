/**
 * useDialogs —— 任务相关弹窗的开关状态
 *
 * 为什么单独抽出来：这些状态彼此独立，唯一的共同点是"都要在页面底部
 * 渲染成弹窗"。散在 App 里会让编排逻辑被十来个 useState 淹没。
 * 集中到一处后，App 只关心"哪个窗开着"，具体渲染交给 AppDialogs。
 */

import { useState } from 'react';
import type { Task } from '../types';

export interface DialogState {
  showTaskModal: boolean;
  setShowTaskModal: (value: boolean) => void;
  showDependencyModal: boolean;
  setShowDependencyModal: (value: boolean) => void;
  editingTask: Task | null;
  setEditingTask: (task: Task | null) => void;
  actionTask: Task | null;
  setActionTask: (task: Task | null) => void;
  deleteTarget: Task | null;
  setDeleteTarget: (task: Task | null) => void;
  waitingTarget: Task | null;
  setWaitingTarget: (task: Task | null) => void;
  revokeTarget: Task | null;
  setRevokeTarget: (task: Task | null) => void;
  quickLogTarget: Task | null;
  setQuickLogTarget: (task: Task | null) => void;
  completeTarget: Task | null;
  setCompleteTarget: (task: Task | null) => void;
}

export function useDialogs(): DialogState {
  const [showTaskModal, setShowTaskModal] = useState<boolean>(false);
  const [showDependencyModal, setShowDependencyModal] = useState<boolean>(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [actionTask, setActionTask] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [waitingTarget, setWaitingTarget] = useState<Task | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Task | null>(null);
  const [quickLogTarget, setQuickLogTarget] = useState<Task | null>(null);
  const [completeTarget, setCompleteTarget] = useState<Task | null>(null);

  return {
    showTaskModal, setShowTaskModal,
    showDependencyModal, setShowDependencyModal,
    editingTask, setEditingTask,
    actionTask, setActionTask,
    deleteTarget, setDeleteTarget,
    waitingTarget, setWaitingTarget,
    revokeTarget, setRevokeTarget,
    quickLogTarget, setQuickLogTarget,
    completeTarget, setCompleteTarget,
  };
}

/**
 * AppDialogs —— 所有任务相关的弹窗集中渲染
 *
 * 为什么单独一个文件：这些弹窗以前全堆在 App.tsx 底部，占了 180 多行，
 * 让 App 的编排逻辑被淹没在 UI 细节里。集中到这里后，
 * App 只负责「数据 + 排期 + 判断」，弹窗的打开关闭状态由 useDialogs 管。
 *
 * 组件本身不持有状态：该开哪个窗由外部传进来，它只负责画出来。
 */

import type { Task, Dependency, TaskLog, TaskLogKind } from '../types';
import type { ScheduledItem } from '../../shared/scheduler.ts';
import { Modal } from './Modal';
import { TaskForm } from './TaskForm';
import { TaskLogsPanel } from './TaskLogsPanel';
import { CompleteDialog } from './CompleteDialog';
import { WaitingDialog } from './WaitingDialog';
import { RevokeDialog } from './RevokeDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { ActionSheet } from './ActionSheet';
import { QuickLogDialog } from './QuickLogDialog';
import { DependencyForm } from './DependencyForm';
import type { DialogState } from '../hooks/useDialogs';

interface TaskDependenciesProps {
  task: Task;
  tasks: Task[];
  dependencies: Dependency[];
}

/**
 * 编辑弹窗里的「与其他任务的依赖」区块。
 * 从 App.tsx 搬过来，因为只有编辑弹窗用它。
 */
function TaskDependencies({ task, tasks, dependencies }: TaskDependenciesProps) {
  const titleById: Map<string, string> = new Map<string, string>(
    tasks.map((item: Task) => [item.id, item.title]),
  );
  const predecessors: Dependency[] = dependencies.filter(
    (dep: Dependency) => dep.toTaskId === task.id,
  );
  const successors: Dependency[] = dependencies.filter(
    (dep: Dependency) => dep.fromTaskId === task.id,
  );
  if (predecessors.length === 0 && successors.length === 0) {
    return null;
  }
  return (
    <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card-muted)] px-4 py-3">
      <p className="text-xs font-semibold text-[var(--color-text-secondary)]">与其他任务的依赖</p>
      <ul className="mt-1.5 space-y-1 text-xs leading-5 text-[var(--color-text-secondary)]">
        {predecessors.map((dep: Dependency) => (
          <li key={dep.id}>
            等「{titleById.get(dep.fromTaskId) ?? dep.fromTaskId}」完成后才能开始
          </li>
        ))}
        {successors.map((dep: Dependency) => (
          <li key={dep.id}>
            这个完成后，「{titleById.get(dep.toTaskId) ?? dep.toTaskId}」才能开始
          </li>
        ))}
      </ul>
    </div>
  );
}

interface AppDialogsProps {
  dialogs: DialogState;
  tasks: Task[];
  dependencies: Dependency[];
  scheduledById: Map<string, ScheduledItem>;
  onAddTask: (task: Task) => Promise<void>;
  onUpdateTask: (id: string, patch: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onCompleteTask: (
    id: string,
    isCompleted: boolean,
    hours: number | null,
    scheduledStartAt: string | null,
    note: string | null,
  ) => Promise<void>;
  onAddDependency: (dep: Dependency) => Promise<void>;
  onRefresh: () => Promise<void>;
  onLoadLogs: (taskId: string) => Promise<TaskLog[]>;
  onAddLog: (taskId: string, content: string, kind: TaskLogKind) => Promise<void>;
  onDeleteLog: (id: string) => Promise<void>;
  onMarkWaiting: (id: string, remindDate: string, note: string | null) => Promise<void>;
  onRevokeWaiting: (id: string, note: string | null) => Promise<void>;
}

export function AppDialogs({
  dialogs,
  tasks,
  dependencies,
  scheduledById,
  onAddTask,
  onUpdateTask,
  onDeleteTask,
  onCompleteTask,
  onAddDependency,
  onRefresh,
  onLoadLogs,
  onAddLog,
  onDeleteLog,
  onMarkWaiting,
  onRevokeWaiting,
}: AppDialogsProps) {
  // 组件内部沿用原 App 里的 handleXxx 命名，避免逐处改写调用点；
  // 外部通过 onXxx 传入，两边在这里对接一次。
  const handleAddTask = onAddTask;
  const handleUpdateTask = onUpdateTask;
  const handleDeleteTask = onDeleteTask;
  const handleCompleteTask = onCompleteTask;
  const handleAddDependency = onAddDependency;
  const refresh = onRefresh;
  const listTaskLogs = onLoadLogs;
  const addTaskLog = onAddLog;
  const deleteTaskLog = onDeleteLog;
  const markWaiting = onMarkWaiting;
  const revokeWaiting = onRevokeWaiting;
  const {
    showTaskModal, setShowTaskModal,
    showDependencyModal, setShowDependencyModal,
    editingTask, setEditingTask,
    actionTask, setActionTask,
    deleteTarget, setDeleteTarget,
    waitingTarget, setWaitingTarget,
    revokeTarget, setRevokeTarget,
    quickLogTarget, setQuickLogTarget,
    completeTarget, setCompleteTarget,
  } = dialogs;

  return (
    <>
      {showTaskModal && (
        <Modal
          title="新增任务"
          description="预估工期是正常情况下要花的时间"
          onClose={() => setShowTaskModal(false)}
        >
          <TaskForm
            tasks={tasks}
            onAdd={handleAddTask}
            onDone={() => setShowTaskModal(false)}
          />
        </Modal>
      )}

      {editingTask !== null && (
        <Modal
          title="编辑任务"
          description="修改后保存，排期会自动重算"
          onClose={() => setEditingTask(null)}
        >
          <div className="mb-4">
            <TaskLogsPanel
              taskId={editingTask.id}
              history={editingTask.history ?? null}
              onLoad={listTaskLogs}
              onAdd={async (taskId: string, content: string, kind) => {
                await addTaskLog(taskId, content, kind);
              }}
              onDelete={async (id: string) => {
                await deleteTaskLog(id);
              }}
            />
          </div>
          <TaskDependencies task={editingTask} tasks={tasks} dependencies={dependencies} />
          <TaskForm
            tasks={tasks}
            onAdd={handleAddTask}
            onUpdate={handleUpdateTask}
            editing={editingTask}
            onDelete={async (id: string): Promise<void> => {
              await handleDeleteTask(id);
              setEditingTask(null);
            }}
            onDone={() => setEditingTask(null)}
          />
        </Modal>
      )}

      {completeTarget !== null && (
        <CompleteDialog
          task={completeTarget}
          onConfirm={async (hours: number | null, note: string | null) => {
            const target: Task = completeTarget;
            const item: ScheduledItem | undefined = scheduledById.get(target.id);
            setCompleteTarget(null);
            await handleCompleteTask(target.id, true, hours, item?.startAt ?? null, note);
          }}
          onCancel={() => setCompleteTarget(null)}
        />
      )}

      {waitingTarget !== null && (
        <WaitingDialog
          task={waitingTarget}
          onConfirm={async (remindDate: string, note: string | null) => {
            await markWaiting(waitingTarget.id, remindDate, note);
            setWaitingTarget(null);
            await refresh();
          }}
          onCancel={() => setWaitingTarget(null)}
        />
      )}

      {revokeTarget !== null && (
        <RevokeDialog
          task={revokeTarget}
          onConfirm={async (note: string | null) => {
            await revokeWaiting(revokeTarget.id, note);
            setRevokeTarget(null);
            await refresh();
          }}
          onCancel={() => setRevokeTarget(null)}
        />
      )}

      {deleteTarget !== null && (
        <ConfirmDialog
          title="删除这个任务？"
          message={`「${deleteTarget.title}」将被删除。与它相关的依赖会一并清理，它下面的子任务会变成独立任务。`}
          confirmLabel="删除"
          busyLabel="删除中…"
          onConfirm={() => {
            const target: Task = deleteTarget;
            setDeleteTarget(null);
            void handleDeleteTask(target.id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {actionTask !== null && (
        <ActionSheet
          title={actionTask.title}
          actions={[
            { label: '查看 / 编辑任务', onSelect: () => setEditingTask(actionTask) },
            {
              label: '记一笔进展',
              onSelect: () => setQuickLogTarget(actionTask),
            },
            ...(actionTask.status === 'done'
              ? [
                  {
                    label: '撤销完成',
                    onSelect: () => {
                      void handleCompleteTask(
                        actionTask.id,
                        false,
                        actionTask.actualHours ?? null,
                        actionTask.scheduledStartAt ?? null,
                        actionTask.completionNote ?? null,
                      );
                    },
                  },
                ]
              : [
                  {
                    label: actionTask.status === 'waiting' ? '收回（等待结束）' : '标记为等待中',
                    onSelect: () => {
                      if (actionTask.status === 'waiting') {
                        setRevokeTarget(actionTask);
                      } else {
                        setWaitingTarget(actionTask);
                      }
                    },
                  },
                  {
                    label: '标记完成',
                    // 直接弹完成窗口，不再绕进编辑页——编辑页是改字段的地方，
                    // 完成是另一件事，入口混用会让人多点两下。
                    onSelect: () => {
                      setCompleteTarget(actionTask);
                      setActionTask(null);
                    },
                  },
                ]),
            {
              label: '删除任务',
              danger: true,
              onSelect: () => setDeleteTarget(actionTask),
            },
          ]}
          onClose={() => setActionTask(null)}
        />
      )}

      {quickLogTarget !== null && (
        <QuickLogDialog
          task={quickLogTarget}
          onSave={async (content: string, kind) => {
            await addTaskLog(quickLogTarget.id, content, kind);
            setQuickLogTarget(null);
            await refresh();
          }}
          onCancel={() => setQuickLogTarget(null)}
        />
      )}

      {showDependencyModal && (
        <Modal
          title="新增依赖"
          description="前置任务完成后，后继任务才能开始"
          onClose={() => setShowDependencyModal(false)}
        >
          <DependencyForm
            tasks={tasks}
            onAdd={handleAddDependency}
            onDone={() => setShowDependencyModal(false)}
          />
        </Modal>
      )}
    </>
  );
}

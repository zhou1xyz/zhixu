/**
 * TaskLogsPanel —— 任务时间线
 *
 * 流转记录（系统自动写）和过程记录（人手动写）本质上是同一件事的两面：
 * 都在讲「这个任务中途发生了什么」。但存储上必须分开——流转记录是
 * 可计算的结构化数据，靠它算工时；过程记录是自由文本。
 *
 * 所以这里只合并展示：两类记录按时间顺序混排成一条线，
 * 看的时候是一件事从头到尾，不再是两块割裂的列表。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskLog, TaskLogKind } from '../types';
import { STATUS_LABELS, formatStamp } from './format';

/** 类型标签的中文名和配色 */
const KIND_OPTIONS: { value: TaskLogKind; label: string; className: string }[] = [
  { value: 'note', label: '记录', className: 'bg-[var(--color-card-muted)] text-[var(--color-text-secondary)]' },
  { value: 'contact', label: '沟通', className: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
  { value: 'waiting', label: '等回复', className: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300' },
  { value: 'issue', label: '发现问题', className: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' },
  { value: 'progress', label: '有进展', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
];

const KIND_MAP: Map<TaskLogKind, { label: string; className: string }> = new Map(
  KIND_OPTIONS.map((o) => [o.value, { label: o.label, className: o.className }]),
);

/** 状态流转条目的结构（tasks.history 里的元素） */
interface HistoryEntry {
  at: string;
  from: string | null;
  to: string;
  note: string | null;
}

function parseHistory(raw: string | null | undefined): HistoryEntry[] {
  if (typeof raw !== 'string' || raw === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** 时间线上的一格：要么是系统写的状态流转，要么是人写的过程记录 */
type TimelineItem =
  | { kind: 'history'; at: string; entry: HistoryEntry; key: string }
  | { kind: 'log'; at: string; log: TaskLog; key: string };

/**
 * 把两类记录按时间合并成一条线。
 *
 * 为什么不在后端合并：两个来源的结构、写入方、用途都不同，
 * 合并只发生在展示层，数据结构保持各自干净。
 */
function mergeTimeline(history: HistoryEntry[], logs: TaskLog[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  history.forEach((entry: HistoryEntry, index: number) => {
    items.push({ kind: 'history', at: entry.at, entry, key: `h-${entry.at}-${index}` });
  });
  logs.forEach((log: TaskLog) => {
    items.push({ kind: 'log', at: log.createdAt, log, key: `l-${log.id}` });
  });
  items.sort((a: TimelineItem, b: TimelineItem) => {
    const ta: number = Date.parse(a.at);
    const tb: number = Date.parse(b.at);
    if (Number.isNaN(ta) || Number.isNaN(tb)) {
      return 0;
    }
    return ta - tb;
  });
  return items;
}

interface TaskLogsPanelProps {
  taskId: string;
  /** 流转记录原始 JSON 文本（tasks.history），由系统生成，这里只读 */
  history?: string | null;
  onLoad: (taskId: string) => Promise<TaskLog[]>;
  onAdd: (taskId: string, content: string, kind: TaskLogKind) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function TaskLogsPanel({ taskId, history, onLoad, onAdd, onDelete }: TaskLogsPanelProps) {
  // 父组件每次渲染都会传新的箭头函数，直接依赖它们会让 effect 反复触发、
  // 面板反复重置。用 ref 存住最新的回调，effect 只跟 taskId 走。
  const loadRef = useRef(onLoad);
  const addRef = useRef(onAdd);
  const deleteRef = useRef(onDelete);
  loadRef.current = onLoad;
  addRef.current = onAdd;
  deleteRef.current = onDelete;

  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [adding, setAdding] = useState<boolean>(false);
  const [content, setContent] = useState<string>('');
  const [kind, setKind] = useState<TaskLogKind>('note');
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows: TaskLog[] = await loadRef.current(taskId);
      setLogs(rows);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function handleSave(): Promise<void> {
    const text: string = content.trim();
    if (text === '' || saving) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      await addRef.current(taskId, text, kind);
      setContent('');
      setAdding(false);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const timeline: TimelineItem[] = mergeTimeline(parseHistory(history), logs);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card-muted)] px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[var(--color-text-secondary)]">
          任务时间线
          {timeline.length > 0 && <span className="ml-1 font-normal">（{timeline.length} 条）</span>}
        </p>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-brand)] transition hover:bg-[var(--color-brand-soft)]"
          >
            + 添加一条
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setKind(option.value)}
                className={`rounded-full px-2 py-0.5 text-xs transition ${
                  kind === option.value
                    ? option.className + ' ring-1 ring-inset ring-current'
                    : 'bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <textarea
            rows={3}
            autoFocus
            placeholder="这一步推进到哪了？和谁沟通了什么？遇到什么问题？"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-brand)]"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setContent('');
              }}
              className="h-8 rounded-md px-3 text-xs text-[var(--color-text-secondary)] transition hover:bg-[var(--color-card)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving || content.trim() === ''}
              onClick={() => {
                void handleSave();
              }}
              className="h-8 rounded-md bg-[var(--color-brand)] px-3 text-xs font-medium text-white transition disabled:opacity-50"
            >
              {saving ? '提交中…' : '记一笔'}
            </button>
          </div>
        </div>
      )}

      {error !== '' && <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}

      {loading ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">加载中…</p>
      ) : timeline.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          还没有记录。可以记一笔：跟谁沟通了、卡在哪、有什么新进展。
        </p>
      ) : (
        <ol className="mt-2 max-h-[280px] space-y-2 overflow-y-auto pr-1">
          {timeline.map((item: TimelineItem) => {
            if (item.kind === 'history') {
              const entry: HistoryEntry = item.entry;
              return (
                <li key={item.key} className="flex gap-2 text-xs leading-5">
                  <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                    {formatStamp(item.at)}
                  </span>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    状态
                  </span>
                  <span className="wrap-anywhere min-w-0 flex-1 text-[var(--color-text-secondary)]">
                    {entry.from !== null ? `${STATUS_LABELS[entry.from] ?? entry.from} → ` : ''}
                    <span className="font-medium text-[var(--color-text)]">
                      {STATUS_LABELS[entry.to] ?? entry.to}
                    </span>
                    {typeof entry.note === 'string' && entry.note !== '' && (
                      <span className="ml-1 text-[var(--color-text-muted)]">（{entry.note}）</span>
                    )}
                  </span>
                </li>
              );
            }
            const log: TaskLog = item.log;
            const meta = KIND_MAP.get(log.kind) ?? { label: '记录', className: '' };
            return (
              <li key={item.key} className="group flex gap-2 text-xs leading-5">
                <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                  {formatStamp(item.at)}
                </span>
                <span className={`shrink-0 rounded px-1.5 text-[11px] font-medium ${meta.className}`}>
                  {meta.label}
                </span>
                <span className="wrap-anywhere min-w-0 flex-1 whitespace-pre-wrap text-[var(--color-text-secondary)]">
                  {log.content}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void deleteRef.current(log.id).then(() => load());
                  }}
                  className="shrink-0 text-[var(--color-text-muted)] opacity-0 transition hover:text-[var(--color-danger)] group-hover:opacity-100"
                  aria-label="删除这条记录"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * taskService 测试：直接打生产模块 server/taskService.js（P0-02）
 * 覆盖：正常流转、返工累计、非法状态、任务不存在、受保护字段伪造、数据库异常
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyStatusTransition, validateTaskUpdates, sanitizeNewTask } from '../server/taskService.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'todo',
    isCompleted INTEGER NOT NULL DEFAULT 0, estimatedHours REAL DEFAULT 0,
    minHours REAL DEFAULT 0, category TEXT DEFAULT 'any', deadline TEXT,
    waitingHours REAL, workHours REAL, firstStartedAt TEXT, completedAt TEXT,
    createdAt TEXT, history TEXT, completionNote TEXT, remindDate TEXT, waitingNote TEXT
  )`);
  db.prepare(`INSERT INTO tasks (id, title, status, estimatedHours, minHours, createdAt)
    VALUES ('t1', '测试任务', 'todo', 2, 1, '2026-10-28T08:00:00.000Z')`).run();
  return db;
}
const T0 = Date.parse('2026-10-28T09:00:00.000Z');

test('校验：空更新对象视为 empty', () => {
  const r = validateTaskUpdates(freshDb(), 't1', {});
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
});
test('校验：全非法字段返回错误', () => {
  const r = validateTaskUpdates(freshDb(), 't1', { hacker: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /没有可更新的合法字段/);
});
test('校验：非法 status / category / 负数工时均拒绝', () => {
  const db = freshDb();
  for (const bad of [{ status: 'bogus' }, { category: 'xxx' }, { estimatedHours: -5 }, { minHours: -1 }]) {
    assert.equal(validateTaskUpdates(db, 't1', bad).ok, false, JSON.stringify(bad));
  }
});
test('校验：单独 minHours 超过库内 estimatedHours 拒绝', () => {
  const r = validateTaskUpdates(freshDb(), 't1', { minHours: 999 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /minHours 不能大于/);
});
test('校验：受保护字段 completedAt / firstStartedAt / createdAt 不进白名单', () => {
  const r = validateTaskUpdates(freshDb(), 't1', { completedAt: '2020-01-01', firstStartedAt: '2020-01-01', createdAt: '2020-01-01' });
  assert.equal(r.ok, false);
});
test('流转：todo→waiting→todo 结算等待并盖开工章', () => {
  const db = freshDb();
  const t1 = Date.parse('2026-10-28T10:00:00.000Z');
  const t2 = Date.parse('2026-10-28T11:00:00.000Z');
  const m1 = applyStatusTransition(db, 't1', validateTaskUpdates(db, 't1', { status: 'waiting' }).filtered, t1);
  db.prepare('UPDATE tasks SET status=@status, history=@h WHERE id=@id').run({ status: m1.status, h: m1.history, id: 't1' });
  const m2 = applyStatusTransition(db, 't1', validateTaskUpdates(db, 't1', { status: 'todo' }).filtered, t2);
  assert.equal(m2.waitingHours, 1);
  assert.ok(m2.firstStartedAt);
  assert.equal(m2.isCompleted, 0);
});
test('流转：完成结算净工时、盖章 completedAt；返工不清零；再完成累加', () => {
  const db = freshDb();
  db.prepare("UPDATE tasks SET firstStartedAt='2026-10-28T09:00:00.000Z', history=? WHERE id='t1'")
    .run(JSON.stringify([{ at: '2026-10-28T09:00:00.000Z', from: 'waiting', to: 'todo', note: null }]));
  const m1 = applyStatusTransition(db, 't1', validateTaskUpdates(db, 't1', { status: 'done' }).filtered, Date.parse('2026-10-28T10:00:00.000Z'));
  assert.equal(m1.workHours, 1);
  assert.ok(m1.completedAt);
  assert.equal(m1.isCompleted, 1);
  const h1 = JSON.parse(m1.history!);
  db.prepare('UPDATE tasks SET status=?, isCompleted=1, workHours=?, completedAt=?, history=?, firstStartedAt=? WHERE id=?')
    .run(m1.status, m1.workHours, m1.completedAt, m1.history, '2026-10-28T09:00:00.000Z', 't1');
  const m2 = applyStatusTransition(db, 't1', validateTaskUpdates(db, 't1', { status: 'todo' }).filtered, Date.parse('2026-10-28T10:30:00.000Z'));
  // 「返工不清零」的实现语义：mapped 里不含 workHours 键 → UPDATE 不触碰该列 → 库内值保持
  assert.equal('workHours' in m2, false, '返工不触碰工时列');
  assert.equal(m2.completedAt, null, '返工清完成时刻');
  // m2 落库（工时列不更新）
  db.prepare('UPDATE tasks SET status=?, completedAt=?, history=? WHERE id=?')
    .run(m2.status, m2.completedAt, m2.history, 't1');
  const m3 = applyStatusTransition(db, 't1', validateTaskUpdates(db, 't1', { status: 'done' }).filtered, Date.parse('2026-10-28T11:30:00.000Z'));
  assert.equal(m3.workHours, 2, '再完成累加');
  const transitions = JSON.parse(m3.history!).map((e: { from: string | null; to: string }) => `${e.from}->${e.to}`);
  assert.deepEqual(transitions, ['waiting->todo', 'todo->done', 'done->todo', 'todo->done']);
});
test('流转：任务不存在时不产生 mapped 业务字段（before 为空不崩）', () => {
  const db = freshDb();
  const m = applyStatusTransition(db, 'missing', validateTaskUpdates(db, 'missing', { status: 'done' }).filtered, T0);
  assert.equal(m.status, 'done');
  assert.equal(m.history, undefined);
});
test('健壮性：history 脏数据不崩，按无历史处理', () => {
  const db = freshDb();
  db.prepare("UPDATE tasks SET history='not-json{{' WHERE id='t1'").run();
  const m = applyStatusTransition(db, 't1', validateTaskUpdates(db, 't1', { status: 'done' }).filtered, T0);
  assert.equal(m.isCompleted, 1);
});
test('数据库异常：向不存在的表查询时抛出而非吞错', () => {
  const bad = new DatabaseSync(':memory:');
  assert.throws(() => validateTaskUpdates(bad, 't1', { minHours: 1 }));
});

test('P1-02：仅含受保护字段的 PATCH 被整体拒绝（无合法可更新字段）', () => {
  const r = validateTaskUpdates(freshDb(), 't1', { workHours: 99, waitingHours: 99, history: 'x', isCompleted: true });
  assert.equal(r.ok, false);
  assert.match(r.error!, /没有可更新的合法字段/);
});
test('P1-02：受保护字段混在合法字段中时被剥离', () => {
  const r = validateTaskUpdates(freshDb(), 't1', { status: 'waiting', workHours: 99, history: 'x' });
  assert.equal(r.ok, true);
  const f = r.filtered as Record<string, unknown>;
  assert.deepEqual(Object.keys(f).sort(), ['status']);
});
test('P1-02：sanitizeNewTask 拒绝直插 done', () => {
  const r = sanitizeNewTask({ id: 'x', title: 'x', estimatedHours: 1, status: 'done' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /不允许通过创建接口/);
});
test('P1-02：sanitizeNewTask 剥离权威字段', () => {
  const r = sanitizeNewTask({ id: 'x', title: 'x', estimatedHours: 1, status: 'todo', workHours: 9, history: 'h', completedAt: 'c', isCompleted: true });
  assert.equal(r.ok, true);
  const c = r.clean as Record<string, unknown>;
  assert.equal(c.workHours, undefined);
  assert.equal(c.history, undefined);
  assert.equal(c.completedAt, undefined);
  assert.equal(c.isCompleted, undefined);
  assert.equal(c.status, 'todo');
});
test('P1-02：客户端 waitingHours 不再进白名单', () => {
  const v = validateTaskUpdates(freshDb(), 't1', { status: 'waiting', waitingHours: 999 });
  assert.equal(v.ok, true);
  assert.equal('waitingHours' in (v.filtered as object), false);
});

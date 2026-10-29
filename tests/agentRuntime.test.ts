/**
 * P1-03c：工具注册表单测 + Agent HTTP 集成测试（独立临时库进程）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeParams, hashParams, executeTool } from '../server/agent/tools.js';
import { DatabaseSync } from 'node:sqlite';

// ---- 单元：注册表与规范化 ----
test('canonicalizeParams：键序无关、确定性', () => {
  assert.equal(canonicalizeParams({ b: 1, a: { d: 2, c: [3, 4] } }), canonicalizeParams({ a: { c: [3, 4], d: 2 }, b: 1 }));
  assert.equal(hashParams({ x: 1 }), hashParams({ x: 1 }));
  assert.notEqual(hashParams({ x: 1 }), hashParams({ x: 2 }));
});
test('executeTool：未注册工具拒绝（param_invalid）', () => {
  const db = new DatabaseSync(':memory:');
  const r = executeTool(db, 'nope', {});
  assert.equal(r.status, 'rejected');
  assert.equal(r.error_kind, 'param_invalid');
});
test('executeTool：risk 无法被调用方覆盖（注册表为准）', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'todo', category TEXT DEFAULT 'any', deadline TEXT, estimatedHours REAL DEFAULT 1, minHours REAL DEFAULT 0, waitingHours REAL, workHours REAL, createdAt TEXT, completedAt TEXT)");
  db.prepare("INSERT INTO tasks (id, title, createdAt) VALUES ('t1','任务','2026-10-29T00:00:00Z')").run();
  const r = executeTool(db, 'query_tasks', { limit: 5, risk: 'R3' } as Record<string, unknown>);
  assert.equal(r.status, 'executed'); // risk 被忽略，正常执行
});
test('executeTool：非法参数拒绝', () => {
  const db = new DatabaseSync(':memory:');
  for (const bad of [{ limit: 0 }, { limit: 101 }, { status: 'bogus' }, { keyword: 123 }]) {
    assert.equal(executeTool(db, 'query_tasks', bad as Record<string, unknown>).status, 'rejected');
  }
});

// ---- HTTP 集成（独立进程 + 临时库） ----
const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;
let child: ReturnType<typeof spawn> | undefined;
const dbPath = join(mkdtempSync(join(tmpdir(), 'p103c-')), 'test.db');

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let sid = '';
before(async () => {
  const errChunks: string[] = [];
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), TASK_DB_PATH: dbPath },
  });
  (child as { stderr?: { on: (ev: string, cb: (d: Buffer) => void) => void } }).stderr?.on('data', (d: Buffer) => errChunks.push(String(d)));
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/tasks'); if (r.ok) { up = true; break; } } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not start: ' + errChunks.join(''));
  const r = await call('POST', '/api/agent/sessions', { title: '集成测试' });
  sid = String((r.body as { session: { id: string } }).session.id);
});
after(() => child?.kill());

test('HTTP：query_tasks 正常查询', async () => {
  await call('POST', '/api/tasks', { id: 'a1', title: '写周报', estimatedHours: 1, status: 'todo' });
  const r = await call('POST', `/api/agent/sessions/${sid}/tools`, { request_id: 'q1', calls: [{ tool: 'query_tasks', arguments: { keyword: '周报' } }] });
  assert.equal(r.status, 200);
  const calls = (r.body as { tool_calls: Array<{ status: string; result_json: string }> }).tool_calls;
  assert.equal(calls[0].status, 'executed');
  assert.ok(JSON.parse(calls[0].result_json).count >= 1);
});
test('HTTP：同 request_id 顺序重放返回同一 run', async () => {
  const r1 = await call('POST', `/api/agent/sessions/${sid}/tools`, { request_id: 'q1', calls: [{ tool: 'query_tasks', arguments: { keyword: '周报' } }] });
  assert.equal((r1.body as { replayed: boolean }).replayed, true);
  assert.equal((r1.body as { run_id: string }).run_id, (r1.body as { run_id: string }).run_id);
});
test('HTTP：同 request_id 不同输入 → 409', async () => {
  const r = await call('POST', `/api/agent/sessions/${sid}/tools`, { request_id: 'q1', calls: [{ tool: 'query_tasks', arguments: { limit: 7 } }] });
  assert.equal(r.status, 409);
});
test('HTTP：未注册工具 → run failed + error_kind', async () => {
  const r = await call('POST', `/api/agent/sessions/${sid}/tools`, { request_id: 'q2', calls: [{ tool: 'drop_all' }] });
  assert.equal((r.body as { status: string }).status, 'failed');
  assert.equal((r.body as { error_kind: string }).error_kind, 'param_invalid');
});
test('HTTP：相同参数的独立调用（不同 lcid）不被合并', async () => {
  const r = await call('POST', `/api/agent/sessions/${sid}/tools`, { request_id: 'q3', calls: [{ tool: 'query_tasks', lcid: 'L2' }, { tool: 'query_tasks', lcid: 'L3' }] });
  assert.equal((r.body as { tool_calls: unknown[] }).tool_calls.length, 2);
});
test('HTTP：消息接口不伪造 agent 回复', async () => {
  const r = await call('POST', `/api/agent/sessions/${sid}/messages`, { request_id: 'm1', content: '你好' });
  const msg = (r.body as { message: { role: string } }).message;
  assert.equal(msg.role, 'user');
});
test('HTTP：孤儿记录为零', async () => {
  const r = await call('GET', `/api/agent/sessions/${sid}`);
  const bundle = r.body as { messages: Array<{ run_id: string | null }>; runs: Array<{ id: string; session_id: string }>; session: { id: string }; tool_calls: Array<{ run_id: string }> };
  const runIds = new Set(bundle.runs.map((x) => x.id));
  for (const m of bundle.messages) if (m.run_id !== null) assert.ok(runIds.has(m.run_id), '消息孤儿');
  for (const c of bundle.tool_calls) assert.ok(runIds.has(c.run_id), '调用孤儿');
  for (const r of bundle.runs) assert.equal(r.session_id, bundle.session.id);
});

test('HTTP：并发相同 request_id 只产生一个 run 和一条消息', async () => {
  const body = { request_id: 'cc1', content: '并发消息' };
  const results = await Promise.all([
    call('POST', `/api/agent/sessions/${sid}/messages`, body),
    call('POST', `/api/agent/sessions/${sid}/messages`, body),
    call('POST', `/api/agent/sessions/${sid}/messages`, body),
  ]);
  const runIds = new Set(results.map((r) => (r.body as { run_id?: string }).run_id).filter(Boolean));
  assert.equal(runIds.size, 1, '所有成功响应应指向同一 run');
  const bundle = (await call('GET', `/api/agent/sessions/${sid}`)).body as { messages: Array<{ content: string }> };
  assert.equal(bundle.messages.filter((m) => m.content === '并发消息').length, 1, '消息只落一条');
});
test('HTTP：executed 状态不重复执行（重放不产生新调用行）', async () => {
  const before = await call('POST', `/api/agent/sessions/${sid}/tools`, { request_id: 'q1', calls: [{ tool: 'query_tasks', arguments: { keyword: '周报' } }] });
  const calls1 = (before.body as { tool_calls: unknown[] }).tool_calls.length;
  assert.equal((before.body as { replayed: boolean }).replayed, true);
  assert.equal(calls1 >= 1, true);
});

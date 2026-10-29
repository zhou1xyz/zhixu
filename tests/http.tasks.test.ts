/**
 * HTTP 层测试（P1-02）：独立临时库 + 独立端口拉起真实服务进程，
 * 覆盖 POST 严格版、非法字段、伪造受保护字段、幂等。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;
let child;
const dbPath = join(mkdtempSync(join(tmpdir(), 'p102-')), 'test.db');

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), TASK_DB_PATH: dbPath },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/tasks'); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('server did not start');
});
after(() => child?.kill());

test('POST 严格版：禁止直插 done', async () => {
  const r = await call('POST', '/api/tasks', { id: 'h1', title: 'x', estimatedHours: 1, status: 'done' });
  assert.equal(r.status, 400);
});
test('POST：todo 可建且权威字段被剥离', async () => {
  const r = await call('POST', '/api/tasks', { id: 'h2', title: 'x', estimatedHours: 1, status: 'todo', workHours: 99, history: 'h', isCompleted: true });
  assert.equal(r.status, 200);
  const tasks = await (await fetch(BASE + '/api/tasks')).json();
  const row = tasks.find((t) => t.id === 'h2');
  assert.equal(row.workHours, null);
  assert.equal(row.isCompleted, false);
});
test('PATCH：完成后伪造受保护字段不生效', async () => {
  await call('PATCH', '/api/tasks/h2', { status: 'done' });
  const only = await call('PATCH', '/api/tasks/h2', { workHours: 999, history: 'x', isCompleted: false });
  assert.equal(only.status, 400);
  const tasks = await (await fetch(BASE + '/api/tasks')).json();
  const row = tasks.find((t) => t.id === 'h2');
  assert.equal(row.status, 'done');
  assert.ok(row.completedAt);
});
test('PATCH：重复完成幂等', async () => {
  await call('PATCH', '/api/tasks/h2', { status: 'done' });
  const tasks = await (await fetch(BASE + '/api/tasks')).json();
  const row = tasks.find((t) => t.id === 'h2');
  const h = JSON.parse(row.history || '[]');
  assert.equal(h.filter((e) => e.to === 'done').length, 1);
});

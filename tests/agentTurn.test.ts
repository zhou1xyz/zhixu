/**
 * P1-03d B1：runAgentTurn 单轮闭环测试
 * 直调函数（:memory: 库），mock 适配器可编程；不触网、不碰生产库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAgentTables } from '../server/agentSchema.js';
import { runAgentTurn, transitRun } from '../server/agent/runtime.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  createAgentTables(db);
  const t = new Date().toISOString();
  db.prepare("INSERT INTO agent_sessions (id, title, status, created_at, updated_at) VALUES ('s1','测试','active',?,?)").run(t, t);
  return db;
}
function scripted(steps) {
  let i = 0;
  const calls = [];
  return {
    calls,
    adapter: {
      model: 'mock',
      chat: async () => {
        const s = steps[Math.min(i, steps.length - 1)];
        i += 1;
        calls.push(s);
        if (s.hang) return s.promise;
        if (s.throw) throw s.throw;
        return s.value;
      },
    },
  };
}
const ok = (content: string, usage?: unknown) => ({ ok: true as const, content, ...(usage ? { usage } : {}) });

test('1 正常响应：run succeeded + 助手消息 + 用量/轮次从库中验证', async () => {
  const db = setup();
  const { adapter, calls } = scripted([{ value: ok('回复内容', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) }]);
  const r = await runAgentTurn(db, 's1', { request_id: 'r1', content: '问题' }, adapter);
  assert.equal(r.status, 200);
  assert.equal((r.payload as { status: string }).status, 'succeeded');
  const row = db.prepare('SELECT * FROM agent_runs WHERE request_id=?').get('r1') as { rounds: number; usage_json: string; status: string };
  assert.equal(row.rounds, 1);
  assert.equal(row.status, 'succeeded');
  assert.equal(JSON.parse(row.usage_json).total_tokens, 15, '用量必须从库中重新读取验证');
  const msg = db.prepare("SELECT content, role FROM agent_messages WHERE run_id=? AND role='agent'").get(row.id) as { content: string; role: string };
  assert.equal(msg.role, 'agent');
  assert.equal(msg.content, '回复内容');
  assert.equal(calls.length, 1);
});

test('2 适配器失败：run failed + error_kind 正确', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: { ok: false, error_kind: 'model_error', error: '上游 HTTP 500: oops' } }]);
  const r = await runAgentTurn(db, 's1', { request_id: 'r2', content: '问题' }, adapter);
  const row = db.prepare('SELECT * FROM agent_runs WHERE request_id=?').get('r2') as { status: string; error_kind: string; error_detail: string };
  assert.equal(row.status, 'failed');
  assert.equal(row.error_kind, 'model_error');
  assert.match(row.error_detail, /上游 HTTP 500/);
});

test('3 未配置密钥：映射 model_error + not_configured 前缀', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: { ok: false, error_kind: 'not_configured', error: '模型密钥未配置' } }]);
  await runAgentTurn(db, 's1', { request_id: 'r3', content: '问题' }, adapter);
  const row = db.prepare('SELECT error_kind, error_detail FROM agent_runs WHERE request_id=?').get('r3') as { error_kind: string; error_detail: string };
  assert.equal(row.error_kind, 'model_error');
  assert.match(row.error_detail, /^not_configured: /);
});

test('4 顺序重放：模型只调一次，返回持久化回复', async () => {
  const db = setup();
  const { adapter, calls } = scripted([{ value: ok('首次回复') }]);
  await runAgentTurn(db, 's1', { request_id: 'r4', content: '问题' }, adapter);
  const r2 = await runAgentTurn(db, 's1', { request_id: 'r4', content: '问题' }, adapter);
  const p = r2.payload as { replayed: boolean; status: string; message: { content: string } };
  assert.equal(p.replayed, true);
  assert.equal(p.status, 'succeeded');
  assert.equal(p.message.content, '首次回复');
  assert.equal(calls.length, 1, '模型只调一次');
});

test('5 failed 重放：返回原失败，不重调', async () => {
  const db = setup();
  const { adapter, calls } = scripted([{ value: { ok: false, error_kind: 'timeout', error: '超时' } }]);
  await runAgentTurn(db, 's1', { request_id: 'r5', content: '问题' }, adapter);
  const r2 = await runAgentTurn(db, 's1', { request_id: 'r5', content: '问题' }, adapter);
  const p = r2.payload as { replayed: boolean; status: string; error_kind: string };
  assert.equal(p.replayed, true);
  assert.equal(p.status, 'failed');
  assert.equal(p.error_kind, 'timeout');
  assert.equal(calls.length, 1);
});

test('9 同 request_id 不同输入 → 409', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: ok('a') }]);
  await runAgentTurn(db, 's1', { request_id: 'r9', content: '输入一' }, adapter);
  const r = await runAgentTurn(db, 's1', { request_id: 'r9', content: '输入二' }, adapter);
  assert.equal(r.status, 409);
});

test('11 用量缺失：usage_json=NULL、rounds=1、不伪造', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: ok('无用量回复') }]);
  await runAgentTurn(db, 's1', { request_id: 'r11', content: '问题' }, adapter);
  const row = db.prepare('SELECT usage_json, rounds FROM agent_runs WHERE request_id=?').get('r11') as { usage_json: string | null; rounds: number };
  assert.equal(row.usage_json, null);
  assert.equal(row.rounds, 1);
});

test('12 模型请求工具：不执行，run failed/unknown + 助手说明', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: { ok: true, content: '', toolCalls: [{ name: 'delete_all', arguments: {} }, { name: 'hack', arguments: {} }] } }]);
  const r = await runAgentTurn(db, 's1', { request_id: 'r12', content: '问题' }, adapter);
  const p = r.payload as { status: string; error_kind: string; error_detail: string };
  assert.equal(p.status, 'failed');
  assert.equal(p.error_kind, 'unknown');
  assert.match(p.error_detail, /delete_all.*hack|hack.*delete_all/);
  const msg = db.prepare("SELECT content FROM agent_messages WHERE run_id=(SELECT id FROM agent_runs WHERE request_id='r12') AND role='agent'").get() as { content: string };
  assert.match(msg.content, /未执行/);
});

test('10+13 状态守卫：非法转换拒绝、合法转换生效', async () => {
  const db = setup();
  db.prepare("INSERT INTO agent_runs (id, session_id, request_id, status, model, created_at) VALUES ('g1','s1','g1','succeeded','mock',datetime('now'))").run();
  assert.equal(transitRun(db, 'g1', 'succeeded', 'running'), 0, '终态不可复活');
  assert.equal(transitRun(db, 'g1', 'failed', 'succeeded'), 0, '来源不符拒绝');
  db.prepare("INSERT INTO agent_runs (id, session_id, request_id, status, model, created_at) VALUES ('g2','s1','g2','running','mock',datetime('now'))").run();
  assert.equal(transitRun(db, 'g2', 'running', 'failed', { error_kind: 'timeout', error_detail: 'x' }), 1, '合法转换生效');
  const row = db.prepare('SELECT status, error_kind, finished_at FROM agent_runs WHERE id=?').get('g2') as { status: string; error_kind: string; finished_at: string };
  assert.equal(row.status, 'failed');
  assert.ok(row.finished_at);
});

test('8 用量写入失败注入：不伪造用量，run 仍可终态', async () => {
  const db = setup();
  const origPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (sql.includes('usage_json')) throw new Error('注入的用量写入失败');
    return origPrepare(sql);
  };
  const { adapter } = scripted([{ value: ok('回复', { total_tokens: 42 }) }]);
  const r = await runAgentTurn(db, 's1', { request_id: 'r8', content: '问题' }, adapter);
  const p = r.payload as { status: string };
  assert.equal(p.status, 'succeeded');
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = origPrepare;
  const row = db.prepare('SELECT usage_json FROM agent_runs WHERE request_id=?').get('r8') as { usage_json: string | null };
  assert.equal(row.usage_json, null, '注入失败 → 用量不得伪造');
});

test('6/7 并发挂起：单执行者 + 放行后重放', async () => {
  const db = setup();
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((res) => { release = res; });
  const calls: unknown[] = [];
  const adapter = {
    model: 'mock',
    chat: async () => { calls.push(1); await gate; return ok('挂起后回复', { total_tokens: 9 }); },
  };
  const first = runAgentTurn(db, 's1', { request_id: 'r6', content: '问题' }, adapter);
  await new Promise((r) => setTimeout(r, 100));
  // 挂起期间重放：in_progress、不建新 run、不调模型
  const second = await runAgentTurn(db, 's1', { request_id: 'r6', content: '问题' }, adapter);
  assert.equal((second.payload as { in_progress: boolean }).in_progress, true);
  assert.equal(calls.length, 1, '模型只调一次');
  release(ok('挂起后回复', { total_tokens: 9 }));
  const done = await first;
  assert.equal((done.payload as { status: string }).status, 'succeeded');
  const runs = db.prepare('SELECT COUNT(*) n FROM agent_runs WHERE request_id=?').get('r6') as { n: number };
  assert.equal(runs.n, 1);
});

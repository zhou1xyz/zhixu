/**
 * P1-03d B1 修正版：runAgentTurn 单轮闭环测试
 * 覆盖批准书 §四 8 类场景：用量语义区分、故障说明事务、重放不重复、
 * 工具拒绝守卫、并发挂起、409、状态守卫、注入失败。
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
/** 临时注入：命中 match 的 prepare 调用按 behavior 处理；返回恢复函数 */
function inject(db: DatabaseSync, matches: string | Array<string>, behavior: 'throw' | 'zero') {
  const list = Array.isArray(matches) ? matches : [matches];
  const orig = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (list.some((m) => sql.includes(m))) {
      if (behavior === 'throw') throw new Error('注入的数据库故障');
      return { run: () => ({ changes: 0 }) } as unknown as ReturnType<typeof orig>;
    }
    return orig(sql);
  };
  return () => { (db as unknown as { prepare: (sql: string) => unknown }).prepare = orig; };
}
function scripted(steps: Array<Record<string, unknown>>) {
  let i = 0;
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    adapter: {
      model: 'mock',
      chat: async () => {
        const s = steps[Math.min(i, steps.length - 1)];
        i += 1;
        calls.push(s);
        return s.value;
      },
    },
  };
}
const ok = (content: string, usage?: unknown) => ({ ok: true as const, content, ...(usage ? { usage } : {}) });
const getRow = (db: DatabaseSync, req: string) =>
  db.prepare('SELECT * FROM agent_runs WHERE request_id=?').get(req) as Record<string, unknown>;
const msgCount = (db: DatabaseSync, role?: string) =>
  role
    ? (db.prepare(`SELECT COUNT(*) n FROM agent_messages WHERE role='${role}'`).get() as { n: number }).n
    : (db.prepare('SELECT COUNT(*) n FROM agent_messages').get() as { n: number }).n;

test('1 上游无用量：usage_json=NULL、无 usage_warning（正常未知）', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: ok('回复', undefined) }]);
  const r = await runAgentTurn(db, 's1', { request_id: 'r1', content: '问题' }, adapter);
  const p = r.payload as { status: string; usage_json: string | null; usage_warning?: string };
  assert.equal(p.status, 'succeeded');
  assert.equal(p.usage_json, null);
  assert.equal(p.usage_warning, undefined, '正常未知用量不得报故障警告');
});

test('2/3 有效用量写入失败：usage_warning + system 故障说明 + 回复保留（从库重读）', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: ok('重要回复', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) }]);
  const restore = inject(db, 'usage_json=?, rounds=1', 'throw');
  const r = await runAgentTurn(db, 's1', { request_id: 'r2', content: '问题' }, adapter);
  restore();
  const p = r.payload as { status: string; usage_json: string | null; usage_warning?: string; message: { content: string } };
  assert.equal(p.status, 'succeeded', '有效回复不得因用量故障丢弃');
  assert.match(String(p.usage_warning), /用量持久化失败/);
  assert.equal(p.usage_json, null, '不伪造用量数字');
  assert.equal(p.message.content, '重要回复');
  // 从数据库重读（不信响应）：助手消息 + system 故障说明 + 终态一致
  const row = getRow(db, 'r2');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.usage_json, null);
  const sys = db.prepare("SELECT content FROM agent_messages WHERE role='system'").all() as Array<{ content: string }>;
  assert.equal(sys.length, 1);
  assert.match(sys[0].content, /用量持久化失败/);
  const agentMsgs = db.prepare("SELECT content FROM agent_messages WHERE role='agent'").all() as Array<{ content: string }>;
  assert.equal(agentMsgs.length, 1);
  assert.equal(agentMsgs[0].content, '重要回复');
});

test('4 后续事务失败：不声称已持久化，run 停留 running', async () => {
  const db = setup();
  const { adapter, calls } = scripted([{ value: ok('回复', { total_tokens: 15 }) }]);
  // 注入：用量写入与 system 故障说明均失败 → 整个事务回滚
  const restore = inject(db, ['usage_json=?, rounds=1', "VALUES (?,?,'system'"], 'throw');
  const r = await runAgentTurn(db, 's1', { request_id: 'r4', content: '问题' }, adapter);
  restore();
  const p = r.payload as { status: string; warning?: string };
  assert.equal(p.status, 'running', '事务失败不得宣称终态');
  assert.match(String(p.warning), /未保存|持久化失败/);
  const row = getRow(db, 'r4');
  assert.equal(row.status, 'running');
  assert.equal(row.rounds, -1, '未决 running 保留执行中哨兵');
  assert.equal(row.usage_json, null, '回滚后无伪造用量');
  assert.equal(msgCount(db), 1, '仅用户消息留存');
  const replay = await runAgentTurn(db, 's1', { request_id: 'r4', content: '问题' }, adapter);
  assert.equal((replay.payload as { in_progress: boolean }).in_progress, true, '未决重放不重调模型');
  assert.equal(calls.length, 1, '模型调用计数不变');
});

test('5 成功响应读取最新数据库结果（非陈旧快照）', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: ok('回复', { total_tokens: 7 }) }]);
  const r = await runAgentTurn(db, 's1', { request_id: 'r5', content: '问题' }, adapter);
  const p = r.payload as { usage_json: string };
  const dbVal = (getRow(db, 'r5').usage_json) as string;
  assert.equal(p.usage_json, dbVal, '响应用量与库内一致');
});

test('6 工具拒绝路径：transitRun 0 行时不谎报转换成功', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: { ok: true, content: '', toolCalls: [{ name: 'delete_all', arguments: {} }] } }]);
  const restore = inject(db, 'finished_at = ?', 'zero');
  const r = await runAgentTurn(db, 's1', { request_id: 'r6', content: '问题' }, adapter);
  restore();
  const p = r.payload as { status: string; warning?: string };
  assert.equal(p.status, 'running', '0 行不得谎报 failed');
  assert.match(String(p.warning), /0 行/);
  const row = getRow(db, 'r6');
  assert.equal(row.status, 'running');
  assert.equal(row.rounds, -1, '0 行未决保留哨兵');
});

test('7 重放不重复插入助手/故障说明消息', async () => {
  const db = setup();
  const { adapter } = scripted([{ value: ok('回复', { total_tokens: 5 }) }]);
  await runAgentTurn(db, 's1', { request_id: 'r7', content: '问题' }, adapter);
  const agentBefore = msgCount(db, 'agent');
  const sysBefore = msgCount(db, 'system');
  for (let i = 0; i < 3; i++) {
    await runAgentTurn(db, 's1', { request_id: 'r7', content: '问题' }, adapter);
  }
  assert.equal(msgCount(db, 'agent'), agentBefore, '重放不得新增助手消息');
  assert.equal(msgCount(db, 'system'), sysBefore, '重放不得新增故障说明');
});

test('8 既有语义回归：409/未配置映射/状态守卫', async () => {
  const db = setup();
  const { adapter } = scripted([
    { value: ok('a') },
    { value: { ok: false, error_kind: 'not_configured', error: '模型密钥未配置' } },
  ]);
  await runAgentTurn(db, 's1', { request_id: 'r8', content: '输入一' }, adapter);
  const conflict = await runAgentTurn(db, 's1', { request_id: 'r8', content: '输入二' }, adapter);
  assert.equal(conflict.status, 409);
  const other = setup();
  const r = await runAgentTurn(other, 's1', { request_id: 'r8', content: '问题' }, adapter);
  const row = getRow(other, 'r8');
  assert.equal(row.error_kind, 'model_error');
  assert.match(String(row.error_detail), /^not_configured: /);
  assert.equal(transitRun(other, 'r8', 'failed', 'running'), 0, '终态不可复活');
});

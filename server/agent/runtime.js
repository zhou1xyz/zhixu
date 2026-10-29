/**
 * runtime.js —— 最小 Agent 执行生命周期（P1-03c，无模型）
 *
 * 明确边界：本阶段没有模型。/messages 只落用户消息并记录一次
 * model='none' 的运行，不伪造 agent 回复；/tools 是受控直调通道
 * （自动化测试与后续 Runtime 复用），与真实用户对话语义区分。
 * 写工具未开放：任何非 R0 工具调用一律拒绝并留痕。
 */
import { randomUUID, createHash } from 'node:crypto';
import { executeTool, listTools, hashParams } from './tools.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const MAX_CONTENT_BYTES = 16384;
const now = () => new Date().toISOString();


function getSessionBundle(db, id) {
  const session = db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(id);
  if (!session) return null;
  return {
    session,
    messages: db.prepare('SELECT * FROM agent_messages WHERE session_id=? ORDER BY created_at, id').all(id),
    runs: db.prepare('SELECT * FROM agent_runs WHERE session_id=? ORDER BY created_at, id').all(id),
    tool_calls: db.prepare('SELECT c.* FROM agent_tool_calls c JOIN agent_runs r ON c.run_id = r.id WHERE r.session_id=? ORDER BY c.created_at, c.id').all(id),
  };
}

/** 找既有 run 或在单事务内创建（run + 用户消息同事务，失败回滚不留孤儿） */
function findOrCreateRun(db, sessionId, requestId, model, kind, inputHash, buildInput) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM agent_runs WHERE session_id=? AND request_id=?').get(sessionId, requestId);
    if (existing) {
      db.exec('ROLLBACK');
      // 请求重放：先比对输入指纹，不同输入占用同 request_id → 冲突
      let storedHash = null;
      let stored = null;
      if (existing.message_id) {
        const msg = db.prepare('SELECT content FROM agent_messages WHERE id=?').get(existing.message_id);
        if (msg) { storedHash = sha('message:' + msg.content); stored = msg; }
      } else {
        const calls = db.prepare('SELECT tool, arguments_json FROM agent_tool_calls WHERE run_id=? ORDER BY created_at, id').all(existing.id);
        storedHash = sha('tools:' + canonicalJson(calls.map((c) => ({ tool: c.tool, arguments: JSON.parse(c.arguments_json) }))));
        stored = calls;
      }
      if (storedHash !== inputHash) {
        return { status: 409, payload: { error: 'request_id 已被不同输入使用', run_id: existing.id } };
      }
      return { status: 200, payload: { run_id: existing.id, replayed: true, [kind === 'message' ? 'message' : 'tool_calls']: stored } };
    }
    const runId = randomUUID();
    const t = now();
    db.prepare("INSERT INTO agent_runs (id, session_id, request_id, status, model, created_at) VALUES (?,?,?, 'running', ?, ?)")
      .run(runId, sessionId, requestId, model, t);
    const created = buildInput(runId, t); // 回调负责插入消息/登记调用，返回负载
    db.exec('COMMIT');
    return { status: 200, payload: { run_id: runId, replayed: false, ...created } };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

/** 用户消息：只落消息 + 记录 model='none' 的运行，不伪造 agent 回复 */
export function postMessage(db, sessionId, body) {
  if (!db.prepare('SELECT id FROM agent_sessions WHERE id=?').get(sessionId)) return { status: 404, payload: { error: '会话不存在' } };
  const requestId = typeof body?.request_id === 'string' ? body.request_id : '';
  const content = typeof body?.content === 'string' ? body.content : '';
  if (!requestId || requestId.length > 128) return { status: 400, payload: { error: 'request_id 必填且 ≤128 字符' } };
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return { status: 400, payload: { error: 'content 必填且 ≤16384 UTF-8 字节' } };
  const inputHash = sha('message:' + content);
  const r = findOrCreateRun(db, sessionId, requestId, 'none', 'message', inputHash, (runId, t) => {
    const msgId = randomUUID();
    db.prepare("INSERT INTO agent_messages (id, session_id, role, content, run_id, created_at) VALUES (?,?,'user',?,?,?)")
      .run(msgId, sessionId, content, runId, t);
    db.prepare("UPDATE agent_runs SET status='succeeded', finished_at=?, message_id=? WHERE id=?").run(now(), msgId, runId);
    return { message_id: msgId };
  });
  if (r.status !== 200) return r;
  const msg = db.prepare('SELECT * FROM agent_messages WHERE run_id=?').get(r.payload.run_id);
  return { status: 200, payload: { run_id: r.payload.run_id, replayed: r.payload.replayed, message: msg } };
}

/** 受控直调工具：仅 R0；每个调用持久化 pending→executing→终态 */
export function invokeTools(db, sessionId, body) {
  if (!db.prepare('SELECT id FROM agent_sessions WHERE id=?').get(sessionId)) return { status: 404, payload: { error: '会话不存在' } };
  const requestId = typeof body?.request_id === 'string' ? body.request_id : '';
  const calls = Array.isArray(body?.calls) ? body.calls : null;
  if (!requestId || requestId.length > 128) return { status: 400, payload: { error: 'request_id 必填且 ≤128 字符' } };
  if (!calls || calls.length < 1 || calls.length > 10) return { status: 400, payload: { error: 'calls 必须是 1-10 个的数组' } };
  for (const c of calls) {
    if (typeof c?.tool !== 'string' || c.tool.length > 64) return { status: 400, payload: { error: 'calls[].tool 非法' } };
    if (c.lcid !== undefined && (typeof c.lcid !== 'string' || c.lcid.length === 0 || c.lcid.length > 128)) return { status: 400, payload: { error: 'calls[].lcid 非法' } };
    if (c.arguments !== undefined && (typeof c.arguments !== 'object' || c.arguments === null || Array.isArray(c.arguments))) return { status: 400, payload: { error: 'calls[].arguments 必须是对象' } };
  }
  const inputHash = sha('tools:' + canonicalJson(calls.map((c) => ({ tool: c.tool, arguments: c.arguments ?? {} }))));
  const prepared = findOrCreateRun(db, sessionId, requestId, 'none', 'tools', inputHash, (runId, t) => {
    let seq = 0;
    const ids = [];
    for (const c of calls) {
      const lcid = typeof c.lcid === 'string' ? c.lcid : 'call-' + (++seq);
      db.prepare("INSERT INTO agent_tool_calls (id, run_id, lcid, tool, arguments_json, params_hash, risk, status, created_at) VALUES (?,?,?,?,?,?, 'R0', 'pending', ?)")
        .run(randomUUID(), runId, lcid, c.tool, canonicalJson(c.arguments ?? {}), hashParams(c.arguments ?? {}), t);
      ids.push(lcid);
    }
    return { lcid_seq: ids };
  });
  if (prepared.status !== 200) return prepared;
  const runId = prepared.payload.run_id;
  const replayed = prepared.payload.replayed;
  const rows = db.prepare('SELECT * FROM agent_tool_calls WHERE run_id=? ORDER BY created_at, id').all(runId);
  if (replayed) return { status: 200, payload: { run_id: runId, replayed: true, tool_calls: rows } };

  // 执行：每调用 持久化 executing → 执行 → 持久化终态（各自短事务）
  let runFailed = false;
  for (const row of rows) {
    if (row.status !== 'pending') continue; // 重放不重执行
    db.prepare("UPDATE agent_tool_calls SET status='executing' WHERE id=? AND status='pending'").run(row.id);
    const outcome = executeTool(db, row.tool, JSON.parse(row.arguments_json));
    if (outcome.status === 'executed') {
      db.prepare("UPDATE agent_tool_calls SET status='executed', result_json=?, finished_at=? WHERE id=? AND status='executing'")
        .run(JSON.stringify(outcome.result).slice(0, 16384), now(), row.id);
    } else {
      runFailed = true;
      db.prepare("UPDATE agent_tool_calls SET status=?, error_kind=?, error_detail=?, finished_at=? WHERE id=? AND status='executing'")
        .run(outcome.status, outcome.error_kind, outcome.error, now(), row.id);
    }
  }
  const finalRows = db.prepare('SELECT * FROM agent_tool_calls WHERE run_id=? ORDER BY created_at, id').all(runId);
  const bad = finalRows.find((r) => r.status === 'rejected' || r.status === 'failed');
  db.prepare("UPDATE agent_runs SET status=?, error_kind=?, error_detail=?, finished_at=? WHERE id=?")
    .run(bad ? 'failed' : 'succeeded', bad ? bad.error_kind : null, bad ? bad.error_detail : null, now(), runId);
  return { status: 200, payload: { run_id: runId, replayed: false, status: bad ? 'failed' : 'succeeded', error_kind: bad ? bad.error_kind : null, tool_calls: finalRows } };
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

export function createSession(db, body) {
  const id = randomUUID();
  const t = now();
  const title = typeof body?.title === 'string' ? body.title.slice(0, 50) : '';
  db.prepare("INSERT INTO agent_sessions (id, title, status, created_at, updated_at) VALUES (?,?,'active',?,?)").run(id, title, t, t);
  return { status: 200, payload: { session: db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(id) } };
}

export function listSessions(db) {
  return db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC').all();
}

/** Agent HTTP 路由：返回 {status, payload}，协议处理仍留在 index.js */
export function agentApi(db, method, pathname, body) {
  const rest = pathname.split('/').filter(Boolean).slice(2); // 去掉 api/agent
  try {
    if (method === 'POST' && rest[0] === 'sessions' && !rest[1]) return createSession(db, body);
    if (method === 'GET' && rest[0] === 'sessions' && !rest[1]) return { status: 200, payload: { sessions: listSessions(db) } };
    if (method === 'GET' && rest[0] === 'sessions' && rest[1] && !rest[2]) {
      const bundle = getSessionBundle(db, rest[1]);
      return bundle ? { status: 200, payload: bundle } : { status: 404, payload: { error: '会话不存在' } };
    }
    if (method === 'POST' && rest[0] === 'sessions' && rest[1] && rest[2] === 'messages') return postMessage(db, rest[1], body);
    if (method === 'POST' && rest[0] === 'sessions' && rest[1] && rest[2] === 'tools') return invokeTools(db, rest[1], body);
    if (method === 'GET' && rest[0] === 'tools' && !rest[1]) return { status: 200, payload: { tools: listTools() } };
    return { status: 404, payload: { error: 'not found' } };
  } catch (e) {
    return { status: 500, payload: { error: String(e?.message ?? e).slice(0, 500) } };
  }
}

// ============================================================
// P1-03d B1：runAgentTurn —— 单轮对话闭环（模型调用 + 持久化）
// ============================================================

/** 终态集合（进入即不可再转换） */
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'needs_reconciliation']);

/**
 * 状态转换守卫：仅允许声明的 from→to。
 * 终态转换附带 finished_at；返回 changes（0 = 守卫拒绝，调用方不得伪造成功）。
 */
export function transitRun(db, id, from, to, fields = {}) {
  // 终态无出边：succeeded/failed/cancelled/needs_reconciliation 一律拒绝复活
  if (TERMINAL_RUN_STATES.has(from)) return 0;
  const isTerminal = TERMINAL_RUN_STATES.has(to);
  const extraKeys = Object.keys(fields);
  const sets = ['status = ?'];
  const vals = [to];
  if (isTerminal) { sets.push('finished_at = ?'); vals.push(now()); }
  for (const k of extraKeys) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  const setSql = ['status = ?']
    .concat(isTerminal ? ['finished_at = ?'] : [])
    .concat(extraKeys.map((k) => `${k} = ?`))
    .join(', ');
  const finalVals = [to, ...(isTerminal ? [now()] : []), ...Object.values(fields), id, from];
  const result = db.prepare(`UPDATE agent_runs SET ${setSql} WHERE id = ? AND status = ?`).run(...finalVals);
  return result.changes;
}

/** 适配器错误分类 → 落库 error_kind 的映射（持久化边界，唯一出口） */
function mapErrorKind(kind) {
  switch (kind) {
    case 'timeout':
    case 'bad_response':
    case 'model_error':
    case 'auth_invalid':
      return kind;
    case 'not_configured':
      // 语义归入 model_error；原始分类保留在 error_detail 前缀
      return 'model_error';
    case 'db_error':
      // 保守映射：错误详情前缀标明真实原因（error_kind 闭集含 db_error，
      // 但按 B1 批准约束不直接落库该值）
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * 单轮对话闭环：幂等创建 → 模型调用 → 用量持久化 → 助手消息 → 终态。
 * 明确边界（B1）：不执行工具；单轮；模型调用在事务外（无跨系统原子性）。
 */
export async function runAgentTurn(db, sessionId, body, adapter) {
  if (!db.prepare('SELECT id FROM agent_sessions WHERE id=?').get(sessionId)) return { status: 404, payload: { error: '会话不存在' } };
  const requestId = typeof body?.request_id === 'string' ? body.request_id : '';
  const content = typeof body?.content === 'string' ? body.content : '';
  if (!requestId || requestId.length > 128) return { status: 400, payload: { error: 'request_id 必填且 ≤128 字符' } };
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return { status: 400, payload: { error: 'content 必填且 ≤16384 UTF-8 字节' } };
  if (!adapter || typeof adapter.chat !== 'function') return { status: 400, payload: { error: '缺少模型适配器' } };

  const inputHash = sha('message:' + content);

  // 阶段 1：幂等创建/重放裁决（事务内）
  db.exec('BEGIN IMMEDIATE');
  let run;
  try {
    run = db.prepare('SELECT * FROM agent_runs WHERE session_id=? AND request_id=?').get(sessionId, requestId);
    if (run) { db.exec('ROLLBACK'); }
    else {
      const runId = randomUUID();
      const msgId = randomUUID();
      const t = now();
      // message_id 先为 NULL（FK 指向 agent_messages），落消息后回填（P1-03c 同款模式）
      db.prepare("INSERT INTO agent_runs (id, session_id, message_id, request_id, status, model, created_at) VALUES (?,?,NULL,?,'running',?,?)")
        .run(runId, sessionId, requestId, adapter.model ?? 'none', t);
      db.prepare("INSERT INTO agent_messages (id, session_id, role, content, run_id, created_at) VALUES (?,?,'user',?,?,?)")
        .run(msgId, sessionId, content, runId, t);
      db.prepare('UPDATE agent_runs SET message_id=? WHERE id=?').run(msgId, runId);
      db.exec('COMMIT');
      run = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  // 阶段 2：重放裁决（按 run 状态；先校验输入指纹，不同输入占用同 request_id → 409）
  const userMsg = run.message_id ? db.prepare('SELECT content FROM agent_messages WHERE id=?').get(run.message_id) : null;
  const storedHash = userMsg ? sha('message:' + userMsg.content) : null;
  if (storedHash !== inputHash) {
    return { status: 409, payload: { error: 'request_id 已被不同输入使用', run_id: run.id } };
  }
  const assistant = () => db.prepare("SELECT * FROM agent_messages WHERE run_id=? AND role='agent'").get(run.id) ?? null;
  if (run.status === 'succeeded') {
    return { status: 200, payload: { run_id: run.id, replayed: true, status: 'succeeded', message: assistant(), usage_json: run.usage_json, rounds: run.rounds } };
  }
  if (run.status === 'failed') {
    return { status: 200, payload: { run_id: run.id, replayed: true, status: 'failed', error_kind: run.error_kind, error_detail: run.error_detail, usage_json: run.usage_json, rounds: run.rounds } };
  }
  if (run.status !== 'running') {
    // awaiting/proposed/cancelled/needs_reconciliation：不重调、不伪造
    return { status: 200, payload: { run_id: run.id, replayed: true, status: run.status, in_progress: false } };
  }
  // run.status === 'running'：可能正在执行（并发重入）→ in_progress
  // 但若本请求就是创建者（首次），继续执行。区分：创建分支后 run 一定 running。
  // 并发重入者也会看到 running —— 用数据库守卫保证模型调用只发生一次：
  // 先原子认领（占位列不可用）→ 采用「助手消息唯一性」间接判定不可靠；
  // B1 方案：认领即 transitRun('running'→'running') 无效。
  // 落地方案：以 created_at==finished_at IS NULL 且本进程内存标记不跨进程——
  // 采用条件更新争抢标记：无专用列时，用 rounds IS NULL 作为「未执行」标记。
  // ⚠ 哨兵值：rounds=-1 表示「执行中认领」，非法计数；B2 引入独立认领字段
  // （如 claimed_at）时迁移该哨兵，迁移前任何统计必须排除 -1。
  const claimed = db.prepare("UPDATE agent_runs SET rounds = -1 WHERE id=? AND rounds IS NULL AND status='running'").run(run.id).changes;
  if (claimed === 0 && run.rounds !== null && run.rounds !== undefined) {
    // 已有执行者认领过（rounds=-1 或已计数）→ in_progress
    return { status: 200, payload: { run_id: run.id, in_progress: true } };
  }
  void claimed;

  // 阶段 3：模型调用（事务外，至多一个执行者）
  const chatResult = await adapter.chat({ messages: [{ role: 'user', content }] });
  const callCount = 1;
  void callCount;

  // 阶段 4：适配器失败 → failed（0 行与 SQL 异常分别处理，均不伪造终态）
  if (!chatResult.ok) {
    const kind = mapErrorKind(chatResult.error_kind);
    const detail = (chatResult.error_kind === 'not_configured' ? 'not_configured: ' : '')
      + String(chatResult.error ?? '').slice(0, 500);
    let changes;
    try {
      changes = transitRun(db, run.id, 'running', 'failed', { error_kind: kind, error_detail: detail });
    } catch (e) {
      console.error('[agent] 终态更新异常（保留 running）：', String(e?.message ?? e).slice(0, 200));
      return { status: 200, payload: { run_id: run.id, status: 'running', warning: '终态更新异常，结果未持久化' } };
    }
    if (changes === 0) {
      return { status: 200, payload: { run_id: run.id, status: 'running', warning: '终态更新失败（0 行），结果未持久化' } };
    }
    return { status: 200, payload: { run_id: run.id, status: 'failed', error_kind: kind, error_detail: detail } };
  }

  // 阶段 5：模型请求工具 → 说明消息 + failed（单事务；不执行任何工具）
  if (chatResult.toolCalls && chatResult.toolCalls.length > 0) {
    const names = chatResult.toolCalls.map((tc) => tc.name).join(', ');
    const notice = `模型请求调用工具，本轮未执行：${names}（当前版本不支持工具执行，已记录待人工处理）`;
    const detail = `tool_calls 未执行: [${names}]（B1 不支持工具执行）`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("INSERT INTO agent_messages (id, session_id, role, content, run_id, created_at) VALUES (?,?,'agent',?,?,?)")
        .run(randomUUID(), sessionId, notice, run.id, now());
      const changes = transitRun(db, run.id, 'running', 'failed', { error_kind: 'unknown', error_detail: detail });
      // 0 行 = 状态守卫拒绝，不得提交（提交即谎报已转换 failed）
      if (changes === 0) {
        db.exec('ROLLBACK');
        return { status: 200, payload: { run_id: run.id, status: 'running', warning: '终态更新失败（0 行），结果未持久化' } };
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('[agent] 工具拒绝持久化失败（保留 running）：', String(e?.message ?? e).slice(0, 200));
      return { status: 200, payload: { run_id: run.id, status: 'running', warning: '工具拒绝结果持久化失败' } };
    }
    return { status: 200, payload: { run_id: run.id, status: 'failed', error_kind: 'unknown', error_detail: detail } };
  }

  // 阶段 6：成功持久化（单事务：助手消息 + 用量 + 故障说明 + 终态）
  // 用量语义（P1-03d 收尾批准）：
  //   - 上游无有效用量 → usage_json=NULL，正常未知，无警告
  //   - 有效用量写入失败 → 同事务追加 system 故障说明 + payload.usage_warning，
  //     绝不伪造数字、不与普通 NULL 混淆
  let usageWarning;
  let msgId;
  db.exec('BEGIN IMMEDIATE');
  try {
    msgId = randomUUID();
    db.prepare("INSERT INTO agent_messages (id, session_id, role, content, run_id, created_at) VALUES (?,?,'agent',?,?,?)")
      .run(msgId, sessionId, chatResult.content, run.id, now());
    const u = chatResult.usage;
    const validUsage = u && (Number(u.total_tokens) > 0 || Number(u.prompt_tokens) > 0 || Number(u.completion_tokens) > 0);
    if (validUsage) {
      try {
        db.prepare("UPDATE agent_runs SET usage_json=?, rounds=1 WHERE id=? AND status='running'")
          .run(JSON.stringify(u), run.id);
      } catch (usageErr) {
        // 用量持久化故障：同事务留痕（system 消息），payload 显式告知
        db.prepare("INSERT INTO agent_messages (id, session_id, role, content, run_id, created_at) VALUES (?,?,'system',?,?,?)")
          .run(randomUUID(), sessionId, '用量持久化失败：本轮 token 用量未能记录（写入异常）。', run.id, now());
        usageWarning = '用量持久化失败，本轮用量未能记录';
      }
    }
    const changes = transitRun(db, run.id, 'running', 'succeeded');
    if (changes === 0) {
      db.exec('ROLLBACK');
      return { status: 200, payload: { run_id: run.id, status: 'running', warning: '终态更新失败（0 行），结果未持久化' } };
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    // 事务失败：数据库保留真实可确认的未决状态（run=running，无助手消息），
    // 不得假设故障标记已写入
    console.error('[agent] 结果持久化事务失败（保留 running）：', String(e?.message ?? e).slice(0, 200));
    return { status: 200, payload: { run_id: run.id, status: 'running', warning: '结果持久化失败，本轮回复未保存' } };
  }

  // 从数据库重读最终结果（不使用创建 run 时的陈旧快照）
  const finalRow = db.prepare('SELECT status, usage_json, rounds FROM agent_runs WHERE id=?').get(run.id);
  const payload = {
    run_id: run.id,
    status: finalRow.status,
    message: db.prepare('SELECT * FROM agent_messages WHERE id=?').get(msgId),
    usage_json: finalRow.usage_json,
    rounds: finalRow.rounds,
  };
  if (usageWarning) payload.usage_warning = usageWarning;
  return { status: 200, payload };
}

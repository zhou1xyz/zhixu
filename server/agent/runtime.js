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

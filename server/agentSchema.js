/**
 * agentSchema —— P1-03b：Agent 会话与执行记录五张表（DDL v4 定稿）
 *
 * 外键声明均为文档性（PRAGMA foreign_keys 未启用，运行时由应用层维护，
 * 维护规则见 docs P1-03b 设计报告 §1/§3）。删除策略：
 *   - 删 run：应用层先将 agent_messages.run_id 置 NULL（保留消息），再删 run
 *   - 删会话：单事务按 confirmations → tool_calls → runs → messages → sessions 顺序
 */

/** 归一化 DDL 文本用于结构比对（空白折叠） */
export function normalizeSql(sql) {
  // sqlite_master 存储的 DDL 不含 IF NOT EXISTS（SQLite 剥离），比对时两侧同剥
  return String(sql).replace(/\s+/g, ' ').replace(/IF NOT EXISTS /gi, '').trim();
}

const TABLES = [
  { name: 'agent_sessions', sql: `CREATE TABLE IF NOT EXISTS agent_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','archived')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)` },
  { name: 'agent_runs', sql: `CREATE TABLE IF NOT EXISTS agent_runs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id),
  message_id    TEXT UNIQUE REFERENCES agent_messages(id),
  request_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
                  'running','proposed','awaiting_confirm',
                  'succeeded','failed','cancelled','needs_reconciliation')),
  model         TEXT NOT NULL,
  result_json   TEXT,
  confirmed_at  TEXT,
  error_kind    TEXT CHECK (error_kind IS NULL OR error_kind IN (
                  'timeout','bad_response','param_invalid','param_mismatch',
                  'tool_error','db_error','auth_invalid','model_error','unknown')),
  error_detail  TEXT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
)` },
  { name: 'agent_messages', sql: `CREATE TABLE IF NOT EXISTS agent_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
  role        TEXT NOT NULL CHECK (role IN ('user','agent','system')),
  content     TEXT NOT NULL,
  run_id      TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
)` },
  { name: 'agent_tool_calls', sql: `CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES agent_runs(id),
  lcid            TEXT NOT NULL,
  tool            TEXT NOT NULL,
  arguments_json  TEXT NOT NULL,
  params_hash     TEXT NOT NULL,
  risk            TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending','executing','executed','failed',
                    'outcome_unknown','rejected')),
  result_json     TEXT,
  error_kind      TEXT CHECK (error_kind IS NULL OR error_kind IN (
                    'timeout','bad_response','param_invalid','param_mismatch',
                    'tool_error','db_error','auth_invalid','model_error','unknown')),
  error_detail    TEXT,
  verified_at     TEXT,
  created_at      TEXT NOT NULL,
  finished_at     TEXT
)` },
  { name: 'agent_confirmations', sql: `CREATE TABLE IF NOT EXISTS agent_confirmations (
  id              TEXT PRIMARY KEY,
  tool_call_id    TEXT NOT NULL UNIQUE REFERENCES agent_tool_calls(id),
  confirm_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending','confirmed','consumed','invalid')),
  confirmed_at    TEXT,
  consumed_at     TEXT,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
)` },
];

const INDEXES = [
  { name: 'idx_agent_messages_session', sql: `CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at)` },
  { name: 'uq_agent_runs_session_request', sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_session_request ON agent_runs(session_id, request_id)` },
  { name: 'idx_agent_runs_session', sql: `CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, created_at)` },
  { name: 'uq_agent_tool_calls_run_lcid', sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_calls_run_lcid ON agent_tool_calls(run_id, lcid)` },
  { name: 'idx_agent_tool_calls_run', sql: `CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id)` },
];

/**
 * 建 Agent 五表与索引：单事务 + 幂等（IF NOT EXISTS）+ 事务内结构自检。
 * 自检失败（同名对象结构不一致）→ 抛错 → 整体回滚，不静默。
 */
export function createAgentTables(database) {
  database.exec('BEGIN');
  try {
    for (const t of TABLES) database.exec(t.sql);
    ensureAgentColumns(database);
    for (const i of INDEXES) database.exec(i.sql);
    verifyAgentSchema(database);
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 老库增列（P1-03d-A）：agent_runs 补 usage_json / rounds。
 * 仅增列，不改既有字段、不回填；幂等。
 */
export function ensureAgentColumns(database) {
  const need = { agent_runs: [['usage_json', 'TEXT'], ['rounds', 'INTEGER']] };
  for (const [table, cols] of Object.entries(need)) {
    const existing = new Set(
      database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
    );
    for (const [col, type] of cols) {
      if (!existing.has(col)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      }
    }
  }
}


/** 从 CREATE TABLE 模板提取列名集合（括号深度感知，跳过表级约束） */
function requiredColumns(createSql) {
  const body = createSql.slice(createSql.indexOf('(') + 1, createSql.lastIndexOf(')'));
  const segs = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { segs.push(cur); cur = ''; } else { cur += ch; }
  }
  segs.push(cur);
  return segs
    .map((x) => x.trim().replace(/,$/, '').trim())
    .filter((x) => x && !/^(CHECK|UNIQUE|PRIMARY|FOREIGN)\b/i.test(x))
    .map((x) => x.split(/\s+/)[0]);
}

/** 结构自检：表存在 + 必需列齐（列集比对，兼容 ALTER 增列）+ 索引比对 */
export function verifyAgentSchema(database) {
  for (const t of TABLES) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t.name);
    if (!row) throw new Error(`Agent 表缺失：${t.name}`);
    const cols = new Set(database.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name));
    for (const c of requiredColumns(t.sql)) {
      if (!cols.has(c)) throw new Error(`Agent 表缺列：${t.name}.${c}`);
    }
  }
  for (const i of INDEXES) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(i.name);
    if (!row) throw new Error(`Agent 索引缺失：${i.name}`);
    if (normalizeSql(row.sql) !== normalizeSql(i.sql)) {
      throw new Error(`Agent 索引结构不一致：${i.name}`);
    }
  }
}

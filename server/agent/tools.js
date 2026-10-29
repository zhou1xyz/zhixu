/**
 * tools.js —— Agent 工具注册表（P1-03c）
 *
 * 服务端唯一定义：工具名、参数 schema、风险等级。调用方无法覆盖 risk。
 * 不暴露 SQL、不 eval、不动态导入。写工具未开放（本期仅 R0 只读）。
 */
import { createHash } from 'node:crypto';

/** 确定性序列化：键排序、数组保序 → 同参数必同哈希 */
export function canonicalizeParams(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalizeParams).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizeParams(value[k])).join(',') + '}';
}

export function hashParams(value) {
  return createHash('sha256').update(canonicalizeParams(value)).digest('hex');
}

const REGISTRY = {
  query_tasks: {
    risk: 'R0',
    description: '只读查询任务列表（可按状态/类别/关键字过滤，限 1-100 条）',
    validate(p) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: '参数必须是对象' };
      const out = {};
      if ('status' in p) {
        if (!['todo', 'waiting', 'done'].includes(p.status)) return { ok: false, error: 'status 只能是 todo/waiting/done' };
        out.status = p.status;
      }
      if ('category' in p) {
        if (!['work', 'personal', 'any'].includes(p.category)) return { ok: false, error: 'category 只能是 work/personal/any' };
        out.category = p.category;
      }
      if ('keyword' in p) {
        if (typeof p.keyword !== 'string' || p.keyword.length === 0 || p.keyword.length > 100) return { ok: false, error: 'keyword 必须是 1-100 字符' };
        out.keyword = p.keyword;
      }
      if ('limit' in p) {
        const n = Number(p.limit);
        if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false, error: 'limit 必须是 1-100 的整数' };
        out.limit = n;
      }
      return { ok: true, params: out };
    },
    execute(db, p) {
      let sql = 'SELECT id, title, status, category, deadline, estimatedHours, minHours, waitingHours, workHours, createdAt, completedAt FROM tasks';
      const conds = [];
      const vals = [];
      if (p.status) { conds.push('status = ?'); vals.push(p.status); }
      if (p.category) { conds.push('category = ?'); vals.push(p.category); }
      if (p.keyword) { conds.push('title LIKE ?'); vals.push('%' + p.keyword + '%'); }
      if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ');
      sql += ' ORDER BY createdAt DESC LIMIT ?';
      vals.push(p.limit ?? 20);
      const tasks = db.prepare(sql).all(...vals);
      return { tasks, count: tasks.length };
    },
  },
};

export function listTools() {
  return Object.entries(REGISTRY).map(([name, t]) => ({ name, risk: t.risk, description: t.description }));
}

/**
 * 受控执行：注册表查找 → 参数校验 → 执行。
 * 调用方传入的 risk 一律无效（注册表为准）。
 */
export function executeTool(db, name, args) {
  const tool = REGISTRY[name];
  if (!tool) return { status: 'rejected', error_kind: 'param_invalid', error: `未注册工具：${name}` };
  const v = tool.validate(args ?? {});
  if (!v.ok) return { status: 'rejected', error_kind: 'param_invalid', error: v.error };
  try {
    const result = tool.execute(db, v.params);
    return { status: 'executed', result };
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 500);
    const kind = /UNIQUE|CONSTRAINT|no such/i.test(msg) ? 'db_error' : 'tool_error';
    return { status: 'failed', error_kind: kind, error: msg };
  }
}

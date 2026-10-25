/**
 * 知序后端服务
 * ============
 *
 * 职责：
 *   1. 提供 /api/* 接口，读写 SQLite 数据库
 *   2. 把 dist/ 里的前端静态文件发给浏览器
 *
 * 为什么用原生 HTTP：没有框架依赖，300 多行就能说清全部行为，
 * 出问题看这一个文件就够。
 *
 * 数据放在 data/app.db（SQLite 单文件），备份就是复制这个文件。
 *
 * 写代码注意：
 *   - 所有 SQL 都用参数化（?），不要拼字符串，防注入
 *   - 更新任务时用 TASK_UPDATABLE_FIELDS 白名单过滤字段
 *   - 新增列用 ensureColumn，老库启动时自动补列
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { schedule } from '../shared/scheduler.ts';

const PORT = Number(process.env.PORT || 5190);
const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'app.db');

await mkdir(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// 表结构与前端 types 一一对应。taskFiles 为将来附件功能预留，当前不写入。
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  parentId TEXT,
  estimatedHours REAL NOT NULL DEFAULT 0,
  minHours REAL NOT NULL DEFAULT 0,
  deadline TEXT,
  actualHours REAL,
  isCompleted INTEGER NOT NULL DEFAULT 0,
  scheduledStartAt TEXT,
  startDate TEXT,
  completionNote TEXT,
  doneCriteria TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  remindDate TEXT,
  waitingNote TEXT,
  history TEXT,
  category TEXT NOT NULL DEFAULT 'any',
  createdAt TEXT,
  completedAt TEXT,
  firstStartedAt TEXT,
  waitingHours REAL,
  workHours REAL
);
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  fromTaskId TEXT NOT NULL,
  toTaskId TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'fs',
  lagDays REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS availabilityTemplates (
  id TEXT PRIMARY KEY,
  weekday INTEGER NOT NULL,
  startTime TEXT NOT NULL,
  endTime TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'any'
);
CREATE TABLE IF NOT EXISTS scheduleEntries (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  startAt TEXT NOT NULL,
  endAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS taskTemplates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS taskLogs (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS taskFiles (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  fileName TEXT NOT NULL,
  mimeType TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  storagePath TEXT,
  createdAt TEXT
);
`);

/** 轻量迁移：已有库补齐新增列，避免 CREATE TABLE IF NOT EXISTS 不生效 */
/**
 * 轻量迁移：老库缺列时补上。
 *
 * 为什么需要：CREATE TABLE IF NOT EXISTS 对已存在的表不起作用，
 * 所以新加的字段没法靠建表语句生效。启动时检查一遍，
 * 缺什么补什么，老数据不受影响。
 */
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

ensureColumn('tasks', 'startDate', 'TEXT');
ensureColumn('tasks', 'completionNote', 'TEXT');
ensureColumn('tasks', 'doneCriteria', 'TEXT');
ensureColumn('tasks', 'status', "TEXT NOT NULL DEFAULT 'todo'");
ensureColumn('tasks', 'remindDate', 'TEXT');
ensureColumn('tasks', 'waitingNote', 'TEXT');
ensureColumn('tasks', 'history', 'TEXT');
// v5.0：实际工时的自动计量。createdAt 是任务生命的起点，
// 没有它就算不出「实际跨度」，所以老任务这一列只能留空。
ensureColumn('tasks', 'createdAt', 'TEXT');
// v5.2：完成时刻。以前没这个字段，「完成时间」位置被塞进了排期计划开始时间，
// 导致已完成任务占用了还没到来的未来时段。这个字段只由服务端在状态转向 done 时写入。
ensureColumn('tasks', 'completedAt', 'TEXT');
ensureColumn('tasks', 'firstStartedAt', 'TEXT');
ensureColumn('tasks', 'waitingHours', 'REAL');
ensureColumn('tasks', 'workHours', 'REAL');
// 一次性迁移：把旧的 isCompleted=1 映射为 status='done'
db.exec("UPDATE tasks SET status = 'done' WHERE isCompleted = 1 AND (status IS NULL OR status = 'todo')");

const logRow = (row) => ({
  id: row.id,
  taskId: row.taskId,
  createdAt: row.createdAt,
  kind: row.kind ?? 'note',
  content: row.content,
});

const taskRow = (row) => ({
  id: row.id,
  title: row.title,
  parentId: row.parentId ?? null,
  estimatedHours: row.estimatedHours,
  minHours: row.minHours,
  deadline: row.deadline ?? null,
  actualHours: row.actualHours ?? null,
  isCompleted: row.isCompleted === 1,
  scheduledStartAt: row.scheduledStartAt ?? null,
  startDate: row.startDate ?? null,
  completionNote: row.completionNote ?? null,
  doneCriteria: row.doneCriteria ?? null,
  status: row.status ?? (row.isCompleted === 1 ? 'done' : 'todo'),
  remindDate: row.remindDate ?? null,
  waitingNote: row.waitingNote ?? null,
  history: row.history ?? null,
  category: row.category ?? 'any',
  createdAt: row.createdAt ?? null,
  completedAt: row.completedAt ?? null,
  firstStartedAt: row.firstStartedAt ?? null,
  waitingHours: row.waitingHours ?? null,
  workHours: row.workHours ?? null,
});

const depRow = (row) => ({
  id: row.id,
  fromTaskId: row.fromTaskId,
  toTaskId: row.toTaskId,
  type: row.type,
  lagDays: row.lagDays,
});

const availRow = (row) => ({
  id: row.id,
  weekday: row.weekday,
  startTime: row.startTime,
  endTime: row.endTime,
  category: row.category ?? 'any',
});

/**
 * 统一返回 JSON：自动设置 Content-Type 和 Content-Length，
 * 省得每个接口都写一遍。
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读取并解析请求体。
 * 空请求体返回空对象，这样 PATCH 传空也不会报错。
 */
// 请求体上限 1MB。本项目所有请求都是小 JSON，超过这个量级一定是异常调用，
// 直接断开，避免把整个进程内存吃掉。
const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('请求体过大');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * 把 dist/ 里的前端文件发给浏览器。
 *
 * 安全：先判断路径不能跑出 dist 目录，防止 ../ 越权读取系统文件。
 * 找不到的文件一律回落到 index.html —— 这是单页应用的标准做法，
 * 让前端路由能接管地址。
 */
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(DIST, rel));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const target = existsSync(filePath) ? filePath : join(DIST, 'index.html');
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/** 允许前端更新的任务字段白名单：挡住拼错或恶意字段名直接进 SQL */
const TASK_UPDATABLE_FIELDS = new Set([
  'title', 'parentId', 'estimatedHours', 'minHours', 'deadline', 'actualHours',
  'isCompleted', 'scheduledStartAt', 'category', 'startDate', 'completionNote',
  'doneCriteria', 'status', 'remindDate', 'waitingNote', 'history',
  // v5.0：完成时前端会带上算好的净工时，允许落库；
  // createdAt / firstStartedAt 是系统自己写的锚点，不接受外部传值
  'waitingHours', 'workHours',
]);

/**
 * 接口总调度：按「表名 + 方法」分发到不同的处理分支。
 *
 * 设计上的一个选择：不同表共用一个入口，用 if 分支区分，
 * 而不是拆成一堆路由文件。理由是接口总量只有十几个，
 * 放在一起反而更容易对照和排查。
 *
 * 字段安全：更新任务时只认白名单里的字段，
 * 前端传什么奇怪的字段名都不会进到 SQL 里。
 */
function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'tasks', ...]

  // GET /api/all —— 一次性取全部数据，前端启动时用
  if (req.method === 'GET' && url.pathname === '/api/all') {
    json(res, 200, {
      tasks: db.prepare('SELECT * FROM tasks').all().map(taskRow),
      dependencies: db.prepare('SELECT * FROM dependencies').all().map(depRow),
      availability: db.prepare('SELECT * FROM availabilityTemplates').all().map(availRow),
    });
    return;
  }

  const table = parts[1];
  const id = parts[2];

  // POST /api/schedule —— 用当前库里的数据算一遍排期，返回给前端
  // 算法放在后端，是为了以后小程序 / App / 桌面端共用同一套逻辑
  if (req.method === 'POST' && url.pathname === '/api/schedule') {
    const tasks = db.prepare('SELECT * FROM tasks').all().map(taskRow);
    const dependencies = db.prepare('SELECT * FROM dependencies').all().map(depRow);
    const availability = db.prepare('SELECT * FROM availabilityTemplates').all().map(availRow);
    try {
      json(res, 200, schedule(tasks, dependencies, availability));
    } catch (e) {
      json(res, 400, { error: String(e.message) });
    }
    return;
  }

  if (table === 'tasks') {
    if (req.method === 'GET') {
      json(res, 200, db.prepare('SELECT * FROM tasks').all().map(taskRow));
      return;
    }
    if (req.method === 'POST') {
      return readBody(req).then((t) => {
        db.prepare(
          `INSERT INTO tasks (id, title, parentId, estimatedHours, minHours, deadline, actualHours, isCompleted, scheduledStartAt, category, startDate, completionNote, doneCriteria, status, remindDate, waitingNote, history, createdAt, completedAt, firstStartedAt, waitingHours, workHours)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title, parentId=excluded.parentId, estimatedHours=excluded.estimatedHours,
             minHours=excluded.minHours, deadline=excluded.deadline, actualHours=excluded.actualHours,
             isCompleted=excluded.isCompleted, scheduledStartAt=excluded.scheduledStartAt, category=excluded.category, startDate=excluded.startDate, completionNote=excluded.completionNote, doneCriteria=excluded.doneCriteria, status=excluded.status, remindDate=excluded.remindDate, waitingNote=excluded.waitingNote, history=excluded.history,
             waitingHours=excluded.waitingHours, workHours=excluded.workHours`,
        ).run(
          t.id, t.title, t.parentId ?? null, t.estimatedHours ?? 0, t.minHours ?? 0,
          t.deadline ?? null, t.actualHours ?? null, t.isCompleted ? 1 : 0,
          t.scheduledStartAt ?? null, t.category ?? 'any', t.startDate ?? null, t.completionNote ?? null, t.doneCriteria ?? null, t.status ?? 'todo', t.remindDate ?? null, t.waitingNote ?? null, t.history ?? null,
          // createdAt 只在首次插入时生效：ON CONFLICT 分支不覆盖它，
          // 否则每次保存都会把「录入时刻」刷新成「最后编辑时刻」，起点就假了
          t.createdAt ?? new Date().toISOString(),
          // completedAt / firstStartedAt 与 PATCH 同一口径：不接受前端传值，
          // 由状态推导。v5.3.2 修复：旧版 POST 的 upsert 分支漏了这道闸，
          // 直连接口可以伪造完成时刻。
          (t.status ?? 'todo') === 'done' ? new Date().toISOString() : null,
          (t.status ?? 'todo') === 'done' ? new Date().toISOString() : null,
          t.waitingHours ?? null, t.workHours ?? null,
        );
        json(res, 200, { ok: true, id: t.id });
      }).catch((e) => json(res, 400, { error: String(e.message) }));
    }
    if (req.method === 'PATCH' && id) {
      return readBody(req).then((updates) => {
        const keys = Object.keys(updates);
        if (keys.length === 0) return json(res, 200, { ok: true, changed: 0 });
        const filtered = {};
        for (const key of keys) {
          if (TASK_UPDATABLE_FIELDS.has(key)) {
            filtered[key] = updates[key];
          }
        }
        if (Object.keys(filtered).length === 0) {
          return json(res, 400, { error: '没有可更新的合法字段' });
        }
        // 值域校验：字段名合法不代表值合法。前端有校验，但直接调接口能绕过，
        // 必须在服务端兜住——一条 estimatedHours=-5 或 status='乱写' 会污染整张排期。
        const VALID_STATUS = new Set(['todo', 'waiting', 'done']);
        const VALID_CATEGORY = new Set(['work', 'personal', 'any']);
        if ('status' in filtered && !VALID_STATUS.has(String(filtered.status))) {
          return json(res, 400, { error: 'status 只能是 todo / waiting / done' });
        }
        if ('category' in filtered && !VALID_CATEGORY.has(String(filtered.category))) {
          return json(res, 400, { error: 'category 只能是 work / personal / any' });
        }
        for (const numeric of ['estimatedHours', 'minHours', 'waitingHours', 'workHours']) {
          if (numeric in filtered) {
            const value = filtered[numeric];
            if (value !== null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
              return json(res, 400, { error: `${numeric} 必须是不小于 0 的数字` });
            }
          }
        }
        if ('estimatedHours' in filtered && Number(filtered.estimatedHours) <= 0) {
          return json(res, 400, { error: 'estimatedHours 必须大于 0' });
        }
        // 最短安排不能超过预估工期，否则排期算出来是无意义的。
        // 两个字段单独提交时，另一个的现值要从库里取出来一起比，
        // 否则只改 minHours 就能绕过这道校验。
        if ('minHours' in filtered || 'estimatedHours' in filtered) {
          const current = db.prepare('SELECT estimatedHours, minHours FROM tasks WHERE id=?').get(id);
          const est = 'estimatedHours' in filtered ? Number(filtered.estimatedHours) : Number(current?.estimatedHours ?? 0);
          const min = 'minHours' in filtered ? Number(filtered.minHours) : Number(current?.minHours ?? 0);
          if (min > est) {
            return json(res, 400, { error: 'minHours 不能大于 estimatedHours' });
          }
        }

        const mapped = { ...filtered };
        // 状态发生变化时，把一条流转记录追加到 history（JSON 文本）
        if (typeof mapped.status === 'string') {
          const before = db.prepare('SELECT status, history, waitingHours, workHours, firstStartedAt, createdAt FROM tasks WHERE id=?').get(id);
          if (before && before.status !== mapped.status) {
            let log = [];
            try {
              log = before.history ? JSON.parse(before.history) : [];
            } catch {
              log = [];
            }
            const nowMs = Date.now();
            // v5.0 自动计时：离开「等待中」时，把这段等待加进累计等待时长。
            // 为什么在这里算而不是前端算：等待是「发生了什么」，不是「谁点的按钮」，
            // 服务端落库时的时间才是唯一可信的时间轴。
            const lastEntry = log.length > 0 ? log[log.length - 1] : null;
            if (before.status === 'waiting' && mapped.status !== 'waiting' && lastEntry) {
              const enteredAt = Date.parse(lastEntry.at);
              if (Number.isFinite(enteredAt) && nowMs > enteredAt) {
                const deltaHours = (nowMs - enteredAt) / (60 * 60 * 1000);
                mapped.waitingHours = Math.round(((before.waitingHours ?? 0) + deltaHours) * 1000) / 1000;
              }
            }
            // 返工：离开「已完成」时不回滚净工时。
            // 为什么：那段时间是真的用掉了，返工与否都发生过。清零等于抹掉事实。
            // 再次完成时在原有累积量上继续加，得到的是这件事总共花掉的工作时间。
            // 第一次离开「等待中」进入待办，就是真正的开工时刻。
            // 已有值时不覆盖：开工只发生一次。
            if (before.status === 'waiting' && mapped.status === 'todo' && !before.firstStartedAt) {
              mapped.firstStartedAt = new Date(nowMs).toISOString();
            }
            // 完成时刻由服务端盖章，不接受前端传值。
            // 为什么必须服务端写：前端曾经把「排期计划开始时间」当完成时间传上来，
            // 结果已完成任务占住了还没到来的明天，后面的任务全被挤走。
            if (mapped.status === 'done') {
              mapped.completedAt = new Date(nowMs).toISOString();
            } else if (before.status === 'done') {
              // 返工：撤销完成时不保留完成时刻，等下次真正完成重新盖章
              mapped.completedAt = null;
            }

            // 点完成时结算净工时：本段净工时 = 本段跨度 - 本段等待，累加到已有值上。
            // 为什么累加：返工后再完成，是按第二次完成的时刻结算的。
            // 若不累加，返工前的净工时会随着「取消完成」一起被抹掉，只留下最后一段。
            // 旧任务没有时间锚点，退化为「预估工期」，宁可保守也不虚报。
            if (mapped.status === 'done') {
              const round3 = (v) => Math.round(v * 1000) / 1000;
              const prevWork = Number(before.workHours ?? 0);
              const prevWait = Number(before.waitingHours ?? 0);
              const newWait = Number(mapped.waitingHours ?? prevWait);
              // 本段等待 = 本次离开等待时新增的部分
              const segmentWaiting = Math.max(0, newWait - prevWait);
              const spanStart = before.firstStartedAt ?? before.createdAt;
              let segmentWork;
              if (spanStart) {
                // segmentStart 取「这段的起点」：首次完成时是开工时刻，
                // 返工后再完成时是上一次取消完成的时刻（已由 history 记录在案）。
                const reopenedAt = log.length > 0
                  ? log.filter((e) => e.from === 'done').map((e) => Date.parse(e.at)).pop()
                  : undefined;
                const segmentStart =
                  typeof reopenedAt === 'number' && Number.isFinite(reopenedAt)
                    ? Math.max(reopenedAt, Date.parse(spanStart))
                    : Date.parse(spanStart);
                const spanHours = Math.max(0, (nowMs - segmentStart) / (60 * 60 * 1000));
                segmentWork = Math.max(0, spanHours - segmentWaiting);
              } else {
                segmentWork = Number(before.estimatedHours ?? 0);
              }
              mapped.workHours = round3(prevWork + segmentWork);
            }
            log.push({
              at: new Date().toISOString(),
              from: before.status ?? null,
              to: mapped.status,
              note: mapped.waitingNote ?? null,
            });
            mapped.history = JSON.stringify(log);
            // isCompleted 是 status 的派生物，统一由 status 决定，不再分叉判断
            mapped.isCompleted = mapped.status === 'done' ? 1 : 0;
          }
        }
        if ('isCompleted' in mapped) mapped.isCompleted = mapped.isCompleted ? 1 : 0;
        const cols = Object.keys(mapped);
        const sql = `UPDATE tasks SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE id=?`;
        const result = db.prepare(sql).run(...cols.map((c) => mapped[c] ?? null), id);
        json(res, 200, { ok: true, changed: result.changes });
      }).catch((e) => json(res, 400, { error: String(e.message) }));
    }
    if (req.method === 'DELETE' && id) {
      // 与前端 repository 一致的级联语义：同一事务内完成
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM dependencies WHERE fromTaskId=? OR toTaskId=?').run(id, id);
        // v5.3.2：过程记录也一并删掉。旧版漏了这步，孤儿日志永远留在
        // 库里，而且 /api/logs/latest 还会把它们查出来返回给前端。
        db.prepare('DELETE FROM taskLogs WHERE taskId=?').run(id);
        db.prepare('UPDATE tasks SET parentId=NULL WHERE parentId=?').run(id);
        db.prepare('DELETE FROM tasks WHERE id=?').run(id);
        db.exec('COMMIT');
        json(res, 200, { ok: true });
      } catch (e) {
        db.exec('ROLLBACK');
        json(res, 500, { error: String(e.message) });
      }
      return;
    }
  }

  if (table === 'dependencies') {
    if (req.method === 'POST') {
      return readBody(req).then((d) => {
        db.prepare(
          `INSERT INTO dependencies (id, fromTaskId, toTaskId, type, lagDays) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fromTaskId=excluded.fromTaskId, toTaskId=excluded.toTaskId,
             type=excluded.type, lagDays=excluded.lagDays`,
        ).run(d.id, d.fromTaskId, d.toTaskId, d.type ?? 'fs', d.lagDays ?? 0);
        json(res, 200, { ok: true, id: d.id });
      }).catch((e) => json(res, 400, { error: String(e.message) }));
    }
    if (req.method === 'DELETE' && id) {
      db.prepare('DELETE FROM dependencies WHERE id=?').run(id);
      json(res, 200, { ok: true });
      return;
    }
  }

  if (table === 'availability') {
    if (req.method === 'POST') {
      return readBody(req).then((a) => {
        db.prepare(
          `INSERT INTO availabilityTemplates (id, weekday, startTime, endTime, category) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET weekday=excluded.weekday, startTime=excluded.startTime,
             endTime=excluded.endTime, category=excluded.category`,
        ).run(a.id, a.weekday, a.startTime, a.endTime, a.category ?? 'any');
        json(res, 200, { ok: true, id: a.id });
      }).catch((e) => json(res, 400, { error: String(e.message) }));
    }
    if (req.method === 'DELETE' && id) {
      db.prepare('DELETE FROM availabilityTemplates WHERE id=?').run(id);
      json(res, 200, { ok: true });
      return;
    }
  }

  // 修复父任务已被删除的子任务：把 parentId 置空，避免它们在界面上消失
  // ---- 过程记录 ----
  // GET  /api/logs?taskId=xxx  取某任务的全部记录（按时间倒序）
  // GET  /api/logs/latest      取每个任务的最新一条，列表页用
  // POST /api/logs             新建一条
  // DELETE /api/logs/:id       删除一条
  if (req.method === 'GET' && url.pathname === '/api/logs/latest') {
    const rows = db
      .prepare(
        `SELECT l.* FROM taskLogs l
         JOIN (SELECT taskId, MAX(createdAt) AS maxAt FROM taskLogs GROUP BY taskId) m
           ON l.taskId = m.taskId AND l.createdAt = m.maxAt`,
      )
      .all();
    json(res, 200, rows.map(logRow));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const taskId = url.searchParams.get('taskId');
    if (!taskId) {
      json(res, 400, { error: '缺少 taskId' });
      return;
    }
    const rows = db
      .prepare('SELECT * FROM taskLogs WHERE taskId=? ORDER BY createdAt DESC')
      .all(taskId);
    json(res, 200, rows.map(logRow));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logs') {
    return readBody(req)
      .then((body) => {
        const taskId = String(body.taskId ?? '');
        const content = String(body.content ?? '').trim();
        if (taskId === '' || content === '') {
          return json(res, 400, { error: 'taskId 和内容不能为空' });
        }
        const id = String(body.id ?? `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const createdAt = String(body.createdAt ?? new Date().toISOString());
        const kind = String(body.kind ?? 'note');
        db.prepare(
          'INSERT INTO taskLogs (id, taskId, createdAt, kind, content) VALUES (?, ?, ?, ?, ?)',
        ).run(id, taskId, createdAt, kind, content);
        json(res, 200, { ok: true, id });
      })
      .catch((e) => json(res, 400, { error: String(e.message) }));
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/logs/')) {
    const logId = url.pathname.slice('/api/logs/'.length);
    db.prepare('DELETE FROM taskLogs WHERE id=?').run(logId);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/purge-orphan-children') {
    const taskIds = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
    const all = db.prepare('SELECT id, parentId FROM tasks').all();
    const orphans = all.filter((t) => t.parentId && !taskIds.has(t.parentId));
    for (const o of orphans) {
      db.prepare('UPDATE tasks SET parentId=NULL WHERE id=?').run(o.id);
    }
    json(res, 200, { ok: true, repaired: orphans.length });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/purge-orphan-deps') {
    const taskIds = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
    const deps = db.prepare('SELECT * FROM dependencies').all();
    const orphans = deps.filter((d) => !taskIds.has(d.fromTaskId) || !taskIds.has(d.toTaskId));
    for (const o of orphans) db.prepare('DELETE FROM dependencies WHERE id=?').run(o.id);
    json(res, 200, { ok: true, removed: orphans.length });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/export') {
    json(res, 200, {
      exportedAt: new Date().toISOString(),
      tasks: db.prepare('SELECT * FROM tasks').all().map(taskRow),
      dependencies: db.prepare('SELECT * FROM dependencies').all().map(depRow),
      availability: db.prepare('SELECT * FROM availabilityTemplates').all().map(availRow),
      scheduleEntries: db.prepare('SELECT * FROM scheduleEntries').all(),
      taskTemplates: db.prepare('SELECT * FROM taskTemplates').all(),
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}

/** 请求总入口：API 走接口，其余交给静态文件 */
/**
 * 请求总入口：/api/* 走接口，其余交给静态文件。
 * 任何接口抛出的异常都兜住，返回 500 而不是让进程崩掉。
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      json(res, 500, { error: String(e.message) });
    }
    return;
  }
  await serveStatic(req, res, url.pathname);
}

/** 创建服务实例；测试时可传 0 端口让它自动分配，避免与线上端口冲突 */
export function createApp() {
  return createServer(handleRequest);
}

/** 直接运行时才监听端口；被测试 import 时不会启动 */
const isMain = process.argv[1] && process.argv[1].endsWith('server/index.js');
if (isMain) {
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`task-scheduler server listening on http://127.0.0.1:${PORT}`);
    console.log(`database: ${DB_PATH}`);
  });
}

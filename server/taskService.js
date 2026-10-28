/**
 * taskService —— 任务领域服务（P0-02 自 server/index.js 抽离）
 * ============================================================
 *
 * 职责：任务更新的业务规则全部住在这里——字段白名单、值域校验、
 * 状态流转记录、等待/净工时结算、服务端盖章字段、isCompleted 派生。
 *
 * 边界（ADR-001 / ADR-003）：
 *   - 本层不做 HTTP：输入是 db 句柄 + 更新对象，输出是纯结果对象，
 *     错误以 { ok:false, error } 返回，由 HTTP 层映射状态码（当前统一 400）。
 *   - 本层不碰 SQL 之外的协议细节，可以被未来的 Agent Runtime 直接调用。
 *
 * 事务边界：单条 UPDATE 自身原子；读状态与写更新之间的竞态是既有行为
 * （单用户场景），本轮不改变——记录为已知限制，P0-03 统一处理。
 */

/** 允许前端更新的任务字段白名单：挡住拼错或恶意字段名直接进 SQL */
const TASK_UPDATABLE_FIELDS = new Set([
  'title', 'parentId', 'estimatedHours', 'minHours', 'deadline', 'actualHours',
  'isCompleted', 'scheduledStartAt', 'category', 'startDate', 'completionNote',
  'doneCriteria', 'status', 'remindDate', 'waitingNote', 'history',
  // v5.0：完成时前端会带上算好的净工时，允许落库；
  // createdAt / completedAt / firstStartedAt 是系统自己写的锚点，不接受外部传值
  'waitingHours', 'workHours',
]);

const VALID_STATUS = new Set(['todo', 'waiting', 'done']);
const VALID_CATEGORY = new Set(['work', 'personal', 'any']);

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 校验并过滤更新对象。
 * 返回 { ok:true, filtered } 或 { ok:false, error }。
 * 纯读取 + 纯计算，不写库。
 */
export function validateTaskUpdates(db, id, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: true, filtered: null, empty: true };
  const filtered = {};
  for (const key of keys) {
    if (TASK_UPDATABLE_FIELDS.has(key)) {
      filtered[key] = updates[key];
    }
  }
  if (Object.keys(filtered).length === 0) {
    return { ok: false, error: '没有可更新的合法字段' };
  }
  // 值域校验：字段名合法不代表值合法。前端有校验，但直接调接口能绕过，
  // 必须在服务端兜住——一条 estimatedHours=-5 或 status='乱写' 会污染整张排期。
  if ('status' in filtered && !VALID_STATUS.has(String(filtered.status))) {
    return { ok: false, error: 'status 只能是 todo / waiting / done' };
  }
  if ('category' in filtered && !VALID_CATEGORY.has(String(filtered.category))) {
    return { ok: false, error: 'category 只能是 work / personal / any' };
  }
  for (const numeric of ['estimatedHours', 'minHours', 'waitingHours', 'workHours']) {
    if (numeric in filtered) {
      const value = filtered[numeric];
      if (value !== null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        return { ok: false, error: `${numeric} 必须是不小于 0 的数字` };
      }
    }
  }
  if ('estimatedHours' in filtered && Number(filtered.estimatedHours) <= 0) {
    return { ok: false, error: 'estimatedHours 必须大于 0' };
  }
  // 最短安排不能超过预估工期，否则排期算出来是无意义的。
  // 两个字段单独提交时，另一个的现值要从库里取出来一起比，
  // 否则只改 minHours 就能绕过这道校验。
  if ('minHours' in filtered || 'estimatedHours' in filtered) {
    const current = db.prepare('SELECT estimatedHours, minHours FROM tasks WHERE id=?').get(id);
    const est = 'estimatedHours' in filtered ? Number(filtered.estimatedHours) : Number(current?.estimatedHours ?? 0);
    const min = 'minHours' in filtered ? Number(filtered.minHours) : Number(current?.minHours ?? 0);
    if (min > est) {
      return { ok: false, error: 'minHours 不能大于 estimatedHours' };
    }
  }
  return { ok: true, filtered, empty: false };
}

/**
 * 应用状态流转的业务规则，返回最终落库字段（mapped）。
 * 只做计算，不写库；调用方负责 UPDATE。
 */
export function applyStatusTransition(db, id, filtered, nowMs) {
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
      // v5.0 自动计时：离开「等待中」时，把这段等待加进累计等待时长。
      // 为什么在这里算而不是前端算：等待是「发生了什么」，不是「谁点的按钮」，
      // 服务端落库时的时间才是唯一可信的时间轴。
      const lastEntry = log.length > 0 ? log[log.length - 1] : null;
      if (before.status === 'waiting' && mapped.status !== 'waiting' && lastEntry) {
        const enteredAt = Date.parse(lastEntry.at);
        if (Number.isFinite(enteredAt) && nowMs > enteredAt) {
          const deltaHours = (nowMs - enteredAt) / (60 * 60 * 1000);
          mapped.waitingHours = round3((before.waitingHours ?? 0) + deltaHours);
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
        at: new Date(nowMs).toISOString(),
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
  return mapped;
}

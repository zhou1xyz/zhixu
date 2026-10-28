# P0-01 基线核验报告（2026-10-28）

对应《知序架构决策记录与渐进式开发计划》P0-01，核验人：简丹。

## 1. 仓库与运行状态

| 项 | 结果 |
|---|---|
| 版本 | v5.3.3（提交 d7ad4b5） |
| 工作区 | clean，无未提交改动 |
| 服务 | systemd 用户单元 task-scheduler.service，active |
| 页面 | http://127.0.0.1:5190/ → 200 |

## 2. 测试与构建基线

| 检查 | 结果 |
|---|---|
| `tsc -b` | ✅ 零错误 |
| 单元测试 | ✅ 22/22 通过（全部指向 shared/scheduler.ts） |
| `npm run build` | ✅ 成功 |

基线失败项：无。

## 3. API 行为基线

| 接口 | 状态 |
|---|---|
| GET /api/all | 200 |
| GET /api/tasks | 200 |
| GET /api/logs/latest | 200 |
| POST /api/schedule | 200，status=ok，13 条排期 |

API 清单（server/index.js）：tasks CRUD+PATCH、dependencies、availability、
logs（含 latest）、purge-orphan-children、purge-orphan-deps、export、schedule。

## 4. 数据备份与恢复方式

- 备份文件：`data/backups/app.db.20261028-p001-baseline.db`（94KB，43 条任务，已验证可读）。
- 备份方法：`VACUUM INTO`（在线安全，WAL 模式下不会产生空壳文件；
  本机 node:sqlite 无 backup API）。
- 恢复方法：停服务 → 用备份文件覆盖 `data/app.db`（同时删除
  app.db-wal / app.db-shm）→ 起服务 → 抽查任务数与排期输出。
- 历史备份：`data/backups/` 另有 20261021/20261022 系列 5 份。

## 5. 关键业务场景的既有测试覆盖

- 排期：22 条测试覆盖依赖四类型、压缩、等待不计排期、completedAt
  历史占用闭合等核心规则（tests/scheduler.*.test.ts）。
- 状态流转与工时结算：**无自动化测试**（当前靠手工 curl 验证）→
  列入 P0-02 补测试范围。
- HTTP 参数与权限：**无自动化测试**（v5.3.2 的三处修复靠手工验证）→
  列入 P0-04 补测试范围。

## 6. 与 ADR 技术决策的核验结论

| ADR 决策 | 代码现状 | 一致性 |
|---|---|---|
| ADR-002 服务监听与暴露 | server 监听 0.0.0.0:5190，无鉴权，外网经 Tailscale serve 反代 | ⚠️ 访问控制缺失，P0-04 处理 |
| ADR-004 scheduleEntries 表 | 表已建但**从未写入**，排期结果仅存在于运行时 | 确认 P3 需从零建计划版本机制 |
| ADR-001 领域规则位置 | 状态流转/工时结算约 120 行业务逻辑内嵌在 PATCH handler 里 | 确认 P0-02 抽离必要性 |
| 客户端伪造服务端字段 | v5.3.2 已封 completedAt/firstStartedAt（POST+PATCH 均封） | ✅ 但白名单机制本身分散，P0-02 统一 |
| 前端统一数据入口 | src/data/repository.ts 是唯一出口 | ✅ 符合 ADR-001 决策 3 |
| 排期算法纯函数 | shared/scheduler.ts 纯函数 + 22 测试 | ✅ 符合 ADR-004 保留要求 |

## 7. P0-01 结论

基线健康，无历史失败项。可以进入 P0-02。

---

# P0-02 ~ P0-04 实施方案（待批准后执行）

## P0-02：抽离任务领域服务（预计 1 次会话完成）

**新建 `server/taskService.js`**（纯 JavaScript，与现有后端风格一致）：

1. 迁移内容（自 server/index.js PATCH handler，约 120 行）：
   - status 白名单校验、history 流转记录追加
   - waitingHours 离开等待时结算、workHours 完成时结算
   - firstStartedAt / completedAt 服务端盖章
   - isCompleted 派生
2. 导出形态：`applyTaskUpdates(db, id, updates, nowMs)` 返回
   `{ ok, changed } | { error }`，HTTP handler 只剩解析与响应。
3. 迁移方式：**搬一块 → node --check + curl 对照 → 再搬下一块**
   （沿用既有规则，禁止多处改完统一验证）。
4. 补测试：`tests/taskService.test.js`（node:test）覆盖
   todo→waiting→done→返工→再完成全流转的工时/时间戳断言。

**风险**：迁移中行为漂移。**对策**：迁移前先用 curl 固化 6 个场景的
响应快照，迁移后逐一对照。

## P0-03：写入一致性（预计 0.5 次会话）

1. POST /api/tasks 的 upsert 改为显式 INSERT ... ON CONFLICT 事务包裹
   （db.exec BEGIN/COMMIT，与 DELETE 路径一致）。
2. 任务+日志追加类操作（未来 Agent 写入也走这里）统一走事务。
3. 并发保护：PATCH 增加 `updatedAt` 乐观锁字段（可选项，若易哥
   认为单用户无并发可暂缓——**默认暂缓**，记录为已知限制）。
4. 删除遗留：删除任务同时清理该任务在 scheduleEntries 的引用
   （P3 之前该表为空，此条为 P3 前置）。

## P0-04：访问控制基线（预计 0.5 次会话）

1. 监听地址 0.0.0.0 → **127.0.0.1**（外网访问走 Tailscale serve 反代，
   反代目标本就是 127.0.0.1:5190，行为不变，暴露面收窄）。
2. Tailscale 网络内的其他设备仍可访问（经 serve 反代），需实测确认。
3. 写操作鉴权：本期不做 token（单用户 + 内网），记录为 P1-03 前置项。
4. 密钥与文件权限检查：data/ 目录 700、无密钥入库（已满足，复核）。

## 验收口径（P0 阶段整体）

- 22 条既有测试 + 新增 taskService 测试全过。
- 6 个 curl 场景快照迁移前后一致。
- `npx tsc -b`、`npm run build`、页面 200。
- 真实数据零变化（迁移是纯代码搬动，不碰库）。

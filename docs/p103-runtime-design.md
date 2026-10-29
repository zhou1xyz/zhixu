# P1-03 设计方案：最小 Agent Runtime 骨架（只读设计稿，未实施）

- 状态：待易哥审阅。本文区分【事实】（代码证据）与【设计】（建议）。

## 一、现有代码事实

1. 模块边界【事实】：
   - `server/taskService.js` 导出 4 个纯函数（validateTaskUpdates /
     applyStatusTransition / updateTask / sanitizeNewTask），全部接收
     db 句柄，无 HTTP 依赖——Agent 可直接复用。
   - `server/index.js` 模块加载即有副作用：`await mkdir`（L34）、
     `new DatabaseSync`（L36）、WAL（L37）、ensureColumn 迁移——
     Runtime 若 import 它会连带开生产库，必须先做惰性化改造。
   - `src/data/repository.ts` 是浏览器 fetch 封装，Runtime 不用它。
   - `shared/scheduler.ts` 纯函数 `schedule(tasks, deps, availability, {now})`，
     直接可被 Runtime 调用生成候选排期。
2. 运行时【事实】：Node v26.8（ESM，type:module）；生产依赖仅
   react/react-dom/tailwind（后端零依赖）；测试 `tsx --test tests/**/*.test.ts`；
   环境变量仅 PORT、TASK_DB_PATH；仓库内无密钥（index.js 命中"token"一词
   仅为注释），密钥均在 ~/.ollama 等仓库外。
3. SQLite【事实】：node:sqlite DatabaseSync，WAL，事务用 BEGIN/COMMIT/
   ROLLBACK 显式包裹（POST/DELETE/PATCH 均已包）；备份 VACUUM INTO 手工。
4. ADR/测试【事实】：ADR-001~006 已归档 docs/；测试 41 条
   （排期 22 + taskService 14 + http 5）。

## 二、核心架构【设计】

### 2.1 入口与生命周期

新增 `server/agent/` 目录，独立于现有 HTTP 路由：

```
server/
  agent/
    runtime.js       生命周期编排（唯一入口 runAgentTurn()）
    tools.js         工具注册表 + 参数校验 + 执行
    modelAdapter.js  模型适配接口 + 首版 DashScope 实现
    auth.js          确认凭证签发/校验（服务端）
  agentSessions.db   独立 SQLite（或同库新表，见 §三）
```

生命周期（对齐 ADR-006 状态机）：

```
runAgentTurn(sessionId, userMessage)
  1. 载入会话上下文（最近 N 条消息 + 当前有效计划摘要）
  2. 构造系统提示词（含工具清单 + 授权规则，模型无法改写）
  3. 调用模型适配器 → 解析输出
  4a. 纯文本回复 → 落消息表，返回
  4b. 工具调用 → 校验工具存在/参数 schema/风险级
      R0 只读 → 执行 → 结果回填 → 再调模型（最多 N 轮）
      R1+   → 生成 proposal（不执行）→ 返回确认请求
  5. 每一步落 agentRuns / agentToolCalls 表
```

### 2.2 模型适配接口（首版单模型）

```js
// modelAdapter.js 导出
export async function chat({ messages, tools, timeoutMs }) 
// → { text?, toolCalls?: [{ name, arguments(JSON) }], usage }
```

- 首版仅实现 DashScope（key 走环境变量 AGENT_MODEL_KEY，不入库不入仓）。
- 超时默认 30s、失败重试 0 次（上层决定）、响应 JSON schema 校验。
- 换模型只改此文件（ADR-005）。

### 2.3 防绕过设计

- Runtime 进程内只暴露工具注册表；工具实现函数闭包持有 db，
  模型输出只可能是「工具名 + JSON 参数」，无 SQL 通道。
- 所有写工具内部强制走 taskService；任务服务不暴露 SQL 参数。
- 系统提示词与工具 schema 由服务端拼接，模型消息不进入提示词层。
- 工具执行不 eval、不动态 import；模型给的 toolCalls.name 必须精确
  匹配注册表 key，否则记 violation 并拒绝。

## 三、会话与执行记录【设计】

新表（与业务同库，便于事务；均含 created_at）：

| 表 | 关键字段 |
|---|---|
| agent_sessions | id, title, status(active/archived) |
| agent_messages | id, session_id, role(user/agent/system), content, created_at |
| agent_runs | id, session_id, message_id, status(proposed/awaiting_confirm/running/succeeded/failed/cancelled), model, error, created_at, finished_at |
| agent_tool_calls | id, run_id, tool, arguments_json, risk, status, result_json, idempotency_key, created_at |
| agent_confirmations | id, tool_call_id, confirm_hash, confirmed_at, expires_at |

- 不改业务表 schema；迁移 = 新建 5 表（幂等 CREATE IF NOT EXISTS）。
- 失败/超时：run 标 failed，工具调用标 failed，不自动重试写操作；
  只读工具可重试。取消：run 置 cancelled，已开始的事务让其完成
  （SQLite 单语句原子，不中断半途）。
- 幂等：写工具调用必须带 idempotency_key（服务端对 tool_call_id+参数
  做 hash 生成），重复 key 直接返回首次结果，不再执行。
- 敏感信息：模型请求/响应原文不落库，只存摘要与 token 用量；
  会话内容保留在 agent_messages（用户自己的数据，不出本机）。

## 四、授权与安全【设计】

- 风险分级（对齐 ADR-003）：R0 只读（查任务/查排期）自动执行；
  R1 创建任务自动；R2 更新/完成需确认；R3 删除/批量操作需确认并
  显示完整参数；R4 SQL/改授权 不存在此工具。
- 确认绑定：确认对象是 tool_call 的 `confirm_hash = sha256(tool +
  arguments_json + run_id)`。执行时服务端重算 hash，不一致即失效；
  确认 5 分钟过期；一次性消费（用后标记）。
- 防伪造：授权状态只存服务端表，模型输出中任何"已确认"字样不改变
  数据库状态；confirm hash 含 run_id，跨 run 重放无效。
- 无用户鉴权的现状（ADR-002）：知序访问面已收窄到 Tailscale 身份层
  （P0-04），能打开页面 = 网络层已认证。Runtime 的确认交互复用同一
  前提：确认动作来自同一 Web UI。此为已知边界，多用户接入时重审。

## 五、第一批工具【设计】

P1-03 实施期只交付 1 个：

| 工具 | 级别 | 说明 |
|---|---|---|
| `query_tasks` | R0 | 参数：{ status?, category?, keyword?, limit }；内部走与 /api/tasks 相同的只读查询 |

后续路线（各自独立子阶段）：
1. `create_task`（R1）：强制走 sanitizeNewTask + status 强制 todo
2. `update_task`（R2）：走 updateTask，status 迁移含工时结算
3. `query_schedule`（R0）：调 schedule() 返回当前有效排期视图
4. `propose_schedule`（R2→提案）：生成候选排期存 agent_runs.result_json，
   **永远不写 scheduleEntries**；落成有效计划必须由用户在 UI 确认
   （对齐 ADR-004 候选与有效分离）

## 六、测试与实施计划【设计】

子阶段拆分（每个独立提交独立验收）：

| 子阶段 | 内容 | 验收标准 | 回滚 |
|---|---|---|---|
| P1-03a | server 惰性化改造（db 打开移入函数/工厂），行为不变 | 41 测试全过 + 六组快照零差异 + 页面 200 | revert |
| P1-03b | 会话/记录 5 张表 + 建表迁移 | 建表幂等；旧库升级无业务数据变化 | drop 新表 |
| P1-03c | tools.js + query_tasks（R0）+ runtime.js 骨架 | 工具单测；无模型也能被 HTTP 调用 | revert |
| P1-03d | modelAdapter（DashScope）+ runAgentTurn + 确认流 | 适配器 mock 测试 + 工具调用测试；超时/未知工具/坏参数用例 | revert（不碰业务表） |

测试矩阵要点：模型超时、响应非 JSON、未知工具、参数不符 schema、
重复 idempotency_key、数据库错误回滚、R2 无确认不执行、确认后参数
变化失效、并发同 run。

上线不影响现有功能：Runtime 全部走新路由（/api/agent/*），旧接口
一字不动；手机端经 Tailscale 访问不变。

## 七、已知问题处理

1. actualHours：不在任何工具暴露；update_task 白名单本就允许它作展示
   参考字段，但 workHours 权威结算只认服务端状态机（P1-02 已保证）。
2. 启动迁移幂等性【事实】：P1-02 版本迁移用
   `completedAt=COALESCE(completedAt,?)` + `history=COALESCE(history,?)`，
   已有值的行不会重复追加 → 幂等 ✅。但仍会每次启动扫一遍 SELECT
   （0 行开销）。
3. 40d65b71 不动 ✅（除非未来单独批准修复）。
4. Agent 无 SQL 工具、授权状态只在服务端表 ✅（§2.3/§四）。
5. 无多 Agent/插件/新框架；唯一新增后端依赖是模型 SDK 或直接 fetch
   （推荐直接 fetch DashScope 兼容接口，零依赖）。

## 八、需要你拍板的决策点

1. 会话数据存同库新表（推荐，事务一致）还是独立 agentSessions.db（隔离彻底）？
2. 模型接入：直接 fetch DashScope 兼容接口（推荐，零依赖）还是引入官方 SDK？
3. P1-03d 需要你提供模型 API key 的注入方式：环境变量文件（推荐，
   不入仓不入对话）——到时你手动写入 `server/.env.agent`，我只读文件名约定。

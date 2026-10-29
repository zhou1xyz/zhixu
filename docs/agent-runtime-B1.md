# P1-03d B1 阶段归档：runAgentTurn 单轮闭环

- 归档版本：v5.5.2（阶段提交时文件内实际版本为 v5.5.1）
- 提交：055bbaa（主体）/ d7c0784（持久化与工具守卫修正）/ 8f0198e（终态轮数语义）

## 范围与明确不做

- 做：幂等创建/重放裁决 → 单轮模型调用 → 用量持久化 → 助手消息 → 终态守卫
- 不做：工具执行、确认流、多轮循环、真实模型接入（B2+）

## Run 状态转换（B1 实际使用）

```
(创建) → running
running → succeeded  [守卫] 回复成功且助手消息落库
running → failed     [守卫] 适配器错误 / 工具请求未执行 / 落库失败
running → running    [rounds=-1 认领] 并发重入标记
```

未使用：proposed / awaiting_confirm / cancelled / needs_reconciliation；
工具层 outcome_unknown（均留 B2+）。

## 幂等键与输入指纹

- `UNIQUE(session_id, request_id)`：请求重放返回同一 run；不同输入 409
- 输入指纹：sha256("message:" + content)，重放前重校验
- `UNIQUE(run_id, lcid)`：run 内逻辑调用唯一（B2 工具层复用）

## rounds=-1 哨兵语义与迁移条件

`rounds=-1` = 执行中认领标记（非法计数）。终态时由 transitRun fields
统一置实际值（成功/工具拒绝=1，适配器失败=0），仅未决 running 保留 -1。
迁移条件：B2 引入独立认领字段（如 claimed_at）时迁移哨兵；迁移前任何
统计必须排除 -1。

## 用量未知 vs 用量持久化失败

| 情形 | 表现 |
|---|---|
| 上游未提供有效用量 | usage_json=NULL，无警告（正常未知） |
| 有效用量但写入失败 | 同事务 system 故障说明消息 + payload.usage_warning；绝不伪造数字 |

## 测试与生产核验

- agentTurn 11 条；全量 69/69（055bbaa）→ 收尾修正后 65/65（测试重构合并计数）→
  本轮归档复跑 65/65 通过
- 故障注入：用量写入失败、事务回滚、终态 0 行、并发挂起单执行者
- 生产库：tasks 43、agent_runs/tool_calls/messages 0、40d65b71 原样未动

## 残余风险

1. 落库异常保留 running，回复文本可能丢失——依赖 P1-04 恢复扫描（未实现）
2. 崩溃遗留 running+rounds=-1 重放语义正确（in_progress），恢复扫描属后续
3. system 故障说明随事务回滚消失时，payload.warning 为唯一告知渠道

## 版本对应关系（核验结论）

- 三个 B1 提交标题中的 v5.4.1 为笔误，**不是发布过的应用版本**
- B1 三个提交内文件实际版本为 v5.5.1（继承自阶段 A）
- 本归档版本 v5.5.2 为 B1 内容的正式归档版本号

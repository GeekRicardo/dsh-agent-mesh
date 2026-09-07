# Changelog

## 0.2.0

行为修复，让「子对话插队、主动回传主对话、可配模型/审批模式」如 README 承诺那样工作：

- **`agent_send` 默认插队（steer）**：新增 `mode: "auto"`（默认值）——子对话正在跑时消息折入当前轮（插队），空闲时则开启新的一轮；需要「不插队」时传 `mode: "queue"` 等当前轮跑完，`mode: "steer"` 则总是折入。`agent_open` 的首条 prompt 与 A2A `message/send` 的默认发送同样走 `auto`。
- **审批/提问主动回传主对话**：移除 `attention` 门控——子对话一旦 park 一个权限请求或提问，即使主对话当前并未「等待它」，也会收到 `[子对话通知]`；子对话跑完一轮同样回传。唯一的抑制是主对话正阻塞等待**同一个**子对话时（该操作的返回结果已包含状态，避免浪费一轮；该阻塞操作结束时会把它持有队列中的通知并入返回结果）。
- **dsh 子对话的提问确实路由给主对话**：`userQuestions` 在 harness 里是单槽 provider 服务（不是 waterfall 事件），原实现监听的 `userQuestions/request` 事件不存在，dsh 子对话的提问一直落在人工卡片上。现在包装该单槽 provider：`approvals=parent` 的托管子对话提问 park 给主对话；其余照旧回人工卡片（teardown 时还原）。
- **修复 `statusOf` 的 lossless-JSON 校验崩溃**：提问请求没有 `callId`，`status.awaiting` 中出现 `callId: undefined` 会让 `agent_read`/`agent_list` 报「必须是 lossless JSON data」，读到一个提问中的子对话会直接失败。现在 `callId` 仅在存在时携带。

## 0.1.0

从 claude-in-dsh 拆分出来的独立多 agent 协作插件。

- 一个会话开/驱动/审批/配置其它会话，全部走 dsh 原生渲染；dsh↔dsh 与 cc↔dsh 皆可。
- 跨会话协议可切：**A2A（默认）** 或 **MCP**。A2A 侧实现 Agent Card、`message/send`、`message/stream`（SSE）、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`、`tasks/pushNotificationConfig/set|get`，一轮工作映射为 Task（`working → input-required → completed`）。
- **子对话提问也会通知主对话**：新增 `agent_answer`；权限走 `agent_approve`。Claude 子对话的 `AskUserQuestion` / `ExitPlanMode` 由 claude-in-dsh 经 `answerQuestion` 路由回主对话；dsh 子对话经可选的 `userQuestions/request` 接缝路由。
- **通知不再丢**：发起方即使被 dsh 卸载，委派工作的完成/需人介入也会把它 `queue` 唤醒（冷会话 resume 收消息），而不是攒着等它下次调用。
- **内存权衡**：`DSH_AGENT_MESH_MAX_LIVE_CLAUDE`（默认 2）限制常驻 Claude 子进程数，开新一轮前按 LRU 停掉空闲的那个。

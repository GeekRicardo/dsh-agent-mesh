# Changelog

## 未发布

- **子对话状态带上额度等待**：`agent_read` 等的标题行会写明在等哪个额度窗口、什么时候恢复。
- **缺必填参数直接报错，并列出参数名**。之前 `agent_send` 把 `text` 写成 `message` 时，子对话真的会收到一条内容是 "undefined" 的消息。
- **带通知的一轮失败了，通知会重发**。接口接受通知只代表开了一轮，这一轮可能在模型读到之前就失败。最多重试 8 次，之后留在队列，随下一条通知或工具调用送出。
- **dsh 里的 Claude 阻塞调用上限 20 秒**，低于 hop 的 25 秒，不会再把慢回答变成“upstream timed out”然后重试。外部驱动方不受影响。
- **`turnFailure()`** 从日志最后一条消息判断 Claude 这一轮是否失败，因为所有 Claude 轮次的结束原因都是 `blocked`。
- **扩展接缝新增** `noticeTo`、`turnFailure`、`guardOp`、`onChildOpened`；`onTurnEnd` 返回 `'handled'` 时不再发“跑完了这一轮”。
- **开子对话时传 `notify: off` 不再打印“叫不醒父对话”的警告**。

- **外部 handle 当父对话不再每 3 秒重试到天荒地老**。`cc-linux` 这种固定 handle 不是 dsh 会话，确认之后通知就攒着，随它下一次 `agent_*` 调用带回去。其它失败改成退避重试，上限 60 秒。开子对话时也会明说「没人能叫醒你」。
- **新工具 `agent_wait`**：外部驱动方等到子对话需要它或停下来才返回。
- **通知带上完整内容**：审批带调用参数；提问带详情、选项说明和计划审核语义；`agent_read` 里也能看到全文。之前父对话只看到工具名，等于盲批。
- **拒绝审批的理由会告诉子对话**，并说明不是用户本人拒绝的。之前子对话只看到「用户拒绝了」，会猜错原因或反复重试。
- **通知标真实位置**：远端子对话显示 `worker:/tmp/x`，不再显示它在 dsh 这边所属项目的本机目录。
- **Claude 子对话的审批通知也有参数**：审批可能先于转录到达，通知会等一下调用记录，最多 1.5 秒。
- **`agent_send` 一段文字就能答提问**。子对话卡在提问时不读收件箱，这段话之前会一直躺着，子对话继续卡。文字正好是选项标签就算选中。审批不走这条路，放行只能用 `agent_approve`。
- **`workspaceId` 开子对话时记录的是那个项目的目录**，之前记成父对话的目录。
- **动态形态能跑了**：沙箱没有 `AbortController`，之前所有 prompt 投递都失败；`agent_answer` 的嵌套 schema 被沙箱拒收。
- **`runCapture` 等 stdout 读完才返回**，之前进程一退出就返回，可能只拿到半个文件。
- **两份核心不打架**：已有 `multiagentControl` 时这一份保持空闲并说明。加了扩展接缝（`meshExtension`），dsh-superagent 靠它接入。
- **根治「CC 父对话收不到通知」要配合 claude-in-dsh**：见其 CHANGELOG。

- **等 dsh 的 API 网关不再有「等够了」这一说**。此前等 60 秒还没等到 `apiProxy`/`sessionController` 就永久放弃：整个 dsh 运行期里不注册任何工具、不挂 MCP 路由、不装审批桥——主对话就是开不出子对话，日志里只留一行 `cannot open conversations`。60 秒听着宽裕，直到机器忙起来：那台 Mac 并行跑着十个 rustc、负载 80，dsh 光启动就要好几分钟，插件早已退场。现在前 60 次每秒一试，之后每 5 秒一试，**一直等**，并且每分钟在错误日志里说一次还在等谁。

- **插进正在跑的那一轮的提问，不会再石沉大海**。主对话在跑时，子对话的提问是 steer 进那一轮的；「在不在跑」是看会话日志判断的，等 dsh 真的处理这条 prompt 时那一轮可能已经结束，而一条 next-step 消息在没有 turn 的时候没人读——子对话就永远卡在一个「通知过一次、但那一次落在了一轮已经结束的对话里」的提问上。现在主对话的 `turn/end` 会检查还挂着的请求，用**新的一轮**再问一次（每个请求只提醒一次：忽略第二次就是它的决定）。
- **投递失败的通知会自己重试**。此前 `sessions.prompt` 抛错时通知被放回队列却没人再送，只能等下一个子对话事件顺带把它带出去——对一个卡在提问上的子对话来说就是永远。
- **被挂起的子对话不排在合并窗口后面**。审批/提问意味着子对话是停着的，它的通知用 250ms 而不是 3s 的合并窗口；已经排着的窗口会被它缩短。

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

# dsh-agent-mesh

让一个 DeepSeek Harness 会话像人一样去**开、驱动、审批、配置其它会话**——子对话是侧栏里一条真正的普通会话，原生渲染、可持久化、随时能被人接管。支持：

- **dsh ↔ dsh**：一个 dsh 会话开另一个 dsh 会话。
- **cc ↔ dsh**：装了 [claude-in-dsh](https://github.com/GeekRicardo/claude-in-dsh) 时，可以开由本机 Claude Code 驱动的子对话，或让一个 Claude 会话去开/驱动 dsh 子对话。

跨会话协议可切：**A2A（默认，Agent2Agent）** 或 **MCP**。

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-agent-mesh/main/install.sh | bash
```

装完重启 dsh web、硬刷新页面即可。要开 Claude 子对话需另装 claude-in-dsh；不装时本插件只支持 dsh 子对话，Claude 相关旋钮会如实报告"未组合 Claude 引擎"。

## 模型看到的工具

一个会话会多出这些工具（dsh 会话原生可调；Claude 会话通过下面的 wire 端点拿到同一组）：

| 工具 | 作用 |
| --- | --- |
| `agent_open` | 新开一个子对话并开始驱动它（选引擎/模型/权限档/谁来审批） |
| `agent_send` | 像在输入框里打字一样对子对话说话（`auto` 默认插队/`queue` 排队/`steer` 总是折入） |
| `agent_read` | 读子对话自上次以来产生的内容、是否在跑、是否在等你 |
| `agent_approve` | 回答子对话卡住的**权限**请求（allow/deny） |
| `agent_answer` | 回答子对话向你**提出的问题**（ask_user_question / 计划审核） |
| `agent_config` | 中途改子对话的模型/effort/权限档/审批去向 |
| `agent_stop` | 打断当前轮（cancel）或彻底关掉并停止托管（close） |
| `agent_list` | 列出你开的子对话及各自在等你的事项 |
| `claude_usage` | 读本机 Claude 订阅用量各窗口（规划长任务用） |

你不必坐着轮询：只要没传 `notify: "off"`，子对话**跑完一轮 / 卡在审批 / 要向你提问**时都会主动唤醒发起会话——哪怕发起会话此刻已经被 dsh 卸载（冷会话会被 resume 起来收这条消息）。

## 通知与提问怎么落到原生能力上

- **子对话的权限请求** → 走 dsh 的 `approval` waterfall，路由回主对话的 `agent_approve`。
- **子对话的提问 / 计划审核**：
  - Claude 子对话：claude-in-dsh 把 CLI 的 `AskUserQuestion` / `ExitPlanMode` 交给本插件的 `answerQuestion`，路由回主对话的 `agent_answer`（答案按题面文本回给 CLI，和人在卡片里选的一模一样）。
  - dsh 子对话：本插件包装 `ctx.userQuestions` 的单槽 provider——`approvals=parent` 的托管子对话的提问（`ask_user_question` 与 `exit_plan_mode` 计划审核）会 park 给主对话，由 `agent_answer` 回答；其余会话照旧回人工卡片（teardown 时还原）。**
- **发起方已停下**：通知是一条普通消息，投递到发起会话——正在跑就 `steer` 进当前轮，空闲/已卸载就 `queue` 一条新轮把它唤醒。

## 协议

- `A2A`（默认）：每个被托管的会话对外是一个 A2A agent——`GET …/a2a/agent-card/<parent>` 给出 Agent Card；`POST …/a2a/<parent>` 是 JSON-RPC，支持 `message/send`、`message/stream`（SSE）、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`、`tasks/pushNotificationConfig/set|get`。一轮工作映射成一个 Task，状态在 `working → input-required → completed` 间流转；push notification config 就是"卡住/完成时回调唤醒驱动方"的机制。Claude Code 作为工具客户端只会说 MCP，所以 A2A 模式下仍会并行挂一个 MCP 兼容端点给 cc 用。
- `MCP`：只挂 MCP JSON-RPC 端点（老形态），不带 A2A 任务机。

所有 wire 端点都只允许回环 + Bearer，且拒绝跨站。

## 配置（环境变量，写在 dsh web 的启动环境里）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_AGENT_MESH` | 开 | 设 `off` 完全关闭本插件 |
| `DSH_AGENT_MESH_PROTOCOL` | `a2a` | `a2a` 或 `mcp` |
| `DSH_AGENT_MESH_MAX_LIVE_CLAUDE` | `2` | 同时常驻的 Claude 子进程上限（`0`=不限）。超出时在开新一轮前停掉最久未活跃且空闲的那个 Claude 子对话，其会话可持久、下次发消息用 `--resume` 唤起 |

## 内存权衡

每个空闲的 Claude 都是一整个 Node 进程（几百 MB）。在小内存机器上，本插件按 `DSH_AGENT_MESH_MAX_LIVE_CLAUDE` 只保留有限个常驻 Claude 子进程：开新一轮前，会停掉最久未活跃且不在跑的那个（正在跑的绝不动）。被停的子对话仍在侧栏、下次 `agent_send` 会 `--resume` 起来——代价只是一次进程启动，不丢上下文。

## Known Limitations and Deferred Work

- A2A 目前是本机回环传输；跨机可达（对外 URL、鉴权、发现）尚未接。
- dsh 子对话的提问经 `userQuestions` 单槽 provider 包装路由回主对话：这只在本插件激活期间生效，且 `approvals=parent` 的子对话才会被接管；`approvals=human` 的子对话提问仍直接落在人工卡片上。

## License

MIT

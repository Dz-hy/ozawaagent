# 工具系统

## 主对话工具所有权

主对话不再由 GUI 侧 `builtinRegistry` 组合或分派工具。`useSendChatTurn` 通过 `runGaChatTurn` 和 `GaBridgeClient` 把 prompt 提交给 GenericAgent runtime；模型调用、工具 schema 与工具执行均由该 runtime 拥有。GUI 只把 session snapshot 映射成对话视图，并渲染其中的 tool call/result。

`src/lib/tools/builtinToolCatalog.ts` 仅是 Settings 与 UI 使用的展示目录，不导入 executor，也不是运行时注册表。

## GUI 侧保留的工具支撑模块

| 模块 | 主要路径 | 职责 |
|---|---|---|
| 展示目录与类型 | `builtinToolCatalog.ts`、`builtinTypes.ts`、`systemToolOptions.ts` | 工具名称、分类、只读标记、runtime scope 与 UI 选项。 |
| 文件后端适配 | `fsBackend.ts`、`bashTimeoutPolicy.ts` | Tauri FS 错误归一与 Shell timeout 策略；不组成模型工具注册表。 |
| Memory | GenericAgent runtime 的 MemoryManager | GUI 不再保留旧桌面 Memory extraction/organizer 工具执行器；主对话与 Settings 的 Memory 能力以 runtime/Gateway 契约为准。 |
| Todo / AskUser | `todoTools.ts`、`askUserQuestionTools.ts` | 独立状态与交互 bundle；不构成主对话本地注册表。 |
| Subagent 支撑 | `src/lib/subagents/*` | 保留会话持久化、消息总线与 SendMessage/卡片展示适配；Agent 执行与模型工具所有权属于 GenericAgent runtime。 |

Rust 的 FS、Shell/process、Skills、Cron 等命令与 service 仍可供桌面功能调用；MCP settings 由桌面配置层写入并同步，协议执行由 GenericAgent MCP Connector 负责。

## 执行边界

| 端 | 职责 | 说明 |
|---|---|---|
| GenericAgent runtime | 主对话模型与工具执行 | 接收 prompt，维护 session，并产生消息、tool call/result 与终态。 |
| GUI 本地 Chat | bridge 与渲染 | 启动/连接 runtime、提交 prompt、读取权威 HTTP snapshot；WebSocket 只用于低延迟刷新提示。 |
| Tauri Rust | 本地系统能力与 runtime supervisor | 提供文件、进程、Skills 等桌面后端命令，并负责 GenericAgent runtime 生命周期；MCP 协议执行由 GenericAgent MCP Connector 负责。 |
| WebUI / Gateway | 远程传输 | 转发 chat command/event 与维护 buffer，不在 Gateway 内执行业务工具。 |

## MCP 管理边界

Settings/MCP Hub 维护 server 配置并通过 `mcpOps.ts` 写入/同步；GenericAgent MCP Connector 负责 server lifecycle、tools/list、call_tool、动态工具暴露与健康状态。GUI 不维护本地 `McpManager` 或 MCP runtime。

## Skills 管理边界

| 能力 | 说明 |
|---|---|
| 固定 root | 旧桌面 Skills runtime root 是 `~/.ozawaagent/skills`；当前 Agent 语义以 GenericAgent 为唯一真相源。 |
| 桌面管理 | Skills Hub 与 Tauri/Rust skills service 可继续提供安装、校验和打包等桌面管理能力。 |
| 文件访问 | `fsBackend.ts` 与桌面文件树/预览适配器继续提供本地文件能力；GUI 不再注册 `SkillsManager` 模型工具。 |
| 主对话 | 可见 Skills 与相关工具以 GenericAgent runtime 实际暴露为准。 |

## Memory 工具边界

GUI 不再保留旧桌面 Memory extraction/organizer 工具执行器。主对话的 MemoryManager、Settings Memory 展示与 Gateway memory.manage 均以 GenericAgent runtime 的 MemoryStore 和契约为准。

## Subagent（Agent / SendMessage）

子代理域整体位于 `src/lib/subagents/`，按严格分层组织：

| 层 | 文件 | 职责 |
|---|---|---|
| L1 纯领域 | `types.ts`、`protocol.ts`、`errors.ts`、`validate.ts`、`bus.ts`、`roster.ts`、`utils.ts` | 类型与常量、UI wire protocol、结构化错误、收件人/参数校验、Message Bus 渲染、roster/template 汇总。无 IPC、无模型执行。 |
| L2 ipc | `ipc/store.ts`、`ipc/worktree.ts` | 持久化与 worktree 的 Tauri invoke 端口（`subagent_*` 命令），null→absent 归一，同一 run 的写入串行化；测试可注入替身。 |
| L3 runtime | `scheduler.ts`、`store.ts` | `SubagentScheduler` 信号量并发调度；`SubagentConversationStore` 是会话级唯一真源（roster、latest run、hydrated 私有上下文 LRU、Message Bus）。模型执行由 GenericAgent runtime 负责。 |
| L4 适配 | `sendMessageTool.ts`、`card.ts`、`index.ts` | SendMessage 投递、卡片识别与对外导出面；不拥有 Agent loop 或模型工具注册。 |

`SendMessage` 适配语义：

| 能力 | 说明 |
|---|---|
| 收件人 | `to=parent`（父私有）/`to=*`（共享广播）/`to=<agent id>`（直达），收件人按 roster 校验，未知收件人直接拒绝。 |
| 投递 | channel 为 direct/shared/decision/question，消息在下一轮 turn 边界投递；桌面只负责持久化与展示权威结果。 |
| UI 协议 | details kind 为 `subagent_message`/`subagent_card`；`lib/subagents/protocol.ts` 在 GUI/WebUI 间逐字节镜像。 |

## 工具改造检查表

| 改动 | 必查 |
|---|---|
| 新增 builtin tool | schema、executor、metadata、UI trace details、agent-dev 可观测性。 |
| 新增 Tauri-backed tool | Rust invoke command、前端 invoke 参数、错误消息、权限边界。 |
| 修改 MCP 配置 | GUI/WebUI Settings/MCP Hub 两端、Gateway settings sync redaction。工具侧写入必须走 `settings/mcpOps.ts` 的 `McpSettingsOp` id 级合并（`applyMcpOps`），禁止全量替换 `settings.mcp`；读取必须走 `getMcpSettings` 实时 getter（权威 `settingsRef`），禁止 turn 级快照；读改写决策与提交必须在同一同步段内（await 之后重读）。 |
| 修改 Skills 行为 | services/skills/*、lib/skills 双端复制、Skills Hub installed 状态。所有对 skills 根目录活动目标的落盘必须持 `skills_write_guard()`，安装走 stage-then-swap（`<root>/.staging` 构建 + `fs::rename` 原子入位），禁止直接向活动目录逐文件写。 |
| 修改 Memory 行为 | MemoryStore、MemoryManager、Settings Memory 双端、Gateway memory.manage。 |

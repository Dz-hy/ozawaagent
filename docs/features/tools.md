# 工具系统

## 主对话工具所有权

主对话不再由 GUI 侧 `builtinRegistry` 组合或分派工具。`useSendChatTurn` 通过 `runGaChatTurn` 和 `GaBridgeClient` 把 prompt 提交给 GenericAgent runtime；模型调用、工具 schema 与工具执行均由该 runtime 拥有。GUI 只把 session snapshot 映射成对话视图，并渲染其中的 tool call/result。

`src/lib/tools/builtinToolCatalog.ts` 仅是 Settings 与 UI 使用的展示目录，不导入 executor，也不是运行时注册表。

## GUI 侧保留的工具支撑模块

| 模块 | 主要路径 | 职责 |
|---|---|---|
| 展示目录与类型 | `builtinToolCatalog.ts`、`builtinTypes.ts`、`systemToolOptions.ts` | 工具名称、分类、只读标记、runtime scope 与 UI 选项。 |
| 文件后端适配 | `fsBackend.ts`、`pathUtils.ts`、`skillAccessPolicy.ts`、`bashTimeoutPolicy.ts` | Tauri FS 错误归一、路径与 Skills 访问策略、Shell timeout 策略；不组成模型工具注册表。 |
| Memory | `memoryTools.ts` | 供旧 Memory extraction/organizer 后台闭包使用；主对话和 Settings 已断开该闭包。 |
| Todo / AskUser | `todoTools.ts`、`askUserQuestionTools.ts` | 独立状态与交互 bundle；不构成主对话本地注册表。 |
| Subagent 支撑 | `src/lib/subagents/*` | 保留子代理领域、持久化、worktree 与消息总线实现；主对话工具所有权仍属于 GenericAgent runtime。 |

Rust 的 FS、Shell/process、Skills、MCP、Cron 等命令与 service 仍可供桌面功能调用，但“后端能力存在”不等于 GUI 已向模型注册同名工具。

## 执行边界

| 端 | 职责 | 说明 |
|---|---|---|
| GenericAgent runtime | 主对话模型与工具执行 | 接收 prompt，维护 session，并产生消息、tool call/result 与终态。 |
| GUI 本地 Chat | bridge 与渲染 | 启动/连接 runtime、提交 prompt、读取权威 HTTP snapshot；WebSocket 只用于低延迟刷新提示。 |
| Tauri Rust | 本地系统能力与 runtime supervisor | 提供文件、进程、Skills/MCP 等后端命令，并负责 GenericAgent runtime 生命周期。 |
| WebUI / Gateway | 远程传输 | 转发 chat command/event 与维护 buffer，不在 Gateway 内执行业务工具。 |

## MCP 管理边界

Settings/MCP Hub 维护 server 配置，Tauri/Rust runtime 负责 server lifecycle 和 MCP 协议能力。GUI 已不再包含本地 `McpManager` 工具适配器；主对话可见的 MCP 管理或动态 MCP 工具以 GenericAgent runtime 实际暴露为准。

## Skills 管理边界

| 能力 | 说明 |
|---|---|
| 固定 root | 旧 LiveAgent Skills runtime root 是 `~/.liveagent/skills`；当前 Agent 语义以 GenericAgent 为唯一真相源。 |
| 桌面管理 | Skills Hub 与 Tauri/Rust skills service 可继续提供安装、校验和打包等桌面管理能力。 |
| 文件访问 | `SkillAccessPolicy` 与路径辅助模块仍服务保留的桌面/后台调用，但 GUI 不再注册 `SkillsManager` 模型工具。 |
| 主对话 | 可见 Skills 与相关工具以 GenericAgent runtime 实际暴露为准。 |

## Memory 工具边界

`memoryTools.ts` 只被尚待清理的旧 extraction/organizer 后台闭包引用。主对话已不接入 extraction controller，应用启动不再挂载 organizer，Settings Memory 只读展示 GenericAgent memory layers；因此它不是当前主对话或设置页的工具入口。

## Subagent（Agent / SendMessage）

子代理域整体位于 `src/lib/subagents/`，按严格分层组织：

| 层 | 文件 | 职责 |
|---|---|---|
| L1 纯领域 | `types.ts`、`protocol.ts`、`errors.ts`、`validate.ts`、`policy.ts`、`prompts.ts`、`bus.ts`、`roster.ts`、`utils.ts` | 类型与常量、UI wire protocol、结构化错误、批量校验、readonly/worktree 工具选择与 apply/cleanup 决策、system prompt 构造、Message Bus 渲染、roster/template 汇总。无 IPC、无副作用。 |
| L2 ipc | `ipc/store.ts`、`ipc/worktree.ts` | 持久化与 worktree 的 Tauri invoke 端口（`subagent_*` 命令），null→absent 归一，同一 run 的写入串行化；测试可注入替身。 |
| L3 runtime | `scheduler.ts`、`store.ts`、`run.ts` | `SubagentScheduler` 信号量并发调度；`SubagentConversationStore` 是会话级唯一真源（roster、latest run、hydrated 私有上下文 LRU、Message Bus）；`run.ts` 是单次 run 状态机（worktree 创建 → tool loop → apply/cleanup → 持久化）。 |
| L4 工具适配 | `agentTool.ts`、`sendMessageTool.ts`、`cards.ts`、`index.ts` | 生成 `Agent`/`SendMessage` 的 tool schema 与 executor、per-agent 卡片 tool call/result、对外导出面。 |

`Agent` 工具语义：

| 能力 | 说明 |
|---|---|
| 结构化参数 | `agents` 数组（每项 `id/prompt/name/role/identity/template/mode/apply_policy/allowed_output_paths/resume/retain_worktree`）+ 顶层 `concurrency`，单次最多 8 个 agent 并行。 |
| 稳定 id 与复用 | 同一会话内复用 id 即恢复该子代理的私有上下文；`name/role/identity/template` 只在 id 首次创建时生效，对既有 id 传入不同值会被拒绝。`resume=false` 为同一 id 开启全新私有上下文。 |
| mode | `readonly`（新 agent 默认，只读工具）用于调研/评审；`worktree` 在隔离 git worktree 内提供文件+shell 工具。resume 的 agent 默认沿用上次 mode。 |
| apply_policy | `none`（默认，不回灌）/`auto`（自动 apply patch）/`explicit`（仅当所有变更文件命中 `allowed_output_paths` 才 apply；路径必须解析进 workspace）。`retain_worktree=true` 保留可安全清理的 worktree 供复查。 |
| 原子校验 | 校验失败时不启动任何 agent，返回结构化错误并附上当前 roster 与已启用模板列表；`AgentPromptTemplate.enabled` 生效，`template` 只能引用已启用模板（按 id 或 name 解析）。 |
| SendMessage | `to=parent`（父私有）/`to=*`（共享广播）/`to=<agent id>`（直达），收件人按 roster 校验，未知收件人直接拒绝；channel 为 direct/shared/decision/question，消息在下一轮 turn 边界投递。 |
| 持久化 | run 在每个 turn 边界通过 `subagent_run_save` 增量落盘，中断的 run 可从最后完成的 round 恢复；run status 含 `cancelled`。identity/run/message/worktree 各有 Tauri 命令族（见 architecture/gui.md）。 |
| UI 协议 | details kind 为 `subagent_batch`/`subagent_card`/`subagent_message`；per-agent 卡片以 `subagent_card: true` 标记的合成 tool call 渲染，被拒绝的 Agent 调用也会可见渲染；`lib/subagents/protocol.ts` 在 GUI/WebUI 间逐字节镜像（scripts/mirror-manifest.json）。 |

## 工具改造检查表

| 改动 | 必查 |
|---|---|
| 新增 builtin tool | schema、executor、metadata、UI trace details、agent-dev 可观测性。 |
| 新增 Tauri-backed tool | Rust invoke command、前端 invoke 参数、错误消息、权限边界。 |
| 修改 MCP 配置 | GUI/WebUI Settings/MCP Hub 两端、Gateway settings sync redaction。工具侧写入必须走 `settings/mcpOps.ts` 的 `McpSettingsOp` id 级合并（`applyMcpOps`），禁止全量替换 `settings.mcp`；读取必须走 `getMcpSettings` 实时 getter（权威 `settingsRef`），禁止 turn 级快照；读改写决策与提交必须在同一同步段内（await 之后重读）。 |
| 修改 Skills 行为 | services/skills/*、lib/skills 双端复制、Skills Hub installed 状态。所有对 skills 根目录活动目标的落盘必须持 `skills_write_guard()`，安装走 stage-then-swap（`<root>/.staging` 构建 + `fs::rename` 原子入位），禁止直接向活动目录逐文件写。 |
| 修改 Memory 行为 | MemoryStore、MemoryManager、Settings Memory 双端、Gateway memory.manage。 |

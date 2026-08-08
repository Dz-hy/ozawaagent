# 桌面 GUI 与 Tauri 架构

## 模块边界

| 模块 | 路径 | 职责 |
|---|---|---|
| React app shell | `crates/agent-gui/src/App.tsx` | 设置 hydration/save、主题/i18n、Settings overlay、ChatPage、全局 toast 与 GenericAgent runtime readiness。 |
| Chat 页面 | `crates/agent-gui/src/pages/ChatPage.tsx` | 会话视图、消息发送/取消、历史、上传与 GenericAgent bridge 编排。 |
| Chat 子模块 | `crates/agent-gui/src/pages/chat/*` | transcript、composer、header、GA runtime adapter、history actions、uploads 与对话状态映射。 |
| Settings | `crates/agent-gui/src/pages/SettingsPage.tsx`、`src/pages/settings/*` | Providers、System、MCP、Agents、Hooks、Cron、Memory、Skills、GA 配置。 |
| Hub 页面 | `src/pages/skills-hub/*`、`src/pages/mcp-hub/*`、`src/components/hub/HubChrome.tsx` | Skills Hub、MCP Hub、store/registry 浏览与本地配置管理。 |
| UI 组件 | `src/components/*`、`src/components/ui/*` | Sidebar、Markdown、ImagePreview、通用 button/input/select/dropdown/scroll 等。 |
| 前端设置库 | `src/lib/settings/*` | 默认值、normalize、storage、provider redaction。 |
| GenericAgent bridge | `src/lib/ga/*`、`src/pages/chat/runtime/*` | GA runtime supervisor 的 typed client（GaBridgeClient）、HTTP session snapshot、WebSocket refresh hint 与对话状态映射。 |
| 工具展示层 | `src/lib/tools/builtinToolCatalog.ts`、`src/pages/chat/components/*` | 展示工具目录与 tool call/result 卡片；不注册或执行主对话工具。 |
| Tauri 后端 | `src-tauri/src` | 系统命令、SQLite、MCP 配置持久化、GA runtime supervisor、automation、代理服务。 |

## App Shell

| 责任 | 当前实现 |
|---|---|
| 初始设置 | 通过 settings API 读取 providers/system/mcp/agents/hooks/cron/memory，并与前端默认值合并。 |
| 设置保存 | Settings 页修改后按配置域保存到 Tauri SQLite。 |
| 主题与语言 | `theme` 写入 document root，`LocaleProvider` 提供翻译。 |
| 页面布局 | 主视图以 ChatPage 为中心，Settings 使用 overlay/modal 风格进入。 |
| runtime bridge | App shell 确保 GenericAgent runtime ready（GA supervisor 启停）；聊天通过 GA bridge 观察 session。 |

## ChatPage 编排

| 子系统 | 说明 | 关键路径 |
|---|---|---|
| 会话运行态 | 当前 conversation、session、message list、live stream、tool status、running/canceling 状态。 | `ChatPage.tsx`、`pages/chat/hooks/useChatPageRuntimeStore.ts`、`lib/chat/conversation/liveTranscriptStore.ts` |
| 发送入口 | 将用户文本、附件、选中模型、execution mode、workdir、system tools 等合并为 turn request。 | `ChatPage.tsx` |
| 主对话 | `useSendChatTurn` 经 `runGaChatTurn`/`GaBridgeClient` 提交 prompt；GenericAgent runtime 负责模型、工具与 session，GUI 读取权威 HTTP snapshot 并渲染。 | `pages/chat/runtime/useSendChatTurn.ts`、`pages/chat/runtime/runGaChatTurn.ts`、`lib/ga/GaBridgeClient.ts` |
| 对话映射 | 将 GA message snapshot 映射为 `ConversationViewState`，同步 messages、tool cards、running/idle/error。 | `lib/ga/gaMessages.ts`、`lib/chat/conversation/conversationState.ts` |
| 历史与侧栏 | 通过 GA bridge backend 读取/更新对话目录；本地结构仅作为 UI 兼容模型。 | `lib/ga/gaSidebarBackend.ts`、`pages/chat/history/*` |
| Memory | Settings 只读展示 GenericAgent memory layer metadata；主对话不再注入本地 Memory overview。 | `pages/settings/GaMemorySection.tsx`、`lib/ga/GaBridgeClient.ts` |
| Skills/SOP | 主对话可见 Skills/SOP 由 GenericAgent runtime 决定；Skills Hub 保留桌面管理视图。 | `pages/skills-hub/*`、`lib/ga/GaBridgeClient.ts` |
| 上传 | GUI 直接调用 Tauri import readable files/image preview；工作区外文件复制到 uploads 暂存区（不污染工作区），工作区内文件原地引用。 | `pages/chat/usePendingUploads.ts`、`src-tauri/src/commands/app/system.rs` |

## Tauri Invoke Surface

| 域 | 命令模块 |
|---|---|
| App/系统 | `commands/app/*`（app/system.rs、app/tray.rs） |
| 设置 | `commands/config/settings/*`（providers/system/mcp/agents/commands/ssh/memory） |
| 历史 | `commands/history/chat_history/*`、`commands/history/history_db.rs`、`subagent_store.rs` |
| Runtime | `commands/runtime/ga_runtime.rs`、`process.rs`、`terminal.rs`、`sftp.rs` |
| Workspace | `commands/workspace/*`（fs、git、edit_match、subagent_worktree） |
| Automation | `commands/automation/*`（hook.rs、cron.rs） |
| Integration | `commands/integration/*`（workspace_watch） |

## Rust Services 与 Runtime

| 路径 | 作用 |
|---|---|
| `services/automation/*` | Hooks/Cron 调度、执行记录与快照。 |
| `services/memory/*` | Memory 目录组织、daily、organizer（GA 侧为权威记忆层，本地做管理/索引）。 |
| `services/skills/*` | Skills root、builtin seed、install/create/validate/package、ClawHub。 |
| `services/provider_models.rs` | Provider 模型元数据。 |
| `services/proxy.rs`、`services/system_proxy.rs` | 本地 proxy server 与系统代理。 |
| `services/workspace_watch/*` | 工作区上下监控。 |
| `services/tray.rs`、`services/power_activity.rs` | 托盘菜单与电源活性感知。 |
| `services/legacy_archive.rs` | 首次启动旧数据归档（allowlist、manifest+hash、幂等）。 |
| `crates/agent-gui/src-tauri/src/runtime/managed_process_journal.rs` | GA 子进程/托管进程 journal 与可恢复性。 |

## GenericAgent 运行时连接

| 机制 | 当前实现 |
|---|---|
| 进程管理 | Tauri supervisor 启停 GenericAgent 托管进程（`ga_runtime.rs` 定义 GA bridge 端口与命令表；`process.rs` 负责进程生命周期、退出码与日志）。 |
| 协议 | GA bridge 对外提供 HTTP 快照 + WebSocket refresh hint；adapter 位于 `src-tauri/ga-runtime/ga_bridge_adapter.py`（支持 projectId、session 绑定、MCP Connector、automation/hooks、token 统计等只读/控制端点）。 |
| 失败处理 | 托管进程退出后自动重启，journal 记录往返事件，异常时 GUI 显示 runtime 不可用并允许恢复。 |
| 会话绑定 | GA session 通过 `projectId` 与 WorkspaceProject 绑定（普通 cwd 会话降级为普通会话，多匹配时需用户显式选择）。 |

## 本地持久化模型

| 数据域 | Rust 位置 | 表或文件 |
|---|---|---|
| Providers/System/MCP/Agents/Hooks/Cron/Memory settings | `commands/config/settings/*` | `~/.ozawaagent/config.sqlite` 内多张 settings 表 |
| Chat history | `commands/history/chat_history/*` | `~/.ozawaagent/chat-history.sqlite3` 的 `chatHistory`、`chatHistorySegment`、`chatHistoryShare`、FTS |
| Memory | GA runtime + `services/memory/*` | `~/.ozawaagent/memory/**/*.md` + `memory-index.sqlite3` |
| Skills | `services/skills/*` | `~/.ozawaagent/skills` |
| Cron 执行日志 | `commands/automation/cron.rs` | `cron_execution_logs` |
| Subagent identity/run/message | `commands/history/subagent_store.rs` | chat history 库内 `subagentMeta`/`subagentIdentity`/`subagentRun`/`subagentRunSegment`/`subagentMessage`（schema v2） |

## GUI 的设计取舍

| 取舍 | 原因 |
|---|---|
| ChatPage 仍是总编排层 | 对话运行时跨模型、工具、历史、压缩、记忆、GA bridge、上传和 UI 状态，保留一个编排中心能减少跨模块隐式状态。 |
| 高权限能力放 Rust | 文件系统、Shell、SQLite、GA 进程管理、Cron 更适合在 Tauri 后端做权限与生命周期控制；MCP 协议执行归 GenericAgent/Connector。 |
| GA 只读桥接 | GUI 通过 GA bridge 读取会话快照与只读元数据；写路径（模型调用、工具执行、记忆写入）始终由 GenericAgent runtime 完成。 |
| 设置按域保存 | provider secret、agents、cron、memory 等域有不同验证与同步策略，分域保存便于限制泄露与减少误覆盖。 |
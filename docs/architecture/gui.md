# 桌面 GUI 与 Tauri 架构

## 模块边界

| 模块 | 路径 | 职责 |
|---|---|---|
| React app shell | `crates/agent-gui/src/App.tsx` | 设置 hydration/save、主题/i18n、Settings overlay、ChatPage、全局 toast 与 GenericAgent runtime readiness。 |
| Chat 页面 | `crates/agent-gui/src/pages/ChatPage.tsx` | 会话视图、消息发送/取消、历史、上传与 GenericAgent bridge 编排。 |
| Chat 子模块 | `crates/agent-gui/src/pages/chat/*` | transcript、composer、header、GA runtime adapter、history actions、uploads 与对话状态映射。 |
| Settings | `crates/agent-gui/src/pages/SettingsPage.tsx`、`src/pages/settings/*` | Providers、System、MCP、Agents、Hooks、Cron、Remote、Memory、Skills 配置。 |
| Hub 页面 | `src/pages/skills-hub/*`、`src/pages/mcp-hub/*`、`src/components/hub/HubChrome.tsx` | Skills Hub、MCP Hub、store/registry 浏览与本地配置管理。 |
| UI 组件 | `src/components/*`、`src/components/ui/*` | Sidebar、Markdown、ImagePreview、通用 button/input/select/dropdown/scroll 等。 |
| 前端设置库 | `src/lib/settings/*` | 默认值、normalize、storage、Gateway sync snapshot、provider redaction。 |
| GenericAgent bridge | `src/lib/ga/*`、`src/pages/chat/runtime/*` | runtime supervisor 的 typed client、HTTP session snapshot、WebSocket refresh hint 与对话状态映射。 |
| 工具展示/兼容层 | `src/lib/tools/builtinToolCatalog.ts`、`src/pages/chat/components/*` | 展示工具目录与 tool call/result 卡片；不注册或执行主对话工具。 |
| Tauri 后端 | `src-tauri/src` | 系统命令、SQLite、MCP 配置持久化、MemoryStore、GatewayController、CronManager、代理服务。 |

## App Shell

| 责任 | 当前实现 |
|---|---|
| 初始设置 | 通过 settings API 读取 providers/system/mcp/agents/hooks/cron/remote/memory，并与前端默认值合并。 |
| 设置保存 | Settings 页修改后按配置域保存到 Tauri SQLite，并在需要时 publish settings sync 到 Gateway。 |
| 主题与语言 | `theme` 写入 document root，`LocaleProvider` 提供翻译。 |
| 页面布局 | 主视图以 ChatPage 为中心，Settings 使用 overlay/modal 风格进入。 |
| 后台 bridge | App shell 确保 GenericAgent runtime ready；聊天通过 GA bridge 观察 session，旧 Memory organizer 不再启动。 |
| 远程桥接 | Remote settings 启用时，Tauri GatewayController 连接 Go Gateway，并把 settings/history/chat event 发布出去。 |

## ChatPage 编排

| 子系统 | 说明 | 关键路径 |
|---|---|---|
| 会话运行态 | 当前 conversation、session、message list、live stream、tool status、running/canceling 状态。 | `ChatPage.tsx`、`pages/chat/hooks/useChatPageRuntimeStore.ts`、`lib/chat/conversation/liveTranscriptStore.ts` |
| 发送入口 | 将用户文本、附件、选中模型、execution mode、workdir、system tools 等合并为 turn request。 | `ChatPage.tsx` |
| 主对话 | `useSendChatTurn` 经 `runGaChatTurn`/`GaBridgeClient` 提交 prompt；GenericAgent runtime 负责模型、工具与 session，GUI 读取权威 HTTP snapshot 并渲染。 | `pages/chat/runtime/useSendChatTurn.ts`、`pages/chat/runtime/runGaChatTurn.ts`、`lib/ga/GaBridgeClient.ts` |
| 对话映射 | 将 GA message snapshot 映射为 `ConversationViewState`，同步 messages、tool cards、running/idle/error。 | `lib/ga/gaMessages.ts`、`lib/chat/conversation/conversationState.ts` |
| 历史与侧栏 | 通过 GA bridge backend 读取/更新对话目录；本地 V3 结构仅作为 UI 兼容模型。 | `lib/ga/gaSidebarBackend.ts`、`pages/chat/history/*` |
| Memory | Settings 只读展示 GenericAgent memory layer metadata；主对话不再注入旧 Memory overview。 | `pages/settings/GaMemorySection.tsx`、`lib/ga/GaBridgeClient.ts` |
| Skills/SOP | 主对话可见 Skills/SOP 由 GenericAgent runtime 决定；Skills Hub 保留桌面管理视图。 | `pages/skills-hub/*`、`lib/ga/GaBridgeClient.ts` |
| 上传 | GUI 直接调用 Tauri import readable files/image preview；工作区外文件复制到 `~/.liveagent/uploads` 暂存区（不污染工作区），工作区内文件原地引用。 | `pages/chat/usePendingUploads.ts`、`src-tauri/src/commands/system.rs` |
| Gateway bridge | 本地运行时接收远程 command，把 token/thinking/tool/done/error 等事件发布给 Gateway；listener 与 worker id 在组件生命周期内保持稳定。 | `pages/chat/gateway/useGatewayBridgeListeners.ts`、`lib/chat/conversation/run/gatewayBridgeEvents.ts` |

## Tauri Invoke Surface

`src-tauri/src/lib.rs` 用 `tauri::generate_handler!` 注册桌面端所有命令。按领域可归纳为：

| 领域 | 命令族 |
|---|---|
| Chat history | `chat_history_list/search/get/upsert/upsert_active_segment/append_segment/rename/set_pinned/share_get/share_set/delete` |
| Subagent store | `subagent_identity_upsert/list`、`subagent_run_save/list/load/prune`、`subagent_message_append/list` |
| File system | `fs_read_editable_text/read_workspace_image/write_text/delete/open_workspace_path/create_dir/rename/roots/list/mention_list` |
| Subagent worktree | `subagent_worktree_create/status/apply/cleanup` |
| Memory | —（旧 `memory_*` Tauri 命令已移除；操作经 Gateway `memory.manage` 归 GenericAgent runtime） |
| Settings | `settings_load_all/save_providers/save_system/save_mcp/save_agents/save_hooks/save_cron/save_remote/save_memory` |
| Hooks/Cron | `hook_run_script/run_http_requests`、`cron_validate_expression/list_logs/clear_logs/take_pending_prompt_runs/complete_prompt_run` |
| Shell/process | `managed_process_stop/read_log/snapshot/clear` |
| System | folder/file picker、uploads、skill metadata/text/manage、debug jsonl、power activity、cron task manage |
| Gateway | `gateway_status/nudge_connection/send_chat_event/publish_settings_sync`，以及 chat queue/runtime snapshot 与 tunnel/workspace watch 命令 |
| Proxy | `proxy_get_server_info` |

## Rust Services 与 Runtime

| 路径 | 作用 |
|---|---|
| `src-tauri/src/services/gateway/*` | GatewayController，维护桌面端到 Gateway 的连接、原生唤醒、inbox、状态同步与重连。 |
| `src-tauri/src/services/gateway_bridge.rs` | 将 Gateway 请求转成前端/Tauri 能处理的操作，处理 settings/history/chat 等桥接。 |
| `src-tauri/src/services/memory.rs` | MemoryStore，负责 Markdown 记忆文件、SQLite FTS 索引、quota、daily、organizer。 |
| `src-tauri/src/services/skills.rs` | Skills root、builtin seed、install/create/validate/package、ClawHub。 |
| `src-tauri/src/services/cron.rs` | CronManager，调度 bash/http/prompt task，记录日志并暴露 pending prompt run。 |
| `src-tauri/src/services/proxy.rs` | 本地 proxy server，用于 provider proxy 和上游访问。 |
| `src-tauri/src/runtime/shell_runner.rs` | Shell 脚本执行抽象。 |
| `src-tauri/src/runtime/managed_process.rs` | 长任务/后台进程管理。 |
| `src-tauri/src/runtime/task_runner.rs` | 通用异步任务运行辅助。 |

## Gateway 连接与 Runtime 唤醒

| 机制 | 当前实现 |
|---|---|
| 稳定 WebView listener | `useGatewayBridgeListeners` 用 ref 保存 worker id 和最新回调，effect 只在组件挂载/卸载时注册或销毁；普通 React render 不再重建 listener、制造接收空窗或重复上报 `suspended`。 |
| 原生往返唤醒 | Rust 收到 `chat-runtime-wake-` 前缀的关联 Ping 后 emit `gateway:chat-runtime-wake`；所有 Pong（唤醒与心跳）经专用出站控制通道（64 深，与数据队列 merge 进同一信封流（v2 WebSocket））`try_send` 返回，token 流打满数据队列时探测仍可被应答，且绝不阻塞 inbound receive loop。 |
| 生命周期 nudge | `online`、`focus`、`pageshow`、`visibilitychange`、WebView `resume` 与 Tauri `RunEvent::Resumed` 会唤醒 runtime；`online`/focus 类事件经 `gateway_nudge_connection` 走 offline/stale-heartbeat 健康检查后才重建连接（不强制），仅 `RunEvent::Resumed` 保留强制重连。 |
| 快速重连 | 信封流自动重连从 250ms 指数退避到 5s（v2 `/ws/v2/agent`），稳定连接 30s 后重置；stale 判断使用 heartbeat interval 加 20s（最多 60s）。 |
| inbound 优先 | 信封流（`/ws/v2/agent`）建立后立即进入 inbound receive loop。Runtime status 先恢复，settings、terminal、tunnel、process 与 run ledger 延迟 200ms 后在可中止后台任务中低优先级 replay，并在批次间 yield。 |
| 启动空窗消除 | WebView 在 Tauri listener 异步注册完成前就先 heartbeat + drain 一次；native wake、request-ready 与 Gateway online 事件都会继续触发 drain。 |

## 本地持久化模型

| 数据域 | Rust 命令/服务 | 表或文件 |
|---|---|---|
| Providers/System/MCP/Agents/Hooks/Cron/Remote/Memory settings | `commands/settings.rs` | `~/.liveagent/config.sqlite` 内多张 settings 表 |
| Chat history | `commands/chat_history.rs` | `~/.liveagent/chat-history.sqlite3` 的 `chatHistory`、`chatHistorySegment`、`chatHistoryShare`、FTS |
| Memory | `services/memory.rs` | `~/.liveagent/memory/**/*.md` + `memory-index.sqlite3` |
| Skills | `services/skills.rs` | `~/.liveagent/skills` |
| Cron logs | `commands/settings.rs`、`services/cron.rs` | `cron_execution_logs` |
| Subagent identity/run/message | `commands/history/subagent_store.rs` | chat history 库内 `subagentMeta` 版本标记 + `subagentIdentity`/`subagentRun`/`subagentRunSegment`/`subagentMessage`（schema v2，版本不符即 drop-and-recreate，无 event 表） |

## GUI 的设计取舍

| 取舍 | 原因 |
|---|---|
| ChatPage 仍是总编排层 | 对话运行时跨模型、工具、历史、压缩、记忆、Gateway、上传和 UI 状态，保留一个编排中心能减少跨模块隐式状态。 |
| 高权限能力放 Rust | 文件系统、Shell、SQLite、Gateway 连接、Cron 更适合在 Tauri 后端做权限与生命周期控制；MCP 协议执行归 GenericAgent/Connector。 |
| GUI 与 WebUI 复制部分 UI | 两端运行环境不同，WebUI 不能直接调用 Tauri，但需要维持体验 parity，因此复制 settings/hub/chat 组件并接入 shims。 |
| Settings 按域保存 | provider secret、remote、cron、memory 等域有不同验证和同步策略，分域保存便于限制泄露与减少误覆盖。 |
| Gateway 控制面优先 | 远程首条 Chat command 与 Ping/Pong 必须先于大体积状态 reconciliation；后台 snapshot replay 只负责最终一致性，不阻塞 inbound。 |

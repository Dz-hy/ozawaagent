# OzawaAgent 总体架构

## 系统分层

| 层级 | 主要路径 | 技术栈 | 核心职责 |
|---|---|---|---|
| 桌面 GUI | `crates/agent-gui/src` | React、TypeScript、Vite、Tailwind | Chat shell、Settings、Skills Hub、MCP Hub、Memory UI、历史侧边栏、上传与流式渲染。 |
| 桌面后端 | `crates/agent-gui/src-tauri` | Tauri、Rust | 本地权限边界（设置/历史/自动化/运行时命令），管理 GenericAgent 子进程，提供技能、MCP 配置、代理与工作区服务。 |
| Agent 运行时 | GenericAgent（托管进程） | Rust 驱动的本地运行环境 | 主对话中的模型调用、工具执行、Skills/SOP 发现、MCP Connector 生命周期与内存管理。 |
| 本地存储 | `~/.ozawaagent/` | SQLite、Markdown | 设置、Chat 历史、Memory 文件与索引、Skills runtime root。 |

> 历史说明：仓库曾包含 `crates/agent-gateway`（Go Gateway）与浏览器 WebUI 双端镜像架构；该远程中继层已整体移除，产品为纯本地桌面应用。如需追溯旧设计可查 git 历史。

## 进程边界

| 进程/运行环境 | 入口 | 和谁通信 | 权限边界 |
|---|---|---|---|
| Tauri WebView | `crates/agent-gui/src/main.tsx`、`src/App.tsx` | Tauri invoke、模型 API | 用户可见桌面界面，触发本地能力但不直接访问 Rust 内部状态。 |
| Tauri Rust 进程 | `src-tauri/src/main.rs`、`src-tauri/src/lib.rs` | 前端 invoke、SQLite、OS、GenericAgent 子进程 | 本地桌面能力与持久化；Agent 工具与 MCP 协议由 GenericAgent/Connector 执行。 |
| GenericAgent 运行时 | `src-tauri` 的 GA 运行 supervisor 启停 | GA bridge（HTTP 快照 + WebSocket refresh）、模型 API | 本地工具执行与模型访问；GUI 通过桥接读取会话快照。 |

## 核心数据流

| 数据流 | 步骤 | 关键路径 |
|---|---|---|
| 本地桌面对话 | GUI composer 经 `useSendChatTurn` 向 GenericAgent runtime 提交 prompt；GenericAgent 拥有模型与工具执行，GUI 以 session snapshot 为权威状态、WebSocket 提示刷新，`GaBridgeClient` 管理桥接。 | `lib/ga/GaBridgeClient.ts`、`pages/chat/runtime/runGaChatTurn.ts` |
| 设置 | GUI load/save 设置到本地 SQLite（`commands/config/settings/*`），普通 sync 不带真实 provider API key。 | `src-tauri/src/commands/config/settings/*` |
| 历史 | GUI/Tauri 持久化 `chatHistory` 到本地 SQLite，History 侧边栏与子代理记录经 Tauri 命令读写。 | `src-tauri/src/commands/history/*` |
| 上传文件 | GUI 直接通过 Tauri 导入；统一写入 `~/.ozawaagent/upload/` 或 workdir 并由工具执行。 | `commands/runtime/*`、`commands/workspace/*` |
| 记忆目录 | Settings Memory 通过 GA Bridge 读取 GenericAgent 暴露的只读 memory layer metadata；内容与文件路径留在 GenericAgent 内部，GUI 不启动本地 organizer/extraction。 | GA Bridge memory 只读接口 |
| Skills / MCP | Skills Hub 与 MCP Hub 修改配置并落盘，GenericAgent runtime 在对话中按需加载。 | `services/skills/*`、`lib/mcpRegistry/*` |

## 当前主要持久化

| 数据 | 位置 | 所有者 | 说明 |
|---|---|---|---|
| 应用设置 | `~/.ozawaagent/config.sqlite` | Tauri Rust | provider/system/mcp/agents/hooks/cron/memory settings。 |
| Chat 历史 | `~/.ozawaagent/chat-history.sqlite3` | Tauri Rust | 对话 header、segment、FTS 索引。 |
| Memory 文件 | `~/.ozawaagent/memory/...` | GenericAgent/Tauri | Markdown 记忆事实源，按 global/project/daily 等目录组织。 |
| Skills root | `~/.ozawaagent/skills` | Tauri Rust + GUI | 用户可安装/创建/打包的 Skills runtime root。 |
| 项目工作区 | `~/.ozawaagent/default-project` | Tauri Rust | 首次安装/空 workdir 时的默认项目目录。 |

## 设计原则

- **桌面本地优先**：设置、历史、记忆、Cron 与 Skills 等本地状态全部由 Tauri/GUI 持久化，无外部中继依赖。
- **Agent 运行时执行**：模型调用、工具执行、MCP server 生命周期由 GenericAgent/Connector 负责，GUI 不维护本地 Agent runtime。
- **桥接只读**：GUI 通过 GA bridge 读取会话快照与 memory 元数据；写路径始终经由 Agent 运行时自身完成。
- **功能域清晰**：Chat runtime、Tools、Memory、Skills、MCP、Cron、Hooks、History 各自有独立源码区域与后端命令。

## 高层模块图

```text
Desktop OzawaAgent
├─ React GUI: App, ChatPage, SettingsPage, Hub pages (Skills/MCP)
├─ GA bridge: typed HTTP snapshots, WebSocket refresh hints, tool-card rendering
└─ Tauri Rust
   ├─ commands: settings, history, workspace, runtime, automation (cron/hook), app
   ├─ services: skills, memory, provider_models, proxy, workspace_watch
   └─ GA runtime supervisor: GenericAgent（模型调用 + 工具执行 + MCP Connector）
```
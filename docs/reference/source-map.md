# 源码索引

## 根目录

| 路径 | 说明 |
|---|---|
| `README.md` | 项目根说明。 |
| `Makefile` | 桌面构建与 release 常用命令。 |
| `Cargo.toml` | Rust workspace。 |
| `doc/` | 历史专项文档。 |
| `docs/` | 当前架构总览文档。 |

## GUI Frontend

| 功能 | 路径 |
|---|---|
| App shell | `crates/agent-gui/src/App.tsx` |
| React entry | `crates/agent-gui/src/main.tsx` |
| Chat page | `crates/agent-gui/src/pages/ChatPage.tsx` |
| Chat turn | `crates/agent-gui/src/pages/chat/runtime/useSendChatTurn.ts`、`runGaChatTurn.ts` |
| Chat transcript | `crates/agent-gui/src/pages/chat/transcript/ChatTranscript.tsx`、`pages/chat/components/AssistantBubble.tsx` |
| Composer/header | `crates/agent-gui/src/pages/chat/components/ChatComposerBar.tsx`、`ChatHeader.tsx` |
| History sidebar | `crates/agent-gui/src/components/chat/ChatHistorySidebar.tsx` |
| Context builders | `crates/agent-gui/src/pages/chat/conversationContextBuilders.ts` |
| Settings page | `crates/agent-gui/src/pages/SettingsPage.tsx`、`src/pages/settings/*` |
| Skills Hub | `crates/agent-gui/src/pages/skills-hub/*` |
| MCP Hub | `crates/agent-gui/src/pages/mcp-hub/*` |
| Shared hub chrome | `crates/agent-gui/src/components/hub/HubChrome.tsx` |
| i18n | `crates/agent-gui/src/i18n/*` |

## GUI Libraries

| 功能 | 路径 |
|---|---|
| Model provider layer | `crates/agent-gui/src/lib/providers/llm.ts` |
| Provider proxy helpers | `crates/agent-gui/src/lib/providers/proxy.ts` |
| Settings defaults/storage/sync | `crates/agent-gui/src/lib/settings/*` |
| GenericAgent bridge client | `crates/agent-gui/src/lib/ga/GaBridgeClient.ts` |
| GenericAgent chat turn | `crates/agent-gui/src/pages/chat/runtime/runGaChatTurn.ts` |
| Display-only builtin tool catalog | `crates/agent-gui/src/lib/tools/builtinToolCatalog.ts` |
| Tool types/options | `crates/agent-gui/src/lib/tools/builtinTypes.ts`、`systemToolOptions.ts` |
| FS backend adapter | `crates/agent-gui/src/lib/tools/fsBackend.ts` |
| Todo / AskUser bundles | `crates/agent-gui/src/lib/tools/todoTools.ts`、`askUserQuestionTools.ts` |
| Subagent support | `crates/agent-gui/src/lib/subagents/*` |
| Conversation state | `crates/agent-gui/src/lib/chat/conversation/*` |
| Memory prompt/policy | `crates/agent-gui/src/lib/chat/memory/*` |
| Skills discovery | `crates/agent-gui/src/lib/skills/*` |
| MCP registry | `crates/agent-gui/src/lib/mcpRegistry/*` |

## Tauri Rust

| 功能 | 路径 |
|---|---|
| Tauri entry | `crates/agent-gui/src-tauri/src/main.rs` |
| App builder/invoke handler | `crates/agent-gui/src-tauri/src/lib.rs` |
| Settings commands | `crates/agent-gui/src-tauri/src/commands/config/settings/*`（providers/mcp/agents/system/ssh/memory_settings/json/db） |
| Chat history commands | `crates/agent-gui/src-tauri/src/commands/history/chat_history/*`、`history/history_db.rs` |
| Subagent worktree/store | `crates/agent-gui/src-tauri/src/commands/workspace/subagent_worktree.rs`、`commands/history/subagent_store.rs` |
| Workspace commands | `crates/agent-gui/src-tauri/src/commands/workspace/*`（fs、git、edit_match） |
| Runtime commands | `crates/agent-gui/src-tauri/src/commands/runtime/*`（ga_runtime、process、sftp、terminal） |
| App/system commands | `crates/agent-gui/src-tauri/src/commands/app/*`（system） |
| Cron/hook commands | `crates/agent-gui/src-tauri/src/commands/automation/*` |
| Workspace watch | `commands/integration/workspace_watch.rs` + `services/workspace_watch/*` |
| Memory (store+settings) | `commands/config/settings/memory_settings.rs` + `services/memory/*` |
| Skills service | `crates/agent-gui/src-tauri/src/services/skills/*` |
| Provider/proxy services | `crates/agent-gui/src-tauri/src/services/provider_models.rs`、`system_proxy.rs`、`proxy.rs` |
| Legacy archive | `crates/agent-gui/src-tauri/src/services/legacy_archive.rs` |

## 资料与设计

| 路径 | 说明 |
|---|---|
| `docs/architecture/*` | 当前总览架构文档。 |
| `docs/features/*` | 当前功能域架构文档。 |

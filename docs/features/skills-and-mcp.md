# Skills 与 MCP

## Skills 架构

| 层 | 路径 | 职责 |
|---|---|---|
| builtin source | `crates/agent-gui/src-tauri/prompt/skills/<skill-name>` | 内置 skills 源文件。 |
| runtime root | `~/.liveagent/skills` | 用户运行时 skills 根目录。 |
| Rust service | `src-tauri/src/services/skills/*` | seed builtin、list/read/manage/install/create/validate/package/ClawHub。写侧由进程级 `skills_write_guard()` 串行化（agent 调用、gateway 转发、UI 后台安装线程、builtin seeding 四路写者）；安装走 stage-then-swap：内容（含 `_meta.json`）先在 `<root>/.staging/` 完整构建，再原子 rename 入位，读者永远看不到半成品。 |
| Frontend lib | `src/lib/skills/*`、WebUI copy | managed skills metadata、展示 prompt 辅助、ClawHub client、install status。 |
| Agent runtime | GenericAgent | 主对话中的 Skills/SOP 发现、选择与工具暴露。 |
| Hub UI | `src/pages/skills-hub/SkillsHubPage.tsx`、WebUI mirror | Installed/Store 两个视图，选择、扫描、预览、安装。 |

## Builtin Skills

| Skill | 说明 |
|---|---|
| `skills-creator` | 指导模型创建新 Skill。 |
| `skills-installer` | 指导模型安装本地/GitHub/压缩包/ClawHub Skill。 |

这两个 builtin skill 在前端 `lib/skills/builtin.ts` 中作为 always enabled 名称处理，Rust 启动或扫描时可通过 `system_ensure_builtin_skills` seed 到 runtime root。

## Skills 管理能力

桌面端不再维护本地 `SkillsManager` 工具适配器；Skills Hub 与 Tauri/Rust skills service 负责以下管理能力，主对话中的工具暴露由 GenericAgent runtime 决定。

| Action | 说明 |
|---|---|
| `read` | 读取 Skill entry file，例如 `SKILL.md`、`skill.json`、`README.md`。 |
| `list` | 列出已安装或已启用的 Skills。 |
| `install` | 从本地目录、`.zip/.skill`、HTTP(S)、GitHub repo/tree/blob 导入。 |
| `create` | 根据 workflow 摘要创建新 Skill。 |
| `validate` | 校验已安装 Skill。 |
| `package` | 打包为 `.skill` archive。 |
| `clawhub_search` | 搜索/浏览 ClawHub。 |
| `clawhub_install` | 按 ClawHub slug 下载并安装。 |

UI 后台安装 job 使用 `install_start` 启动带进度的后台安装线程、`install_status` 轮询快照、`install_cancel` 协作式取消（下载与逐 skill 安装循环检查取消标记，终态为 `phase: "cancelled"`）。

## ClawHub 兼容边界

| 场景 | 处理规则 |
|---|---|
| Store identity | ClawHub Skill 以 `ownerHandle + slug` 作为唯一身份；React key、安装任务、已安装状态和 `_meta.json` 回读不得只按 slug 合并。 |
| list 缺 owner | `/api/v1/skills` 条目缺少发布者时，详情/安装前通过精确搜索按 `updatedAt`、version、downloads 等字段懒解析 owner；无法唯一匹配时明确失败，不盲选发布者。 |
| 下载/详情 | 所有已解析的详情和 `/api/v1/download` 请求都携带 `ownerHandle`，避免重名 slug 返回 HTTP 409。 |
| 非便携名称 | 仍严格执行 Agent Skills 小写名称规范；ClawHub 官方语义是 slug 与目录显示名分离、互不派生，因此单 Skill 包的非法 `name` 一律修复而非拒绝：优先改写为 registry slug（payload 缺 slug 时从下载 URL query 兜底解析），slug 不可用时回退为规范化后的 `name`；原名、规范名和转换类型写入 `_meta.json`。 |
| 原始内容 | 名称兼容转换只发生在下载临时目录，不修改注册表下载包；合法 `name` 即便与 slug 不同也保持原样；slug 与规范化 `name` 都不可用（如 Windows 保留名）时仍按严格校验拒绝。 |

## Skills 选择与 Prompt 注入

| 阶段 | 说明 |
|---|---|
| 扫描 | `discoverSkills()` 调用 Tauri 或 Gateway skill APIs，读取 runtime root 中的 Skill metadata。 |
| 选择 | Settings/Skills Hub 管理 `settings.skills.selected`，builtin always-on 自动合并。 |
| 注入 | Chat tools 模式下，`useChatSkills` 和 `lib/skills/index.ts` 生成当前对话可见 skills prompt。 |
| 访问 | 桌面 UI 与后台服务通过现有 Tauri/Gateway APIs 管理旧 LiveAgent runtime root；主对话对 Skills/SOP 的访问由 GenericAgent runtime 负责。 |

## MCP 架构

| 层 | 路径 | 职责 |
|---|---|---|
| MCP settings | `settings.mcp.servers`、`settings.mcp.selected` | server 配置与启用选择。 |
| MCP Hub UI | `src/pages/mcp-hub/*`、WebUI mirror | server form、registry browser、preview drawer、install draft。 |
| Registry client | `src/lib/mcpRegistry/index.ts`（Gateway WebUI） | official registry、Smithery、Glama 等 registry 归一化。 |
| Rust runtime | `src-tauri/src/commands/mcp.rs` | stdio/http/sse server lifecycle、tools/list、call_tool、test/restart/stop/status。 |
| Agent runtime | GenericAgent | 主对话中的 MCP 配置语义与动态工具暴露；GUI 不维护本地 `McpManager` 工具适配器。 |
| Write path | `src/lib/settings/mcpOps.ts` | 唯一的 MCP 配置写路径：`McpSettingsOp`（upsert/patch/remove/setEnabled）+ 纯 reducer `applyMcpOps`，按 id 合并进 `setSettings(prev => ...)`；工具读取走 `getMcpSettings` 实时 getter（权威 `settingsRef`），不做 turn 级快照，读改写决策与提交在同一同步段内完成，从根上消除多写者覆盖。 |

## MCP Runtime 生命周期

| 阶段 | 说明 |
|---|---|
| 配置 | 用户在 MCP Hub/Settings 添加 server，支持 stdio/http/sse 等 transport。 |
| 选择 | enabled 且 selected 的 server 构成当前启用配置。 |
| 管理 | MCP Hub/Settings 经配置写路径执行 add/update/delete/enable/disable；Tauri 命令提供 status/test/restart/stop/tools/list。桌面写操作仍按先 commit 配置、后 best-effort 停旧 runtime 的顺序执行（stop 失败降级为 warning，由下次 `ensure_client` 配置判等自愈）。主对话是否暴露 MCP 管理或动态工具由 GenericAgent runtime 决定。 |
| Runtime | Tauri/Rust 命令负责 server lifecycle、tools/list 与 call_tool；`McpRuntimeManager` 的 clients map 锁只做 get/insert 短持有，绝不在持 map 锁时锁单个 client 或 spawn——同 id 调用在 client 锁上串行，不同 server 互不阻塞。 |

## MCP Registry

| Source | 作用 |
|---|---|
| official registry | 从 `registry.modelcontextprotocol.io` 读取官方 server 列表与 package metadata。 |
| Smithery | 搜索 Smithery server，并尝试解析 install draft 或 manual draft。 |
| Glama | 搜索 Glama MCP server 列表。 |

Registry card 会被归一化为统一的 `McpRegistryCard`，其中 `installDraft` 表示可直接生成 server config，`manualDraft` 表示需要用户手工补全。

## GUI/WebUI Parity 要点

| 区域 | 注意事项 |
|---|---|
| Skills Hub | GUI/WebUI 都有 installed/store、preview drawer、install job 状态，并以 `ownerHandle + slug` 推导 ClawHub 安装身份。 |
| MCP Hub | GUI/WebUI 都有 server form、registry browser、preview drawer、install draft。 |
| i18n | 双端有各自 `i18n/config.ts`，新增文案要同步。 |
| settings sync | Skills/MCP settings 从 GUI 经 Gateway 同步到 WebUI，WebUI 修改再回写 GUI。 |
| shims | WebUI 的 Tauri invoke 实际走 Gateway，不应假设浏览器有本地权限。 |

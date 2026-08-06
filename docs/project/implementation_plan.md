# LiveAgent × GenericAgent 二开主规划（已确认）

- 项目模式：`GA-aee18f3a`
- 目标代码：`C:\Users\DZHY\git-repository\ozawaagent`
- 开发态 GA：`D:\GenericAgent`
- GA 勘察基线：`main@51f7692`（2026-08-06 起改为跟随官方最新，见 §3.1-26）
- 目标平台：Windows 10/11 x64
- 产品品牌：`OzawaAgent`（2026-08-06 用户定名；Phase 9 落地 productName/标识，见 §3.1-21）
- 文档状态：已于 2026-07-27 获用户最终确认；后续实施从 Phase 0 开始；2026-08-06 修订见 §3.1

## 1. 项目目标

保持 LiveAgent 的视觉、布局和主要交互方式，以 GenericAgent 完全替换其 Agent 运行时。React 可以修改状态管理和调用逻辑，但不能继续承载第二套 Agent Loop。工作区、文件树、Git、终端、窗口和托盘等纯桌面能力继续使用 LiveAgent 原生实现。

最终产品使用新的独立名称和标识；About/NOTICE 与分发物保留 LiveAgent、GenericAgent 的 MIT 版权和来源说明。

## 2. 已核验的现状与关键判断

### 2.1 LiveAgent

- 技术栈：React 19 + TypeScript + Vite + Tauri 2 + Rust。
- 当前 Agent Loop 在 React/TypeScript 内运行，不是可在 Rust 层无损替换的单一后端。
- Tauri/Rust 已包含文件系统、Git、终端、SQLite、进程、更新、托盘等成熟桌面能力。
- Gateway 是大型独立子系统：Go 服务、Browser WebUI、Proto、Rust Gateway service、前端同步与发布链均有耦合。
- 当前目录缺少 `.git`，不能直接审计或回滚。

### 2.2 GenericAgent

- Python 核心，以 `GenericAgent` SDK、约 100 行 Agent Loop 和原子工具体系为中心。
- 原生能力包括：文件、脚本、浏览器、用户确认、工作记忆、长期记忆、自进化 Skills/SOP、子 Agent/长期任务等。
- 官方桌面端已经通过 `frontends/desktop_bridge.py` 暴露本地 Bridge：
  - `/status`、`/config`、`/model-profiles*`
  - `/sessions`、`/session/new`、`/session/{sid}`
  - prompt、messages、plan、cancel、restore、model
  - upload、path/open、token stats/history
  - services、mykey、memory import、conductor 等
  - WebSocket `/ws` 推送轻量状态通知
- 官方 Bridge 默认监听 `127.0.0.1:14168`，但现状不足以满足本项目所需的强制鉴权、Origin 校验、动态端口和类型化版本协商。

### 2.3 核心架构结论

不能用“Rust 层替换一个函数”的方式完成改造。正确边界是：

```text
LiveAgent React UI
  ├─ 纯桌面能力 ──Tauri invoke──> LiveAgent Rust services
  └─ Agent 语义 ──HTTP/WS──> ga_bridge_adapter.py
                              └─ import/wrap GA desktop_bridge + GA core
```

`ga_bridge_adapter.py` 是防腐层，不是第二个 Agent 内核。

## 3. 决策基线

1. 保持视觉与交互，允许改 React 状态和调用逻辑。
2. Agent 语义全部以 GA 为唯一真相源，禁止双库或双 Agent Loop。
3. 开发态连接 `D:\GenericAgent`；发布态内置独立 Python+GA runtime，并支持外部 GA 路径覆盖。
4. 删除 Gateway、Go 服务、Browser WebUI 及其构建发布链，不再考虑远程能力。
5. 首期仅 Windows 10/11 x64。
6. 能映射 GA 的页面改接 GA；LiveAgent 专属 Agent 页面删除；纯桌面页面保留。
7. 复用官方 `desktop_bridge.py`，在 LiveAgent 仓维护薄适配器。
8. 不迁移旧 Agent 数据；首次启动只读归档；纯桌面设置保留。
9. Bridge 仅 localhost，随机令牌，HTTP/WS 鉴权，Origin/CORS 限制，动态端口。
10. 当前无 Git：改造前建立文件哈希和初始 Git 基线。
11. MVP 先做端到端垂直切片。
12. 已知 GA 事件精确映射；未知事件以通用卡片保真降级。
13. GA 内核跟随官方最新 main（fork 合入、保留本地补丁；2026-08-06 修订，废弃"锁定早期 commit 51f7692 不再跟进"）；每个发布版本仍固定"最近一次通过 adapter 契约回归的官方 commit"写入 runtime manifest，不在运行时自动更新。详见 §3.1-26。
14. 每个 GA 会话固定绑定一个工作区，禁止运行中偷偷更换 cwd。
15. Workspace/Project 采用分层融合而非二选一：LiveAgent `workspaceProjects` 是真实目录、文件树、Git、终端与桌面工程生命周期的唯一真相源；GA session `cwd` 是 Agent 文件操作根目录；GA per-session Project Mode 是项目记忆、规则、私域产物和跨会话连续性的唯一真相源。
16. LiveAgent Workspace 与 GA Project Mode 必须通过稳定 `projectId` 一对一绑定；不得只用目录 basename、大小写未规范化路径或进程级全局激活锚识别项目，也不得维护两套可独立改写真实目录的 workspace 注册表。
17. 工具授权完全沿用 GA 原生安全策略与 `ask_user`，LiveAgent 不叠加第二套权限系统。
18. 扩展能力采用“Capability Registry 管配置与授权、Connector/Tool 管执行、SOP/Memory 管使用认知、Command Registry 管显式入口”的分层；不得把 MCP/CLI/HTTP 协议细节或密钥当作 Memory 注入模型。
19. `/命令` 是可选的人类显式入口，不是工具协议、插件实现或权限系统；模型可自动选择已启用能力，但不得自行安装、永久启用能力或绕过 `ask_user`。
20. Morphling 成果按产物性质固化：认知进 Memory、流程进 SOP/Skill、确定性执行进 Tool/Connector、显式入口进 Command Pack、配置进 Capability Registry、验收进 tests/fixtures，禁止全部堆入长期记忆。

### 3.1 2026-08-06 规划修订（用户确认）

21. **品牌定名**：`OzawaAgent`，GitHub 公开仓库（owner `Dz-hy`）。Phase 9 完成 productName/identifier/包名/二进制名/图标/协议与数据目录的落地；About/NOTICE 与源码分发保留 LiveAgent（2026 Stack-Cairn）与 GenericAgent（2025 lsdefine）双 MIT 版权与来源说明。
22. **P1 修复 = 独立补丁**：审核 P1×6（A 配置写盘非事务、B proxy 脱敏不全、C 删除引用漂移、D 前端丢弃控制 runtime、E 命令/PATCH 先改内存后持久化、F Mixin 清理不全）按 P1-B→A→E+D→C+F 顺序以独立补丁推进，不并入 Phase 6 删除工作；每批独立 commit + 最小测试 + 全量回归。
23. **Phase 6 确认节奏**：批量删除清单在执行 Phase 6 时再生成并请求用户确认（用户已确认该节奏，不提前准备清单）。
24. **构建产物延后**：最终安装包等产物延后至 Phase 6/9 全部完成后统一构建；Phase 8 的 stager 打包链与单元测试保留，期间不重复产出安装包。
25. **安装态验收归入 Phase 9 门禁**：用最终构建的新安装包执行完整验收矩阵（干净用户/无系统 Python/路径含中文空格/非管理员/离线启动/升级/卸载/外部 GA 覆盖），补齐"旧 Aug2 安装包不代表 Aug5+ 工作树"的遗留。
26. **GA 开发态跟随最新**：`D:\GenericAgent` 是本地 fork（本地补丁：llmcore.py codex_client 指纹可选化、mykey_template.py 扩展、.gitignore CDP Bridge 配置忽略），官方更新后执行 `fetch + merge 官方 main`（保留本地补丁），跑 adapter 契约测试 + 核心冒烟，通过后更新 `runtime_manifest.json` 的 ga_commit；发布态锁定最近一次通过回归的官方 commit。

## 4. 目标模块划分

### 4.1 React：保留 UI，替换运行时

新增建议目录：

```text
crates/agent-gui/src/lib/ga-bridge/
  client.ts             # HTTP 客户端、令牌、超时、错误分类
  websocket.ts          # 断线重连、状态同步、序列/去重
  contract.ts           # API DTO 与版本
  eventAdapter.ts       # GA 事件 -> LiveAgent transcript 模型
  sessionAdapter.ts     # GA session -> sidebar/history 模型
  providerAdapter.ts    # GA model profile -> Provider 表单模型
  errors.ts
  redaction.ts
```

新增/替换运行时：

```text
crates/agent-gui/src/pages/chat/runtime/GaChatRuntimeHost.ts
```

职责：

- session CRUD 与工作区绑定；
- prompt、upload、cancel、restore；
- WS 状态驱动 + HTTP authoritative snapshot；
- 应用重启后恢复 running/failed/cancelled/done；
- 将已知事件映射为现有 AssistantBubble、ToolResult、AskUserQuestionCard；
- 未知事件显示 GenericAgentEventCard；
- 不执行模型调用、不调用 LiveAgent builtin tool registry。

### 4.2 Python adapter：协议、安全、兼容

建议目录：

```text
runtime/ga/
  ga_bridge_adapter.py
  contract.py
  auth.py
  event_mapper.py
  runtime_manifest.json
  requirements.lock
```

职责：

- 通过 `GA_ROOT` 加载开发态或内置 GA；
- 复用官方 AgentManager、session/history、model profile、service 能力；
- 增加 `/api/v1/capabilities` 和 `/api/v1/version`；
- 规范统一 envelope：`request_id`、`session_id`、`turn_id`、`event_id`、`type`、`timestamp`、`payload`；
- 增加令牌中间件、Origin allowlist、敏感字段脱敏；
- 只监听 127.0.0.1；
- 对上传、工作区路径、错误响应做边界检查；
- 未知 GA item 原样保真封装，不静默丢弃；
- 项目专用逻辑不直接污染 D:\GenericAgent；通用改进另行提交上游。

### 4.3 Tauri/Rust：sidecar 生命周期

建议新增：

```text
crates/agent-gui/src-tauri/src/services/ga_runtime/
  mod.rs
  discovery.rs
  process.rs
  health.rs
  manifest.rs
  migration.rs
  logs.rs
crates/agent-gui/src-tauri/src/commands/ga_runtime.rs
```

职责：

- 解析 runtime 优先级：显式外部路径 > 开发环境 `D:\GenericAgent` > 内置 runtime；
- 校验 GA 路径、Python、manifest 与 adapter API 兼容性；
- 申请空闲端口，生成高熵临时令牌；
- 以环境变量启动 adapter，隐藏 Windows 控制台；
- 等待健康检查并向 React 仅返回必要连接信息；
- 捕获脱敏日志，维护状态机：starting/ready/degraded/crashed/stopping；
- 精确终止自身子进程树，禁止误杀系统 Python；
- 崩溃有限退避重启，令牌轮换；
- 首次启动归档旧 Agent 数据；保留纯桌面配置。

注意：长期应尽量避免把 bearer token 暴露给任意网页上下文；Tauri capability/CSP 也必须收紧。MVP 可由主 WebView 获取短期连接上下文，但必须配合严格 Origin、CSP 和导航限制。

### 4.4 Workspace 与 GA Project Mode：工程外壳和项目大脑

采用三层单向绑定：

```text
LiveAgent WorkspaceProject
  projectId + displayName + canonicalPath
  文件树 / 编辑器 / Git / 终端 / Clone / 目录生命周期
                  │ 创建会话时固定绑定
                  ▼
GA Session
  cwd = canonicalPath
  projectId + projectName
                  │ 每个 GenericAgent 实例独立激活
                  ▼
GA per-session Project Mode
  project_memory.md / 项目规则 / 私域 todo、草稿和 Agent 产物 / 跨会话连续性
```

职责与约束：

- LiveAgent `workspaceProjects` 继续负责用户真实目录和桌面工程 UI；GA 不复制、移动或接管用户工程，也不另建可独立修改真实路径的第二注册表。
- 新建会话时将 `projectId`、展示名和规范化绝对路径一并传给 Bridge；`cwd` 在 session 生命周期内不可变。切换 Workspace 应切换已有会话或新建会话，不能原地修改运行中 session 的目录。
- Bridge 以 `projectId` 作为稳定身份，以 `canonicalPath` 作为文件操作根目录；目录 basename 只用于展示。Windows 路径需统一绝对化、分隔符、盘符大小写、junction/realpath 比较规则，避免同目录重复注册。
- Bridge 为每个 `GenericAgent` 实例设置 per-session Project Mode 上下文，不使用 `temp/.active_project.<pid>` 等进程级全局锚；多会话并行时不得串项目记忆或 cwd。
- GA 项目私域目录只保存 `project_memory.md`、todo、草稿、运行元数据和明确标记的 Agent 产物；用户源码仍保存在真实 Workspace。junction 仅作为 GA 兼容实现细节，不作为前端身份或路径真相源。
- 同一 `projectId` 的不同 GA sessions 共享项目级记忆，但会话 transcript/status 仍相互独立；未绑定 Workspace 的临时会话仅使用普通 cwd，不自动开启 Project Mode。
- 删除/隐藏 LiveAgent Workspace 默认不删除 GA 项目记忆；必须提供明确的“保留记忆 / 导出后删除”选择。任何删除 project memory 或 junction 的操作均不得触碰真实用户目录。
- 现有仅含 `cwd` 的会话按规范化路径尝试回填唯一 `projectId`；零匹配保持普通会话，多匹配或路径冲突进入显式修复流程，禁止静默猜测。

### 4.5 Capability、Connector、Command 与 Memory：能力执行分层

统一扩展架构：

```text
Capability Registry
  安装状态 / 版本 / transport / secret引用 / 权限 / scope / 健康状态
        │
        ├─ Native GA Tool
        ├─ MCP Connector（stdio / SSE / Streamable HTTP）
        ├─ CLI / HTTP Connector
        └─ Python Tool Plugin
                    │
SOP / Skill / Memory ── 何时使用、适用边界、失败降级与安全规则
Command Registry ───── 人类可选的显式 `/命令` 入口
Automation / Hook ──── 定时或事件触发入口
```

职责与约束：

- GA 不原生支持的 MCP-only 程序由 Bridge 侧 MCP Connector 接入：完成 initialize、`tools/list`、`tools/call`、schema 转换、连接复用、重连、取消、超时、输出限额、脱敏和故障隔离，再向 GA 暴露标准 Tool；禁止让模型依据 Memory 临时手搓 MCP JSON-RPC。
- MCP tools 映射为 GA Tools；resources 映射为受控上下文资源；prompts 可映射为 Skill 或 `ga/prompt` Command Pack。CLI/HTTP-only 程序走同一 Connector 抽象，不为每种协议另造 UI 真相源。
- Capability Registry 保存稳定 `capabilityId`、实现类型、版本、transport、endpoint/启动方式、工具 allowlist、超时、作用域、启用状态和健康状态；认证字段只保存安全存储引用，Memory、SOP、命令定义、日志和前端 DTO 均不得包含明文 secret。
- 能力生命周期区分 `installed`、`enabled`、`discoverable`、`loaded`、`invoked`。低风险常用能力可默认发现；低频能力采用摘要发现与按需加载完整 schema；首次启用、高风险或扩大权限必须由用户确认。
- 模型可以自动调用当前 session/project 已启用且获授权的能力，也可以建议启用未启用能力；模型不得自行安装、永久启用、扩大 scope 或绕过 GA `ask_user`。`/命令` 同样不能绕过权限。
- 自定义 `/命令` 支持 `ga/prompt`、workflow command 与 `ga/python`；命令定义至少含 namespace/id、scope、invocation（human/model/both）、activation（always/project/manual）、参数 schema、`requires_capabilities`、permissions、risk 和版本。内置 namespace 保留，冲突时 UI 显示实际 owner。
- `/命令` 只编排或调用已注册能力，不承载 MCP 会话协议，不复制 Tool 实现，也不启动第二套 Agent Loop；插件卸载或能力不可用时返回结构化 unavailable，禁止静默退化为普通 Prompt。
- Morphling 固化必须先分类：知识与适用边界→Memory；可复用判断/操作流程→SOP/Skill；确定性动作→Tool/Python Plugin；MCP/CLI/HTTP 接入→Connector；人类高频入口→Command Pack；长流程→Workflow/Automation；安装权限状态→Capability Registry；客观标准→tests/fixtures/benchmark。
- Memory 只引用稳定 `capabilityId` 并记录“何时用、限制、顺序、失败替代和安全约束”，不复制 endpoint、认证、完整 schema 或实现代码，避免上下文膨胀与配置漂移。

## 5. 功能映射矩阵

| LiveAgent 功能 | 处理 | 新真相源/实现 |
|---|---|---|
| Chat UI、输入框、消息气泡 | 保留外观，替换数据流 | GA session + event adapter |
| text/tools/agent-dev 模式 | 删除原 Agent Loop；按 GA 能力重定义或简化 | GA |
| Provider 设置 | 保留页面外观，字段适配 | GA model profiles/mykey API |
| 会话历史、标题、删除 | 改接 | GA sessions/history |
| 发送、流式、取消、恢复 | 改接 | GA prompt/cancel/restore + WS |
| 工具轨迹 | 保留组件，适配事件 | GA tool events |
| ask_user | 保留交互卡，真实等待 | GA ask_user |
| 文件上传/附件 | 保留操作方式，改接 | GA upload/path context |
| Skills Hub | 保留可复用外观，重做数据适配 | GA SOP/Skills 文件与能力 API |
| `/` 输入面板 | 保留交互并改为 Commands/Skills 分组；行首精确命令优先，冲突 Skill 用 `/skill <name>` | GA Command Registry + GA Skills |
| `/workspace`、`/model`、`/effort`、`/btw`、`/cost` | 改为结构化运行态命令，不把字符串透传给 TUI | GA Python Command Plugins |
| `/autorun`、`/morphling`、`/goal`、`/hive`、`/conductor` | 注册为 Prompt 宏命令，复用 GA prompt builder/SOP | GA Command Packs/Registry |
| 新增自定义 `/命令` | 声明式 Command Pack 或 Python Command Plugin；React 自动发现，不改 UI 业务代码 | GA Command Registry |
| Hooks 设置页 | 保留外观，改为管理 GA Hook Registry；删除 LiveAgent Hook 执行器 | GA plugins/hooks.py + adapter |
| Automation/Cron 页面 | 保留外观，数据与执行全部改接 GA；页面与 `/scheduler` 同源 | GA Automation/Scheduler Registry |
| Memory 页面 | 保留可复用外观，重做数据适配 | GA 分层 memory |
| Cron/长期任务 | 支持 Agent Prompt、GA service、受控 command/http；禁止双调度器 | GA Automation/Scheduler Registry |
| Subagent roster | 删除 LiveAgent 实现；未来展示 GA 事件/状态 | GA |
| MCP Hub/Registry | 删除 LiveAgent 旧 MCP 执行器与 Agent registry；保留可复用外观并改为统一 Capability Center | GA Capability Registry + MCP/CLI/HTTP Connectors |
| MCP-only 第三方程序 | 经 Bridge Connector 转换为 GA 标准 Tool；可选生成 `/命令` 显式入口 | GA Tool Plugin + Capability Registry |
| Morphling 蒸馏成果 | 按知识/流程/执行器/入口/配置/测例分类固化，不全部写入 Memory | Memory + SOP/Skill + Tool/Connector + Command/Automation + tests |
| Builtin tool registry | 删除 LiveAgent 旧运行时调用；能力状态统一并入 Capability Registry | GA tools + Capability Registry |
| LiveAgent compaction、usage budget | 删除或仅展示 GA 自有统计 | GA |
| 工作区、文件树 | 保留桌面工程外壳；以稳定 projectId 绑定 GA session，不维护第二目录真相源 | LiveAgent Rust/React WorkspaceProject |
| Agent 项目记忆与规则 | 新增 per-session Project Mode；同 projectId 跨会话共享项目记忆，普通临时会话不强制启用 | GA Project Mode |
| Git review | 保留 | LiveAgent Rust |
| 终端 | 保留 | LiveAgent Rust |
| 窗口、托盘、主题、i18n | 保留 | LiveAgent |
| 更新 | 保留框架，重做产品 endpoint/签名 | 新产品 |
| Gateway/Go/WebUI/Proto | 完整删除 | 不替代 |

## 6. API 与事件契约

### 6.1 必需管理 API

- `GET /api/v1/version`
- `GET /api/v1/capabilities`
- `GET/POST/PATCH/DELETE /api/v1/capabilities*`（安装元数据、启用状态、scope、权限和健康状态；密钥仅接收 write-only secret reference）
- `POST /api/v1/capabilities/{id}/enable|disable|test`
- `GET /api/v1/capabilities/{id}/tools` 与 `POST /api/v1/capabilities/{id}/tools/{tool}/invoke`（后者仅供受控诊断/显式命令复用，正常 Agent 调用走 GA Tool Registry）
- `GET /api/v1/health`
- `GET/PUT /api/v1/model-profiles*`
- `GET/POST/PATCH/DELETE /api/v1/sessions*`
- `GET/POST/PATCH /api/v1/projects*`（GA Project Mode 元数据、记忆状态与安全生命周期；真实目录仍由 LiveAgent 管理）
- `POST /api/v1/projects/{id}/resolve`（用稳定 projectId + canonicalPath 幂等解析/准备 per-session Project Mode）
- `GET /api/v1/projects/{id}/memory` 与受控 `PATCH /api/v1/projects/{id}/memory`（后续 Memory 页面使用，禁止任意路径访问）
- `POST /api/v1/sessions/{id}/turns`
- `POST /api/v1/sessions/{id}/turns/{turn_id}/cancel`
- `POST /api/v1/sessions/{id}/restore`
- `POST/DELETE/GET /api/v1/uploads*`
- `GET /api/v1/sessions/{id}/snapshot`
- `GET /api/v1/commands`（能力发现、参数 schema、权限、owner、版本）
- `POST /api/v1/commands/{id}/execute`（结构化上下文与结构化结果）
- `POST /api/v1/commands/reload`（仅开发/授权模式）
- `GET /api/v1/skills` 与 `POST /api/v1/skills/{id}/resolve`
- `GET/PATCH /api/v1/hooks*`（内置 Hook 只读或仅安全开关）
- `GET/POST/PATCH/DELETE /api/v1/automations*`
- `POST /api/v1/automations/{id}/run|stop`
- `GET /api/v1/automations/{id}/runs`
- `WS /api/v1/events`

adapter 可在内部调用/复用官方旧路由，但 React 只依赖版本化 `/api/v1` 契约。

Session 创建/快照的 Workspace 绑定至少包含：

```json
{
  "cwd": "D:\\MyProject",
  "projectId": "workspace-project-123",
  "projectName": "MyProject",
  "projectMode": true
}
```

契约不变量：

- `projectId` 是稳定机器身份，`projectName` 仅用于展示且允许重命名；同名目录不能合并项目。
- `cwd` 必须是经 adapter 校验的规范化绝对目录，并在 session 创建后只读；API 不提供原地换 cwd。
- `projectMode=true` 时，Bridge 必须将该 GA Agent 实例绑定到同一 `projectId` 的 Project Mode；不得写进程级全局 active project。
- `projectId` 与规范化 `cwd` 的冲突返回结构化错误，要求用户显式修复，不得静默重绑。
- 兼容旧数据时，缺少 `projectId` 的 session 可保持 `projectMode=false`；只有规范化路径唯一匹配已有 LiveAgent WorkspaceProject 时才自动回填。
- API 只暴露项目记忆和状态的受控 DTO，不向 React 暴露 GA 内部 registry 路径、junction 实现细节或任意文件写权限。

### 6.2 Command Registry 契约

命令不能继续绑定 `tuiapp_v2.py` 或写死在 React。Registry 至少支持三类 owner/kind：

1. `ga/prompt`：声明式 Command Pack，以 `command.yaml` 描述 id、aliases、参数 schema、权限、可见性和依赖，并引用 prompt/Skill/SOP；执行结果是提交给 GA 的规范化 Prompt；
2. `ga/python`：Python Command Plugin，处理 workspace/model/effort/btw/cost/scheduler 等运行态或有副作用操作；
3. `desktop/ui`：new/switch/clear 等纯桌面动作，但只能调用公开 Bridge/Tauri API，不能访问或复制 GA 私有状态。

统一结果 envelope 支持 `message`、`toast`、`picker`、`form`、`table`、`job`、`prompt`、`error`、`unavailable`；未知结果降级显示原始脱敏结构。命令定义带 `api_version`、`plugin_version`、namespace/id、scope、invocation（human/model/both）、activation（always/project/manual）、参数 schema、`requires_capabilities`、permissions、risk 和版本。生产模式禁止任意热装 Python；声明式包可受控刷新，Python Plugin 安装/升级需明确授权或随应用发布。

命令只提供显式入口与编排：引用 Capability Registry 中的稳定 `capabilityId`，不得内嵌 endpoint、secret 或 MCP 协议逻辑。能力缺失、未启用或权限不足时返回结构化 `unavailable`/approval request，不得把原命令文本静默当普通 Prompt 发送。内置 namespace 保留；项目命令、用户全局命令发生别名冲突时，UI 必须显示 owner 和最终解析结果。

统一 `/` 面板将 Commands 与 Skills 分组。行首精确命令优先；同名 Skill 通过 `/skill <name>` 或 Skill 分组显式选择；消息中的 Skill chip 只向 GA 注入上下文。`/update` 仅外部 GA 开发模式可用，内置固定 runtime 中隐藏/禁用。Capability Center 与 `/` 面板共享同一启用状态；模型只看到已授权能力的摘要或 schema，不因命令可见而自动获得权限。

#### 4.5.1 可发现性与命名

不继续沿用含义过窄的“自定义工具”作为总入口，独立页面统一命名为 **能力中心（Capabilities）**。LiveAgent 现有“系统工具 / 自定义工具”卡片与详情弹窗可复用视觉和交互，但“自定义工具”只作为能力中心中的来源/分类，不再承载 MCP、命令、Skill 的全部语义；原 MCP Hub 合并为能力中心的 Connectors/MCP 视图，Skills Hub 可保留独立内容页并从能力中心交叉导航。

能力中心至少提供：

- 总览、工具、连接器（MCP/CLI/HTTP）、命令、Skills/SOP 五类视图；
- 按名称、别名、自然语言功能、来源、标签、scope、启用状态和健康状态搜索/筛选；
- 每项显示“一句话能做什么”、来源、owner、版本、风险、global/project scope、enabled/loaded/health，以及关联命令或依赖能力；
- 详情页展示适用场景、参数、调用示例、最近使用时间、最近错误、权限与“在当前项目启用/禁用”；协议 endpoint 和 secret 不直接展示给普通详情页；
- MCP Server 以连接器卡片展示，其导出的 tools 作为可展开子项；既能按 Server 找工具，也能直接按工具功能反查所属 Server；
- Command 以入口卡片展示，明确标记它调用的 capabilityId；一个能力可有多个命令别名，但只有一个稳定身份，避免重复安装和名称漂移；
- 提供“仅显示当前项目可用”“最近使用”“新安装”“不可用/需授权”等快捷筛选和数量统计。

聊天输入区的 `/` 面板是能力中心的快捷入口而非第二套注册表：支持 Commands/Skills 分组、描述、来源、参数提示、启用状态与模糊搜索，并提供“查看全部能力”跳转。增加 `/help` 或等价内置入口列出当前项目可用命令；当命令很多时默认按最近使用、项目相关性和显式收藏排序，而不是把全部 schema 一次注入模型上下文。

### 6.3 Hook 与 Automation 契约

GA Hook Registry 是唯一执行器，事件对齐如下：`agent_before→agent_start`、`turn_before→turn_start`、`llm_before→message_start`、`llm_after→message_end`、`tool_before→tool_execution_start`、`tool_after→tool_execution_end`、`turn_after→turn_end`、`agent_after→agent_end`。Python Hook 可按 GA 原生语义读写 ctx；声明式 command/http Hook 默认只接收脱敏快照，并有超时、失败策略和最近错误。内置插件只能只读展示或切换安全开关，UI 禁止覆盖其源码。

Automation Registry 是唯一调度真相源，支持 `agent_prompt`、`service`、`command`、`http`。页面与 `/scheduler` 读取同一状态；每个任务有 schedule、timezone、workspace、model、effort、timeout、enabled、next_run、last_run 和 run history。旧 `sche_tasks/*.json` 可作为兼容导入或底层实现，但 React 不直接编辑文件，且禁止 LiveAgent Rust Cron 同时执行。

### 6.4 事件最小集合

- `session.state_changed`
- `turn.started`
- `assistant.delta`
- `assistant.final`
- `reasoning.delta`（若 GA 提供）
- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`
- `ask_user.requested`
- `ask_user.resolved`
- `turn.cancelled`
- `turn.failed`
- `turn.completed`
- `command.started`
- `command.completed`
- `command.failed`
- `hook.started`
- `hook.completed`
- `hook.failed`
- `automation.triggered`
- `automation.run_changed`
- `service.state_changed`
- `runtime.warning`
- `unknown.raw`

### 6.5 一致性规则

- HTTP snapshot 是权威状态，WS 只用于低延迟通知。
- 每个 turn/event 必须有稳定 ID；React 按 event_id 去重。
- WS 重连后重新拉 snapshot，不依赖无限事件重放。
- `cancel` 幂等；重复请求返回当前最终状态。
- 页面切换或重启不能让正在执行的 GA turn 被 React 生命周期误取消。
- secret 字段只允许写入，不允许回显明文。

## 7. 分阶段实施路线

### Phase 0：基线、可回滚与依赖图

任务：

1. 生成当前 LiveAgent 文件清单、SHA-256、工具链版本和构建结果。
2. 检查 `.gitignore` 是否排除构建物/密钥，再初始化 Git。
3. 提交未改造导入基线；每次 commit 末尾添加指定 Co-Authored-By。
4. 跑并记录现有门禁：pnpm install/build/lint/test，cargo check/tests。
5. 生成 Gateway、Agent runtime、纯桌面模块的 import/command/service 依赖图。
6. 建立 Architecture Decision Records（本计划中的 22 项决策）。

验收：基线可重新 checkout，构建证据可复现，工作区干净。

### Phase 1：Bridge 契约与安全骨架

任务：

1. 创建 `ga_bridge_adapter.py` 与 `/api/v1/version|capabilities|health`。
2. 加入 token、Origin/CORS、localhost、错误 envelope、脱敏。
3. 建立 contract fixtures 和 adapter 单测。
4. 固定 GA `51f7692` 作为首个开发兼容基线。
5. 对官方 Bridge 行为做契约测试，而非复制其内部实现。

验收：无令牌、错误令牌、错误 Origin 全部拒绝；正确客户端可查询版本和健康；密钥不出现在日志/响应。

### Phase 2：Tauri GA runtime supervisor

任务：

1. 实现路径发现与 manifest 校验。
2. 动态端口、随机 token、无控制台启动。
3. 健康检查、超时、日志、有限重启、优雅退出和进程树清理。
4. 向 React 暴露最小 runtime status 命令/事件。
5. 为端口占用、Python 缺失、GA 路径错误、版本不兼容提供可操作错误。

验收：连续启停、模拟崩溃、应用强退重开后无孤儿 Python；不误杀其他 Python；外部 GA 与内置 mock runtime 均能发现。

### Phase 3：React 类型化客户端与会话骨架

任务：

1. 创建 GaBridgeClient、WS 管理器、DTO、错误模型。
2. 将会话列表/创建/切换/重命名/删除接到 GA。
3. 每个 session 固定 workspace；切换 workspace 切会话/新建。
4. Session DTO 同时携带稳定 `projectId`、展示名、规范化 `cwd` 与 `projectMode`；LiveAgent WorkspaceProject 继续是桌面目录真相源。
5. Bridge 为绑定项目的每个 Agent 实例独立激活 GA per-session Project Mode，不使用进程级全局 workspace 锚。
6. 建立 snapshot hydration 与 WS 重连机制。
7. 保持侧边栏和 ChatPage 视觉不变。

验收：会话 CRUD 与工作区绑定在重启后仍一致；同一 projectId 的多个会话共享项目记忆但 transcript 独立；不同项目并行运行不串 cwd/记忆；断开/恢复 Bridge 不重复消息。

当前实现状态说明：桌面版已经完成 LiveAgent Workspace → GA session `cwd`，但尚未携带稳定 `projectId` 或激活 GA per-session Project Mode；该项作为 Phase 3 遗留缺口，在进入依赖项目记忆的高阶 Memory/Automation 功能前补齐。

### Phase 4：MVP 垂直聊天切片

任务：

1. Provider 最小配置闭环。
2. prompt、流式增量、最终消息、cancel、restore。
3. 工具 call/result 映射到现有卡片。
4. ask_user 请求与应答闭环。
5. 上传和文件路径上下文。
6. 未知事件通用卡片。
7. 运行中切页面、重启 UI、Bridge 崩溃后的状态恢复。
8. 建立 GA Command Registry、`GET /commands` 与结构化 execute 契约。
9. Composer `/` 面板分组展示 Commands/Skills，实现精确命令与 `/skill` 冲突规则。
10. 接入 `/workspace`、`/model`、`/effort`、`/btw`、`/cost` 运行态命令。
11. 接入 `/autorun`、`/morphling`、`/goal` Prompt 宏；`/update` 在内置 runtime 禁用。
12. 提供一个声明式 Command Pack 和一个 Python Command Plugin 样例，证明新增命令无需改 React。
13. 暴露 GA Hook 生命周期事件的只读可观测链路。
14. 建立 Automation Registry 最小 API，并跑通一个 Agent Prompt 定时任务。
15. 关闭 LiveAgent 旧 `runAgentConversationTurn`/builtinRegistry 的生产入口。

MVP 验收场景：

- 配置一个模型后创建会话并完成普通回答；
- 运行文件读取与脚本工具，UI 显示开始、参数摘要、结果和失败；
- 触发 ask_user，未选择前 Agent 不继续，选择后恢复；
- 上传文件并让 GA 读取；
- 长回复流式显示，取消后状态稳定且可继续新 turn；
- turn 执行中刷新/重启应用，恢复到权威状态；
- 杀死 Bridge 后 UI 明确报错，supervisor 恢复并重新同步；
- `/` 面板同时发现 Commands 与 Skills，同名冲突按已定规则解析；
- 新放入一个声明式 Command Pack 后，无需修改 React 即出现在面板并可执行；
- Python Plugin 命令返回 picker/form/table 等结构化结果并由现有 UI 渲染；
- 核心命令不依赖启动 TUI，workspace/model/effort/cost 状态与 GA 会话一致；
- Hook 事件可观测且敏感字段被脱敏；一个定时 Agent Prompt 只触发一次并留下运行记录；
- 未知事件不丢失、不破坏 transcript。

### Phase 5：高阶 GA 页面适配

按风险顺序：

1. 完整 model profiles 与高级参数；
2. 补齐 WorkspaceProject → GA session → per-session Project Mode 的稳定 projectId 绑定，并提供项目记忆状态/冲突修复入口；
3. Skills/SOP 浏览、启用、导入、刷新；
4. 分层 Memory 浏览与安全编辑/导入；项目级 Memory 只通过受控 Project API 访问；
5. token stats/history（只展示 GA 统计）；
6. `/hive`、`/conductor` 多 Agent 状态、子任务树、消息与日志可视化；
7. `/scheduler` 完整 Automation Center：Agent Prompt、service、受控 command/http、运行历史与手动触发/停止；任务引用稳定 projectId，执行时解析为受控 cwd/Project Mode，不保存仅靠显示名的工作目录；
8. Hooks 高级管理：声明式 command/http 编辑、超时、脱敏、失败策略和最近错误；Python 插件仅发现、只读详情及安全开关；
9. 能力中心（Capabilities）：复用 LiveAgent 现有系统/自定义工具卡片与详情交互，替代含义过窄的“自定义工具”总入口；统一发现 Native Tool、MCP、CLI、HTTP、Python Tool Plugin、Commands 与 Skills/SOP，提供分类、自然语言检索、来源/owner、别名、用途、示例、最近使用、关联能力，并管理 installed/enabled/discoverable/loaded 状态、project/global scope、权限、健康检查和 secret reference；
10. MCP Connector：将原 MCP Hub 合并为能力中心的 Connectors/MCP 视图；至少打通一个 stdio 与一个 Streamable HTTP/SSE fixture，完成 tools/list、tools/call、schema 转换、取消、重连、输出限额和脱敏，并支持从 Server 展开工具及按工具反查 Server；
11. Command Pack 管理：发现、启停、受控刷新、版本/权限/冲突诊断，并支持 human/model/both、manual/project/always 与 `requires_capabilities`；
12. Morphling 固化向导/规范：要求成果选择 Memory、SOP/Skill、Tool/Connector、Command/Automation、Capability Registry 和 tests 中的正确目标，禁止默认整包写入 Memory；
13. GA 服务状态与日志的用户友好视图。

每项必须先写“GA 概念 → UI 概念”映射；无法一一映射时删入口，不创建第二真相源。

### Phase 6：旧内核与远程模块拆除

删除顺序必须在 MVP 稳定后进行：

1. 先用静态搜索和编译门禁确认旧入口不再运行。
2. 删除 React Agent Loop、builtin tools、LiveAgent Provider runtime、旧 memory/skills/subagent/compaction/cron Agent 实现。
3. 删除前端 Remote/Gateway 状态与设置。
4. 删除 Rust Gateway services/commands、Proto build、相关依赖。
5. 删除 `crates/agent-gateway`（Go + WebUI）。
6. 删除 Dockerfile、railway、Gateway workflows、Proto/mirror/release scripts、文档和 Make targets。
7. 清理 Cargo/pnpm/Go 依赖、权限和 dead code。
8. 全仓搜索 `gateway|remote|proto|runAgentConversationTurn|builtinRegistry`，对每个残留分类说明。

注意：这是批量删除，执行前必须再次生成删除清单并请求用户确认；每一组删除单独 commit，编译/测试通过后再进入下一组。

### Phase 7：旧数据归档与首启迁移

任务：

1. 识别旧 Agent DB/config/cache 的精确路径和 schema。
2. 首次启动生成时间戳归档，保留 manifest 和 hash。
3. 禁止把明文 Provider secret 写入归档日志。
4. 保留桌面偏好；对混合配置做字段级 allowlist 迁移。
5. 为已有仅含 `cwd` 的 GA sessions/LiveAgent workspaceProjects 做幂等 projectId 回填：规范化路径唯一匹配才自动绑定，零匹配保持普通会话，多匹配/冲突要求用户显式选择。
6. Workspace 隐藏/移除不自动删除 GA project memory；注销 GA 项目时只清理 registry/junction/私域记忆，不得删除真实用户目录。
7. UI 提供“打开备份目录”，不提供自动回滚到旧 Agent 内核。

验收：重复启动幂等；旧数据不丢失；GA 新数据与旧 DB 完全解耦；迁移不产生同目录多 projectId，不因同名目录误合并项目，不触碰真实 Workspace 文件。

### Phase 8：Windows 内置 runtime 与安装包

任务：

1. 选择可再分发 Python runtime，固定 Python 与依赖版本。
2. 构建 GA runtime manifest：GA commit、adapter API、依赖 hash、构建时间。
3. 仅打包运行所需文件；排除 `.git`、temp、用户 memory、密钥和开发缓存。
4. NSIS 安装、升级、卸载；用户数据与程序 runtime 分离。
5. 保留外部 GA 路径高级选项和兼容提示。
6. 更新器采用新产品标识、endpoint 与签名密钥。
7. 加入双 MIT License、NOTICE、SBOM/第三方依赖清单。

验收矩阵：Windows 10/11 x64，干净用户、无系统 Python、路径含中文/空格、非管理员安装、离线启动、升级安装、卸载、外部 GA 覆盖。

注：2026-08-06 修订——stager 打包链与单元测试保留，但最终安装包构建与安装态验收延后至 Phase 9 门禁统一执行（见 §3.1-24/25）。

### Phase 9：品牌、文档与发布门禁

任务：

- 新 productName（OzawaAgent）、identifier、包名、二进制名、图标、协议/数据目录；
- README、架构、故障排查、开发模式、外部 GA 模式；
- About/NOTICE 与上游来源（双 MIT）；
- 删除远程能力的残余说明；
- 安装态验收（强制门禁，§3.1-25）：用最终构建的新安装包执行完整验收矩阵；
- 发布 checklist 与回滚说明。

## 8. 测试策略

### 8.1 Python adapter

- API schema/contract tests；
- auth、Origin、CORS、路径边界；
- session/turn/cancel/restore 幂等；
- Workspace/Project 契约：projectId 幂等解析、cwd 规范化与不可变、同名目录隔离、路径冲突拒绝、旧 cwd 唯一匹配回填；
- per-session Project Mode 隔离：同项目跨会话共享 project memory，不同项目并发不串 cwd/记忆，不写进程级全局激活锚；
- project 注销只清理 GA registry/junction/私域数据，绝不触碰真实 Workspace；
- event normalization 与 unknown.raw；
- Command Registry 发现、alias/冲突、参数 schema、权限、结构化结果和插件故障隔离；
- 声明式 Command Pack 加载/刷新及 Python Plugin 授权边界；
- Capability Registry 生命周期：installed/enabled/discoverable/loaded/invoked、global/project/session scope、稳定 capabilityId、secret reference 与权限变更审批；
- MCP Connector 契约：initialize、tools/list、tools/call、schema 转换、stdio/SSE/Streamable HTTP、取消/超时/重连、输出限额、脱敏与服务故障隔离；
- 命令引用 capabilityId、缺失能力返回 unavailable、命令不可绕过授权、卸载后不静默退化为 Prompt；
- Morphling 固化分类器/校验：Memory 不接收 endpoint、secret、完整工具 schema 或执行实现；调用型成果必须落到 Tool/Connector 与客观测例；
- Hook 事件顺序、ctx 读写语义、声明式 Hook 脱敏/超时/失败策略；
- Automation schedule/timezone/幂等、单实例触发、重启补偿和运行历史；
- secret redaction；
- 兼容指定 GA commit 的真实集成测试。

### 8.2 React

- DTO parser 和 event reducer 单测；
- snapshot + WS race、重复事件、乱序/断线；
- session/workspace 绑定；
- WorkspaceProject 稳定 projectId 透传、普通 cwd 会话降级、路径冲突修复 UI、隐藏/移除项目不误删 project memory；
- tool/ask_user/unknown event 渲染；
- Commands/Skills 分组检索、键盘选择、精确命令与同名冲突规则；
- 能力中心的分类、自然语言搜索、来源/owner、别名、用途/示例、最近使用、关联命令/能力、状态/scope/权限/健康展示、按项目启用、首次与高风险授权、按需 schema 加载；
- MCP Server 可展开导出 tools，按工具功能可反查所属 Server；旧“自定义工具”与 MCP Hub 入口迁移后不存在双重真相源；
- 自定义命令 owner、invocation、activation、requires_capabilities 展示及 unavailable/approval 状态；`/help`、收藏/最近使用排序与“查看全部能力”跳转可用；
- picker/form/table/job 等结构化命令结果渲染；
- Hooks/Automation 页面读取 GA snapshot、运行状态和错误的 reducer 测试；
- Bridge 不可用与重启恢复；
- 视觉回归：关键页面截图与改造前基线对比。

### 8.3 Rust/Tauri

- runtime discovery 与 manifest 兼容；
- 动态端口和 token；
- 子进程启动、超时、崩溃重启、精确终止；
- Windows 路径编码、空格、中文；
- 首启归档幂等。

### 8.4 端到端

使用可控 fake adapter 做确定性测试；另设真实 GA smoke test。核心 E2E 不依赖付费模型时，使用 fixture/replay；真实模型只作为发布前人工/受控门禁。

## 9. 提交与回滚策略

建议提交序列：

1. `chore: import liveagent baseline`
2. `docs: record ga integration decisions`
3. `feat(adapter): add versioned secure ga bridge`
4. `feat(tauri): supervise ga runtime`
5. `feat(ui): add typed ga bridge client`
6. `feat(chat): route sessions and turns to genericagent`
7. `feat(chat): map tool and ask-user events`
8. `feat(commands): add ga command registry and slash discovery`
9. `feat(commands): unify commands and skills composer`
10. `feat(capabilities): add registry and connector contracts`
11. `feat(mcp): bridge mcp servers as ga tools`
12. `feat(automation): bridge ga hooks and scheduler registry`
13. `feat(settings): map model profiles to genericagent`
14. `feat(hub): map skills memory and morphling outputs`
15. `refactor: remove legacy liveagent agent runtime`
16. `refactor: remove gateway and webui`
17. `feat(packaging): bundle pinned windows ga runtime`
18. `chore: rebrand and add notices`

每个 commit：

- 独立可构建；
- `git diff --check`；
- 运行对应最小测试集合；
- commit message 最后一行：`Co-Authored-By: GenericAgent <bot@gaagent.ai>`。

回滚单位是阶段 commit，不通过“同时保留旧内核并动态切换”回滚，避免双内核长期存在。

## 10. 主要风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| GA Bridge 当前事件粒度不足 | 工具轨迹/ask_user 不完整 | 先做真实事件采样和契约测试；adapter 保真 unknown.raw |
| React 旧 Agent 逻辑耦合深 | 容易残留双真相源 | 以 GaChatRuntimeHost 替换入口；Phase 6 全仓残留审计 |
| Gateway 删除面巨大 | 编译/发布链破裂 | MVP 后分组删除，每组构建与静态搜索 |
| localhost 被恶意网页访问 | 可触发高权限 Agent | token + Origin + CORS + CSP + 导航限制 + localhost-only |
| 密钥通过 API/日志泄露 | 严重安全问题 | write-only secret reference、统一 redaction、Memory/SOP/命令禁止明文配置、测试日志扫描 |
| MCP schema/transport 漂移或服务失联 | 工具调用错误、阻塞会话 | Connector 版本化转换、健康检查、超时取消、有限重连、unknown/raw 诊断与单服务故障隔离 |
| 把 MCP 实现塞入 Memory 或 `/命令` | 协议不稳定、上下文膨胀、权限旁路 | Memory 只存使用认知；Connector 执行协议；命令仅引用 capabilityId 并复用同一授权链 |
| 低频能力全部加载 | 工具 schema 挤占上下文并误选工具 | 摘要发现、按需加载、project scope 和显式启用状态 |
| Morphling 成果全部写入 Memory | 知道但无法稳定执行、实现与认知漂移 | 按知识/流程/执行器/入口/配置/测例分类固化并设验收门禁 |
| GA 上游更新破坏兼容 | 运行时突变 | 固定 commit/manifest，契约测试后随应用升级 |
| Python runtime 体积/杀软 | 安装失败或误报 | 最小依赖、签名、SBOM、干净 VM 测试 |
| 工作区与会话错配 | Agent 误操作目录 | session 创建时固定 cwd，UI 始终显示绑定目录 |
| 多会话共享进程级 cwd/active-project | 串项目、读写错误目录或记忆 | 每 Agent/任务显式 cwd，使用 per-session Project Mode，禁止全局激活锚作为长期状态 |
| 双 Workspace 真相源或项目身份漂移 | 同目录重复项目、同名目录误合并、记忆错绑 | LiveAgent WorkspaceProject 独占真实路径真相；稳定 projectId 绑定 canonicalPath；冲突显式修复，禁止静默重绑 |
| 项目注销误删用户工程 | 不可逆数据损失 | Workspace 移除与 GA 项目注销分离；只删除经验证的 registry/junction/私域记忆，绝不递归删除 junction 目标 |
| 旧数据归档含 secret | 数据暴露 | 原文件权限保留、日志不打印内容、归档 manifest 脱敏 |
| UI“看起来没变”但行为退化 | 用户体验不一致 | 关键流程视觉回归 + 交互验收清单 |

## 11. 明确不做

- 不保留 LiveAgent Agent Loop 作为备用内核。
- 不做 LiveAgent/GA 数据双向同步。
- 不迁移旧 Agent 会话和语义配置。
- 不保留 Gateway、Go、Browser WebUI 或远程控制。
- 首期不支持 macOS/Linux。
- 不在运行时自动更新 GA。
- 不把项目专用兼容逻辑直接堆入 GA 上游仓。
- 不让 LiveAgent 自动批准 GA 的 ask_user。

## 12. 开工前最后门槛

只有在用户明确确认本规划已达到共同理解后，才能开始源码改造。开工第一轮只执行 Phase 0，不直接进入内核替换；任何大于 3 个文件的批量删除，执行前另行提交精确删除清单确认（2026-08-06 用户再次确认该节奏，删除清单在 Phase 6 执行时提交）。

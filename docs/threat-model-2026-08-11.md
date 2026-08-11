# OzawaAgent 桌面端威胁模型（2026-08-11）

> **目的**：补足 Mimosa 深扫因 `scanner_enobufs` / `entryPoints=0` 未能生成入口清单的覆盖缺口；本文是对当前可追溯代码面的人工威胁建模，而**不是**“项目安全”的声明或完整渗透测试结论。
>
> **审阅快照**：`main` / 2026-08-11，Rust Tauri command registry 为 **142** 项；前端 typed GA bridge client 可见 **44 个 HTTP method/path 形态 + 1 个 WebSocket 端点**。Adapter 自己注册 29 个 HTTP 路由，其余由固定版本的官方 GenericAgent Desktop Bridge 提供。

## 1. 范围、方法与限制

### 1.1 本次覆盖范围

| 领域 | 已检查入口/证据 | 覆盖内容 |
|---|---|---|
| Tauri IPC | `crates/agent-gui/src-tauri/src/lib.rs:41-196` | `generate_handler!` 注册的 142 个 `#[tauri::command]`；命令输入、文件、Git、终端、SFTP、设置、自动化与生命周期边界。 |
| Tauri capability / WebView | `src-tauri/capabilities/default.json:1-15`、`src-tauri/tauri.conf.json:12-26` | main window 获得的 capability、CSP 配置、XSS 对本地能力的影响。 |
| GA supervisor | `src-tauri/src/runtime/ga_supervisor.rs:237-525`、`commands/runtime/ga_runtime.rs:7-62` | 随机 loopback port、bridge token 的产生、进程启动、token 返回给 WebView、origin allowlist。 |
| GA HTTP / WS bridge | `runtime/ga/ga_bridge_adapter.py:123-198, 2120-2948`、`src/lib/ga/GaBridgeClient.ts:54-403` | token / origin / loopback middleware、adapter-owned 路由、官方 bridge 继承路由、WebSocket 及敏感返回值处理。 |
| GenericAgent / MCP | `runtime/ga/runtime_manifest.json:1-83`、`runtime/ga/ga_bridge_adapter.py:1215-1364` | 固定上游来源、MCP connector 声明、stdio 子进程及 HTTP connector 边界。 |
| 工作区文件与 Git | `commands/workspace/fs.rs:352-451`、`commands/workspace/git.rs:561-624` | canonicalize、相对路径净化、symlink、用户选择 workdir 与 Git 子进程。 |
| 已有安全处置 | `docs/security-triage-2026-08-11.md` | Mimosa 的 CWE 分类、已修复/上游项与证据链。 |

### 1.2 不在本次可验证范围的部分

- `ga-runtime/` 是 gitignored 的 CI 暂存产物；当前工作树没有完整 GenericAgent 上游源码。可审的本地维护面是 `runtime/ga/ga_bridge_adapter.py` 和 `runtime_manifest.json` 中钉住的上游 commit `7083b937…`。
- 不包含运行中 Windows 进程、第三方 MCP server、模型供应商、用户工作区、用户安装 Skills / command packs 的动态行为测试。
- 不等同于网络渗透测试；loopback 服务、Windows token 泄露面、WebSocket 协议兼容性应在最终 Windows smoke 中实际复核。

### 1.3 方法

1. 以 `app_invoke_handler!` 的实际 `generate_handler!` 注册表为 IPC 单一事实源，而非仅搜索前端 `invoke()`。
2. 以 `GaBridgeClient` 的 typed 方法与 `ga_bridge_adapter.py` 路由注册为 bridge 单一事实源；按 **HTTP method + path template** 计数。
3. 对每个入口识别：调用者、可达资产、权限收敛控制、攻击前置条件和剩余风险。
4. 将“产品有意允许用户完成的高权限动作”与“未授权跨边界动作”分开标记；前者不是自动消失的风险。

## 2. 系统、资产与攻击者假设

### 2.1 进程与信任边界

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Tauri WebView（React / TypeScript；渲染不可信 repo、模型、MCP 内容）       │
│   ├─ Tauri invoke / event  ───────────────────────────────────────────┐ │
│   └─ HTTP + WebSocket（Bearer token 在 JS 内存） ────────────────────┐ │ │
└──────────────────────────────────────────────────────────────────────┼─┘ │
                                                                       ▼   │
┌─────────────────────────────────────────────────────────────────────────┐
│ Tauri Rust host                                                        │ │
│  142 IPC commands · SQLite · filesystem · Git · shell/SSH/SFTP         │ │
│  启动并监控 GA Python sidecar                                           │ │
└──────────────────────────────────────┬──────────────────────────────────┘ │
                                       │ Command::new(python, adapter, …)     │
                                       ▼                                      │
┌─────────────────────────────────────────────────────────────────────────┐
│ GenericAgent bridge，127.0.0.1:dynamic-port                              │
│  middleware: loopback peer + Origin allowlist + secret token              │
│  official bridge routes + 29 adapter-owned HTTP methods + /ws             │
│  MCP stdio/HTTP、agent model/tool/runtime                                 │
└──────────────┬───────────────────────┬────────────────────────────────────┘
               │                       │
               ▼                       ▼
       MCP connector/server      Model / provider / hook / external URL
       （用户配置的信任主体）       （用户或运行时选择的外部主体）
```

### 2.2 受保护资产

| 资产 | 主要位置 | 保密性 | 完整性 | 可用性 |
|---|---|---:|---:|---:|
| Provider API keys、custom headers | `~/.ozawaagent/config.sqlite`、GA model profile | 高 | 高 | 中 |
| SSH password / private key / passphrase | settings SQLite、SSH runtime | 高 | 高 | 中 |
| GA bridge bearer token | Rust supervisor 内存 + **WebView JS 内存** | 高 | 高 | 高 |
| 用户工作区、上传附件、Git worktree | 用户选择的 `workdir`、`~/.ozawaagent/uploads` | 高 | 高 | 高 |
| Chat history / subagent records / memory | SQLite、GA data root、Markdown | 中/高 | 高 | 中 |
| MCP connector config、Skills、Hooks、command packs | app data / GA root | 高 | 高 | 中 |
| 自动化定义与执行记录 | automation store、GA automation dir | 中 | 高 | 中 |
| desktop host 控制权 | Tauri IPC、shell、terminal、Git、sidecar | 高 | 高 | 高 |

### 2.3 需要考虑的攻击者

| 攻击者 | 能力 | 不假设的能力 |
|---|---|---|
| 恶意网页内容 / XSS | 在 Tauri WebView 中执行与 GUI 相同 origin 的 JavaScript；读取前端内存和发起 `invoke` / loopback 请求。 | 不能直接读 Rust 私有内存。 |
| 本机非特权进程 | 尝试连接 `127.0.0.1` bridge、读取用户可读文件、竞争动态端口。 | 不拥有当前用户进程内存或 token。 |
| 恶意仓库 / 文件 | 提供路径、symlink、Git 内容、Markdown、图片、large file、命令输出。 | 不天然被授予工作区外文件权限。 |
| 恶意或失陷的 MCP server / Skill / Hook | 返回恶意 tool 内容，诱导 agent，发起其已获许可的进程或网络活动。 | 不应绕过 connector / host 已施加的边界。 |
| 恶意模型输出 / 远端 API | 输出 prompt injection、工具调用建议、异常结构、泄密诱导。 | 不应被当作本地可信控制面。 |

## 3. 入口面清单

### 3.1 Tauri IPC：142 个命令

注册表在 `src-tauri/src/lib.rs:41-196`，Tauri capability 只绑定 window label `main`（`capabilities/default.json:3-13`）。下表按命令模块统计；这是审阅范围而非权限分级。

| 域 | 数量 | 注册命令组 | 典型高权限动作 |
|---|---:|---|---|
| App / system / tray / proxy | 24 | app 8、system 14、tray 1、`proxy_get_server_info` 1 | 选取/导入文件、读 Skills、写 debug JSONL、窗口与电源活动控制。 |
| Settings configuration | 8 | `settings_load_all`、各 `settings_save_*`、SSH patch / reset known host | 读写 provider、MCP、SSH、memory、agent 配置与凭据状态。 |
| History / subagent storage | 20 | chat history 12、subagent store 8 | 读写对话、segment、identity、run/message records。 |
| Workspace / Git / worktree / watch | 48 | filesystem 10、Git 33、worktree 4、workspace watch 1 | 读写删改 workspace，clone/fetch/pull/push/commit，外部文件管理器。 |
| Runtime / terminal / SFTP | 29 | GA start 1、managed process 4、terminal / SSH 17、SFTP 7 | 本地 shell、SSH interactive I/O、SFTP 读写/删除/传输、读取进程 log。 |
| Automation / Hooks | 13 | cron 10、hook 3 | 计划任务写入/立即执行、执行 shell script、执行 HTTP requests。 |
| **合计** | **142** | 所有项目均在 `generate_handler!` 显式注册 | 本地用户权限范围内的可组合高权限能力。 |

#### 高风险命令类别（非穷尽）

| 类别 | 命令例 | 当前收敛点 | 剩余风险 |
|---|---|---|---|
| 文件读写/删改 | `fs_read_editable_text`、`fs_write_text`、`fs_delete` | `canonicalize_workdir` 拒绝空值/相对 workdir；相对路径拒绝 root、`..`、prefix，existing target canonicalize 后必须仍在 workdir 内（`fs.rs:352-451`）。 | 用户可选择任意自己有权限的绝对 workdir；获得 Tauri IPC 的 XSS 因而等同获得该用户对所选目录的修改权限。 |
| Git 操作 | `git_clone_repository_start`、`git_commit`、`git_push`、`git_discard_all` | `Command::new("git")`、参数数组、超时、`GIT_TERMINAL_PROMPT=0`（`git.rs:574-624`）；repo-relative 路径有专门校验。 | Git remote / hook / repository content 都是用户配置或不可信输入；push 和 discard 有真实外部/破坏性影响。 |
| Shell / hook | `terminal_create`、`terminal_stream_input`、`hook_run_script` | hook 必须有 workdir，timeout clamp，cancel scope；仅 `OZAWAAGENT_` 前缀 context 环境变量会转发（`hook.rs:99-179`）。 | **设计上执行用户配置的脚本**；若 XSS、恶意 Skill 或 prompt injection 能驱动该路径，即为当前用户代码执行。 |
| 网络 / MCP / SFTP | `hook_run_http_requests`、`sftp_*`、`settings_save_mcp` | Hook HTTP client 与 MCP adapter 分开；SFTP 由显式 SSH host 配置。 | 外部地址、proxy、MCP HTTP server 和远端 SSH host 是信任边界；存在 SSRF / data egress 风险。 |
| 子进程与日志 | `ga_runtime_start`、`managed_process_read_log`、`system_read_skill_text` | GA supervisor 仅以参数数组启动固定 adapter；sidecar stdout/stderr 进入本地 log。 | log/skill 内容可能包含不可信文本或敏感上下文，渲染与 redaction 必须持续审查。 |

**调用者认证结论：**这 142 个 command 没有逐 command 的“用户/角色”认证层；安全前置条件是 Tauri 仅向受控 main WebView 暴露 capability。故 IPC 不是对 WebView 内恶意脚本的隔离边界。

### 3.2 GenericAgent bridge：至少 45 个前端可见端点形态

`GaBridgeClient` 在 `src/lib/ga/GaBridgeClient.ts:122-345` 调用的 endpoint 形态如下。

| 来源 | HTTP 端点数 | WebSocket | 主要能力 |
|---|---:|---:|---|
| 官方 Desktop Bridge（由 `official_module.create_app()` 注入） | 15 | `/ws` 1 | session list/create/read/update/delete、prompt/model/cancel/restore、services panel/log/start/stop、memory import。 |
| 本地 adapter 注册 | 29 | 0 | version/capability/health、session runtime、knowledge/memory metadata/token telemetry、model profiles、commands、hooks/conductor、automations、connectors/tool calls、morphling。 |
| **当前 typed client 可见合计** | **44** | **1** | **45 个 method/path 或 WS 入口形态**。`~50` 为架构层的四舍五入描述；未将当前工作树中不可用的完整上游源码推测为已审计端点。 |

Adapter-owned 路由注册表可逐项核对 `runtime/ga/ga_bridge_adapter.py:2919-2947`：

- 只读/观察：`/api/v1/version`、`capabilities`、`health`、`knowledge`、project memory status、token stats/history、model profiles GET、commands、command packs、hooks、conductor、automations GET、automation runs、connectors GET。
- 变更/执行：session runtime PATCH；model profile POST/PUT/DELETE/default；`commands/{id}/execute`；automation POST/PATCH/DELETE；connector tools/list 和 tools/call；morphling classify。
- 官方 bridge 继承面中同样含变更路径：`/session/new`、`/session/{id}/prompt`、model/cancel/restore/update/delete、`/memory/import`、`/services/start`、`/services/stop`。因此“bridge 只读”只能描述部分观察 API，**不能**作为全 bridge 的安全假设。

### 3.3 Tauri 事件面

Rust 向 WebView 广播的命名事件包括：

`app:action`、`app:action-feedback`、`global-shortcut:pin-changed`、`ga-runtime:status`、`terminal:event`、`terminal:stream`、`terminal:exit-requested`、`sftp:event`、`managed-process:changed`、`automation:cron-changed`、`automation:hooks-changed`、`automation:prompt-pending`、`automation:prompt-expired`、`workspace:activity`。

事件名定义/emit 点见 `src-tauri/src/lib.rs:23-29, 691-695` 及 `runtime/*`、`services/automation/store.rs`。事件 payload 应被视为可能含路径、terminal output、任务状态或不可信远端文本的展示输入，不可当作授权凭据。

## 4. 关键数据流与控制点

### 4.1 Settings 与密钥

```text
WebView Settings
  → Tauri settings_save_* / settings_apply_ssh_patch
  → ~/.ozawaagent/config.sqlite
  → GA model profile / terminal / MCP / provider 请求
  → external provider, SSH host, MCP or hook HTTP endpoint
```

- 前端 settings 类型确实承载 `apiKey`、SSH password/private key/passphrase（`src/lib/settings/index.ts:150-267`）；UI 的 `*Configured` flag 不能替代静态存储、OS ACL 或运行时最小暴露。
- 当前架构文本“普通 sync 不带真实 provider API key”（`docs/architecture/overview.md:27`）是有益约束，但本模型不把它扩大为“密钥绝不会进入 WebView / bridge”的保证；每条保存与 adapter profile 路径仍须具体验证。
- Adapter 的输出走递归 `redact()`：按敏感 key 名（`token`、`secret`、`password`、`api_key`、`private_key` 等）遮蔽，路径也替换为 `[REDACTED_PATH]`（`ga_bridge_adapter.py:84-120`）。Model profile 输出用 `api_key_configured` 表示状态而不返回 key（`ga_bridge_adapter.py:539-577`）。这是**响应泄露缓解**，不是 secret storage control。

### 4.2 WebView → bridge：最高风险边界

1. `ga_runtime_start` 由 Tauri command 向 WebView 返回 `{ baseUrl, token }`（`commands/runtime/ga_runtime.rs:7-62`）。
2. `GaBridgeClient` 将 token 保存在 JS 对象字段 `runtime`，每个 HTTP request 附 `Authorization: Bearer <token>`（`GaBridgeClient.ts:54-96`）。
3. Bridge 的 global middleware 要求 loopback peer、Origin allowlist 和常量时间 token 比较（`ga_bridge_adapter.py:145-177`）。
4. 因而，**在 WebView 执行任意 JavaScript（XSS / unsafe HTML / 不安全 preload 依赖）= 可读取 bearer token = 可作为桌面 GUI 对 bridge 发出已认证请求**。再加上 default capability 给 main window 的 `core:default`、`mcp-bridge:default`、`opener:default`，XSS 同时是 Tauri IPC 能力沦陷风险。

| 判定 | 风险等级 | 原因 | 当前处理 |
|---|---|---|---|
| **WebView 持有 bridge bearer token** | **最高** | token 是 bridge 完整权限的 bearer credential；XSS 可启动/修改 session、调用 connector tool、管理 automation/profile/service，并可结合 Tauri IPC 操作 host。 | 接受为当前桌面架构边界；发布前必须以 CSP、依赖审查、严格 markdown/HTML sanitizer、禁用不必要远程内容和 XSS regression 为第一优先级。不能把 loopback / CORS 当作对已执行 XSS 的补偿。 |
| token 被本机其他进程偷取 | 高 | token 只在 Rust 与 JS 内存中，不通过 URL；但同用户进程内存读取、恶意浏览器扩展式注入、log 泄露等仍是威胁。 | 每次新 runtime 产生两个 UUID 拼接的 64 hex 字符（256 bits；`ga_supervisor.rs:245-249, 795-802`）；不写进持久化配置；response `Cache-Control: no-store`。 |
| 跨站页面滥用 bridge | 中 | 浏览器 CSRF / CORS 与 loopback probing。 | loopback peer check；only allow `tauri.localhost`（debug 时增加 Vite origin）；origin 不允许即 403；实际请求要求 token。 |

### 4.3 Bridge `/ws` token 通道：需在 Windows 冒烟复核的契约差异

Adapter 只在 WebSocket upgrade 的 `Sec-WebSocket-Protocol` 中接受 `ga-token.<token>`，并优先接受 `Authorization: Bearer …`（`ga_bridge_adapter.py:128-142`）；middleware 对所有实际请求仍做该 credential 比较（`:165-175`）。其单元测试明确断言该 subprotocol credential 可用（`runtime/ga/tests/test_ga_bridge_adapter.py:954-965`）。

但当前 `GaWebSocketManager` **刻意不传 protocols**（`GaBridgeClient.ts:397-403`），注释称 server 不协商协议。浏览器 WebSocket API 无法像 fetch 一样设置 Authorization header；若 adapter middleware 覆盖官方 `/ws` 路由（当前 `app.middlewares.insert(0, security_middleware(...))` 显示它会覆盖），则这两个实现的契约存在可用性风险：WS upgrade 可能 401，或只在上游 bridge 存在未见的额外认证逻辑时可工作。

- 本文**不把“WS 已被 token 保护且客户端可用”写为已验证事实**。
- 最终 Windows smoke 应检查：WebSocket 是否升级成功、请求是否确实带可验证的 credential、token 是否没有出现在 DevTools/log/telemetry、断线后是否仍只把 WS 当 refresh hint。
- 安全目标不变：若恢复 `ga-token.<token>` subprotocol，token 会出现在本机协议头但不得进日志；若维持无 subprotocol，应实现并测试等效的认证协议。不能为修复可用性去掉 middleware token 校验。

### 4.4 Bridge → GenericAgent / MCP subprocess

```text
Authenticated bridge request
  → connector declaration from adapter-owned connector directory
  → stdio: allowlisted command + shutil.which + create_subprocess_exec(args)
  → HTTP: user-configured connector URL / headers
  → MCP server tool response → bridge → WebView rendering
```

- stdio MCP：connector name 有正则，transport 仅 `stdio` / `http`；stdio command 必须在 `MCP_STDIO_ALLOWED_COMMANDS`，并在 load 与 spawn 两次检查，`shutil.which` 解析，`asyncio.create_subprocess_exec` 参数数组且 **不经 shell**（`ga_bridge_adapter.py:1215-1280, 1293-1321`）。这是 CWE-78 #24 的实际修复控制；证据与复核记录见 [security triage](security-triage-2026-08-11.md) §7.1。
- MCP HTTP：用户为 connector 配置 URL / headers；这本身授予 outbound network 与敏感 header 发出能力。adapter 的 30 秒 / 最大响应与工具数限制能约束资源，不等同于 SSRF allowlist。
- MCP output、tool schema、command pack、model output 都是不可信数据。`redact()` 是输出泄露的第二道防线；前端渲染仍是 XSS 第一线。

### 4.5 Workspace / uploads → Rust filesystem / Git

- Workspace FS 接受用户选定 workdir 和相对路径，但会 canonicalize existing target 并检查 `starts_with(workdir)`，拒绝 `..`、absolute path、Windows prefix、`:`, platform reserved component（`fs.rs:352-451`）。这样防止不可信 repo 中 symlink / path traversal 越出**已选 workspace**。
- 新建目录/rename 还显式检验 symlink parent，测试覆盖越界 symlink（`fs.rs:4641-4665`）。
- Git command 使用参数数组和无交互 terminal prompt，但 `validate_git_workdir` 只要求目录存在（`git.rs:561-608`）。这是合理的“用户可以管理任意自己选择的 repo”产品模型，并非全局目录 allowlist。
- 因此，路径防护的承诺是“工作区边界内的路径净化”，不是“WebView 被攻破后不能修改用户的任何文件”。

## 5. 威胁、控制与剩余风险登记

| ID | 威胁路径 | 影响 | 现有控制/证据 | 剩余风险与处置 |
|---|---|---|---|---|
| TM-01 | 不可信 Markdown、MCP/tool output、Git text 或依赖漏洞造成 WebView XSS。 | token / Tauri invoke 被劫持；可扩展到工作区删改、shell/SSH、bridge command/connector 调用。 | loopback/token 只防 WebView 外部主体，**不防同 origin XSS**；capability 绑定 main window。 | **最高、接受但必须持续治理**：CSP 当前为 `null`，应在 release 前做 CSP 与 renderer injection 专项审查；所有 HTML/URL render path 需 sanitizer regression。 |
| TM-02 | 同机进程连接 loopback bridge 或浏览器跨站请求。 | session / profile / automation / connector 控制，敏感 metadata 读取。 | `127.0.0.1` peer check、origin allowlist、min 32 char token、`compare_digest`、no-store（adapter `:145-177`）。 | token 泄露后控制失效；不要记录 bearer / protocol header。 |
| TM-03 | `/ws` 认证协议与 client 不一致。 | 主要是事件流不可用；若以删除 auth 方式“修复”会变成未授权 bridge。 | Adapter 测试 credential 提取；client 有 WS unit test 但仅验证不传 protocol。 | **待 Windows smoke / 单测对齐**；只能通过携带安全 credential 或服务端等效认证修复。 |
| TM-04 | 恶意 repo 用 traversal / symlink 诱导 file API。 | 读写工作区外文件。 | canonical workdir、relative path sanitizer、existing target containment、symlink-parent 测试。 | TOCTOU 和新平台 path 语义需要持续测试；用户主动选择任意 workdir 仍是有意权限。 |
| TM-05 | 恶意 Git remote、Git hooks、submodule / clone 内容。 | 网络泄露、任意用户级命令、repo 破坏/错误 push。 | 参数数组、timeout、禁交互 prompt；UI 操作与 user-selected repo。 | Git hooks 是 Git 设计行为；external remote 与 hook 内容视为用户信任决策，破坏性操作需 UI confirmation。 |
| TM-06 | Hook / command pack / scheduled automation 执行未信任脚本或 HTTP。 | 本机代码执行、SSRF、长时间资源占用、数据外传。 | Hook workdir required、timeout clamp、cancellation、环境变量前缀；automation 有 store/scheduler 状态。 | **设计上的高权限执行面**；只有受审配置/明确用户动作可创建，日志/提示不得将敏感 context 回显。 |
| TM-07 | MCP stdio connector command injection。 | 子进程执行任意 executable。 | launcher allowlist、`shutil.which`、双重检查、`create_subprocess_exec` 无 shell。 | connector `args/env` 仍是用户给 allowlisted launcher 的输入；该权限应被视为用户配置的脚本执行。 |
| TM-08 | MCP HTTP / provider / hook URL 指向内网或 cloud metadata。 | SSRF、credential/header 外泄。 | 请求有 timeout/response bounds，adapter redacts response fields。 | **CWE-918 by-design / upstream-owned 面**：用户可配置 URL/proxy/MCP。对默认配置、云/企业环境需另做 egress policy / host allowlist 决策。 |
| TM-09 | Agent / upstream GenericAgent 处理 user/agent generated file paths 或 dynamic code。 | path traversal / code execution。 | 本仓库维护 adapter 对 connector spawn 的 fix；上游固定版本和 manifest 完整性校验。 | **CWE-22 / CWE-95 by-design 且多数为 vendored**；详见 triage §4.3 / §4.5。不要把静态 finding 等同于已修复或已可利用，应随上游版本评估。 |
| TM-10 | Settings SQLite、history、uploads、runtime log 在本机被读取。 | API/SSH key、private project content、token 或 prompt 泄露。 | 不把 GA token 持久化；bridge response redaction；app-local storage。 | 依赖 OS user-profile ACL；desktop app 无法防御同用户恶意进程。需要确保 debug log 与 UI error 不写入 secrets。 |
| TM-11 | 供应链：Tauri plugin、Python runtime、GenericAgent 上游、MCP/Skill bundle。 | 任意代码执行或 renderer compromise。 | runtime manifest 固定 official bridge SHA-256，并在 startup 验证（`ga_supervisor.rs:15-31`、adapter `verify_official_bridge`）；vendored staging 有 CI 编排。 | 39 项 vendored GA residual 只能上游修复；发布前执行上游评估并记录 commit / artifact hash。 |
| TM-12 | Tauri command/event 模型被误当作细粒度 authorization。 | 任意 XSS 执行 UI 有权 command，事件欺骗 UI state。 | command registry 显式、main window capability scoped。 | 无逐 command principal / policy，故 renderer integrity 是前提；敏感 event 只作 UI notification，后端必须自行验证所有 command input。 |

## 6. CWE 分类的边界说明

本节不改变 [security triage](security-triage-2026-08-11.md) 的 finding 状态，只说明为何这些类别在威胁模型中持续存在。

| CWE | 本产品中的边界 | 状态/解释 |
|---|---|---|
| CWE-22（路径穿越） | 文件、上传、Git/worktree、GenericAgent 的用户项目路径。 | Tauri workspace 相关路径已有 canonicalize/symlink 防护；GenericAgent 静态 findings 多为 pinned vendored 上游。用户授权 agent 读写 project path 是设计功能，不代表允许越出所选根。 |
| CWE-95（动态代码） | GenericAgent / tool/automation/command pack 的执行语义。 | 用户要求 agent 执行代码、hook 或 shell 是功能本体；不能靠“移除 eval 字符串”把授权执行面从模型中抹去。它应有显式 UI、审计、scope 和上游更新治理。 |
| CWE-918（SSRF） | provider base URL、proxy、MCP HTTP、hook HTTP、agent web capability。 | 用户配置远端 URL 是功能；timeout 不是 egress allowlist。企业/托管环境如需限制，应额外定义 destination / DNS / private-IP policy。 |
| CWE-78（OS command injection） | MCP stdio、Git、GA sidecar、shell/terminal/hook。 | Adapter `_mcp_stdio` 的 arbitrary launcher 路径已以 allowlist + resolved executable + no-shell 处置；terminal/hook 则是有意 shell execution，应由 renderer integrity 和 user intent 保护。 |

## 7. 必须保留的验证与发布前复核

### 7.1 已有回归证据

- Bridge adapter tests：`runtime/ga/tests/test_ga_bridge_adapter.py` 61 passed（包含 token minimum length、origin defaults、WS credential extraction、response redaction、stdio launcher allowlist）。
- Frontend suite：`pnpm test:frontend` 711/711 passed（包含 bridge client Authorization header / typed routes，以及 WS manager 的 duplicate handling）。
- Rust 侧的 workspace path tests 覆盖 relative traversal 与越界 symlink；`cargo check --tests` 应持续执行。
- 每次 commit 的 Mimosa hook 在本冲刺中仍报告 `scanner_enobufs`，因此不把 hook 放行表述成“完整扫描已通过”。

### 7.2 最终 Windows smoke（本模型新增安全观测项）

| 场景 | 操作 | 必须观察到 |
|---|---|---|
| bridge start | 打开 chat，触发 `ga_runtime_start`。 | 动态端口绑定 127.0.0.1；token 不出现在 UI、normal log 或错误 toast；health request 需要 token。 |
| bridge HTTP | 新建 session、stream、读取 profile / automation。 | `Authorization` 存在于 HTTP client；错误 envelope / console 不回显 API key、SSH key、token、真实 upload path。 |
| bridge WebSocket | 开 chat 后观察 events/reconnect。 | WS 要么按照 adapter contract 携带可验证 credential 并成功升级，要么明确显示/记录其等效机制；绝不以移除 token middleware 换取“可用”。 |
| renderer hostile content | 在受控 fixture 中显示带 HTML/URL/长 tool output 的模型或 MCP 文本。 | 无 script execution / Tauri invoke / bridge request 旁路；仅经过既有 renderer 安全策略呈现。 |
| filesystem / Git | 在含外链 symlink 的临时 workdir 测读写/rename/delete；测试 Git panel remote action。 | 越界路径被拒绝；合法 workspace 文件成功；Git 可用性回归不破坏 path guard。 |
| secrets | 保存 provider / SSH 设置后，查看 UI、bridge response 和 debug log。 | 仅显示 configured flag 或 `[REDACTED]`；无密钥值写入前端错误、automation log 或 bridge telemetry。 |

### 7.3 建议的下一轮工程项（不在本 WP 中改代码）

1. 对 `tauri.conf.json` 的 `csp: null` 制定可部署 CSP；把 renderer HTML/URL sink 清单、依赖审计和 XSS fixture 作为 release gate。
2. 用一个端到端测试钉住 `/ws` credential contract，统一 adapter test 与 `GaWebSocketManager` 行为。
3. 对 hook / command pack / automation 增加 source/provenance 展示、显式执行确认和可审计日志；对 HTTP outbound 制定产品级 allowlist / deny-private-network 策略（若产品目标包含企业或多用户场景）。
4. 将 Tauri 142 command 表按“read / write / execute / external network / destructive”生成机器可检验清单，并在新增 command 时要求 threat-model delta。
5. 在上游 GenericAgent 更新评估中重新审查 CWE-22/95/918 及 manifest pinned hash；不要以本地 adapter 修复替代上游审计。

## 8. 接受残留与结论

以下项目在当前质量加固冲刺中**有意保留并需要在 release checklist 引用**：

1. **WebView 持有 bridge bearer token**：这是当前架构的最高风险信任边界；XSS 即 bridge / Tauri capability compromise。
2. **39 个 vendored GenericAgent findings**：本仓库不能直接持续维护，需以固定上游 commit 的发布前评估处理。
3. **Mimosa scanner enobufs / entryPoints=0**：工具未给完整入口覆盖；本文件是人工补充，不能使扫描覆盖变为 complete。
4. **xterm `!important`**：第三方主题覆盖所需，已有局部注释；与本模型的安全边界无直接关系。
5. **高权限用户配置能力**：shell hook、MCP stdio/HTTP、provider URL、Git remote、SSH/SFTP 与 automation 都是功能性授权面；应以用户意图、可见性、path/network policy 和 renderer integrity 管控，不能通过静态扫描将其“消除”。

**结论**：当前产品最重要的安全前置条件不是“loopback bridge 只监听 localhost”，而是 **Tauri WebView 不被执行任意脚本**。Bridge 的 loopback/origin/token 三重检查有效地降低了外部和普通本机连接风险；一旦 renderer 被 XSS 控制，bearer token 和 Tauri capability 同时使该边界失效。后续 release 判断应将 CSP / XSS 防护、WS credential 对齐、Windows 实测和上游 GenericAgent 评估放在高于新增功能的优先级。

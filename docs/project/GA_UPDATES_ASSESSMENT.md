# GA 上游更新评估（2026-08-06，跟随最新策略依据）

背景：2026-08-06 用户确认 GA 内核**以官方最新为主**（原锁定早期 commit 51f7692 的策略废弃）。
本文档评估 `lsdefine/GenericAgent` 近期更新的可利用点与风险，作为 §3.1-26 跟随流程的参考。

## 结论

跟随最新**利大于弊**：近期更新集中在桌面流式稳定性、长会话体验、安全加固与 conductor/project mode 演进，与本项目桌面端定位一致；未发现破坏 adapter 契约面（desktop_bridge）的变更（bridge 仍为 HTTP+WS 同构契约，adapter `--check` 可验证）。

## 可利用点（按价值排序）

### 直接受益（经 bridge/内核自然获得）
1. **llmcore 稳定性**（7ffc958/5c3fc72/9355c22/a1e470b）：retry-after 上限防挂死、空 text block 丢弃防 HTTP 400、Responses API 终端事件处理、usage null-safe → 聊天流式更稳，OzawaAgent 无需改代码即受益。
2. **长会话渲染**（fb9ea53/a3a626a/b4597a0）：lazy-render 历史、非阻塞 fragment 流轮询、RUNNING 徽标、active model 显示 → GA 侧已修复长会话卡死类问题，桌面端通过 WS/状态同步获得。
3. **scroll-to-bottom**（b4aeb00/bd6eccd）：切换会话自动滚底。
4. **tmwebdriver 安全**（caa41dd）：移除 legacy DOM bridge、HTTP origin 防护 → 浏览器工具面收紧。

### 可跟进利用
5. **memory 演进**（8a75b39）：官方弃用 plan mode、索引 project mode → 与本项目 per-session Project Mode 方向一致，后续 Phase 6 清理时对照官方最新语义。
6. **desktop 细节**（277c485）：quick-access helper、trim factor → Phase 9 可选用。
7. **conductor 改进**（6bed654/022299a/7fede5a）：文件与运行时处理、chat 通知 → Phase 5 的 Conductor 只读视图可随之受益。
8. **reasoning effort max**（582168a/555d7bc/c8136d0）：Claude output_config.effort 映射 → 模型配置能力扩展。

### 明确不采纳
9. **hub/p2p**（7083b93/89a8ab7/41e1fce 等）：WS peer hub、phone pairing sidecar、composer → 与本项目"无远程能力"边界冲突（决策 4），默认不启用、不打包；仅保留本地面板类能力时另行评估。
10. **wechat conductor forwarding**（a1f7368）：IM 转发，桌面端不适配，跳过。

## 本地 fork 补丁（合并时必须保留）

`D:\GenericAgent` 相对官方 main 的本地修改（NewAPI 渠道白名单场景）：

- `llmcore.py`：codex_client 指纹可选化（originator/client_metadata 默认关闭，按会话开启；解决 NewAPI `client_restricted` 403）
- `mykey_template.py`：本地扩展（模板字段）
- `.gitignore`：忽略 `assets/tmwd_cdp_bridge/config.js`（CDP Bridge 密钥配置，首次运行自动生成）

每次 `fetch + merge 官方 main` 后须确认上述改动未被上游覆盖；若有冲突，以本地补丁为准并回归 NewAPI 渠道。

## 跟随流程（写入 implementation_plan.md §3.1-26）

1. `git -C D:\GenericAgent fetch origin`（代理：`-c http.proxy=http://127.0.0.1:7890`）
2. 确认本地补丁（llmcore/mykey_template/.gitignore）无冲突，`merge origin/main`
3. 跑 adapter 契约测试（`runtime/ga/tests`）+ 核心冒烟
4. 通过后更新 `runtime_manifest.json` 的 ga_commit 并提交
5. 发布打包前锁定该 commit 做最终回归（产物延后至 Phase 6/9 后，§3.1-24）
## 2026-08-06 复核（force-push 事件，第二轮跟随）

**事件**：官方 `main` 被 force-push 改写。旧 main 顶 `d69ec88`（该线独有 1154 提交，含 adapter 曾锁定的 `51f7692`、release desktop portable v0.1.8、`277c485` quick-access、`d69ec88` trim factor）→ 新 main 顶 `7083b93`（hub/p2p/phone pairing 线）。本地 `D:\GenericAgent` HEAD=`7083b93` 恰为新 main 顶，`behind=0`，无需 merge；本地 3 补丁（llmcore/mykey_template/.gitignore）在，无冲突。

**影响与动作**：
- adapter 锁定 commit `51f7692` 已不在官方历史（dropped）→ `runtime_manifest.json` 更新：`ga_commit=7083b9377eb4c4d6657f9dc61b80296cbcd2143a`、`official_bridge.sha256=94df8539...`（新线 bridge，2210 行，相对 51f7692 版仅新增 `/subscription-portal` GET/POST 路由与 `start_subscription_portal`；adapter 复用官方 `create_app` → 新端点透明继承且受 token 保护，`capabilities` 不声明 = 前端不暴露，保守正确）
- 验证：临时组装副本 `--check` → `compatible`✅；`runtime/ga/tests` pytest 61 passed / 2 skipped✅（契约无回归）
- 发布态副本 `crates/agent-gui/src-tauri/ga-runtime/`（gitignore 排除、release CI 组装）同步刷新 29 个同名文件（bridge/adapter/llmcore/agentmain 等）+ 新 manifest，`--check` → `compatible`✅
- 新 main 线独有 hub/p2p、desktop pet v2、im plugins 等新功能；上文可利用点除 `277c485`/`51f7692`（dropped）外均在新线

**遗留提示**：开发态若将 `--ga-root` 直指 `D:\GenericAgent`，因其根目录无 `runtime_manifest.json`（manifest 是 stager 组装物）会启动失败；是否在 `D:\GenericAgent` 根放置 manifest 由用户定夺，Phase 9 打包流程统一处理。

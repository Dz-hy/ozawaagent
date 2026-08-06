# OzawaAgent — 项目总览

> 本文档是项目随仓库发布的权威总览；实施细节与决策基线见同目录 `implementation_plan.md`，审核结论见 `merged_review_report.md`。

## 是什么

**OzawaAgent** 是「LiveAgent（Stack-Cairn，2026）UI 外壳 × GenericAgent（lsdefine，2025）Agent 内核」的桌面端二开产品：

- 保持 LiveAgent 的视觉、布局与主要交互；React 只做状态与调用逻辑适配，不承载第二套 Agent Loop。
- Agent 语义（模型配置、会话历史、Skills/SOP、Memory、子 Agent、定时/长期任务）**全部以 GenericAgent 为唯一真相源**；LiveAgent 页面仅作适配视图。
- 纯桌面能力（工作区、文件树、Git、终端、窗口、托盘、主题/i18n）继续使用 LiveAgent 原生（Tauri/Rust）实现。
- 已删除/不保留：Gateway、Go 服务、Browser WebUI 与远程控制能力。
- 首期平台：Windows 10/11 x64；macOS/Linux 待 Windows 稳定后评估。
- 许可：双 MIT（LiveAgent © 2026 Stack-Cairn / GenericAgent © 2025 lsdefine），About/NOTICE 与源码分发中保留来源说明。

## 架构

```text
OzawaAgent React UI (React 19 + TS + Vite)
  ├─ 纯桌面能力 ──Tauri invoke──> LiveAgent Rust services
  └─ Agent 语义 ──HTTP/WS──> runtime/ga/ga_bridge_adapter.py（防腐层）
                              └─ import/wrap 官方 frontends/desktop_bridge.py + GA core
```

- `ga_bridge_adapter.py` 是稳定防腐层：强制 127.0.0.1、高熵令牌、Origin 校验、动态端口、脱敏、类型化版本协商。
- Tauri 侧 `GaRuntimeSupervisor` 负责 sidecar 启停、健康检查、日志、崩溃恢复与 runtime 路径。
- 每个 GA 会话固定绑定一个 workspace/projectId；per-session Project Mode 是项目记忆唯一真相源。

## 决策基线（26 条，2026-08-06 修订）

完整清单见 `implementation_plan.md` §3/§3.1。要点：

1. Agent 语义 GA 唯一真相源，禁止双库双内核。
2. 开发态连 `D:\GenericAgent`（本地 fork，跟随官方最新 main，保留本地补丁）；发布态内置独立 Python+GA runtime 并支持外部 GA 路径覆盖。
3. 发布版本锁定"最近一次通过 adapter 契约回归的官方 commit"写入 runtime manifest；不在运行时自动更新。
4. 品牌 OzawaAgent；GitHub 公开仓库（Dz-hy）。
5. 审核 P1×6 以独立补丁推进（P1-B→A→E+D→C+F），不并入 Phase 6。
6. Phase 6 批量删除清单执行时提交并请求用户确认。
7. 最终安装包等产物延后至 Phase 6/9 完成后统一构建；安装态验收纳入 Phase 9 强制门禁。

## 阶段进度（2026-08-06）

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 基线/可回滚/依赖图 | ✅ 完成（1259 文件 SHA-256、22 ADR） |
| 1 | Bridge 契约与安全骨架 | ✅ 完成（ga_bridge_adapter） |
| 2 | Tauri GA runtime supervisor | ✅ 完成 |
| 3 | React 类型化客户端与会话骨架 | ✅ 完成 |
| 4 | MVP 垂直聊天切片（聊天/工具/提问/命令） | ✅ 完成（含 Command Pack/Plugin） |
| 5 | 高阶 GA 页面适配（profiles/projectId/skills/memory/token/conductor/automation/hooks/capabilities/MCP/Morphling/services/command packs） | ✅ 全部闭环 |
| 6 | 旧内核与远程模块拆除 | ⛔ 未开始（执行时提交删除清单确认） |
| 7 | 旧数据归档与首启迁移 | ✅ 完成（只读归档，不迁移会话） |
| 8 | Windows 内置 runtime 与安装包 | 🟡 打包链完成；最终产物延后（§3.1-24） |
| 9 | 品牌/文档/发布门禁（含安装态验收） | ⛔ 未开始 |

## 目录导览

- `docs/project/` — 本目录：规划、阶段 TODO、审核报告、总览
- `runtime/ga/` — Python 防腐层 adapter、契约测试、runtime manifest、命令扩展样例
- `crates/agent-gui/src/lib/ga-bridge/` — React 类型化客户端/WS/事件适配
- `crates/agent-gui/src/pages/.../Ga*Section.tsx` — 改接 GA 的设置页
- `crates/agent-gui/src-tauri/src/...` — Rust sidecar 主管/workspace/归档等

## 已知遗留与下一步

- 审核 P1×6 独立补丁修复（详见 merged_review_report.md）
- Phase 6 旧内核/Gateway 全量拆除（删除清单届时确认）
- Phase 9：OzawaAgent 品牌落地（productName/标识/协议目录）、README/架构文档、安装态验收、双 MIT 声明
- GA 开发态跟随官方最新（合并节奏见 implementation_plan.md §3.1-26）

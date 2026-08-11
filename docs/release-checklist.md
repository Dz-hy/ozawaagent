# 发布检查清单（Release Checklist）

> 基线: 2026-08-08，main @ ce9fa68a 后。本清单用于每次发布前的门禁核验与发布流程指引。

## A. 静态门禁（每轮提交前本地跑，全绿才 commit）
- [x] `pnpm lint`（biome，0 error；注意 max-diagnostics=20 会截断输出，长报告读尾部/显式加 --max-diagnostics）
- [x] `pnpm exec tsc --noEmit` 0 错误
- [x] `pnpm build`（vite 生产构建）
- [x] `pnpm test:frontend --run` 全绿（settings/chat/debug/memory/providers/subagents/tools/i18n/skills/context-menu/system）
- [x] `pnpm test:release --run`（后端 release 契约）
- [x] `git diff --check` 无空白错误

## B. CI（push 后盯 GitHub Actions 全绿）
- [x] GUI（Vite + 前端测试）
- [x] Tauri Rust Check（cargo clippy/check）
- [x] Diff Hygiene（PR/提交卫生）

## C. 产品验收（已闭环项，发布前复核）
- [x] Phase 0-3：依赖图/骨架/Rust shell/GA 侧线确定性启动
- [x] Phase 4：Provider 配置闭环（3 问见 phase4_task11_provider_notes，PUT/PATCH 待拍板）、ask_user 竞态修复（#327系已移植）、命令注册表
- [x] Phase 5：13 项全部闭环（mirror 90%→80%、SKM→DeclarativeSkills 等，见 phase5_todo.md）
- [x] Phase 6：gateway 拆除收官（残留分类见 phase6_final_report.md）
- [x] Phase 9 标识：rebrand 全仓 5 项 + 镜像同步注释 + 文档轮（08-07 6 commits）
- [x] 托盘：P1/P2/P3 完成，自动化布局任务 1/2 toast 回归于 1c799f2b，托盘协议模型优化 5e46be42
- [x] 合规：LICENSE(MIT Stack-Cairn) / NOTICE（双 MIT 声明）/ package.json+Cargo license=MIT
- [x] 31 commits 全带 Co-Authored-By footer，main==origin 同步

## D. 发布步骤（tag 流程）— ⛔ 首发需用户显式确认

> **红线（2026-08-08 用户指令）**：没有 Dz-hy 的确认，**禁止创建第一个正式版本**（v1.x 正式版 / 首个生产 Release）。
> 任何 tag 创建、GitHub Release、产物对外分发，必须先经用户明确批准后再执行。
> 开发期产物（0.0.0-dev、本地 build）不在此限，仅供内部验证。

1. 本地全门禁绿 → push main → CI 3/3 绿
2. `git tag vX.Y.Z`（Cargo.toml version 由 tag workflow 覆盖 0.0.0-dev 占位）— **执行前向用户确认**
3. `pnpm tauri build`（Windows 桌面产物；GA 运行时以 GA-local sidecar 分发，不进仓库）
4. GitHub Release + changelog（README zh-CN/en 对齐）— **执行前向用户确认**
5. 产物安装冒烟：首启托盘、Provider 配置、chat 回合、工具调用、面板、重启恢复

## E. 发布前遗留（已知非阻塞，按序消化）
- [x] P4 Task11 问2：model-profiles 更新语义 PUT（官方契约）——2026-08-08 拍板 A（client 64f0ae94 + 真源 97fcaf3f + 测试对齐）已落地
- [x] P6 文档层：docs 内旧 gateway 实战词条（operations/development.md 两节）已清理（2026-08-09）；本地非仓库规划文档（C:\Users\DZHY\git-repository\GA）另行处理
- [x] Phase 7（旧数据归档与首启迁移）：**已取消**（2026-08-08 用户拍板：全新 Agent，无旧内核 LiveAgent 用户，不做旧数据迁移；旧内核数据原样不动，GA 新数据天然隔离）
- [x] Phase 9 剩余-Hive 可视化：**判定闭环**（2026-08-09）——官方 `/hive` 仅为提示词入口（build_hive_prompt→Goal Hive 多 worker 模式），无独立状态端点；多 Agent 运行态已由 GaConductorSection（ga.conductor.v1 快照：subagents/messages/counts）覆盖，按"不建第二真相源"原则不新增专用端点
- [x] Phase 9 剩余-高级 Hook 编辑：**判定闭环**（2026-08-06 P5.8）——官方 plugins/hooks.py 为纯内存注册表（无编辑/持久化/超时语义），保留只读快照入口，不建编辑面
- [x] 质量加固冲刺（2026-08-11）：Biome 104 → 0 warnings；Remote/Gateway residue 移除；死 i18n 键经模板感知 census 清除（833 键/locale，1666 行）；Tauri/GA bridge threat model 见 [`threat-model-2026-08-11.md`](threat-model-2026-08-11.md)。对应提交 `f26a0ead`–`0dfafde8`、`baf46f9b`、`3ccaad87`、`d4189da7`。
- [x] Phase 6 最终删除复核（2026-08-11）：`crates/agent-gateway/` 和 `railway.json` 已分别由 `f9224d4a` / `ce9fa68a` 删除；HEAD、工作树及 live-reference 检查均为 0（本地 ignored 的 `docs/project/phase6_final_deletion.md` 保留完整命令输出与物证）。
- [ ] 接受残留（发布引用，非“已安全”结论）：39 个 vendored GenericAgent findings（仅上游可修）；Mimosa `scanner_enobufs` / `entryPoints=0`（人工 threat model 已补，但扫描仍不完整）；`src/index.css` xterm `!important`（第三方主题覆盖，已注释）；WebView 持有 bridge bearer token（**最高风险边界：XSS = bridge/Tauri capability compromise**）。
- [ ] Phase 9 剩余-发布态受控安装：**保持后置**（2026-08-09 用户指示先不构建产物；放开后按 Phase 8 安装验收矩阵执行）
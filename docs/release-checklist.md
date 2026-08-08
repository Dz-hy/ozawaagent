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
- [ ] P4 Task11 问2：model-profiles 更新语义 PATCH（现状） vs PUT（官方契约）——见 phase4_task11_provider_notes.md，等用户拍板后 2 行改动
- [ ] P6 文档层：implementation_plan/dependency-map 中旧 gateway 历史词条，随文档重构轮清理
- [x] Phase 7（旧数据归档与首启迁移）：**已取消**（2026-08-08 用户拍板：全新 Agent，无旧内核 LiveAgent 用户，不做旧数据迁移；旧内核数据原样不动，GA 新数据天然隔离）
- [ ] Phase 9 剩余功能面：Hive 可视化、高级 Hook 编辑、发布态受控安装（规划后置项）
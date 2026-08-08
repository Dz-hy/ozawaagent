# OzawaAgent 架构文档

本文档树用于从当前代码实现出发，系统梳理 OzawaAgent 的桌面 GUI、Tauri 后端与 GenericAgent 运行时。`docs/` 定位为全局架构索引；仓库已有的 `doc/` 仍保留为历史方案、专项设计与实验文档，不在本次整理中迁移或改名。

## 项目一句话

OzawaAgent 是一个以桌面端为本地执行核心的 Agent 应用：React GUI 负责用户体验与本地工具展示，Tauri/Rust 负责系统能力与持久化，GenericAgent 运行时负责模型调用、工具执行、Skills/SOP 与 MCP Connector 生命周期。

## 文档目录

| 文档 | 覆盖范围 | 推荐读者 |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | 系统总览、进程边界、数据流、持久化地图 | 新接手项目者 |
| [architecture/gui.md](architecture/gui.md) | 桌面 GUI、Tauri commands/services/runtime、设置与本地执行 | 前端与桌面端开发 |
| [features/chat-runtime.md](features/chat-runtime.md) | 对话运行时、GA bridge、模型层、流式、hooks、上传与重发 | Chat 功能开发 |
| [features/tools.md](features/tools.md) | 工具目录与执行边界、MCP 管理工具 | 工具系统开发 |
| [features/memory.md](features/memory.md) | Memory 目录与索引、automation（hook/cron）、GA memory 桥接 | 记忆系统开发 |
| [features/skills-and-mcp.md](features/skills-and-mcp.md) | Skills root/builtin/ClawHub 与 MCP registry/runtime | Skills/MCP 开发 |
| [features/history-compaction.md](features/history-compaction.md) | 历史分段、FTS、分享、上下文压缩 checkpoint | 历史与上下文开发 |
| [operations/development.md](operations/development.md) | 本地开发、构建、测试 | 日常开发 |
| [operations/deployment.md](operations/deployment.md) | CI、跨平台 Release 发布链路 | 发布维护 |
| [reference/source-map.md](reference/source-map.md) | 按功能域列出的源码路径索引 | 快速定位源码 |
| [project/implementation_plan.md](project/implementation_plan.md) | LiveAgent × GenericAgent 二开主规划与阶段状态 | 项目推进 |
| [project/PROJECT_OVERVIEW.md](project/PROJECT_OVERVIEW.md) | 产品总览与目标 | 项目交接 |

## 架构阅读顺序

| 顺序 | 目标 | 文档 |
|---:|---|---|
| 1 | 先建立整体进程和边界模型 | [architecture/overview.md](architecture/overview.md) |
| 2 | 理解桌面端为什么是执行真相源 | [architecture/gui.md](architecture/gui.md) |
| 3 | 按功能域深入 Chat、Tools、Memory、Skills/MCP、History/Compaction | `features/` |
| 4 | 需要动手时查运行命令和源码索引 | [operations/development.md](operations/development.md)、[reference/source-map.md](reference/source-map.md) |

## 当前实现的核心边界

| 边界 | 当前结论 |
|---|---|
| Agent 执行位置 | GenericAgent 托管运行时（桌面 GUI 经 GA bridge 提交 prompt；模型调用、工具、MCP、Skills、Memory 均在其内部）。 |
| Tauri 职责 | 本地权限边界：设置/历史/自动化/工作区/上传等命令，GA 运行时 supervisor 启停与进程管理。 |
| GUI 职责 | 对话 showcast、Settings、Skills/MCP Hub、历史与记忆只读展示；不维护本地 Agent runtime。 |
| 设置 | GUI load/save 设置到本地 SQLite，普通同步不带真实 provider API key。 |
| 历史 | GUI/Tauri 持久化 chatHistory 到本地 SQLite，History 侧边栏与子代理记录经 Tauri 命令读写。 |
| 存储位置 | `~/.ozawaagent/`（设置、历史、Memory、Skills、默认项目）。 |
| 文档来源 | 本文档基于当前 checkout 的源码路径、入口文件与运行脚本整理。 |

## 与 `doc/` 的关系

| 目录 | 定位 |
|---|---|
| `docs/` | 当前实现的全局架构说明、模块地图、运行说明和源码索引。 |
| `doc/` | 既有专项文档与历史设计资料（含 Gateway 时代的设计草案）。 |

后续如果某个专项文档已经稳定成为当前实现的一部分，可以在 `docs/` 中建立摘要与导航，但不建议把 `doc/` 直接重命名为 `docs/`，以免丢失历史上下文。
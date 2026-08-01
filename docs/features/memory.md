# Memory 系统

## 当前所有权

GenericAgent 是 Agent Memory 的唯一真相源。桌面 GUI 不维护第二套聊天记忆库，不向主对话注入旧 LiveAgent Memory overview，也不在 turn 结束后运行本地提取控制器或在 App shell 启动 organizer。

| 能力 | 当前实现 | 边界 |
|---|---|---|
| Memory catalog | `src/pages/settings/GaMemorySection.tsx` → `GaBridgeClient.getKnowledgeCatalog()` | Settings 只读展示 GenericAgent 声明的 memory layers。 |
| Project memory status | `GaBridgeClient.getProjectMemoryStatus()` → `/api/v1/projects/{project_id}/memory-status` | 侧栏展示绑定项目的 memory 可用性、行数与更新时间。 |
| Memory 内容与路径 | GenericAgent runtime | 不经 GUI 返回；Settings 明确不运行本地 database、extraction engine 或 organizer。 |
| 主对话召回/写入 | GenericAgent session/runtime | LiveAgent 只映射权威 session snapshot，不注册 `MemoryManager`。 |

## 已断开的旧入口

以下旧 LiveAgent 入口已经从生产接线移除：

- `ChatPage` 不再导入或调用 `memoryExtraction`。
- `App` 不再挂载 `MemoryOrganizerHost`。
- Settings Memory 已由 `GaMemorySection` 取代旧 `MemoryPanel`。
- 主对话工具注册表已经退役；MemoryManager 由 GenericAgent runtime 负责，GUI 不再保留旧 Memory 工具执行器。

本轮先删除了因此失去生产消费者的 `src/lib/chat/memory/extractionController.ts` 与 `src/components/memory/useMemoryOrganizer.ts`；后续切片又删除了完整的旧 extraction engine 闭包（`extractionEngine.ts`、`extraction/context.ts`、`extraction/planTool.ts`、`prompts/extraction.ts`）及其专属行为测试。`ga-automation-ui-contract.test.mjs` 继续约束 `App`/`ChatPage` 不得恢复这些接线。

## 尚存的旧 LiveAgent Memory 闭包

仓库仍保留下列历史实现，供后续按依赖闭包分批清理；它们不得被视为当前 Agent Memory 真相源：

| 闭包 | 主要路径 | 当前状态 |
|---|---|---|
| organizer service | Desktop `src/lib/memory/organizer/service.ts` 已删除；WebUI 仍通过 legacy panel 使用其自身支撑路径 | App shell 不再运行本地 organizer；桌面残余 organizer helpers 需按后续孤儿闭包继续审计。 |
| legacy Settings panel | Desktop `src/pages/settings/memory/*` 已删除；WebUI 对应目录仍保留 | 桌面 Settings 仅使用 `GaMemorySection`；WebUI legacy panel 仍在线，待独立迁移后再清理。 |
| Rust MemoryStore / commands | `src-tauri/src/services/memory/*` | 旧本地持久化能力尚在仓库中，但不拥有当前 Agent Memory 语义。 |
| Gateway/WebUI memory mirror | `scripts/mirror-manifest.json` 登记的 memory 文件 | Gateway/WebUI 保留当前 MemoryStore 契约；桌面侧旧 API/config/schema/prompt 副本已删除，镜像登记已解除。 |

本轮又删除了无 GUI 生产消费者的桌面 `lib/memory/api.ts`、`config.ts`、`prompts/injection.ts` 与 `prompts/shared.ts`，以及对应的旧契约测试；Gateway/WebUI 的 Memory 真相源与 Rust 契约未改动。

## 后续清理纪律

1. 先从生产入口生成静态 import/调用图，再按闭包删除；共享 Memory、Gateway bridge 与桌面能力分属不同失败半径，分别验证。
2. 涉及 `scripts/mirror-manifest.json` 的文件必须同步处理 desktop/WebUI mirror 和镜像测试。
3. Rust MemoryStore、Gateway bridge 与 Settings mirror 属不同失败半径，分别提交并独立验证。
4. `docs/phase0/*` 是历史快照，保留当时路径与哈希，不随当前源码删除改写。

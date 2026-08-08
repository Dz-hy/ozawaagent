# Chat Runtime 架构

## Execution Mode

GUI 仍可保留 execution mode 作为界面与兼容设置，但它不再选择本地 `text`/`tools` 执行器。所有主对话统一经 `useSendChatTurn` → `runGaChatTurn` → `GaBridgeClient` 提交给 GenericAgent runtime；实际模型、Skills/SOP、工具与子 Agent 能力由 GenericAgent session 决定。

## 主流程

| 步骤 | 说明 | 关键模块 |
|---:|---|---|
| 1 | 收集用户输入、附件与当前 conversation id，并确保 GenericAgent bridge/runtime 可用。 | `ChatPage.tsx`、`ChatComposerBar.tsx`、`useSendChatTurn.ts` |
| 2 | 通过 `promptSession` 向 GenericAgent session 提交 prompt。 | `runGaChatTurn.ts`、`GaBridgeClient.ts` |
| 3 | 订阅 bridge event 作为低延迟刷新提示，同时轮询权威 HTTP session snapshot；WebSocket payload 不是消息真相源。 | `runGaChatTurn.ts`、`GaBridgeClient.ts` |
| 4 | 将 GenericAgent message snapshot 映射成 `ConversationViewState`，更新 transcript、tool card、状态和错误。 | `gaMessages.ts`、`conversationState.ts` |
| 5 | turn 到达 `idle`/`error` 后停止观察；标题与侧栏等适配功能通过 GA bridge 的对应 API/状态继续更新。 | `useSendChatTurn.ts`、`conversationTitleJob.ts`、`gaSidebarBackend.ts` |

## 模型与工具所有权

GenericAgent runtime 是主对话的唯一 Agent 语义真相源，负责模型配置、上下文组织、工具 schema、工具执行、Memory、Skills/SOP 与子 Agent。GUI 的 provider、旧 runner 和工具 bundle 代码不再是主对话入口；仍存留的模块只可用于尚待清理的后台闭包或 UI 兼容展示。

## 对话状态

| 状态 | 来源 |
|---|---|
| messages / tool calls / tool results | GenericAgent session HTTP snapshot，经 `gaSnapshotToConversationState` 映射。 |
| running / idle / error | GenericAgent session status；bridge event 仅触发提前刷新。 |
| attachments / composer draft | GUI 输入层；发送时归一为 GA prompt request。 |
| tool catalog UI | `builtinToolCatalog.ts` 仅为展示数据，不是 executor registry。 |

## 上下文压缩

| 触发点 | 作用 |
|---|---|
| pre-send | 发送前估算上下文，超预算时先压缩旧历史。 |
| mid-stream | 流式或工具链路中发现预算不足时中断式压缩。 |
| post-tool | 工具调用后上下文膨胀，进入下一轮前压缩。 |

压缩产物以 summary checkpoint 写入新的 history segment。UI 中会显示上下文检查点，后续请求把 summary 合并进 system prompt，并只携带未覆盖的消息窗口。

## Hooks 生命周期

GenericAgent Hooks 是主对话 hooks 的真相源。GUI Settings 提供只读观察视图，通过 GA bridge 读取 hook 定义、事件与 diagnostics；GUI 不再创建、编辑或执行旧桌面 shell/HTTP hooks。

## 上传与重发

| 能力 | 语义 |
|---|---|
| 文件上传 | 仅在 tools 类模式可用；文件暂存在 `~/.ozawaagent/uploads`（工作区外，启动时按 30 天时效 GC），模型通过绝对路径以只读方式访问。 |
| 图片预览 | GUI/WebUI 都支持用户附件、Image 工具图片和 inline tool result 图片预览。 |
| 编辑重发 | 从目标 user message 处 truncate 后重发，保持历史语义与 GUI/WebUI 一致。 |
| 附件-only 重发 | 支持仅靠已有附件重新发起请求。 |

## 交互式提问（AskUserQuestion）

| 能力 | 语义 |
|---|---|
| 工具形态 | chat-only 内置工具；模型一次最多提 4 个问题，每题 2-6 个选项且**同轮各题选项数一致**，至多一个"推荐"项且**固定排在首位**。 |
| 挂起语义 | `execute` 在工具挂起表（toolCallId 键）上等待；用户提交后 resolve，停止按钮经 AbortSignal 以"未应答"落定（`details.cancelled`）；**3 分钟未作答按推荐项（缺省第一项）自动落定**（`details.timedOut`），卡片展示倒计时。**倒计时双端同源**：桌面端在网关上报的工具参数上盖 `__askUserQuestionDeadlineAt` 权威截止时间戳（`gatewayToolPreview` 统一盖章，execute 复用同一预置值），WebUI/重连场景按真实剩余时间倒数。 |
| 卡片 UI | `components/chat/AskUserQuestionCard.tsx`（双端镜像）负责兼容渲染问题、选项与已落定结果；提问何时完整出现以及工具执行生命周期由 GenericAgent session snapshot 决定。 |
| 双端应答 | GUI 直接调用 `answerAskUserQuestion`；WebUI 走 `chat_queue.tool_answer`（item_id=toolCallId，request_json=选择数组）由桌面端落到同一挂起表，协议零改动；远端应答**校验 conversation_id 与挂起提问所属会话一致**，防串会话应答。 |
| 结果回模型 | 标准 `ToolResultMessage`：content 列出每题的最终选择，`details.kind = "ask_user_question"` 驱动历史回放渲染。 |

## 运行态可观测性

| 内容 | 位置 |
|---|---|
| Usage | assistant round 的 token usage，agent-dev 更明显。 |
| Tool trace | `AssistantBubble` 中按 round 和 group 展示工具调用/结果。 |
| Hosted search | Search block 进入 transcript，保留 anchor 与聚合状态。 |
| Debug JSONL | `system_append_debug_jsonl` 可写入本地 debug 日志。 |
| Gateway stream | WebUI 可看到 token/thinking/tool/done/error 等远程事件。 |

# LiveAgent 源码审核整合报告（三轮合并 · 2026-08-06）

基线：`<repo>@3e815fe` + 工作树 16 个未提交修改文件
来源：
- 审核#1：提交 `95b69ed`（模型配置管理）专项审核（与父提交比对，只读，未读密钥）
- 审核#2：16 个工作区改动专项审核（Verdict: CONDITIONAL）
- 审核#3：全项目源码终审（本轮，只读源码、未构建产物）

---

## 一、统一严重度汇总

| ID | 严重度 | 归属 | 主题 | 来源 |
|----|--------|------|------|------|
| P1-A | P1 | 95b69ed | 模型配置写入非事务性（假失败/真变更，重试可重复创建） | #1+#3 |
| P1-B | P1 | 95b69ed | Proxy 脱敏只处理 userinfo，path/query/fragment 凭据进 DOM | #1+#3 |
| P1-C | P1 | 删除逻辑（存量）+ 工作树修复不完整 | 删除模型后索引型引用漂移：会话 llm_no 未重映射 | #1归责+#3实证 |
| P1-D | P1 | 16文件工作树 | 控制命令返回的权威 session runtime 在前端最终消费处被丢弃 | #2+#3复核 |
| P1-E | P1 | 16文件工作树 | 运行态命令/PATCH 先改内存后持久化：500但内存污染 / 200但重启回退 | #3故障注入 |
| P1-F | P1 | 95b69ed 清理代码（现象存量） | Mixin 清理只命中第一个+仅名字匹配，索引/整数引用漂移 | #3实证 |
| P2-A | P2 | 存量 | apibase 可携带凭据由列表/详情原样返回 | #1归责边界 |
| P2-B | P2 | 16文件工作树 | side-question 异步 backend 直接 503 无提示 | #3 |
| P3-A | P3 | 16文件工作树 | Biome 新增 2 硬错（GaBridgeClient.ts 格式、useSendChatTurn.ts import 顺序） | #3 |
| P3-B | P3 | 工作树 | 16 个文件全部未提交，无法回滚/归责 | #3 |

## 二、P1 明细

### P1-A 配置写入非事务性
- 位置：`runtime/ga/ga_bridge_adapter.py:665-691`（`_save_mykey_text` 写盘链）、`:1368-1378`（update 调用链）、`:1436-1450`（create 入口）
- 证据：故障注入复现：①请求修改/创建；②mykey.py 已覆盖；③reload/readback 抛异常；④HTTP 4xx/503；⑤内容已在磁盘。客户端看到"失败"实为"已提交"；重试可生成重复配置；写盘中断可损坏 mykey.py。
- 修复：内存生成完整新文件 → 临时文件 → 完整验证（语法/导入/ID/默认引用）→ `os.replace()` 原子替换 → 再更新内存；reload 失败恢复备份或返回"已持久化未激活"独立状态；create 加幂等。

### P1-B Proxy 脱敏不完整
- 位置：`runtime/ga/ga_bridge_adapter.py:397-417`（`_safe_profile_proxy`）；前端回显 `crates/agent-gui/src/pages/settings/GaModelProfilesSection.tsx:751`（普通文本 Input）
- 证据：仅替换 `scheme://user:pass@host` 的 userinfo；`/path/BEARER_SECRET`、`?api_key=...`、`#FRAG` 及 percent-encoded 凭据原样保留并动态证实进入列表/详情响应 → renderer/DOM。现有测试只覆盖 userinfo。
- 修复：响应仅返回 `{"proxy_configured": true}`；必须显示 endpoint 时只重建 scheme/hostname/port 白名单；解析失败不得回退原串；编辑时空 proxy 表示"保留现值"，另设显式"清除代理"。

### P1-C 删除模型后索引型引用漂移
- 位置：profile DELETE 处理 + 全局默认重映射；持久化/活动 session 的 `llm_no` 无重映射
- 证据：动态实证两种后果：删除低 id 模型后旧会话静默换模型（old==d 落安全默认）；越界默认（id 压缩后）。工作树修复只覆盖全局默认，未覆盖会话绑定；测试未覆盖。
- 归责：审核#1 列为存量风险（删除代码非 95b69ed 新增）；审核#3 确认现状修复不完整。按现状缺陷处理，需修。

### P1-D 控制命令 runtime 被前端丢弃（状态分叉）
- 位置：`crates/agent-gui/src/pages/ChatPage.tsx:1450-1456`（`onGaControlResult` 只取 `control.model?.llmNo`，丢弃 `control.runtime`）；状态所有者 `useChatModelSelection.ts:99-123`（仅 sessionId 变化时 `getSessionRuntime` 拉取）、`:328-353`（唯一本地写路径=PATCH）
- 证据：`ga_bridge_adapter.py:1816-1824`（/effort 修改、应用、持久化并返回新 runtime）；前端丢弃后，`/effort high` 服务端立即生效并持久化，但推理控件仍显示旧值直到 session 重载。Q3：`/effort off|clear|unset` 后端归一化为 null，前端忽略 null → 控件显示"非 off"旧值。
- 修复：`useChatModelSelection` 暴露带 session/conversation 校验的 runtime 应用函数；`onGaControlResult` 收到 `control.runtime` 时原子更新 `gaSessionRuntimeRef` + `gaSessionRuntime`；model 与 runtime 同帧返回时一次提交；迟到结果不得污染已切换会话。

### P1-E 运行态命令/PATCH 先改内存后持久化
- 位置：session runtime PATCH handler；`/effort` 命令 `ga_bridge_adapter.py:1816-1820`；`_install_project_session_support` 包装的 `create_session`（直接调 `manager._persist_session` 无保护）
- 证据（故障注入）：持久化抛异常 → HTTP 500 但 live session 内存已污染（与响应不一致）；官方 `_persist_session` 吞写盘异常 → 200 但重启回退（成功但不耐久）；create_session 包装使 project_id/runtime 字段可能不落盘。
- 修复：统一"先持久化成功、再提交内存"或显式两段式状态；persist 失败返回明确错误并回滚内存；吞异常需改为可观测（日志+状态标记）。

### P1-F Mixin 清理不完整
- 位置：manager mixin 清理逻辑（工作树有部分修复）；profile 删除路径
- 证据：动态实证：清理只命中"第一个发现的 mixin"+ 仅名字字符串匹配；多个 mixin 可残留已删模型引用；整数/索引引用在 id 压缩后漂移；删除唯一原生 profile 可通过"多于一个 profile"表面守卫，留下不可用 mixin（构造失败）。

## 三、P2

### P2-A apibase 凭据原样返回（存量）
列表/详情接口对 apibase 不脱敏；与 P1-B 同类，修复时一并纳入（apibase 也建议只回 `configured` 标记）。

### P2-B side-question 异步后端直接 503
`raw_ask` 同步语义下异步 backend 直接 503，无降级提示（设计取舍但需用户可见反馈）。

## 四、P3 / 工程项
- P3-A：Biome 2 个硬错，lint 未过（全仓另有既有 11 errors/8 files）
- P3-B：16 文件未提交；建议按功能拆分提交后再验收

## 五、门禁结果（审核#3 实测）
Python 40/2skip · 前端 899 · frontend build · cargo check/test/fmt · compileall · ga-runtime stager/check（source/data 各 46 文件）· git diff --check · 定向 Node/GUI adapter 测试。2 个既有 Windows hook 断言失败为基线外。均通过。

## 六、跨轮分歧说明
1. P1-C/P1-F 的归责：#1 归为"存量风险（非 95b69ed 新增代码）"；#3 确认"工作树修复不完整是事实"。结论一致指向现状缺陷，仅归责口径不同，报告中保留双方表述。
2. 审核#3 初判"前端控制结果同步无新增缺陷"，复核 #2 行号证据后确认 P1-D 成立（ChatPage 1450-1456 / useChatModelSelection 99-123,328-353 / adapter 1807-1824 均已逐行核验），采纳为正式 Finding。

## 七、修复优先级建议
1. **P1-B**（凭据进 DOM）→ **P1-A**（假失败/重复创建/文件损坏）：安全+数据正确性
2. **P1-E + P1-D**：同一 session runtime 写路径（PATCH/effort/命令结果）必须统一事务化并汇入同一状态所有者
3. **P1-C + P1-F**：删除/清理一致性，重映射范围扩到会话绑定与全部 mixin 引用
4. P2-A/P2-B、P3-A/P3-B 随上收尾

## 八、回归测试建议（三轮合并）
1. create 写盘后 reload 失败：原文件不变 + 重试不重复
2. update 写盘后 readback 失败：文件与内存恢复或明确"已持久化未激活"
3. 原子写入中断：mykey.py 字节级不变
4. Proxy 脱敏矩阵：userinfo/path/query/fragment/percent-encoded/不可解析，列表+详情+创建+更新均不含秘密
5. UI 回显：`proxy_configured` 时编辑器不得把脱敏占位符提交为真实 proxy
6. /effort high：不发送普通 prompt，state/ref/控件立即变 high
7. /effort off|clear|unset：null 被应用，控件立即显示 off
8. /model 2：model 与 runtime 同帧原子更新
9. 命令未完成切会话：迟到结果不污染当前页，切回以权威状态恢复
10. /effort 后切 thinking 控件：本地合并使用命令返回后的 runtime

## 九、遗留验证（未做）
1. HTTP 级 proxy 全契约复现（完整 manager stub 五 CRUD）
2. ContextVar → 子线程 project_id 传递实证
3. 当前工作树 NSIS/MSI 真实安装态核验（按用户要求未构建）

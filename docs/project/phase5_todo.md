# Phase 5 TODO（精确判定版 v2，2026-08-06 物证核实）

规划原文：C:\Users\DZHY\git-repository\GA\implementation_plan.md（Phase 5 = 行 480-494）
规则：每项先写“GA 概念 → UI 概念”映射；无法映射时删入口，不创建第二真相源（行 494）。

## 已闭环（物证）
- [x] P5.1 model profiles：adapter CRUD+normalize 全参数；前端 GaModelProfilesSection 完整表单（temperature/max_tokens/context_win/trim/reasoning_effort/service_tier/thinking/proxy/user_agent/originator/codex_client/verify/timeouts/api_mode）+mixin 只读+key 脱敏
- [x] P5.3 Skills/SOP 判定闭环（不建第二真相源，行 494）：官方 desktop_bridge 71 方法 0 个 skill 相关、无 enable/import API（已核）；skills 由 GA kernel 每请求重扫（同 P5.11 command packs）→ 文件放入 GA skills 目录+刷新即生效；KnowledgeHubPage 浏览清单+Refresh 已有（HubHeader actions），页脚补生效说明
- [x] P5.2 projectId：ChatPage `isAgentMode ? activeWorkspaceProjectId : undefined`→createSession({cwd,projectId})；adapter `_install_project_session_support` 持久化/恢复/enter_project_mode；project_session_middleware 注入 /session/new
- [x] P5.5 token 用量：GaUsageSection（stats/modelTotals/history/truncated，schema ga.token_usage.v1）
- [x] P5.6 conductor：GaConductorSection（subagents+prompt/reply+chat20+刷新）
- [x] P5.7 Automation：GaAutomationSection CRUD+runs+service 启停（getServices/setServiceRunning→GA 官方 /services/panel|start|stop，desktop_bridge.py 实锤）；手动触发=service running 切换
- [x] P5.4 导入部分：GaMemorySection 新增 Import 卡片→POST /memory/import{sourceDir}（官方 _import_memory_from：memory 备份后合并+model_responses 去重+import_sessions）；commit caa0a01；安全编辑/冲突修复仍缺
- [x] P5.4 判定闭环：导入部分已闭环（caa0a01，GaMemorySection Import 卡片→官方 /memory/import）；安全编辑/冲突修复无官方受控 API（官方 bridge 仅 /memory/import 为 memory 写入口，无分层编辑/project 列表端点）→ 保持只读分层呈现+import 入口（GaMemorySection 只读提示已显式），不建第二真相源（行 494）
- [x] P5.13 服务状态全闭环：GaServicesSection（服务列表+启停+健康/版本卡+/services/logs 日志查看）；commit caa0a01；tsc 零错误
- [x] P5.9 能力中心：GaCapabilitiesSection（桥能力/事件徽标+健康+命令注册表：搜索/kind 过滤/requires_capabilities/permissions/示例）；/commands 已反射 GA slash_cmds 真实 registry（无需 adapter 扩展，修正此前"需扩展"判定）；client 补 getCapabilities；commit 3896db9
- [x] P5.8 判定闭环（不建第二真相源，行 494）：hooks=GA plugins.hooks 运行时内存注册表（hook_snapshot 读 sys.modules["plugins.hooks"]._registry，由插件代码 register_hook 注册），无官方"编辑/超时/脱敏/策略/开关"文件语义→保留只读快照（GaHooksSection 已闭环），删除编辑入口
- [x] P5.7 细项判定闭环：automations 存储=GA 官方 sche_tasks/ 目录（adapter automation_directory 实锤，L2 GA_schedule_config 佐证）；"手动触发/停止"无官方语义（scheduler 服务定时轮询，service running 启停即唯一触发）→ P5.7 全闭环
- [x] P5.10 MCP Connector：adapter 常量/stdio+HTTP 传输/tools.list+call（64 工具上限、4KB 截断、_redact_extra 脱敏、env/redact_keys 脱敏呈现、跳 id 不匹配行健壮性）+pytest 6 用例；UI=Settings→Connectors(MCP)（Plug 图标、清单、展开 tools、参数调用、跨 Server 反查）；tsc 验证通过；commit 12a1ec2
- [x] P5.11 Command Pack 管理闭环：adapter GET /api/v1/command-packs（packs/plugins/conflicts/loaded_command_count，pack/plugin 原始声明参与冲突诊断，GA core 去重优先）；前端 Command Packs Section（registry 状态/包与插件表/冲突诊断/刷新）；tests 41 passed+tsc 零错误；commit dd9174e。判定：启停/受控刷新无官方语义（load_command_registry 每请求全量重扫、无 enable/disable 概念）→ 如实呈现只读清单+冲突诊断，不建第二真相源（行 494）
- [x] P5.12 Morphling 固化向导：adapter POST /api/v1/morphling/classify（规则分类器 discard/tool/memory_l1..3，端点安全=只读不写，32KB 上限，SENSITIVE_KEYS 拒收 endpoint/secret）+pytest 2 用例；UI=KnowledgeHub→Morphling→Absorption wizard（粘贴→分类→目标映射建议，明确禁止默认整包写入 Memory）；commit 12a1ec2

## 待执行（按依赖/价值序）
- （无 — Phase 5 已全部闭环）

## 阻塞项
- [ ] Phase 6 旧内核拆除：执行前生成精确删除清单并请求用户确认（行 509）
- [ ] Phase 9 品牌/文档/发布：待 Phase 5/6 稳定

## 验证门禁
- adapter pytest 新契约+40 passed 基线不回退；前端 tsc+生产构建；每 commit git diff --check + 最小测试集；消息末行 Co-Authored-By: GenericAgent <bot@gaagent.ai>

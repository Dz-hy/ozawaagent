# 03 — 治理清单页：全部可执行资产的来源与风险一览

**What to build:** 新增治理页面，以只读方式统一展示所有可执行资产（命令/命令包、Skill、Connector、Hook、Automation）：来源（内置/用户创建/项目级/第三方）、风险标签（读、写、删除、Shell、网络、凭据、常驻）、作用范围与启用状态；列表可筛选、可搜索；页面入口与其他资产中心平级。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 清单 API 返回全量资产的来源、风险标签、范围、启用状态
- [ ] 治理页可按来源/风险标签/范围筛选，可搜索
- [ ] 页面为只读，任何操作不修改资产本身
- [ ] 清单覆盖命令、Skill、Connector、Hook、Automation 五类
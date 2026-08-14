# 06 — 启用范围与出站策略

**What to build:** 治理页可切换资产的项目级/全局启用范围；对外 HTTP 请求按域名 allowlist 管控，allowlist 编辑需人工确认并留审计记录。策略变更即时生效且不可绕过 GUI。

**Blocked by:** 04 执行审计历史、05 高危执行确认流

**Status:** ready-for-agent

- [ ] 资产可在项目级与全局范围间切换启用/禁用
- [ ] 出站 HTTP 受域名 allowlist 约束，列表外请求被拒并记录
- [ ] allowlist 编辑经人工确认并写入审计
- [ ] 范围与策略变更即时生效且无绕过路径
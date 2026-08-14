# 01 — 渲染安全门禁：CSP 与不可信输出消毒

**What to build:** 整个应用的渲染链路被严格 CSP 与不可信输出消毒规则约束：Markdown、Mermaid、MCP/工具返回、外部链接均按不可信输入处理，恶意 SVG/HTML/脚本 payload 无法在渲染器中执行；XSS 回归 fixtures 成为 CI 门禁。消毒规则集中维护，新渲染点必须显式接入。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Tauri 配置启用明确声明的 CSP（不再为 null），默认限制 script 与 style 来源
- [ ] 所有不可信渲染点（Markdown、Mermaid、工具/MCP 输出、链接跳转）接入统一消毒层
- [ ] 恶意 SVG、Markdown 注入、工具返回 HTML、javascript: 链接的回归 fixtures 全部被拦截（自动化测试）
- [ ] 回归测试证明正常内容（Markdown、代码块、Mermaid 图、合法链接）不被破坏
# 02 — WebSocket 鉴权契约统一

**What to build:** 前端 WebSocket 建立时携带与 adapter 一致的 bearer/subprotocol 鉴权凭据；无凭据或错误凭据的连接被拒绝；打包后的 Windows E2E 冒烟测试锁定该契约。HTTP snapshot 仍为权威数据源，WS 仅作刷新提示。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] WS 连接携带与 adapter 侧校验一致的 token/subprotocol
- [ ] 无凭据/错误凭据的 WS 连接被拒绝，且不影响 HTTP 主流程
- [ ] Windows E2E 冒烟覆盖鉴权成功与失败两条路径
- [ ] 断言 HTTP snapshot 仍为主对话与清单数据的权威来源
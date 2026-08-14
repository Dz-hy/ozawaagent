# 10 — 固化建议与脱敏预览

**What to build:** 会话/工具调用成功后，GUI 显示"沉淀为资产？"建议（复用现有分类建议能力，仅建议、不落盘）；用户可预览候选内容与推荐分类；含 endpoint、协议细节或密钥的候选被自动拦截并提示原因。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 建议入口只在成功后出现，展示候选内容与推荐分类
- [ ] 含 endpoint、协议细节或密钥的候选被拦截并说明原因
- [ ] 预览阶段不产生任何写入
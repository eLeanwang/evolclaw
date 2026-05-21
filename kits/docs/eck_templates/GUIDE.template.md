# Agent 查阅指南

本文件是 {{SELF_AID}} 的个人查阅指南。

## 查阅优先级

1. `$KITS_RULES`（自动加载）— ECK 机制骨架
2. `$AGENT_INDEX/INDEX.md`（本目录）— 个人索引
3. `$KITS_DOCS/INDEX.md` — evolclaw 级文档索引
4. 按索引中的路径 Read 具体文档

## 路径解析

遇到 `$名称` 时：
1. 查 `$ECK/path-registry.md` 获取实际路径
2. 如果实例文件中没有，查 `$KITS_DOCS/path-registry.md` 了解派生规则

## 索引维护

当以下范围内有文档变动时，更新本索引：
- `{{CURRENT_PROJECT}}`
- `{{AGENT_DIR}}`

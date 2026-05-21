# 文档查阅指南

## 查阅流程

1. 先看 `$KITS_RULES`（自动加载的 8 个规则文件）了解机制骨架
2. 需要详细信息时，按 `INDEX.md` 找到对应文档路径
3. Read 对应文档

## 路径解析

文档中用 `$名称` 引用路径。解析步骤：
1. 查 `$KITS_RULES/01-entry.md` 的路径体系速查表
2. 如需完整定义，Read `$KITS_DOCS/path-registry.md`
3. 如需运行时实际值，Read `$ECK/path-registry.md`

## 不要做的事

- 不要一次性加载所有文档——按需逐个 Read
- 不要猜测路径——查注册表
- 不要在当前会话输出对外消息——用 CLI

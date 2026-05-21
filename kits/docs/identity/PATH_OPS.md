# 路径运维操作

<!-- TODO: 填充路径失效处理、迁移、新增路径等运维操作 -->

## 路径失效处理

当 `$ECK/path-registry.md` 中某路径不存在时：
1. 检查路径是否已迁移（查 git log）
2. 尝试按派生规则重新计算
3. 如无法恢复，标记为 `❌` 并通知用户

## 新增路径

1. 在 `$KITS_DOCS/path-registry.md` 添加定义
2. 在 `$ECK/path-registry.md` 添加实例值
3. 更新 `$KITS_DOCS/INDEX.md`

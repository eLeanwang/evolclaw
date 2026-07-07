# behavior.json 残留清理报告

**日期**: 2026-07-07  
**任务**: 清理代码中的 behavior.json 残留注释

## 背景

v3 配置系统已将所有参数统一到 config.json，不再使用 behavior.json。但代码中仍有一些说明性注释提到 behavior.json，需要清理或改写，使其更清晰。

## 清理内容

### 1. 源代码文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/config-store.ts` | 删除注释 | 删除 `// behavior.js 已删除（v3 设计去除 behavior.json）` |
| `src/config/config-manager.ts` | 清理注释 | 删除多处提到 behavior.json 已删除的注释 |
| `src/config/snapshot.ts` | 删除注释 | 删除扫描配置文件时的 behavior.json 注释 |
| `src/config/role-model-sync.ts` | 简化注释 | 删除文件头和函数中的 v3 设计说明 |
| `src/types.ts` | 简化注释 | 删除配置体系注释中的 behavior.json 说明 |
| `src/cli/config.ts` | 改写注释 | 将"合并 H + behavior"改为"合并 H 链" |

### 2. 测试文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `tests/config-routing.test.ts` | 删除注释和测试 | 删除检查 behavior.json 不存在的测试代码 |

## 修改原则

1. **删除说明性注释**：删除仅用于说明"behavior.json 已删除"的注释
2. **保留语义性使用**：保留函数名（如 `saveInitialBehavior`）中的 "behavior" 单词，因为这是指"行为配置"的语义，不是文件名
3. **改写混淆性注释**：将可能引起混淆的注释改写得更清晰

## 未修改的内容

### 保留的 "behavior" 语义使用

以下使用了 "behavior" 单词，但指的是语义概念，不是文件名，因此保留：

1. **权限检查返回值**: `{ behavior: 'allow' }` / `{ behavior: 'deny' }` —— 这是权限系统的返回格式
2. **函数命名**: `saveInitialBehavior()` —— 指"保存初始行为配置"的语义
3. **AUN 协议字段**: `behavior: 'reply'` —— AUN 卡片按钮的行为类型
4. **队列行为**: `queueBehavior` —— 消息队列的行为模式

这些都是合理的语义使用，与 behavior.json 文件无关。

## 验证

清理后，代码中对 behavior.json 的引用仅存在于文档中，用于历史说明或迁移指南，源代码和测试中已无残留。

## 注意事项

- 文档文件（`docs/`）中的 behavior.json 引用未修改，因为这些是历史记录和迁移指南
- 配置体系已完全迁移到 v3，所有参数统一在 config.json 中
- 覆盖链为：defaults.json → agent/config.json → relation/config.json

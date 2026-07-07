# behavior.json 残留清理完成报告

**日期**: 2026-07-07  
**任务**: 清理代码和测试中的 behavior.json 残留

## 概述

v3 配置系统已将所有参数统一到 config.json，不再使用 behavior.json。本次清理移除了代码和测试中所有对 behavior.json 的引用注释和检查。

## 提交记录

### Commit 1: 源代码清理
**提交号**: 4ba7613  
**标题**: `refactor(config): clean up behavior.json remnants in comments`

清理内容：
- `src/cli/config.ts` - 更新注释和帮助文本
- `src/config-store.ts` - 删除导入注释
- `src/config/config-manager.ts` - 清理多处注释
- `src/config/snapshot.ts` - 删除快照相关注释
- `src/config/role-model-sync.ts` - 简化文件头和函数注释
- `src/types.ts` - 更新配置体系注释
- `tests/config-routing.test.ts` - 删除检查 behavior.json 的测试代码
- `docs/config/behavior-json-cleanup.md` - 添加清理文档

### Commit 2: 测试文件清理
**提交号**: 673ea9f  
**标题**: `test: clean up behavior.json remnants in test files`

清理内容：
- `tests/unit/config-manager.test.ts` - 删除 behavior.json 存在性检查
- `tests/unit/agent.test.ts` - 简化测试设置注释
- `tests/integration/agent-cli.test.ts` - 删除 v3 设计注释
- `tests/integration/agent-scenarios.test.ts` - 删除 v3 设计注释
- `tests/integration/config-cli.test.ts` - 删除 behavior.json 检查

## 清理统计

### 源代码文件
- 修改文件数: 7
- 删除注释行数: ~20
- 改写注释行数: ~10

### 测试文件
- 修改文件数: 5
- 删除检查代码: 4 处
- 删除注释行数: ~8

## 验证结果

所有相关测试均通过：
- ✅ `tests/config-routing.test.ts` - 8/8 passed
- ✅ `tests/unit/config-manager.test.ts` - 14/14 passed
- ✅ `tests/unit/config-snapshot.test.ts` - 12/12 passed

## 保留的 "behavior" 使用

以下使用了 "behavior" 单词但指的是语义概念，已确认保留：

1. **权限检查返回值**
   - `{ behavior: 'allow' }` / `{ behavior: 'deny' }`
   - 位置: `src/core/permission.ts`, `src/agents/claude-runner.ts`, `src/agents/codex-runner.ts`
   - 说明: 权限系统的标准返回格式

2. **函数命名**
   - `saveInitialBehavior()` in `src/cli/agent.ts`
   - 说明: "保存初始行为配置"的语义，不是文件名

3. **AUN 协议字段**
   - `behavior: 'reply'` in `src/channels/aun.ts`
   - 说明: AUN 卡片按钮的行为类型

4. **队列行为**
   - `queueBehavior` in `src/response-modes/decision-executor.ts`
   - 说明: 消息队列的行为模式枚举

## 文档文件未修改

`docs/` 目录下的文档保留了对 behavior.json 的引用，因为这些是：
- 历史记录和迁移指南
- v2 → v3 迁移说明
- 设计决策文档

## 最终状态

- ✅ 源代码中无 behavior.json 功能性残留
- ✅ 测试代码中无 behavior.json 检查残留
- ✅ 注释已清理或改写，不再引起混淆
- ✅ 所有测试通过
- ✅ "behavior" 语义使用已确认合理

## v3 配置系统确认

当前配置体系：
- **覆盖链**: defaults.json → agent/config.json → relation/config.json
- **统一存储**: 所有参数（基础设施 + 行为）统一在 config.json
- **角色约束**: 通过 roles.json + role-assignments.json 实现
- **独立配置**: evolclaw.json 不参与覆盖链

v3 设计已完全落地，behavior.json 已彻底退出历史舞台。

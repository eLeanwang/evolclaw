# 实验性代码目录

本目录包含未在生产环境使用的实验性功能和架构探索代码。

## 目录结构

### index-gateway.ts
Gateway 模式入口文件（实验性）

### gateway/
Gateway 模式相关模块：
- `instance-manager.ts` - Claude 实例池管理
- `claude-instance.ts` - 单个 Claude 实例封装
- `failure-handler.ts` - 故障处理和重试机制

**设计目标**：支持高并发场景下的实例池管理和故障恢复

### monitor/
Hook 事件监控模块：
- `hook-collector.ts` - Hook 事件收集到数据库
- `hook-monitor.ts` - 基于 Hook 的超时监控
- `index.ts` - 模块导出

**设计目标**：提供会话状态监控和超时检测能力

### core/
实验性核心架构：
- `agent-runner-v2.ts` - Agent 运行器 v2（内置并发管理）
- `concurrency-manager.ts` - 并发控制管理器
- `database.ts` - 消息数据库（messages、sync_state、processed_messages 表）
- `message-sync.ts` - JSONL 消息同步到数据库

**设计目标**：
- 探索内置并发管理的简化架构
- 提供消息历史的结构化查询能力（搜索、统计、导出）

### index.ts
渠道模块统一导出（来自 channels/index.ts）

**设计目标**：提供统一的 MessageChannel 接口定义

## 状态说明

这些模块均为**实验性功能**，未在生产环境（`src/index.ts`）中使用。

保留原因：
- 提供架构设计参考
- 可能在未来版本中启用
- 包含有价值的设计思路

## 使用建议

如需启用这些功能，需要：
1. 更新导入路径（添加 `experimental/` 前缀）
2. 集成到主入口文件
3. 进行完整的测试验证

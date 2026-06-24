# 响应模式插件化系统文档

## 概述

响应模式插件化系统是 EvolClaw 的核心架构升级，旨在将会话响应机制从硬编码转变为灵活的插件化架构。通过这套系统，你可以：

- **自定义响应策略**：不同会话使用不同的响应模式（interactive/proactive/dual-session 等）
- **灵活的队列控制**：每个响应模式可以有自己的队列实现（FIFO/LIFO/Priority/Custom）
- **智能调度**：支持规则驱动、AI 驱动、混合三种调度策略
- **易于扩展**：开发新的响应模式只需实现标准接口并注册

## 文档结构

### 核心文档（必读）

1. **[architecture.md](./architecture.md)** - 架构设计文档
   - 为什么需要响应模式插件化？
   - 三层架构（调度层/响应层/执行层）
   - 响应模式接口设计
   - 队列管理机制
   - 调度策略设计
   - 一条消息的完整流程

2. **[plugin-guide.md](./plugin-guide.md)** - 插件开发指南
   - 快速上手（30分钟实现第一个插件）
   - 接口详解
   - 最佳实践
   - 调试与测试
   - 高级模式示例

3. **[command-reference.md](./command-reference.md)** - 命令参考
   - `ec response list` - 列出所有响应模式
   - `ec response current` - 查看当前响应模式
   - `ec response set` - 设置响应模式
   - `ec response config` - 查看/修改配置
   - 使用示例

### 参考文档

4. **[config-reference.md](./config-reference.md)** - 配置参考
   - 配置文件位置与层级
   - `response_modes` 配置块
   - 每个内置模式的配置参数
   - 配置示例

5. **[builtin-modes.md](./builtin-modes.md)** - 内置模式文档
   - 10 种内置模式详解
   - 模式选择指南

6. **[troubleshooting.md](./troubleshooting.md)** - 故障排查
   - 常见问题
   - 诊断命令
   - 日志分析

7. **[implementation-plan.md](./implementation-plan.md)** - 实施路线
   - 实施前的决策门（6 项待 owner 拍板）
   - Phase 1-7 任务清单（输入/产出/依赖/影响文件）
   - 关键路径与并行
   - 风险控制原则

## 阅读路径

### 架构师/核心开发者
```
architecture.md（理解全局）
  ↓
plugin-guide.md（实现插件）
  ↓
builtin-modes.md（参考内置模式）
```

### 插件开发者
```
plugin-guide.md（快速上手）
  ↓
architecture.md（深入理解）
  ↓
builtin-modes.md（参考示例）
```

### 终端用户
```
command-reference.md（学习命令）
  ↓
builtin-modes.md（选择模式）
  ↓
config-reference.md（调整配置）
```

## 快速开始

### 查看所有响应模式
```bash
ec response list
```

### 查看当前会话的响应模式
```bash
ec response current
```

### 切换到双会话模式
```bash
ec response set dual-session
```

### 查看当前模式的配置
```bash
ec response config
```

### 修改配置参数
```bash
ec response config set auxiliary_model haiku
```

## 核心概念

### 响应模式（Response Mode）
定义会话如何处理入站消息和发送出站消息的策略。每个响应模式包含：
- **入站处理策略**：决定消息是否处理、如何入队
- **出站发送策略**：决定如何发送回复
- **队列管理**：每个模式可以有自己的队列实现
- **扩展机制**：可选的辅助会话、线索追踪等

### 三层架构

```
┌─────────────────────────────────────────────┐
│  调度层（Slot Manager）                       │  ← 管"能不能处理"
│  - 资源分配、并发控制、预算管理                │
│  - 调度策略（规则/AI/混合）                    │
└────────────────┬────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  响应层（Response Mode）                      │  ← 管"怎么处理"
│  - 入站处理策略                               │
│  - 出站发送策略                               │
│  - 队列管理（每个模式自己的队列）              │
│  - 扩展机制（辅助会话、线索追踪等）            │
└────────────────┬────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────┐
│  执行层（Runner/Channel）                     │  ← 管"执行"
│  - Agent Runner（模型调用）                   │
│  - Channel Adapter（消息收发）                │
└─────────────────────────────────────────────┘
```

## 设计原则

1. **职责清晰**：每层只关心自己的问题域
2. **独立演进**：改一层不影响其他层
3. **依赖注入**：响应模式通过 Context 获取依赖，不直接依赖具体实现
4. **开放封闭**：对扩展开放，对修改封闭
5. **最少知识**：响应模式只知道自己需要知道的

## 贡献指南

### 开发新的响应模式

1. 实现 `ResponseMode` 接口
2. 在 `src/response-modes/extensions/` 目录创建模块文件
3. 注册到 `ResponseModeRegistry`
4. 编写测试
5. 更新 `builtin-modes.md` 文档

详见 [plugin-guide.md](./plugin-guide.md)

### 提交 Bug 或功能请求

请在 GitHub Issues 中提交，标签使用 `response-mode`

## 版本历史

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v1.0 | 2025-01-XX | 初始版本 |

## 许可证

[项目许可证]

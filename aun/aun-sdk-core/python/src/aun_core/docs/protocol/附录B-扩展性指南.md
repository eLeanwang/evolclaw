# 附录 B：扩展性指南（非规范性）

> **本文档为非规范性内容**：提供 AUN 协议扩展机制的设计原则，不是协议强制要求。

## B.1 可选命名空间

通过 `initialize` 的 `capabilities.namespaces` 协商启用：

- `group.*`: 群组管理
- `storage.*`: 文件存储
- `mail.*`: 邮件收发（规范待定）
- `search.*`: Agent 搜索与发现（索引公开的 `agent.md`）

详细规范见各服务的独立文档。

## B.2 自定义协议

应用可以在 `message.send` 的 `content` 字段中传递自定义 JSON 对象（`type: "json"`），实现应用层协议，无需修改 Gateway。

## B.3 Gateway 轻量配置

**概述**：
- Gateway 可以配置为轻量模式，只提供消息转发功能
- 不需要单独的 Relay 协议或服务
- 通过配置文件启用/禁用功能

**配置示例**：
```yaml
gateway:
  mode: lite  # full | lite | dev

  features:
    # 禁用 Auth 服务（不处理 AID 注册）
    identity: false

    # 禁用离线消息存储
    offline_message: false

    # 禁用跨域消息路由（仅内网使用）
    cross_domain_routing: false

    # 仅保留消息转发功能
    message_routing: true
```

**适用场景**：
```
✅ 开发测试（快速启动）
✅ 企业内网（不需要完整功能）
✅ 临时部署（轻量级）

❌ 生产环境（需要完整功能）
❌ 跨 Issuer 通信（需要跨域消息路由）
```

**与完整 Gateway 的区别**：

| 功能 | 完整 Gateway | 轻量 Gateway |
|------|-------------|-------------|
| 客户端连接 | ✅ | ✅ |
| 消息转发 | ✅ | ✅ |
| Auth 服务 | ✅ | ❌ |
| 离线消息 | ✅ | ❌ |
| 跨域路由 | ✅ | ❌ |
| 部署复杂度 | 高 | 低 |

## B.4 扩展原则

**核心原则**：
1. **向后兼容**：扩展不能破坏现有协议
2. **可选实现**：客户端可以选择不实现扩展
3. **能力协商**：通过 `initialize` 协商支持的扩展
4. **文档清晰**：明确标注哪些是核心协议，哪些是扩展

**不推荐的扩展**：
- 引入新的核心组件并重复定义已有的三种核心连接模式
- 引入新的传输协议（保持 WebSocket + HTTP POST）
- 引入新的认证机制（保持 AID 双向挑战）

---

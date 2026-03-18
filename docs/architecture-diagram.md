# EvolClaw 七层架构图

```mermaid
graph TB
    subgraph Layer1["第一层：消息渠道层"]
        Feishu[飞书 WebSocket<br/>src/channels/feishu.ts]
        AUN[AUN 协议<br/>src/channels/aun.ts]
    end

    subgraph Layer2["第二层：消息队列层"]
        Queue[消息队列<br/>src/core/message-queue.ts<br/>• 会话级串行处理<br/>• 中断机制]
    end

    subgraph Layer3["第三层：消息处理层"]
        Processor[消息处理器<br/>src/core/message-processor.ts<br/>• 统一事件处理<br/>• 工具活动格式化<br/>• 文件标记处理]
        Flusher[流式刷新器<br/>src/core/stream-flusher.ts<br/>• 3秒批量发送]
    end

    subgraph Layer4["第四层：监控层"]
        Monitor[Hook 监控<br/>src/monitor/<br/>• 实验性功能<br/>• 主入口未使用]
    end

    subgraph Layer5["第五层：会话管理层"]
        SessionMgr[会话管理器<br/>src/core/session-manager.ts<br/>• 多项目会话<br/>• 会话切换<br/>• 状态持久化]
    end

    subgraph Layer6["第六层：实例管理层"]
        InstanceMgr[实例管理器<br/>src/gateway/<br/>• 实验性功能<br/>• 实例池管理]
        AgentRunner[Agent 运行器<br/>src/agent-runner.ts<br/>• SDK 调用封装<br/>• 中断支持]
    end

    subgraph Layer7["第七层：存储层"]
        SQLite[(SQLite 数据库<br/>会话元数据)]
        JSONL[(JSONL 文件<br/>对话历史<br/>SDK 管理)]
    end

    Feishu --> Queue
    AUN --> Queue
    Queue --> Processor
    Processor --> Flusher
    Processor -.-> Monitor
    Processor --> SessionMgr
    SessionMgr --> AgentRunner
    AgentRunner -.-> InstanceMgr
    AgentRunner --> SQLite
    AgentRunner --> JSONL

    style Layer1 fill:#e1f5ff
    style Layer2 fill:#fff4e1
    style Layer3 fill:#e8f5e9
    style Layer4 fill:#f3e5f5
    style Layer5 fill:#fff9c4
    style Layer6 fill:#ffe0b2
    style Layer7 fill:#ffebee
```

## 架构说明

### 数据流向

**用户消息流**：
```
用户消息 → 渠道层 → 消息队列 → 消息处理器 → 会话管理 → Agent运行器 → Claude SDK
```

**响应流**：
```
Claude SDK → Agent运行器 → 流式刷新器 → 消息处理器 → 渠道层 → 用户
```

### 关键特性

1. **中断机制**：新消息到达时，队列层立即触发中断，终止当前任务
2. **批量发送**：流式刷新器在 3 秒窗口内累积工具活动，减少消息数量
3. **统一处理**：消息处理器消除了 ~250 行重复代码，所有渠道共享同一处理逻辑
4. **会话隔离**：每个项目独立会话，切换项目时保留历史
5. **实验性层**：监控层和实例管理层保留用于参考，主入口使用简化架构

### 入口点

- **主入口** (`src/index.ts`)：生产使用，完整功能
- **网关模式** (`src/index-gateway.ts`)：实验性，保留用于参考

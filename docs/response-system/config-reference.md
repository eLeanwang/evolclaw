# 配置参考

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | 响应模式配置参考 |
| 版本 | v1.0 |
| 状态 | Draft |
| 适用读者 | 配置管理者、运维 |

---

## 一、配置文件位置与层级

响应模式配置复用 EvolClaw 现有配置体系，遵循三级覆盖链。

```
defaults.json                                  # 全局默认（最低优先级）
  ↓ 覆盖
agents/<aid>/config.json                       # Agent 级
  ↓ 覆盖
agents/<aid>/relations/<peerKey>/config.json   # Relation 级（最高优先级）
```

| 层级 | 文件 | 作用域 |
|------|------|--------|
| 全局 | `agents/defaults.json` | 所有 agent |
| Agent | `agents/<aid>/config.json` | 单个 agent |
| 关系 | `agents/<aid>/relations/<peerKey>/config.json` | 特定对端/群 |

---

## 二、response_modes 配置块

所有响应模式配置集中在 `response_modes` 块下。

### 2.1 完整结构

```typescript
interface ResponseModesConfig {
  /** 默认响应模式（单聊） */
  default_private?: string;

  /** 默认响应模式（群聊） */
  default_group?: string;

  /** 各模式的配置参数 */
  configs?: {
    [modeId: string]: any;
  };

  /** 会话级覆盖 */
  overrides?: {
    [peerKey: string]: {
      mode: string;
      config?: any;
    };
  };
}
```

### 2.2 字段说明

#### default_private

单聊场景的默认响应模式。

- **类型**：string（模式 ID）
- **默认值**：`interactive`
- **示例**：`"default_private": "interactive"`

#### default_group

群聊场景的默认响应模式。

- **类型**：string（模式 ID）
- **默认值**：`proactive`
- **示例**：`"default_group": "dual-session"`

#### configs

各响应模式的配置参数。键为模式 ID，值为该模式的配置对象（结构由模式的 `configSchema` 定义）。

```json
{
  "configs": {
    "dual-session": {
      "auxiliary_model": "haiku",
      "relevance_threshold": 0.7
    },
    "batch-processing": {
      "max_count": 50,
      "idle_ms_default": 180000
    }
  }
}
```

#### overrides

针对特定对端/群的覆盖配置。键为 `peerKey`（`<channel>#<urlEncode(peerId)>`）。

```json
{
  "overrides": {
    "aun#work-group.company.com": {
      "mode": "workflow",
      "config": {
        "workflow_file": "task-flow.json"
      }
    },
    "aun#alice.aid.pub": {
      "mode": "interactive"
    }
  }
}
```

---

## 三、解析优先级

会话的响应模式按以下优先级解析：

```
1. overrides[peerKey].mode    （最高优先级，特定对端）
   ↓ 未命中
2. default_private / default_group  （按 chatType）
   ↓ 未命中
3. 系统兜底（private→interactive, group→proactive）
```

配置解析也遵循三级文件覆盖链。最终生效配置 = `deepMerge(defaults, agentConfig, relationConfig)`。

---

## 四、配置示例

### 4.1 最小配置

```json
{
  "response_modes": {
    "default_private": "interactive",
    "default_group": "proactive"
  }
}
```

### 4.2 群聊使用双会话模式

```json
{
  "response_modes": {
    "default_private": "interactive",
    "default_group": "dual-session",
    "configs": {
      "dual-session": {
        "auxiliary_model": "haiku",
        "relevance_threshold": 0.7
      }
    }
  }
}
```

### 4.3 不同群使用不同模式

```json
{
  "response_modes": {
    "default_group": "proactive",
    "configs": {
      "dual-session": { "auxiliary_model": "haiku" },
      "workflow": { "coordinator_role": "owner" }
    },
    "overrides": {
      "aun#busy-chat.group.com": {
        "mode": "dual-session"
      },
      "aun#task-board.group.com": {
        "mode": "workflow",
        "config": { "workflow_file": "sprint-flow.json" }
      },
      "aun#casual-chat.group.com": {
        "mode": "rate-limited",
        "config": { "rate_limit": { "window_ms": 600000, "max_responses": 5 } }
      }
    }
  }
}
```

---

## 五、内置模式配置参数

### 5.1 interactive（交互模式）

无特殊配置参数。

### 5.2 proactive（主动模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `pre_tool_1stmsgchk` | boolean | true | 首个工具调用前是否必须先表态 |
| `tool_use_reminder` | boolean | true | 是否启用工具使用提醒 |

### 5.3 dual-session（双会话模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `auxiliary_model` | string | haiku | 辅助会话模型 |
| `relevance_threshold` | number | 0.7 | 相关性阈值（0-1） |
| `model_switching_rules` | object | {} | 模型切换规则（按内容类型） |

```json
{
  "auxiliary_model": "haiku",
  "relevance_threshold": 0.7,
  "model_switching_rules": {
    "image": "opus",
    "video": "opus"
  }
}
```

### 5.4 thread-tracking（线索追踪模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `max_active_threads` | number | 5 | 最多追踪线索数 |
| `thread_timeout_ms` | number | 1800000 | 线索过期时间（30分钟） |
| `auto_join_on_mention` | boolean | true | 被@时自动加入线索 |
| `context_injection` | boolean | true | 是否注入线索历史上下文 |

### 5.5 workflow（工作流模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `workflow_file` | string | - | 工作流定义文件路径 |
| `coordinator_role` | string | owner | 协调者角色 |
| `state_persistence` | boolean | true | 是否持久化工作流状态 |

### 5.6 context-enhanced（上下文增强模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `document_sources` | array | [] | 文档来源列表 |
| `injection_strategy` | string | cached | 注入策略（always/on-demand/cached） |

```json
{
  "document_sources": [
    { "type": "file", "path": "./group-rules.md", "refresh_interval_ms": 3600000 }
  ],
  "injection_strategy": "cached"
}
```

### 5.7 batch-processing（批量处理模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `max_count` | number | 50 | 队列达 N 条立即处理 |
| `max_bytes` | number | 16384 | 累计字节达 M 立即处理 |
| `idle_ms_default` | number | 180000 | 无新消息静默超时（3分钟） |
| `idle_ms_active` | number | 10000 | 有活跃交互对象时的超时（10秒） |
| `flush_on_mention` | boolean | true | 被@时立即处理 |

### 5.8 selective-response（选择性响应模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `whitelist_aids` | string[] | - | 白名单（仅响应这些 AID） |
| `blacklist_aids` | string[] | - | 黑名单（不响应这些 AID） |
| `keyword_rules` | array | [] | 关键词规则 |
| `min_influence_threshold` | number | 0 | 最低影响力阈值 |

### 5.9 rate-limited（速率限制模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `rate_limit.window_ms` | number | 600000 | 时间窗口（10分钟） |
| `rate_limit.max_responses` | number | 20 | 窗口内最大响应次数 |
| `cooldown_ms` | number | 0 | 冷却期 |
| `priority_preemption` | boolean | true | owner/admin 可打断冷却 |

### 5.10 autonomous（自主模式）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `allow_inbound` | boolean | false | 是否接受外部消息 |
| `trigger_only` | boolean | true | 仅触发器驱动 |

---

## 六、调度层配置

调度层配置在 `scheduler` 块下（独立于 `response_modes`）。

```typescript
interface SchedulerConfig {
  /** 最大并发会话数（per-agent） */
  max_concurrent_sessions?: number;

  /** 调度策略 */
  strategy?: 'rule-based' | 'ai-based' | 'hybrid';

  /** 全局 token 预算 */
  global_budget?: number;

  /** 规则驱动配置 */
  rule_config?: {
    role_weights?: Record<string, number>;
    chattype_weights?: Record<string, number>;
    wait_time_factor?: number;
  };

  /** AI 驱动配置 */
  ai_config?: {
    scheduler_model?: string;
    max_sessions_per_call?: number;
  };

  /** 混合配置 */
  hybrid_config?: {
    ai_trigger_threshold?: number;
    ai_trigger_conditions?: string[];
  };
}
```

### 6.1 示例

```json
{
  "scheduler": {
    "max_concurrent_sessions": 3,
    "strategy": "hybrid",
    "global_budget": 1000000,
    "rule_config": {
      "role_weights": { "owner": 100, "admin": 80, "guest": 50, "anonymous": 10 },
      "chattype_weights": { "private": 20, "group": 0 },
      "wait_time_factor": 0.05
    },
    "ai_config": {
      "scheduler_model": "haiku",
      "max_sessions_per_call": 10
    },
    "hybrid_config": {
      "ai_trigger_threshold": 5,
      "ai_trigger_conditions": ["queue_length > 5", "has_urgent_keyword"]
    }
  }
}
```

---

## 七、配置校验

### 7.1 Schema 校验

每个响应模式的配置参数根据其 `configSchema` 校验：

- 参数名必须在 schema 中定义
- 参数类型必须匹配
- 必填参数（required）不能缺失
- 枚举值（enum）必须在允许范围内
- 数值范围（minimum/maximum）必须满足

### 7.2 校验时机

- `ec response config set` 命令执行时
- 配置文件加载时
- 模式 `initialize` 时

### 7.3 校验失败处理

- 命令行：拒绝写入，显示错误信息
- 文件加载：使用默认值，记录警告日志

---

## 八、配置迁移

### 8.1 从现有 chatmode 迁移

现有的 `chatmode` 配置：

```json
{
  "chatmode": {
    "private": "interactive",
    "group": "proactive"
  }
}
```

迁移到 `response_modes`：

```json
{
  "response_modes": {
    "default_private": "interactive",
    "default_group": "proactive"
  }
}
```

### 8.2 从现有 dispatch 迁移

现有的 `dispatch` 配置（mention/broadcast）映射到响应模式：

- `dispatch: mention` → 使用 `selective-response` 模式（仅@响应）
- `dispatch: broadcast` → 使用 `proactive` 模式（全部响应）

### 8.3 兼容性

迁移期间，系统同时支持新旧配置：
- 优先读 `response_modes`
- 回落到 `chatmode` + `dispatch`

---

## 附录：相关文档

- [架构设计](./architecture.md)
- [插件开发指南](./plugin-guide.md)
- [命令参考](./command-reference.md)
- [内置模式文档](./builtin-modes.md)

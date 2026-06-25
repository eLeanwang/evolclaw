# 覆盖链与合并规则

> EvolClaw 配置体系 v3
> 上一篇：[01-overview.md](./01-overview.md) | 下一篇：[03-schema.md](./03-schema.md)

---

## 一、核心机制

每个配置文件就是**一个扁平字典**：`参数名 → 值`。覆盖链作用在**参数这一层**：

```
关系级（最高） > agent级 > 全局级 defaults（最低）
```

**进程级独立**，不参与覆盖链。

### 覆盖链层级

| 层级 | 文件 | 优先级 |
|------|------|--------|
| 全局级 | `agents/defaults.json` | 最低 |
| agent级 | `agents/{aid}/config.json` | 中 |
| 关系级 | `relations/{peerKey}/config.json` | 最高 |

---

## 二、合并规则（类型即合并契约）

对每个参数，**类型锚定在最低优先级中定义它的文件**；高优先级若类型不一致则拒绝。值按类型合并：

| 参数值类型 | 合并行为 | 高优先级能做什么 |
|-----------|---------|----------------|
| **标量** (string/number/bool/null) | 高优先级整体覆盖 | 整个换掉 |
| **列表** (array) | 并集追加去重 | 只能加，不能减 |
| **字典** (object) | 键并集；同键 → 高优先级值覆盖（**不递归**） | 加新键 + 换已有键的整个值 |

### 关键原则

**合并粒度 = 字典的第一层键**，不往下递归。

想让某字段"可继承+可独立覆盖"，就放在**顶层参数**或**字典第一层键**，别埋进二级嵌套。

合并代码永远只有这三条规则，所有"覆盖 vs 追加"的需求通过 schema 的类型选择来表达，不为任何字段写特判。

---

## 三、类型选择决定语义

| 想要的语义 | 建模方式 |
|-----------|---------|
| 标量整体覆盖 | scalar |
| 集合只增不减 | list |
| 命名条目可加可改 | dict（key → 任意） |
| 一批值可被高优先级整体替换 | dict（key → list） |

---

## 四、合并示例

### 标量覆盖

```jsonc
// defaults.json
{ "active_baseagent": "claude" }
// agent/config.json
{ "active_baseagent": "codex" }
// 合并结果
{ "active_baseagent": "codex" }   // agent 级覆盖
```

### 列表并集

```jsonc
// defaults.json
{ "owners": ["ops.aid.pub"] }
// agent/config.json
{ "owners": ["bob.aid.pub"] }
// relation/config.json
{ "owners": ["carol.aid.pub"] }
// 合并结果
{ "owners": ["ops.aid.pub", "bob.aid.pub", "carol.aid.pub"] }   // 并集
```

### 字典键合并

```jsonc
// defaults.json
{
  "baseagents": {
    "claude": { "model": "opus", "effort": "high" }
  }
}
// agent/config.json
{
  "baseagents": {
    "claude": { "model": "sonnet" }
  }
}
// 合并结果（注意：不递归！）
{
  "baseagents": {
    "claude": { "model": "sonnet" }   // 整个 claude 对象被覆盖，effort 丢失！
  }
}
```

**⚠️ 注意**：字典合并**不递归**！如果想保留 `effort`，需要在 agent 级也写上：

```jsonc
// agent/config.json（正确做法）
{
  "baseagents": {
    "claude": { "model": "sonnet", "effort": "high" }
  }
}
```

---

## 五、角色配置（owners / admins）

`owners` / `admins` 是 **list**，因此沿覆盖链**并集追加去重**：

```
最终 owners = defaults.owners ∪ agent.owners ∪ relation.owners
最终 admins = defaults.admins ∪ agent.admins ∪ relation.admins
```

### 含义

高优先级**只能往上加** owner/admin，**不会**剥夺低优先级已声明的角色。

例如："在关系级把 carol 提为 owner"不会让 agent 级的 bob 失去 owner 身份——这正是 list 合并语义的保证，符合"角色只能授予、不能在子作用域剥夺"。

---

## 六、关系级个性化场景

关系级配置用于针对不同用户的个性化设置。

### 示例：对不同用户用不同模型

```jsonc
// agent/config.json（默认）
{
  "active_baseagent": "claude",
  "baseagents": {
    "claude": { "model": "opus", "effort": "high" }
  }
}

// relations/aun#alice/config.json（VIP 用户）
{
  "baseagents": {
    "claude": { "model": "opus", "effort": "max" }
  }
}

// relations/aun#bob/config.json（普通用户）
{
  "baseagents": {
    "claude": { "model": "sonnet", "effort": "medium" }
  }
}
```

### 示例：对不同用户用不同对话模式

```jsonc
// relations/aun#alice/config.json
{
  "chatmode": { "private": "proactive" },
  "show_activities": "all",
  "permissionMode": "bypass"
}

// relations/aun#stranger/config.json
{
  "chatmode": { "private": "interactive" },
  "show_activities": "none",
  "permissionMode": "readonly"
}
```

---

## 七、解析与生效

### 实时解析

- 每条消息实时按覆盖链解析
- 不缓存到会话、不绑会话 id
- 改配置后该范围所有对话**下一条消息即时生效**

### 并发隔离

- 多对端并发各自独立解析
- 互不污染

---

## 八、解析实现

### resolveAgentConfig（覆盖链合并）

```typescript
resolveAgentConfig(selector: { self: string; peerKey?: string }): AgentConfig {
  const layers = [
    this.read(ConfigTarget.Defaults),                                      // 全局（最低）
    this.read(ConfigTarget.Agent, selector),                              // agent
    selector.peerKey ? this.read(ConfigTarget.Relation, selector) : null, // relation（最高）
  ];
  return layers.filter(Boolean).reduce(deepMerge, {} as AgentConfig);
}
```

### 合并算法（deepMerge）

```typescript
function deepMerge(low: object, high: object): object {
  const result = { ...low };
  for (const [key, highVal] of Object.entries(high)) {
    const lowVal = result[key];
    if (Array.isArray(highVal)) {
      // 列表：并集去重
      result[key] = unionDedupe(lowVal || [], highVal);
    } else if (isObject(highVal) && isObject(lowVal)) {
      // 字典：键并集（第一层），同键高优先级覆盖（不递归）
      result[key] = { ...lowVal, ...highVal };
    } else {
      // 标量：整体覆盖
      result[key] = highVal;
    }
  }
  return result;
}
```

### 关键点

- 逐级深合并，低优先级独有字段保留、冲突点高优先级胜
- 关系级缺省（无 peerKey）时该层不参与，链自然退化
- 没有"代码内置默认值"作为覆盖链的一级。缺省兜底由 schema 的 `default` 在 `ensureFile` 时落到骨架

---

## 九、设计要点

### 唯一合并实现点

全项目只有 ConfigManager 的 `deepMerge` 一处合并逻辑，不允许第二份。

### 机制先行

加任何"可继承+可追加"的概念，套对应类型即可，无需改合并代码：
- 想要标量覆盖 → schema 定义为 scalar
- 想要列表追加 → schema 定义为 array
- 想要命名条目 → schema 定义为 object

---

## 相关文档

- [01-overview.md](./01-overview.md) - 总体架构
- [03-schema.md](./03-schema.md) - Schema 治理
- [04-config-manager.md](./04-config-manager.md) - ConfigManager API
- [config-params-classified.md](./config-params-classified.md) - 完整参数清单

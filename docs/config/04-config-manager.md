# ConfigManager API

> EvolClaw 配置体系 v3
> 上一篇：[03-schema.md](./03-schema.md) | 下一篇：[05-snapshot.md](./05-snapshot.md)

---

## 一、设计原则

### 统一归口

**所有配置文件的读写经过单例 `ConfigManager`**，不允许散落的 `fs.readFileSync` 直接操作配置文件。

### 唯一合并实现点

全项目只有 ConfigManager 的覆盖链合并逻辑，不允许第二份实现。

---

## 二、核心接口

```typescript
class ConfigManager {
  // 读写单个配置文件
  read<T>(target: ConfigTarget, selector?: Selector): T | null
  write<T>(target: ConfigTarget, value: T, opts?: WriteOpts): void
  
  // 覆盖链合并
  resolveAgentConfig(selector: Selector): AgentConfig
  resolveEffectiveAgentConfig(selector: Selector): EffectiveAgentConfig
  
  // 骨架生成
  ensureFile(target: ConfigTarget, selector?: Selector): void
  
  // 快照
  snapshot(opts?: SnapshotOpts): SnapshotResult
}
```

---

## 三、ConfigTarget 枚举

```typescript
enum ConfigTarget {
  Process          = 'process',           // evolclaw.json
  Defaults         = 'defaults',          // agents/defaults.json
  Agent            = 'agent',             // agents/{aid}/config.json
  Relation         = 'relation',          // relations/{peerKey}/config.json
  Behavior         = 'behavior',          // agents/{aid}/behavior.json
  RelationBehavior = 'relation-behavior', // relations/{peerKey}/behavior.json
}
```

---

## 四、Selector 定义

```typescript
interface Selector {
  self?: string;      // Agent AID
  peerKey?: string;   // 关系 key（格式：{channel}#{peerId}）
}
```

### Selector 示例

```typescript
// 全局级
{ }

// agent 级
{ self: "bot1.aid.pub" }

// 关系级
{ self: "bot1.aid.pub", peerKey: "aun#alice.aid.pub" }
```

---

## 五、read() 方法

### 签名

```typescript
read<T>(target: ConfigTarget, selector?: Selector): T | null
```

### 功能

- 读取单个配置文件，返回强类型对象
- 不存在返回 `null`（不自动创建）
- 走 mtime 门控缓存

### 示例

```typescript
// 读取 process 级配置
const processConfig = configManager.read<ProcessConfig>(ConfigTarget.Process);

// 读取 agent 级配置
const agentConfig = configManager.read<AgentConfig>(
  ConfigTarget.Agent,
  { self: "bot1.aid.pub" }
);

// 读取关系级配置
const relationConfig = configManager.read<RelationConfig>(
  ConfigTarget.Relation,
  { self: "bot1.aid.pub", peerKey: "aun#alice.aid.pub" }
);
```

### 返回值

- 成功：返回强类型对象
- 文件不存在：返回 `null`
- 解析错误：抛出异常

---

## 六、write() 方法

### 签名

```typescript
write<T>(target: ConfigTarget, value: T, opts?: WriteOpts): void

interface WriteOpts {
  merge?: boolean;    // 是否与现有内容合并（默认 false，整体覆盖）
  validate?: boolean; // 是否 schema 验证（默认 true）
}
```

### 功能

写入前：
1. Schema 验证（如果 `validate: true`）
2. 文件不存在则 `ensureFile`
3. 原子写入（写临时文件 + rename）

**不做 pre-change 快照**：
- 人工编辑统一在启动时由 P2 捕获（W≠w-version 自动建版本）
- 写路径不耦合快照

### 示例

```typescript
// 整体覆盖
configManager.write(
  ConfigTarget.Agent,
  { aid: "bot1.aid.pub", enabled: true, channels: [] },
  { self: "bot1.aid.pub" }
);

// 合并写入
configManager.write(
  ConfigTarget.Agent,
  { chatmode: { private: "proactive" } },
  { self: "bot1.aid.pub", merge: true }
);
```

---

## 七、resolveAgentConfig() 方法

### 签名

```typescript
resolveAgentConfig(selector: Selector): AgentConfig
```

### 功能

H 链合并：`defaults → agent/config → relation/config`。
运行时 effective 还会叠加 HA 行为链：`agent/behavior → roles.<role> → relation/behavior`。

### 实现

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

### 合并规则

- 标量：高优先级覆盖
- 列表：并集去重
- 字典：键并集，同键高优先级覆盖（不递归）

详见 [02-merge-rules.md](./02-merge-rules.md)。

### 示例

```typescript
// agent 级配置
const agentEffective = configManager.resolveAgentConfig({
  self: "bot1.aid.pub"
});

// 关系级配置
const relationEffective = configManager.resolveAgentConfig({
  self: "bot1.aid.pub",
  peerKey: "aun#alice.aid.pub"
});
```

---

## 八、resolveEffectiveAgentConfig() 方法

### 签名

```typescript
resolveEffectiveAgentConfig(selector: Selector): EffectiveAgentConfig
```

### 功能

返回运行时完整配置（覆盖链合并结果）。

### 实现

```typescript
resolveEffectiveAgentConfig(selector: Selector): EffectiveAgentConfig {
  const merged = this.resolveAgentConfig(selector);
  
  return {
    $schema_version: merged.$schema_version ?? 1,
    aid: merged.aid!,
    enabled: merged.enabled,
    owners: merged.owners,
    admins: merged.admins,
    channels: merged.channels || [],
    // 所有其他字段...
    models: merged.models,
    active_baseagent: merged.active_baseagent,
    baseagents: merged.baseagents,
    chatmode: merged.chatmode,
    flush_delay: merged.flush_delay,
    debounce: merged.debounce,
    dispatch: merged.dispatch,
    show_activities: merged.show_activities,
    proactive: merged.proactive,
    render: merged.render,
    enable_rich_content: merged.enable_rich_content,
    permissionMode: merged.permissionMode,
    roles: merged.roles,
    // ...
  };
}
```

### 与 resolveAgentConfig 的区别

- `resolveAgentConfig`：返回 AgentConfig（覆盖链合并，字段 optional）
- `resolveEffectiveAgentConfig`：返回 EffectiveAgentConfig（扁平化，方便下游使用）

---

## 九、ensureFile() 方法

### 签名

```typescript
ensureFile(target: ConfigTarget, selector?: Selector): void
```

### 功能

按 schema 的 required + default 生成骨架并写入（幂等）。

### 示例

```typescript
// 确保 agent 配置文件存在
configManager.ensureFile(ConfigTarget.Agent, { self: "bot1.aid.pub" });
```

### 生成内容

```json
{
  "$schema_version": 1,
  "aid": "bot1.aid.pub",
  "channels": []
}
```

---

## 十、snapshot() 方法

### 签名

```typescript
snapshot(opts?: SnapshotOpts): SnapshotResult

interface SnapshotOpts {
  full?: boolean;           // 强制全量快照
  trigger?: string;         // 触发原因
  description?: string;     // 描述
}

interface SnapshotResult {
  version: string;          // 版本号（如 "v103"）
  type: 'full' | 'delta';   // 类型
  changedFiles: string[];   // 变更的文件
}
```

### 功能

触发配置快照。详见 [05-snapshot.md](./05-snapshot.md)。

---

## 十一、缓存策略

### 读取缓存

- 使用 mtime 门控缓存（复用现有 `fileCache`）
- 文件未变更则返回缓存
- 文件变更则重新读取

### 写入失效

- 写入后主动 invalidate 对应 cache entry
- CLI 子进程与 daemon 共用同一缓存接口

---

## 十二、${VAR} 展开（expandEnvRefs）

### 功能

`read` 返回后、交付消费方前，ConfigManager 内部按优先级展开 `${VAR}` 引用。

### 优先级

```
关系级 .env > agent 级 .env > 全局 .env > process.env
```

### 安全保证

**展开仅发生在运行时内部消费路径**：
- CLI 读命令调用的是「不展开」的读路径
- 确保 .env 明文不经 CLI 回流

### 实现

```typescript
private expandEnvRefs(value: any, selector: Selector): any {
  if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
    const varName = value.slice(2, -1);
    // 按优先级查找
    return this.lookupEnv(varName, selector) || value;
  }
  if (Array.isArray(value)) {
    return value.map(v => this.expandEnvRefs(v, selector));
  }
  if (typeof value === 'object' && value !== null) {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = this.expandEnvRefs(v, selector);
    }
    return result;
  }
  return value;
}
```

---

## 十三、取代现有代码

ConfigManager 是全新模块，**不包旧函数**。

| 现有 | 新接口 | 说明 |
|------|--------|------|
| `config-store.ts` 的 `load*/save*` | `read`/`write` | 按 ConfigTarget |
| `config-store.ts` 的 `mergeForAgent` | `resolveAgentConfig` | 三级深合并，语义不同 |
| `config-store.ts` 的 `validateAgentConfig` | ajv schema 校验 | 内置于 write |
| `config-store.ts` 的 `ensureAgentDirSkeleton` | `ensureFile` | 按 schema 生成 |
| `config-store.ts` 的 `expandEnvRefs` | 迁入 ConfigManager | 三级 .env 解析 |
| `model-scope.ts` 的 `resolveEffectiveModel` | `resolveAgentConfig` | 逐级深合并 |
| `model-scope.ts` 的 `readScope/writeScope` | `read`/`write` | 通用接口 |
| `agent.ts` 的 `agentSet/agentGet` | 改走 ConfigManager | 删特判 |
| 关系级 `preferences.json` | 删除 | 并入 relation config.json |

### 为什么不包一层

旧 `mergeForAgent`/`resolveEffectiveModel` 与新合并语义不同，包装会同时保留两套合并逻辑，违反"全项目唯一合并实现点"硬约束。

---

## 十四、使用示例

### 读取配置

```typescript
// 读取单个配置文件
const agentConfig = configManager.read<AgentConfig>(
  ConfigTarget.Agent,
  { self: "bot1.aid.pub" }
);

// 读取合并后的配置
const effective = configManager.resolveEffectiveAgentConfig({
  self: "bot1.aid.pub",
  peerKey: "aun#alice.aid.pub"
});

console.log(effective.chatmode?.private);  // "proactive"
```

### 写入配置

```typescript
// 修改 agent 级配置
configManager.write(
  ConfigTarget.Agent,
  { chatmode: { private: "proactive" } },
  { self: "bot1.aid.pub", merge: true }
);

// 修改关系级配置
configManager.write(
  ConfigTarget.Relation,
  { 
    baseagents: { 
      claude: { model: "opus", effort: "max" } 
    } 
  },
  { self: "bot1.aid.pub", peerKey: "aun#alice.aid.pub", merge: true }
);
```

### 创建快照

```typescript
const result = configManager.snapshot({
  trigger: 'manual',
  description: '修改 alice 的模型配置'
});

console.log(`创建快照 ${result.version}，变更 ${result.changedFiles.length} 个文件`);
```

---

## 十五、来源追溯机制

### 追溯接口

```typescript
interface SourceTrace {
  field: string;
  effectiveValue: any;
  sources: Array<{
    layer: 'defaults' | 'agent' | 'relation';
    value: any;
    isEffective: boolean;
    filePath: string;
  }>;
}

// 获取参数来源追溯
configManager.trace(field: string, selector: Selector): SourceTrace
```

### 实现示例

```typescript
const trace = configManager.trace('chatmode.private', {
  self: 'bot1.aid.pub',
  peerKey: 'aun#alice.aid.pub'
});

console.log(trace);
// 输出:
// {
//   field: 'chatmode.private',
//   effectiveValue: 'proactive',
//   sources: [
//     { layer: 'defaults', value: undefined, isEffective: false, filePath: '~/.evolclaw/agents/defaults.json' },
//     { layer: 'agent', value: 'interactive', isEffective: false, filePath: '~/.evolclaw/agents/bot1.aid.pub/config.json' },
//     { layer: 'relation', value: 'proactive', isEffective: true, filePath: '~/.evolclaw/agents/bot1.aid.pub/relations/aun#alice.aid.pub/config.json' }
//   ]
// }
```

### CLI 集成

`ec config get` 命令内部调用 trace 接口：

```bash
ec config get chatmode.private --self bot1 --peer aun#alice

# 输出:
# chatmode.private = proactive          # effective
#   解析链（低 → 高）：
#     defaults  : (未定义)
#     agent     : interactive
#     relation  : proactive   ← 命中
```

---

## 十六、错误处理

### 错误类型定义

```typescript
// 配置错误基类
class ConfigError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Schema 验证错误
class SchemaValidationError extends ConfigError {
  constructor(
    public field: string,
    public expectedType: string,
    public actualValue: any,
    public schemaErrors: any[]
  ) {
    super(
      `Schema validation failed for ${field}: expected ${expectedType}`,
      'SCHEMA_VALIDATION_FAILED',
      { field, expectedType, actualValue, schemaErrors }
    );
  }
}

// 文件不存在错误
class ConfigFileNotFoundError extends ConfigError {
  constructor(
    public target: ConfigTarget,
    public selector: Selector,
    public filePath: string
  ) {
    super(
      `Config file not found: ${filePath}`,
      'CONFIG_FILE_NOT_FOUND',
      { target, selector, filePath }
    );
  }
}

// 权限错误
class ConfigPermissionError extends ConfigError {
  constructor(
    public operation: string,
    public field: string,
    public caller: string
  ) {
    super(
      `Permission denied: ${caller} cannot ${operation} field ${field}`,
      'PERMISSION_DENIED',
      { operation, field, caller }
    );
  }
}

// 并发冲突错误
class ConfigConflictError extends ConfigError {
  constructor(
    public target: ConfigTarget,
    public selector: Selector,
    public expectedVersion: string,
    public actualVersion: string
  ) {
    super(
      `Config file was modified by another process`,
      'CONCURRENT_MODIFICATION',
      { target, selector, expectedVersion, actualVersion }
    );
  }
}
```

### 错误处理策略

```typescript
try {
  configManager.write(ConfigTarget.Agent, newConfig, { self: 'bot1.aid.pub' });
} catch (error) {
  if (error instanceof SchemaValidationError) {
    // Schema 验证失败
    console.error(`字段 ${error.field} 类型错误`);
    console.error(`期望: ${error.expectedType}`);
    console.error(`实际: ${JSON.stringify(error.actualValue)}`);
    console.error(`详细错误:`, error.schemaErrors);
  } else if (error instanceof ConfigFileNotFoundError) {
    // 文件不存在
    console.error(`配置文件不存在: ${error.filePath}`);
    console.log(`提示: 使用 ec config init --self ${error.selector.self} 创建`);
  } else if (error instanceof ConfigPermissionError) {
    // 权限不足
    console.error(`权限不足: ${error.caller} 不能修改 ${error.field}`);
  } else if (error instanceof ConfigConflictError) {
    // 并发冲突
    console.error(`配置文件已被其他进程修改，请重试`);
  } else {
    // 其他错误
    throw error;
  }
}
```

---

## 十七、并发控制与原子性

### 乐观锁机制

ConfigManager 使用 mtime 实现乐观锁：

```typescript
class ConfigManager {
  write<T>(target: ConfigTarget, value: T, opts: WriteOpts): void {
    const filePath = this.resolvePath(target, opts.selector);
    
    // 1. 读取当前文件和 mtime
    const currentContent = fs.readFileSync(filePath, 'utf8');
    const currentMtime = fs.statSync(filePath).mtimeMs;
    
    // 2. 合并内容
    const newContent = opts.merge 
      ? deepMerge(JSON.parse(currentContent), value)
      : value;
    
    // 3. Schema 验证
    this.validate(target, newContent);
    
    // 4. 原子写入（写临时文件 + rename）
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(newContent, null, 2));
    
    // 5. 检查 mtime（乐观锁）
    const latestMtime = fs.statSync(filePath).mtimeMs;
    if (latestMtime !== currentMtime) {
      fs.unlinkSync(tmpPath);
      throw new ConfigConflictError(target, opts.selector, currentMtime.toString(), latestMtime.toString());
    }
    
    // 6. 原子替换
    fs.renameSync(tmpPath, filePath);
    
    // 7. 清除缓存
    this.invalidateCache(filePath);
  }
}
```

### 原子性保证

**写入原子性**：
1. 写入临时文件（`.tmp.{timestamp}`）
2. 验证成功后 `rename` 替换原文件
3. `rename` 在大多数文件系统上是原子操作

**读取一致性**：
1. 使用 mtime 门控缓存
2. 文件变更后缓存失效
3. 重新读取最新内容

**并发写入处理**：
1. 乐观锁检测并发修改
2. 冲突时抛出 `ConfigConflictError`
3. 调用方重试（读取最新 → 合并 → 再次写入）

### 并发场景示例

```typescript
// 场景：两个进程同时修改同一个配置文件

// 进程 A
try {
  configManager.write(ConfigTarget.Behavior, { chatmode: { private: 'proactive' } }, {
    self: 'bot1.aid.pub',
    merge: true
  });
} catch (error) {
  if (error instanceof ConfigConflictError) {
    // 重试：重新读取 + 合并 + 写入
    const current = configManager.read(ConfigTarget.Behavior, { self: 'bot1.aid.pub' });
    const merged = deepMerge(current, { chatmode: { private: 'proactive' } });
    configManager.write(ConfigTarget.Behavior, merged, { self: 'bot1.aid.pub' });
  }
}
```

---

## 十八、Debug 模式

### 启用 Debug

```bash
# 环境变量
DEBUG=evolclaw:config ec start

# 或在代码中
configManager.enableDebug(true);
```

### Debug 输出

```typescript
class ConfigManager {
  private debug: boolean = process.env.DEBUG?.includes('evolclaw:config') || false;
  
  read<T>(target: ConfigTarget, selector?: Selector): T | null {
    if (this.debug) {
      console.log(`[ConfigManager] read(${target}, ${JSON.stringify(selector)})`);
    }
    
    const filePath = this.resolvePath(target, selector);
    
    if (this.debug) {
      console.log(`[ConfigManager]   → ${filePath}`);
    }
    
    // 检查缓存
    const cached = this.cache.get(filePath);
    if (cached) {
      if (this.debug) {
        console.log(`[ConfigManager]   ✓ cache hit`);
      }
      return cached as T;
    }
    
    // 读取文件
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    
    if (this.debug) {
      console.log(`[ConfigManager]   ✓ loaded, ${Object.keys(parsed).length} keys`);
    }
    
    this.cache.set(filePath, parsed);
    return parsed;
  }
}
```

### Debug 信息示例

```
[ConfigManager] resolveAgentConfig({ self: 'bot1.aid.pub', peerKey: 'aun#alice.aid.pub' })
[ConfigManager]   read(defaults, undefined)
[ConfigManager]     → ~/.evolclaw/agents/defaults.json
[ConfigManager]     ✓ cache hit
[ConfigManager]   read(agent, { self: 'bot1.aid.pub' })
[ConfigManager]     → ~/.evolclaw/agents/bot1.aid.pub/config.json
[ConfigManager]     ✓ loaded, 8 keys
[ConfigManager]   read(relation, { self: 'bot1.aid.pub', peerKey: 'aun#alice.aid.pub' })
[ConfigManager]     → ~/.evolclaw/agents/bot1.aid.pub/relations/aun#alice.aid.pub/config.json
[ConfigManager]     ✓ loaded, 3 keys
[ConfigManager]   deepMerge: 3 layers
[ConfigManager]     defaults: 15 keys
[ConfigManager]     agent: 8 keys (5 overrides)
[ConfigManager]     relation: 3 keys (2 overrides)
[ConfigManager]   ✓ merged, 18 keys total
```

---

## 十九、性能优化

### 缓存策略

```typescript
interface CacheEntry<T> {
  value: T;
  mtime: number;
  expiresAt: number;
}

class ConfigManager {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private cacheTTL: number = 5000; // 5 秒
  
  private getCached<T>(filePath: string): T | null {
    const entry = this.cache.get(filePath);
    if (!entry) return null;
    
    // 检查 TTL
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(filePath);
      return null;
    }
    
    // 检查 mtime
    const currentMtime = fs.statSync(filePath).mtimeMs;
    if (currentMtime !== entry.mtime) {
      this.cache.delete(filePath);
      return null;
    }
    
    return entry.value;
  }
  
  private setCache<T>(filePath: string, value: T): void {
    const mtime = fs.statSync(filePath).mtimeMs;
    this.cache.set(filePath, {
      value,
      mtime,
      expiresAt: Date.now() + this.cacheTTL
    });
  }
}
```

### 批量操作优化

```typescript
// 批量读取多个 agent 的配置
async function batchReadAgentConfigs(aids: string[]): Promise<Map<string, AgentConfig>> {
  const results = new Map();
  
  // 并行读取
  await Promise.all(
    aids.map(async (aid) => {
      const config = configManager.read(ConfigTarget.Agent, { self: aid });
      results.set(aid, config);
    })
  );
  
  return results;
}
```

---

## 二十、扩展点设计

### Hook 接口

```typescript
interface ConfigHook {
  beforeRead?(target: ConfigTarget, selector: Selector): void;
  afterRead?<T>(target: ConfigTarget, selector: Selector, value: T): T;
  beforeWrite?<T>(target: ConfigTarget, value: T, opts: WriteOpts): T;
  afterWrite?(target: ConfigTarget, selector: Selector): void;
}

class ConfigManager {
  private hooks: ConfigHook[] = [];
  
  registerHook(hook: ConfigHook): void {
    this.hooks.push(hook);
  }
  
  read<T>(target: ConfigTarget, selector?: Selector): T | null {
    // 调用 beforeRead hooks
    for (const hook of this.hooks) {
      hook.beforeRead?.(target, selector);
    }
    
    // 读取
    let value = this._readImpl(target, selector);
    
    // 调用 afterRead hooks
    for (const hook of this.hooks) {
      if (hook.afterRead) {
        value = hook.afterRead(target, selector, value);
      }
    }
    
    return value;
  }
}
```

### Hook 使用示例

```typescript
// 审计日志 hook
configManager.registerHook({
  afterWrite(target, selector) {
    auditLog.write({
      timestamp: Date.now(),
      action: 'config.write',
      target,
      selector,
      caller: getCurrentCaller()
    });
  }
});

// 通知 hook
configManager.registerHook({
  afterWrite(target, selector) {
    // 广播配置变更事件
    eventBus.emit('config:changed', { target, selector });
  }
});
```

---

## 相关文档

- [01-overview.md](./01-overview.md) - 总体架构
- [02-merge-rules.md](./02-merge-rules.md) - 覆盖链与合并规则
- [03-schema.md](./03-schema.md) - Schema 治理
- [05-snapshot.md](./05-snapshot.md) - 快照与回滚机制
- [code-refactoring-plan.md](./code-refactoring-plan.md) - 代码改造清单

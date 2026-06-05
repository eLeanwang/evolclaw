# 渠道插件化改造设计方案

## 一、改造目标

### 1.1 当前问题

index.ts 中渠道接入代码存在以下问题：

1. **代码重复**：每个渠道都有类似的初始化、注册、连接逻辑（~80行/渠道）
2. **修改频繁**：新增渠道需要修改 index.ts 的多个位置（实例化、注册、连接、关闭）
3. **职责不清**：index.ts 既负责服务编排，又负责渠道接入细节
4. **依赖复杂**：渠道接入需要访问 6-7 个核心组件
5. **错误处理不统一**：各渠道的错误处理策略不一致

### 1.2 改造目标

将渠道接入逻辑从 index.ts 迁移到各渠道文件，实现：

1. **开闭原则**：新增渠道只需添加文件，无需修改 index.ts
2. **职责单一**：index.ts 只负责服务编排，渠道负责自己的接入逻辑
3. **接口统一**：所有渠道实现统一的 ChannelPlugin 接口
4. **错误隔离**：单个渠道失败不影响其他渠道
5. **生命周期清晰**：明确的初始化、连接、断开钩子

## 二、设计方案

### 2.1 核心接口

#### ChannelPlugin 接口

```typescript
// src/core/channel-plugin.ts
export interface ChannelPlugin {
  // 基本信息
  readonly name: string;
  readonly enabled: boolean;
  
  // 生命周期钩子
  initialize(context: PluginContext): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // 可选能力
  getAdapter?(): ChannelAdapter;
  onError?(error: Error): void;
}
```

**设计说明：**
- `name`：渠道标识符（'feishu', 'wechat', 'aun'）
- `enabled`：是否启用（从 config 读取）
- `initialize()`：初始化渠道实例、注册 adapter、设置回调
- `connect()`：建立连接（WebSocket、HTTP 轮询等）
- `disconnect()`：断开连接、清理资源
- `getAdapter()`：返回 ChannelAdapter 包装器（可选，用于消息发送）
- `onError()`：错误处理回调（可选）

#### PluginContext 接口

```typescript
export interface PluginContext {
  config: Config;
  sessionManager: SessionManager;
  processor: MessageProcessor;
  cmdHandler: CommandHandler;
  messageQueue: MessageQueue;
  eventBus: EventBus;
}
```

**设计说明：**
- 封装所有渠道可能需要的依赖
- 避免参数爆炸（6个参数 → 1个对象）
- 便于未来扩展（新增依赖不影响接口签名）

### 2.2 插件加载器

#### ChannelLoader 类

```typescript
// src/core/channel-loader.ts
export class ChannelLoader {
  private plugins: Map<string, ChannelPlugin> = new Map();
  private context: PluginContext;
  
  constructor(context: PluginContext);
  register(plugin: ChannelPlugin): void;
  async initializeAll(): Promise<void>;
  async connectAll(): Promise<string[]>;
  async disconnectAll(): Promise<void>;
  getPlugin(name: string): ChannelPlugin | undefined;
}
```

**职责：**
1. 管理所有渠道插件的注册
2. 统一初始化流程（串行，带错误处理）
3. 统一连接流程（并行，失败不影响其他）
4. 统一断开流程（优雅关闭）

### 2.3 渠道实现

每个渠道实现 ChannelPlugin 接口：

```typescript
// src/channels/feishu.ts
export class FeishuChannelPlugin implements ChannelPlugin {
  readonly name = 'feishu';
  private channel: FeishuChannel | null = null;
  private context: PluginContext | null = null;
  
  get enabled(): boolean {
    return this.context?.config.channels?.feishu?.enabled !== false;
  }
  
  async initialize(context: PluginContext): Promise<void> {
    // 1. 保存 context
    // 2. 创建 FeishuChannel 实例
    // 3. 设置回调（onProjectPathRequest）
    // 4. 创建并注册 ChannelAdapter
    // 5. 注册 Policy
    // 6. 连接消息流（MsgBridge.register）
  }
  
  async connect(): Promise<void> {
    // 调用 channel.connect()
  }
  
  async disconnect(): Promise<void> {
    // 调用 channel.disconnect()
  }
  
  getAdapter(): ChannelAdapter | undefined {
    // 返回 adapter 包装器
  }
}
```

## 三、文件结构变化

### 3.1 新增文件

```
src/
├── core/
│   ├── channel-plugin.ts       # 新增：ChannelPlugin 接口定义
│   └── channel-loader.ts       # 新增：ChannelLoader 类
├── channels/
│   ├── feishu.ts               # 修改：导出 FeishuChannelPlugin
│   ├── wechat.ts               # 修改：导出 WechatChannelPlugin
│   └── aun.ts                  # 修改：导出 AUNChannelPlugin
└── index.ts                    # 修改：简化为服务编排
```

### 3.2 代码量变化

| 文件 | 当前行数 | 改造后行数 | 变化 |
|------|---------|-----------|------|
| index.ts | 489 | ~300 | -189 |
| feishu.ts | 653 | ~750 | +97 |
| wechat.ts | ~500 | ~580 | +80 |
| aun.ts | ~200 | ~250 | +50 |
| channel-plugin.ts | 0 | ~50 | +50 |
| channel-loader.ts | 0 | ~100 | +100 |
| **总计** | ~1842 | ~2030 | +188 |

**说明：**
- index.ts 大幅简化（-189行）
- 各渠道文件增加插件实现代码（+80-100行/渠道）
- 新增接口和加载器（+150行）
- 总代码量略增（+188行），但结构更清晰

## 四、实现计划

### 4.1 阶段划分

#### 阶段 1：定义接口和加载器（2小时）

**任务：**
1. 创建 `src/core/channel-plugin.ts`
   - 定义 ChannelPlugin 接口
   - 定义 PluginContext 接口
2. 创建 `src/core/channel-loader.ts`
   - 实现 ChannelLoader 类
   - 实现错误处理逻辑
3. 编写单元测试
   - 测试插件注册
   - 测试初始化流程
   - 测试错误隔离

**验收标准：**
- 接口定义清晰，类型检查通过
- ChannelLoader 单元测试通过
- 文档完善（JSDoc 注释）

#### 阶段 2：迁移 Feishu 渠道（3小时）

**任务：**
1. 在 `src/channels/feishu.ts` 中实现 FeishuChannelPlugin
   - 将 index.ts 中的 Feishu 初始化逻辑迁移到 initialize()
   - 实现 connect/disconnect 方法
   - 实现 getAdapter() 方法
2. 修改 index.ts
   - 创建 PluginContext
   - 创建 ChannelLoader
   - 注册 FeishuChannelPlugin
   - 调用 initializeAll/connectAll
3. 测试验证
   - 运行集成测试
   - 手动测试 Feishu 消息收发
   - 验证错误处理

**验收标准：**
- Feishu 渠道功能完全正常
- 所有测试通过
- 代码审查通过

#### 阶段 3：迁移 WeChat 和 AUN 渠道（3小时）

**任务：**
1. 实现 WechatChannelPlugin
2. 实现 AUNChannelPlugin
3. 在 index.ts 中注册两个插件
4. 清理 index.ts 中的旧代码
5. 完整测试

**验收标准：**
- 所有渠道功能正常
- 所有测试通过（310+ tests）
- index.ts 代码简洁清晰

#### 阶段 4：优化和文档（1小时）

**任务：**
1. 代码优化
   - 提取公共逻辑
   - 优化错误消息
   - 添加日志
2. 文档更新
   - 更新 CLAUDE.md
   - 更新 docs/architecture.md
   - 添加插件开发指南
3. 最终测试
   - 完整回归测试
   - 性能测试
   - 错误场景测试

**验收标准：**
- 代码质量高
- 文档完善
- 所有测试通过

### 4.2 时间估算

| 阶段 | 预计时间 | 风险缓冲 | 总计 |
|------|---------|---------|------|
| 阶段1 | 2小时 | 0.5小时 | 2.5小时 |
| 阶段2 | 3小时 | 1小时 | 4小时 |
| 阶段3 | 3小时 | 1小时 | 4小时 |
| 阶段4 | 1小时 | 0.5小时 | 1.5小时 |
| **总计** | **9小时** | **3小时** | **12小时** |

## 五、技术细节

### 5.1 初始化顺序

插件初始化采用**串行**方式，确保顺序可控：

```typescript
async initializeAll(): Promise<void> {
  for (const [name, plugin] of this.plugins) {
    if (!plugin.enabled) continue;
    
    try {
      await plugin.initialize(this.context);
      logger.info(`✓ ${name} initialized`);
    } catch (error) {
      logger.error(`✗ ${name} initialization failed:`, error);
      plugin.onError?.(error as Error);
      // 继续初始化其他插件，不中断
    }
  }
}
```

**设计理由：**
- 串行初始化：确保初始化顺序可控，便于调试
- 错误不中断：单个插件失败不影响其他插件
- 日志清晰：每个插件的初始化结果都有明确日志

### 5.2 连接流程

插件连接采用**并行**方式，提高启动速度：

```typescript
async connectAll(): Promise<string[]> {
  const results = await Promise.allSettled(
    Array.from(this.plugins.values())
      .filter(p => p.enabled)
      .map(async p => {
        await p.connect();
        return p.name;
      })
  );
  
  const connected = results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<string>).value);
  
  return connected;
}
```

**设计理由：**
- 并行连接：提高启动速度（Feishu WebSocket 可能较慢）
- Promise.allSettled：失败不影响其他插件
- 返回成功列表：便于日志输出

### 5.3 错误处理策略

| 阶段 | 错误类型 | 处理策略 |
|------|---------|---------|
| 注册 | 重复注册 | 抛出异常（编程错误） |
| 初始化 | 配置错误 | 记录日志，跳过该插件 |
| 初始化 | 依赖缺失 | 记录日志，跳过该插件 |
| 连接 | 网络错误 | 记录警告，继续其他插件 |
| 运行时 | 消息处理错误 | 由 MessageProcessor 处理 |
| 断开 | 清理失败 | 记录错误，继续其他插件 |

### 5.4 向后兼容

改造过程中保持向后兼容：

1. **配置文件**：无需修改 evolclaw.json
2. **数据库**：无需修改 sessions.db 结构
3. **API**：ChannelAdapter 接口不变
4. **行为**：消息处理逻辑不变

## 六、测试策略

### 6.1 单元测试

新增测试文件：

```
tests/
├── unit/
│   ├── channel-plugin.test.ts      # ChannelPlugin 接口测试
│   └── channel-loader.test.ts      # ChannelLoader 类测试
└── integration/
    └── channel-plugin-integration.test.ts  # 插件集成测试
```

**测试覆盖：**
- ChannelLoader 注册、初始化、连接、断开
- 错误隔离（一个插件失败不影响其他）
- 生命周期钩子调用顺序
- PluginContext 依赖注入

### 6.2 集成测试

复用现有集成测试：

```bash
npm test  # 所有测试必须通过（310+ tests）
```

**重点验证：**
- Feishu 消息收发
- WeChat 消息收发
- AUN 消息收发
- 多渠道并发
- 错误恢复

### 6.3 手动测试

**测试场景：**
1. 单渠道启动（只启用 Feishu）
2. 多渠道启动（Feishu + WeChat）
3. 配置错误（缺少 appId）
4. 网络错误（连接失败）
5. 运行时错误（消息处理异常）
6. 优雅关闭（SIGINT/SIGTERM）

## 七、风险评估

### 7.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 初始化顺序问题 | 低 | 中 | 串行初始化，明确顺序 |
| 错误处理遗漏 | 中 | 中 | 完善测试，代码审查 |
| 性能下降 | 低 | 低 | 并行连接，性能测试 |
| 向后兼容问题 | 低 | 高 | 保持接口不变，充分测试 |

### 7.2 进度风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 时间估算不准 | 中 | 中 | 预留 3 小时缓冲 |
| 测试发现问题 | 中 | 中 | 分阶段验收，及时修复 |
| 需求变更 | 低 | 高 | 先沟通设计，再实施 |

## 八、后续优化

改造完成后，可以进一步优化：

### 8.1 配置驱动加载

```typescript
// evolclaw.json
{
  "channels": {
    "enabled": ["feishu", "wechat"],  // 配置启用的渠道
    "feishu": { ... },
    "wechat": { ... }
  }
}
```

### 8.2 动态插件发现

```typescript
// 自动扫描 channels/ 目录
const plugins = await discoverPlugins('./channels');
plugins.forEach(p => loader.register(p));
```

### 8.3 插件依赖声明

```typescript
export class FeishuChannelPlugin implements ChannelPlugin {
  readonly dependencies = ['eventBus', 'sessionManager'];
  // ...
}
```

## 九、决策点

在开始实施前，需要确认以下决策：

### 9.1 接口设计

- [ ] ChannelPlugin 接口是否满足需求？
- [ ] PluginContext 是否包含所有必要依赖？
- [ ] 生命周期钩子是否足够？

### 9.2 实现细节

- [ ] 初始化采用串行还是并行？（建议：串行）
- [ ] 连接采用串行还是并行？（建议：并行）
- [ ] 错误处理策略是否合理？

### 9.3 迁移策略

- [ ] 是否分阶段迁移？（建议：是）
- [ ] 是否保留旧代码作为备份？（建议：使用 git）
- [ ] 是否需要灰度发布？（建议：不需要，本地项目）

### 9.4 测试要求

- [ ] 单元测试覆盖率要求？（建议：>80%）
- [ ] 是否需要性能测试？（建议：简单对比即可）
- [ ] 是否需要压力测试？（建议：不需要）

## 十、总结

### 10.1 改造价值

**短期价值：**
- 代码结构更清晰
- 职责划分更明确
- 错误处理更统一

**长期价值：**
- 新增渠道成本降低（无需修改 index.ts）
- 维护成本降低（渠道逻辑内聚）
- 扩展性更好（统一接口）

### 10.2 投入产出比

- **投入**：9-12 小时开发时间
- **产出**：
  - 新增渠道时间从 2-3 小时降低到 1-1.5 小时
  - 维护成本降低 30%
  - 代码可读性提升

**结论**：如果未来计划接入 3+ 个新渠道，改造是值得的。

---

**文档版本**：v1.0  
**创建时间**：2026-04-01  
**作者**：Claude  
**状态**：待审核

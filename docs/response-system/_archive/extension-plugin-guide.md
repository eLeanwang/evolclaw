# 扩展插件开发与打包指南

本文档指导如何将响应模式插件独立打包成 npm 包，供 EvolClaw 动态加载。

## 为什么独立打包

**内置模式**（`src/response-modes/core/`）与 EvolClaw 核心一起发布，适合通用场景。  
**扩展插件**（独立 npm 包）适合：
- 特定业务场景（如公司内部工作流）
- 实验性模式（不成熟，不放入核心）
- 第三方社区贡献
- 需要独立版本管理的模式

独立打包后，用户通过 `npm install @your-org/evolclaw-response-xxx` 安装，EvolClaw 自动发现并加载。

---

## 插件包结构

```
@your-org/evolclaw-response-your-mode/
├── package.json
├── src/
│   └── index.ts          # 导出 ResponseMode 实现
├── tsconfig.json
├── README.md
└── dist/                 # 构建产物（发布到 npm）
    └── index.js
```

### package.json

```json
{
  "name": "@your-org/evolclaw-response-your-mode",
  "version": "1.0.0",
  "description": "Your custom response mode for EvolClaw",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "keywords": ["evolclaw", "response-mode", "plugin"],
  "peerDependencies": {
    "evolclaw": "^0.x.x"
  },
  "devDependencies": {
    "evolclaw": "^0.x.x",
    "typescript": "^5.0.0"
  }
}
```

**关键点**：
- `peerDependencies` 声明 `evolclaw`（避免重复安装核心）
- `keywords` 包含 `evolclaw-response-mode`（便于发现）

---

## 实现插件类

### src/index.ts

```typescript
import type {
  ResponseMode,
  InboundMessage,
  InboundDecision,
  OutboundPayload,
  OutboundDecision,
  ResponseModeContext,
  MessageQueueInterface,
  JSONSchema,
} from 'evolclaw/response-modes';

export class YourCustomMode implements ResponseMode {
  // ─── 元数据 ───
  readonly id = 'your-custom-mode';
  readonly displayName = '你的自定义模式';
  readonly description = '模式功能简述';
  readonly type = 'extension' as const;
  readonly applicableScenes = ['private', 'group'] as const;

  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      your_param: { type: 'boolean', description: '参数说明', default: true },
    },
  };

  // ─── 运行时状态 ───
  private context!: ResponseModeContext;
  private queue!: MessageQueueInterface;

  // ─── 生命周期 ───
  async initialize(context: ResponseModeContext): Promise<void> {
    this.context = context;
    // 初始化逻辑（如读取配置、设置定时器）
    const config = context.modeConfig; // 当前模式的配置
    context.logger.info(`[YourCustomMode] Initialized with config: ${JSON.stringify(config)}`);
  }

  async cleanup(): Promise<void> {
    // 清理资源（如关闭定时器、保存状态）
    this.context.logger.info(`[YourCustomMode] Cleanup`);
  }

  // ─── 核心能力 ───
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 入站决策：决定这条消息怎么处理
    // 例：私聊立即处理，群聊仅响应 @提及
    if (message.chatType === 'private') {
      return { action: 'process', queueBehavior: 'enqueue', reason: '私聊消息直接处理' };
    }
    if (message.isMentioned) {
      return { action: 'process', queueBehavior: 'priority', reason: '群聊@提及优先处理' };
    }
    return { action: 'drop', reason: '群聊未@不响应' };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    // 出站决策：决定这个输出怎么发
    // 例：普通文本直接发送
    if (payload.kind === 'result.text') {
      return { method: 'direct', type: 'message', reason: '文本直接发送' };
    }
    return { method: 'direct', reason: '默认直接发送' };
  }

  getQueue(): MessageQueueInterface {
    // 返回队列实例（简单模式用默认队列，复杂模式可自定义）
    if (!this.queue) {
      this.queue = this.context.session.queue; // 使用会话默认队列
    }
    return this.queue;
  }

  // ─── 可选钩子 ───
  // 以下钩子按需实现，不需要的可以不写

  beforeProcess?(ctx: ProcessContext): Promise<void> | void {
    // 出队后、Runner 调用前：准备模式运行时状态
    ctx.state.set('your-mode', { customFlag: true });
  }

  configureRun?(ctx: ProcessContext): RunConfig | undefined {
    // 提供本次运行的配置（policyHook、renderer 抑制、系统提示变量）
    return {
      policyHook: (toolName, toolInput) => {
        // 示例：拦截某些工具调用
        if (toolName === 'ForbiddenTool') {
          return { block: true, reason: '此工具在当前模式下禁用' };
        }
      },
    };
  }

  onToolUse?(ctx: ToolUseContext): Promise<void> | void {
    // 工具调用事件（如记录、注入提醒）
    ctx.logger.debug(`[YourCustomMode] Tool used: ${ctx.toolName}`);
  }

  onComplete?(ctx: CompleteContext): Promise<void> | void {
    // 完成事件（如检查输出标志位、更新会话状态）
    ctx.logger.debug(`[YourCustomMode] Processing complete`);
  }

  afterProcess?(ctx: AfterProcessContext): Promise<void> | void {
    // Runner 返回后：后处理（如发送额外消息、清理临时状态）
    ctx.logger.debug(`[YourCustomMode] After process`);
  }
}

// 默认导出插件实例（EvolClaw 会调用此导出）
export default YourCustomMode;
```

---

## 类型导入

插件依赖 EvolClaw 的类型定义。确保 `tsconfig.json` 正确配置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
```

---

## 发布流程

### 1. 构建

```bash
npm run build  # 编译 TypeScript 到 dist/
```

### 2. 测试（本地链接）

在插件包目录：
```bash
npm link
```

在 EvolClaw 目录：
```bash
npm link @your-org/evolclaw-response-your-mode
```

配置文件中启用：
```json
{
  "response_modes": {
    "private": "your-custom-mode"
  }
}
```

启动 EvolClaw 验证插件加载。

### 3. 发布到 npm

```bash
npm publish --access public
```

---

## 用户安装与使用

### 安装

```bash
npm install -g @your-org/evolclaw-response-your-mode
```

或在 agent 项目目录安装：
```bash
cd ~/.evolclaw/agents/your-aid/
npm install @your-org/evolclaw-response-your-mode
```

### 配置

**全局配置**（`~/.evolclaw/config/global.json`）：
```json
{
  "response_modes": {
    "private": "your-custom-mode",
    "group": "your-custom-mode"
  },
  "response_mode_config": {
    "your-custom-mode": {
      "your_param": false
    }
  }
}
```

**Agent 级配置**（`~/.evolclaw/agents/<aid>/config.json`）：
```json
{
  "response_modes": {
    "aun": {
      "private": "your-custom-mode"
    }
  }
}
```

---

## 插件发现机制

EvolClaw 通过以下方式发现扩展插件：

1. **全局安装**：扫描 `npm root -g` 下所有 `@*/evolclaw-response-*` 或 `evolclaw-response-*` 包
2. **Agent 本地安装**：扫描 `~/.evolclaw/agents/<aid>/node_modules/` 下的同名包
3. **项目安装**（coding 模式）：扫描当前项目 `node_modules/` 下的同名包

加载优先级：Agent 本地 > 全局 > 项目。

---

## 开发建议

### 状态管理

响应模式是**无状态的单例**（每个会话共享同一个实例）。Per-session 状态存储方式：

```typescript
// 在 beforeProcess 中初始化
beforeProcess(ctx: ProcessContext): void {
  if (!ctx.state.has('your-mode')) {
    ctx.state.set('your-mode', { counter: 0 });
  }
}

// 在其他钩子中读写
onToolUse(ctx: ToolUseContext): void {
  const state = ctx.state.get('your-mode');
  state.counter++;
  ctx.logger.info(`Tool count: ${state.counter}`);
}
```

`ctx.state` 是 `Map<string, any>`，key 用模式 id 命名避免冲突。

### 日志

所有钩子的 ctx 都有 `logger`，使用它而不是 `console.log`：

```typescript
ctx.logger.debug('详细调试信息');
ctx.logger.info('一般信息');
ctx.logger.warn('警告');
ctx.logger.error('错误', error);
```

### 配置校验

如果模式有必填参数，在 `initialize` 里校验：

```typescript
async initialize(context: ResponseModeContext): Promise<void> {
  const config = context.modeConfig;
  if (!config.required_field) {
    throw new Error(`[YourMode] Missing required config: required_field`);
  }
  this.context = context;
}
```

### 异步操作

所有钩子都支持异步（返回 `Promise<void>`）。如果需要调用异步 API，直接 `await`：

```typescript
async onComplete(ctx: CompleteContext): Promise<void> {
  await ctx.updateSessionMeta({ lastCompleteTime: Date.now() });
}
```

---

## 示例插件

参考内置模式实现：
- **InteractiveMode**：`src/response-modes/core/interactive.ts`（简单模式，无钩子）
- **ProactiveMode**：`src/response-modes/core/proactive.ts`（复杂模式，全钩子）

---

## 注意事项

### 依赖管理

- **不要** 在插件包里打包 `evolclaw` 本身（用 `peerDependencies`）
- 插件的其他依赖（如 `lodash`）可以正常打包

### 版本兼容

- 插件的 `peerDependencies` 版本范围要宽松（如 `^0.x.x`）
- 破坏性变更时升级主版本号

### 安全

- 不要在插件里执行不受信任的代码
- 配置参数要校验（防止注入攻击）
- 敏感操作（如文件写入、网络请求）记录日志

### 性能

- `handleInbound`/`handleOutbound` 是热路径，避免重计算
- 如果需要缓存，用实例字段存储（所有会话共享）

---

## 未来扩展

### 插件市场

未来可能支持：
- 中心化插件仓库（类似 VSCode Marketplace）
- 插件评分与评论
- 自动更新通知

### 更多钩子

响应模式接口可能增加新钩子（向后兼容）：
- `onError`：错误处理
- `onInterrupt`：消息中断
- `onResume`：会话恢复

---

## 总结

扩展插件独立打包流程：

1. 创建独立 npm 包，实现 `ResponseMode` 接口
2. 声明 `peerDependencies: { "evolclaw": "^0.x.x" }`
3. 发布到 npm（公开或私有 registry）
4. 用户通过 `npm install` 安装
5. 在配置文件中启用：`"response_modes": { "private": "your-mode-id" }`

插件与核心解耦，独立版本管理，社区可贡献，用户按需安装。

# 响应模式契约（Mode Contract）

**版本**: 1.0（草案）
**创建时间**: 2026-07-14
**状态**: 待评审
**定位**: 本文档是**响应模式与系统其余部分之间边界的唯一事实源（SSOT）**。
它定义一个响应模式对外呈现的全部内容，以及宿主向模式注入的全部资源。
模式内部如何实现（几个会话、几轮判断、队列结构、提示词内容）不属于本契约。

> **设计目标**：将来任何一个响应模式的内部迭代，都不需要改动本契约、宿主、
> 或其他模式。若一次迭代被迫触碰契约，说明契约有缺口，应先修契约再动手。

---

## 一、外部定义总览

一个响应模式被外部看到的东西，分四类：

| 类 | 内容 | 本文档章节 |
|----|------|-----------|
| **静态声明** | 目录规范、注册表条目（descriptor）、会话原型、ECK 资产 | §二 |
| **运行时接口** | 消息传入、生命周期、状态查询 | §三 |
| **配置契约** | 参数 schema、宿主合并、通用参数行为承诺 | §四 |
| **资源边界** | 宿主注入的 ctx、持久化命名空间、模式切换语义 | §五 |

契约是**双向**的：模式声明并暴露前三类；宿主保证第四类。
模式获取任何资源的唯一途径是 ctx（§5.1），自行伸手（读配置文件、拼关系层路径、
直接触碰 SDK）都是违约。

---

## 二、静态声明

### 2.1 目录规范

```
src/response-system/modes/<name>/
├── index.ts                 # 导出 ResponseModeDescriptor；configSchema 由 loadSchema('<name>') 读磁盘
└── ...                      # 内部实现，结构自由

kits/schemas/
├── <name>.schema.<v>.json   # 模式桶 schema（特有参数：候选/默认/校验）——唯一事实源，见 §4.1
└── _meta.json               # 须登记 <name> 的 currentVersion + 一条 history

kits/docs/response-system/<name>/
├── README.md                # 定位、适用场景（文档完备性见 checklist D 类）
├── prompts/                 # 本模式的提示词模板
└── ...
```

> **模式 schema 不再放 `modes/<name>/config-schema.json`**（旧约定已废）。它是一份独立的
> kits schema `kits/schemas/<name>.schema.<v>.json`，随包分发、登记进 `_meta.json`，与
> `agent-config` 等核心 schema 走同一套 `loadSchema` / `ec config schema` 机制。理由：`src/`
> 下的 json 不进 dist、运行时读不到；且这样 `ec config schema <name>` 能直接展示给前端。
> 详见 [config/03-schema.md](../config/03-schema.md)。

### 2.2 注册表条目（ResponseModeDescriptor）

```typescript
interface ResponseModeDescriptor {
  name: string;                        // 唯一名，同目录名
  displayName: string;
  description: string;

  factory: (config: ResolvedModeConfig, ctx: ModeContext) => ResponseModeImpl;

  configSchema: object;                // = loadSchema('<name>').raw（读自 kits/schemas/<name>.schema.<v>.json）
  supportedCommonParams: string[];     // 声明支持的通用参数
  specificParams: string[];            // 特有参数（必须与 configSchema.properties 一致）

  // 会话原型声明：本模式有哪几种会话，各绑什么 manifest / 缺省模型 / 投递策略。
  // 宿主据此路由 manifest、注入 sessionPrototype 变量、决定事件流是否出站；
  // 模式运行时通过 ctx.sessions.create(<原型名>) 实例化。
  sessionPrototypes: Record<string, {
    manifest?: string;                 // 相对 kits/ 的 manifest 文件；缺省 = 默认主 manifest
    defaultModel?: string;
    delivery: 'reply' | 'silent';      // 'reply'：事件流经宿主出站投影器按 chatMode 投递（§3.2）
                                       // 'silent'：事件流不出站，turn 结果仅返还模式内部消费
  }>;

  // 本模式会注入的 ECK 变量（须带命名空间，见 §2.4）
  eckVars?: string[];

  // 本模式 manifest sections 允许使用的 order 区间（注册时校验不与他模式冲突）
  orderRange?: [number, number];
}
```

### 2.3 会话原型（session prototype）

- 会话原型是**系统级机制**：模式声明原型，宿主负责按原型创建会话时
  加载对应 manifest、注入 `sessionPrototype` 变量、套用缺省模型、
  并按 `delivery` 声明决定该会话的事件流是否接入出站投影器（§3.2）。
- dual-session 声明 `{ auxiliary: { delivery: 'silent' }, main: { delivery: 'reply' } }`
  两个原型；single-session 声明 `{ main: { delivery: 'reply' } }`。
- 原有 agent config 中的 `sessionManifests` 映射由本机制取代——用户不再手工配置
  原型与 manifest 的对应关系。
- 每个原型内部承担什么职责、跑几轮，外部不定义。

### 2.4 ECK 资产规则

**变量命名空间**：

- 系统保留变量（所有模式可读、由宿主注入）：`responseMode`、`chatMode`、
  `mentionMode`、`model`、`sessionPrototype`、以及 ECK 既有运行时变量
  （`chatType` / `channel` / `selfAid` / `peerId` / `peerKey` 等）。
  - 注：原 dual-session 文档中的 `sessionType` 由系统级 `sessionPrototype` 取代。
- 模式私有变量必须带前缀 `<name>.`（如 `workflow.stage`），且全部列在
  descriptor 的 `eckVars` 中。未声明的变量运行时禁止注入。

**manifest section 规则**：

- 模式贡献的 section 一律通过覆盖文件机制合入，不改基础 manifest；
- section 的 `order` 必须落在 descriptor 声明的 `orderRange` 内；
  区间由注册表分配（系统段保留 0–99，每模式一个百位段，如 dual-session 200–299）；
- 模板文件中引用的注入变量必须是系统保留变量或本模式已声明的 eckVars。

---

## 三、运行时接口

### 3.1 ResponseModeImpl

```typescript
interface ResponseModeImpl {
  // 消息传入：同步收下、立即返回、不抛出。
  // 决策、延迟、回复全部在内部异步进行——外部不向模式索要即时决策。
  onMessage(message: Message): void;

  // 生命周期（均幂等）
  init(): Promise<void>;              // 恢复持久化状态、建定时器；不预建会话也可
  drain(timeoutMs?: number): Promise<void>;  // 不再接新消息，处理完手头的；超时可强制
  dispose(): Promise<void>;           // 释放会话/定时器；持久化状态留盘

  // 状态查询（只读观察窗口）
  getStatus(): ModeStatus;
}

interface ModeStatus {
  state: 'idle' | 'busy' | 'degraded' | 'error';
  pendingCount: number;               // 待处理消息数（各模式自行折算）
  detail?: Record<string, unknown>;   // 模式私有细节：外部只透传展示，不解释、不依赖
}
```

- `Message` 是**系统级类型**（渠道适配器产出、含 `peerRole` 等），定义在
  `src/response-system/types.ts`，演化规则：只增可选字段。模式不感知渠道差异。
- `onMessage` 返回 void 是刻意的：模式对一条消息 hold 三天还是立刻回，是内部的事。

### 3.2 会话与出站投影（chatMode 的宿主侧实现）

模式不直接触碰 base agent SDK，也**不实现任何出站投递**。回复的产生与投递
是宿主既有设施的职责，模式只声明与关联。

**背景（现状机制，契约以此为准）**：base agent 的一个 turn 产出的是
`AgentEvent` **事件流**（文本增量、tool_use、tool_result、进度、notice、complete），
不是单一结果。宿主的**出站投影器**（现实现为 IMRenderer）消费该流并按 chatMode 投影：

| chatMode | 投影行为（宿主既有设施） |
|----------|------------------------|
| `interactive` | 事件流即回复：聚合窗口内打包为 `activity.batch` / `result.text` 持续出站——中间文本、工具活动、notice、最终文本都是回复的组成部分 |
| `proactive` | 事件流投影为 thought（非回复）；真正的回复由模型在 turn 内经渠道 CLI 发出；notice 仅放行终态错误白名单 |

**会话接口**：

```typescript
interface ModeSessionFactory {
  create(prototype: string, opts?: { model?: string }): Promise<ModeSession>;
}

interface ModeSession {
  process(input: TurnInput): Promise<TurnResult>;
  interrupt(): Promise<void>;         // 硬 abort 当前 turn（在飞的 process 以抛错中止）
  dispose(): Promise<void>;
}

interface TurnInput {
  content: string;                    // 模式组装的本 turn 输入
  replyTo?: string[];                 // 本 turn 关联的入站消息 ID（归属关联，见下）
}

interface TurnResult {                // 事后摘要，供模式内部消费（反馈/总结/决策解析）
  finalText: string;                  // turn 累计的全部输出文本
  sentMessages: string[];             // 宿主提取的、本 turn 已经渠道 CLI 发出的消息正文
  aborted: boolean;                   // 是否被 interrupt 中止
}
```

**投递规则（全部在宿主侧，模式代码在两种 chatMode 下完全相同）**：

- 原型声明 `delivery: 'reply'` 的会话：宿主在 `process()` 期间把该会话的事件流
  接入出站投影器，按当前 chatMode 投影出站。聚合窗口、flush 时序、降级、
  echo 等全部是投影器内部事务，模式不可见。
- 原型声明 `delivery: 'silent'` 的会话：事件流不出站，仅 `TurnResult` 返还模式
  （如辅助会话解析决策 JSON）。
- **replyTo 是归属关联，不是投递门**：宿主用它构造出站信封（回复上下文 / @ 对象 /
  日志归属）。模式的义务是如实填写"本 turn 在处理哪些消息"（批次即现成的 replyTo）；
  投递本身在 turn 进行中由投影器持续完成，不依赖 turn 结束。
- `TurnResult` 是**事后摘要**而非投递载体：`sentMessages` 由宿主/渠道层从工具调用
  历史提取——渠道命令名（`ec group send` 等）的知识留在渠道层，模式内**禁止**
  硬编码发送命令或自行解析工具调用历史。

**事件观察（可选）**：模式可传入只读观察器
`process(input, { onEvent?: (e: AgentEvent) => void })` 用于内部决策
（如统计工具调用、感知 turn 进展）。观察器是只读的：模式不得据此自行出站，
也不得阻塞投影。

### 3.3 模式实例的作用域

- 一个 `ResponseModeImpl` 实例对应一个**会话单元**：`(peerKey, threadId)`。
  宿主按会话单元路由消息、懒实例化、按需 drain+dispose 回收（内存策略归宿主）。
- 模式实例之间不共享可变状态；跨实例的共性（如全局限流）是宿主的事。

---

## 四、配置契约

### 4.1 参数定义与读取分工

- **定义归模式 schema 文件**：`kits/schemas/<name>.schema.<v>.json` 定义全部特有参数
  （`type` / `enum` 候选 / `default` 默认；`additionalProperties:false` 拦截未知键）。
  `specificParams` 与 schema 的 properties 必须一致。这份 schema 是特有参数的**唯一事实源**，
  同时供三处消费：
  1. **写校验**：宿主 `write()` 对 `responseModeParams[<name>]` 桶用本 schema 逐桶校验
     （桶键须是已注册模式，否则报错点名；桶内容按 `enum`/`additionalProperties` 校验）；
  2. **候选/默认展示**：`ec config schema <name>` 读出给前端；
  3. **运行时默认注入**：宿主 `coordinator.schemaDefaults` 提取 `default` 铺进 modeConfig，
     模式/flow **不得**再硬编码默认（如 `?? true`）。
- **读取与合并归宿主**：多层合并（关系级 > agent 级 > schema 默认）由宿主 ConfigManager 完成，
  factory 收到**合并后的最终 config**。特有参数存 `responseModeParams[<name>]` 桶，按模式 id
  整桶 dict 合并（高优先层整桶覆盖，不递归到键）。模式内**禁止**自行读取任何配置文件。
- 非法配置在 write 期（桶校验）或 factory 阶段报错拒绝（fail fast），不得运行中途才暴露。
- 除声明为必填的通用参数外，**空 config 必须能启动**（全特有参数在 schema 有 `default`）。

### 4.1.1 新增一个响应模式：schema 侧清单

新增模式 `<name>` 时，schema 相关**必须全部完成**，缺一即挂：

| # | 动作 | 位置 |
|---|------|------|
| 1 | 建模式桶 schema，含 `x-logical-name`/`x-scope:mode`、每个特有参数的 `type`+`enum`+`default`、`additionalProperties:false` | `kits/schemas/<name>.schema.1.json` |
| 2 | 登记 currentVersion + 一条 history | `kits/schemas/_meta.json` |
| 3 | `LogicalSchemaName` union 加 `'<name>'` | `src/config/schema-registry.ts` |
| 4 | descriptor `configSchema = loadSchema('<name>').raw`（不内联、不放 `modes/<name>/`） | `src/response-system/modes/<name>/index.ts` |
| 5 | `specificParams` 与 schema properties 保持一致 | 同上 |
| 6 | 确认写校验覆盖：`write()` 的桶专项校验对 `<name>` 桶生效（`isSchemaName('<name>')`→true 后自动走） | 无需改代码，靠 1+2+3 |
| 7 | 确认默认注入：`coordinator.schemaDefaults` 会从新 schema 提 `default`（自动） | 无需改代码 |
| 8 | 文档：本模式 README + config-reference 参数表与 schema 一致（checklist D1） | `docs/response-system/<name>/` |

> 校验/默认/展示三条链路都靠「模式必带同名 schema 且登记进 `_meta`」这一约定驱动——
> 只要 1+2+3 到位，桶校验与默认注入**零额外代码**自动生效；漏了 1/2/3 则该模式桶会被判「未注册」而报错。

### 4.2 通用参数的行为承诺

模式声明 `supportedCommonParams` 即承诺以下**可观察行为**（实现方式自由）：

| 参数值 | 承诺的可观察行为 | 保证方 |
|--------|-----------------|--------|
| `chatMode: interactive` | `delivery:'reply'` 会话的事件流经出站投影器聚合出站（流即回复） | **宿主投影器**（模式义务：原型 delivery 声明正确 + replyTo 如实） |
| `chatMode: proactive` | 回复经渠道 CLI 送达；事件流投影为 thought，不作为回复 | **宿主投影器 + [channel] 段**（同上） |
| `mentionMode: disabled` | 所有消息都参与处理判断 | 模式 |
| `mentionMode: mention-only` | 未 @ 消息不得触发回复；但不得丢弃（至少可作上下文） | 模式 |
| `model` | 主处理会话使用该模型 | 模式（经 ctx.sessions 传入） |

新增通用参数时必须同步在此表追加行为承诺，并在 conformance 套件中补对应测试。

---

## 五、资源边界

### 5.1 宿主注入的上下文（ModeContext）

模式获取资源的唯一途径：

```typescript
interface ModeContext {
  sessions: ModeSessionFactory;       // §3.2：会话创建（含投递、manifest 路由、模型缺省）
  config: ResolvedModeConfig;         // §4.1：合并后的最终配置（只读）
  storage: ModeStorage;               // §5.2：本模式专属持久化目录的读写句柄
  peer: PeerInfo;                     // 只读：peerKey / chatType / 对端 role 等关系层信息
  logger: Logger;
  metrics: MetricsSink;
}
```

### 5.2 持久化命名空间

```
$RELATIONS_DIR/<peerKey>/_threads/<threadId>/_modes/<name>/
```

- 模式的全部持久化状态落在自己的 `_modes/<name>/` 之下，目录内结构、文件格式、
  版本管理、原子写策略均为内部事务；
- **禁止**写出该目录之外（thread 根、其他模式目录、其他 peer 目录）；
- 注：dual-session 现设计中的 `_threads/<threadId>/_queues/` 相应调整为
  `_threads/<threadId>/_modes/dual-session/`（队列文件内部规格不变）。

### 5.3 模式切换语义

关系级/agent 级配置将某会话单元的 `responseMode` 从 A 改为 B 时，宿主执行：

1. 新消息停止路由给 A 实例；
2. `A.drain(timeout)` → `A.dispose()`（drain 超时则强制 dispose，未定案状态留盘）；
3. 创建 B 实例并 `init()`，此后新消息路由给 B；
4. A 的 `_modes/A/` 目录**原样保留、B 不读取**；切回 A 时由 A 自己按其持久化
   规格恢复（能恢复多少是 A 的内部事务）。

切换只对新消息生效；A 在 drain 窗口内发出的回复照常有效（副作用不可撤回原则）。

### 5.4 依赖约束

- 模式代码不 import 其他模式；对宿主的依赖仅限 `ModeContext` 与系统级 types；
- 不直接 import base agent SDK / 渠道 SDK；
- 不硬编码渠道命令字符串（发送能力见 §3.2）。

---

## 六、外部不定义的清单（反向边界）

以下均为模式内部事务，外部不得依赖、契约永不约束：

- 内部有几个会话、几个回合、会话间如何协作；
- 队列结构、触发时机（防抖/超时/容量参数是模式特有参数，语义归模式）；
- 打断机制及其正确性防护（如 generation 守卫）；
- 压缩策略与阈值；
- 提示词内容；
- 模式内部的决策输出 schema（如 AuxiliaryDecision）；
- 重试、降级路径；
- `_modes/<name>/` 目录内的一切。

外部对内部的唯一观察窗口：`getStatus().detail`、日志、指标。三者都不构成接口承诺。

---

## 七、完备性判定

一个响应模式是否完备，依据 [conformance-checklist.md](./conformance-checklist.md)
判定：注册器校验通过 + conformance 测试套件全绿 + 人工评审项勾满。

---

**文档维护者**: Claude Code
**最后更新**: 2026-07-14
**状态**: 草案，待评审

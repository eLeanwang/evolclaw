# 双会话响应模式 - 数据结构定义

## 文档说明

**版本**: 2.0  
**创建时间**: 2026-07-08  
**来源**: 从 dual-session-lite 迁移  
**关联**: [README.md](./README.md) | [架构设计](./architecture.md)

---

## 一、核心数据结构

### 1.1 Message（消息）

```typescript
interface Message {
  id: string;                      // 消息唯一 ID
  channel: string;                 // 渠道（aun/feishu/wechat等）
  peerId: string;                  // 发送者 ID
  peerName: string;                // 发送者名称
  peerRole: 'owner' | 'admin' | 'guest' | 'anonymous';  // 发送者角色（权限判断依据，必填）
  content: string;                 // 消息内容
  timestamp: number;               // 时间戳（毫秒）
  
  // 可选字段
  isMentioned?: boolean;           // 是否 @本agent
  attachments?: Attachment[];      // 附件
  referencedMessages?: string[];   // 引用的消息 ID
  metadata?: Record<string, any>;  // 元数据
}

interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  size?: number;
  mimeType?: string;
}
```

> **peerRole 字段说明**：来自关系层（见 `kits/rules/04-relation.md`），是每条消息的固有属性，
> 权限判断（主队列按角色分组、PreToolUse Hook 判断 owner/guest 权限）依赖它，因此**必填**。
> 兜底：无 token 或 token 残缺时按 `anonymous` 处理。全系统统一用平级字段 `message.peerRole`
> （不用 `message.role`，也不用嵌套的 `message.from.role`）。

---

### 1.2 QueuedMessage（队列中的消息）

```typescript
interface QueuedMessage {
  message: Message;                // 原始消息
  state: MessageState;             // 消息状态
  enqueuedAt: Date;                // 入队时间
  processedByAuxiliary: boolean;   // 是否已被辅助会话处理
  
  // 到期投递（DELAY 与 HOLD 统一用这一套；由所属批次统一计算，批内所有消息取同一值 → 无 skew）
  expireAt?: Date;                 // 到期时刻：到点后由到期扫描转投到主队列
  expireReason?: 'delay' | 'hold-timeout';
                                   // 'delay'        —— 辅助会话主动延迟（分钟级，等意图/错开竞争）
                                   // 'hold-timeout' —— HOLD 挂起的兜底超时（默认 1 小时，防饿死）
  
  // 如果 state = HOLD
  holdSince?: number;              // 首次 HOLD 的时间（毫秒时间戳）；expireAt = holdSince + holdTimeoutMs
  
  // 错误处理
  hasError?: boolean;              // 是否处理失败
  lastErrorTime?: number;          // 上次失败时间（毫秒时间戳）
  errorCount?: number;             // 失败次数
  
  // 元数据
  processedCount?: number;         // 被辅助会话处理的次数
  lastProcessedAt?: Date;          // 最后一次处理时间
}

enum MessageState {
  PENDING = 'pending',             // 刚到达，未处理
  HOLD = 'hold',                   // 挂起（与agent无关）
  DELAY = 'delay',                 // 延迟投递
  // transfer 时消息立即移出队列，无 TRANSFERRED 中间态
}
```

**反馈标记项（FeedbackItem）**：辅助队列除消息外，还容纳一类"反馈标记项"。主会话处理完批次后，
代码层把 `MainFeedback` 包成 `FeedbackItem` **插入辅助队列**（不调模型）；下次辅助会话被真正触发时，
`extractBatch()` 把队列中的反馈标记项随本批一起带出，作为**只读上下文**喂给辅助会话（见
[auxiliary-queue-processing.md](../dual-session/auxiliary-queue-processing.md) §1.2）。这样反馈不产生
额外 LLM 调用、也不绕过队列破坏串行化。

```typescript
interface FeedbackItem {
  kind: 'feedback';                // 与普通消息项区分的标记
  feedback: MainFeedback;          // 主会话反馈内容
  enqueuedAt: Date;                // 入队时间
}

// 辅助队列元素 = 消息项 | 反馈标记项
type AuxiliaryQueueItem = QueuedMessage | FeedbackItem;
```

**HOLD 超时机制**（与 DELAY 到期共用同一套到期扫描，见
[auxiliary-queue-processing.md](./auxiliary-queue-processing.md) §6.2）：
- 消息进入 HOLD 时，代码层按批次统一算出 `expireAt = holdSince + holdTimeoutMs`（默认 1 小时），
  `expireReason = 'hold-timeout'`，写入本批每条消息（批内同值）。
- **到期由独立定时器驱动、不依赖新消息**：到期扫描到点后转投所有 `expireAt <= now` 的消息，
  扫完再按队列中"下一个最早的 `expireAt`"重挂定时器。
- ⚠️ 这正是修掉旧设计"每次辅助会话处理时检查"的漏洞——旧法在队列安静（无新消息、无 delay 到期）
  时永不触发，HOLD 会远超 1 小时；改为独立定时器后，即使队列全程安静也能按时兜底投递。
- **重启恢复**：不持久化定时器。重启后遍历队列，`expireAt <= now` 的立即转投，其余按最早 `expireAt`
  重挂一个定时器即可（幂等）。

---

### 1.3 AuxiliaryInput（辅助会话输入）

```typescript
interface AuxiliaryInput {
  // 一次触发的批次 = 一个带标记的项列表。
  // 每项一个 kind 字段，辅助会话遍历时按 kind 分别对待：
  //   - 'message'  ：待判断的新消息
  //   - 'feedback' ：主会话反馈（只读上下文，不为它单独产出决策）
  // 反馈保持独立类型、与新消息同批带入；不是触发源（见 TriggerReason）。
  items: AuxItem[];

  remainingInQueue: number;        // 【信号A】去掉本批次后，辅助队列还剩多少条待判断
                                   // 越大 → 判断越果断，少 hold/少 delay/优先 short，尽快清空积压

  // 主会话当前状态
  mainSession: MainSessionStatus;
}

// 批次项：消息项与反馈项平级，靠 kind 区分
type AuxItem =
  | { kind: 'message';  message: Message }        // 待判断的新消息
  | { kind: 'feedback'; feedback: MainFeedback }; // 主会话反馈，只读上下文

// 注：mention 模式在 message 项上追加一个 role: 'primary' | 'reference' 字段，
// 区分被 @ 的主消息与仅供参考的引用消息（缺省 primary）。详见 MENTION-MODE-MECHANISM.md §4.4。

interface MainSessionStatus {
  status: 'idle' | 'processing';
  pendingCount: number;            // 【信号B】主队列待处理消息数（= queueSize，不含正在处理的批次）
                                   // 越大 → 主会话越忙，应更倾向 delay/更长等级，别再压给它
                                   // 例外：紧急消息仍照常 transfer + 打断
}
```

> **两个信号方向相反**：`remainingInQueue`（信号A）催辅助会话**加快**清空积压；
> `pendingCount`（信号B）提示主会话忙、要辅助会话**放慢**投递。辅助会话在两者间权衡。
>
> **反馈项只读**：辅助会话遍历到 `kind: 'feedback'` 的项时，只用它更新对"主会话消费了什么"的
> 认知（供后续 hold/delay 重判参考），**不**为反馈项产出任何决策，也不产出应答。

---

### 1.4 AuxiliaryOutput（辅助会话输出）

```typescript
interface AuxiliaryOutput {
  // 输出只有决策一种（反馈是只读上下文，不再需要 feedback-ack 应答）
  type: 'aun-decision';

  decision: AuxiliaryDecision;
}

interface AuxiliaryDecision {
  // 决策类型（群聊：hold/delay/transfer；单聊：delay/transfer，无 hold）
  action: 'hold' | 'delay' | 'transfer';
  
  // 如果 action = 'delay'
  delayLevel?: 'short' | 'medium' | 'long';  // 延迟等级（默认 medium）；换算见下方说明
  
  // 如果 action = 'transfer'
  interrupt?: boolean;             // 是否打断主会话（默认false）
  previousMessageStrategy?: 'ignore' | 'defer' | 'continue';  // 被打断消息处理策略（interrupt=true 时必填）
  
  // 简短说明（<50字）；interrupt=true 时，在此一并说明打断原因
  reason: string;
}

/**
 * 延迟投递机制（单聊与群聊公式相同）：
 *
 *   实际延迟 = baseDelayMs + random(0, effectiveLevelMs)
 *   effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数
 *
 * baseLevelMs：short=60000(1分钟) / medium=120000(2分钟) / long=180000(3分钟)
 *
 * 对端系数（代码自动判定，不由辅助会话输出）：
 *   - 对端是 agent → ×1.0（群聊消息集合含 agent 就算 agent）
 *   - 对端是 人   → ×0.5（群聊全是人 / 单聊对端是人）
 *
 * 延迟的双重目的：①避免多 agent 竞态回复 ②等待用户完整意图输入。
 * 因此单聊也需要 delay（等意图），也带随机。若意图已完整应直接 transfer，不 delay。
 *
 * delayLevel 选择建议：
 *   - short：高相关性、紧急
 *   - medium（默认）：中等相关性
 *   - long：低相关性、不紧急
 */

/**
 * previousMessageStrategy 三种策略（均为提示词层建议，非队列层机制；
 * 详见 interrupt-mechanism.md §6）：
 * - ignore：忽略被打断的消息，只处理新消息
 * - defer：先处理新消息，完成后再处理被打断的消息
 *          （注意：无队列层"稍后重投"，靠主会话同 turn 从上下文自行捞回）
 * - continue：继续处理被打断的消息，但考虑新消息的内容
 */
```

**辅助会话输出格式**：

辅助会话的输出包含两部分（以自然语言形式）：

1. **思考过程**（<200字）
2. **JSON 判断结果**

**示例**：
```
【思考过程】
Owner 提了一个关于报错的紧急问题，主会话正忙着处理闲聊消息，需要打断。新问题优先，但闲聊消息不重要可以忽略。

【判断结果】
{
  "action": "transfer",
  "interrupt": true,
  "previousMessageStrategy": "ignore",
  "reason": "Owner 提出紧急问题，打断优先处理，闲聊可忽略"
}
```

**Schema 插入方式**：
- Schema 作为辅助会话系统提示词的一部分（`.md` 文件）
- 通过 ECK 的模板渲染机制注入
- 兼容所有 base agent（Claude Code、Codex、Gemini CLI 等）

**输出验证**：
- 代码层提取 JSON 部分
- 验证 schema 是否符合 `AuxiliaryDecision`
- 验证失败时，提示辅助会话重新输出

---

### 1.5 MainFeedback（主会话反馈）

```typescript
interface MainFeedback {
  summary: string;                 // 主会话输出的自然语言总结（<200字）
  replies: string[];               // 从工具调用历史提取的回复内容
}
```

**说明**：
- `summary`: 主会话在 turn 结束时输出的自然语言总结，代码层从输出中提取
- `replies`: 代码层从主会话的工具调用历史中提取所有 `ec group send` / `ec msg send` 的消息正文
- MainFeedback 由代码层组装后直接传递给辅助会话（不写文件）

---

## 二、配置数据结构

### 2.1 DualSessionConfig（双会话配置）

> **参数唯一事实源见 [config-reference.md](../config-reference.md)**。本接口与之保持一致，
> 若有出入以 config-reference.md 为准。

```typescript
interface DualSessionConfig {
  // 模型配置
  auxiliaryModel: string;          // 辅助会话模型（默认：deepseek-v4-flash）
  // 注意：主会话模型用通用参数 model（不是 mainModel），见 common-params.md
  
  // mention 机制配置
  mentionMode: 'disabled' | 'mention-only';  // 默认：disabled
  // - disabled: 所有消息进入辅助队列，由辅助会话判断
  // - mention-only: 只处理被 @ 的消息，未 @ 消息作为引用上下文（详见 MENTION-MODE-MECHANISM.md）
  
  // 队列配置
  debounceMs: number;              // 防抖时间（默认：3000，可配置 0-6000）
  maxWaitMs: number;               // 最早消息最长等待（默认：15000）
  maxQueueSize: number;            // 队列最大容量（群聊：50，单聊：15）
  maxBatchSize: number;            // 每批最多消息数（默认：50）
  maxBatchBytes: number;           // 每批最多字节数（默认：10240）
  
  // 延迟配置（单聊与群聊公式相同）
  // 实际延迟 = baseDelayMs + random(0, effectiveLevelMs)
  // effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数（agent×1.0 / 人×0.5）
  // 其中 delayLevel 是辅助会话决策的输出（short/medium/long），不是配置项
  // 对端系数由代码按发送者类型自动判定，无需配置参数
  baseDelayMs: number;             // 延迟基础偏移（默认：0，打底叠加在随机延迟上）
  
  // 压缩配置
  auxiliaryMaxTokens: number;      // 辅助会话触发压缩阈值（默认：40000）
  auxiliaryMaxMessages: number;    // 辅助会话触发压缩阈值（默认：100）
  mainMaxTokens: number;           // 主会话触发压缩阈值（默认：160000）
  mainMaxMessages: number;         // 主会话触发压缩阈值（默认：200）
  compressionTarget: number;       // 压缩摘要目标字数（默认：2000）
  
  // 打断与调试
  interruptEnabled: boolean;       // 是否允许打断主会话（默认：true）
  enableDebug: boolean;            // 是否启用调试输出（默认：false）
}
```

**单聊与群聊差异**（延迟机制完全相同，仅以下不同）：
- `maxQueueSize`: 群聊 50 条，单聊 15 条
- 决策类型：群聊 hold/delay/transfer；单聊 delay/transfer（无 hold，一对一都相关）
- 对端系数：群聊按"消息集合是否含 agent"判定，单聊按对端是人/agent 判定

---

### 2.2 AgentConfig（Agent 配置）

```typescript
interface AgentConfig {
  // 响应模式（见 config-reference.md §二）
  responseMode: 'single-session' | 'dual-session' | 'workflow' | null;
  
  // 响应模式配置（通用参数 + 特有参数）
  config?: DualSessionConfig | SingleSessionConfig;
  
  // 其他现有配置
  aid: string;
  name: string;
  model: string;
  // ...
}
```

---

## 三、存储数据结构

### 3.1 队列持久化

#### 存储位置（话题级、主/辅分文件）

```
$AGENT_DIR/relations/<channel>#<urlEncode(peerId)>/_threads/<threadId>/_queues/
├── main-queue.json          # 主队列（批次）
└── auxiliary-queue.json     # 辅助队列（消息 + 反馈标记项）
```

- **话题级隔离**：`_threads/<threadId>/` 是话题级数据的根，每个话题一套独立队列
  （与现有 queueKey `selfAID::channel#channelId#threadId::projectPath` 的话题维度对应；
  未来话题级其它数据如 context/summary 也落这一层）。
- **主/辅分文件**：辅助队列写入频繁（每条消息入队/状态变化）、主队列写入稀疏（批次进出），
  分文件减少写放大；且一个文件损坏不殃及另一个。

#### 文件内容

```typescript
// auxiliary-queue.json
interface AuxiliaryQueueState {
  items: AuxiliaryQueueItem[];     // 消息项（QueuedMessage，自带 expireAt/expireReason）
                                   // + 反馈标记项（FeedbackItem），保持队列顺序
  lastUpdateAt: string;            // ISO 8601
}

// main-queue.json
interface MainQueueState {
  batches: TransferBatch[];        // 等待中的批次（到达顺序，各带指令）
  processing: TransferBatch | null; // 在飞批次（崩溃恢复用，见下）
  lastUpdateAt: string;            // ISO 8601
}
```

> 定时器（到期/防抖）**一律不持久化**——它们是从数据派生的（到期定时器由 `expireAt` 重建，
> 见 §1.2；防抖不恢复，重启后新消息自然重新防抖，积压靠"最早消息 15s 强制触发"兜底，
> 其判断依据 `enqueuedAt` 就在持久化数据里）。

#### 写入（原子写，复用单会话模式的既有做法）

- 每次队列变化（入队/出队/状态更新/批次进出）覆盖写对应文件；
- 原子写：先写临时文件（`<name>.json.tmp`），再 `rename` 替换正式文件——
  任何时刻磁盘上的正式文件要么是完整旧版、要么是完整新版，不存在半个 JSON。

#### 懒加载

1. 启动时给所有话题打"需要重载"标志（不逐个读文件）；
2. 首次操作某话题的队列时检查标志，需要则从文件加载、清标志；
3. 之后队列变化即写入。

#### 恢复流程（加载后执行一次）

```
1. auxiliary-queue.json → 恢复辅助队列
   → rebuildExpiryOnRestart()：expireAt <= now 的立即转投，其余按最早 expireAt 重挂
     单个到期定时器（见 auxiliary-queue-processing.md §6.2）
2. main-queue.json → 恢复主队列批次
   → 若 processing 非空（崩溃时有在飞批次）：
     该批次未 completeBatch、未产反馈 = 未定案 → 放回主队列【队首】重新处理
     （旧进程的模型调用上下文已随进程消失，重处理是唯一正确语义；
      崩溃前可能已发出的半截回复按"副作用不可撤回"处理，不补机制）
   → 清空 processing，按 §5.2 nextBatch() 正常调度
```

#### 损坏降级（隔离重建）

任一队列文件 JSON 解析失败：

```
1. 把损坏文件改名为 <name>.json.corrupt-<ISO时间戳>（留证，不删除）
2. 该队列以空队列启动
3. 日志告警（含损坏文件路径）
```

- 该话题未处理的积压会丢失——可接受：消息源头在渠道侧（对端可重发），
  且主/辅分文件使损坏只影响一半；
- 原子写已把"写一半损坏"压到极低，剩余极端情况（磁盘坏块）任何本地方案都救不了，
  不引入双副本轮换等更重机制（回退旧副本还会带来重复处理已回复消息的新问题）。

---

## 四、内部数据结构

### 4.1 TriggerReason（触发原因）

```typescript
type TriggerReason = 
  | 'debounce'           // 防抖超时
  | 'max-wait'           // 最早消息超时
  | 'queue-full'         // 队列满
  | 'delay-timeout'      // 延迟投递超时
  | 'retry';             // 重试（失败后）
  // 注：主会话反馈不是触发源。反馈以 FeedbackItem 入队暂存，
  //     被动等待下一次真实触发（防抖/超时/队列满/延迟到期）时随批带出。
```

---

### 4.2 SessionStatus（会话状态）

```typescript
interface SessionStatus {
  conversationId: string;          // 当前会话 ID
  status: 'idle' | 'processing';
  
  // 统计信息
  stats: {
    totalMessages: number;         // 总消息数
    totalTokens: number;           // 总 token 数
    totalCalls: number;            // 总调用次数
    lastCallAt?: Date;             // 最后一次调用时间
  };
  
  // 压缩信息
  compression: {
    lastCompressedAt?: Date;       // 最后一次压缩时间
    compressionCount: number;      // 压缩次数
  };
}
```

---

### 4.3 TransferBatch（转投批次——主队列的调度单位）

```typescript
interface TransferBatch {
  batchId: string;         // 批次标识（反馈定案、队列移除都以批次为单位）
  batchRole: PeerRole;     // 本批统一角色——仅作权限分组键（PreToolUse Hook 用），不代表优先级
  messages: Message[];     // 同角色消息（保持到达顺序）

  // 辅助会话对本批次的判断指令（主队列照此调度，见 interrupt-mechanism.md §3/§4）
  interrupt: boolean;      // 是否要求打断/优先处理
  previousMessageStrategy?: 'ignore' | 'defer' | 'continue';  // interrupt=true 时必填
}
```

**要点**：
- 批次在 **transfer 边界**成形（辅助队列提取即同角色，见 auxiliary-queue-processing.md §1.2），
  主队列**不拆散重切**——辅助的批次边界就是主会话的处理边界（判断不失效）
- `batchRole` 只是权限分组键；优先级/打断来自辅助对**内容**的判断，与角色高低无关

### 4.4 BatchInfo（批次信息）

```typescript
interface BatchInfo {
  batchId: string;
  messages: Message[];
  extractedAt: Date;
  
  // 辅助会话批次
  triggerReason?: TriggerReason;
  
  // 主会话批次
  isInterrupted?: boolean;         // 是否是打断后的批次
  references?: TransferBatch[];    // 被跳过、以只读引用注入的批次（本体仍在主队列排队）
}
```

---

## 五、API 数据结构

### 5.1 AuxiliaryQueue API

```typescript
interface AuxiliaryQueueAPI {
  // 入队
  enqueue(message: Message): void;
  
  // 查询
  getAllUndelivered(): QueuedMessage[];
  getByState(state: MessageState): QueuedMessage[];
  getOldestPending(): QueuedMessage | null;
  getExpired(now: Date): QueuedMessage[];        // 所有 expireAt <= now（DELAY/HOLD 统一），供到期扫描
  getEarliestExpireAt(): Date | null;            // 队列中最早的 expireAt，供 armExpiryTimer 重挂定时器
  size(): number;
  
  // 更新（转 DELAY/HOLD 时传入该批次统一算好的 expireAt 与 expireReason）
  updateState(
    messageId: string,
    state: MessageState,
    expire?: { expireAt: Date; expireReason: 'delay' | 'hold-timeout' }
  ): void;
  
  // 移除
  remove(messageIds: string[]): void;
  
  // 批次提取
  extractBatch(maxSize: number, maxBytes: number): Message[];
}
```

---

### 5.2 MainQueue API（以批次为单位）

```typescript
interface MainQueueAPI {
  // 入队（单位：同角色批次，携带辅助判断指令）
  enqueueBatch(batch: TransferBatch): Promise<void>;

  // 打断守卫：若队列中有 interrupt 批次且主会话正在处理 → 触发硬 abort
  // （是否真的打断按 interrupt-mechanism.md §5 的四条件判断）
  maybeInterruptInFlight(): Promise<void>;

  // 查询
  size(): number;                  // 等待中的批次数
  isEmpty(): boolean;
  peekBatches(): TransferBatch[];  // 按到达顺序查看等待中的批次

  // 调度提取（主会话每处理完一个批次调用一次）：
  //   有 interrupt 批次 → 取最后一个，之前被跳过的批次以 references 附带（只读，本体留队列）
  //   无 → FIFO 取队首
  // 详见 interrupt-mechanism.md §3（SSOT）
  nextBatch(): { primary: TransferBatch; references: TransferBatch[] } | null;

  // ignore 指令的队列侧执行：移除指定的未处理批次（interrupt-mechanism.md §4）
  removeBatches(batchIds: string[]): void;

  completeBatch(batchId: string): void;

  // 状态
  isProcessing(): boolean;
  getCurrentBatch(): TransferBatch | null;
}
```

---

### 5.3 Session API

```typescript
interface SessionAPI {
  // 处理
  process(input: any): Promise<any>;
  
  // 状态
  getStatus(): SessionStatus;
  isIdle(): boolean;
  isProcessing(): boolean;
  
  // 打断（仅主会话）
  interrupt?(): Promise<void>;
  
  // 压缩
  shouldCompress(): boolean;
  compressAndNew(): Promise<void>;
  
  // 系统提示词
  loadSystemPrompt(): Promise<string>;
}

interface AuxiliarySessionAPI extends SessionAPI {
  process(batch: Message[], reason: TriggerReason): Promise<void>;

  // 接收主会话反馈：仅把 feedback 包成 FeedbackItem 入队暂存，不调模型、不触发处理。
  // 下次辅助会话被真实触发时，随批带出作为只读上下文（见 architecture.md §3.4）。
  enqueueFeedback(feedback: MainFeedback): void;

  // 错误状态
  errorState: AuxiliaryErrorState;
}

interface AuxiliaryErrorState {
  isInError: boolean;           // 是否处于错误状态
  consecutiveFailures: number;  // 连续失败次数
  lastSuccessTime?: number;     // 上次成功时间（毫秒时间戳）
}

interface MainSessionAPI extends SessionAPI {
  process(batch: Message[]): Promise<void>;
  interrupt(): Promise<void>;
  getCurrentBatchSize(): number;
}
```

**辅助会话错误状态说明**：
- `isInError = true`：辅助会话处于错误状态，后续调用失败时不重试，直接降级
- `consecutiveFailures`：记录连续失败次数
- `lastSuccessTime`：记录上次成功时间，用于判断是否恢复

**降级策略**：
- 第一次失败：重试 3 次（5秒、10秒、30秒退避）
- 重试失败：延迟 2 分钟投递，标记 `isInError = true`
- 后续失败：延迟 2 分钟投递（不重试）
- 调用成功：清除错误状态

---

## 六、事件数据结构

### 6.1 事件类型

```typescript
type DualSessionEvent = 
  | MessageEnqueuedEvent
  | AuxiliaryTriggeredEvent
  | AuxiliaryDecisionEvent
  | MainQueueAppendEvent
  | MainQueueInterruptEvent
  | MainSessionProcessingEvent
  | MainSessionCompletedEvent
  | FeedbackGeneratedEvent;

interface BaseEvent {
  type: string;
  timestamp: Date;
  agentAid: string;
  peerKey: string;
}

interface MessageEnqueuedEvent extends BaseEvent {
  type: 'message-enqueued';
  messageId: string;
}

interface AuxiliaryTriggeredEvent extends BaseEvent {
  type: 'auxiliary-triggered';
  reason: TriggerReason;
  batchSize: number;
}

interface AuxiliaryDecisionEvent extends BaseEvent {
  type: 'auxiliary-decision';
  decision: AuxiliaryDecision;
  processedMessageIds: string[];
}

interface MainQueueAppendEvent extends BaseEvent {
  type: 'main-queue-append';
  messageIds: string[];
}

interface MainQueueInterruptEvent extends BaseEvent {
  type: 'main-queue-interrupt';
  messageIds: string[];
  currentBatchSize: number;
}

interface MainSessionProcessingEvent extends BaseEvent {
  type: 'main-session-processing';
  batchId: string;
  batchSize: number;
}

interface MainSessionCompletedEvent extends BaseEvent {
  type: 'main-session-completed';
  batchId: string;
  repliesCount: number;
}

interface FeedbackGeneratedEvent extends BaseEvent {
  type: 'feedback-generated';
  feedback: MainFeedback;          // 已包成 FeedbackItem 入队暂存，等待下次触发随批带出
}
```

---

## 七、日志数据结构

### 7.1 日志格式

```typescript
interface LogEntry {
  timestamp: string;               // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;               // AuxiliaryQueue / AuxiliarySession / MainQueue / MainSession
  action: string;                  // enqueue / trigger / decision / append / interrupt / processing / completed
  
  // 上下文
  agentAid?: string;
  peerKey?: string;
  
  // 详细信息
  details: Record<string, any>;
  
  // 错误信息（如果 level = error）
  error?: {
    message: string;
    stack?: string;
  };
}
```

**示例**：
```json
{
  "timestamp": "2026-07-01T10:30:00.123Z",
  "level": "info",
  "component": "AuxiliaryQueue",
  "action": "enqueue",
  "agentAid": "agent.aid.pub",
  "peerKey": "aun#owner.aid.pub",
  "details": {
    "messageId": "msg-001",
    "queueSize": 3
  }
}
```

---

## 八、监控指标数据结构

### 8.1 指标定义

```typescript
interface DualSessionMetrics {
  // 辅助队列指标
  auxiliaryQueue: {
    currentSize: number;
    totalEnqueued: number;
    totalProcessed: number;
    avgWaitTimeMs: number;
    maxWaitTimeMs: number;
  };
  
  // 辅助会话指标
  auxiliarySession: {
    totalCalls: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
    decisions: {
      hold: number;
      delay: number;
      transfer: number;
    };
  };
  
  // 主队列指标
  mainQueue: {
    currentSize: number;
    totalAppended: number;
    totalInterrupts: number;
    interruptSuccessRate: number;  // 成功打断的比例
  };
  
  // 主会话指标
  mainSession: {
    totalBatches: number;
    avgBatchSize: number;
    avgProcessingTimeMs: number;
    totalReplies: number;
  };
  
  // 反馈指标
  feedback: {
    totalGenerated: number;
    totalAcked: number;
    avgAckLatencyMs: number;
  };
  
  // 时间窗口
  timeWindow: {
    startAt: string;               // ISO 8601
    endAt: string;                 // ISO 8601
  };
}
```

---

## 九、错误数据结构

### 9.1 错误类型

```typescript
class DualSessionError extends Error {
  code: string;
  component: string;
  details?: Record<string, any>;
}

// 具体错误类型
class AuxiliaryQueueFullError extends DualSessionError {
  code = 'AUXILIARY_QUEUE_FULL';
  component = 'AuxiliaryQueue';
}

class AuxiliaryCallError extends DualSessionError {
  code = 'AUXILIARY_CALL_FAILED';
  component = 'AuxiliarySession';
}

class MainQueueError extends DualSessionError {
  code = 'MAIN_QUEUE_ERROR';
  component = 'MainQueue';
}

class MainSessionCallError extends DualSessionError {
  code = 'MAIN_SESSION_CALL_FAILED';
  component = 'MainSession';
}

class SendReplyError extends DualSessionError {
  code = 'SEND_REPLY_FAILED';
  component = 'MainSession';
}

class FeedbackStoreError extends DualSessionError {
  code = 'FEEDBACK_STORE_ERROR';
  component = 'FeedbackStore';
}
```

---

## 十、版本兼容性

### 10.1 数据结构版本

```typescript
interface DataStructureVersion {
  version: string;                 // 语义化版本（如 "1.0.0"）
  schemaUrl?: string;              // JSON Schema URL（可选）
}

// 在序列化数据中包含版本信息
interface VersionedData<T> {
  _version: DataStructureVersion;
  data: T;
}
```

**示例**：
```json
{
  "_version": {
    "version": "1.0.0"
  },
  "data": {
    "batchId": "batch-001",
    "processedAt": "2026-07-01T10:30:00Z",
    "processedMessageIds": ["msg-001"],
    "summary": "...",
    "replies": ["..."]
  }
}
```

---

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队

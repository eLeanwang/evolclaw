# 辅助队列消息处理流程

**版本**: 1.0  
**创建时间**: 2026-07-08  
**状态**: 设计定稿

---

## 一、核心原则

### 1.1 辅助会话的上下文记忆

**关键点**：辅助会话是一个持续的对话，具有上下文记忆能力。

- ✅ 已判断过的消息会留在辅助会话的上下文中
- ✅ 新消息到来时，只需要给辅助会话新消息
- ✅ 辅助会话结合上下文和新消息，综合判断整体处理策略

### 1.2 批次提取规则

本系统有**两个不同的提取函数**，用途不同，不可混用：

| 函数 | 用途 | 提取的状态 | 去向 |
|------|------|-----------|------|
| `extractBatch()` | 喂给辅助会话判断 | 仅 PENDING（+ 顺带反馈项） | 辅助会话（消息项 + 反馈项） |
| `extractForceTransferBatch()` | 强制转投（队列满） | 所有未投递消息（含 HOLD/DELAY） | 直接投主队列，不经辅助会话 |

> **职责边界**：辅助队列/辅助会话**全程不做角色检查**。消息角色一致性（避免权限污染）
> 由**主队列/主会话**在提取处理批次时负责。辅助侧只关心「何时投递」，不关心「谁发的」。

#### extractBatch()：喂给辅助会话

```typescript
// 返回一个异构批次：待判断的新消息（kind:'message'，同角色）+ 积攒的反馈（kind:'feedback'）
extractBatch(): AuxItem[] {
  const batch: AuxItem[] = [];
  let batchRole: PeerRole | undefined;  // 本批的统一角色（首条 PENDING 消息定）

  for (const item of this.items) {
    // 反馈标记项：随本批带出作为只读上下文，带出后即移除
    // （反馈是纯上下文，不占 maxBatchSize 名额，也不是"待判断消息"）
    if (item.kind === 'feedback') {
      batch.push({ kind: 'feedback', feedback: item.feedback });
      this.markForRemoval(item);
      continue;
    }

    // 消息项：只提取 PENDING 状态的消息，且**同一批只取同一角色**（角色同质批次）
    // 遇到不同 peerRole 即停止——它们留给下一轮提取（与主会话批次机制一致）
    // HOLD/DELAY 的消息已经在辅助会话上下文中，不重复提取
    // HOLD/DELAY 到期由独立的 triggerExpiredScan() 处理，不在此路径
    if (item.state === MessageState.PENDING) {
      if (batchRole === undefined) batchRole = item.message.peerRole;
      else if (item.message.peerRole !== batchRole) break;  // 角色变化 → 本批截止

      batch.push({ kind: 'message', message: item.message });
      // ✅ 提取即标记：这条消息即将被喂给辅助会话，进入其上下文
      // 此后判断期间新到的消息不会被本次决策裹挟
      item.processedByAuxiliary = true;

      if (this.countMessages(batch) >= maxBatchSize) {
        break;
      }
    }
  }

  // 统一移除本批带出的反馈项
  this.flushRemovals();
  return batch;
}
```

**关键点**：
- ✅ 只提取 PENDING（新消息），提取即标记 `processedByAuxiliary = true`
- ✅ **角色同质批次**：遇到不同 `peerRole` 即截批——批次自此以同角色为单位流转，
     transfer 后直接成为主队列的调度单位（主队列不再拆散重切，见 interrupt-mechanism.md §2）。
     角色切分是机械分组（按字段值），不是权限判断，不违反"辅助侧不做角色检查"的分工
- ✅ 标记时机很关键：消息被选中喂给辅助会话的那一刻就标记，
     这样 transfer 决策时 `getProcessedByAuxiliary()` 能准确圈定"辅助会话见过的消息"，
     判断期间新入队的 PENDING（`processedByAuxiliary = false`）不会被误投
- ✅ **反馈随批带出**：队列里的 `FeedbackItem` 一并放进本批（`kind:'feedback'`），带出后即移除；
     它是只读上下文、**不计入 `maxBatchSize`**（该上限只约束待判断消息数），也不产出决策
- ✅ **不负责 HOLD/DELAY 到期**：到期由 `triggerExpiredScan()` 独立扫描转投（见 §6.2），
     与批次提取解耦——即使没有新 PENDING 消息，到期消息也能按时投出
- ✅ HOLD 的消息**不提取**（已在辅助会话上下文中；到期兜底走 §6.2）
- ✅ DELAY 的消息**不提取**（不论是否到期，到期由 `triggerExpiredScan()` 处理）

> **反馈搭便车的时机**：`extractBatch()` 只在辅助会话被真实触发（防抖/最早消息超时/队列满/
> 延迟到期）时调用，反馈不额外触发它。所以反馈总是"等到下一次决策顺路带走"，
> 零额外 LLM 调用、零额外唤醒（见 architecture.md §3.4）。若某次带出的批次里只有反馈、
> 没有 PENDING 消息，辅助会话读入反馈更新上下文即可，本轮不产出决策。

#### extractForceTransferBatch()：强制转投

队列满时使用。与 `extractBatch()` 不同，它**不区分状态**——因为强制转投的目的就是把积压的队列（包括一直 HOLD 的消息）清空。

```typescript
extractForceTransferBatch(): Message[] {
  // 直接取出队列中所有未投递消息（不区分 PENDING/HOLD/DELAY，不做角色检查）
  const messages = this.messages
    .slice(0, maxBatchSize)
    .map(qm => qm.message);
  
  return messages;
}
```

**关键点**：
- ✅ 取出队首起的所有未投递消息（受 maxBatchSize 限制）
- ✅ **包含所有状态**：PENDING / HOLD / DELAY（不论 DELAY 是否到期）
- ✅ 强制转投的目的是清空积压队列，所以 HOLD/未到期 DELAY 也一并转投
- ✅ 不经过辅助会话判断，不能打断
- ❌ **不做角色检查**——辅助侧全程不碰角色，角色一致性由主队列/主会话负责（见「职责边界」）

> **边界说明**：队列满触发阈值（如 50）与 `maxBatchSize` 可能不同。若积压超过
> `maxBatchSize`，单次只投前 `maxBatchSize` 条，队列仍 ≥ 阈值时会**立即再次触发**，
> 直到降到阈值以下。即多次强制转投接力清空，不会一次超额投递，也不会漏投。

### 1.3 辅助会话输入格式

一次触发的批次是**带 `kind` 标记的项列表**：待判断的新消息（`kind:'message'`）与被动带出的
反馈（`kind:'feedback'`）平级混在同一个列表里。完整定义见 data-structures.md §1.3。

```typescript
interface AuxiliaryInput {
  // extractBatch() 的返回：消息项 + 反馈项混合
  // ❌ 不需要 queue 字段（已判断的消息在辅助会话上下文中）
  items: AuxItem[];
  remainingInQueue: number;      // 【信号A】去掉本批次后辅助队列剩余数（催辅助会话加快）
  mainSession: {
    status: 'idle' | 'processing';
    pendingCount: number;        // 【信号B】主队列待处理数（=queueSize，压辅助会话放慢）
  };
}

type AuxItem =
  | { kind: 'message';  message: Message }        // 待判断的新消息
  | { kind: 'feedback'; feedback: MainFeedback }; // 主会话反馈，只读上下文，不产出决策
```

> `remainingInQueue` 只数**待判断消息**，不含反馈项——反馈不是待判断对象。

---

## 二、消息状态流转

### 2.1 状态定义

```typescript
enum MessageState {
  PENDING = 'pending',      // 新到达，未判断
  HOLD = 'hold',            // 挂起，等待重新判断
  DELAY = 'delay',          // 延迟投递
  // transfer 时消息立即移出队列，无 TRANSFERRED 中间态
}

interface QueuedMessage {
  message: Message;
  state: MessageState;
  processedByAuxiliary: boolean;  // 是否已被喂给辅助会话（进入其上下文）
  expireAt?: Date;                // DELAY/HOLD 的到期时刻（批内统一，见 §6）
  expireReason?: 'delay' | 'hold-timeout';
}
```

### 2.2 两个正交维度：state 与 processedByAuxiliary

这是本设计的关键——一条消息有两个独立的维度：

- **`state`**：辅助会话对它的**判断结果**（PENDING 未判断 / HOLD / DELAY）
- **`processedByAuxiliary`**：它是否**已经被喂给辅助会话**（进入其上下文）

两者不等价。典型情况：消息刚被 `extractBatch()` 提取喂给辅助会话，
此时 `processedByAuxiliary = true`，但辅助会话还没返回决策，`state` 仍是 PENDING。

| 关键 API | 返回 | 用途 |
|---------|------|------|
| `getProcessedByAuxiliary()` | 所有 `processedByAuxiliary === true` 的消息 | transfer 时确定投递范围 |
| `getExpired(now)` | 所有 `expireAt <= now` 的消息（DELAY 与 HOLD 统一） | `triggerExpiredScan()` 扫描到期转投 |
| `getAllUndelivered()` | 所有未投递消息（不论是否喂过辅助会话） | ⚠️ 仅内部统计用，**不用于 transfer 投递** |

### 2.3 状态流转图

```
消息到达 → PENDING, processedByAuxiliary=false
  ↓ extractBatch() 提取 → processedByAuxiliary=true（进入辅助会话上下文）
  ↓ (辅助会话判断)
  ├─→ HOLD (挂起) ─→ 留在队列（仍在上下文中），expireAt=holdSince+1h, expireReason='hold-timeout'
  │                    └─→ 期间新消息可重判为 DELAY/TRANSFER；否则到期兜底转投
  ├─→ DELAY (延迟) ─→ expireAt=now+随机延迟, expireReason='delay'
  └─→ TRANSFER (立即) ─→ 投递「已喂给辅助会话」的消息 ─→ 移除出队列

  HOLD/DELAY 的到期统一由 triggerExpiredScan() 处理：
  到点扫描 expireAt<=now 的消息 ─→ 转投主队列 ─→ 移除出队列 ─→ 重挂下一个最早到期的定时器
```

---

## 三、完整流程示例

### 场景 1：transfer（立即投递）

```
T0: 消息 [1-10] 到达
→ 入辅助队列，状态：PENDING
→ 辅助队列：[1-10(PENDING)]

T+3s: 防抖触发
→ 提取批次：[1-10]
→ 给辅助会话：newMessages: [1-10]

辅助会话判断：
{
  action: 'transfer',
  interrupt: false,
  reason: '用户分段输入已完成'
}

代码层执行：
→ 获取已喂给辅助会话的消息（processedByAuxiliary=true）：[1-10]
→ 投递到主队列（不打断）
→ 从辅助队列移除 [1-10]
→ 辅助队列：[]
```

---

### 场景 2：delay（延迟投递）

```
T0: 消息 [1-10] 到达
→ 辅助队列：[1-10(PENDING)]

T+3s: 防抖触发
→ 提取批次：[1-10]
→ 给辅助会话：newMessages: [1-10]

辅助会话判断：
{
  action: 'delay',
  delayLevel: 'medium',  // 2分钟
  reason: '等待其他 agent 回复'
}

代码层执行（假设对端是 agent，系数 1.0）：
→ levelMs = medium = 120000ms
→ effectiveLevelMs = 120000 × 1.0 = 120000ms
→ totalDelay = baseDelayMs + random(0, 120000)   // 若对端是人则上限减半 = 60000
→ [1-10] 标记为 DELAY，批内统一 expireAt = 当前时间 + totalDelay, expireReason = 'delay'
→ [1-10] 留在辅助队列
→ armExpiryTimer()（重算最早到期，维护单个定时器）
→ 辅助队列：[1-10(DELAY)]

---

情况 A：delay 到期，没有新消息

T+122s: 到期定时器触发 → triggerExpiredScan()
→ 扫描队列，找出所有 expireAt <= now 的消息（DELAY/HOLD 统一）：[1-10]
→ ✅ 直接投递到主队列（不再给辅助会话判断）
→ 从辅助队列移除 [1-10]
→ armExpiryTimer() 重挂（此时无待到期消息，不再挂）
→ 辅助队列：[]

（不依赖 extractBatch —— 即使此刻队列里没有任何 PENDING 新消息，到期消息也能按时投出）

---

情况 B：delay 期间收到新消息

T+10s: 消息 11 到达
→ 消息 11 入队，状态：PENDING
→ 辅助队列：[1-10(DELAY), 11(PENDING)]

T+13s: 防抖触发
→ 提取批次：[11]（只提取 PENDING，DELAY 未到期不提取）
→ 给辅助会话：newMessages: [11]
   （✅ [1-10] 已在辅助会话上下文中，不重复给）

辅助会话：
  - 从上下文中知道 [1-10] 在 delay 状态
  - 看到新消息 [11]
  - 综合判断整体处理策略

辅助会话判断（可能的输出）：

A) transfer（认为现在应该立即处理）：
{
  action: 'transfer',
  interrupt: false,
  reason: '新消息紧急，立即处理'
}
→ 投递辅助会话上下文中的消息（processedByAuxiliary=true）：
  [1-10] 之前判断过 + [11] 本轮刚喂给辅助会话 = [1-11]
→ ✅ [1-11] 全部投递到主队列（包括 delay 中的 1-10）
→ 从辅助队列移除 [1-11]
→ 辅助队列：[]

  ⚠️ 若在 T+13s 判断期间又到了消息 12（未喂给辅助会话，processedByAuxiliary=false），
     则只投 [1-11]，12 留在队列等下一轮

B) delay（新消息也延迟）：
{
  action: 'delay',
  delayLevel: 'short',
  reason: '继续等待'
}
→ [11] 标记为 DELAY
→ [1-10] 保持原 DELAY 状态和到期时间
→ 辅助队列：[1-10(DELAY), 11(DELAY)]

C) hold（新消息挂起）：
{
  action: 'hold',
  reason: '与 agent 无关的闲聊'
}
→ [11] 标记为 HOLD
→ [1-10] 保持原 DELAY 状态和到期时间
→ 辅助队列：[1-10(DELAY), 11(HOLD)]
```

---

### 场景 3：hold（挂起后重新判断）

```
T0: 消息 [1-10] 到达
→ 辅助队列：[1-10(PENDING)]

T+3s: 防抖触发
→ 提取批次：[1-10]
→ 给辅助会话：newMessages: [1-10]

辅助会话判断：
{
  action: 'hold',
  reason: '与本 agent 无关的闲聊'
}

代码层执行：
→ [1-10] 标记为 HOLD
→ [1-10] 留在辅助队列
→ 辅助队列：[1-10(HOLD)]

---

T+60s: 消息 11 到达
→ 消息 11 入队，状态：PENDING
→ 辅助队列：[1-10(HOLD), 11(PENDING)]

T+63s: 防抖触发
→ 提取批次：[11]（只提取 PENDING）
→ 给辅助会话：newMessages: [11]
   （✅ [1-10] 已在辅助会话上下文中，不重复给）

辅助会话：
  - 从上下文中知道 [1-10] 之前被判断为 hold
  - 看到新消息 [11]
  - 结合上下文重新判断整体是否还应该 hold

辅助会话判断（可能的输出）：

A) transfer（发现相关了）：
{
  action: 'transfer',
  interrupt: false,
  reason: '消息 11 提到了本 agent，之前的上下文也需要了'
}
→ 获取已喂给辅助会话的消息（processedByAuxiliary=true）：
  [1-10] 之前 HOLD + [11] 本轮 batch = [1-11]
→ [1-11] 全部投递到主队列
→ 从辅助队列移除 [1-11]
→ 辅助队列：[]

B) hold（继续挂起）：
{
  action: 'hold',
  reason: '仍然与本 agent 无关'
}
→ [11] 标记为 HOLD（只动本批次）
→ [1-10] 保持原 HOLD 状态（本就在上下文中，不重复标记）
→ 辅助队列：[1-10(HOLD), 11(HOLD)]
```

---

## 四、强制转投机制

### 4.1 队列满强制转投（≥50 条）

辅助队列唯一的强制转投场景：队列累积到上限时，不再经过辅助会话判断，直接把积压消息全部投给主队列，保证队列不无限增长。

```
辅助队列：[1-50]（混合状态：PENDING/HOLD/DELAY）

触发：队列满（≥50 条）
→ 调用 extractForceTransferBatch()（取出所有未投递消息，不区分状态，不做角色检查）
→ 提取 [1-50]（含 PENDING/HOLD/未到期 DELAY）

代码层执行：
→ ✅ 不经过辅助会话判断
→ ✅ [1-50] 直接追加转投到主队列
→ ❌ 不能打断（强制转投）
→ 从辅助队列移除 [1-50]
→ 辅助队列：[]
```

> **注意**：强制转投会把一直 HOLD 的消息、未到期的 DELAY 消息一并投出——
> 这是队列满时的降级行为（清空积压），优先保证队列不无限增长。

> **强制转投也按角色切批**：取出的消息按 `peerRole` 机械切成若干同角色批次、保序入主队列
> （均不带 interrupt）。切批是字段分组，不是权限判断——与 §7.3 的职责边界一致。

---

## 五、投递数据结构

### 5.1 投递批次（主队列的调度单位）

辅助侧投给主队列的是**同角色批次（TransferBatch）**——批次在 transfer 边界成形，
主队列**不再拆散重切**（调度规则见 [interrupt-mechanism.md](./interrupt-mechanism.md) §2/§3）。

```typescript
interface TransferBatch {
  batchId: string;         // 批次标识（反馈定案、队列移除都以批次为单位）
  batchRole: PeerRole;     // 本批次的统一角色——仅作权限分组键（PreToolUse Hook 判权限用），
                           // 不代表优先级；优先级/打断均来自辅助会话对内容的判断
  messages: Message[];     // 同角色消息（保持到达顺序）

  // 辅助会话对本批次的判断指令（主队列照此调度，不自行判断）
  interrupt: boolean;      // 是否要求打断/优先处理（调度：遍历取最后一个 interrupt 批次优先）
  previousMessageStrategy?: 'ignore' | 'defer' | 'continue';
                           // interrupt=true 时必填，作用于之前所有未定案批次
                           // （执行语义见 interrupt-mechanism.md §4）
}
```

> **角色分组是机械动作，不是权限判断**：按 `message.peerRole` 切组不需要理解权限语义，
> 辅助侧做的仅是"同角色连续消息归同批"；权限判断（owner 能做什么）仍完全在主会话侧的
> PreToolUse Hook。这与"辅助侧不做角色检查"的分工不矛盾——检查的是权限，分组的是字段。

### 5.2 投递到主队列（保序、逐批、各带指令）

transfer 决策触发时，**所有已判断未投递的批次按到达顺序全部投出**（消息按顺序投递、
所有消息都会被投递的原则）——之前 HOLD/DELAY 的批次被裹挟同行，但**各带各的判断指令**：
被裹挟的旧批次不带 interrupt（它们当初的判断是 hold/delay）；只有触发本次 transfer 的
批次携带本次判断的 `interrupt`/`previousMessageStrategy`。

```typescript
async function transferToMain(decision: AuxiliaryDecision, currentBatch: TransferBatch) {
  // 1. 之前已判断（hold/delay）、仍在辅助队列的批次：按序先投，不带 interrupt
  for (const held of auxiliaryQueue.getJudgedBatchesInOrder()) {
    await mainQueue.enqueueBatch({ ...held, interrupt: false });
    auxiliaryQueue.removeBatch(held.batchId);
  }
  // 2. 触发本次 transfer 的批次：携带本次判断的指令
  await mainQueue.enqueueBatch({
    ...currentBatch,
    interrupt: decision.interrupt || false,
    previousMessageStrategy: decision.previousMessageStrategy,
  });
  auxiliaryQueue.removeBatch(currentBatch.batchId);

  // 3. 若 interrupt=true 且主会话正在处理 → 触发打断守卫（见 interrupt-mechanism.md §5）
  if (decision.interrupt) {
    await mainQueue.maybeInterruptInFlight();
  }
}
```

> **调度在主队列侧**：主会话每处理完一个批次，遍历队列取「最后一个 interrupt 批次」优先
> （被跳过的批次作 reference 注入、本体留队列排队），无 interrupt 批次则 FIFO。
> 完整调度规则与 reference 语义见 [interrupt-mechanism.md](./interrupt-mechanism.md) §3——
> 那里是 SSOT，本文不重复。

---

## 六、决策执行逻辑

### 6.1 完整代码

> 以下伪代码中，`auxiliaryQueue` 为当前会话的辅助队列实例，`chatType`（`'group'|'private'`）
> 来自会话上下文，`batch` 是本轮 `extractBatch()` 提取并已喂给辅助会话的消息（仅 PENDING）。
> `logger`/`setTimeout` 为运行时环境提供。

```typescript
async function executeDecision(
  output: AuxiliaryOutput,
  batch: Message[]
): Promise<void> {
  if (output.type !== 'aun-decision') {
    return;
  }
  
  const { action, delayLevel, interrupt, reason } = output.decision;
  
  if (action === 'hold') {
    // ✅ 只标记本批次为 HOLD。到期时刻 = 首次 HOLD 时刻 + 超时（默认 1 小时）。
    //    批内统一取同一个 expireAt，避免逐条 skew（见本节末「批次统一到期」）。
    const now = Date.now();
    const expireAt = new Date(now + config.holdTimeoutMs);  // 默认 1h
    for (const msg of batch) {
      auxiliaryQueue.updateState(msg.id, MessageState.HOLD, {
        expireAt,
        expireReason: 'hold-timeout',
      });
    }
    armExpiryTimer();  // 重算最早到期并维护单个定时器（HOLD 兜底不依赖新消息）
    logger.info('[Auxiliary] Hold', { count: batch.length, expireAt, reason });
  }
  
  else if (action === 'delay') {
    // 计算延迟时间（单聊与群聊公式相同）
    // 实际延迟 = baseDelayMs + random(0, effectiveLevelMs)
    // effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数
    const levelMs = baseLevelMs(delayLevel || 'medium');
    const peerFactor = isAgentPeer(batch) ? 1.0 : 0.5;  // 含 agent→1.0，全是人→0.5
    const effectiveLevelMs = levelMs * peerFactor;
    const totalDelay = config.baseDelayMs + Math.random() * effectiveLevelMs;
    const expireAt = new Date(Date.now() + totalDelay);  // 批内统一，无 skew
    
    // ✅ 只标记本批次为 DELAY
    for (const msg of batch) {
      auxiliaryQueue.updateState(msg.id, MessageState.DELAY, {
        expireAt,
        expireReason: 'delay',
      });
    }
    
    armExpiryTimer();  // 与 HOLD 共用同一套到期扫描/定时器
    
    logger.info('[Auxiliary] Delay', { 
      count: batch.length,
      levelMs,
      peerFactor,
      totalDelay, 
      expireAt,
      reason 
    });
  }
  
  else if (action === 'transfer') {
    // ✅ 只投递辅助会话上下文中的消息（processedByAuxiliary === true）
    //    这已涵盖本次 batch（extractBatch 提取时已标记）+ 之前 HOLD/DELAY 的消息
    // ❌ 不含判断期间新入队、尚未喂给辅助会话的 PENDING 消息
    const toTransfer = auxiliaryQueue.getProcessedByAuxiliary();
    
    // 构造投递批次（仅消息列表 + 是否请求打断，不做角色分组）
    const transferBatch = {
      messages: toTransfer,
      interrupt: interrupt || false,
    };
    
    // 投递（是否真的打断、如何按角色分批由主队列决定）
    await transferToMain(transferBatch);
    
    // 从辅助队列移除（仅移除已投递的，判断期间新到的 PENDING 保留）
    auxiliaryQueue.remove(toTransfer.map(m => m.id));

    // 被移除的可能含 DELAY/HOLD（带 expireAt），移除后最早到期时刻可能变化 → 重挂定时器
    armExpiryTimer();

    logger.info('[Auxiliary] Transfer', { 
      count: toTransfer.length,
      interrupt,
      reason 
    });
  }
}

// 等级 → 基础时长（随机延迟的满值上限，未乘对端系数前）
function baseLevelMs(level: 'short' | 'medium' | 'long'): number {
  switch (level) {
    case 'short': return 60000;   // 1分钟
    case 'medium': return 120000; // 2分钟
    case 'long': return 180000;   // 3分钟
  }
}

// 对端类型判定：本批次消息集合只要含 agent 就算 agent，全是人才算人
// （群聊、单聊统一此规则；单聊对端就是那一个主体）
function isAgentPeer(batch: Message[]): boolean {
  return batch.some(m => m.peerRole !== 'anonymous' && isAgent(m.peerId));
}
```

> **对端系数由代码判定，辅助会话不输出**：辅助会话只需给出 `delayLevel`。
> 对端是人还是 agent 由发送者类型（关系层）自动得出，人 ×0.5、agent ×1.0。

### 6.2 到期扫描：triggerExpiredScan() + armExpiryTimer()

DELAY 与 HOLD 到期**共用同一套机制**，由独立定时器驱动、不依赖 `extractBatch()`——
即使队列里没有任何 PENDING 新消息（队列全程安静），到期消息也能按时投出。
这一点是修掉旧「HOLD 每次辅助会话处理时才检查」漏洞的关键。

**定时器策略**：全队列**只维护一个到期定时器**（数量 = O(1)，与 DELAY/HOLD 消息条数无关）。
定时器只负责「叫醒扫描」，不绑定某一条消息；叫醒后**转投所有已到期消息**，再按剩余最早到期时刻
重挂下一个定时器。

```typescript
let expiryTimer: Timeout | null = null;

// 维护单个到期定时器：取队列中最早的 expireAt，重挂定时器
function armExpiryTimer(): void {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }

  // 队列中所有带 expireAt 的消息（DELAY + HOLD），取最早到期时刻
  const next = auxiliaryQueue.getEarliestExpireAt();  // null 表示无待到期消息
  if (!next) return;

  const delay = Math.max(0, next.getTime() - Date.now());
  expiryTimer = setTimeout(() => { void triggerExpiredScan(); }, delay);
}

// 到期扫描：转投所有 expireAt <= now 的消息（DELAY 与 HOLD 一视同仁）
async function triggerExpiredScan(): Promise<void> {
  const now = new Date();

  // ⚠️ 用 <= now 整体扫描，而非「只处理触发定时器的那一条」——
  //    这样同批/相近到期的消息一次全部带走，不会因几十毫秒差被漏到下一轮。
  const expired = auxiliaryQueue.getExpired(now);  // 所有 expireAt <= now

  if (expired.length > 0) {
    // 到期消息此前已被辅助会话判断过（delay 或 hold），到期只是执行既定决策，不再判断、不打断
    await transferToMain({
      messages: expired.map(qm => qm.message),
      interrupt: false,
    });
    auxiliaryQueue.remove(expired.map(qm => qm.message.id));

    logger.info('[Auxiliary] Expired transfer', {
      count: expired.length,
      byReason: countByExpireReason(expired),  // { delay, 'hold-timeout' }
    });
  }

  // 关键：扫完必须重挂——保证「差几十毫秒的下一批」被下一个定时器捕获，永不漏
  armExpiryTimer();
}
```

**重启恢复**（不持久化定时器，纯靠消息 `expireAt` 重建）：

```typescript
// 加载持久化队列后调用一次
async function rebuildExpiryOnRestart(): Promise<void> {
  const now = new Date();
  const expired = auxiliaryQueue.getExpired(now);   // 停机期间已过期的
  if (expired.length > 0) {
    await transferToMain({ messages: expired.map(qm => qm.message), interrupt: false });
    auxiliaryQueue.remove(expired.map(qm => qm.message.id));
  }
  armExpiryTimer();  // 其余未到期的，按最早 expireAt 重挂一个定时器
}
```

**要点**：
- ✅ DELAY / HOLD 到期统一处理，**与批次提取解耦**，不依赖新消息到来（补齐 HOLD 安静期兜底）
- ✅ 全队列**单个定时器**，数量 O(1)；`expireAt` 由批次统一计算，批内无 skew
- ✅ 扫描用 `expireAt <= now` **整体转投**，扫完**必重挂**——相近到期不漏投
- ✅ 到期消息不再判断、不打断（执行既定的 delay/hold 决策）
- ✅ 重启后按消息 `expireAt` 重建：过期的立即投、未过期的重挂定时器，幂等

---

## 七、关键设计要点

### 7.1 transfer 投递哪些消息？

**投递范围 = 辅助会话上下文中的消息**（即所有已喂给过辅助会话的消息）：
- 之前判断为 hold/delay 的消息（已在上下文中）
- 本次 batch（本次喂进去的）
- ❌ **不含**判断期间新入队、尚未喂给辅助会话的 PENDING 消息

**原因**：辅助会话的决策只对**它上下文里见过的消息**负责。

```
T0: [1-10] 提取为 batch，喂给辅助会话，开始判断（模型调用耗时）...
T+0.5s: 消息 11 到达 → 入队 PENDING（未喂给辅助会话）
T+0.8s: 消息 12 到达 → 入队 PENDING（未喂给辅助会话）
T+1s: 辅助会话输出 transfer
      → ✅ 只投递 [1-10]（辅助会话上下文中的消息）
      → ❌ 不投 [11, 12]（辅助会话从没见过它们）

[11, 12] 留在队列，processedByAuxiliary = false
下一轮防抖触发时作为新 batch 喂给辅助会话判断
```

**实现**：投递集合 = 所有 `processedByAuxiliary === true` 的消息，
**不是** `getAllUndelivered()`（后者会把判断期间新到的 PENDING 也算进去）。

### 7.2 为什么 hold/delay 只标记本批次？

**原因**：
- hold/delay 只是"暂时不处理本批次"
- 队列中可能还有其他状态的消息（如之前的 delay 还在等待到期）
- 只应该更新本批次的状态，不影响其他消息

### 7.3 角色的职责边界：分组在辅助侧（机械），权限在主侧（语义）

**角色分组（机械）**：辅助队列提取时按 `peerRole` 字段截批（§1.2），批次自此同角色流转。
这只是按字段值分组，不需要理解权限语义，也不影响辅助会话的判断
（辅助判断紧急与否看内容，不看角色高低）。

**权限判断（语义）**：owner/guest 能做什么，完全由主会话侧的 PreToolUse Hook 依据
`batchRole` 判断。辅助侧不做任何权限判断。

**为什么批次必须同角色**：
- 不同角色权限的消息不能合并成一个处理批次
- owner 可改基础设施配置，guest 不能；若混在一批，PreToolUse Hook 权限判断会不明确
- 批次在 transfer 边界已同角色成形，主队列直接以批次为调度单位（**不再拆散重切**），
  辅助会话的判断（打断/忽略/优先）得以精确作用到它判断的那批消息上——判断不失效

---

## 八、总结

### 转投主队列的两种场景

| 场景 | 触发条件 | 提取函数 | 提取的消息 | 是否请求打断 |
|------|---------|---------|-----------|---------|
| **辅助会话 transfer** | 辅助会话判断 | `getProcessedByAuxiliary()`（已喂给辅助会话的） | 辅助会话上下文中的消息（含之前 HOLD/DELAY + 本轮 batch）；**不含**判断期间新到的 PENDING | ✅ 可请求（由 interrupt 决定，最终是否打断由主队列判断） |
| **队列满** | ≥50 条 | `extractForceTransferBatch()` | 所有未投递消息（含 HOLD/未到期 DELAY，不论是否喂过辅助会话） | ❌ 不请求（强制转投） |

> 批次在 transfer 边界已按角色成形（§1.2 提取即同角色），主队列以批次为调度单位、不再拆散。
> 调度顺序（interrupt 批优先、跳过批作 reference）与打断守卫见 interrupt-mechanism.md §3/§5。

### 状态流转规则

| 当前状态 | 是否重新提取正文 | 说明 |
|---------|---------|-----------|
| PENDING | ✅ 提取 | 新消息，作为 newMessages 给辅助会话判断 |
| HOLD | ❌ 不提取 | 已在辅助会话上下文中，仅通过上下文参与新批次判断；留在队列等待 transfer 时一起投递 |
| DELAY | ❌ 不提取 | 已在辅助会话上下文中，仅通过上下文参与新批次判断；到期后直接转投（不再判断） |

> **说明**：HOLD/DELAY 的消息正文不会被重新提取喂给辅助会话（避免重复），
> 它们只通过辅助会话的上下文记忆参与后续新批次的综合判断。
> transfer 时消息立即移出队列，无 TRANSFERRED 中间态。

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 设计定稿

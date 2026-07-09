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
| `extractBatch()` | 喂给辅助会话判断 | 仅 PENDING | 辅助会话（newMessages） |
| `extractForceTransferBatch()` | 强制转投（队列满） | 所有未投递消息（含 HOLD/DELAY） | 直接投主队列，不经辅助会话 |

> **职责边界**：辅助队列/辅助会话**全程不做角色检查**。消息角色一致性（避免权限污染）
> 由**主队列/主会话**在提取处理批次时负责。辅助侧只关心「何时投递」，不关心「谁发的」。

#### extractBatch()：喂给辅助会话

```typescript
extractBatch(): Message[] {
  const batch: Message[] = [];
  
  for (const qm of this.messages) {
    // 只提取 PENDING 状态的消息
    // HOLD/DELAY 的消息已经在辅助会话上下文中，不重复提取
    // DELAY 到期由独立的 triggerDelayExpired() 处理，不在此路径
    
    if (qm.state === MessageState.PENDING) {
      batch.push(qm.message);
      // ✅ 提取即标记：这条消息即将被喂给辅助会话，进入其上下文
      // 此后判断期间新到的消息不会被本次决策裹挟
      qm.processedByAuxiliary = true;
    }
    
    if (batch.length >= maxBatchSize) {
      break;
    }
  }
  
  return batch;
}
```

**关键点**：
- ✅ 只提取 PENDING（新消息），提取即标记 `processedByAuxiliary = true`
- ✅ 标记时机很关键：消息被选中喂给辅助会话的那一刻就标记，
     这样 transfer 决策时 `getProcessedByAuxiliary()` 能准确圈定"辅助会话见过的消息"，
     判断期间新入队的 PENDING（`processedByAuxiliary = false`）不会被误投
- ✅ **不负责 DELAY 到期**：DELAY 到期由 `triggerDelayExpired()` 独立扫描转投（见 §6.2），
     与批次提取解耦——即使没有新 PENDING 消息，到期消息也能按时投出
- ✅ HOLD 的消息**不提取**（已在辅助会话上下文中）
- ✅ DELAY 的消息**不提取**（不论是否到期，到期由 `triggerDelayExpired()` 处理）

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

```typescript
interface AuxiliaryInput {
  type: 'aun-messages';
  aunMessages: {
    newMessages: Message[];      // ✅ 只给本批次提取的消息
    // ❌ 不需要 queue 字段（已判断的消息在辅助会话上下文中）
    remainingInQueue: number;    // 【信号A】去掉本批次后辅助队列剩余数（催辅助会话加快）
  };
  mainSession: {
    status: 'idle' | 'processing';
    pendingCount: number;        // 【信号B】主队列待处理数（=queueSize，压辅助会话放慢）
  };
}
```

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
  transferAt?: Date;              // DELAY 时的到期时间
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
| `getByState(state)` | 队列中指定 `state` 的消息 | `triggerDelayExpired()` 扫描 DELAY 到期 |
| `getAllUndelivered()` | 所有未投递消息（不论是否喂过辅助会话） | ⚠️ 仅内部统计用，**不用于 transfer 投递** |

### 2.3 状态流转图

```
消息到达 → PENDING, processedByAuxiliary=false
  ↓ extractBatch() 提取 → processedByAuxiliary=true（进入辅助会话上下文）
  ↓ (辅助会话判断)
  ├─→ HOLD (挂起) ─→ 留在队列，不再重新提取（仍在辅助会话上下文中）
  ├─→ DELAY (延迟) ─→ 到期 ─→ triggerDelayExpired() 扫描转投 ─→ 移除出队列
  └─→ TRANSFER (立即) ─→ 投递「已喂给辅助会话」的消息 ─→ 移除出队列
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
→ [1-10] 标记为 DELAY，设置 transferAt = 当前时间 + totalDelay
→ [1-10] 留在辅助队列
→ 设置延迟定时器
→ 辅助队列：[1-10(DELAY)]

---

情况 A：delay 到期，没有新消息

T+122s: 延迟定时器触发 → triggerDelayExpired()
→ 扫描队列，找出所有 state=DELAY 且 transferAt 已到期的消息：[1-10]
→ ✅ 直接投递到主队列（不再给辅助会话判断）
→ 从辅助队列移除 [1-10]
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

> **角色一致性不在这里处理**：辅助侧直接把 [1-50] 整体投给主队列，其中可能包含
> 不同角色的发送者。角色分组由**主队列**在提取处理批次时完成（见「职责边界」）。

---

## 五、投递数据结构

### 5.1 投递批次

辅助侧投给主队列的就是**一个消息列表**，每条消息携带自己的发送者信息（含 `peerRole` 角色）。
辅助侧**不计算 batchRole、不做角色分组**——这些是主队列的职责。

```typescript
interface TransferBatch {
  messages: Message[];   // 复用核心 Message 类型（见 data-structures.md）
                         // 每条消息自带 peerId/peerName/peerRole，供主队列后续按角色分组
  interrupt: boolean;    // 辅助会话是否要求打断（transfer 决策携带）
}
```

> 消息的发送者角色用平级字段 `message.peerRole`（不是 `message.from.role`）。
> 主队列据此分组，保证同一处理批次角色统一。

### 5.2 投递到主队列

辅助侧只负责把消息**追加或请求打断**投给主队列，是否真的打断、如何按角色分批，全部由主队列/主会话决定。

```typescript
async function transferToMain(batch: TransferBatch) {
  if (batch.interrupt) {
    // 请求打断——最终是否打断由主队列判断（含角色一致性等条件）
    await mainQueue.interrupt(batch.messages);
  } else {
    await mainQueue.append(batch.messages);
  }
}
```

> **角色一致性与打断条件由主队列负责**：主队列在提取处理批次（`extractBatch`）时按角色分组，
> 保证同一处理批次内角色统一；打断时是否允许，也在主队列侧结合角色一致性判断。
> 打断机制完整论述见 [interrupt-mechanism.md](./interrupt-mechanism.md)，本文不展开。

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
    // ✅ 只标记本批次为 HOLD
    for (const msg of batch) {
      auxiliaryQueue.updateState(msg.id, MessageState.HOLD);
    }
    logger.info('[Auxiliary] Hold', { count: batch.length, reason });
  }
  
  else if (action === 'delay') {
    // 计算延迟时间（单聊与群聊公式相同）
    // 实际延迟 = baseDelayMs + random(0, effectiveLevelMs)
    // effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数
    const levelMs = baseLevelMs(delayLevel || 'medium');
    const peerFactor = isAgentPeer(batch) ? 1.0 : 0.5;  // 含 agent→1.0，全是人→0.5
    const effectiveLevelMs = levelMs * peerFactor;
    const totalDelay = config.baseDelayMs + Math.random() * effectiveLevelMs;
    const transferAt = new Date(Date.now() + totalDelay);
    
    // ✅ 只标记本批次为 DELAY
    for (const msg of batch) {
      auxiliaryQueue.updateState(msg.id, MessageState.DELAY, transferAt);
    }
    
    // 设置延迟定时器
    setTimeout(() => {
      triggerDelayExpired();
    }, totalDelay);
    
    logger.info('[Auxiliary] Delay', { 
      count: batch.length,
      levelMs,
      peerFactor,
      totalDelay, 
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

### 6.2 DELAY 到期扫描：triggerDelayExpired()

DELAY 到期由**独立函数**处理，不依赖 `extractBatch()`。延迟定时器到点后调用，
直接扫描队列、转投到期消息——即使队列里没有任何 PENDING 新消息，到期消息也能按时投出。

```typescript
async function triggerDelayExpired(): Promise<void> {
  const now = new Date();
  
  // 扫描所有 DELAY 且已到期的消息
  const expired = auxiliaryQueue
    .getByState(MessageState.DELAY)
    .filter(qm => qm.transferAt && qm.transferAt <= now);
  
  if (expired.length === 0) {
    return;
  }
  
  // 直接转投到主队列（DELAY 消息之前已被辅助会话判断过，不再判断）
  const transferBatch = {
    messages: expired.map(qm => qm.message),
    interrupt: false,  // 到期投递不打断
  };
  await transferToMain(transferBatch);
  
  // 从辅助队列移除
  auxiliaryQueue.remove(expired.map(qm => qm.message.id));
  
  logger.info('[Auxiliary] Delay expired', { count: expired.length });
}
```

**要点**：
- ✅ 独立扫描 DELAY 到期消息，**与批次提取解耦**
- ✅ 到期消息之前已被辅助会话判断过（判成 delay），到期只是执行延迟决策，不再判断
- ✅ 不打断（到期投递是常规投递）
- ✅ 多条 DELAY 到期时间不同，各自的定时器分别触发；每次扫描只投当下到期的

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

### 7.3 为什么辅助侧不做角色检查？

**原因**：职责分离。辅助侧只回答「何时投递」，不关心「谁发的」。

- 辅助队列/辅助会话全程不碰角色，逻辑更简单，也避免辅助会话的判断被角色因素干扰
- 角色一致性（避免权限污染）是**处理阶段**的问题，由主队列在提取处理批次时统一负责：
  - 不同角色权限的消息不能合并成一个处理批次
  - owner 可改基础设施配置，guest 不能；若混在一批，PreToolUse Hook 权限判断会不明确
  - 所以主队列按角色分组提取批次，保证同一批次角色统一
- 辅助侧投给主队列的消息列表可能含多种角色，主队列负责拆分——**辅助侧无需操心**

---

## 八、总结

### 转投主队列的两种场景

| 场景 | 触发条件 | 提取函数 | 提取的消息 | 是否请求打断 |
|------|---------|---------|-----------|---------|
| **辅助会话 transfer** | 辅助会话判断 | `getProcessedByAuxiliary()`（已喂给辅助会话的） | 辅助会话上下文中的消息（含之前 HOLD/DELAY + 本轮 batch）；**不含**判断期间新到的 PENDING | ✅ 可请求（由 interrupt 决定，最终是否打断由主队列判断） |
| **队列满** | ≥50 条 | `extractForceTransferBatch()` | 所有未投递消息（含 HOLD/未到期 DELAY，不论是否喂过辅助会话） | ❌ 不请求（强制转投） |

> 辅助侧不做角色检查、不做角色分组。转投的消息列表可能含多种角色，
> 由**主队列**在提取处理批次时按角色拆分，并在此判断打断是否允许。

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

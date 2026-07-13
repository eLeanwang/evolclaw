# 双会话响应模式 - 主会话打断与批次调度机制

**版本**: 2.0
**创建时间**: 2026-07-13
**状态**: 权威定稿
**定位**: 本文件是**主会话打断与批次调度机制的唯一事实源（SSOT）**。其他文档（`architecture.md`、`README.md`、`data-structures.md`、`config/specific-params.md`、`prompts/main-base.md`）涉及打断/调度的表述均以本文为准，冲突时以本文为准。

---

## 一、为什么需要打断

主会话使用慢模型（如 Opus），处理一个批次可能耗时数分钟。这期间若有**紧急消息**到达（如"生产环境崩了"），不能让它排队等慢批次跑完。打断机制让辅助会话能中止主会话当前处理、立即转入紧急批次。

打断是**例外路径**，不是常态。绝大多数批次正常排队、按序处理。

---

## 二、主队列的单位是「批次」，不是消息

**主队列中的元素是同角色批次（TransferBatch），不是散消息。**

- 批次在 **transfer 边界**成形：辅助会话按角色提取、判断，转投时每个批次已是**同一 `peerRole`** 的消息集合（角色是批次的一个字段，仅作权限分组键——优先级、是否打断均由辅助**判断内容**得出，与角色高低无关）。
- 每个批次**携带辅助会话对它的判断指令**（是否打断、如何处置之前的批次等，见 §4）。
- 主队列**不再拆散重切**批次——辅助的批次边界就是主会话的处理边界。这保证辅助会话的判断能精确作用到它所判断的那批消息上（判断不失效）。
- 同批同角色 → `batchRole` 唯一 → PreToolUse Hook 权限判断清晰，**无跨角色破窗**。

> **紧急批次天然完整**：批次在 transfer 边界成形、整批入队、整批调度，
> 紧急消息必然在它所属的批次内被一起优先处理。单批大小上限由辅助侧提取时的 ≤50 条/10k 约束。

---

## 三、批次调度规则

**主会话每处理完一个批次，按以下规则选取下一个批次：**

```
1. 遍历主队列中所有等待的批次
2. 若存在 interrupt=true 的批次 → 取「最后一个」此类批次优先处理
   （最后 = 最新到达；它代表辅助会话最新的紧急判断）
   → 被跳过的更早批次：作为 reference（只读引用）注入本批上下文，
     本体仍留在主队列中排队，之后轮到时再作为 primary 正常处理
3. 若不存在 → 按 FIFO 取队首批次
```

**reference（被跳过批次的引用）语义**：
- 只读上下文：供当前批次理解背景（如 owner 追问时，之前 guest 的相关描述）；
- **不作为响应对象**：主会话不回复 reference 中的消息、不执行中的指令；
- **不影响 `batchRole`**：权限判断只看 primary 批次的角色，reference 不参与；
- 本体**留队列**：被引用 ≠ 被消费，之后按调度规则轮到时以自己的角色作为 primary 处理。

> 这正是"顺序原则"的精确化：**每条消息保证最终被看到（作为 primary 处理或作为 reference
> 进上下文），但"被作为处理主体响应"的顺序按辅助判断的紧急度，不严格按到达顺序。**
> 例：guest 批（早到、原判 hold）因 owner 紧急批被裹挟转投——owner 批 interrupt=true
> 被优先处理（guest 批作 reference 保证上下文完整），guest 批随后按序处理。
> 不会出现"guest 占机制便宜先被处理、真正紧急的 owner 反而排队"。

---

## 四、批次携带的指令与 previousMessageStrategy

每个批次携带辅助话的判断结果（见 data-structures.md `TransferBatch`）。
`interrupt: true` 时必须给出 `previousMessageStrategy`，作用于**之前所有已转投而未定案的批次**
（不只当前在处理的那一个——辅助会话不追踪主会话正在处理哪个批次，它把"已转投未反馈"的整体作为对象；
"已反馈的批次 = 已定案、不可撤销"是天然边界）：

| 策略 | 对「在飞批次」（正在处理、已在上下文） | 对「队列中未处理的已转投批次」 |
|------|------|------|
| `ignore` | 硬 abort 中止 + **提示词注入【打断通知】提示忽略**（消息已在上下文，物理无法移除，靠提示词约束不再处理） | **从主队列移除**（真实队列操作，不是建议） |
| `defer` | 硬 abort 中止；提示词提示"稍后处理" | 保留排队；本批（新批次）**优先处理**，被跳过的批次作 reference（见 §3） |
| `continue` | 硬 abort 中止；提示词提示"继续处理，结合新消息" | 保留排队，与本批一起按 §3 调度 |

**执行层次的区分**：
- `ignore` 对**队列中未处理的批次是真实移除**（队列操作，保证它们不会再被提取处理——判断落到实处）；
  对**已进上下文的在飞消息**则靠提示词层提示（上下文无法物理剔除，这是 LLM 会话的固有约束——接受它，不引入 rewind 等重操作）。
- `defer` 的语义 = **优先处理本批**：不是"旧批稍后重投"（无重投机制），而是调度层让本批插队、旧批保序留队。

【打断通知】示例（ignore）：
```
【打断通知】
原因：生产环境崩了，需立即处理。
处理建议：忽略之前正在处理的消息批次，只处理本批次。
（之前批次中尚未处理的部分已从队列移除，不会再出现。）
```

---

## 五、触发条件

打断（中止在飞批次）发生**当且仅当**同时满足：

1. `interruptEnabled === true`（配置开关，默认 true）
2. 批次携带 `interrupt: true`（辅助会话判断）
3. 主会话正在处理：`status === 'processing'`
4. 在飞批次未满：`currentBatchSize < 50`（旧批已很大时再打断收益低、成本高）

任一不满足 → 不中止在飞批次，但批次仍带着指令入队，**§3 的调度规则仍然生效**
（interrupt 批次在下一个调度点被优先选取）。

---

## 六、硬 abort 语义（P0-5）

打断在飞批次是**硬打断**：调用 base agent 的 `agent.interrupt(sessionId)`，其内部调用 SDK 的 `sdkStream.interrupt()`，**中止当前正在进行的 API 请求（abort）**。

关键后果——**旧批次的主路径被中止，不会继续往下跑**：

- 主会话 `process(batch)` 此刻正 `await callModel(batch)`；
- abort 使该 await **抛错中止**，`process()` 的主路径不会执行到后续的 `extractSummary` / `enqueueFeedback` / `completeBatch`；
- 因此正常路径上**旧批次不会产生反馈、不会 completeBatch、不会清空新批次的 processing 状态**。

> ⚠️ **但"抛错中止"不等于"续体消失"**：抛出的错误会落进 `process()` 的 `catch`/`finally`，
> 那段代码仍会执行——它就是旧批次的残余续体。若不加防护，它可能走错误重试、回灌、清状态等路径，
> 与新批次并发写状态。防护机制（generation 守卫）见 §8，这是**实现必做项**。

被打断批次的消息**不回灌队列**——它们已在主会话上下文中，如何对待由 `previousMessageStrategy` 决定（§4）。

> **实现注意**：`interrupt()` 只把 `status` 设为 idle 是**不够**的——单设状态不会中断正在进行的 `await callModel`。必须真正调用 abort。

---

## 七、副作用不可撤回（P0-5）

打断**无法撤回**已经发生的副作用：
- 已发送的回复（哪怕只发了半截）无法收回；
- 已执行的工具调用（改文件、跑命令）无法回滚。

这是硬打断的**固有特性，不是设计缺陷**。应对方式是**在决策层规避**：
- 辅助会话**谨慎决定是否打断**（打断是例外路径，紧急才用）；
- 主会话在执行破坏性操作前，先确认消息未过期；发送回复前，检查是否有更新的消息。

---

## 八、并发与时序（P1-6）

### 8.1 队列层：串行化已覆盖，无需额外保护

整个双会话是队列串行化的：

1. **所有触发都经过队列**：AUN 消息、主会话反馈都进辅助队列，不直接触发处理；
2. **辅助会话串行处理**：一次一个批次，处理完再取下一批；
3. **主会话串行调度**：一次处理一个批次，每个批次结束才执行 §3 的调度选取；
4. **辅助判断与主执行的时差**：辅助的 `previousMessageStrategy` 表达的是对"未定案整体"的**意图**，
   主会话在**执行那一刻**按队列真实状态执行（已定案的不受影响）——意图/执行分离，时差不产生错杀。

队列层因此**不需要**额外的并发保护。

### 8.2 续体层：必须加 generation 守卫（实现必做）

**串行化在 promise 续体层不自动成立**。被 abort 的 `process(A)` 不是消失了——错误落进它的
`catch`/`finally`，那段残余续体仍会执行。若它按错误处理流程行动（见 architecture.md §6.1），
就会与新批次并发写状态：

```
T1  打断：abort → process(A) 的 callModel 抛错
T2  调度器取 O，主会话开始处理 O（processing = O）
T3  A 的 catch/finally 醒来，若无防护：
    ① 走错误重试 → 旧批次复活，与 O 并发调模型（串行化被打破）
    ② 重试耗尽 → 把 A 回灌主队列（违反"被打断批次不回灌"）
    ③ finally 清 status/processing/completeBatch → 踩掉 O 的状态（调度错乱）
```

**防护 = generation 守卫**：

```typescript
class MainSession {
  private generation = 0;   // 每开始处理一个新批次 ++；每次打断 ++

  async process(batch: TransferBatch): Promise<void> {
    const myGen = ++this.generation;   // 捕获本 run 的代
    try {
      const response = await this.callModel(batch);
      if (myGen !== this.generation) return;   // 过期续体：静默退出
      // ... extractSummary / enqueueFeedback / completeBatch
    } catch (err) {
      if (myGen !== this.generation) return;   // 被打断的旧续体：不重试、不回灌、不碰状态
      // 走到这里才是"当前批次的真实失败" → architecture.md §6.1 的重试/回退流程
      await this.handleFailure(batch, err);
    }
  }

  async interrupt(): Promise<void> {
    this.generation++;      // 使所有在飞续体过期
    await this.abortCall(); // 硬 abort（§6）
  }
}
```

**规则**：
- `generation` 是 MainSession 上的单调整数；**开始处理新批次**与**每次打断**都使其 +1；
- `process()` 开头捕获 `myGen`；**每个 `await` 之后的状态写入点**（completeBatch、enqueueFeedback、
  错误重试、回灌、status/processing 修改）之前都必须检查 `myGen === this.generation`，
  不等则静默 return——过期续体无论从正常路径、catch 还是 finally 醒来，一律无害退出；
- 守卫检查是同步的（单线程事件循环内无 TOCTOU），实现可收敛为一个
  `ifCurrent(myGen, fn)` 辅助函数，避免逐处手写漏掉；
- **不依赖错误类型判断**：不要用 `isAbortError(err)` 作为唯一防线——abort 与真实网络错误
  几乎同时发生时错误类型不可靠，generation 对所有路径统一兜底（错误类型判断可作为
  日志友好性的补充，不作为正确性依据）。

**结论**：队列层不需要 epoch/幂等反馈这类机制；但**主会话处理 run 的续体层必须有 generation
守卫**——这是打断机制正确性的一部分，不是可选优化。

---

## 九、完整时序示例

```
T0:  guest 批次 G 转投主队列（原判 hold，被后续转投裹挟，无 interrupt）
     主会话空闲 → 按 FIFO 取 G？否——此刻主会话正在处理更早的批次 A
T2:  紧急 owner 消息到辅助队列，命中紧急信号，立即触发辅助会话
T2.5 辅助判断（按角色分批）：owner 批次 O：transfer + interrupt=true,
       previousMessageStrategy=defer（A 的内容还要处理，稍后继续）
     → O（携带指令）入主队列。主队列：[G, O]，在飞：A
T2.6 打断守卫：processing？是；A <50？是 → 打断成立
T2.7 硬 abort：旧 process(A) 的 callModel 抛错中止
       → 不 feedback、不 completeBatch；A 仅留在上下文
T2.8 调度：遍历队列，最后一个 interrupt 批次 = O → 优先处理 O
       → 被跳过的 G 作为 reference 注入（只读），G 本体留队列
T2.9 主会话处理 O：上下文有 A（提示词提示"稍后继续处理"）+ reference G
       → 只响应 O 的消息 → 总结/反馈
T3.0 O 完成 → 调度：队列无 interrupt 批次 → FIFO 取 G，作为 primary 正常处理
       （此时 O 已定案；A 的内容由主会话在上下文中按 defer 提示自行接续）
```

---

## 十、相关文档

- [架构设计](./architecture.md) - §2.3 MainQueue、§2.4 MainSession、§3.3 打断机制、§5 批次角色一致性
- [数据结构定义](./data-structures.md) - `TransferBatch`、`AuxiliaryDecision.previousMessageStrategy`
- [辅助队列处理](./auxiliary-queue-processing.md) - 按角色分批提取与转投
- [配置参数](./config/specific-params.md) - `interruptEnabled`
- [主会话提示词](./prompts/main-base.md) - 打断通知注入
- [来源：REVIEW-SUPPLEMENT](../dual-session-lite/REVIEW-SUPPLEMENT.md) - P0-5/P0-6/P1-3/P1-6 原始拍板

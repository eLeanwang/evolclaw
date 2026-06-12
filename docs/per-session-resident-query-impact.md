# Per-Session 长驻 Query 改造影响面分析

> 目标：把 Claude runner 从「每条消息 spawn 一个一次性 `query()`、收到 `result` 即终结流」改成「每个 session 维护一个长驻的 streaming-input `Query`，跨 turn 复用」。
> 动机：解锁 `backgroundTasks()` 的 `task_notification` 带外回调，以及 `startup()` 预热（两者共享同一前置）。

## 0. 当前模型基线（改造的起点）

一次消息处理的生命周期（`message-processor.ts` 主流程）：

```
queue.processNext → handler(message)
  → agent.runQuery(...)            // 每次 new 一个 SDK Query（claude-runner.ts:1166 createQuery）
  → agent.registerStream(key)      // 存入 activeStreams（活跃标记）
  → processEventStream(stream)     // for await，消费到 complete
  → agent.cleanupStream(key)       // 清 activeStreams + interruptFns
```

关键不变量（被现有代码到处依赖）：

1. **一次 turn = 一个 Query = 一个流**。`transformStream` 收到 `result` 事件就 `return`（`claude-runner.ts:928`），流自然结束，`for await` 退出。
2. **queue 的 processing 锁 = turn 的生命周期**。`processNext`（`message-queue.ts:148`）串行 await `handler`，handler 返回才处理下一条。锁绝不在 turn 中途释放。
3. **interrupt = 关掉当前流**。`interruptFns.get(sessionId)()` 调 `sdkStream.interrupt()`（`claude-runner.ts:1266`），流抛出/结束，`for await` 退出。
4. **session 状态全在 Map 里按 sessionId 键**：`activeSessions`、`activeStreams`、`interruptFns`、`permissionContexts`（`claude-runner.ts:290-297`）。每次 runQuery 用 `resume: agentSessionId` 让 SDK 自己从 JSONL 恢复历史。

长驻模型要打破不变量 1（result 不再终结）和部分改写 3，同时**必须保住不变量 2**（这是上一轮讨论的核心结论：锁跟 turn 走，不跟后台任务走）。

---

## 1. 影响面清单（按模块）

### 1.1 `claude-runner.ts` — 改动最大，执行模型重写

**现状**：`runQuery` 每次 `createQuery(prompt, resume)`，prompt 直接当字符串传。

**改造**：
- 新增 `Map<sessionId, ResidentQuery>`，`ResidentQuery = { query: Query, input: MessageStream, sessionId, lastActivity }`。
- 首次 runQuery：用 streaming-input 模式建 Query（prompt 传 `MessageStream` 异步迭代器，**不传字符串**），存入 map。
- 后续 runQuery：复用同一 Query，通过 `input.push(prompt)` 或 `query.streamInput()` 喂入新消息，**不再传 `resume`**（历史在长驻进程内存里）。
- `transformStream` 的 `result` 分支**不能再 `return`**（`claude-runner.ts:928`）。否则 generator 结束，后续 turn 和 `task_notification` 都收不到。要改成：`result` 事件转成 `complete` 事件 yield 出去，但**流继续 alive**。

**这里冒出一个核心矛盾**：现在 `processEventStream` 的 `for await` 依赖流在 `complete` 后结束来退出循环（`message-processor.ts:1231`）。如果流永不结束，`for await` 永远不退出，handler 永不返回，queue 锁永不释放 —— 直接死锁。

**解法**：需要一个「per-turn 切片」机制。长驻 Query 是一条**无限流**，但每个 turn 要从中切出一段「本 turn 的事件」给 processor 消费。两种实现：

- **方案 1a（事件分发器）**：runner 内部单独跑一个 `for await (const ev of residentQuery)` 的常驻消费循环，把事件按「当前 turn 边界」分发给一个 per-turn 的临时 channel（如 `AsyncQueue`）。turn 的 `complete` 到达时关闭这个临时 channel（而非关闭底层流）。`runQuery` 返回的是这个临时 channel 的迭代器。`task_notification` 这类带外事件不属于任何 turn channel，走单独的回调路由。
- **方案 1b（哨兵切片）**：`transformStream` 在 `result` 后不 return，而是 yield 一个 `complete` 然后 `break` 出一个内层循环，但保持外层 generator 对底层流的引用，下次 runQuery 复用同一个 generator 继续 `for await`。实现更 tricky，状态机容易错。

**推荐 1a** —— 把「底层无限流的消费」和「per-turn 的事件投影」彻底解耦。这是整个改造的技术核心。

**其它连带改动**：
- `interrupt`：不能再 `close()` 整个流（会杀掉长驻进程）。改成调 `query.interrupt()`（SDK 的 interrupt 是中止当前 turn，不杀进程 —— 需验证 SDK 语义）。中止后底层流应继续 alive 等下一个 turn。
- `compactSession` / `clearSession`：现在用独立的一次性 `runSessionCommand`（`claude-runner.ts:1307`）。长驻模型下 `/compact`、`/clear` 应该走同一个长驻 Query 的 streamInput，否则会和长驻进程的内存历史不一致（长驻进程不知道你在另一个进程 clear 了）。**这是个隐蔽的正确性 bug 来源**。
- `closeSession`：现在只删 map。改造后要真正 `query.close()` 杀长驻进程 + 清理事件分发器。
- 会话文件校验逻辑（`claude-runner.ts:947-983`）：长驻模型下首次建 Query 时校验一次即可，后续 turn 不再每次校验（因为不再 resume）。

### 1.2 `message-queue.ts` — 锁语义需显式确认，小改但关键

**现状**：`processNext`（148）串行，锁 = handler 执行期。

**改造**：
- **核心约束不变**：锁仍然 = turn 生命周期。`backgroundTasks` 把工具摘出去后 turn 继续跑完，handler 正常返回，锁正常释放。**不要在 background 时刻提前释放锁**（上一轮已确认这会导致同 session 双 turn 并发写坏 JSONL）。
- 真正要加的是：`task_notification` 带外事件到达时，它**不是**一条用户消息，不应走 `enqueue`（不占处理槽、不触发 interrupt、不参与 FIFO 合并）。需要一条「带外事件直达 renderer」的旁路，绕开 queue。
- `interceptors` 机制（`message-queue.ts:96`）目前用于 AskUserQuestion 一次性拦截。要确认它和长驻 Query 的 `canUseTool` 回调时序不冲突（canUseTool 现在在长驻进程里跨 turn 存活）。

### 1.3 `message-processor.ts` — 消费循环和带外事件

**现状**：`processEventStream`（1231）`for await` 到 `complete`，`runQuery → registerStream → 消费 → cleanupStream` 的三段式（659-898）。

**改造**：
- `for await` 现在消费的是「per-turn 切片 channel」（方案 1a），不是底层流。`complete` 到达 channel 关闭，循环退出，逻辑基本不变 —— **这是 1a 方案的最大好处：processor 主流程几乎不用动**。
- 但要处理 retry 路径（`message-processor.ts:710,754`）：现在 retry 是「再 runQuery 一次」。长驻模型下 retry 是「往同一 Query 再 streamInput 一次」，session 历史已在进程内，不需要 resume。逻辑要调整。
- **带外 `task_notification` 路由**：新增一个事件入口（不在 `processEventStream` 里，因为那是 per-turn 的）。需要一个 session 级的常驻 renderer 引用，让后台任务完成时能 `renderer.addNotice("后台任务完成: ...")` 推给用户。问题：turn 已结束、renderer 可能已 flush/销毁。要让 renderer（或一个轻量替代）在 session 存活期间常驻，而非 per-turn 创建（`message-processor.ts` 现在是 per-message 创建 renderer）。**这是 processor 侧最大的结构改动**。
- `isBackgroundSession` 投影分支（1291-1294）：后台任务事件要复用这套「后台 session 静默」逻辑还是单独处理，需设计。

### 1.4 Autonomous / trigger session 清理 — 生命周期冲突

**现状**：autonomous session 完成后 `unbindSession`（`message-processor.ts:977`），trigger 完成后清理（976）。这些 session「用完即弃」。

**改造**：长驻 Query 意味着进程常驻。autonomous session 如果每次都建长驻 Query 又立刻 unbind，要确保 `unbindSession` 触发 `closeSession` → `query.close()` 杀进程，否则**进程泄漏**（每个 trigger 留一个 200MB 的 CLI 进程）。这是改造后最危险的资源泄漏点。

需要明确策略：
- autonomous/trigger session：**不该用长驻 Query**（用完即弃，长驻无意义且泄漏）。应保留现有一次性模型。
- 只有交互式单聊/群聊 session 才用长驻 Query。
- → 意味着 runner 要支持**两种执行模式并存**，按 session 类型分流。增加复杂度。

### 1.5 进程数与资源 — 新的运维约束

- 现在：同时只有「正在处理的 session 数」个 CLI 进程（峰值受 queue 串行限制，通常很少）。
- 改造后：**每个活跃交互 session 常驻一个 CLI 进程**。多 agent、多群、多私聊场景下，进程数 = 活跃 session 数，可能几十个，每个 200MB+。
- 必须加：空闲 session 的 Query LRU/TTL 回收（`lastActivity` 超时 → `query.close()`）。这是新增的常驻后台任务。
- `instance-registry` / `evolclaw status` 可能需要暴露「长驻 Query 数 / 内存占用」。

### 1.6 interrupt 与 idle-kill 的语义复核

- `message-processor.ts:313` 的 idle-kill 调 `agent.interrupt(streamKey)`。现在 interrupt 会杀流；改造后 interrupt 只中止 turn、不杀进程。要确认 idle-kill 的本意（杀超时任务）在新语义下仍成立 —— 大概率成立，但要测。
- 新消息打断（`message-queue.ts:128`）：interrupt 当前 turn 后，下一条消息往同一 Query streamInput。要确认 SDK 在 interrupt 后能立刻接受新输入（而非进程进入坏状态）。**这是必须先验证的 SDK 行为**。

---

## 2. 风险矩阵

| 风险 | 严重度 | 说明 |
|---|:---:|---|
| 同 session 双 turn 并发（误释放锁） | 致命 | 上一轮已识别。坚持「锁=turn」即可规避，但改造中容易手滑 |
| `for await` 永不退出死锁 | 致命 | 流不再 result-terminate 的直接后果。靠方案 1a 的 per-turn channel 切片解决 |
| autonomous session 进程泄漏 | 高 | 长驻 + 用完即弃冲突。靠「autonomous 不走长驻」规避 |
| 跨进程历史不一致（compact/clear） | 高 | /compact 走旧的独立进程会和长驻进程内存历史脱节 |
| interrupt 后 Query 坏状态 | 高 | SDK 行为未知，必须先验证 |
| 空闲进程堆积 OOM | 中 | 靠 LRU/TTL 回收 |
| renderer 跨 turn 常驻改动 | 中 | 带外事件路由需要 session 级常驻 renderer，结构改动较大 |

---

## 3. 必须先验证的 SDK 行为（PoC 第一步）

在动任何 EvolClaw 代码前，写一个独立脚本验证以下 SDK 语义（都还没确认）：

1. **streaming-input Query 能否跨 turn 复用**：建一个 Query，streamInput 消息 A，消费到 result，再 streamInput 消息 B，能否在同一进程内继续（带历史）？
2. **`result` 后流是否继续 alive**：消费到 result 事件后，`for await` 是会结束还是会 block 等下一个 turn？（决定方案 1a 的 channel 切片怎么写）
3. **`query.interrupt()` 的语义**：是中止当前 turn 还是杀整个 Query？interrupt 后能否继续 streamInput？
4. **`backgroundTasks()` + `task_notification` 的到达时机**：notification 是从同一个 message stream 来，还是另有通道？turn 结束后多久到？
5. **`canUseTool` 跨 turn 的回调身份**：长驻 Query 里 canUseTool 触发时，怎么知道是哪个 turn / 哪条消息触发的（用于路由权限卡片到正确的 replyContext）？

第 2、3 条直接决定整个架构能不能成立。**建议先花半天写验证脚本，再决定是否投入改造。**

---

## 4. 工作量与建议

- **真实工作量**：大改。核心是 `claude-runner.ts` 的执行模型重写（方案 1a 事件分发器）+ `message-processor.ts` 的 renderer 常驻化 + 双执行模式分流 + 进程回收。保守估计远超「中等」，且有两条致命风险路径。
- **共享前置**：`backgroundTasks` 和 `startup()` 预热都依赖这套长驻 Query。如果只为 `backgroundTasks` 一个功能，性价比偏低；如果连带把预热（首响应延迟优化）一起拿下，则前置投入可被两个功能摊薄。
- **建议路径**：
  1. 先做第 3 节的 SDK 行为验证脚本（半天，决定可行性）。
  2. 若可行，先在**单聊单 agent**场景做最小长驻 Query PoC，验证「锁=turn」「带外通知路由」「进程回收」三件事。
  3. autonomous/trigger 路径**明确不改**，保留一次性模型，避免泄漏。
  4. PoC 通过后再推广到群聊 + 多 agent。

**反向选项**：如果验证发现 SDK 语义有坑，或工作量不可接受，退回上一轮的「路线 A」—— 不接收 `task_notification`，仅靠 `task_notification.output_file` 让用户/下个 turn 自己读后台结果。有损但零架构改动。

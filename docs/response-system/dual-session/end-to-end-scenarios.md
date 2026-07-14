# 双会话响应模式 - 端到端场景剧本

**版本**: 2.0
**关联**: [README.md](./README.md) | [架构设计](./architecture.md) | [辅助队列流程](./auxiliary-queue-processing.md) | [打断机制](./interrupt-mechanism.md)

---

## 本文档的定位

其它文档按**组件**或**单一机制**切分：

- [architecture.md](./architecture.md) —— 四大组件（辅助队列 / 辅助会话 / 主队列 / 主会话）各自的职责与方法
- [auxiliary-queue-processing.md](./auxiliary-queue-processing.md) —— 辅助队列内部的状态流转与 transfer/delay/hold 决策
- [interrupt-mechanism.md](./interrupt-mechanism.md) —— 打断的硬 abort 语义、被打断批次去向（唯一事实源）

本文档不重复这些内容，只提供**跨组件、带真实时钟的端到端剧本**：一条（或一批）消息从到达、经辅助判断、投递、主会话处理、到回复与反馈的**完整走一遍**。读完组件文档后，用这里的时间轴理解"各组件在时间上怎么协作"。

> ⚠️ 剧本里的**机制**（transfer 投递范围、反馈传递方式、打断行为、延迟公式）以事实源文档为准；本文只做叙事演示。若发现不一致，以被引用的事实源文档为准。

**贯穿全篇的几条关键约定**（均引自事实源，勿在剧本里写反）：

| 约定 | 出处 |
|------|------|
| transfer 投递范围 = **已喂给辅助会话的消息**（`getProcessedByAuxiliary()`），不含判断期间新到的 PENDING | auxiliary-queue-processing.md §7.1 |
| 反馈 = 代码层组装 `MainFeedback{summary, replies}` 后 `enqueueFeedback()` **入辅助队列暂存**，被动等下次触发随批带出，**不调模型、不额外触发** | data-structures.md §1.3、architecture.md §3.4 |
| 打断 = 硬 abort；被打断批次消息**留在上下文、不回灌队列**；主队列以同角色批次为调度单位,interrupt 批次优先、跳过批作 reference 留队列 | interrupt-mechanism.md |
| 延迟 = `baseDelayMs + random(0, levelMs × peerFactor)`；`peerFactor` 人=0.5 / 含 agent=1.0；`levelMs` short=60k/medium=120k/long=180k | architecture.md §3.2 |

> 剧本用 `T0 / T+Δ` 相对时序演示，延迟具体值按上面公式计算；为可读只标 `delayLevel` 与量级，不写死毫秒。

---

## 场景一：分段输入（防抖聚合）

**背景**：用户把一个问题拆成三条消息陆续发出。系统应聚合后一次性处理，而非逐条回复。

```
T0    消息「这个报错」到达
        → 辅助队列入队（PENDING）
        → 启动防抖定时器（3s）

T+2s  消息「[截图]」到达
        → 入队（PENDING）
        → 重置防抖（3s）

T+5s  消息「怎么解决？」到达
        → 入队（PENDING）
        → 重置防抖（3s）

T+8s  防抖到期 → 触发辅助会话
        → extractBatch() 提取 [报错, 截图, 怎么解决]，标记 processedByAuxiliary
        → 辅助会话判断：意图已完整 → transfer（不打断）
        → 投递范围 = 已喂给辅助会话的这 3 条 → 投给主队列，移出辅助队列

T+8.2s 主会话处理
        → 批次 = [报错, 截图, 怎么解决]
        → 调模型生成回复「这个报错是因为…」
        → 通过 CLI 发送回复

T+9s  反馈入队（被动，不额外调模型）
        → 代码层从主会话输出提取 summary、从工具调用历史提取 replies
        → 组装 MainFeedback，enqueueFeedback() 包成 FeedbackItem 插入辅助队列（不落盘、不触发）
        → 反馈静静躺在辅助队列里，等下一次辅助会话被真实触发时随批带出

（此后某刻）下一条新消息到达或延迟到期 → 辅助会话触发
        → extractBatch() 把新消息 + 这条 FeedbackItem 一起带出
        → 辅助会话遍历批次：kind='feedback' 的项只读吸收（知道这 3 条已被主会话消费），
          决策只针对本批的新消息
```

**要点**：防抖把"分段输入"聚合成一个批次，避免对半句话抢答。反馈是纯上下文信息——不立刻处理，
入队暂存、搭下一次决策的便车带给辅助会话，**零额外 LLM 调用、零额外唤醒、不绕过队列**（见
architecture.md §3.4）。消息在 transfer 时就已移出辅助队列，反馈的作用只是让辅助会话**知道**主会话消费了什么。

---

## 场景二：多 agent 竞争回复（延迟错开 + 重判挂起）

**背景**：群里 owner 抛出一个问题，群内有 Agent1/2/3 三个 agent 都收到了。期望：只有一个 agent 回复，其余观察到已有回复后自行退让。

```
T0    owner 消息「这个问题怎么解决？」到达三个 agent

      各 agent 辅助队列：入队（PENDING），启动防抖 3s

T+3s  各 agent 防抖到期 → 触发辅助会话
      辅助会话均判断为 delay（群聊、含 agent 对端 → peerFactor=1.0）
      按 §3.2 公式 baseDelayMs + random(0, levelMs×1.0) 各自算出延迟 Δ：

        Agent1: delayLevel=medium → Δ₁（较长）
        Agent2: delayLevel=short  → Δ₂（最短）   ← 最先到期
        Agent3: delayLevel=medium → Δ₃（最长）

      随机项使三者错开，避免同时抢答

T+3s+Δ₂  Agent2 延迟到期 → triggerExpiredScan() 扫描转投
        → 期间无其他 agent 回复 → transfer 投给主队列
        → Agent2 主会话处理并回复群

T+…   Agent2 的回复作为**新群消息**到达 Agent1、Agent3
        → 二者辅助队列收到新消息 → 触发辅助会话重判
        → 辅助会话在上下文里看到「已有 agent 回复」
        → 判断 hold（无需重复），取消各自的延迟定时器
        → 原问题消息留在队列（HOLD），不再投递
```

**要点**：
- 延迟的随机项是**群聊防竞态**的核心（§3.2 双重目的之一）。
- Agent1/3 的退让靠"新消息触发重判"——延迟期间来新消息就重新判断，是辅助队列的既有能力（auxiliary-queue-processing.md 场景 3）。
- 重判为 hold 时只标记本批次状态，不影响队列中其它消息（§7.2）。

---

## 场景三：紧急打断（批次调度 + 硬 abort）

**背景**：主会话正在处理一个耗时批次，群里还有一个更早的 guest 批次在排队,此时 owner 发来紧急消息。

```
T0    批次 A 转投主队列 → 主会话开始处理 A（耗时较长）
      guest 批次 G 稍后被裹挟转投（原判 hold,不带 interrupt）→ 主队列排队
      主队列：[G]，在飞：A

T+2s  owner 紧急消息「生产环境崩了！」到达
        → 辅助队列入队（PENDING）
        → 命中紧急信号 → 立即触发辅助会话

T+2.5s 辅助会话判断（按角色分批,owner 消息自成一批 O）
        → O：transfer + interrupt=true, previousMessageStrategy=defer
        → transferToMain()：O 携带指令入主队列 → 主队列：[G, O]
        → interrupt=true → 触发打断守卫

T+2.6s 打断守卫（四条件,详见 interrupt-mechanism.md §5）
        → 开关开？是；主会话正在处理？是（A）；在飞批次未满（<50）？是
        → 打断成立

T+2.7s 主会话被硬打断
        → 真正中止进行中的模型调用（不是只把 status 置 idle）
        → 在飞批次 A 不产出回复、不生成反馈、不 completeBatch
        → A 已在上下文中：保留，**不回灌队列**（defer → 提示词提示"稍后继续"）

T+2.8s 批次调度（interrupt-mechanism.md §3）
        → 遍历主队列找最后一个 interrupt 批次 = O → 优先处理
        → 被跳过的 G 作为 reference（只读引用）注入,G 本体留队列排队
        → 主队列：[G]，在飞：O（+ references: [G]）

T+2.9s 主会话处理 O
        → 上下文含 A（打断通知提示稍后继续）+ reference G（只读背景）
        → 只响应 O 的消息（batchRole=owner,权限判断清晰）
        → 发送回复 → 组装 MainFeedback，enqueueFeedback() 入辅助队列暂存（被动，不额外调模型）

T+3.5s O 完成 → 调度：无 interrupt 批次 → FIFO 取 G,作为 primary 正常处理
        （guest 的消息此时才被作为响应对象,之前只是 owner 批次的只读背景）
```

**要点**：
- **主队列以同角色批次为调度单位**,批次携带辅助判断的指令,主队列照指令执行、不自行判断优先级（角色只是权限分组键,不代表优先级）。
- 打断是**硬 abort**,被打断批次的消息**留在上下文、不回灌队列**（interrupt-mechanism.md 是唯一事实源）。
- **被跳过的批次作 reference、本体留队列**：owner 紧急批优先时,更早的 guest 批以只读引用保证上下文完整,但不作为响应对象,之后按序轮到它——紧急的先被处理,又没有消息被跳过不见。
- 若指令是 `ignore`（而非本例的 defer）,primary 之前的未处理批次会**从队列真实移除**,在飞批次靠提示词提示忽略。
- 是否真正中止在飞批次由**打断守卫**判断（不满足则不 abort,但 interrupt 批仍在下个调度点优先）。

---

## 场景四：延迟期间被新信息推翻（delay → hold）

**背景**：单聊/群聊中一条消息进入延迟等待，等待期间出现让它无需回复的新信息。这是场景二的通用化——不限于多 agent。

```
T0    消息「这个问题怎么解决？」到达（群聊、未 @ 本 agent）
        → 辅助会话判断 delay（delayLevel=medium）
        → 按公式算出 Δ，设置延迟定时器，消息标记 DELAY（在上下文中）

T+Δ 之前，另一 agent 回复了该问题
        → 该回复作为新消息到达 → 入队 PENDING → 触发辅助会话重判
        → 辅助会话结合上下文（原问题 DELAY 中）+ 新消息（已有人回复）
        → 判断 hold：无需重复回复
        → 取消原延迟定时器
        → 原问题保持 HOLD，留在队列不投递
```

**要点**：
- delay 不是"定时必投"——到期前来新消息会**重判**，可能翻转为 hold 并取消定时器。
- 若到期前无新信息，则 `triggerExpiredScan()` 扫描到期的 DELAY/HOLD 消息**直接转投**（不再经辅助判断），见 auxiliary-queue-processing.md 场景 2 / §6.2。

---

## 场景对照速查

| 场景 | 触发聚合方式 | 辅助决策 | 投递/打断 | 独特点 |
|------|------------|---------|----------|--------|
| 一、分段输入 | 防抖聚合 | transfer | 追加 | 半句话不抢答 |
| 二、多 agent 竞争 | 防抖 + 延迟错开 | delay→（重判）hold | 最短延迟者 transfer | 随机项防竞态 |
| 三、紧急打断 | 紧急信号即时触发 | transfer + interrupt | 硬 abort + 提取全部 | 批次被中止、不回灌 |
| 四、延迟被推翻 | 延迟期间新消息 | delay→hold | 取消定时器、不投递 | delay 可翻转 |

---

**版本**: 2.0
**维护者**: EvolClaw 团队

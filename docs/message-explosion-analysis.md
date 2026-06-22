# 网络消息爆炸分析

> 草案 v2 — 基于讨论结论整理。目标：系统性梳理消息爆炸的原因、链路和决策基础，为优化方案提供依据。
>
> 概念分层：**传输层**（端↔网关原语）→ **协议层**（消息流经主体的路径模式）→ **业务层**（消息类型语义）。
> 三层之上有贯穿性的**主体模型**与**决策维度**。

---

## 0. 问题陈述

在一个含 5 个 agent、7 个人类的群里发一条消息，实测产生：

- **消息列表可见消息**：1800+ 条
- **实际网络通信**：~10,000 条

爆炸的乘法结构：

```
总网络通信 = Σ (
    业务层：每次响应产生多少条某类型消息
  × 协议层：这条消息扇出给多少接收者、流经几个主体
  × 传输层：每段流经几条网络通信
)
```

三层各管乘法里的一个因子，互不重叠。本文逐层拆解，并给出量化估算与优化决策基础。

---

## 1. 主体模型

消息在「主体」之间流转。一个主体在体系中只定义一次，但在某条消息的流图中可多次出现。

### 1.1 主体编号

| 编号 | 主体 | 持有 AID | 说明 |
|---|---|---|---|
| **①** | **agent** | ✅ 映射到本端 AID | LLM 推理单元，evolclaw 内多个并行 |
| **②** | **触发器** | ❌ | evolclaw 子进程，通过 evolclaw 行动，不直接收发网络消息 |
| **③** | **evolclaw**（agent runtime）| ✅ 自身 AID | 多 agent 宿主、触发器调度器、channel 适配器 |
| **④** | **AUN 网关** | — | 路由、认证、投递、**存储**的基础设施；唯一落盘节点 |
| **⑤** | **接收端 evolclaw** | ✅ | 对端那侧的 agent runtime（结构同③）|
| **⑥** | **接收端 agent** | ✅ | 对端那侧的推理单元（结构同①）|
| **⑦** | **对端前端** | ✅ human AID | 对端 human 用户的 Evol App/Web/Desktop |
| **⑧** | **owner 前端**（观察者）| ✅ human AID | 本端 agent 的 owner，通过前端观察会话 |

> **说明**：⑤⑥与③①结构相同，只是站在「接收方」视角。本文用不同编号是为了在流图里区分「本端发出」与「对端接收/再转发」两段。⑦与⑧都是前端，区别在角色：⑦是对话对端，⑧是观察者（本端 agent 的 owner）。

### 1.2 evolclaw 的定位

evolclaw 不是 AUN 网关，而是 **agent runtime**（agent 运行时）：

- 为多个 agent 提供生命周期管理、上下文组装、消息队列、触发器调度
- 接入多种 channel：AUN 网络（通过 AUN SDK）、飞书、微信、钉钉等
- AUN 是其接入的一个网络，飞书/微信等是其他 channel，均为 runtime 的外部接入点
- 自身持有一个 AID，用于接收对 evolclaw 直接的通信（如前端查看控制台）

> **术语建议**：避免叫「agent 网关」——gateway 在 AUN 语境特指 AUN Gateway（④），且 gateway 暗示「只转发」，而 evolclaw 承载推理宿主、调度、适配多职责。准确叫法是 **agent runtime** 或 **agent host**。

### 1.3 对端类型

对端（⑤⑥⑦所代表的外部主体）分四类，是策略分叉的关键维度：

| 类型 | 有 LLM | 有前端 | 会观察进度 | 说明 |
|---|---|---|---|---|
| **human** | — | ✅ | ✅ 可能 | 人类用户，可能处于观察状态 |
| **agent** | ✅ | ❌ | ❌ | 另一 runtime 上的 agent，不看 thought/进度 |
| **node** | ❌ | ❌ | ❌ | 功能性端点，执行确定性任务 |
| **group** | — | — | 成员可能 | 群组，成员混合（human/agent/node）|

**核心洞察**：agent 与 node **不需要观察进度**，不消费 thought 和中间态 status。因此本端发给 agent/node 的此类消息应在源头就**不发**（协议模式 F），对端也不会拉取、更不会转发给其 owner。

---

## 2. 架构图

主体为节点，边为消息流经方式。**边分两类**：

- **网络边**（实线 `═`）：跨网络，承载传输层原语（RPC 调用 / RPC 通知 / 网关推送），有网络通信成本。
- **本地边**（虚线 `┄`）：同主机，进程内函数调用（①↔③ 同进程）或跨进程 IPC（②↔③ 走 stdio/socket），无网络成本。

```
   本端                          网络                      对端
┌────────────┐                                      ┌────────────┐
│ ① agent    │┄┄┄┐                            ┌════│ ⑦ 对端前端 │
│            │   │                            │    │  (human)   │
│ ② 触发器   │┄IPC┤                            │    └────────────┘
└────────────┘   │                            │
                 ▼                            │
            ┌─────────┐  ═══════════  ┌──────────────┐
            │③evolclaw│════网络═══════│ ④ AUN 网关   │
            │(runtime)│               │  (唯一落盘)  │
            └─────────┘               └──────────────┘
                                          ║       ║
                              ┌═══════════╝       ╚═══════════┐
                              ▼                                ▼
                       ┌────────────┐                  ┌────────────┐
                       │⑤接收端     │                  │ ⑧ owner    │
                       │ evolclaw   │                  │  前端      │
                       └────────────┘                  │ (观察者)   │
                              ┊本地                     └────────────┘
                              ▼                          ▲ observe 心跳
                       ┌────────────┐                    ┊（上行通知）
                       │⑥接收端agent│                    ┊
                       └────────────┘              ⑧─────┘→④
```

> **排版设计点**：正式文档应将此图重绘为标准有向图（mermaid/draw.io），节点用编号，边标注「网络边/本地边 + 传输原语」。observe 心跳是 ⑧→④ 的反向上行通知，决定④对模式D的投递行为，需单独标注。

### 2.1 主体的连接与落盘

| 编号 | 主体 | 连入边 | 连出边 | 落盘 |
|---|---|---|---|---|
| ① | agent | 本地（←③）| 本地（→③）| ❌ |
| ② | 触发器 | IPC（←③ 事件/状态）| IPC（→③ stdout+退出码）| ❌ |
| ③ | evolclaw | 本地（←①②）、网络（←④）| 本地（→①②）、网络（→④）| ❌¹ |
| ④ | AUN 网关 | 网络（←③⑤⑦⑧）| 网络（→③⑤⑦⑧）| ✅ **唯一** |
| ⑤ | 接收端 evolclaw | 网络（←④）| 本地（→⑥）、网络（→④）| ❌ |
| ⑥ | 接收端 agent | 本地（←⑤）| 本地（→⑤）| ❌ |
| ⑦ | 对端前端 | 网络（←④）| 网络（→④）| ❌ |
| ⑧ | owner 前端 | 网络（←④）| 网络（→④，observe 心跳）| ❌ |

> ¹ ③ 有本地消息日志（调试/会话历史用途），但不是网络意义上的持久化，不参与「落盘」决策。落盘决策唯一发生在 ④。

---

## 3. 触发器机制（主体②）

触发器是 evolclaw 的内部调度单元，三阶段工作。它不持有 AID、不直接收发网络消息，最终动作经 ③ 执行。

### 3.1 设定阶段

创建来源：
- **agent 工具调用**（①→工具）：agent 处理消息时调用 `ec trigger set`，传入条件 + 脚本 + 反馈配置
- **外部指令**：直接给 evolclaw 自身 AID 发结构化消息，或命令行调用，bypasses agent，由 ③ 直接注册
- **消息进 agent 后设定**：消息先给 agent 处理，agent 决定后调工具写入

触发条件两类：
- **事件订阅**：订阅 evolclaw 内部事件总线——`message.received`、`task.completed`、`agent.idle`、`session.started` 等
- **状态轮询**：定期检查内部状态（队列长度、最后活跃时间、外部定时 cron/delay/at）

### 3.2 执行阶段

每个触发器是 ③ 启动的**独立子进程**，进程生命周期即触发器生命周期：

- 启动时注入上下文（触发参数、目标 agent/AID、会话信息）
- 脚本来源：预定义模板（内置）或 agent 临场生成（写临时文件后执行）
- 进程类型：**长驻型**（持续监听，多次触发）或**一次性**（条件满足即退出）
- 与 ③ 主进程通过本地 IPC（socket/stdio）通信：订阅事件流、查询状态

### 3.3 反馈阶段

进程退出时，③ 读取退出码和 stdout：

| 退出码 | 含义 | evolclaw 动作 |
|---|---|---|
| **0** | 交 evolclaw 直接处理 | 读 stdout 结构化数据，③ 直接执行（发消息/调 API），不过 agent，**保证准时** |
| **1** | 交 agent 处理 | 读 stdout 非结构化文本作为 prompt，注入目标 agent 队列，agent 自主决定后续 |
| **2** | 条件未满足，自然退出 | 无动作，触发器生命周期结束 |
| **其他非零** | 执行出错 | 记录错误，按配置决定重试或告警 |

结构化输出（退出码 0）示例：
```json
{ "action": "message.send", "to": "alice.aid.pub", "text": "定时任务完成" }
```

**触发信息进 agent（退出码 1）属于 L1 上下文级消息**（见 §5），绝不能丢。

---

## 4. 传输层

AUN 网络基于 JSON-RPC 2.0 over WebSocket。传输层只关心「字节怎么在端与网关之间走」，不关心业务语义。

### 4.1 原子动作

| 原子动作 | 方向 | 需要应答 | 网络通信条数 | 说明 |
|---|---|---|---|---|
| **上行调用** | 端 → 网关 | ✅ req/resp | 2 | 带 id，等网关 response，可确认送达 |
| **上行通知** | 端 → 网关 | ❌ | 1 | 无 id，fire-and-forget |
| **下行推送** | 网关 → 端 | ❌ | 1 | 网关主动推，端不一定 ack |
| **下行推送+ack** | 网关 → 端 → 网关 | ✅ | 3 | 端收到后发 ack RPC（+2）|

两个维度：**方向**（上行/下行）× **是否应答**（RPC=2条 / 通知=1条）。多个原子动作拼接成完整链路。

### 4.2 SDK 方法的传输成本

| SDK 方法 | 传输原语组合 | 网络通信条数 | 落库 |
|---|---|---|---|
| `message.send` / `group.send` | 上行调用(2) + 网关落库 + 下行推送每接收者(1) + 对端 ack(2) | **2 + 3D** | ✅ |
| `thought.put` / `group.thought.put` | 上行调用(2) + 网关缓存(1h) + 对端按需 pull(2) | **2 + 2P** | ❌ 缓存 1h |
| 普通通知 | 上行通知(1) + 下行推送每接收者(1) | **1 + D** | ❌ |
| 观察通知（新）| 上行通知(1) + 下行推送给观察中接收者(1) | **1 + D′** | ❌ |

> D=在线接收者数，P=拉取者数，D′=观察中接收者数（可为 0，此时仅 1 条）。

---

## 5. 消息重要性分级（L1~L4）

消息按「丢失代价」分四级。**核心原则：重要消息走 RPC 调用（可确认、可重试），不重要消息走通知（丢了无所谓）。** 重要性决定传输原语，是协议模式选择的首要依据。

| 级别 | 名称 | 丢失代价 | 传输原语 | 落盘 | 进上下文 |
|---|---|---|---|---|---|
| **L1** | 上下文级 | 致命（agent 行为错误/失忆）| RPC 调用 | ✅ | ✅ |
| **L2** | 统计/审计级 | 高（丢失任务结论/计费依据）| RPC 调用 | ✅ | ❌ |
| **L3** | 状态感知级 | 低（在线有用，离线无意义）| RPC 通知 | ❌ | ❌ |
| **L4** | 观察级 | 无（少看一帧渲染）| 观察通知（门控）| ❌ | ❌ |

### 5.1 各级别包含的消息

**L1 上下文级（绝不能丢）**——进入 agent 上下文窗口、影响 LLM 推理：
- 用户输入（text/file/image、interaction 回复）
- agent 最终回复（result.text/file/image）
- 工具调用及结果（activity.batch 内的 tool_call / tool_result）
- 触发器触发信息（退出码 1 的 prompt 注入）
- observer.inject（owner 插话提示）

**L2 统计/审计级（重要但可异步，离线需补看）**：
- `status.completed`（含 duration、token 用量 — 计费依据）
- `status.error` / `status.interrupted` / `status.timeout`（任务异常终结原因）
- `result.error`（面向用户的错误）
- `command.result` / `command.error`（命令执行结论）
- `system.error`（系统级异常）

**L3 状态感知级（在线有用，离线无意义）**：
- `status.started` / `status.queued` / `status.progress`
- `system.notice`

**L4 观察级（纯实时渲染，丢了不影响任何结论）**：
- `activity.batch` 的 text / reasoning（模型思考过程）
- `activity.batch` 的 progress / notice / summary（进度提示）

### 5.2 activity.batch 需拆分

`activity.batch` 当前在代码里是一个 batch 打包发送，但内含的 ThoughtItem 跨越两个级别：

| ThoughtItem.kind | 级别 | 原因 |
|---|---|---|
| tool_call / tool_result | **L1** | 进 agent 上下文，影响后续推理 |
| text / reasoning / progress / notice / summary | **L4** | 纯观察渲染 |

> **设计点（待拍板）**：协议层是否按 `item.kind` 把 activity.batch 拆成两条不同原语发送——L1 部分走 RPC 落盘进上下文，L4 部分走观察通知。当前实现未拆分，是一个潜在的「把 L4 内容误当 L1 持久化」或「把 L1 内容误当 L4 丢弃」的风险点。

---

## 6. 决策维度（分布在不同主体上）

每条消息流经各主体时，会被做出决策。**关键：维度不是集中在单一主体，而是分布在不同节点——每个节点只管它有权决定的那几个。** 这也是早期把五维平铺成一张表容易混淆的原因。

| 维度 | 决策主体 | 取值 | 决策依据 |
|---|---|---|---|
| **进上下文** | ① / ⑥ agent | 进 vs 不进 LLM 上下文 | 重要性（仅 L1 进）|
| **处理** | ⑤ 接收端 evolclaw | 进 agent vs 丢弃 | 消息类型（reply 进，status/thought 不进）|
| **投递** | ③ 发端 / ④ 网关 | 发/不发、用哪种模式、扇出给谁 | 重要性 + 对端类型 |
| **存储** | ④ 网关 | 落盘 vs 不落盘 | 重要性（L1/L2 落，L3/L4 不落）|
| **转发 owner** | ③ 发端 / ⑤ 接收端 | 转 vs 不转 | 重要性（仅 L1 转）|

各主体拥有的维度：

| 主体 | 拥有的维度 |
|---|---|
| ① 发端 agent | 进上下文（出站内容生成时）|
| ③ 发端 evolclaw | 投递（选模式+发出）、转发 owner（出站转发）|
| ④ 网关 | 存储、投递（下行扇出 + observe 门控）|
| ⑤ 接收端 evolclaw | 处理（是否进 agent）、转发 owner（入站转发）|
| ⑥ 接收端 agent | 进上下文 |
| ⑦/⑧ 前端 | 渲染（处理的一种）、observe 心跳上报（影响④的投递）|

> **正交性**：这些维度两两独立、无因果关系。例如「进上下文」与「落盘」无关——入站 status 不进上下文但 L2 时仍落盘；L4 thought 不进上下文也不落盘；L1 reply 既进上下文又落盘。

---

## 7. 协议层

协议层描述「消息流经哪些主体、在每个主体上如何处理、到哪个主体终止」。**只要改变了流经的主体序列，就是一种新的协议模式。** 每种模式 = 编号节点的有向路径 + 各节点的决策。

### 7.1 协议模式枚举

用 §1 编号表达路径。`[X]` 表示在该节点的关键决策，`✗` 表示终止。

#### 出站方向（本端 ① / ② 产生）

**O1 落库消息**：`① → ③ → ④[落盘] → ⑦`
- 传输：2 + 3D｜L1/L2｜适用：result.\*、status-terminal（→human/group）

**O2 临时思考流（pull）**：`① → ③ → ④[缓存1h] ← pull ← ⑦`
- 传输：2 + 2P｜L4｜适用：thought（→human，当前 thought.put）

**O3 观察通知（push 门控）**：`① → ③ → ④[不落盘, observe门控] → ⑦（仅观察中）`
- 传输：1 + D′｜L3/L4｜适用：status-transient（→human）、thought（→group）

**O4 发给对端 agent（进对端上下文）**：`① → ③ → ④[落盘] → ⑤ → ⑥[进上下文]`
- 传输：2 + 3｜L1｜适用：result.\*（→agent/node）

**O5 对端处理后转其 owner**：`① → ③ → ④[落盘] → ⑤ → ⑥[处理] → ⑤ → ④[落盘] → ⑧`
- 传输：两段 RPC｜L1｜适用：reply 被对端 agent 接收并转发给对端的 owner

**O6 触发器直发（不过 agent）**：`② → ③ → ④[落盘] → ⑦/⑤`
- 传输：2 + 3D｜L1/L2｜适用：触发器退出码 0，结构化直接执行，**保证准时**

**O7 不发（源头终止）**：`① → ③[✗]`
- 传输：0｜适用：thought / status-transient 出站 → agent/node（对端不观察，发了纯浪费）

#### 入站方向（外部经 ④ 进来）

**I1 处理后回复**：`④ → ③ → ①[处理] → ③ → ④ → 对端`
- 适用：reply 入站，agent 响应

**I2 处理 + 转 owner（并行）**：`④ → ③ → ①[处理]` 且 `③ → ④[落盘] → ⑧`
- 适用：L1 reply 入站，需转给本端 owner 观察

**I3 丢弃（evolclaw 层过滤）**：`④ → ③[✗]`
- 适用：thought / status 入站，不进 agent（白名单过滤）

**I4 无差别转发（当前爆炸源）**：`④ → ③[✗ 不进agent] → ④[落盘] → ⑧`
- **当前 forwardInbound 对所有入站消息无差别走此路径**——是爆炸最大放大器。
- **目标**：仅 L1（reply）走此路径转发，L2/L3/L4 一律不转（owner 看落盘历史即可）。

### 7.2 observe-state 机制（模式 O3 的门控）

- 前端（⑦/⑧）进入观察状态时，每 **2 分钟**向 ④ 发一次观察心跳（上行通知）。
- ④ 记录 `aid → 正在观察的 session-key`，TTL 2 分钟，持续心跳持续刷新。
- 每个前端同一时刻只观察一个会话。
- ④ 收到 L3/L4 观察通知时，检查目标 session 是否有活跃观察者：有则推送，无则丢弃。
- 前端关闭/崩溃后最多 2 分钟 TTL 过期，之后自动停推。
- **代价**：心跳成本可忽略；最多 2 分钟陈旧窗口（白推一点），可接受。

> **设计点（P3）**：observe-state 的 session-key 粒度——观察「agent A 与对端 Z 的单个会话」还是「agent A 的所有会话」，影响④的存储结构与前端交互。

---

## 8. 业务层：消息类型 → 级别 → 协议模式

### 8.1 OutboundPayload 完整类型

| 大类 | 类型 | 级别 |
|---|---|---|
| **result** | result.text / result.file / result.image | L1 |
| | result.error | L2 |
| **activity** | activity.batch（tool_call / tool_result）| L1 |
| | activity.batch（text / reasoning / progress / notice / summary）| L4 |
| **status** | status.started / status.queued / status.progress | L3 |
| | status.completed / status.interrupted / status.error / status.timeout | L2 |
| **command** | command.result / command.error | L2 |
| **interaction** | interaction | L1 |
| **system** | system.notice | L3 |
| | system.error | L2 |

### 8.2 完整策略表（目标状态）

列：进上下文(①⑥) / 落盘(④) / 投递对端(③④) / 转发 owner(③⑤) / 协议模式。

| 消息类型 | 级别 | 对端 | 方向 | 进上下文 | 落盘 | 投递对端 | 转 owner | 模式 |
|---|---|---|---|---|---|---|---|---|
| result.text/file/image | L1 | human | 出/入 | 入✅ | ✅ | 出✅ | ✅ | O1/I2 |
| result.text/file/image | L1 | agent/node | 出/入 | 入✅ | ✅ | 出✅ | ✅ | O4/O5 |
| result.text/file/image | L1 | group | 出/入 | 入✅ | ✅ | 出✅全员 | ✅ | O1/I2 |
| result.error | L2 | human/group | 出/入 | ❌ | ✅ | 出✅ | ✅ | O1 |
| result.error | L2 | agent/node | 出/入 | 入✅ | ❌ | 出✅ | ❌ | C |
| activity(tool_call/result) | L1 | 任意 | 内部 | ✅ | ❌ | — | ❌ | （进上下文，不外发）|
| activity(text/reasoning…) | L4 | human | 出 | — | ❌ | ✅ | ❌ | O2 |
| activity(text/reasoning…) | L4 | agent/node | 出 | — | ❌ | ❌ | ❌ | O7 |
| activity(text/reasoning…) | L4 | group | 出 | — | ❌ | ✅观察 | ❌ | O3 |
| activity.batch | — | 任意 | 入 | ❌ | ❌ | — | ❌ | I3 |
| status.started/queued/progress | L3 | human/group | 出 | — | ❌ | ✅观察 | ❌ | O3 |
| status.started/queued/progress | L3 | agent/node | 出 | — | ❌ | ❌ | ❌ | O7 |
| status.started/queued/progress | L3 | 任意 | 入 | ❌ | ❌ | — | ❌ | I3 |
| status.completed/error/interrupted/timeout | L2 | human | 出 | — | ✅ | ✅ | ❌¹ | O1 |
| status.completed/error/interrupted/timeout | L2 | agent/node | 出 | — | ❌ | ✅观察 | ❌ | O3 |
| status.completed/error/interrupted/timeout | L2 | group | 出 | — | ✅ | ✅全员 | ❌¹ | O1 |
| status.completed/error/interrupted/timeout | L2 | 任意 | 入 | ❌ | ✅(human/group) | — | ❌ | I3 |
| command.result/error | L2 | human/group | 出/入 | 入❌ | ✅ | 出✅ | ✅ | O1 |
| command.result/error | L2 | agent/node | 出/入 | 入✅² | ❌ | 出✅ | ❌ | C |
| interaction | L1 | human/group | 出/入 | 入✅ | ✅ | 出✅ | ✅ | O1/I2 |
| interaction | L1 | agent/node | 出/入 | 入✅ | ❌ | 出✅ | ❌ | O4 |
| system.notice | L3 | human/group | 出 | — | ❌ | ✅观察 | ❌ | O3 |
| system.notice | L3 | agent/node | 出 | — | ❌ | ❌ | ❌ | O7 |
| system.error | L2 | human/group | 出 | — | ✅ | ✅ | ✅ | O1 |
| system.error | L2 | agent/node | 出 | — | ❌ | ✅观察 | ❌ | O3 |

> ¹ status-terminal 是否转 owner 见开放问题 P1（metadata 含 token/duration，owner 可能需要）。
> ² command.result 对端是 agent 时是否进上下文见 P2。

---

## 9. 量化估算（当前 vs 优化后）

**场景**：5 agent + 7 human 群，1 人发消息，5 agent 各响应一次。参数：T=25 thought/响应，S=5 status/响应，O=2 owner/agent，群在线 D=11。

### 9.1 当前机制

| 来源 | 计算 | 网络通信 | 落库 |
|---|---|---|---|
| group.send（reply+status，31条）| 31 × (2+3×11) | 1085 | 31 |
| thought.put（125条，7人拉取）| 125 × (2+2×7) | 2000 | 0 |
| observer 转发（155条 × 5agent × 2owner = 1550，每条 5）| 1550 × 5 | **7750** | 1550 |
| **合计** | | **~10835** | **~1581** |

observer 转发（模式 I4）占 **72%** 网络通信、**98%** 落库——爆炸主因。

### 9.2 优化后（无人观察，最常见）

| 来源 | 计算 | 网络通信 | 落库 |
|---|---|---|---|
| group.send（reply + status-terminal，11条）| 11 × 35 | 385 | 11 |
| thought 观察通知（无人观察，仅上行）| 125 × 1 | 125 | 0 |
| status-transient 观察通知（无人观察）| 100 × 1 | 100 | 0 |
| observer 转发（仅 L1 reply，5条 × 5 × 2 = 50）| 50 × 5 | 250 | 50 |
| **合计** | | **~860** | **~61** |

**↓ 网络通信 92%，↓ 落库 96%**。若有 1 个 owner 观察 1 个会话，仅多约 +25 条通知，总量基本不变。

### 9.3 三个杠杆的贡献

| 杠杆 | 机制 | 砍掉的量 |
|---|---|---|
| **observer 转发按级别过滤** | I4 仅 L1 走，L2/L3/L4 不转 | ~7500 条网络 + ~1500 条落库 |
| **status/thought 走通知 + observe 门控** | L3/L4 用 O3/O7，无人观察则不扇出、不落盘 | ~1800 条网络 + ~25 条落库 |
| **status-terminal 落盘但不转 owner** | L2 落盘供离线补看，但不再镜像给在线 owner | 落盘保留，省转发 |

> 注：本文这条轴治「**单次响应产生多少消息**」。**连锁反应**（agent 互相响应的**次数**）是另一条正交的轴，由 `group-response-policy-design.md`（mention 模式 + 影响力门控 + 攒批）治理。两份设计互补，应并行推进。

---

## 10. 开放问题（待拍板）

| # | 问题 | 影响 |
|---|---|---|
| **P1** | status-terminal（尤其 completed，含 token/duration）是否转 owner？ | 若是，出站需为 L2 终态加一条「仅终态」的 owner 转发（模式 E 变体）|
| **P2** | command.result 对端是 agent 时是否进 agent 上下文？ | agent 间 RPC 是否需要 LLM 消费结果 |
| **P3** | observe-state 的 session-key 粒度（单会话 vs 全部会话）| ④ 存储结构 + 前端交互 |
| **P4** | thought 出站→human：保留 thought.put（缓存+pull）还是改观察通知（push）？ | 建议：pull 补历史 + 观察通知实时推，两者并存 |
| **P5** | result.error 对端是 agent/node 时是否落库？ | 存储成本 vs agent 间错误审计 |
| **P6** | activity.batch 是否按 item.kind 拆分（L1 部分进上下文落盘 / L4 部分观察通知）？ | 避免 L1 误丢或 L4 误存（见 §5.2）|

---

## 附：概念速查

- **传输层原语**：上行调用(2) / 上行通知(1) / 下行推送(1) / 下行推送+ack(3)
- **协议层模式**：O1 落库 / O2 思考pull / O3 观察通知 / O4 发对端agent / O5 转对端owner / O6 触发器直发 / O7 不发；I1 处理回复 / I2 处理+转owner / I3 丢弃 / I4 转发
- **业务层消息**：result.\* / activity.batch / status.\* / command.\* / interaction / system.\*
- **重要性**：L1 上下文 / L2 统计审计 / L3 状态感知 / L4 观察
- **主体编号**：① agent / ② 触发器 / ③ evolclaw / ④ 网关 / ⑤ 接收端evolclaw / ⑥ 接收端agent / ⑦ 对端前端 / ⑧ owner前端

# Phase 6 插件生命周期设计 + 迁移方案

## 文档信息

| 项目 | 内容 |
|------|------|
| 目标 | 把 interactive/proactive 现有机制完整迁移成独立响应模式插件，废弃 message-processor 的条件分支机制 |
| 状态 | 设计待审 |
| 审查方式 | 不靠人眼逐行审，靠三道自动防线（见 §4） |
| 前置 | autonomous 死代码已清理（已完成） |

---

## 一、设计目标与原则

### 1.1 终态愿景

```
现在：message-processor 里 ~20 处 if (isProactive) 条件分支，三种模式逻辑交织
终态：message-processor 是「引擎」，只在固定流程点调 plugin.onXxx(ctx)
      每个响应模式插件「独立完整」实现自己的处理逻辑
```

### 1.2 核心原则

1. **插件独立完整**：一个模式的所有特有逻辑都在它自己的插件类里，不散落在 message-processor
2. **引擎与策略分离**：message-processor 保留「通用执行引擎」（Runner 调用、重试、压缩、统计、持久化），把「模式特有行为」交给插件
3. **运行时能力受控注入**：插件需要的运行时对象（agent/renderer/adapter/queue）通过钩子 Context 传入，不污染插件的「身份/配置」接口
4. **行为逐字节不变**：迁移只换实现位置，不改行为；用行为快照对比保证

### 1.3 为什么需要「生命周期钩子」而非只有 handleInbound/handleOutbound

模式特有逻辑散落在处理流程的**三个阶段**（runner 调用前 / 流处理期间 / 后处理），且依赖运行时对象。仅靠 handleInbound/handleOutbound 两个决策方法无法表达这些「贯穿流程的介入点」。因此插件接口需要扩展为一组**生命周期钩子**。

---

## 二、插件生命周期钩子接口

### 2.1 钩子全景

按 message-processor 处理流程顺序，插件可介入的点：

```
消息入队前
  └─ handleInbound(message) → InboundDecision        [已有] 入队决策

消息出队、开始处理
  └─ beforeProcess(ctx) → void                       [新增] 准备模式运行时状态

Runner 调用前
  └─ configureRun(ctx) → RunConfig                   [新增] 提供 policyHook/renderer 配置/系统提示变量

流处理期间（每个 AgentEvent）
  ├─ onToolUse(ctx) → void                           [新增] 工具调用时介入（首工具表态/汇报提醒）
  └─ onComplete(ctx) → void                          [新增] 完成事件时介入（标志位检查）

每个出站 payload
  └─ handleOutbound(payload) → OutboundDecision      [已有] 发送决策（thought 投影/suppress）

Runner 返回后
  └─ afterProcess(ctx) → void                        [新增] 后处理（文件标记/Unknown skill 兜底）

会话结束
  └─ cleanup() → void                                [已有] 清理
```

### 2.2 钩子签名

```typescript
interface ResponseMode {
  // ─── 元数据（已有）───
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly type: 'builtin' | 'extension';
  readonly applicableScenes: ('private' | 'group')[];
  readonly configSchema?: JSONSchema;

  // ─── 生命周期（已有）───
  initialize(context: ResponseModeContext): Promise<void>;
  cleanup(): Promise<void>;

  // ─── 入站/出站决策（已有）───
  handleInbound(message: InboundMessage): Promise<InboundDecision>;
  handleOutbound(payload: OutboundPayload): Promise<OutboundDecision>;

  // ─── 队列（已有）───
  getQueue(): MessageQueueInterface;

  // ─── 处理流程钩子（新增，全部可选）───
  /** 出队后、Runner 调用前：准备模式运行时状态（如 ProactiveRuntimeState） */
  beforeProcess?(ctx: ProcessContext): Promise<void> | void;

  /** Runner 调用前：提供本次运行的配置（policyHook、renderer 抑制、系统提示变量） */
  configureRun?(ctx: ProcessContext): RunConfig | undefined;

  /** 流处理期间：工具调用事件（首工具表态、工具汇报提醒） */
  onToolUse?(ctx: ToolUseContext): Promise<void> | void;

  /** 流处理期间：完成事件（标志位检查） */
  onComplete?(ctx: CompleteContext): Promise<void> | void;

  /** Runner 返回后：后处理（文件标记发送、Unknown skill 兜底） */
  afterProcess?(ctx: AfterProcessContext): Promise<void> | void;
}
```

### 2.3 钩子的可选性

- **interactive 模式**：只实现 `afterProcess`（文件标记处理）+ handleInbound/handleOutbound。其余钩子不实现。
- **proactive 模式**：实现 beforeProcess（构造 RuntimeState）/ configureRun（policyHook）/ onToolUse（汇报提醒）/ onComplete（标志位）/ handleOutbound（thought）/ afterProcess（Unknown skill 兜底）。
- **未来扩展模式**：按需实现钩子，不用的不实现（接口隔离）。

message-processor 在每个流程点判断 `if (mode.onToolUse) await mode.onToolUse(ctx)`——钩子不存在就跳过，零成本。

---

## 三、钩子 Context 设计（运行时能力受控注入）

每个钩子的 Context 只暴露**该钩子需要的运行时能力**，最小授权。

### 3.1 ProcessContext（beforeProcess / configureRun 用）

```typescript
interface ProcessContext {
  session: Session;
  message: InboundMessage;
  modeConfig: any;                    // 本模式配置（resolver 解析）
  /** per-(session,mode) 状态存储，跨钩子共享（如 ProactiveRuntimeState 存这里） */
  state: Map<string, any>;
  logger: Logger;
}
```

### 3.2 RunConfig（configureRun 返回值）

```typescript
interface RunConfig {
  /** 工具调用策略钩子（proactive 首工具表态用）。返回 block 决定是否拦截工具。 */
  policyHook?: (toolName: string, toolInput: any) => { block: boolean; reason: string } | undefined;
  /** 是否抑制 renderer 活动输出（proactive 不需要，autonomous 才需要——但 autonomous 已删，预留） */
  suppressActivities?: boolean;
  /** 注入系统提示的模式相关变量（chatMode/preTool1stMsgChk 等） */
  promptVars?: Record<string, any>;
}
```

### 3.3 ToolUseContext（onToolUse 用）

```typescript
interface ToolUseContext {
  session: Session;
  state: Map<string, any>;            // 读写 ProactiveRuntimeState
  toolName: string;
  toolInput: any;
  /** 向模型上下文注入消息（不发给对端）——proactive 汇报提醒用 */
  injectToModel: (text: string) => void;
  /** 查询当前队列待处理数——proactive 队列提醒用 */
  getQueueLength: () => number;
  logger: Logger;
}
```

### 3.4 CompleteContext（onComplete 用）

```typescript
interface CompleteContext {
  session: Session;
  state: Map<string, any>;
  /** 本轮最终回复文本（标志位检查用） */
  lastReplyText: string;
  /** 持久化 session metadata（标志位写入用） */
  updateSessionMeta: (patch: Record<string, any>) => Promise<void>;
  logger: Logger;
}
```

### 3.5 AfterProcessContext（afterProcess 用）

```typescript
interface AfterProcessContext {
  session: Session;
  /** Runner 全部输出的完整文本（文件标记扫描用） */
  fullText: string;
  streamResult: { hasReceivedText: boolean };
  /** 发送出站 payload（文件标记发文件、Unknown skill 兜底用） */
  send: (payload: OutboundPayload) => Promise<void>;
  /** 渠道能力查询 */
  channelCapabilities: { file: boolean; thought: boolean; [k: string]: boolean };
  logger: Logger;
}
```

> **设计要点**：Context 不直接传 `agent`/`renderer`/`adapter` 这些大对象，而是把插件需要的**具体能力**包装成小函数（injectToModel/getQueueLength/send/updateSessionMeta）。插件只能用被授予的能力，不能乱碰运行时内部。这是受控注入，不是把引擎内脏掏给插件。

---

## 四、三道审查防线（核心：不靠人眼）

机制已复杂到人工逐行审查不可靠。改用三道自动防线保证正确性。

### 防线 1：行为快照对比（最关键）

**原理**：迁移本质是「行为不变，只换实现」。所以验证「代码对不对」转化为验证「行为是否逐字节一致」。

**做法**：
1. 在 message-processor 的关键决策点埋**行为记录探针**（迁移前），记录每条消息在每个模式分支的：
   - chatMode 判定结果（interactive/proactive）
   - 是否构造 ProactiveRuntimeState、参数值
   - policyHook 是否触发、是否 block
   - 每个出站 payload 的 kind + 发送决策（direct/suppress/thought）
   - 文件标记是否处理、发了哪些文件
   - 标志位是否设置
2. 迁移**前**跑一组真实消息，采集基线快照
3. 迁移**后**插件版本跑同样输入，采集新快照
4. **逐字段对比**，不一致即 bug

**快照格式**（JSONL，每条消息一行）：
```json
{"msgId":"xxx","chatMode":"proactive","proactiveState":{"preTool1stMsgChk":true,...},
 "policyHook":{"triggered":true,"blocked":false},
 "outbound":[{"kind":"activity.batch","decision":"thought"},...],
 "fileMarkers":[],"flagSet":false}
```

### 防线 2：影子模式并行运行

**原理**：切换前先证明「新旧等价」，不拍脑袋。

**做法**：
1. 迁移后，新插件与旧逻辑**并行**跑：
   - 旧逻辑**实际驱动**行为（线上不出事）
   - 新插件**同时算一遍**它「本来会做的决策」，记录但不执行
2. 后台对比两者决策，不一致**告警**（写日志 + eck-debug）
3. 连续 N 条消息（建议 ≥50）完全一致后，才切换到新插件驱动
4. 切换后保留旧逻辑一段时间作为回退路径

**实现**：在决策点同时调用「旧逻辑」和「新插件」，对比结果，差异写 `$EVOLCLAW_HOME/data/eck-debug/shadow-diff.jsonl`。

### 防线 3：迁移点核对表（你审查的就是这张表）

把迁移做成**逐点核对表**，你不看代码，只看这张表的勾选状态。

| # | 迁移点 | 源（行号） | 目标（插件方法） | 抽成能力 | 插件实现 | 快照守护 | 旧守卫删除 | 状态 |
|---|--------|-----------|-----------------|---------|---------|---------|-----------|------|
| 1 | ProactiveRuntimeState 构造 | 811-818 | ProactiveMode.beforeProcess | ☐ | ☐ | ✅ proactiveState | ☐ | ⬜ |
| 2 | policyHook 首工具表态 | 994-1010 | ProactiveMode.configureRun | ☐ | ☐ | ✅ policyHook | ☐ | ⬜ |
| 3 | thought 投影抑制 | 916-922 | ProactiveMode.handleOutbound | ☐ | ✅ | ✅ outbound[].decision | ☐ | ⬜ |
| 4 | 工具汇报提醒 | 2292-2316 | ProactiveMode.onToolUse | ☐ | ☐ | ✅ toolReminder | ☐ | ⬜ |
| 5 | 标志位检查 | 2418-2424 | ProactiveMode.onComplete | ☐ | ☐ | ✅ flagSet | ☐ | ⬜ |
| 6 | Unknown skill 兜底 | 1524-1530 | ProactiveMode.afterProcess | ☐ | ☐ | ✅ unknownSkillFallback | ☐ | ⬜ |
| 7 | 文件标记处理 | 1432→局部函数 | InteractiveMode.afterProcess | ✅ | ✅ | ✅ fileMarkers | ☐(守卫待步骤4) | 🟡 |
| 8 | chatMode 解析 | 764 | Coordinator.resolveInbound | ☐ | ☐ | ✅ chatMode | ☐ | ⬜ |

**列说明**：
- **抽成能力**：模式特有逻辑抽成局部函数/引擎能力（可被插件调用）
- **插件实现**：对应插件方法已实现并单测通过
- **快照守护**：行为快照探针已埋，能捕获该点行为
- **旧守卫删除**：message-processor 的 isProactive 条件分支已删除（步骤4 Coordinator 接入后才能删）
- **状态**：⬜未开始 / 🟡进行中 / ✅完成

> **步骤 2 完成**：迁移点 7（文件标记）抽成局部函数 `processFileMarkers`，InteractiveMode.afterProcess 已实现并单测通过，行为快照验证与基线一致。旧守卫 `if (!isProactive)` 暂留，待步骤4 Coordinator 接入后改由 mode.afterProcess 驱动并删除。

**你的审查 = 确认每行的勾**（抽成能力 + 插件实现 + 快照守护 + 旧守卫删除）。不用看代码。

---

## 五、真实闭环验证方案

**已确认**：4 个 agent 连在 AUN 网关（dddd/llagent2/llbot/ppt-master，持有私钥），`ec msg send` 发、`ec msg pull --app <独立通道>` 收，闭环实测通过。

### 5.1 验证矩阵

| 场景 | 发送方 | 接收方 | 接收方模式 | 预期行为 | 观察方式 |
|------|--------|--------|-----------|---------|---------|
| interactive 私聊 | 人（CLI 模拟） | dddd | interactive | 直接回复 | pull dddd 收件箱看回复 |
| proactive Agent 对话 | llbot | dddd | proactive | thought 投影 + 工具调用才回复 | 看 dddd 输出是 thought 还是 message |
| proactive 首工具表态 | llbot | dddd | proactive | 首工具非表态被 block | 看是否注入违规提醒 |

### 5.2 验证脚本（我自己执行）

```bash
# 1. 迁移前采基线
#    llbot → dddd 发测试消息，dddd 用 proactive 处理
#    用 --app verify-probe 独立通道观察 dddd 的出站（不干扰 daemon）
ec msg send llbot.agentid.pub dddd.agentid.pub "测试消息" --format json
ec msg pull <dddd 的回复目标> --app verify-probe --format json

# 2. 迁移后跑同样输入，对比行为快照
# 3. 影子模式对比 shadow-diff.jsonl
```

> **注意**：验证用真实运行的 agent。我会用独立 app 通道观察、用明确的测试消息，涉及可能干扰真实 agent 工作的操作会先告知 owner。

---

## 六、迁移实施顺序（分模式、可回滚）

每步独立可验证，绝不一次性掀引擎。

### 步骤 0：埋探针 + 影子框架（不改行为）
- 在 message-processor 决策点埋行为快照探针
- 搭影子对比框架（新旧并行 + diff 输出）
- 采集迁移前基线快照
- **验收**：探针不改变任何行为，基线快照采集完成

### 步骤 1：接口扩展（不改行为）
- ResponseMode 接口加 5 个可选钩子 + 5 个 Context 类型
- 两个插件类先留空实现（钩子不做事）
- **验收**：编译通过，现有行为不变（钩子是空的）

### 步骤 2：迁移 InteractiveMode（最简单，1 个迁移点）
- 文件标记处理（迁移点 7）搬进 InteractiveMode.afterProcess
- message-processor 改为调 `mode.afterProcess(ctx)`，删除 1412-1496 旧代码
- **验收**：影子对比 50 条消息一致 + 真实会话发带文件标记的消息验证

### 步骤 3：迁移 ProactiveMode（6 个迁移点）
- 逐个迁移点 1-6，每个迁完跑影子对比
- 全部迁完，删除 message-processor 对应旧代码
- **验收**：影子对比 + 真实 agent 对话验证（thought 投影、首工具表态、汇报提醒）

### 步骤 4：Coordinator 接入 chatMode 解析（迁移点 8）
- 764 行 chatMode 解析改由 Coordinator 驱动（读 response_modes 配置）
- **验收**：配置切换模式生效 + 回落链正确

### 步骤 5：清理与收尾
- 删除 message-processor 残留的 isProactive 判断
- 删除探针、影子框架（或保留为调试开关）
- **验收**：message-processor 无 isProactive 痕迹，全测试通过

---

## 七、风险与回退

| 风险 | 缓解 |
|------|------|
| 钩子 Context 设计不全，迁移中发现缺能力 | 步骤 1 先用空钩子验证接口；缺能力时扩 Context（向后兼容加字段） |
| 新插件行为与旧逻辑有细微差异 | 影子模式对比，差异告警，不达 50 条一致不切换 |
| 切换后线上出问题 | 保留旧逻辑作回退路径，配置开关一键切回 |
| 真实验证干扰运行中 agent | 独立 app 通道观察，测试消息明确标记，高风险操作先告知 owner |

---

## 八、待确认事项

1. **钩子接口设计**（§2.2）：5 个钩子是否覆盖了所有迁移点？有无遗漏的介入时机？
2. **Context 受控注入**（§3）：把运行时能力包装成小函数（injectToModel/send 等）而非传大对象——这个边界是否合理？
3. **三道防线**（§4）：行为快照 + 影子模式 + 核对表，是否够你放心（不用逐行审代码）？
4. **实施顺序**（§6）：先 Interactive（1 点）再 Proactive（6 点）最后 Coordinator——是否认可？

---

最后更新：2026-06-23

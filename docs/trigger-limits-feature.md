# Feature Request: Trigger执行限制与自动停止机制

## 状态
**Status**: 🟡 Workaround Available  
**Created**: 2026-06-26  
**Updated**: 2026-06-26 22:05

## 问题背景

当前trigger系统缺少执行次数和时间限制，导致无法实现"尝试N次或M天后自动停止"的场景。

## 使用场景

用户希望创建一个定时任务，每隔4小时尝试更新某个git仓库。要求：
1. 更新成功后自动停止trigger
2. 最多尝试10次
3. 或最多运行3天
4. 两个条件任一满足即停止

这在网络不稳定的环境下非常有用，既能自动重试，又能防止无限循环。

## 当前Workaround

使用 `strategy: "thread"` + prompt中的逻辑可以部分实现：

**优势**：
- ✅ Thread策略保留历史，agent可统计执行次数
- ✅ Prompt中要求agent检查时间和次数限制
- ✅ Agent可通过 `ec ctl trigger cancel <name>` 自我停止

**局限**：
- ❌ 依赖agent判断逻辑，不是系统强制保证
- ❌ Agent可能误判或遗漏检查
- ❌ 需要较长的prompt描述规则

**示例配置**：见 `hermes-updater` trigger (2026-06-26创建)

详见本文档末尾"临时解决方案"章节。

## 需求详述

### 1. 执行次数限制 (maxRuns)

**参数**: `--max-runs <number>`

**行为**:
- 记录trigger已执行次数
- 达到上限后自动disable该trigger
- 每次成功触发（无论agent返回什么结果）都计数

**示例**:
```bash
ec ctl "trigger set --cron '0 */4 * * *' --max-runs 10 --prompt '更新任务'"
```

### 2. 时间限制 (maxDuration)

**参数**: `--max-days <number>` 或 `--max-duration <duration>`

**行为**:
- 从trigger创建时间开始计时
- 超过指定时长后自动disable
- 支持单位：d(天)、h(小时)、m(分钟)

**示例**:
```bash
ec ctl "trigger set --cron '0 */4 * * *' --max-days 3 --prompt '更新任务'"
# 或
ec ctl "trigger set --cron '0 */4 * * *' --max-duration 72h --prompt '更新任务'"
```

### 3. 条件停止 (stopOn)

**参数**: `--stop-on-success` 或 `--stop-on <condition>`

**行为**:
- 根据agent响应或执行结果判断是否停止
- `--stop-on-success`: 当agent返回特定标记时停止
- `--stop-on <sentinel>`: 自定义停止标记

**Agent端支持**:
在prompt中，agent可以通过输出特定标记触发停止：
```
✓ 更新成功，版本从 v1.0 升级到 v1.1
[TRIGGER_STOP]
```

或使用命令：
```bash
ec ctl trigger stop-current  # 停止当前正在执行的trigger
```

**示例**:
```bash
ec ctl "trigger set --cron '0 */4 * * *' --stop-on-success --prompt '尝试更新hermes-agent，成功后输出[TRIGGER_STOP]'"
```

### 4. 组合使用

多个限制条件可以同时指定，任一条件满足即停止：

```bash
ec ctl "trigger set --cron '0 */4 * * *' \
  --max-runs 10 \
  --max-days 3 \
  --stop-on-success \
  --prompt '更新任务' \
  --name auto-updater"
```

## 数据结构扩展

在 `TriggerDefinition` 类型中增加：

```typescript
export interface TriggerLimits {
  maxRuns?: number;           // 最大执行次数
  maxDurationMs?: number;     // 最大运行时长(毫秒)
  stopOnSuccess?: boolean;    // 成功时停止
  stopSentinel?: string;      // 自定义停止标记
}

export interface TriggerStats {
  totalRuns: number;          // 已执行次数
  successCount: number;       // 成功次数
  failureCount: number;       // 失败次数
  lastRunAt?: number;         // 最后执行时间
  lastStatus?: TriggerRunStatus;
}

export interface TriggerDefinition {
  // ... 现有字段
  limits?: TriggerLimits;
  stats?: TriggerStats;
  autoDisabledReason?: 'max_runs' | 'max_duration' | 'stop_sentinel' | 'manual';
}
```

## UI改进

### trigger list 输出

```
📋 触发器（2 个）：

• auto-updater [cron] active | 下次: 6/27/2026, 12:00:00 AM
  ├─ 执行: 3/10 次
  ├─ 剩余: 2天15小时
  └─ 最后: 6/26 18:00 成功

• daily-report [cron] disabled (达到最大次数)
  └─ 执行: 10/10 次 (全部成功)
```

### trigger 详情

```bash
ec ctl "trigger info auto-updater"
```

输出：
```
📋 触发器详情：auto-updater

状态: ✅ active
类型: cron (0 */4 * * *)
下次触发: 6/27/2026, 12:00:00 AM

📊 执行统计:
  总次数: 3 / 10
  成功: 2 次
  失败: 1 次
  最后执行: 6/26/2026, 6:00:00 PM (成功)

⏱ 时间限制:
  创建于: 6/26/2026, 9:00:00 AM
  最大时长: 3 天
  剩余: 2天15小时

🎯 停止条件:
  • 执行10次后停止
  • 运行3天后停止
  • 成功时自动停止 (sentinel: [TRIGGER_STOP])
```

## 实现建议

1. **scheduler.ts**: 在每次触发前检查限制条件
2. **manager.ts**: 增加 `updateStats()` 方法记录执行统计
3. **feedback.ts**: 解析agent响应中的停止标记
4. **parser.ts**: 解析新增的CLI参数
5. **validation.ts**: 验证参数合法性

## 优先级

**High** - 这是用户实际场景中的常见需求，缺少这些功能会导致trigger的实用性大打折扣。

## 相关Issue

- #TBD: Trigger执行历史查询
- #TBD: Trigger执行失败通知

---

**提交人**: eleanai.agentid.pub  
**日期**: 2026-06-26  
**场景**: 自动更新git仓库，网络不稳定时自动重试

---

## 临时解决方案 (Workaround)

### 方案概述

使用 `strategy: "thread"` + 在prompt中编写限制逻辑，让agent自主判断并停止。

### 配置步骤

1. **使用thread策略**（保留历史）：
```json
{
  "execution": {
    "session": {
      "strategy": "thread"
    }
  }
}
```

2. **在prompt中定义限制**：
```
【任务名称】

执行限制（请严格遵守）：
- 最多执行10次
- 创建时间：<创建时间>
- 最晚执行到：<截止时间>

执行步骤：
1. 检查限制：查看本thread历史，统计执行次数。如果>=10次或超时，
   执行：ec ctl trigger cancel <trigger-name>，然后输出限制信息并结束。

2. 执行任务：<实际任务内容>

3. 判断成功：<成功条件>

4. 成功停止：如果成功，执行：ec ctl trigger cancel <trigger-name>

5. 报告格式：
   - 成功：✅ 第N次 | 成功 | trigger已停止
   - 失败：❌ 第N次 | 失败 | 剩余X次/X天
   - 限制：⏹ 已达限制 | trigger已停止
```

### 实际案例

**Trigger**: `hermes-updater` (创建于2026-06-26)

**配置**：
- 每4小时尝试更新hermes-agent
- 最多10次或3天
- 更新成功后自动停止

**完整配置**：`/home/evolclaw/data/triggers/eleanai.agentid.pub/trig_*/trigger.json`

### 局限性

1. **不是系统保证** - 依赖agent的判断逻辑
2. **可能遗漏** - Agent如果出错可能不执行检查
3. **Prompt长度** - 需要详细描述规则
4. **无审计** - 系统层面无执行次数统计

### 为什么需要系统级实现

- ✅ 强制保证，不依赖agent判断
- ✅ 统一的执行统计和审计
- ✅ 简洁的CLI参数（`--max-runs 10 --max-days 3`）
- ✅ 自动化的UI显示（进度、剩余次数）


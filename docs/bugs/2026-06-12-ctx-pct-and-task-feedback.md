# Bug 反馈: Ctx% 统计口径 & Task 完成通知

**报告人:** toleiliang5 (吴浩)  
**日期:** 2026-06-12  
**发现环境:** evolclaw 3.3.0, Windows 11, Claude Code + Deepseek V4 Pro  

---

## Bug 1: `ec stats --session <id> --context` 的 Ctx% 计算口径有问题

### 现象

`ec stats --session <id> --context` 输出的 `Ctx%` 列：
- **opus 模型轮次全部显示 `0%`**，即使 cache 列显示几百万 token
- **deepseek-v4-pro 的 Ctx% 正常范围为 0%~100%+**，包括出现 `1936%` 这种远超 100% 的异常值
- **同一个 session 内部 switch model 后 Ctx% 行为不一致**

### 具体数据点

**Session:** `meta_20260605_1780643757872` (toleiliang3, 群11716)

| 时间 | 模型 | Input | Output | Cache | Ctx% |
|------|------|-------|--------|-------|------|
| 10:28:43 | deepseek-v4-pro | 69.7k | 301 | 7.0k | **38%** |
| 10:35:02 | deepseek-v4-pro | 25.3k | 13.6k | 3.8M | **1936%** 🔴 |
| 10:35:32 | deepseek-v4-pro | 101.3k | 453 | 118.9k | **110%** |
| 11:57:45 | deepseek-v4-pro | 108.8k | 113 | 1.0k | **54%** |
| ... | ... | ... | ... | ... | ... |
| 00:15:24 | **opus** | 3 | 155 | 361.5k | **0%** 🔴 |
| 00:17:28 | **opus** | 3 | 5 | 362.0k | **0%** 🔴 |
| 06:41:58 | **opus** | 2 | 114 | 453.7k | **0%** 🔴 |
| 06:43:53 | **opus** | 5 | 230 | 2.3M | **0%** 🔴 |

**Session:** `meta_20260605_1780643757789` (toleiliang10, 群11716)

| 时间 | 模型 | Input | Output | Cache | Ctx% |
|------|------|-------|--------|-------|------|
| 10:28:33 | deepseek-v4-pro | 44.4k | 102 | 7.3k | **26%** |
| 10:30:08 | deepseek-v4-pro | 153 | 183 | 51.6k | **26%** |
| 12:00:54 | deepseek-v4-pro | 37.8k | 72 | 13.8k | **19%** |
| 12:01:31 | deepseek-v4-pro | 740 | 68 | 51.8k | **0%** |
| 06:41:34 | deepseek-v4-pro | 258.7k | 7 | 8.2k | **26%** |
| 06:42:53 | deepseek-v4-pro | 182 | 9 | 266.9k | **0%** |

### 分析

**问题 A: opus 的 Ctx% 恒为 0%**

opus 的 `context_window` = 200k，Ctx% = input_tokens / 200000。但 opus 轮次 input 经常只有个位数（dispatch=mention 模式过滤后），计算结果 <0.5%，四舍五入显示 0%。这不是真 "0% 占用"，而是算式不反映真实上下文压力。

真正有意义的是 `(input + cache_read) / context_window`。以 06:43:53 这行为例：
- input=5, cache=2.3M, 窗口=200k
- 如果 Ctx% 用 (5 + 2.3M) / 200k 算，破 1000%
- **问题是 cache_read 被计入了 Cache 列但没有参与 Ctx% 的分子**

用户视角：我看到 Cache 列显示 2.3M、Ctx% 显示 0%，完全无法判断"要不要压缩"。

**问题 B: deepseek-v4-pro Ctx% 超过 100%**

10:35:02 轮: input=25.3k, cache=3.8M, window=128k, Ctx%=1936%
- 单纯 input/window = 25.3k/128k ≈ 19.8%
- cache_read/window = 3.8M/128k ≈ 2969%
- Ctx% = 25.3k/128k * (3.8M / 某基线?) — 明显不对
- 1936% 是一个无法解释的数字，疑似计算逻辑包含了 cache 的某个因子但算错了

**问题 C: 同 session 跨模型 Ctx% 不一致**

同一个 session `meta_20260605_1780643757872`，deepseek-v4-pro 轮次 Ctx% 有正常值（38%~110%），opus 轮次全部 0%。session 级统计没有按模型重设计算逻辑。

### 预期行为

- `Ctx%` = (input_tokens + cache_read_tokens) / context_window × 100%
- `context_window` 按实际使用的模型查询，跨模型切换时自动更新
- 若超过 100%，显示 `>100%` 或实际值加 ⚠️ 标记
- 或者在表格中直接给出 `current input + cache` 两列，让用户自己判断而不是只给一个 Ctx%

---

## Bug 2: Task 完成后只更新 status，不发送用量汇总

### 现象

evolclaw 的 Task 系统（`TaskCreate` / `TaskUpdate`）只在内部跟踪任务状态，**没有在任务标记 `completed` 时向上层产生一条用量通知或用户可见的结束消息**。

### 具体表现

在本次会话中：
- Base agent（Claude Code）做了多次 TaskCreate → TaskUpdate(completed)
- 标记 `completed` 后，harness 没有触发任何 `ec msg send` 或通知
- 用户端（Evol 客户端）完全看不到"任务 X 完成，消耗 input=X output=Y CNY=Z"这类汇总

### 分析

这是 harness 层的缺失——Task 生命周期 event（created/in_progress/completed）没有对应一条向 channel 回调的 hook。可能的落点：
1. evolclaw harness 监听 task 状态变更 event，任务完成时在下一轮注入一段 **用量汇总**到 context，base agent 自然会输出给用户
2. 或者让 `TaskUpdate(status=completed)` 的 tool result 直接包含用量信息，但当前 tool result 只返回一条 dry 的 `Updated task #N status`

### 预期行为

Task `completed` 后，harness 应自动生成类似这样的用户可见输出：

> ✅ Task "整理 toleiliang 打头的 Agent 信息表" 完成  
> 本轮消耗: input=2.0k | output=1.0k | cache=251.9k | Ctx%=0% | ¥0.1381

---

## 附加发现: Task 粒度不一致

部分任务没有建 Task——比如"股神系梳理""雷量系上下文窗口查看"这些子任务直接在对话中处理了，没有 TaskCreate。建议在 harness 侧做一个检查: 如果有超过 1 轮的实际工作但没有 task，prompt 里提醒 base agent 建 task。

# 渠道级 showActivities 差异化配置

## 概述

支持在 `evolclaw.json` 中按渠道独立配置 `showActivities` 参数，控制该渠道是否向用户发送工具活动等中间输出。渠道级配置优先于全局配置。

## 配置方式

```json
{
  "showActivities": "all",
  "channels": {
    "feishu": {
      "showActivities": "dm-only"
    },
    "wechat": {
      "showActivities": "none"
    },
    "aun": {
      "showActivities": "all"
    }
  }
}
```

### 可选值

| 值 | 含义 |
|---|---|
| `"all"` | 所有场景都显示工具活动（默认） |
| `"dm-only"` | 仅私聊显示，群聊抑制 |
| `"owner-dm-only"` | 仅 owner 的私聊显示 |
| `"none"` | 完全不显示 |

### 优先级（Fallback Chain）

```
channels.*.showActivities → showActivities（全局） → 'all'（默认值）
```

- 渠道级设置存在时，使用渠道级值
- 渠道级未设置时，回退到全局 `showActivities`
- 全局也未设置时，默认 `'all'`

## 影响范围

`showActivities` 控制的输出类型：

- 工具调用活动（`🔧 Read: /tmp/x`）
- 流式文本增量
- 会话压缩通知（`⏳ 会话压缩中...`）
- 子任务进度（`⏳ 子任务: ...`）
- 工具错误（`⚠️ Read: error`）
- 运行时错误（`⚠️ ...`）
- 空闲监控通知

**不受影响**：最终回复文本始终发送，与该配置无关。

## 实现

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `ChannelOptions` 和各渠道 config 接口增加 `showActivities` 字段 |
| `src/channels/feishu.ts` | policy 闭包使用 `feishuConfig.showActivities ?? config.showActivities ?? 'all'` |
| `src/channels/wechat.ts` | policy 闭包使用 `wechatConfig.showActivities ?? config.showActivities ?? 'all'` |
| `src/channels/aun.ts` | policy 闭包使用 `aunConfig.showActivities ?? config.showActivities ?? 'all'` |

### 数据流

```
evolclaw.json
  ↓
channels/*.ts setup()          ← 读取 channelConfig.showActivities
  ↓
policy.showMiddleResult()      ← channelConfig ?? globalConfig ?? 'all'
  ↓
message-processor.ts:123       ← shouldSuppress = !policy.showMiddleResult(chatType, identity)
  ↓
message-processor.ts:625+      ← if (!shouldSuppress()) flusher.addActivity(...)
  ↓
flusher → adapter.sendText()   ← 决定是否发送给用户
```

### 核心逻辑

各渠道 policy 中的 `showMiddleResult` 和 `showIdleMonitor` 使用相同逻辑：

```typescript
showMiddleResult: (chatType: string, identity: string) => {
  const mode = channelConfig.showActivities ?? config.showActivities ?? 'all';
  if (mode === 'none') return false;
  if (mode === 'dm-only') return chatType === 'private';
  if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
  return true;
},
```

## 测试

### 单元测试

`tests/unit/show-activities-config.test.ts` — 10 个用例，覆盖 fallback chain 和四种 mode：

- fallback: channel → global → default
- mode: `none` / `dm-only` / `owner-dm-only` / `all`
- channel 覆盖 global

### 集成测试

`tests/integration/show-activities-config.test.ts` — 6 个用例，验证 config → processor → activity 抑制的完整链路：

| 用例 | channel | global | chatType | activity 是否发送 |
|---|---|---|---|---|
| channel=none 抑制 | `none` | `all` | private | 否 |
| channel=all 显示 | `all` | `none` | private | 是 |
| global=none 兜底抑制 | 未设 | `none` | private | 否 |
| dm-only 私聊显示 | `dm-only` | 未设 | private | 是 |
| dm-only 群聊抑制 | `dm-only` | 未设 | group | 否 |
| channel 覆盖 global | `all` | `none` | private | 是 |

### 运行测试

```bash
npx vitest run tests/unit/show-activities-config.test.ts
npx vitest run tests/integration/show-activities-config.test.ts
```

## 典型场景

- **微信渠道设为 `none`**：微信有字符限制且不支持富文本，隐藏工具活动减少干扰
- **飞书渠道设为 `dm-only`**：群聊中抑制中间输出避免刷屏，私聊保留透明度
- **AUN 渠道设为 `all`**：开发调试渠道，保留所有输出

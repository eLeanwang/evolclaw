# ECWeb 系统页面健康检查显示问题诊断结果

## 问题描述
用户反馈：ecweb 点击"健康检查"按钮后，看不到 agent 状态，近1小时消息统计显示全 0。

## 根本原因

**用户没有配置任何 EvolAgent**。

检查发现：
```bash
ls /root/.evolclaw/agents/
# 输出：No such file or directory
```

## 技术细节

### 健康检查数据结构（`/check` 命令）

返回的 `structured` 数据包含：
```typescript
{
  channels: [...],           // 渠道列表
  queue: {...},              // 队列统计
  baseagent: string,         // 当前 baseagent
  defaultBaseagent: string,  // 默认 baseagent
  uptimeMs: number,          // 运行时长
  lastHour: {...},           // 近1小时统计（全局）
  evolagents: [...],         // EvolAgent 列表 ← 问题所在
  unownedChannels: [...],    // 未归属渠道
}
```

### EvolAgent 数据来源

`evolagents` 数组通过以下代码生成（`slash-handler.ts:1661`）：

```typescript
const evolagents = (this.agentRegistry?.list() ?? []).map((ag: any) => {
  const chans = (ag.channels ?? []).map((n: string) => { 
    ownedNames.add(n); 
    return channelHealth(n); 
  });
  const processing = this.messageQueue.getProcessingCountByAgent(ag.aid);
  const pending = this.messageQueue.getQueueLengthByAgent(ag.aid);
  return {
    name: ag.name, 
    aid: ag.aid ?? '', 
    status: ag.status,
    baseagent: ag.baseagent ?? null,
    model: ag.model ?? null,
    effort: ag.effort ?? null,
    projectPath: ag.projectPath ?? null,
    processing, 
    pending,
    activeTasks: processing + pending,
    lastActivity: ag.lastActivity ?? 0,
    error: ag.error,
    channels: chans,
  };
});
```

如果 `agentRegistry.list()` 返回空数组，则 `evolagents` 为空，前端就不会渲染"EvolAgent 健康卡片"。

### 前端渲染逻辑（`app.js:1963`）

```javascript
if (chk.evolagents?.length) {
  html += '<div class="agent-health-grid">';
  for (const ag of chk.evolagents) html += agentHealthCard(ag);
  html += '</div>';
}
```

**如果 `evolagents` 为空数组，这段代码不执行，健康卡片不显示。**

### 近1小时统计

"近1小时"统计显示全 0 是正常的，因为：
- 统计数据来自 `statsCollector.getSnapshot(currentAgentName)`
- 如果最近1小时内没有消息活动，所有计数器都是 0
- 这与是否配置 EvolAgent 无关

## 解决方案

用户需要创建 EvolAgent 配置文件。有两种方式：

### 方式1：通过 CLI 创建（推荐）

```bash
evolclaw agent new myagent
```

交互式引导填写：
- Agent 名称
- 项目路径
- Baseagent（claude/codex/gemini）
- 模型（opus/sonnet/haiku）
- Effort（low/medium/high/xhigh/max）
- 渠道配置（AUN AID、飞书、微信等）

### 方式2：手动创建配置文件

创建 `/root/.evolclaw/agents/myagent.json`：

```json
{
  "name": "myagent",
  "enabled": true,
  "agents": {
    "claude": {
      "model": "opus",
      "effort": "high"
    }
  },
  "channels": {
    "aun": {
      "aid": "evolagent.agentid.pub",
      "owner": "molian.agentid.pub"
    }
  },
  "projects": {
    "defaultPath": "/home/evolclaw"
  },
  "chatmode": {
    "private": "interactive",
    "group": "proactive"
  }
}
```

然后重启 evolclaw：

```bash
evolclaw restart
```

## 预期结果

创建 EvolAgent 后，点击"健康检查"会显示：

### ① 队列统计（已显示）
```
队列
0 待 · 0 处理中
```

### ② 近1小时统计（已显示，数值为0是正常的）
```
近 1 小时
收 0 · 完 0 · 错 0 · 断 0
```

### ③ BASEAGENT 卡片（已显示）
```
Baseagent · ✓ claude
opus · high
```

### ④ EvolAgent 健康卡片（当前缺失，创建后会显示）
```
┌─────────────────────────────────────┐
│ ● myagent                  running  │
│───────────────────────────────────  │
│ 项目   /home/evolclaw                │
│ 后端   claude · opus · high         │
│ 渠道   ✓ aun#evolagent.agentid.pub  │
│ 负载   0 处理中 · 0 待处理           │
└─────────────────────────────────────┘
```

## 总结

- **问题根源**：用户没有配置 EvolAgent
- **表现**：健康检查缺少"EvolAgent 健康卡片"部分
- **近1小时统计全0**：正常现象（最近1小时无消息活动）
- **解决办法**：运行 `evolclaw agent new <name>` 创建 EvolAgent 配置

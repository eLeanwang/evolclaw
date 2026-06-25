# ECWeb 智能体视图显示问题诊断

## 问题描述
用户反馈：ecweb "智能体"标签页看不到 agent 状态了，近1小时的消息统计也没有了。

从截图来看：
- 顶部显示版本信息：EVOLCLAW 3.5.7, FASTAUN 0.5.0, ECWEB 1.2.2, NODEJS v22.17.1
- 显示了队列统计：0 待 · 0 处理中
- 显示了三个 BASEAGENT：
  - CLAUDE: opus · high
  - CODEX: 未指定模型/强度
  - GEMINI: gemini-2.5-flash

## 诊断分析

### 1. 标签页映射
- 中文标签"智能体" → `tab.agents` → 对应 `view-agents`
- HTML 中确认存在：`<section id="view-agents" class="view active"></section>`

### 2. 数据流
```
前端订阅 'agents' view 
→ WebSocket 消息 { type: 'subscribe', view: 'agents' }
→ 后端 aidSource.snapshot() 
→ IPC 查询：aun-aids, aun-aid-stats, status, evolagent.list
→ 返回 { daemonRunning, aids, stats, agents, version }
→ 前端 renderAgents(data)
```

### 3. renderAgents 函数逻辑
```javascript
function renderAgents(data) {
  const allAgents = data.agents || [];  // EvolAgent 列表
  const aids = data.aids || [];         // AUN AID 连接状态
  const statsByAid = {};                // 按 AID 索引的统计
  for (const s of (data.stats || [])) statsByAid[s.aid] = s;
  
  // 渲染 enabled/disabled 两个子标签页
  // enabled 页显示：AID、工作状态、队列、模型、运行时、收发消息、字节、对端数、最后活动、操作
}
```

### 4. 可能的问题

#### 问题1：截图显示的不是 agents 视图
用户截图中显示的内容（版本号、BASEAGENT、队列）实际上像是 **System 视图** 的内容，而不是 Agents 视图。

可能原因：
- 用户点击了"系统"标签页而不是"智能体"标签页
- 标签页切换逻辑有问题，导致点击"智能体"实际显示的是"系统"

#### 问题2：agents 视图数据为空
如果确实是 agents 视图，但显示为空，可能是：
- `data.agents` 为空数组
- `data.daemonRunning` 为 false
- 渲染逻辑错误

### 5. 验证步骤

需要确认：
1. 用户当前看到的是哪个标签页？（URL hash 或 active tab）
2. WebSocket 订阅的是哪个 view？
3. 后端返回的数据是什么？

## 建议操作

### 立即验证
1. 在浏览器控制台执行：
```javascript
console.log('Current view:', document.querySelector('.tab.active')?.dataset.view);
console.log('Visible section:', document.querySelector('.view:not([style*="display: none"])')?.id);
```

2. 检查 WebSocket 消息：
```javascript
// 打开浏览器开发者工具 → Network → WS → 查看消息
```

### 排查方向
- 如果用户看到的是 System 视图：提示用户点击正确的"智能体"标签
- 如果确实是 Agents 视图但无数据：检查后端 IPC 返回值

## 临时结论

**最可能的原因**：用户当前查看的是"系统"（System）标签页，而不是"智能体"（Agents）标签页。截图中显示的内容（版本号卡片、BASEAGENT 列表、队列统计）完全符合 System 视图的布局。

**建议用户操作**：点击顶部导航栏的"智能体"标签（第一个标签），而不是"系统"标签（第六个标签）。

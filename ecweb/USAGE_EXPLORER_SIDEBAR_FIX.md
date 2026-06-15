# Explorer 侧边栏修复

## 修复的问题

### 1. 左侧列表显示 NaN
**原因：** Agent 列表数据没有 `input_tokens` 和 `output_tokens` 字段，导致计算 `a.input_tokens + a.output_tokens` 时返回 NaN。

**修复：** 移除了 Agent 列表项旁边的 token 统计显示，因为这个数据不需要显示在 agent 列表中。

### 2. 对端智能体列表需要动态加载
**原因：** 之前是初始化时同时加载所有 agents 和 peers，无法区分是哪个 agent 的 peer。

**修复：**
- 拆分了 `renderExplorerSidebar` 函数为独立的 `renderExplorerAgentList` 和 `renderExplorerPeerList`
- 初始加载时只加载 agent 列表，peer 列表为空
- 当用户选择特定 agent 时，调用 `loadPeersForAgent(agentAid)` 动态加载该 agent 的 peers
- 当用户选择"全部"时，清空 peer 列表

## 新增函数

### `renderExplorerAgentList(agents)`
渲染 Agent 列表，包含：
- "全部"选项（默认选中）
- 所有 agent 项
- 绑定点击事件，选中时加载对应的 peers

### `loadPeersForAgent(agentAid)`
异步加载指定 agent 的 peer 列表：
- 调用 `/api/stats/peers?agent={agentAid}&from={fromTs}&to={toTs}`
- 传递当前的时间范围参数
- 加载完成后调用 `renderExplorerPeerList` 渲染

### `renderExplorerPeerList(peers)`
渲染 Peer 列表：
- 如果 peers 为空，显示"暂无数据"
- 显示每个 peer 的名称、类型标签（群聊/单聊）、群人数、token 统计
- 绑定点击事件，选中时更新 `_expSelection` 并执行查询

## 交互流程

```
用户打开 Explorer
    ↓
显示所有 agent 列表
默认选中"全部"
peer 列表为空
    ↓
用户点击某个 agent
    ↓
加载该 agent 的 peer 列表
显示该 agent 的所有对话对端
    ↓
用户点击某个 peer
    ↓
显示该 peer 的统计数据
```

## 后端依赖

需要后端 `/api/stats/peers` API 支持 `agent` 参数过滤：
```
GET /api/stats/peers?agent={agentAid}&from={fromTs}&to={toTs}
```

返回该 agent 在指定时间范围内的所有 peer 统计。

## 样式提示

当 peer 列表为空时，显示居中的灰色提示文字："暂无数据"

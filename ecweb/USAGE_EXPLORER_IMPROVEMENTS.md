# Explorer（详细统计）优化

## 改进内容

### 1. 独立的时间选择
- Explorer 现在有自己独立的时间范围选择，不再依赖总览
- 支持预设范围：今日、本周、上周、本月、最近30天、自定义
- **自定义时间支持精确到时分秒**（使用 `datetime-local` 输入框）
- 与总览独立，互不影响

### 2. 动态模型下拉选择
- 模型字段从文本输入改为下拉选择框
- 根据当前选择的时间范围，从数据库聚合出该时段内使用过的模型
- 支持"全部"选项查看所有模型的数据
- 切换时间范围时自动重新加载可用模型列表

### 3. 国际化支持
- 所有新增的 UI 文本支持中英文切换
- 新增翻译项：
  - `usage.explorer.filter.granularity`: "粒度" / "Granularity"

### 4. 样式优化
- **时间范围选择器**：
  - 仿照总览的标签式设计
  - 卡片式背景，带边框和圆角
  - 激活状态使用主题色高亮
  - 自定义时间区域有分隔线
  
- **模型和粒度筛选器**：
  - 更大的内边距和字体
  - 更清晰的标签和输入框布局
  - 下拉框有指针光标提示可点击
  - 查询按钮有悬停动画效果（上移1px）
  - 更好的间距和对齐

### 5. 卡片数据显示优化
- **选择"全部"时**：显示该时间范围的总览汇总数据
- **选择特定 Agent/Peer 时**：
  - 显示该筛选条件下的统计数据
  - 卡片顶部显示友好标题：`昵称 (AID: agent_id)` 或 `Peer名称 (Peer: peer_key)`
  - 如果没有数据，所有指标显示为 0

## 后端新增 API

### `/api/stats/models`
查询指定时间范围内使用过的模型列表

**请求参数：**
- `from` (可选): 开始时间戳（毫秒）
- `to` (可选): 结束时间戳（毫秒）

**返回：** 字符串数组，包含所有使用过的模型ID（去重、排序）

**实现：**
- 新增 `queryUsedModels()` 函数在 `stats.ts`
- 从 `usage_events` 表中 `SELECT DISTINCT model`

## 数据流

```
用户选择时间范围
    ↓
计算时间戳（fromTs, toTs）
    ↓
加载可用模型列表（/api/stats/models）
    ↓
执行查询（/api/stats/explorer + /api/stats/overview）
    ↓
显示卡片和图表
```

## 技术细节

### 全局变量
- `_expCurrentRange`: Explorer 当前的时间范围类型
- `_expTimeRange`: Explorer 的时间范围（fromTs, toTs）
- `_expSelection`: 当前选中的 agent/peer

### 关键函数
- `initExplorerTimeFilters()`: 初始化时间选择器
- `calculateExplorerTimeRange()`: 计算时间范围
- `loadExplorerModels()`: 加载可用模型列表
- `fetchExplorerOverviewData()`: 获取该时间范围的总览数据
- `runExplorerQuery()`: 执行查询并显示结果

### 样式类
- `.exp-time-filters`: 时间筛选器容器
- `.exp-range-tabs`: 时间范围标签按钮组
- `.exp-range-btn`: 时间范围按钮
- `.exp-custom-date`: 自定义时间输入区域
- `.explorer-filters`: 模型和粒度筛选器（优化后）

## 对比：总览 vs Explorer

| 特性 | 总览 (Overview) | 详细统计 (Explorer) |
|------|----------------|-------------------|
| 时间选择 | 独立 | 独立 |
| 自定义时间精度 | 仅日期 | 精确到分钟 |
| 模型筛选 | 无 | 动态下拉选择 |
| Agent/Peer 筛选 | 无 | 左侧列表选择 |
| 卡片数据 | 固定显示总览 | 根据筛选条件动态计算 |
| 图表 | 无 | 时间序列图表 |

## 用户体验提升

1. **更直观的时间选择**：标签式设计一目了然
2.**更精确的时间控制**：Explorer 支持到分钟级别
3. **更方便的模型筛选**：下拉选择，只显示该时段内的模型
4. **更清晰的样式**：卡片式布局，层次分明
5. **更智能的数据展示**：根据筛选条件自动计算对应的卡片数据

# 用量页面详细统计同步总览时间和卡片

## 需求
1. 用量页面的"详细统计"（Explorer）应该使用"总览"（Overview）中的时间日期选择
2. 时间选择应该精确到时分秒
3. 详细统计的卡片内容应该对齐总览的卡片展示

## 实现的修改

### 1. 总览时间选择支持时分秒 (index.html)
- 将总览的自定义日期输入从 `type="date"` 改为 `type="datetime-local"`
- 支持精确到分钟的时间选择

### 2. 移除详细统计独立的时间选择器 (index.html)
- 从 Explorer 面板移除了独立的 From/To 日期选择器
- Explorer 现在完全依赖总览的时间范围

### 3. 总览数据共享 (app.js)
- 在 `loadUsageOverview()` 中保存时间范围到 `window._currentOverviewTimeRange`
- 保存总览数据到 `window._currentOverviewData` 供 Explorer 使用
- 支持 datetime-local 格式的时间解析

### 4. 详细统计使用总览时间 (app.js)
- `runExplorerQuery()` 从 `window._currentOverviewTimeRange` 读取时间范围
- 移除了 Explorer 独立的日期输入框处理逻辑

### 5. 详细统计显示总览卡片 (app.js)
- Explorer 的卡片区域始终显示（移除了 `style="display:none"`）
- `runExplorerQuery()` 使用 `window._currentOverviewData` 生成与总览相同的三组卡片：
  - 会话信息卡片（会话数、收到消息、发出消息）
  - 用量信息卡片（模型调用、输入/输出Token、缓存创建/命中、命中率）
  - 花费信息卡片（官方价格、网关价格）

### 6. 自动同步查询 (app.js)
- 总览的时间范围切换时，自动触发详细统计的查询更新
- 切换到 Explorer 标签时，自动执行一次查询

### 7. 辅助函数 (app.js)
- 新增 `formatDatetimeLocal()` 函数，用于格式化日期为 datetime-local 输入框格式

## 使用方式
1. 在"总览"标签选择时间范围（今日、本周、本月等，或自定义精确时间）
2. 总览会显示对应时间范围的汇总卡片和按 Agent 的统计表
3. 切换到"详细统计"标签，会自动使用相同的时间范围
4. 详细统计顶部显示与总览相同的汇总卡片
5. 可以在详细统计中选择具体的 Agent 或 Peer 进一步筛选

## 技术细节
- 时间范围通过全局变量 `window._currentOverviewTimeRange` 共享
- 总览数据通过全局变量 `window._currentOverviewData` 共享
- datetime-local 格式：`YYYY-MM-DDTHH:mm`
- 时间戳统一使用毫秒级 Unix 时间戳

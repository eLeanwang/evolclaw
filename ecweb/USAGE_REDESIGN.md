# 用量页面重新设计说明

## 更新时间
2026-06-15

## 重大改进

### 1. 卡片布局重新设计 - 信息整合

将相关指标整合到大卡片中，提升信息密度和可读性：

#### **会话信息卡片**（蓝色主题）
- 会话数
- 收到消息
- 发出消息

#### **用量信息卡片**（绿色主题）
- 模型调用次数
- 输入Token
- 输出Token
- 缓存创建
- 缓存读取
- 缓存命中率

#### **花费信息卡片**（橙色主题）
- 官方价格（美元/人民币）
- 网关价格（美元/人民币）

### 2. 按Agent汇总表格增强

新增列：
- **缓存命中率** - 显示每个Agent的缓存使用效率
- **官方价格** - Anthropic官方定价
- **网关价格** - 实际支付价格

价格显示方式：
- 主显示：美元（$X.XX）
- 辅助显示：人民币（¥X.XX，小字灰色，显示在下方）

### 3. 新增：模型访问明细查询功能 ✨

在"按Agent汇总"表格下方新增明细查询区域：

#### 查询条件
- **Agent选择** - 可选择特定Agent或查看全部
- **起始日期** - 开始时间
- **结束日期** - 结束时间
- 默认显示最近7天数据

#### 明细表格显示
每行显示一次模型调用的详细信息：
1. **时间** - 调用时间戳
2. **Agent** - 调用的Agent
3. **Peer** - 对话的Peer
4. **模型** - 使用的模型名称
5. **输入** - 输入Token数
6. **输出** - 输出Token数
7. **缓存创建** - 缓存写入Token数
8. **缓存读取** - 缓存命中Token数
9. **官方价格** - 单次调用的官方价格
10. **网关价格** - 单次调用的实际价格

#### 特性
- 按时间倒序排列（最新的在上面）
- 默认显示100条记录
- 支持滚动查看
- 价格采用紧凑格式显示

## 技术实现

### 前端变更

#### HTML (src/static/index.html)
- 添加了明细查询区域
- 包含Agent选择器、日期选择器和查询按钮

#### JavaScript (src/static/app.js)
- `makeMultiValueCard()` - 创建多值信息卡片
- `initDetailQuery()` - 初始化明细查询功能
- `loadDetailAgentList()` - 加载Agent列表到下拉框
- `queryDetailUsage()` - 执行明细查询
- `renderDetailTable()` - 渲染明细表格
- `fmtCostCompact()` - 紧凑格式价格显示

#### CSS (src/static/style.css)
- `.multi-value-card` - 多值卡片样式
- `.card-title` - 卡片标题
- `.card-items` - 卡片内容网格布局
- `.detail-filters` - 明细查询过滤器样式

### 后端变更

#### stats.ts (src/sources/stats.ts)
- `queryUsageDetail()` - 新增明细查询函数
  - 支持按Agent、时间范围过滤
  - 返回usage_events表的原始记录
  - 包含所有Token和价格信息

#### server.ts (src/server.ts)
- 新增 `/api/stats/detail` 接口
  - 接受参数：from, to, agent, limit
  - 返回模型访问明细数组

### 数据库查询
```sql
SELECT ts, agent_aid, peer_key, model,
  input_tokens, output_tokens, 
  cache_creation_tokens, cache_read_tokens,
  cost_official_usd, cost_official_cny,
  cost_gateway_usd, cost_gateway_cny
FROM usage_events
WHERE ts >= ? AND ts <= ? AND agent_aid = ?
ORDER BY ts DESC LIMIT 100
```

## 用户体验提升

### 信息组织
- ✅ 相关指标集中展示，减少视觉跳转
- ✅ 三个主题色清晰区分信息类别
- ✅ 卡片内部使用网格布局，自适应屏幕宽度

### 价格透明度
- ✅ 官方价格 vs 网关价格对比一目了然
- ✅ 美元和人民币双币种显示
- ✅ 表格中紧凑显示，卡片中详细显示

### 明细追溯
- ✅ 可以精确查看每次模型调用的详情
- ✅ 按Agent过滤，快速定位问题
- ✅ 时间范围筛选，灵活查询历史数据
- ✅ 支持排查异常费用、优化使用策略

## 文件清单

### 修改的文件
1. `src/static/index.html` - 添加明细查询UI
2. `src/static/app.js` - 新增明细查询逻辑和卡片重设计
3. `src/static/style.css` - 多值卡片和明细查询样式
4. `src/sources/stats.ts` - 新增明细查询函数
5. `src/server.ts` - 新增明细查询API端点

### 新增功能
- 模型访问明细查询（全新功能）
- 多值信息卡片组件
- 紧凑价格格式化

## API接口

### GET /api/stats/detail
查询模型访问明细

**参数**
- `from` - 起始时间戳（毫秒）
- `to` - 结束时间戳（毫秒）
- `agent` - Agent ID（可选）
- `limit` - 返回记录数（默认100）

**返回**
```json
[
  {
    "ts": 1718467199999,
    "agent_aid": "agent.123",
    "peer_key": "peer.456",
    "model": "claude-opus-4",
    "input_tokens": 1500,
    "output_tokens": 800,
    "cache_creation_tokens": 200,
    "cache_read_tokens": 500,
    "cost_official_usd": 0.045,
    "cost_official_cny": 0.32,
    "cost_gateway_usd": 0.040,
    "cost_gateway_cny": 0.28
  }
]
```

## 下一步优化建议

1. **导出功能** - 支持导出明细数据为CSV/Excel
2. **分页** - 大量数据时支持分页加载
3. **图表展示** - 明细数据可视化图表
4. **实时更新** - WebSocket推送新的模型调用记录
5. **成本预警** - 设置阈值，超出时提醒

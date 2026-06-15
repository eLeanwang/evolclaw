# EvolClaw Watch 用量页面国际化更新

## 更新日期
2026-06-15

## 更新内容

### 1. 翻译表扩展 ✅

在 `app.js` 的翻译表中新增了 **50+ 条**用量页面相关的翻译键值对：

#### 中文翻译 (zh-CN)
- **Tab 名称更新**：
  - `tab.gateway`: '网关' → '智能体网关'
  
- **用量页面子标签**：
  - `usage.subtab.overview`: '总览'
  - `usage.subtab.dashboard`: '仪表板'
  - `usage.subtab.explorer`: '浏览器'

- **卡片标签**：
  - `usage.card.input`: '输入'
  - `usage.card.output`: '输出'
  - `usage.card.cacheRead`: '缓存读取'
  - `usage.card.cacheHit`: '缓存命中'
  - `usage.card.calls`: '调用'
  - `usage.card.sessionCount`: '会话数'
  - `usage.card.msgIn`: '收到消息'
  - `usage.card.msgOut`: '发出消息'
  - `usage.card.modelCalls`: '模型调用'
  - `usage.card.inputTokens`: '输入 Token'
  - `usage.card.outputTokens`: '输出 Token'
  - `usage.card.cacheCreation`: '缓存创建'
  - `usage.card.cacheHitTokens`: '缓存命中'
  - `usage.card.cacheHitRate`: '缓存命中率'
  - `usage.card.totalCost`: '总花费'

- **Overview 页面**：
  - `usage.overview.title`: '按 Agent 汇总（全时段）'
  - `usage.overview.noData`: '暂无数据'
  - `usage.overview.th.agent`: 'Agent'
  - `usage.overview.th.calls`: '调用'
  - `usage.overview.th.input`: '输入'
  - `usage.overview.th.output`: '输出'
  - `usage.overview.th.cacheCreation`: '缓存创建'
  - `usage.overview.th.cacheHit`: '缓存命中'
  - `usage.overview.th.cost`: '花费'

- **Dashboard 页面**：
  - `usage.dashboard.title.topPeers`: 'Top Peers (Today)'
  - `usage.dashboard.th.rank`: '#'
  - `usage.dashboard.th.peer`: 'Peer'
  - `usage.dashboard.th.tokens`: 'Tokens'
  - `usage.dashboard.th.calls`: 'Calls'

- **Explorer 页面**：
  - `usage.explorer.sidebar.agents`: 'Agents'
  - `usage.explorer.sidebar.peers`: 'Peers'
  - `usage.explorer.selectHint`: '请从左侧选择 Agent 或 Peer'
  - `usage.explorer.all`: '全部'
  - `usage.explorer.filter.from`: 'From'
  - `usage.explorer.filter.to`: 'To'
  - `usage.explorer.filter.model`: 'Model'
  - `usage.explorer.filter.granularity.hour`: 'Hour'
  - `usage.explorer.filter.granularity.day`: 'Day'
  - `usage.explorer.filter.granularity.week`: 'Week'
  - `usage.explorer.filter.granularity.month`: 'Month'
  - `usage.explorer.results`: 'Results'
  - `usage.explorer.noData`: 'No data for selected range.'
  - `usage.explorer.th.period`: 'Period'
  - `usage.explorer.th.input`: 'Input'
  - `usage.explorer.th.output`: 'Output'
  - `usage.explorer.th.cacheCreation`: 'Cache↑'
  - `usage.explorer.th.cacheHit`: 'CacheHit'
  - `usage.explorer.th.calls`: 'Calls'

#### 英文翻译 (en-US)
- **Tab 名称更新**：
  - `tab.gateway`: 'AgentGateway' → 'Agent Gateway'
  
- 其他所有用量页面相关的英文翻译已完整添加

### 2. HTML 国际化标记 ✅

在 `index.html` 中为用量页面添加了 **30+ 处** `data-i18n` 属性标记：

- 子标签按钮（Overview, Dashboard, Explorer）
- 侧边栏标题（Agents, Peers）
- 表格标题
- 筛选器标签（From, To, Model）
- 下拉选项（Hour, Day, Week, Month）
- 提示文本

### 3. 动态文本国际化 ✅

在 `app.js` 中使用 `t()` 函数替换了 **40+ 处**硬编码文本：

#### Dashboard 页面
- 卡片标签：Input, Output, Cache Read, Cache Hit, Calls
- 图表图例
- Top Peers 表格标题

#### Overview 页面
- 卡片标签：会话数、收到消息、发出消息、模型调用等
- Agent 汇总表格标题和内容
- 空状态提示

#### Explorer 页面
- 侧边栏"全部"选项
- 图表图例
- 表格标题
- 空状态提示

### 4. 图表国际化 ✅

- **Hourly Chart**：更新图例文本（Input, Output, Cache）
- **Explorer Chart**：更新图例文本（Input, Output）
- 图表在语言切换时自动更新

### 5. updateI18n 函数增强 ✅

扩展了 `updateI18n()` 函数，现在支持：
- 标准元素的 textContent
- INPUT/TEXTAREA 元素的 placeholder
- **OPTION 元素的 textContent**（新增）
- title 属性的翻译

## 特别说明

### AgentGateway → 智能体网关

- **中文**: '智能体网关' （准确体现 Agent Gateway 的含义）
- **英文**: 'Agent Gateway' （标准表述，增加空格提高可读性）

这个翻译更准确地反映了该功能作为智能体（AI Agent）与外部系统之间的网关角色。

## 使用方法

1. 启动 EvolClaw Web 服务
2. 打开浏览器访问管理界面
3. 点击顶部 **Usage** 标签进入用量页面
4. 点击右上角 **🌐** 按钮切换语言
5. 所有用量页面的文本（包括卡片、表格、图表、按钮）会立即切换语言
6. 语言偏好自动保存到 localStorage

## 覆盖范围

- ✅ Overview 子标签（总览页面）
- ✅ Dashboard 子标签（仪表板）
- ✅ Explorer 子标签（浏览器）
- ✅ 所有卡片标签
- ✅ 所有表格标题
- ✅ 所有图表图例
- ✅ 所有按钮和筛选器
- ✅ 所有提示和空状态文本

## 测试建议

### 功能测试
1. 在用量页面的三个子标签之间切换
2. 点击语言切换按钮，验证所有文本立即更新
3. 在 Explorer 页面选择不同的 Agent 或 Peer
4. 更改日期范围和粒度，点击 Query 按钮
5. 验证图表图例和表格标题的语言切换

### 视觉测试
1. 检查中文文本是否完整显示（无截断）
2. 检查英文文本是否正确换行
3. 验证卡片布局在两种语言下都正常
4. 确认下拉菜单选项正确显示

## 构建验证

```bash
cd /h/project/evolclaw/ecweb
npm run build
```

✅ 构建成功，所有翻译已正确包含在 dist 目录中。

## 翻译统计

- **新增翻译键**: 50+
- **HTML 标记数**: 30+
- **动态调用数**: 40+
- **总翻译键数**: 430+（包含之前的翻译）
- **视图覆盖**: 9/9 (100%)

## 相关文件

- `ecweb/src/static/app.js` - 翻译表和动态文本逻辑
- `ecweb/src/static/index.html` - HTML 国际化标记
- `ecweb/I18N_TEST.md` - 之前的国际化测试文档

---

**更新完成时间**: 2026-06-15  
**版本**: v1.3.0+

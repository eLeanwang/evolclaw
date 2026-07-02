# EvolClaw Web 视图架构梳理

## 修复记录

### 2026-06-25: 修复 `renderRoleAssignments` 未定义错误

**问题**: 在 `app.js:952` 调用了不存在的 `renderRoleAssignments` 函数
**原因**: 函数命名不一致，实际定义的函数名是 `renderRoles`
**修复**: 将 `app.js:952` 的调用改为 `renderRoles(state.roles)`

### 2026-06-25: 优化角色分配页面

**改进内容**:
1. **智能体列表数据源优化**
   - 角色分配页面的智能体选择器现在与智能体 tab 使用一致的数据源
   - 自动合并 `state.agents` 和 `state.roles.agents` 的数据
   - 优先显示 `displayName`，并自动添加 `shortAid` 作为标识

2. **对端关系筛选**
   - 选择智能体后，只显示该智能体的对端关系
   - 未选择智能体时，显示所有关系
   - 新增 `renderAgentPeerRelations()` 函数专门处理对端关系渲染

3. **表格结构优化**
   - 调整表头顺序：Peer Key → Channel → Effective Role → Source → Actions
   - 所有表头支持国际化
   - 添加空状态提示：选中智能体无对端关系时显示友好提示

4. **新增函数**
   - `renderAgentPeerRelations(data, aid)`: 渲染指定智能体的对端关系
   - `renderRelationsTable(data, filterAid)`: 支持按智能体过滤的关系表格渲染

---

## 视图系统架构

### 核心组件

#### 1. 状态管理 (app.js:813)
```javascript
const state = {
  agents: null,
  msg: null,
  session: null,
  cache: null,
  system: null,
  triggers: null,
  monitor: null,
  gateway: null,
  roles: null,
  roleDefinitions: null
};
```

#### 2. 视图切换流程

**switchView()** (app.js:916-933)
- 切换 tab 高亮状态
- 根据视图类型订阅对应的 WebSocket 数据
- 如果状态已存在，立即渲染视图

**renderView()** (app.js:941-953)
- 统一的视图渲染入口
- 根据当前视图名称调用对应的渲染函数

#### 3. 视图与渲染函数映射

| 视图名称 | 订阅参数 | 渲染函数 | 定义位置 |
|---------|---------|---------|---------|
| `agents` | `{}` | `renderAgents()` | app.js:1210 |
| `msg` | `{aid, peer}` | `renderMsg()` | app.js:1454 |
| `session` | `{sessionId, project}` | `renderSession()` | app.js:1520 |
| `cache` | `{}` | `renderCache()` | app.js:1355 |
| `system` | `{}` | `renderSystem()` | app.js:2060 |
| `triggers` | `{agent}` | `renderTriggers()` | app.js:2440 |
| `monitor` | `{range}` | `renderMonitor()` | app.js:3586 |
| `gateway` | `{}` | `renderGateway()` | app.js:2192 |
| `roleDefinitions` | `{}` | `renderRoleDefinitions()` | app.js:4023 |
| `roles` | `{}` | `renderRoles()` | app.js:3810 |

### 4. WebSocket 消息流

#### 连接建立 (app.js:821-831)
```
客户端 → 服务器: WebSocket 连接 + token
服务器 → 客户端: onopen 事件
客户端 → 服务器: subscribe 消息（包含视图名和参数）
```

#### 数据更新 (app.js:833-860)
```
服务器 → 客户端: snapshot/delta 消息
客户端: 更新 state[view]
客户端: 如果是当前视图，调用 renderView()
```

#### 写操作 (app.js:886-899)
```
客户端 → 服务器: menu 消息（带 requestId）
客户端: 将 Promise 存入 _menuPending[requestId]
服务器 → 客户端: menu.response 消息
客户端: 根据 requestId 解析对应的 Promise
```

### 5. 角色系统

#### roles 视图 (角色分配)
- **渲染函数**: `renderRoles()` (app.js:3810)
- **功能**:
  - 填充智能体选择器
  - 显示选中智能体的角色配置 (owners/admins/members)
  - 渲染关系表格
- **辅助函数**:
  - `renderAgentRoles()` (app.js:3850): 渲染单个智能体的角色列表
  - `renderRelationsTable()` (app.js:3880): 渲染关系表格

#### roleDefinitions 视图 (角色定义)
- **渲染函数**: `renderRoleDefinitions()` (app.js:4023)
- **功能**:
  - 显示系统内置的角色定义 (owner/admin/member/guest/anonymous)
  - 编辑和重置角色权限
  - 配置权限模式、模型、分发模式等

---

## 视图扩展指南

### 添加新视图的步骤

1. **在 state 对象中添加字段** (app.js:813)
   ```javascript
   const state = {
     // ...
     newView: null
   };
   ```

2. **在 switchView() 中添加订阅逻辑** (app.js:916-933)
   ```javascript
   else if (view === 'newView') subscribe('newView', { /* params */ });
   ```

3. **在 renderView() 中添加渲染调用** (app.js:941-953)
   ```javascript
   else if (view === 'newView') renderNewView(state.newView);
   ```

4. **实现渲染函数**
   ```javascript
   function renderNewView(data) {
     if (!data) return;
     // 渲染逻辑
   }
   ```

5. **添加对应的 HTML 视图容器**
   ```html
   <div id="view-newView" class="view">
     <!-- 视图内容 -->
   </div>
   ```

6. **添加 Tab 导航**
   ```html
   <div class="tab" data-view="newView" data-i18n="tab.newView">新视图</div>
   ```

7. **添加国际化文本** (app.js:11-22)
   ```javascript
   translations['zh-CN']['tab.newView'] = '新视图';
   translations['en']['tab.newView'] = 'New View';
   ```

---

## 常见问题

### Q: 为什么切换视图时没有数据？
A: 检查以下几点：
1. state 对象中是否添加了对应字段
2. switchView() 中是否正确调用 subscribe()
3. 服务器端是否实现了对应的数据推送
4. 浏览器控制台是否有 WebSocket 消息

### Q: 如何调试视图渲染？
A: 
1. 打开浏览器控制台
2. 查看 `[WS]` 和 `[renderView]` 日志
3. 检查 `state` 对象的内容：在控制台输入 `state`

### Q: 渲染函数命名规范？
A: 
- 主渲染函数：`render<ViewName>()` (驼峰命名，首字母大写)
- 辅助渲染函数：`render<Component>()` 
- 例如：`renderRoles()`, `renderAgentRoles()`, `renderRelationsTable()`

---

## 技术栈

- **前端**: 原生 JavaScript (ES6+)
- **通信**: WebSocket
- **UI**: HTML + CSS (自定义样式)
- **国际化**: 内置 i18n 系统
- **状态管理**: 简单的全局 state 对象

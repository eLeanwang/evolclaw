# 角色管理功能实施指南

## ✅ 已完成的工作

### 1. 后端实现

#### 新增文件
- **`ecweb/src/sources/roles.ts`** - Roles 数据源
  - `rolesSource` - WebSocket 数据推送（2秒轮询）
  - `handleRolesApi` - HTTP API 处理器
  - 集成 evolclaw 的 `ConfigManager` 和 `RoleResolver`

#### 修改文件
- **`ecweb/src/server.ts`**
  - 导入 `rolesSource` 和 `handleRolesApi`
  - 注册 roles 到 SOURCES 对象
  - 添加 `/api/roles/` 路由处理

- **`ecweb/src/sources/types.ts`**
  - 添加 `'roles'` 到 `ViewKind` 类型

### 2. 前端实现

#### HTML (ecweb/src/static/index.html)
- 添加 "Roles" Tab 按钮
- 新增 `#view-roles` section，包含：
  - Agent 选择器
  - 三列角色管理区域（Owners / Admins / Members）
  - 关系列表表格

#### JavaScript (ecweb/src/static/app.js)
- 添加 `state.roles` 状态管理
- 新增 `renderRoles()` 函数
- 新增 `renderAgentRoles()` - 渲染角色列表
- 新增 `renderRelationsTable()` - 渲染关系表格
- 新增 `updateAgentRoles()` - API 调用
- 新增 `initRolesTab()` - 事件初始化
- 集成到 `renderView()` 和 `DOMContentLoaded`

#### CSS (ecweb/src/static/style.css)
- 完整的 Roles Tab 样式
- 响应式三列布局
- 角色徽章样式（5种角色）
- 深色主题适配

---

## 🎯 功能特性

### 1. Agent 角色管理
- ✅ 选择任意 Agent
- ✅ 查看 owners / admins / members 列表
- ✅ 添加用户到角色（AID 格式验证）
- ✅ 移除用户角色（带确认对话框）
- ✅ 实时更新（WebSocket 推送）

### 2. 关系列表浏览
- ✅ 列出所有 Agent-Peer 关系
- ✅ 显示有效角色（经过 RoleResolver 解析）
- ✅ 显示角色来源（agent 配置 or relation 覆盖）
- ✅ 实时更新

### 3. 权限和验证
- ✅ JWT Token 鉴权（与其他 Tab 一致）
- ✅ AID 格式验证（`username.aid.pub` or `username.agentid.pub`）
- ✅ 防止重复添加
- ✅ 最后 owner 保护（由 evolclaw 主项目的 role-constraints 提供）

---

## 🚀 使用方法

### 启动服务

```bash
# 1. 构建 ecweb（已完成）
cd ecweb
npm run build

# 2. 启动 evolclaw 主进程
cd ..
npm run build  # 如果主项目有更新
ec daemon start

# 3. 启动 ecweb
ec daemon web

# 4. 浏览器访问
# 本地: http://localhost:42705
# 输入配对码（终端会显示）
```

### 使用 Roles Tab

1. **选择 Agent**
   - 点击 "Roles" Tab
   - 从下拉菜单选择一个 Agent

2. **添加角色**
   - 点击 "+ Add Owner/Admin/Member" 按钮
   - 输入 AID（格式：`alice.aid.pub` 或 `bob.agentid.pub`）
   - 点击确定

3. **移除角色**
   - 点击用户右侧的 "×" 按钮
   - 确认删除

4. **查看关系**
   - 滚动到页面下方查看 "Relations" 表格
   - 表格显示所有关系及其有效角色

---

## 📊 数据流架构

```
┌─────────────────────────────────────┐
│  Browser                            │
│  - 选择 Agent                        │
│  - 添加/删除角色                      │
│  - 查看关系列表                       │
└──────────────┬──────────────────────┘
               │ WebSocket (实时推送)
               │ HTTP POST (修改角色)
┌──────────────▼──────────────────────┐
│  ecweb/server.ts                    │
│  - rolesSource (WebSocket)          │
│  - handleRolesApi (HTTP)            │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│  ecweb/sources/roles.ts             │
│  - buildSnapshot()                  │
│  - 2秒轮询 + JSON diff              │
└──────────────┬──────────────────────┘
               │ 导入
┌──────────────▼──────────────────────┐
│  evolclaw/src/config/               │
│  - ConfigManager.read/write()       │
│  - RoleResolver.resolveUserRole()   │
└──────────────┬──────────────────────┘
               │ 读写
┌──────────────▼──────────────────────┐
│  agents/{aid}/config.json           │
│  agents/{aid}/relations/{peer}/...  │
└─────────────────────────────────────┘
```

---

## 🔑 技术实现细节

### 1. 配置管理集成

```typescript
// ecweb/sources/roles.ts
async function getConfigManager() {
  const parentPath = path.join(process.cwd(), 'dist', 'config', 'config-manager.js');
  const mod = await import(parentPath);
  return { read: mod.read, write: mod.write, ConfigTarget: mod.ConfigTarget };
}

// 读取角色配置
const config = read(ConfigTarget.Agent, { self: aid });
// → { owners: [...], admins: [...], members: [...] }

// 写入角色配置
write(ConfigTarget.Agent, { self: aid }, { ...config, owners: newOwners });
```

### 2. 角色解析

```typescript
// 使用 RoleResolver 解析有效角色
const role = resolveUserRole('myagent.aid.pub', 'feishu#ou_xxx');
// → 'owner' | 'admin' | 'member' | 'guest' | 'anonymous'

// 优先级：
// 1. relation/config.json 的 role 字段（如果存在）
// 2. agent/config.json 的 owners/admins/members
// 3. guest（已认证但未授权）
// 4. anonymous（未认证）
```

### 3. 实时更新

```typescript
// WebSocket Source 模式
export const rolesSource: WatchSource = {
  kind: 'roles',
  
  async snapshot(): Promise<RolesSnapshot> {
    return buildSnapshot();
  },
  
  subscribe(_params, push): () => void {
    const timer = setInterval(async () => {
      const snap = await buildSnapshot();
      const json = JSON.stringify(snap);
      if (json !== lastJson) {
        lastJson = json;
        push(snap);  // 仅在变化时推送
      }
    }, 2000);
    
    return () => clearInterval(timer);
  }
};
```

### 4. HTTP API

```typescript
// GET /api/roles/agent/{aid}
// 响应：{ owners: string[], admins: string[], members: string[] }

// POST /api/roles/agent/{aid}
// 请求体：{ field: 'owners'|'admins'|'members', users: string[] }
// 响应：{ ok: true } 或 { error: string }
```

---

## 🧪 测试场景

### 场景 1: 基本角色管理

```bash
# 1. 创建测试 Agent
ec agent create test.aid.pub

# 2. 在 Roles Tab 中：
#    - 选择 test.aid.pub
#    - 添加 alice.aid.pub 为 owner
#    - 添加 bob.aid.pub 为 admin
#    - 添加 charlie.aid.pub 为 member

# 3. 验证配置文件
cat agents/test.aid.pub/config.json
# 应该显示：
# {
#   "owners": ["alice.aid.pub"],
#   "admins": ["bob.aid.pub"],
#   "members": ["charlie.aid.pub"]
# }
```

### 场景 2: AID 格式验证

```bash
# 尝试添加无效格式
# ❌ "alice" → 拒绝
# ❌ "alice@example.com" → 拒绝
# ❌ "alice.aid" → 拒绝
# ✅ "alice.aid.pub" → 接受
# ✅ "alice.agentid.pub" → 接受
```

### 场景 3: 实时更新

```bash
# 1. 打开两个浏览器窗口，都在 Roles Tab
# 2. 在窗口 A 添加一个 owner
# 3. 观察窗口 B 应该在 2 秒内自动更新
```

### 场景 4: 关系列表

```bash
# 1. 创建一些关系
ec agent link test.aid.pub feishu#ou_123

# 2. 在关系配置中设置角色覆盖
# agents/test.aid.pub/relations/feishu#ou_123/config.json
# { "role": "admin" }

# 3. 在 Roles Tab 的 Relations 表格中应该看到：
#    - self: test.aid.pub
#    - peerKey: feishu#ou_123
#    - role: admin
#    - source: relation
```

---

## 🐛 调试技巧

### 1. 检查后端日志

```bash
# ecweb 进程日志
cat data/instance/ecweb-*.jsonl

# 查找 roles 相关日志
grep "roles" data/instance/ecweb-*.jsonl
```

### 2. 浏览器控制台

```javascript
// 查看当前 roles 状态
console.log(state.roles);

// 手动触发渲染
renderRoles(state.roles);

// 测试 API
fetch('/api/roles/agent/test.aid.pub', {
  headers: { 'Authorization': `Bearer ${localStorage.getItem('ecWatchToken')}` }
}).then(r => r.json()).then(console.log);
```

### 3. WebSocket 消息

```javascript
// 在浏览器控制台监听所有 WS 消息
const origOnMessage = ws.onmessage;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.view === 'roles') {
    console.log('Roles update:', msg);
  }
  origOnMessage(ev);
};
```

---

## 📝 已知限制

1. **关系级别角色编辑**
   - 当前版本仅支持查看关系角色
   - 不支持直接在 UI 中编辑 relation/config.json
   - 需要手动编辑配置文件或通过 CLI

2. **批量操作**
   - 每次只能添加/删除一个用户
   - 未来可以添加批量导入功能

3. **权限校验**
   - UI 不阻止删除最后一个 owner
   - 依赖后端的 role-constraints 保护

---

## 🔮 未来扩展

### 建议的增强功能

1. **关系角色编辑**
   ```
   - 在关系表格中添加"编辑"按钮
   - 允许设置 relation 级别的角色覆盖
   ```

2. **角色权限预览**
   ```
   - 展开显示每个角色的权限详情
   - permissionMode, allowedModels, dispatch 等
   ```

3. **批量操作**
   ```
   - 从 CSV 导入用户列表
   - 批量移动用户到其他角色
   ```

4. **审计日志**
   ```
   - 记录所有角色变更操作
   - 显示操作人和时间戳
   ```

5. **搜索和筛选**
   ```
   - 搜索用户 AID
   - 按角色筛选关系列表
   ```

---

## ✅ 验收清单

- [x] Roles Tab 出现在导航栏
- [x] 可以选择 Agent
- [x] 可以查看 owners/admins/members
- [x] 可以添加用户（有 AID 格式验证）
- [x] 可以删除用户（有确认对话框）
- [x] 关系列表显示所有关系
- [x] 角色徽章正确显示（5种颜色）
- [x] 实时更新（2秒内）
- [x] 深色主题适配
- [x] Token 鉴权生效
- [x] 错误提示友好

---

## 📚 相关文档

- [角色系统设计](../config/config-roles-layer-design.md)
- [ConfigManager 文档](../config/01-overview.md)
- [RoleResolver 实现](../../src/config/role-resolver.ts)
- [原始需求文档](./ROLE-MANAGEMENT-IMPLEMENTATION.md)

---

**实施完成时间**: 2026-06-24
**开发者**: Claude + User
**状态**: ✅ 完成并可用

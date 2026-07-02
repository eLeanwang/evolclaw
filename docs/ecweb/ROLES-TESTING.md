# 角色管理功能 - 测试说明

## ✅ 已完成的修复

### 1. 国际化支持
- ✅ "Select Agent:" → 中文 "选择智能体:" / 英文 "Select Agent:"
- ✅ "-- Select an Agent --" → 中文 "-- 请选择智能体 --" / 英文保持原样
- ✅ 所有 roles 相关的文本都支持中英文切换

### 2. Agent 列表填充
- ✅ 修复了 renderRoles 函数，确保正确填充选项
- ✅ 保留国际化属性（data-i18n）
- ✅ 动态更新占位符文本

---

## 🧪 测试步骤

### 1. 创建测试 Agent（已完成）

```bash
# 已创建测试 agent: demo.aid.pub
cat .evolclaw/agents/demo.aid.pub/config.json
```

输出：
```json
{
  "owners": ["alice.aid.pub", "admin.aid.pub"],
  "admins": ["bob.aid.pub"],
  "members": ["charlie.aid.pub", "david.aid.pub"]
}
```

### 2. 重启 ecweb

```bash
# 停止当前 ecweb
ec daemon stop web

# 或者找到进程并杀掉
ps aux | grep ecweb
kill <PID>

# 重新启动
ec daemon web

# 或者完全重启
ec daemon restart
```

### 3. 浏览器测试

1. **打开页面**: http://localhost:42705
2. **输入配对码**（终端会显示）
3. **点击 "角色" Tab**
4. **检查 Agent 选择器**:
   - 应该显示 "选择智能体:" 或 "Select Agent:"（取决于语言设置）
   - 下拉列表中应该有 `demo.aid.pub` 选项
5. **选择 demo.aid.pub**
6. **查看角色列表**:
   - Owners: alice.aid.pub, admin.aid.pub
   - Admins: bob.aid.pub
   - Members: charlie.aid.pub, david.aid.pub

### 4. 测试语言切换

1. 点击右上角 🌐 按钮
2. 语言切换为英文（或中文）
3. 检查所有文本是否正确切换

---

## 🔍 调试检查

### 在浏览器控制台执行：

```javascript
// 1. 查看 roles 数据
console.log('Roles data:', state.roles);

// 应该看到：
// {
//   agents: [
//     {
//       aid: "demo.aid.pub",
//       owners: ["alice.aid.pub", "admin.aid.pub"],
//       admins: ["bob.aid.pub"],
//       members: ["charlie.aid.pub", "david.aid.pub"]
//     }
//   ],
//   relations: []
// }

// 2. 检查 select 元素
const select = document.querySelector('#roles-agent-select');
console.log('Select options:', Array.from(select.options).map(o => o.value));

// 应该看到：
// ["", "demo.aid.pub"]

// 3. 手动触发渲染
renderRoles(state.roles);

// 4. 检查国际化函数
console.log(t('roles.selectAgent'));
// 中文: "选择智能体:"
// 英文: "Select Agent:"
```

---

## 📊 预期结果

### Agent 下拉列表
```
+---------------------------+
| 选择智能体:                |
| +------------------------+|
| |-- 请选择智能体 --      ▼||
| +------------------------+|
| | demo.aid.pub          ||
| +------------------------+|
+---------------------------+
```

### 选择 demo.aid.pub 后
```
+---------------------------------------------------------------------+
| 👑 所有者                | 🛡️ 管理员            | 👥 成员              |
|--------------------------|---------------------|---------------------|
| alice.aid.pub       [×] | bob.aid.pub    [×] | charlie.aid.pub [×] |
| admin.aid.pub       [×] |                     | david.aid.pub   [×] |
|                          |                     |                     |
| [+ 添加所有者]           | [+ 添加管理员]      | [+ 添加成员]         |
+---------------------------------------------------------------------+

🔗 关系列表
+----------+-----------+------+--------+
| Agent    | Peer      | Role | Source |
+----------+-----------+------+--------+
| (暂无数据)                            |
+----------+-----------+------+--------+
```

---

## ❓ 如果还是看不到 Agent

### 检查 ecweb 日志

```bash
# 实时查看日志
tail -f data/instance/ecweb-*.jsonl | grep roles

# 应该看到类似：
# [roles] Looking for agents in: /path/to/.evolclaw/agents
# [roles] Found agent directories: 1
# [roles] Snapshot built: 1 agents, 0 relations
```

### 检查 WebSocket 连接

浏览器控制台应该显示：
```
[roles] Looking for agents in: H:\project\evolclaw\.evolclaw\agents
[roles] Found agent directories: 1
[roles] Snapshot built: 1 agents, 0 relations
```

如果没有看到这些日志，说明：
1. WebSocket 连接有问题
2. roles 数据源没有启动
3. 路径解析错误

### 手动订阅

在浏览器控制台执行：
```javascript
// 强制订阅 roles
ws.send(JSON.stringify({ type: 'subscribe', view: 'roles' }));

// 等待 2-3 秒
setTimeout(() => {
  console.log('Roles state:', state.roles);
}, 3000);
```

---

## 🎯 完整测试流程

```bash
# 1. 确认构建完成
ls -lh ecweb/dist/static/app.js ecweb/dist/sources/roles.js

# 2. 确认测试数据存在
cat .evolclaw/agents/demo.aid.pub/config.json

# 3. 重启服务
ec daemon restart

# 4. 查看日志
tail -f data/instance/ecweb-*.jsonl &

# 5. 打开浏览器
# http://localhost:42705

# 6. 输入配对码

# 7. 点击 "角色" Tab

# 8. 检查 Agent 列表是否有 demo.aid.pub

# 9. 选择并查看角色列表
```

---

## 📝 功能验证清单

- [ ] Roles Tab 显示正确（"角色" 或 "Roles"）
- [ ] "选择智能体" 标签显示正确
- [ ] Agent 下拉列表有选项（demo.aid.pub）
- [ ] 选择 Agent 后显示角色列表
- [ ] Owners 列显示 2 个用户
- [ ] Admins 列显示 1 个用户
- [ ] Members 列显示 2 个用户
- [ ] 语言切换正常工作
- [ ] 可以点击 "+" 按钮添加用户
- [ ] 可以点击 "×" 按钮删除用户
- [ ] 关系列表显示（即使为空也有表头）

---

**测试 Agent 已创建**: `demo.aid.pub`  
**下一步**: 重启 ecweb 并在浏览器中测试

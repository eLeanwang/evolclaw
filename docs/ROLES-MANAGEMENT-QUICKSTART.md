# 角色管理功能 - 快速入门

## 🚀 5 分钟上手

### 1. 启动服务

```bash
# 确保 evolclaw 已构建（已完成）
cd H:/project/evolclaw

# 启动 daemon
ec start

# 启动 ecweb
ec ecweb
```

### 2. 访问界面

1. 浏览器打开：`http://localhost:42705`
2. 输入终端显示的 6 位配对码
3. 点击顶部导航 **"Roles"** Tab

### 3. 管理角色

#### 添加用户到角色

```
1. 从下拉列表选择一个 Agent
2. 在 Owners/Admins/Members 列中点击 "+ Add"
3. 输入 User ID（格式：xxx.aid.pub）
4. 点击"添加"
```

#### 移除用户

```
1. 在用户列表中找到目标用户
2. 点击 "Remove" 按钮
3. 确认删除
```

#### 查看关系

```
- 关系列表自动显示该 Agent 的所有对端
- 每行显示：peerKey、Channel、Role、Source
- 使用搜索框过滤关系
```

---

## 🔑 核心概念

### 角色层级（由高到低）

1. **Owner** 👑
   - 完全控制权限
   - 可以修改所有配置
   - 至少保留 1 个（不能删除最后一个）

2. **Admin** 🛡️
   - 管理员权限
   - 需要确认敏感操作
   - 可使用主流模型

3. **Member** 👥
   - 基本使用权限
   - 智能判断模式
   - 中低成本模型

4. **Guest** 👤
   - 访客权限（有 AID 但未授权）
   - 只读模式
   - 最低成本模型

5. **Anonymous** 🚫
   - 匿名用户（无 AID）
   - 极度受限

### 角色来源

- **Agent 配置**：在 `agents/{aid}/config.json` 中的 owners/admins/members
- **Relation 配置**：在 `agents/{aid}/relations/{peerKey}/config.json` 中的 role 字段（覆盖 agent 配置）

### User ID 格式

必须是 **AID 格式**：
- 标准：`username.aid.pub` 或 `username.agentid.pub`
- 例如：`alice.aid.pub`、`bob.agentid.pub`

---

## 📋 测试清单

- [ ] Agent 下拉列表加载正常
- [ ] 选择 Agent 后显示三列角色
- [ ] 添加 Owner 成功
- [ ] 添加 Admin 成功  
- [ ] 添加 Member 成功
- [ ] 移除 Member 成功
- [ ] 移除 Admin 成功
- [ ] 删除最后一个 Owner 被阻止
- [ ] 关系列表显示正常
- [ ] 搜索过滤工作正常
- [ ] 配置文件正确更新（查看 `.agents/<aid>/config.json`）

---

## 🛠️ 故障排查

### ecweb 无法启动

```bash
# 检查端口占用
netstat -ano | grep 42705

# 强制重启
pkill ecweb
ec ecweb
```

### Roles Tab 显示空白

```bash
# 检查 daemon 状态
ec status

# 重启 daemon
ec restart
```

### 添加用户失败

1. 检查 User ID 格式（必须是 xxx.aid.pub）
2. 检查配置文件权限
3. 查看 daemon 日志：`tail -f ~/.evolclaw/logs/daemon.log`

### IPC 命令测试

```bash
# 测试 roles.get-agent
ec ipc '{"type":"roles.get-agent","self":"<your-agent-id>"}'

# 测试 roles.list-relations
ec ipc '{"type":"roles.list-relations","self":"<your-agent-id>"}'
```

---

## 📂 相关文件

```
evolclaw/
├── src/ipc.ts                     ← IPC 命令实现
├── src/config/
│   ├── config-manager.ts          ← 配置读写
│   ├── role-resolver.ts           ← 角色解析
│   └── roles.ts                   ← 角色定义
├── ecweb/dist/static/
│   ├── index.html                 ← Roles Tab UI
│   ├── style.css                  ← 样式
│   └── app.js                     ← 交互逻辑
└── .agents/
    └── <agent-id>/
        ├── config.json            ← 角色配置存储
        └── relations/
            └── <peer-key>/
                └── config.json    ← 关系级角色
```

---

## 🎯 完成！

现在你可以通过 ecweb 的 Web 界面轻松管理所有 Agent 的角色配置了！

**问题反馈**: 如遇问题，查看完整报告 `docs/ROLES-MANAGEMENT-IMPLEMENTATION-REPORT.md`

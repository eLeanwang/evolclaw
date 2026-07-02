# 角色管理功能 - 快速修复指南

## ✅ 已修复的问题

### 1. 国际化翻译缺失
**问题**: Tab 显示 `tab.roles` 而不是 "角色" / "Roles"

**修复**: 
- ✅ 添加中文翻译: `'tab.roles': '角色'`
- ✅ 添加英文翻译: `'tab.roles': 'Roles'`

### 2. Agent 列表为空
**可能原因**: 
- agents 目录路径可能不正确
- ConfigManager 导入失败

**修复**: 
- ✅ 修正路径逻辑（使用 `evolclawDir/agents`）
- ✅ 添加详细日志输出

---

## 🔍 如何调试

### 1. 查看 ecweb 进程日志

```bash
# 找到 ecweb 进程的日志文件
ls -lht data/instance/ecweb-*.jsonl | head -1

# 实时查看日志（包含 roles 相关信息）
tail -f data/instance/ecweb-*.jsonl | grep -E "roles|Roles"
```

### 2. 检查浏览器控制台

打开浏览器开发者工具（F12），查看：

```javascript
// 查看 roles 数据源输出
// 应该看到类似：
// [roles] Looking for agents in: /path/to/.evolclaw/agents
// [roles] Found agent directories: 3
// [roles] Snapshot built: 3 agents, 5 relations
```

### 3. 检查 WebSocket 消息

```javascript
// 在浏览器控制台执行：
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.view === 'roles') {
    console.log('Roles data:', msg.data);
  }
});

// 手动订阅 roles
ws.send(JSON.stringify({ type: 'subscribe', view: 'roles' }));
```

### 4. 测试 HTTP API

```bash
# 获取 token（从浏览器 localStorage）
TOKEN=$(node -e "console.log(require('fs').readFileSync('data/instance/ecweb-tokens.json', 'utf8'))" | jq -r '.tokens[0].token')

# 测试 API（假设有 agent: myagent.aid.pub）
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:42705/api/roles/agent/myagent.aid.pub
```

---

## 📊 预期数据结构

### WebSocket 推送数据

```json
{
  "type": "snapshot",
  "view": "roles",
  "data": {
    "agents": [
      {
        "aid": "myagent.aid.pub",
        "owners": ["alice.aid.pub"],
        "admins": ["bob.aid.pub"],
        "members": ["charlie.aid.pub"]
      }
    ],
    "relations": [
      {
        "self": "myagent.aid.pub",
        "peerKey": "feishu#ou_123",
        "role": "admin",
        "source": "agent"
      }
    ]
  }
}
```

---

## 🐛 常见问题排查

### 问题 1: Agent 列表为空

**检查步骤**:

```bash
# 1. 确认 agents 目录存在
ls -la .evolclaw/agents/

# 2. 检查是否有 agent 配置文件
find .evolclaw/agents -name "config.json"

# 3. 查看示例配置
cat .evolclaw/agents/myagent.aid.pub/config.json
```

**预期输出**:
```json
{
  "owners": ["alice.aid.pub"],
  "admins": [],
  "members": []
}
```

如果目录或文件不存在，创建测试 agent：

```bash
# 方法 1: 使用 CLI
ec agent create test.aid.pub

# 方法 2: 手动创建
mkdir -p .evolclaw/agents/test.aid.pub
echo '{"owners":["admin.aid.pub"],"admins":[],"members":[]}' > .evolclaw/agents/test.aid.pub/config.json
```

### 问题 2: ConfigManager 导入失败

**症状**: 浏览器控制台显示模块导入错误

**检查步骤**:

```bash
# 1. 确认主项目已构建
ls -la dist/config/config-manager.js

# 2. 如果文件不存在，重新构建
npm run build

# 3. 检查 ecweb 的工作目录
# ecweb 应该在 evolclaw 项目根目录下运行
pwd  # 应该显示 /path/to/evolclaw
```

### 问题 3: 权限错误

**症状**: API 返回 401 Unauthorized

**检查步骤**:

```bash
# 1. 检查 token 存储
cat data/instance/ecweb-tokens.json

# 2. 确认浏览器中有 token
# 打开浏览器控制台：
localStorage.getItem('ecWatchToken')

# 3. 重新配对
# 在浏览器中点击"退出"，重新输入配对码
```

### 问题 4: 数据不更新

**症状**: 修改了配置文件但 UI 不更新

**原因**: WebSocket 轮询间隔为 2 秒

**解决方案**:
- 等待 2-3 秒
- 或者刷新页面（F5）
- 或者切换到其他 Tab 再切回来

---

## 🧪 快速测试脚本

```bash
#!/bin/bash
# 测试脚本：test-roles.sh

set -e

echo "=== 测试角色管理功能 ==="

# 1. 创建测试 agent
echo "1. 创建测试 agent..."
mkdir -p .evolclaw/agents/test.aid.pub
cat > .evolclaw/agents/test.aid.pub/config.json <<EOF
{
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub"],
  "members": ["charlie.aid.pub", "david.aid.pub"]
}
EOF

# 2. 启动服务（如果未运行）
echo "2. 检查服务状态..."
if ! pgrep -f "ec daemon" > /dev/null; then
  echo "   启动 daemon..."
  ec daemon start
fi

if ! pgrep -f "ecweb" > /dev/null; then
  echo "   启动 ecweb..."
  ec daemon web &
  sleep 3
fi

# 3. 获取配对码
echo "3. 获取配对码..."
PAIR_CODE=$(curl -s http://localhost:42705/api/pair-code | jq -r '.code')
echo "   配对码: $PAIR_CODE"

# 4. 配对获取 token
echo "4. 配对获取 token..."
TOKEN=$(curl -s -X POST http://localhost:42705/api/pair \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$PAIR_CODE\"}" | jq -r '.token')

# 5. 测试 API
echo "5. 测试 roles API..."
curl -s -H "Authorization: Bearer $TOKEN" \
     http://localhost:42705/api/roles/agent/test.aid.pub | jq

echo ""
echo "=== 测试完成 ==="
echo "现在可以在浏览器中访问: http://localhost:42705"
echo "切换到 Roles Tab 查看 test.aid.pub 的角色配置"
```

使用方法：

```bash
chmod +x test-roles.sh
./test-roles.sh
```

---

## 📝 最终检查清单

完成以下步骤后，功能应该正常工作：

- [x] ecweb 已重新构建（`npm run build`）
- [x] 主项目已构建（`npm run build`）
- [x] 服务已启动（`ec daemon start` + `ec daemon web`）
- [ ] 浏览器访问 http://localhost:42705
- [ ] 输入配对码
- [ ] 点击 "Roles" Tab（应该显示 "角色" 或 "Roles"）
- [ ] Agent 下拉列表有选项
- [ ] 选择一个 Agent 后显示角色列表
- [ ] 可以添加/删除用户
- [ ] 关系列表显示数据

---

## 🆘 如果还是不行

1. **完全重启**:
```bash
ec daemon stop
killall node  # 确保所有 node 进程都停止
cd ecweb && npm run build
cd .. && npm run build
ec daemon start
ec daemon web
```

2. **清除浏览器缓存**:
   - Chrome: Ctrl+Shift+Delete → 清除缓存和 Cookie
   - 或者使用无痕模式（Ctrl+Shift+N）

3. **查看完整日志**:
```bash
# ecweb 日志
tail -f data/instance/ecweb-*.jsonl

# daemon 日志
tail -f data/instance/daemon.log
```

4. **联系我**: 提供以下信息
   - 浏览器控制台的错误信息
   - ecweb 进程日志中的 [roles] 相关内容
   - `.evolclaw/agents` 目录的文件列表

---

**最后更新**: 2026-06-24 18:10  
**状态**: ✅ 已修复翻译和路径问题，添加详细日志

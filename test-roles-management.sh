#!/bin/bash
# 角色管理功能快速测试脚本

set -e

echo "======================================"
echo "  角色管理功能测试"
echo "======================================"
echo ""

# 检查 evolclaw 是否在运行
echo "1. 检查 evolclaw daemon 状态..."
if ec status >/dev/null 2>&1; then
  echo "   ✅ evolclaw daemon 正在运行"
else
  echo "   ⚠️  evolclaw daemon 未运行"
  echo "   启动命令: ec start"
  exit 1
fi

echo ""
echo "2. 测试 IPC 命令..."

# 获取第一个 agent
AGENT_LIST=$(ec ipc '{"type":"evolagent.list"}' 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "   ✅ IPC 连接正常"

  # 尝试提取第一个 agent ID（简单方式）
  FIRST_AGENT=$(echo "$AGENT_LIST" | grep -o '"aid":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$FIRST_AGENT" ]; then
    echo "   测试 agent: $FIRST_AGENT"
    echo ""
    echo "3. 测试 roles.get-agent 命令..."

    ROLES_DATA=$(ec ipc "{\"type\":\"roles.get-agent\",\"self\":\"$FIRST_AGENT\"}" 2>/dev/null)
    if [ $? -eq 0 ]; then
      echo "   ✅ roles.get-agent 命令成功"
      echo "   响应: $ROLES_DATA"
    else
      echo "   ❌ roles.get-agent 命令失败"
    fi

    echo ""
    echo "4. 测试 roles.list-relations 命令..."

    RELATIONS_DATA=$(ec ipc "{\"type\":\"roles.list-relations\",\"self\":\"$FIRST_AGENT\"}" 2>/dev/null)
    if [ $? -eq 0 ]; then
      echo "   ✅ roles.list-relations 命令成功"
      echo "   响应: $RELATIONS_DATA"
    else
      echo "   ❌ roles.list-relations 命令失败"
    fi
  else
    echo "   ⚠️  没有找到可用的 agent"
  fi
else
  echo "   ❌ IPC 连接失败"
  exit 1
fi

echo ""
echo "======================================"
echo "  后端测试完成！"
echo "======================================"
echo ""
echo "接下来测试前端："
echo ""
echo "1. 启动 ecweb:"
echo "   ec ecweb"
echo ""
echo "2. 浏览器访问:"
echo "   http://localhost:42705"
echo ""
echo "3. 输入配对码登录"
echo ""
echo "4. 点击 'Roles' Tab"
echo ""
echo "5. 选择一个 Agent 并测试角色管理功能"
echo ""
echo "预期功能："
echo "  ✅ Agent 下拉列表显示所有 agents"
echo "  ✅ 显示 Owners / Admins / Members 三列"
echo "  ✅ 点击 '+ Add' 按钮添加用户"
echo "  ✅ 点击 'Remove' 按钮移除用户"
echo "  ✅ 显示对端关系列表"
echo "  ✅ 搜索框过滤关系"
echo ""

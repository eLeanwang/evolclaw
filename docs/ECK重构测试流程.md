# ECK 目录结构重构 — 测试确认流程

## 1. 编译检查

```bash
cd C:/Users/agentcp/AppData/Roaming/Evol/default/workspace/evolclaw
npx tsc --noEmit
```

预期：只有 `src/cli/bench.ts` 的两个预存错误，无其它报错。

## 2. 单元测试

```bash
npx vitest run tests/unit/eck-*.test.ts
```

预期：5 文件 31 测试全部通过。覆盖：
- atomicWriteText 原子写入
- detectEckSymlink 向上遍历检测
- resolveEckInjection 注入决策
- initEck 幂等初始化
- link-rules / unlink-rules 命令
- 新路径函数

## 3. link-rules 命令端到端

```bash
# 构建
npm run build

# 在当前伞目录下创建 symlink/junction
node dist/cli/index.js link-rules --umbrella "C:/Users/agentcp/AppData/Roaming/Evol/default/workspace"

# 确认创建成功
ls "C:/Users/agentcp/AppData/Roaming/Evol/default/workspace/.claude/rules/eck/"
# 应该看到 01-entry.md ~ 08-msg-cmd.md

# 解绑
node dist/cli/index.js unlink-rules --umbrella "C:/Users/agentcp/AppData/Roaming/Evol/default/workspace"

# 确认已删除
ls "C:/Users/agentcp/AppData/Roaming/Evol/default/workspace/.claude/rules/eck/" 2>&1
# 应该报 No such file or directory
```

## 4. ECK 初始化（启动时行为）

```bash
# 清空 eck/ 目录模拟首次启动
rm -rf ~/.evolclaw/eck/runtime.md ~/.evolclaw/eck/path-registry.md

# 启动 evolclaw（会自动初始化 ECK）
node dist/cli/index.js start
# 等几秒后 Ctrl+C 停止

# 确认文件被创建
cat ~/.evolclaw/eck/runtime.md
cat ~/.evolclaw/eck/path-registry.md
```

预期：两个文件从模板生成，包含实际路径值（`{{EVOLCLAW_HOME}}` 等占位符已替换）。

## 5. 幂等性验证

```bash
# 手动修改 runtime.md
echo "# 我的自定义内容" > ~/.evolclaw/eck/runtime.md

# 再次启动
node dist/cli/index.js start
# Ctrl+C 停止

# 确认没有被覆盖
cat ~/.evolclaw/eck/runtime.md
# 应该还是 "# 我的自定义内容"
```

## 6. identities → relations 迁移

```bash
# 如果有现存 agent 目录带 identities/
ls ~/.evolclaw/agents/

# 手动创建一个测试用的 identities/ 目录
mkdir -p ~/.evolclaw/agents/test.agentid.pub/identities/contacts

# 启动 evolclaw（会自动迁移）
node dist/cli/index.js start
# Ctrl+C

# 确认迁移
ls ~/.evolclaw/agents/test.agentid.pub/
# 应该看到 relations/ 而不是 identities/

# 清理测试目录
rm -rf ~/.evolclaw/agents/test.agentid.pub
```

## 7. kits 不再复制到 EVOLCLAW_HOME

```bash
# 如果存在旧的 kits 目录，删除它
rm -rf ~/.evolclaw/kits

# 启动 evolclaw
node dist/cli/index.js start
# Ctrl+C

# 确认 kits/ 没有被创建
ls ~/.evolclaw/kits 2>&1
# 应该报 No such file or directory
```

## 8. 消息处理 ECK 注入（需要实际运行）

这一步需要 evolclaw 正常运行并收到消息：

```bash
# 正常启动
node dist/cli/index.js start

# 从另一个终端发送测试消息
node dist/cli/index.js msg send <your-aid> <peer-aid> "test"
```

观察日志中是否有 ECK 注入相关的行为。如果 projectPath 不在伞目录下（没有 symlink），rules 内容会被注入到 systemPrompt。

## 9. 回归检查清单

| 检查项 | 方法 |
|--------|------|
| 现有 agent 配置能正常加载 | `node dist/cli/index.js agent list` |
| 消息收发正常 | 通过 Evol 前端或 CLI 发消息 |
| 飞书/其它渠道不受影响 | 如果有配置，发一条消息确认 |
| `evolclaw status` 正常 | `node dist/cli/index.js status` |
| 日志无异常 | `tail -f ~/.evolclaw/logs/evolclaw.log` |

---

建议按顺序执行 1→7，确认基础设施无误后再做 8→9 的集成测试。步骤 3 和 6 是最关键的——它们验证了本次改动的两个核心行为（symlink 分发和目录迁移）。

# 在 Root 用户下配置 Playwright MCP

## 问题背景

在 root 用户环境下使用 Playwright MCP 时，会遇到 Chrome 沙箱限制导致的启动失败：

```
Error: browserType.launchPersistentContext: Failed to launch the browser process.
Browser logs:
Chromium sandboxing failed!
Running as root without --no-sandbox is not supported.
```

## 解决方案

### 1. 创建包装脚本

创建 `/root/.claude/playwright-mcp-wrapper.sh`：

```bash
#!/bin/bash
export PLAYWRIGHT_MCP_NO_SANDBOX=true
exec npx -y @playwright/mcp --no-sandbox "$@"
```

添加执行权限：

```bash
chmod +x /root/.claude/playwright-mcp-wrapper.sh
```

### 2. 配置 Playwright Plugin

修改 `/root/.claude/plugins/cache/claude-plugins-official/playwright/d5c15b861cd2/.mcp.json`：

```json
{
  "playwright": {
    "command": "/root/.claude/playwright-mcp-wrapper.sh",
    "args": []
  }
}
```

**注意**：`d5c15b861cd2` 是版本哈希，可能会变化。使用以下命令查找最新版本：

```bash
ls -lt /root/.claude/plugins/cache/claude-plugins-official/playwright/ | head -2
```

### 3. 启用 Playwright Plugin

在 `/root/.claude/settings.json` 中确保 Playwright plugin 已启用：

```json
{
  "enabledPlugins": {
    "playwright@claude-plugins-official": true
  }
}
```

### 4. 重启 Claude CLI

完全退出并重新启动 Claude CLI（不是重启对话）：

```bash
# 退出当前 CLI
exit

# 重新启动
claude
```

## 验证配置

### 检查进程参数

```bash
ps aux | grep playwright | grep -v grep
```

应该看到进程带有 `--no-sandbox` 参数：

```
root  ... npm exec @playwright/mcp --no-sandbox
root  ... node .../playwright-mcp --no-sandbox
```

### 检查环境变量

```bash
cat /proc/$(pgrep -f "node.*playwright-mcp" | head -1)/environ | tr '\0' '\n' | grep PLAYWRIGHT
```

应该看到：

```
PLAYWRIGHT_MCP_NO_SANDBOX=true
```

### 测试功能

在 Claude Code 中测试：

```javascript
// 导航到网页
await page.goto('https://github.com');

// 截图
await page.screenshot();
```

## 配置说明

### 为什么需要两种方式？

1. **环境变量** `PLAYWRIGHT_MCP_NO_SANDBOX=true`：Playwright MCP 的标准配置方式
2. **命令行参数** `--no-sandbox`：直接传递给 Playwright，确保生效

两者结合使用可以确保在各种情况下都能正确禁用沙箱。

### Plugin vs MCP Server

Claude Code 中 Playwright 有两种加载方式：

1. **Plugin 方式**（推荐）：
   - 在 `settings.json` 的 `enabledPlugins` 中启用
   - 配置文件：`.claude/plugins/cache/.../playwright/.../mcp.json`
   - 优点：集成度高，自动管理

2. **MCP Server 方式**：
   - 在 `~/.claude/mcp.json` 中配置
   - 在 `settings.local.json` 的 `enabledMcpjsonServers` 中启用
   - 优点：配置灵活，但 plugin 缓存可能被覆盖

**建议使用 Plugin 方式**，因为它更稳定且不会被自动更新覆盖。

## 常见问题

### Q: 修改配置后没有生效？

A: 必须**完全退出** Claude CLI 进程，而不是重启对话。使用 `exit` 命令退出，然后重新运行 `claude`。

### Q: Plugin 版本更新后配置丢失？

A: Plugin 更新可能会创建新的版本目录。需要重新修改新版本目录下的 `.mcp.json` 文件。

### Q: 如何确认使用的是哪个版本？

A: 检查进程的 `CLAUDE_PLUGIN_ROOT` 环境变量：

```bash
cat /proc/$(pgrep -f "node.*playwright-mcp" | head -1)/environ | tr '\0' '\n' | grep CLAUDE_PLUGIN_ROOT
```

### Q: 能否在非 root 用户下使用？

A: 可以。非 root 用户不需要禁用沙箱，使用默认配置即可。

## 安全注意事项

禁用沙箱会降低浏览器的安全隔离性。建议：

1. 仅在受信任的环境中使用
2. 不要访问不可信的网站
3. 定期更新 Playwright 和 Chrome
4. 考虑使用 Docker 容器隔离

## 参考资料

- [Playwright MCP 官方文档](https://github.com/microsoft/playwright-mcp)
- [Playwright MCP 环境变量](https://mcpservers.org/en/servers/microsoft/playwright-mcp)
- [Chrome 沙箱说明](https://chromium.googlesource.com/chromium/src/+/master/docs/linux/sandboxing.md)

请引导我完成 EvolClaw 的安装和配置（AUN 通道专用版）。EvolClaw 是一个轻量级 AI Agent 网关，通过 AUN 网络连接多个 Agent。

**重要提示**：本安装流程专为 AUN 通道设计，会自动完成初始化并引导创建 AUN 通道配置。

按以下步骤执行：

## 第 1 步：环境检查

运行 `node --version` 和 `npm --version`，确认 Node.js >= 18、npm >= 8。
如果不符合要求，提示用户先升级 Node.js（https://nodejs.org）后停止。

## 第 2 步：确认安装

使用 AskUserQuestion 询问：
- 问题：是否立即安装 EvolClaw？
- 选项 A：立即安装
- 选项 B：仅显示命令，我稍后手动执行

如果选择 B，输出 `npm install -g evolclaw` 后结束。

## 第 3 步：执行安装

运行 `npm install -g evolclaw`，然后 `evolclaw --version` 验证。

如果失败且是权限问题，提示：
```
sudo npm install -g evolclaw
# 或配置 npm prefix（推荐）：
npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH
npm install -g evolclaw
```

## 第 4 步：自动初始化配置

**自动执行**：运行 `evolclaw init`

提示用户：EvolClaw 自动继承 Claude Code CLI 的 API Key，无需重复配置。

## 第 5 步：配置 AUN 通道

**重要**：告知用户需要创建 AUN 通道的 Agent ID (aid)。

提示用户：
1. 访问 AUN 网络管理界面创建新的 Agent
2. 获取分配的 `aid`（Agent ID）
3. 将 `aid` 配置到 `~/.evolclaw/data/evolclaw.json` 的 `channels.aun.aid` 字段

示例配置：
```json
{
  "channels": {
    "aun": {
      "enabled": true,
      "aid": "your-agent-id-here",
      "domain": "aun.network",
      "agentName": "EvolClaw Gateway"
    }
  }
}
```

询问用户是否已完成 AUN aid 配置，如果未完成，等待用户配置后继续。

## 第 6 步：启动并验证

运行 `evolclaw start`，再运行 `evolclaw status` 确认状态为 Running。

安装完成后告知用户：
- AUN 通道已启动，其他 Agent 可通过 AUN 网络发现并调用此 Agent
- 发送 `/help` 查看所有命令
- 发送 `/bind <项目路径>` 绑定项目目录
- 常用命令：`evolclaw stop/restart/logs`
- AUN 通道配置文件：`~/.evolclaw/data/evolclaw.json`

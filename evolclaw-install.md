请引导我完成 EvolClaw 的安装和配置。EvolClaw 是一个轻量级 AI Agent 网关，连接 Claude/Codex 到飞书、微信等 IM 通道。

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

## 第 4 步：初始化配置

运行 `evolclaw init`。

提示用户：EvolClaw 自动继承 Claude Code CLI 的 API Key，无需重复配置。

## 第 5 步：配置消息渠道

使用 AskUserQuestion（multiSelect: true）询问需要配置哪些渠道：
- 飞书：运行 `evolclaw init feishu`（扫码登录）
- 微信：运行 `evolclaw init wechat`（扫码登录）
- 暂不配置：跳过

## 第 6 步：启动并验证

运行 `evolclaw start`，再运行 `evolclaw status` 确认状态为 Running。

安装完成后告知用户：
- 在飞书/微信中发消息验证连接
- 发送 `/help` 查看所有命令
- 发送 `/bind <项目路径>` 绑定项目目录
- 常用命令：`evolclaw stop/restart/logs`

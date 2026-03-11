# EvolClaw 部署指南

## 系统要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- 2GB+ RAM
- Linux/macOS/Windows

## 安装步骤

### 1. 克隆仓库

```bash
git clone https://github.com/your-org/evolclaw.git
cd evolclaw
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境

创建 `data/config.json`：

```json
{
  "anthropic": {
    "apiKey": "sk-ant-..."
  },
  "feishu": {
    "appId": "cli_...",
    "appSecret": "..."
  },
  "acp": {
    "domain": "aid.pub",
    "agentName": "evolclaw"
  },
  "projects": {
    "defaultPath": "./projects/default",
    "autoCreate": true
  }
}
```

### 4. 构建

```bash
npm run build
```

### 5. 启动

```bash
npm start
```

## 生产部署

### 使用 PM2

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start dist/index.js --name evolclaw

# 查看日志
pm2 logs evolclaw

# 重启
pm2 restart evolclaw
```

### 使用 systemd

创建 `/etc/systemd/system/evolclaw.service`：

```ini
[Unit]
Description=EvolClaw AI Agent Gateway
After=network.target

[Service]
Type=simple
User=evolclaw
WorkingDirectory=/opt/evolclaw
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl enable evolclaw
sudo systemctl start evolclaw
sudo systemctl status evolclaw
```

## 配置说明

### Anthropic API

从 https://console.anthropic.com/ 获取 API Key。

### 飞书配置

1. 访问 https://open.feishu.cn/
2. 创建企业自建应用
3. 获取 App ID 和 App Secret
4. 配置事件订阅和权限

### ACP 配置

1. 访问 https://aid.pub/
2. 注册 Agent 身份
3. 配置 domain 和 agentName

## 故障排查

### 连接失败

检查网络和 API Key：

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```

### 日志查看

```bash
# 查看运行日志
tail -f data/logs/evolclaw.log

# 查看错误日志
tail -f data/logs/error.log
```

## 监控

### 健康检查

```bash
curl http://localhost:3000/health
```

### 性能指标

```bash
curl http://localhost:3000/metrics
```

## 备份

定期备份以下目录：

- `data/sessions.db` - 会话数据库
- `data/config.json` - 配置文件
- `projects/` - 项目工作目录

## 更新

```bash
git pull
npm install
npm run build
pm2 restart evolclaw
```

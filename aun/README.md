# AUN CLI

AUN 协议的交互式命令行客户端。

## 安装

```bash
cd /home/evolclaw/projects/aun
.venv/bin/pip install -e .
```

安装后，`aun` 命令在 venv 中可用：

```bash
# 在 venv 中使用
.venv/bin/aun -t evolclaw-ai.agentid.pub

# 或激活 venv 后直接使用
source .venv/bin/activate
aun -t evolclaw-ai.agentid.pub
```

## 使用方法

```bash
# 交互式 REPL
aun -t evolclaw-ai.agentid.pub

# 单条消息（发完等回复）
aun -t evolclaw-ai.agentid.pub -s "你好"

# 指定 AID
aun -a test-user.agentid.pub -t evolclaw-ai.agentid.pub
```

## 多实例运行

不同 AID 天然隔离（SDK 的 AIDs/ 目录按 AID 分子目录），直接开多个终端：

```bash
# 终端1
aun -a user-a.agentid.pub -t evolclaw-ai.agentid.pub

# 终端2
aun -a user-b.agentid.pub -t evolclaw-ai.agentid.pub
```

## REPL 命令

- `/` - 命令菜单
- `//` - 远端命令菜单
- `/target <aid>` - 设置目标 AID（持久化）
- `/plain` - 切换明文/E2EE 模式（持久化）
- `/debug` - 切换调试模式（持久化）
- `/help` - 帮助
- `/quit` - 退出
- `Ctrl+J` - 换行（多行输入）
- `Ctrl+L` - 清屏
- `Ctrl+C` - 中断任务 / 清空输入 / 双击退出

## 数据目录

```
~/.aun/aun-cli/              # AUN_CLI_DATA 可覆盖基础目录
├── config.json              # CLI 配置（aid, target, encrypt, debug）
├── .history                 # REPL 输入历史
└── AIDs/                    # SDK 管理（多 AID 自然共存）
    ├── user-a.agentid.pub/
    │   ├── private/key.json
    │   ├── public/cert.pem
    │   └── tokens/meta.json
    └── user-b.agentid.pub/
        └── ...
```

## 网关配置

- 域名：`gateway.agentid.pub`
- 端口：20001
- WebSocket：`wss://gateway.agentid.pub:20001/aun`

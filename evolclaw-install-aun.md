# EvolClaw AUN 通道安装指南

EvolClaw 是一个开源的 AI Agent 网关，将 Claude/Codex 等 AI 后端连接到 AUN（AgentUnion.Network）消息通道。

- **npm**: https://www.npmjs.com/package/evolclaw
- **GitHub**: https://github.com/eLeanwang/evolclaw
- **AUN**: https://agentunion.network

---

## 前置条件

- Node.js >= 18，npm >= 8
- 一个 AUN Agent ID（AID）——标识你的 Agent
- 一个 Owner AID——接收欢迎消息和管理权限

---

## 安装步骤

### 步骤 1：检查环境

```bash
node --version   # 需要 >= 18
npm --version    # 需要 >= 8
```

版本不满足请先升级：https://nodejs.org

### 步骤 2：安装 EvolClaw

```bash
npm install -g evolclaw
evolclaw --version
```

遇到权限错误（EACCES）：

```bash
# 方案 A
sudo npm install -g evolclaw

# 方案 B（推荐，无需 sudo）
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
npm install -g evolclaw
```

### 步骤 3：检查是否已在运行

npm 安装完成后，先检查是否有正在运行的 evolclaw 进程。升级或重装场景下，旧进程仍在使用旧版本代码，必须停止后才能让新版本生效。

```bash
evolclaw status
```

判断逻辑：

- 输出包含 `running` / `PID` / `已启动` 等表明服务在运行 → **询问用户**是否停止：

  > 检测到 evolclaw 正在运行（PID: xxx）。继续安装需要停止当前服务以应用新版本，是否停止？(y/N)

  用户确认后执行：

  ```bash
  evolclaw stop
  ```

  用户拒绝则中止安装流程，提醒其手动 `evolclaw stop` 后重新发起。

- 输出表明未运行（`not running` / `stopped` / 无 PID）→ 直接进入下一步。

### 步骤 4：准备配置信息

| 参数 | 说明 | 示例 |
|------|------|------|
| `--aun-aid` | **必填**，Agent 自身的 AID，作为 bot 在 AUN 网络上的独立身份 | `mybot.agentid.pub` |
| `--aun-owner` | **必填**，Owner 的 AID，用于接收欢迎消息和管理权限 | `alice.agentid.pub` |
| `--default-path` | 默认项目路径（bot 会话未显式 `/bind` 时使用的工作目录） | `/home/user/myproject` |

**注意**：`--aun-aid` 和 `--aun-owner` 必须是不同的 AID。Agent 需要独立身份，不能与 Owner 相同。

如果用户在触发安装时已提供 Owner AID（例如消息中包含"将 xxx 添加为 Owner ID"），直接使用该值，否则询问用户。Agent AID 必须单独询问用户，不能默认使用 Owner AID。

**默认项目路径必须询问用户，提供三个选项：**

1. **推荐默认**：`~/projects/default`（EvolClaw 约定的默认工作区；若不存在会自动创建）
2. **当前 Claude Code 运行目录**：即本次会话启动 `claude` 的工作目录（通过 `pwd` 获取）——适合希望 bot 直接在当前项目里工作的场景
3. **自定义路径**：用户指定绝对路径（须是已存在的目录，或接受后自动创建）

示例提问：

> 请选择默认项目目录（bot 未显式 `/bind` 时使用的工作目录）：
> 1) `~/projects/default`（推荐，EvolClaw 默认工作区）
> 2) 当前目录：`<pwd 输出>`
> 3) 自定义路径（请提供绝对路径）

用户未选择时，默认取选项 1。选项 3 需校验路径是绝对路径；目录不存在则 `mkdir -p` 创建。

### 步骤 5：非交互式初始化

将用户选择的目录作为 `--default-path` 传入：

```bash
evolclaw init --non-interactive \
  --default-path <用户选择的绝对路径> \
  --channel aun \
  --aun-aid <AID> \
  --aun-owner <Owner AID>
```

此命令自动完成：
1. 创建配置文件 `~/.evolclaw/data/evolclaw.json`
2. 安装 `@agentunion/aun-node`
3. 创建 AID 密钥对（如本地不存在）
4. 下载 CA 根证书到 `~/.aun/CA/root/root.crt`
5. 写入初始 `agent.md`（`initialized: false`）
6. 写入配置（含 owner 字段）

### 步骤 6：启动前验证

读取配置文件确认关键字段：

```bash
cat ~/.evolclaw/data/evolclaw.json
```

检查：
- `channels.aun.aid` — 你的 AID
- `channels.aun.owner` — Owner AID
- `projects.defaultPath` — 项目路径（目录需存在）
- `channels.defaultChannel` — 应为 `"aun"`

如发现缺失或异常，向用户说明并提供修复方案。

### 步骤 7：启动服务

```bash
evolclaw start
```

### 步骤 8：验证运行状态

```bash
evolclaw status
tail -n 30 ~/.evolclaw/logs/evolclaw.log
```

日志中应出现：`[AUN] Connected as @<aid>`

如未出现或有错误，读取完整日志分析原因并提供修复建议。

---

## 首次连接自动行为

EvolClaw 首次连接 AUN 网络时自动：

1. 检测 `~/.aun/AIDs/<aid>/agent.md` 中的 `initialized` 字段
2. 若为 `false`，生成完整 agent.md 并发布到 AUN 网络
3. 向 Owner 发送欢迎消息

无需手动触发，连接成功后自动完成。

---

## 安装完成

```
✅ EvolClaw 安装完成！

服务已启动并连接到 AUN 网络。
首次连接后你将在 AUN 客户端收到欢迎消息。
使用 /bind <项目路径> 绑定工作目录即可开始。
```

---

## 常见问题

**Q: AID 已存在怎么办？**
`evolclaw init --non-interactive` 会检测本地密钥，已存在则跳过创建。

**Q: 启动失败怎么办？**
查看 `~/.evolclaw/logs/evolclaw.log` 或运行 `evolclaw diagnose`。

**Q: 如何重启/查看日志？**
```bash
evolclaw restart
evolclaw logs
```

**Q: 如何清理损坏的 AID 重新注册？**
```bash
rm -rf ~/.aun/AIDs/<aid>
evolclaw init --non-interactive --channel aun --aun-aid <aid> --aun-owner <owner>
```

---

## Windows 故障排除（自动诊断）

以下步骤面向 AI Agent 自动执行，按 if-then 格式编写。

### evolclaw 命令不可用

如果 `evolclaw --version` 返回 command not found 或无法识别：

**原因**：npm 全局 bin 目录不在系统 PATH 中。

**修复**：

```bash
# 1. 获取 npm 全局 bin 目录
npm config get prefix
# Windows 输出示例：C:\Users\<user>\AppData\Roaming\npm
# Unix 输出示例：/usr/local/

# 2. 将该目录加入 PATH
# Windows (PowerShell, 当前用户永久生效):
[Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path', 'User'));C:\Users\<user>\AppData\Roaming\npm", "User")
# Unix:
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

# 3. 验证
evolclaw --version
```

### SDK 找不到 Claude Code 可执行体

**症状**：`evolclaw start` 后日志出现 `spawn ENOENT`、`executable not found`、或 SDK 报 `Could not find claude-code executable`。

**原因**：Claude Code CLI 未安装，或安装后不在 PATH 中。

**修复**：

```bash
# 1. 检查 claude 是否可用
# Windows:
where claude
# Unix:
which claude

# 2. 如果不存在，安装 Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 3. 如果已安装但不在 PATH，同上一节方法将 npm 全局 bin 目录加入 PATH

# 4. 验证
claude --version
```

安装完成后 SDK 会自动发现 `claude` 可执行体，无需额外配置。

**备用方案**：如果因 SDK 平台包版本错位（win32-x64 二进制滞后于 SDK 主包）导致 SDK 内置可执行体不可用，但系统已有独立安装的 `claude`，可在 `~/.evolclaw/data/evolclaw.json` 中显式指定路径：

```json
{
  "agents": {
    "anthropic": {
      "pathToClaudeCodeExecutable": "C:\\Users\\<user>\\AppData\\Roaming\\npm\\claude.cmd"
    }
  }
}
```

此配置仅作为 SDK 自动发现失败时的 escape hatch。

### SDK 平台包版本错位

**症状**：`npm install -g evolclaw` 成功，但启动时 SDK 报原生模块加载失败。

**诊断**：
```bash
# 检查 SDK 主包版本
node -e "console.log(require('@anthropic-ai/claude-agent-sdk/package.json').version)"

# 检查平台包是否存在
node -e "try{require('@anthropic-ai/claude-code-win32-x64');console.log('OK')}catch(e){console.log('MISSING:',e.message)}"
```

**修复**：确保系统有独立安装的 Claude Code CLI（`npm install -g @anthropic-ai/claude-code`），SDK 会优先使用 PATH 中的 `claude`。

### npm install 报 spawn EINVAL

**症状**：`npm install -g evolclaw` 过程中报 `spawn EINVAL`。

**原因**：Node.js 24+ 的安全变更（CVE-2024-27980）与部分 npm 脚本不兼容。

**修复**：

```bash
# 1. 升级到 evolclaw >= 2.5.4
npm install -g evolclaw@latest

# 2. 如仍报错，先手动安装 AUN SDK 依赖再执行 init
npm install -g @agentunion/aun-node
evolclaw init --non-interactive --channel aun --aun-aid <aid> --aun-owner <owner>
```

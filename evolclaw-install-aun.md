# EvolClaw AUN 通道安装指南

EvolClaw 是一个开源的 AI Agent 网关，将 Claude/Codex 等 AI 后端连接到 AUN（AgentUnion.Network）消息通道。

- **npm**: https://www.npmjs.com/package/evolclaw
- **GitHub**: https://github.com/eLeanwang/evolclaw
- **AUN**: https://agentunion.network

---

## 前置条件

- Node.js >= 18，npm >= 8（使用 codex baseagent 时建议 >= 22.5 以获得完整 session 列表查询；低版本会自动降级为 rollout 文件查询）
- 一款 baseagent CLI：`claude` / `codex` / `gemini` 任一在 PATH 中
- 一个 AUN Agent ID（AID）——标识你的 Agent
- 一个 Owner AID（可选）——接收欢迎消息和管理权限；不填则首次通信者自动绑定

---

## 安装步骤

### 步骤 1：检查环境

```bash
node --version   # 需要 >= 18
npm --version    # 需要 >= 8
which claude || which codex || which gemini   # 至少一款 baseagent CLI
```

版本不满足请先升级：https://nodejs.org

baseagent CLI 缺失时可用 `npm install -g @anthropic-ai/claude-code` 安装 claude。

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

### 步骤 4：解析用户输入

用户在触发安装时通常用类似下面的格式提供配置信息（**Claude Code 必须按以下规则解析**）：

```
安装 evolclaw（npm install -g evolclaw），读取包内的安装文档完成配置
你要使用的AID是:aibot.agentid.pub
你的主人AID是:elean.agentid.pub
你的昵称是:我是小艾
```

提取规则（每条都是"消息中有则用，无则不带 flag"）：

| 用户消息模式 | 命令参数 |
|---|---|
| `你要使用的AID是:X` / `agent AID:X` / `bot AID is X` | 位置参数 `<aid>`（**必填**——若用户消息没提供，停下问用户） |
| `你的主人AID是:X` / `owner AID:X` / `owner is X` | `--owner X`（可选，缺则不带 flag，首次通信者自动绑定） |
| `你的昵称是:X` / `叫 X` / `name X` / `the bot is named X` | `--name "X"`（可选，缺则不带 flag，agent new 自动用 AID 首段） |

**注意**：`<aid>` 和 `--owner` 必须不同的 AID（Agent 需要独立身份，不能与 Owner 相同）。

`--description` **不从用户消息提取**，按步骤 5 流程生成候选让用户选择。

`--project`（agent 默认工作目录）需要单独询问用户，提供三个选项：

1. **推荐默认**：`~/evolclaw-projects/<aid 首段>`（EvolClaw 约定的默认工作区；若不存在会自动创建）
2. **当前 Claude Code 运行目录**：即本次会话启动 `claude` 的工作目录（通过 `pwd` 获取）——适合希望 bot 直接在当前项目里工作的场景
3. **自定义路径**：用户指定绝对路径（须是已存在的目录，或接受后自动创建）

示例提问：

> 请选择默认项目目录（agent 默认工作目录）：
> 1) `~/evolclaw-projects/<aid 首段>`（推荐）
> 2) 当前目录：`<pwd 输出>`
> 3) 自定义路径（请提供绝对路径）

用户未选择时，默认取选项 1。选项 3 需校验路径是绝对路径；目录不存在则 `mkdir -p` 创建。

### 步骤 5：生成 description 候选并让用户选择

Claude Code 基于已确定的 `<aid>` / `--name`（若已提取）和当前对话上下文，**生成 3 个不同侧重的简短中文描述**（每条 10-30 字）：

- **候选 1（能力陈述）**：突出 agent 能做什么，例 `"EvolClaw 多模型 AI 助手"`
- **候选 2（服务对象）**：突出服务谁，例 `"<owner 名称>的 AI 私人助手"`
- **候选 3（风格化）**：拟人化或带性格的表述，例 `"可爱聪明的小艾，随叫随到"`

用 `AskUserQuestion`（或交互问答）让用户选择。选项含**4 项**：候选 1 / 2 / 3 / 跳过；用户也可输入"其他"自定义。

| 用户选择 | 命令参数 |
|---|---|
| 候选 1 / 2 / 3 | `--description "<对应候选>"` |
| 其他（自定义文本） | `--description "<用户输入>"` |
| 跳过 | 不带 `--description` flag |

### 步骤 6：写全局 defaults.json

```bash
evolclaw init --non-interactive
```

可选传 `--baseagent <claude|codex|gemini>` 显式指定；不传则取 PATH 中第一个可用项。
重装场景下需要覆盖已有 `defaults.json`，加 `--force`。

此命令仅创建 `$EVOLCLAW_HOME/agents/defaults.json`（`$EVOLCLAW_HOME` 默认 `~/.evolclaw`），不碰 AID 与渠道。

### 步骤 7：创建 agent

```bash
evolclaw agent new <aid> --non-interactive \
  --project <用户选择的绝对路径> \
  [--owner <Owner AID>] \
  [--name "<昵称>"] \
  [--description "<选定描述>"] \
  [--baseagent <claude|codex|gemini>]
```

按步骤 4/5 的提取规则填入 flag——**省略未提取到的可选参数**，不要主动填默认值（agent new 内部会处理默认）。

此命令自动完成：

1. 校验 AID 格式（多级域名，如 `mybot.agentid.pub`）
2. 创建 AID 密钥对（如本地不存在）；下载 CA 根证书到 `~/.aun/CA/root/root.crt`
3. 创建 per-agent 配置文件 `$EVOLCLAW_HOME/agents/<aid>/config.json`（含 `initialized: false`）
4. 生成并签名上传 `agent.md` 到 AUN 网络

AUN 通道由 `agent.aid` 隐式驱动，不需要单独配 channel——`evolclaw start` 后即自动连接；首次连接成功并向 owner 发完欢迎消息后，`config.json` 中的 `initialized` 会被更新为 `true`。

### 步骤 8：启动前验证

读取配置文件确认关键字段：

```bash
cat $EVOLCLAW_HOME/agents/<aid>/config.json
```

检查：

- `aid` — 你的 AID
- `owners` — Owner AID 数组（可为空，留给自动绑定）
- `active_baseagent` — `claude` / `codex` / `gemini`
- `projects.defaultPath` — 项目路径（目录需存在）
- `channels` — 数组，初始可为空（AUN 隐式上线）
- `initialized` — 应为 `false`（首次连接成功后由系统更新为 `true`）

如发现缺失或异常，向用户说明并提供修复方案。

### 步骤 9：启动服务

```bash
evolclaw start
```

### 步骤 10：验证运行状态

```bash
evolclaw status
evolclaw logs   # 实时滚动日志，Ctrl+C 退出
```

或直接读最近日志（LogWriter 会切片归档，需要 `tail -F` 跨切片续接）：

```bash
tail -F ~/.evolclaw/logs/evolclaw.log
```

日志中应出现：`[AUN] Connected as @<aid>`

如未出现或有错误，读取完整日志分析原因并提供修复建议（也可运行 `evolclaw diagnose` 快速检查配置和数据目录）。

---

## 首次连接自动行为

EvolClaw 首次连接 AUN 网络时自动：

1. 检测 `$EVOLCLAW_HOME/agents/<aid>/config.json` 中的 `initialized` 字段
2. 若为 `false`，且 `owners[0]` 已配置：
   - 生成完整 agent.md（含基于 owner 的 display name）并发布到 AUN 网络
   - 向 Owner 发送欢迎消息
   - 把 `config.json` 中的 `initialized` 更新为 `true`
3. 若 `owners[]` 为空（自动绑定模式）：跳过欢迎消息，`initialized` 维持 `false`；首次有人和该 agent 私聊时自动绑定为 owner，**自动绑定后立即补发欢迎消息**并把 `initialized` 置 `true`（订阅 `channel:owner-bound` 事件实现）

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
`evolclaw agent new` 会检测本地密钥，已存在则跳过创建（`alreadyExisted`）。如果 `agents/<aid>/config.json` 已存在，命令会失败；加 `--force` 可覆盖配置（AID 密钥保留；agent.md 会按当前 `--name` / `--description` 重新生成并重新上传）。

**Q: 启动失败怎么办？**
运行 `evolclaw logs` 实时滚动日志，或 `evolclaw diagnose` 检查配置和数据目录。

**Q: 如何重启/查看日志？**
```bash
evolclaw restart
evolclaw logs
```

**Q: 如何清理损坏的 AID 重新注册？**
```bash
evolclaw aid delete <aid>      # 删本地密钥与证书
rm -rf $EVOLCLAW_HOME/agents/<aid>   # 删 per-agent 配置
evolclaw agent new <aid> --non-interactive --project <abs path>
```

**Q: 想加飞书 / 微信 / 钉钉等 IM 通道？**
agent 已建好后再单独配置（每条命令交互式从已有 agents 里选目标）：
```bash
evolclaw init feishu      # 飞书扫码
evolclaw init wechat      # 微信扫码
evolclaw init dingtalk    # 钉钉扫码
evolclaw init qqbot       # QQ 机器人扫码
evolclaw init wecom       # 企业微信手输 Bot ID + Secret
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

# 2. 如仍报错，先手动安装 AUN SDK 依赖再执行 init / agent new
npm install -g @agentunion/aun-node
evolclaw init --non-interactive
evolclaw agent new <aid> --non-interactive --project <abs path>
```
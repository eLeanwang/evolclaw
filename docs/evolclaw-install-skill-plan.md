# EvolClaw 一键安装 Skill — 实现方案 v3

## 概述

在 Claude Code CLI 中，用户通过一行命令触发安装流程，Claude 在线读取安装文档后引导完成 EvolClaw 的安装、配置和启动，全程不需要退出 Claude Code。

安装完成后，EvolClaw AUN 通道首次连接成功时，自动更新 agent.md 并向 Owner 发送欢迎消息。

---

## 用户触发方式

```
请阅读 https://raw.githubusercontent.com/eLeanwang/evolclaw/main/evolclaw-install-aun.md 安装 evolclaw，并将 {ownerId} 添加为 Owner ID
```

Claude 通过 WebFetch 读取文档内容，按文档指引执行安装流程。

---

## 安装流程（Claude Code 内全程完成）

### Step 1：环境检查（静默）

Claude 执行 `node --version` 和 `npm --version`，确认 Node.js >= 18、npm >= 8。
版本不符则提示用户升级后停止。

### Step 2：AskUserQuestion 确认安装

```
问题：是否立即安装 EvolClaw？
选项：
  A. 立即安装
  B. 仅显示命令，我稍后手动执行
```

选择 B 则输出命令后结束。

### Step 3：安装（静默）

```bash
npm install -g evolclaw
evolclaw --version  # 验证
```

权限失败时提示 sudo 或 npm prefix 方案。

### Step 4：初始化（静默）

Claude 收集必要信息后，一次性执行非交互式初始化：

- **默认项目路径**：当前 Claude Code 工作目录（$PWD），不询问
- **模型**：使用默认值，不询问
- **AUN AID**：从用户初始消息提取，未提供则 AskUserQuestion 询问（必填）
- **Owner AID**：从用户初始消息提取，未提供则 AskUserQuestion 询问（必填）

```bash
evolclaw init --non-interactive \
  --default-path $PWD \
  --channel aun \
  --aun-aid mybot.agentid.pub \
  --aun-owner alice.agentid.pub
```

非交互式 init 流程：
1. 读取 sample 配置模板
2. 设置 defaultPath 和 projects.list
3. 自动检查并安装 `@eleans/aun-core-sdk`（无需用户确认）
4. 创建 AID（如果本地不存在）
5. 写入初始 agent.md（`initialized: false`）
6. 写入配置文件（含 owner）

### Step 5：启动前检查

Claude 在启动前验证配置完整性：

```bash
# 检查配置文件是否存在
cat ~/.evolclaw/data/evolclaw.json

# 检查关键字段
# - channels.aun.aid 是否存在
# - channels.aun.owner 是否存在
# - projects.defaultPath 是否存在且目录可访问
# - channels.defaultChannel 是否设置
```

如果发现异常，Claude 向用户提示问题并给出修复方案，用户同意后执行修复。

### Step 6：启动服务

```bash
evolclaw start
```

### Step 7：启动后检查

Claude 验证服务是否正常运行：

```bash
# 检查进程状态
evolclaw status

# 检查日志是否有错误
evolclaw logs  # 查看最近日志，检查是否有 ERROR/FATAL
```

检查项：
- `evolclaw status` 显示 Running
- 日志中无 ERROR/FATAL 级别错误
- 日志中出现 `[AUN] Connected as ...`（AUN 通道连接成功）

如果发现异常，Claude 向用户提示问题并给出修复方案，用户同意后执行修复。

### Step 8：欢迎流程（自动触发）

AUN 通道连接成功后自动执行，详见下方「欢迎流程」。

---

## 首次判定机制：agent.md initialized 字段

### 原理

使用 agent.md 的自定义字段 `initialized` 判定是否为首次连接，状态跟着数据走，不需要额外标记文件。

### 流程

```
创建 AID 时（init 阶段）
  → 写入 agent.md，包含 initialized: false
  → 发布到 AUN 网络

evolclaw start → AUN 连接成功
  → 读取本地 ~/.aun/AIDs/{aid}/agent.md
  → 解析 initialized 字段
  → initialized: false → 进入欢迎流程
  → initialized: true  → 跳过

欢迎流程完成后
  → 更新 agent.md（name/type/desc/tags + initialized: true）
  → 重新发布到 AUN 网络
  → 写入本地 agent.md
```

### 优势

- **状态跟着数据走**：不需要额外标记文件，agent.md 本身就是状态载体
- **语义清晰**：`initialized: false` 明确表示"尚未完成初始化"
- **可手动重置**：用户编辑 agent.md 把 `initialized` 改回 `false` 即可重新触发欢迎流程
- **与现有代码一致**：`setupAunAid()` 已经在创建 AID 时写入 agent.md，只需加一个字段

---

## 欢迎流程

### 触发条件

AUN 通道 `initClient()` 连接成功后：
1. 读取本地 `~/.aun/AIDs/{aid}/agent.md`
2. 解析 `initialized` 字段
3. `initialized: false` → 执行欢迎流程
4. `initialized: true` 或文件不存在 → 跳过

### 第一步：生成并发布 agent.md

| 字段 | 值 | 来源 |
|------|----|------|
| aid | `mybot.agentid.pub` | 配置 |
| name | `{owner短ID}的Evol助手` | owner AID 取第一段，如 `alice.agentid.pub` → `alice的Evol助手` |
| type | `codeagent` | 固定值 |
| description | 简介 | 固定值 `EvolClaw AI Agent Gateway` |
| version | `1.0.0` | 固定值 |
| tags | `evolclaw, codeagent, gateway` | 固定值 |
| initialized | `true` | 标记已完成初始化 |

生成后：
1. 调用 `client.auth.uploadAgentMd()` 发布到 AUN 网络
2. 写入本地 `~/.aun/AIDs/{aid}/agent.md`

### 第二步：发送欢迎消息给 Owner

```
🎉 EvolClaw 已成功连接到 AUN 网络！

✅ agent.md 已更新发布：
  - name: alice的Evol助手
  - type: codeagent
  - description: EvolClaw AI Agent Gateway
  - version: 1.0.0
  - tags: evolclaw, codeagent, gateway

📋 日常使用方法：
  /bind <路径> — 绑定工作目录
  /help — 查看所有可用命令
  /project <名称> — 切换项目
  /session <名称> — 切换会话
  /status — 查看当前状态
  /agentmd — 查看或更新 agent.md

💡 提示：
  - 直接发送消息即可与 Claude/Codex 对话
  - 支持多项目会话管理，每个项目独立会话
  - 所有命令以 / 开头
```

---

## 代码修改清单

### 1. `src/utils/init-channel.ts` — setupAunAid()

**修改 A**：添加 owner 必填收集

位置：`return { aid }` 之前

```typescript
// Owner 必填
console.log('\n📋 Owner 配置');
console.log('  Owner 将接收欢迎消息并拥有管理权限');
let owner = '';
while (!owner) {
  const ownerInput = (await ask(rl, '  Owner AID (必填): ')).trim();
  if (!ownerInput) { console.log('  ⚠ Owner AID 不能为空'); continue; }
  if (!isValidAid(ownerInput)) { console.log('  ⚠ Owner AID 格式无效'); continue; }
  owner = ownerInput;
  console.log(`  ✓ Owner 已设置: ${owner}`);
}
return { aid, owner };
```

**修改 B**：agent.md 初始内容添加 `initialized: false`

位置：第 791 行 agentMdContent 模板

```typescript
// 修改前
const agentMdContent = `---\naid: "${aid}"\nname: "${agentName}"\ntype: "${agentType}"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\n---\n`;

// 修改后
const agentMdContent = `---\naid: "${aid}"\nname: "${agentName}"\ntype: "${agentType}"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\ninitialized: false\n---\n`;
```

### 2. `src/utils/init-channel.ts` — cmdInitAun()

位置：配置写入处

```typescript
// 修改前
config.channels.aun = { enabled: true, aid: result.aid };

// 修改后
config.channels.aun = { enabled: true, aid: result.aid, owner: result.owner };
```

### 3. `src/utils/init.ts` — cmdInit()

**修改 A**：添加 `options` 参数和非交互式分支

```typescript
export async function cmdInit(options?: {
  nonInteractive?: boolean;
  defaultPath?: string;
  channel?: string;
  aunAid?: string;
  aunOwner?: string;
}) {
  // ... 现有前置检查（PID、sample 文件）...

  if (options?.nonInteractive) {
    const config = JSON.parse(fs.readFileSync(sampleSrc, 'utf-8'));
    const defaultPath = options.defaultPath || path.join(os.homedir(), 'evolclaw-project');
    if (!fs.existsSync(defaultPath)) fs.mkdirSync(defaultPath, { recursive: true });
    config.projects.defaultPath = defaultPath;
    config.projects.list = { [path.basename(defaultPath)]: defaultPath };

    if (options.channel === 'aun' && options.aunAid) {
      // 自动安装 AUN SDK（非交互式）
      const { resolveAunCoreSdkPkg } = await import('./init-channel.js');
      if (!resolveAunCoreSdkPkg()) {
        console.log('正在安装 @eleans/aun-core-sdk...');
        const { npmInstallGlobal } = await import('./init-channel.js');
        await npmInstallGlobal('@eleans/aun-core-sdk@latest');
      }

      // 创建 AID（如果本地不存在）
      const aunPath = path.join(os.homedir(), '.aun');
      const aidDir = path.join(aunPath, 'AIDs', options.aunAid);
      if (!fs.existsSync(path.join(aidDir, 'private'))) {
        const { AUNClient } = await import('@eleans/aun-core-sdk');
        const client = new AUNClient({ aun_path: aunPath });
        const domain = options.aunAid.split('.').slice(1).join('.');
        (client as any)._gatewayUrl = `wss://gateway.${domain}:443/aun`;
        await client.auth.createAid({ aid: options.aunAid });

        // 写入初始 agent.md（initialized: false）
        const agentName = options.aunAid.split('.')[0];
        const agentMd = `---\naid: "${options.aunAid}"\nname: "${agentName}"\ntype: "ai"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\ninitialized: false\n---\n`;
        try {
          await client.auth.uploadAgentMd(agentMd);
          fs.writeFileSync(path.join(aidDir, 'agent.md'), agentMd, 'utf-8');
        } catch {}
        try { await client.close(); } catch {}
      }

      config.channels.aun = {
        enabled: true,
        aid: options.aunAid,
        ...(options.aunOwner && { owner: options.aunOwner }),
      };
      config.channels.defaultChannel = 'aun';
    }

    fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');
    console.log(`✓ 已创建配置文件: ${p.config}`);
    setupEnvVar(resolveRoot());
    return;
  }

  // ... 现有交互式逻辑 ...
}
```

**修改 B**：交互式模式中 AUN 分支的配置写入也包含 owner

```typescript
config.channels.aun = {
  enabled: true,
  aid: result.aid,
  owner: result.owner,
};
```

### 4. `src/cli.ts` — CLI 参数解析

位置：init 命令处理处

```typescript
// 添加辅助函数
function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// 修改 init 命令处理
if (args[0] === 'init' && !args[1]) {
  const nonInteractive = args.includes('--non-interactive');
  if (nonInteractive) {
    await cmdInit({
      nonInteractive: true,
      defaultPath: getArgValue(args, '--default-path'),
      channel: getArgValue(args, '--channel'),
      aunAid: getArgValue(args, '--aun-aid'),
      aunOwner: getArgValue(args, '--aun-owner'),
    });
  } else {
    await cmdInit();
  }
  process.exit(0);
}
```

### 5. `src/channels/aun.ts` — 欢迎流程

**修改**：`sendWelcomeMessage()` 使用 agent.md initialized 字段判定

```typescript
private async sendWelcomeMessage(): Promise<void> {
  const owner = this.config.owner;
  if (!owner) {
    logger.info('[AUN] No owner configured, skipping welcome message');
    return;
  }

  // 读取本地 agent.md，检查 initialized 字段
  const aid = this.config.aid;
  const aunPath = this.config.keystorePath || path.join(os.homedir(), '.aun');
  const agentMdPath = path.join(aunPath, 'AIDs', aid, 'agent.md');

  let needsInit = false;
  try {
    if (fs.existsSync(agentMdPath)) {
      const content = fs.readFileSync(agentMdPath, 'utf-8');
      const match = content.match(/^initialized:\s*(false|true)/m);
      needsInit = match?.[1] === 'false';
    }
  } catch (e) {
    logger.warn(`[AUN] Failed to read agent.md: ${e}`);
    return;
  }

  if (!needsInit) {
    logger.debug('[AUN] agent.md already initialized, skipping welcome');
    return;
  }

  try {
    // 第一步：生成并发布更新后的 agent.md
    const ownerShortId = owner.split('.')[0];
    const agentName = `${ownerShortId}的Evol助手`;
    const agentMd = [
      '---',
      `aid: "${aid}"`,
      `name: "${agentName}"`,
      `type: "codeagent"`,
      `version: "1.0.0"`,
      `description: "EvolClaw AI Agent Gateway"`,
      'tags:',
      '  - evolclaw',
      '  - codeagent',
      '  - gateway',
      'initialized: true',
      '---',
    ].join('\n') + '\n';

    try {
      await this.client!.auth.uploadAgentMd(agentMd);
      fs.writeFileSync(agentMdPath, agentMd, 'utf-8');
      logger.info('[AUN] agent.md updated and published');
    } catch (e) {
      logger.warn(`[AUN] agent.md publish failed: ${e}`);
    }

    // 第二步：发送欢迎消息
    const welcomeText = `🎉 EvolClaw 已成功连接到 AUN 网络！

✅ agent.md 已更新发布：
  - name: ${agentName}
  - type: codeagent
  - description: EvolClaw AI Agent Gateway
  - version: 1.0.0
  - tags: evolclaw, codeagent, gateway

📋 日常使用方法：
  /bind <路径> — 绑定工作目录
  /help — 查看所有可用命令
  /project <名称> — 切换项目
  /session <名称> — 切换会话
  /status — 查看当前状态
  /agentmd — 查看或更新 agent.md

💡 提示：
  - 直接发送消息即可与 Claude/Codex 对话
  - 支持多项目会话管理，每个项目独立会话
  - 所有命令以 / 开头`;

    await this.sendMessage(owner, welcomeText);
    logger.info(`[AUN] Welcome message sent to owner: ${owner}`);
  } catch (e) {
    logger.warn(`[AUN] Failed to send welcome message: ${e}`);
  }
}
```

### 6. `evolclaw-install-aun.md` — 安装文档重写

完整重写为 Claude 可执行的 prompt，包含：
- 环境检查 + 安装 + 非交互式 init
- 启动前检查（配置完整性）
- 启动 + 启动后检查（进程状态、日志错误、AUN 连接）
- 异常时向用户提示并给出修复方案

---

## 启动前后检查清单

### 启动前检查

| 检查项 | 方法 | 异常处理 |
|--------|------|----------|
| 配置文件存在 | `cat ~/.evolclaw/data/evolclaw.json` | 提示重新运行 init |
| `channels.aun.aid` 存在 | 解析 JSON | 提示补充 AID |
| `channels.aun.owner` 存在 | 解析 JSON | 提示补充 Owner |
| `projects.defaultPath` 目录可访问 | `ls` 目录 | 提示创建目录或修改路径 |
| `channels.defaultChannel` 已设置 | 解析 JSON | 提示设置 |
| AUN SDK 已安装 | `npm list -g @eleans/aun-core-sdk` | 提示安装 |
| AID 本地密钥存在 | `ls ~/.aun/AIDs/{aid}/private` | 提示重新创建 AID |

### 启动后检查

| 检查项 | 方法 | 异常处理 |
|--------|------|----------|
| 进程状态 Running | `evolclaw status` | 查看日志定位原因 |
| 无 ERROR/FATAL 日志 | `evolclaw logs` 最近 20 行 | 展示错误，提出修复方案 |
| AUN 连接成功 | 日志中出现 `[AUN] Connected as` | 检查 AID、网络、Gateway |

---

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| Node.js 版本不符 | 提示升级，停止流程 |
| npm install 权限失败 | 提示 sudo 或 npm prefix |
| Owner AID 格式无效（交互式） | 循环询问直到有效 |
| Owner AID 格式无效（非交互式） | 报错退出 |
| AUN SDK 未安装 | 非交互式自动安装 |
| AID 创建失败 | 报错，提示检查网络和 Gateway |
| 启动前检查失败 | Claude 提示问题 + 修复方案，用户同意后执行 |
| 启动后检查失败 | Claude 读取日志，分析原因，提出修复方案 |
| agent.md 发布失败 | 记录日志，继续发送欢迎消息 |
| 欢迎消息发送失败 | 记录日志，不更新 initialized 字段（下次重启重试） |

---

## 文件变更汇总

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/utils/init-channel.ts` | 修改 | setupAunAid() 添加 owner 必填 + agent.md 加 initialized 字段；cmdInitAun() 写入 owner |
| `src/utils/init.ts` | 修改 | cmdInit() 添加非交互式模式；交互式 AUN 分支写入 owner |
| `src/cli.ts` | 修改 | 解析 --non-interactive 及相关参数 |
| `src/channels/aun.ts` | 修改 | sendWelcomeMessage() 用 agent.md initialized 字段判定 + 更新发布 + 欢迎消息 |
| `evolclaw-install-aun.md` | 重写 | 反映新流程，含启动前后检查和异常修复引导 |

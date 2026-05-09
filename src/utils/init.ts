import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from '../paths.js';
import { isWindows, commandExists } from './cross-platform.js';

const execFileAsync = promisify(execFile);

// ==================== Helpers ====================

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

async function npmInstallGlobal(pkg: string): Promise<void> {
  try {
    await execFileAsync('npm', ['install', '-g', pkg], { timeout: 120000 });
  } catch (e: any) {
    if (e.stderr?.includes('EACCES') || e.message?.includes('EACCES')) {
      if (isWindows) {
        throw new Error('权限不足。请以管理员身份运行 PowerShell 或 CMD，然后重试');
      }
      await execFileAsync('sudo', ['npm', 'install', '-g', pkg], { timeout: 120000 });
    } else {
      throw e;
    }
  }
}

async function sudoExec(cmd: string, args: string[]): Promise<void> {
  // 让 n 安装到当前 node 所在的 prefix 目录
  const env = { ...process.env };
  if (cmd === 'n' && !env.N_PREFIX) {
    const nodePrefix = (process.config as any).variables?.node_prefix;
    if (nodePrefix) env.N_PREFIX = nodePrefix;
  }
  try {
    await execFileAsync(cmd, args, { timeout: 120000, env });
  } catch (e: any) {
    if (e.stderr?.includes('EACCES') || e.message?.includes('EACCES') || e.code === 'EACCES') {
      if (isWindows) {
        throw new Error('权限不足。请以管理员身份运行 PowerShell 或 CMD，然后重试');
      }
      await execFileAsync('sudo', [cmd, ...args], { timeout: 120000, env });
    } else {
      throw e;
    }
  }
}

// ==================== Environment Check ====================

async function checkEnvironment(rl: readline.Interface): Promise<boolean> {
  console.log('🔍 环境检查...\n');

  // Node.js >= 22
  const nodeVer = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeVer >= 22) {
    console.log(`  ✓ Node.js v${process.versions.node}`);
  } else {
    console.log(`  ✗ Node.js v${process.versions.node} — 需要 >= 22（node:sqlite 依赖）`);
    // 检测 nvm
    // 检测 bash 是否存在（nvm 和 n 都依赖 bash）
    const hasBash = commandExists('bash');

    if (!hasBash) {
      if (isWindows) {
        console.log('  ⚠ Windows 环境，请从 https://nodejs.org 下载安装 Node.js 22+');
      } else {
        console.log('  ⚠ 当前环境没有 bash（Alpine 容器？），无法自动升级 Node.js');
        console.log('  → 请手动升级: apk add nodejs-current 或重建容器使用 node:22-alpine');
      }
      return false;
    }

    const hasNvm = !!process.env.NVM_DIR && fs.existsSync(process.env.NVM_DIR);
    if (hasNvm) {
      const answer = (await ask(rl, '  → 是否通过 nvm 升级到 Node.js 22？[Y/n] ')).trim().toLowerCase();
      if (answer === 'n' || answer === 'no') {
        console.log('  已取消');
        return false;
      }
      console.log('  正在升级 Node.js...');
      try {
        const nvmDir = process.env.NVM_DIR;
        const { stdout } = await execFileAsync('bash', ['-c', `source "${nvmDir}/nvm.sh" && nvm install 22 && nvm alias default 22`], { timeout: 120000 });
        console.log(stdout.trim().split('\n').map(l => `  ${l}`).join('\n'));
        console.log('  ✓ Node.js 升级完成');
        console.log('  → 请打开新终端后重新运行 evolclaw init');
        return false;
      } catch (e: any) {
        console.log(`  ✗ 升级失败: ${e.message?.slice(0, 200) || e}`);
        return false;
      }
    } else {
      // 检测 n
      const hasN = commandExists('n');
      if (hasN) {
        const answer = (await ask(rl, '  → 是否通过 n 升级到 Node.js 22？[Y/n] ')).trim().toLowerCase();
        if (answer === 'n' || answer === 'no') {
          console.log('  已取消');
          return false;
        }
        console.log('  正在升级 Node.js...');
        try {
          await sudoExec('n', ['22']);
          console.log('  ✓ Node.js 升级完成');
          console.log('  → 请打开新终端后重新运行 evolclaw init');
          return false;
        } catch (e: any) {
          console.log(`  ✗ 升级失败: ${e.message?.slice(0, 200) || e}`);
          return false;
        }
      }
      // 无版本管理器，用 npm 安装 n 再升级
      const answer = (await ask(rl, '  → 是否通过 npm 安装 n 并升级到 Node.js 22？[Y/n] ')).trim().toLowerCase();
      if (answer === 'n' || answer === 'no') {
        console.log('  已取消');
        return false;
      }
      console.log('  正在安装 n...');
      try {
        await npmInstallGlobal('n');
        console.log('  正在升级 Node.js...');
        await sudoExec('n', ['22']);
        console.log('  ✓ Node.js 升级完成');
        console.log('  → 请打开新终端后重新运行 evolclaw init');
        return false;
      } catch (e: any) {
        console.log(`  ✗ 升级失败: ${e.message?.slice(0, 200) || e}`);
        return false;
      }
    }
  }

  // claude CLI >= 2.1.32
  const MIN_CLAUDE_VER = [2, 1, 32];
  const claudeInstalled = commandExists('claude');
  if (claudeInstalled) {
    try {
      const verOutput = execFileSync('claude', ['--version'], { encoding: 'utf-8' }).trim();
      const verMatch = verOutput.match(/^(\d+\.\d+\.\d+)/);
      if (verMatch) {
        const parts = verMatch[1].split('.').map(Number);
        const isOk = parts[0] > MIN_CLAUDE_VER[0]
          || (parts[0] === MIN_CLAUDE_VER[0] && parts[1] > MIN_CLAUDE_VER[1])
          || (parts[0] === MIN_CLAUDE_VER[0] && parts[1] === MIN_CLAUDE_VER[1] && parts[2] >= MIN_CLAUDE_VER[2]);
        if (isOk) {
          console.log(`  ✓ claude CLI v${verMatch[1]}`);
        } else {
          console.log(`  ✗ claude CLI v${verMatch[1]} — 需要 >= ${MIN_CLAUDE_VER.join('.')}`);
          const answer = (await ask(rl, '  → 是否升级 claude CLI？[Y/n] ')).trim().toLowerCase();
          if (answer === 'n' || answer === 'no') {
            console.log('  已取消');
            return false;
          }
          console.log('  正在升级 claude CLI...');
          try {
            await npmInstallGlobal('@anthropic-ai/claude-code@latest');
            console.log('  ✓ claude CLI 升级完成');
          } catch (e: any) {
            console.log(`  ✗ 升级失败: ${e.message?.slice(0, 200) || e}`);
            return false;
          }
        }
      } else {
        console.log(`  ✓ claude CLI (${verOutput})`);
      }
    } catch {
      // claude command exists but --version failed
    }
  } else {
    console.log('  ✗ claude CLI 未找到');
    console.log('  → 请先安装: npm install -g @anthropic-ai/claude-code');
    return false;
  }

  // Agent SDK 检查：claude-agent-sdk / codex-sdk，至少需要一个
  const MIN_CLAUDE_SDK = [0, 2, 75];
  let hasClaudeSdk = false;
  let hasCodexSdk = false;

  // Check claude-agent-sdk
  try {
    const esmRequire = createRequire(import.meta.url);
    const sdkEntry = esmRequire.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkPkgPath = path.join(path.dirname(sdkEntry), 'package.json');
    const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf-8'));
    const sdkVer = sdkPkg.version as string;
    const parts = sdkVer.split('.').map(Number);
    const sdkOk = parts[0] > MIN_CLAUDE_SDK[0]
      || (parts[0] === MIN_CLAUDE_SDK[0] && parts[1] > MIN_CLAUDE_SDK[1])
      || (parts[0] === MIN_CLAUDE_SDK[0] && parts[1] === MIN_CLAUDE_SDK[1] && parts[2] >= MIN_CLAUDE_SDK[2]);
    if (sdkOk) {
      console.log(`  ✓ claude-agent-sdk v${sdkVer}`);
      hasClaudeSdk = true;
    } else {
      console.log(`  ✗ claude-agent-sdk v${sdkVer} — 需要 >= ${MIN_CLAUDE_SDK.join('.')}`);
      const answer = (await ask(rl, '  → 是否升级 claude-agent-sdk？[Y/n] ')).trim().toLowerCase();
      if (answer !== 'n' && answer !== 'no') {
        console.log('  正在升级 claude-agent-sdk...');
        try {
          await npmInstallGlobal('@anthropic-ai/claude-agent-sdk@latest');
          console.log('  ✓ claude-agent-sdk 升级完成');
          hasClaudeSdk = true;
        } catch (e: any) {
          console.log(`  ✗ 升级失败: ${e.message?.slice(0, 200) || e}`);
        }
      }
    }
  } catch {
    console.log('  - claude-agent-sdk 未安装');
  }

  // Check @openai/codex-sdk (ESM-only, cannot use require.resolve)
  try {
    const codexPkgPath = path.join(getPackageRoot(), 'node_modules', '@openai', 'codex-sdk', 'package.json');
    if (fs.existsSync(codexPkgPath)) {
      const codexPkg = JSON.parse(fs.readFileSync(codexPkgPath, 'utf-8'));
      console.log(`  ✓ codex-sdk v${codexPkg.version}`);
      hasCodexSdk = true;
    } else {
      console.log('  - codex-sdk 未安装');
    }
  } catch {
    console.log('  - codex-sdk 未安装');
  }

  if (!hasClaudeSdk && !hasCodexSdk) {
    console.log('\n  ✗ 需要至少安装一个 Agent SDK：claude-agent-sdk 或 codex-sdk');
    const answer = (await ask(rl, '  → 是否安装 claude-agent-sdk？[Y/n] ')).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      console.log('  已取消');
      return false;
    }
    console.log('  正在安装 claude-agent-sdk...');
    try {
      await npmInstallGlobal('@anthropic-ai/claude-agent-sdk@latest');
      console.log('  ✓ claude-agent-sdk 安装完成');
    } catch (e: any) {
      console.log(`  ✗ 安装失败: ${e.message?.slice(0, 200) || e}`);
      return false;
    }
  }

  console.log('');
  return true;
}

// ==================== Shell Profile ====================

function setupEnvVar(home: string): void {
  if (isWindows) {
    // Windows: use setx to set user environment variable
    try {
      execFileSync('setx', ['EVOLCLAW_HOME', home], { encoding: 'utf-8', stdio: 'pipe' });
      console.log(`  ✓ 已设置用户环境变量: EVOLCLAW_HOME=${home}`);
      console.log('  ⚠ 请重新打开终端使其生效');
    } catch (e: any) {
      console.log(`  ⚠ 设置环境变量失败: ${e.message?.slice(0, 100) || e}`);
      console.log(`  → 请手动设置环境变量 EVOLCLAW_HOME=${home}`);
    }
    return;
  }

  const exportLine = `export EVOLCLAW_HOME="${home}"`;

  const candidates = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.bash_profile'),
  ];

  let written = false;
  for (const profilePath of candidates) {
    if (!fs.existsSync(profilePath)) continue;
    const content = fs.readFileSync(profilePath, 'utf-8');
    if (content.includes('EVOLCLAW_HOME')) {
      console.log(`  ✓ EVOLCLAW_HOME 已在 ${profilePath} 中配置`);
      written = true;
      continue;
    }
    fs.appendFileSync(profilePath, `\n# EvolClaw\n${exportLine}\n`);
    console.log(`  ✓ 已写入 ${profilePath}: ${exportLine}`);
    written = true;
  }

  if (!written) {
    const shell = process.env.SHELL || '/bin/bash';
    const profilePath = shell.endsWith('zsh')
      ? path.join(os.homedir(), '.zshrc')
      : path.join(os.homedir(), '.bashrc');
    fs.appendFileSync(profilePath, `\n# EvolClaw\n${exportLine}\n`);
    console.log(`  ✓ 已写入 ${profilePath}: ${exportLine}`);
  }

  console.log('  ⚠ 请重新打开终端或执行 source 使其生效');
}

// ==================== Feishu Manual Input ====================

async function initFeishuManual(rl: readline.Interface, config: any): Promise<boolean> {
  let appId = '';
  while (!appId) {
    appId = (await ask(rl, '  飞书 App ID: ')).trim();
    if (!appId) console.log('  ⚠ 不能为空');
  }

  let appSecret = '';
  while (!appSecret) {
    appSecret = (await ask(rl, '  飞书 App Secret: ')).trim();
    if (!appSecret) console.log('  ⚠ 不能为空');
  }

  console.log('  正在验证飞书凭证...');
  try {
    const lark = await import('@larksuiteoapi/node-sdk');
    const client = new lark.Client({ appId, appSecret });
    const res = await client.auth.tenantAccessToken.internal({
      data: { app_id: appId, app_secret: appSecret },
    });
    if (res.code === 0) {
      console.log('  ✓ 飞书凭证验证通过');
    } else {
      console.log(`  ✗ 飞书凭证验证失败: ${res.msg}`);
      const answer = (await ask(rl, '  → 是否继续？[y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        return false;
      }
    }
  } catch (e: any) {
    console.log(`  ⚠ 飞书凭证验证跳过: ${e.message?.slice(0, 100) || e}`);
  }

  config.channels.feishu.appId = appId;
  config.channels.feishu.appSecret = appSecret;
  config.channels.feishu.enabled = true;
  return true;
}

// ==================== AUN Environment Check ====================

// Moved to init-channel.ts

// ==================== Rich Content Renderer ====================

async function offerRichContentRenderer(rl: readline.Interface, config: any): Promise<void> {
  const answer = (await ask(rl, '\n是否启用 LaTeX + Mermaid 渲染模块（约 35MB）？[y/N] ')).trim().toLowerCase();
  const enableRich = answer === 'y' || answer === 'yes';

  // 记录用户选择到全局配置
  config.enableRichContent = enableRich;

  if (!enableRich) {
    console.log('  ✓ 已跳过富内容渲染模块安装');
    return;
  }

  console.log('  正在安装 katex 和 mermaid（可能需要 1-2 分钟）...');
  try {
    await npmInstallGlobal('katex');
    await npmInstallGlobal('mermaid');
    console.log('  ✓ LaTeX + Mermaid 渲染模块安装完成');
  } catch (e: any) {
    const msg = e.message || '';
    if (e.killed || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
      console.log('  ✗ 安装超时，网络可能较慢');
    } else {
      console.log(`  ✗ 安装失败: ${msg.slice(0, 200)}`);
    }
    console.log('  → 可稍后手动安装: npm install -g katex mermaid');
    // 安装失败时，将配置设为 false
    config.enableRichContent = false;
  }
}

// ==================== AUN AID Helpers ====================

// Moved to init-channel.ts

// ==================== Main ====================

export async function cmdInit(options?: {
  nonInteractive?: boolean;
  defaultPath?: string;
  channel?: string;
  aunAid?: string;
  aunOwner?: string;
}) {
  const p = resolvePaths();
  ensureDataDirs();

  if (fs.existsSync(p.pid)) {
    const pid = parseInt(fs.readFileSync(p.pid, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`❌ EvolClaw 正在运行 (PID: ${pid})，请先执行 evolclaw stop`);
      return;
    } catch {}
  }

  const sampleSrc = path.join(getPackageRoot(), 'data', 'evolclaw.sample.json');
  if (!fs.existsSync(sampleSrc)) {
    console.log(`❌ 找不到示例配置: ${sampleSrc}`);
    return;
  }

  // 非交互式模式
  if (options?.nonInteractive) {
    const config = JSON.parse(fs.readFileSync(sampleSrc, 'utf-8'));
    const defaultPath = options.defaultPath || path.join(os.homedir(), 'evolclaw-project');
    if (!fs.existsSync(defaultPath)) fs.mkdirSync(defaultPath, { recursive: true });
    config.projects.defaultPath = defaultPath;
    config.projects.list = { [path.basename(defaultPath)]: defaultPath };

    if (options.channel === 'aun' && !options.aunAid) {
      throw new Error('--aun-aid is required for AUN channel (e.g. --aun-aid mybot.agentid.pub)');
    }
    if (options.channel === 'aun' && options.aunAid) {
      // 自动安装 AUN SDK
      const { resolveAunCoreSdkPkg, npmInstallGlobal, downloadCaRoot } = await import('./init-channel.js');
      if (!resolveAunCoreSdkPkg()) {
        console.log('正在安装 @agentunion/fastaun...');
        await npmInstallGlobal('@agentunion/fastaun@latest');
      }

      // 创建 AID（如果本地不存在）
      const aunPath = path.join(os.homedir(), '.aun');
      const aidDir = path.join(aunPath, 'AIDs', options.aunAid);
      if (!fs.existsSync(path.join(aidDir, 'private'))) {
        const { AUNClient } = await import('@agentunion/fastaun');
        let client = new AUNClient({ aun_path: aunPath });
        // 让 SDK 通过 well-known 自动发现网关
        const result = await client.auth.createAid({ aid: options.aunAid });

        // 下载 CA 根证书（如果本地不存在），从 SDK 返回的实际网关 URL 派生
        const caDownloaded = await downloadCaRoot(aunPath, result.gateway || '');

        // 关键：SDK 默认 rootCaPath=null，只读取包内 bundled certs。
        // 必须显式传 root_ca_path 指向刚下载的 root.crt，uploadAgentMd 才能验证 server cert。
        // 同时传 aid，否则新 client 不知道该加载哪个身份，uploadAgentMd 会报
        // "no local identity found, call auth.createAid() first"。
        const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
        if (caDownloaded && fs.existsSync(caCertPath)) {
          try { await client.close(); } catch {}
          client = new AUNClient({ aun_path: aunPath, root_ca_path: caCertPath, aid: options.aunAid });
        }

        // 写入初始 agent.md（initialized: false）
        const agentName = options.aunAid.split('.')[0];
        const agentMd = `---\naid: "${options.aunAid}"\nname: "${agentName}"\ntype: "ai"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\ninitialized: false\n---\n`;
        const agentMdPath = path.join(aidDir, 'agent.md');
        try {
          await client.auth.uploadAgentMd(agentMd);
        } catch (e) {
          console.warn(`⚠ agent.md 网络发布失败（首次连接将自动重试）: ${String((e as any)?.message || e).slice(0, 100)}`);
        }
        fs.writeFileSync(agentMdPath, agentMd, 'utf-8');
        if (!fs.existsSync(agentMdPath)) {
          try { await client.close(); } catch {}
          throw new Error(`agent.md 写入校验失败: ${agentMdPath}`);
        }
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

  // 交互式模式
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (fs.existsSync(p.config)) {
      const answer = (await ask(rl, `配置文件已存在: ${p.config}\n  是否重新初始化？[y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('  已取消');
        return;
      }
    }

    if (!await checkEnvironment(rl)) {
      return;
    }

    console.log('📝 交互式配置\n');

    // 通用配置
    const defaultSuggestion = path.join(os.homedir(), 'evolclaw-project');
    let defaultPath = (await ask(rl, `  默认项目路径 [${defaultSuggestion}]: `)).trim();
    if (!defaultPath) defaultPath = defaultSuggestion;
    if (defaultPath.startsWith('~/')) {
      defaultPath = path.join(os.homedir(), defaultPath.slice(2));
    } else if (defaultPath === '~') {
      defaultPath = os.homedir();
    }
    if (!fs.existsSync(defaultPath)) {
      fs.mkdirSync(defaultPath, { recursive: true });
      console.log(`  ✓ 已创建目录: ${defaultPath}`);
    }

    const modelInput = (await ask(rl, '  模型 [sonnet(默认)/opus/haiku]: ')).trim().toLowerCase();
    const model = ['opus', 'haiku'].includes(modelInput) ? modelInput : 'sonnet';

    // 渠道选择（支持退回重选）
    const config = JSON.parse(fs.readFileSync(sampleSrc, 'utf-8'));
    config.projects.defaultPath = defaultPath;
    config.projects.list = { [path.basename(defaultPath)]: defaultPath };
    config.agents.anthropic.model = model;

    let channelConfigured = false;
    while (!channelConfigured) {
      console.log('\n选择消息渠道:');
      console.log('  1. 飞书 (Feishu)');
      console.log('  2. 微信 (WeChat)');
      console.log('  3. AUN (AgentUnin.Network)');
      console.log('  4. 钉钉 (DingTalk)');
      console.log('  5. QQ 机器人 (QQBot)');
      const channelChoice = (await ask(rl, '请选择 [1]: ')).trim() || '1';

      if (channelChoice === '1') {
        console.log('\n飞书配置方式:');
        console.log('  1. 扫码自动注册（推荐）');
        console.log('  2. 手动输入 App ID/Secret');
        const feishuMethod = (await ask(rl, '请选择 [1]: ')).trim() || '1';

        if (feishuMethod === '1') {
          const { runFeishuQrFlow } = await import('./init-channel.js');
          const result = await runFeishuQrFlow();
          if (!result) {
            console.log('已取消');
            return;
          }
          config.channels.feishu.appId = result.appId;
          config.channels.feishu.appSecret = result.appSecret;
          config.channels.feishu.enabled = true;
          if (result.openId) config.channels.feishu.owner = result.openId;
        } else {
          if (!await initFeishuManual(rl, config)) {
            console.log('已取消');
            return;
          }
        }
        channelConfigured = true;
        config.channels.defaultChannel = 'feishu';

      } else if (channelChoice === '2') {
        const { runWechatQrFlow } = await import('./init-channel.js');
        const result = await runWechatQrFlow();
        if (!result) {
          console.log('已取消');
          return;
        }
        config.channels.wechat = {
          enabled: true,
          baseUrl: result.baseUrl,
          token: result.token,
        };
        channelConfigured = true;
        config.channels.defaultChannel = 'wechat';

      } else if (channelChoice === '3') {
        const { checkAunEnvironment, setupAunAid } = await import('./init-channel.js');
        const aunReady = await checkAunEnvironment(rl);
        if (!aunReady) continue; // 退回重选渠道

        const result = await setupAunAid(rl, config);
        if (!result) continue;

        config.channels.aun = {
          enabled: true,
          aid: result.aid,
          owner: result.owner,
        };
        channelConfigured = true;
        config.channels.defaultChannel = 'aun';

      } else if (channelChoice === '4') {
        const { runDingtalkQrFlowSimple } = await import('./init-channel.js');
        const result = await runDingtalkQrFlowSimple();
        if (!result) {
          console.log('已取消');
          return;
        }
        config.channels.dingtalk = {
          enabled: true,
          clientId: result.clientId,
          clientSecret: result.clientSecret,
        };
        channelConfigured = true;
        config.channels.defaultChannel = 'dingtalk';

      } else if (channelChoice === '5') {
        const { runQQBotBindFlowSimple } = await import('./init-channel.js');
        const result = await runQQBotBindFlowSimple();
        if (!result) {
          console.log('已取消');
          return;
        }
        config.channels.qqbot = {
          enabled: true,
          appId: result.appId,
          clientSecret: result.clientSecret,
        };
        channelConfigured = true;
        config.channels.defaultChannel = 'qqbot';

      } else {
        console.log('  无效选择，请重新输入');
      }
    }

    // 可选：富内容渲染模块（仅 Feishu 通道需要）
    if (config.channels?.feishu?.enabled) {
      await offerRichContentRenderer(rl, config);
    }

    fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');
    console.log(`\n✓ 已创建配置文件: ${p.config}`);
    setupEnvVar(resolveRoot());
  } finally {
    rl.close();
  }
}

// ==================== Instance Selection (from init-common) ====================

export interface OverwriteChoice {
  action: 'overwrite';
  index: number;
  name: string;
}

export interface AddChoice {
  action: 'add';
  name: string;
}

export type InstanceChoice = OverwriteChoice | AddChoice;

/**
 * Present instance selection menu when existing instances are found.
 * Returns the user's choice, or null if cancelled.
 */
export async function selectInstance(
  rl: readline.Interface,
  channelType: string,
  instances: Array<{ name: string; [key: string]: any }>
): Promise<InstanceChoice | null> {
  const typeLabel = channelType === 'feishu' ? '飞书' : channelType === 'wechat' ? '微信' : channelType === 'dingtalk' ? '钉钉' : channelType === 'qqbot' ? 'QQ机器人' : 'AUN';
  console.log(`\n发现已有 ${typeLabel} 机器人：`);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const id = inst.aid || inst.appId || inst.botId || inst.clientId || inst.token?.slice(0, 16) || '';
    const suffix = id ? ` (${id})` : '';
    console.log(`  ${letters[i]}. ${inst.name}${suffix}`);
  }
  const addLetter = letters[instances.length];
  console.log(`  ${addLetter}. 添加新机器人`);
  console.log('');

  const validOptions = letters.slice(0, instances.length + 1).split('');
  let choice = '';
  while (!validOptions.includes(choice)) {
    choice = (await ask(rl, '请选择: ')).trim().toLowerCase();
    if (!validOptions.includes(choice)) {
      console.log(`无效选择，请输入 ${validOptions.join('/')}`);
    }
  }

  const choiceIndex = letters.indexOf(choice);
  if (choiceIndex === instances.length) {
    // Add new — ask for name
    let name = '';
    while (!name) {
      name = (await ask(rl, '请输入新机器人名称: ')).trim();
      if (!name) console.log('  名称不能为空');
      if (instances.some(i => i.name === name)) {
        console.log(`  名称 "${name}" 已存在，请换一个`);
        name = '';
      }
    }
    return { action: 'add', name };
  }

  // Overwrite — requires confirmation
  const target = instances[choiceIndex];
  console.log(`\n已选择：${target.name}`);
  const confirm = (await ask(rl, `⚠️ 即将覆盖该机器人配置，确认？(y/N) `)).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('已取消');
    return null;
  }

  return { action: 'overwrite', index: choiceIndex, name: target.name };
}

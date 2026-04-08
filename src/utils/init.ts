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

async function checkAunEnvironment(rl: readline.Interface): Promise<boolean> {
  console.log('\n🔍 AUN 环境检查...\n');

  // Check python3
  if (!commandExists('python3')) {
    console.log('  ✗ python3 未找到');
    console.log('  → 请先安装 Python 3: https://www.python.org/downloads/');
    const answer = (await ask(rl, '  → 返回重新选择渠道？[Y/n] ')).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') process.exit(0);
    return false;
  }
  console.log('  ✓ python3');

  // Check aun_core
  try {
    execFileSync('python3', ['-c', 'import aun_core'], { encoding: 'utf-8', stdio: 'pipe' });
    console.log('  ✓ aun_core');
  } catch {
    console.log('  - aun_core 未安装');
    const answer = (await ask(rl, '  → 是否自动安装 aun-core？[Y/n] ')).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      const back = (await ask(rl, '  → 返回重新选择渠道？[Y/n] ')).trim().toLowerCase();
      if (back === 'n' || back === 'no') process.exit(0);
      return false;
    }

    console.log('  正在安装 aun-core（可能需要 1-2 分钟）...');
    try {
      await execFileAsync('pip3', ['install', '--user', 'aun-core'], { timeout: 120000 });
      console.log('  ✓ aun-core 安装完成');
    } catch (e: any) {
      const msg = e.message || '';
      if (e.killed || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        console.log('  ✗ 安装超时，网络可能较慢');
      } else {
        console.log(`  ✗ 安装失败: ${msg.slice(0, 200)}`);
      }
      console.log('  → 可手动安装: pip3 install aun-core');
      const back = (await ask(rl, '  → 返回重新选择渠道？[Y/n] ')).trim().toLowerCase();
      if (back === 'n' || back === 'no') process.exit(0);
      return false;
    }
  }

  console.log('');
  return true;
}

// ==================== Rich Content Renderer ====================

async function offerRichContentRenderer(rl: readline.Interface): Promise<void> {
  const answer = (await ask(rl, '\n是否启用 LaTeX + Mermaid 渲染模块（约 35MB）？[y/N] ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return;

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
  }
}

// ==================== Init AUN (standalone) ====================

export async function cmdInitAun(): Promise<void> {
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log('❌ 配置文件不存在，请先运行 evolclaw init');
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (config.channels?.aun?.aid) {
      const answer = (await ask(rl, '已有 AUN 配置，是否重新配置？[y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('已取消');
        return;
      }
    }

    if (!await checkAunEnvironment(rl)) {
      return;
    }

    let aid = '';
    while (!aid) {
      aid = (await ask(rl, '  AUN Agent ID (例: mybot.agentid.pub): ')).trim();
      if (!aid) console.log('  ⚠ 不能为空');
    }

    const gatewayUrl = (await ask(rl, '  Gateway URL [留空使用默认]: ')).trim() || undefined;
    const accessToken = (await ask(rl, '  Access Token [留空跳过]: ')).trim() || undefined;

    if (!config.channels) config.channels = {};
    config.channels.aun = {
      enabled: true,
      aid,
      ...(gatewayUrl && { gatewayUrl }),
      ...(accessToken && { accessToken }),
    };
    if (!config.channels.defaultChannel) config.channels.defaultChannel = 'aun';

    fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');
    console.log('\n✓ AUN 配置已写入');
  } finally {
    rl.close();
  }
}

// ==================== Main ====================

export async function cmdInit() {
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
      const channelChoice = (await ask(rl, '请选择 [1]: ')).trim() || '1';

      if (channelChoice === '1') {
        console.log('\n飞书配置方式:');
        console.log('  1. 扫码自动注册（推荐）');
        console.log('  2. 手动输入 App ID/Secret');
        const feishuMethod = (await ask(rl, '请选择 [1]: ')).trim() || '1';

        if (feishuMethod === '1') {
          const { runFeishuQrFlow } = await import('./init-feishu.js');
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
        const { runWechatQrFlow } = await import('./init-wechat.js');
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
        const aunReady = await checkAunEnvironment(rl);
        if (!aunReady) continue; // 退回重选渠道

        let aid = '';
        while (!aid) {
          aid = (await ask(rl, '  AUN Agent ID (例: mybot.agentid.pub): ')).trim();
          if (!aid) console.log('  ⚠ 不能为空');
        }

        const gatewayUrl = (await ask(rl, '  Gateway URL [留空使用默认]: ')).trim() || undefined;
        const accessToken = (await ask(rl, '  Access Token [留空跳过]: ')).trim() || undefined;

        config.channels.aun = {
          enabled: true,
          aid,
          ...(gatewayUrl && { gatewayUrl }),
          ...(accessToken && { accessToken }),
        };
        channelConfigured = true;
        config.channels.defaultChannel = 'aun';

      } else {
        console.log('  无效选择，请重新输入');
      }
    }

    // 可选：富内容渲染模块
    await offerRichContentRenderer(rl);

    fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');
    console.log(`\n✓ 已创建配置文件: ${p.config}`);
    setupEnvVar(resolveRoot());
  } finally {
    rl.close();
  }
}

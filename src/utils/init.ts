import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { resolvePaths, ensureDataDirs, getPackageRoot } from '../paths.js';
import { isWindows, commandExists } from './cross-platform.js';
import { scanInstances } from './instance-registry.js';

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

  const aliveMains = scanInstances().mains.filter(m => m.alive);
  if (aliveMains.length > 0) {
    const pids = aliveMains.map(m => m.record.pid).join(', ');
    console.log(`❌ EvolClaw 正在运行 (PID: ${pids})，请先执行 evolclaw stop`);
    return;
  }

  // ── 1. 环境检查：至少有一款 baseagent CLI 可用 ──
  const baseagents = [
    { name: 'Claude Code', cmd: 'claude' },
    { name: 'CodeX', cmd: 'codex' },
    { name: 'OpenClaw', cmd: 'openclaw' },
    { name: 'Hermes', cmd: 'hermes' },
    { name: 'Gemini', cmd: 'gemini' },
  ];

  const available = baseagents.filter(b => commandExists(b.cmd));
  if (available.length === 0) {
    console.log('❌ 未检测到任何 baseagent CLI。请先安装至少一款：');
    console.log('');
    for (const b of baseagents) {
      console.log(`  - ${b.name} (${b.cmd})`);
    }
    console.log('');
    console.log('安装后重新运行 evolclaw init');
    return;
  }

  console.log('✓ 检测到可用的 baseagent:');
  for (const b of available) {
    console.log(`  ● ${b.name} (${b.cmd})`);
  }
  console.log('');

  // ── 2. 创建 agents/defaults.json ──
  const defaultsPath = path.join(p.agentsDir, 'defaults.json');

  if (options?.nonInteractive) {
    // 非交互式：直接写最小模板
    const defaultPath = options.defaultPath || path.join(os.homedir(), 'projects', 'default');
    if (!fs.existsSync(defaultPath)) fs.mkdirSync(defaultPath, { recursive: true });

    const defaults = {
      $schema_version: 1,
      active_baseagent: available[0].cmd === 'claude' ? 'claude' : available[0].cmd,
      baseagents: {
        claude: { apiKey: '$ENV:ANTHROPIC_API_KEY' },
      },
      projects: { defaultPath },
    };

    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2) + '\n');
    console.log(`✓ 已创建: ${defaultsPath}`);
    printNextSteps(available);
    return;
  }

  // 交互式
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (fs.existsSync(defaultsPath)) {
      const answer = (await ask(rl, `配置文件已存在: ${defaultsPath}\n  是否重新初始化？[y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('  已取消');
        return;
      }
    }

    // 默认项目路径
    const defaultSuggestion = path.join(os.homedir(), 'projects', 'default');
    let defaultPath = (await ask(rl, `默认项目路径 [${defaultSuggestion}]: `)).trim();
    if (!defaultPath) defaultPath = defaultSuggestion;
    if (defaultPath.startsWith('~/')) defaultPath = path.join(os.homedir(), defaultPath.slice(2));
    if (!fs.existsSync(defaultPath)) {
      fs.mkdirSync(defaultPath, { recursive: true });
      console.log(`  ✓ 已创建: ${defaultPath}`);
    }

    // 选择默认 baseagent
    const defaultBaseagent = available.find(b => b.cmd === 'claude') ? 'claude' : available[0].cmd;
    const baInput = (await ask(rl, `默认 baseagent [${defaultBaseagent}]: `)).trim() || defaultBaseagent;

    const defaults = {
      $schema_version: 1,
      active_baseagent: baInput,
      baseagents: {
        claude: { apiKey: '$ENV:ANTHROPIC_API_KEY' },
        ...(baInput === 'codex' && { codex: { apiKey: '$ENV:OPENAI_API_KEY' } }),
        ...(baInput === 'gemini' && { gemini: { apiKey: '$ENV:GEMINI_API_KEY' } }),
      },
      projects: { defaultPath },
    };

    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2) + '\n');
    console.log(`\n✓ 已创建: ${defaultsPath}`);

    rl.close();
    printNextSteps(available);
  } finally {
    try { rl.close(); } catch {}
  }
}

function printNextSteps(available: Array<{ name: string; cmd: string }>): void {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('下一步：创建你的第一个 Agent');
  console.log('');
  console.log('  1. 下载 Evol App（https://evolai.cn）');
  console.log('  2. 在 App 中创建 Agent，获取引导文本');
  console.log(`  3. 将引导文本输入给 ${available[0].name} 执行：`);
  console.log('');
  console.log(`     ${available[0].cmd}`);
  console.log('');
  console.log('  或者手动创建：');
  console.log('');
  console.log('     evolclaw agent new <your-aid>.agentid.pub');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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

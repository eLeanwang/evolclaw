import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { resolvePaths, ensureDataDirs } from '../paths.js';
import { commandExists } from '../utils/cross-platform.js';
import { scanInstances } from '../utils/instance-registry.js';
import { saveDefaultsSafe, loadAllAgents, migrateProcessConfigIfNeeded } from '../config-store.js';
import { isCodexSdkAvailable } from '../agents/codex-runner.js';

// ==================== Helpers ====================

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

const BASEAGENT_CANDIDATES = ['claude', 'codex', 'gemini'] as const;
type Baseagent = typeof BASEAGENT_CANDIDATES[number];

function isBaseagentAvailable(baseagent: Baseagent): boolean {
  if (baseagent === 'codex') return isCodexSdkAvailable();
  return commandExists(baseagent);
}

function detectAvailable(): Baseagent[] {
  return BASEAGENT_CANDIDATES.filter(isBaseagentAvailable);
}

function pickDefault(available: Baseagent[]): Baseagent {
  return (available.includes('claude') ? 'claude' : available[0]) as Baseagent;
}

function buildDefaults(chosen: Baseagent, available: Baseagent[], projectsDefaultPath?: string) {
  const baseagents: Record<string, object> = {};
  for (const b of available) baseagents[b] = {};
  return {
    $schema_version: 1,
    active_baseagent: chosen,
    baseagents,
    ...(projectsDefaultPath ? { projects: { defaultPath: projectsDefaultPath } } : {}),
  };
}

function writeDefaults(chosen: Baseagent, available: Baseagent[], projectsDefaultPath?: string): void {
  saveDefaultsSafe(buildDefaults(chosen, available, projectsDefaultPath));
}

// ==================== Main ====================

export async function cmdInit(options?: {
  nonInteractive?: boolean;
  baseagent?: string;
  force?: boolean;
}): Promise<void> {
  const p = resolvePaths();
  ensureDataDirs();
  // config.json → evolclaw.json：init 路径也可能先于 daemon 触发 AID 生成（走 getAidStore），
  // 须在任何 getAidStore 之前迁移 encryptionSeed。
  migrateProcessConfigIfNeeded();

  // ── 1. 单进程互斥 ──
  const aliveMains = scanInstances().mains.filter(m => m.alive);
  if (aliveMains.length > 0) {
    const pids = aliveMains.map(m => m.record.pid).join(', ');
    console.log(`❌ EvolClaw 正在运行 (PID: ${pids})，请先执行 evolclaw stop`);
    return;
  }

  // ── 2. 探测 baseagent ──
  const available = detectAvailable();
  if (available.length === 0) {
    console.log('❌ 未检测到可用 baseagent。请安装至少一款：');
    console.log('  - claude CLI');
    console.log('  - gemini CLI');
    console.log('  - optional dependency @openai/codex-sdk');
    console.log('\n安装后重新运行 evolclaw init');
    return;
  }

  console.log('检测到可用的 baseagent:');
  for (const b of available) console.log(`  ● ${b}`);
  console.log('');

  const defaultsPath = p.defaultsConfig;
  const exists = fs.existsSync(defaultsPath);

  // ── 3. 非交互式分支 ──
  if (options?.nonInteractive) {
    if (exists && !options.force) {
      console.log(`❌ 配置已存在: ${defaultsPath}（加 --force 可覆盖）`);
      return;
    }

    let chosen: Baseagent;
    if (options.baseagent) {
      if (!BASEAGENT_CANDIDATES.includes(options.baseagent as Baseagent)) {
        console.log(`❌ 无效 baseagent: ${options.baseagent}（可选: ${BASEAGENT_CANDIDATES.join('/')}）`);
        return;
      }
      if (!available.includes(options.baseagent as Baseagent)) {
        console.log(`❌ ${options.baseagent} 当前环境不可用（可用: ${available.join('/')}）`);
        return;
      }
      chosen = options.baseagent as Baseagent;
    } else {
      chosen = pickDefault(available);
    }

    writeDefaults(chosen, available);
    console.log(`✓ 已${exists ? '覆盖' : '创建'}: ${defaultsPath}`);
    console.log(`  active_baseagent: ${chosen}`);

    const { agents } = loadAllAgents();
    if (agents.length === 0) {
      console.log('\n提示：尚无 agent，运行以下命令创建：');
      console.log('  evolclaw agent new <aid>.agentid.pub');
    }
    return;
  }

  // ── 4. 交互式分支 ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async function askBaseagent(): Promise<Baseagent> {
    const defaultBa = pickDefault(available);
    if (available.length === 1) {
      console.log(`  baseagent: ${defaultBa}`);
      return defaultBa;
    }
    let chosen: Baseagent | null = null;
    while (chosen === null) {
      const input = (await ask(rl, `默认 baseagent (${available.join('/')}) [${defaultBa}]: `)).trim() || defaultBa;
      if (!BASEAGENT_CANDIDATES.includes(input as Baseagent)) {
        console.log(`  无效选择，可选: ${BASEAGENT_CANDIDATES.join('/')}`);
        continue;
      }
      if (!available.includes(input as Baseagent)) {
        console.log(`  ${input} 当前环境不可用（可用: ${available.join('/')}）`);
        continue;
      }
      chosen = input as Baseagent;
    }
    return chosen;
  }

  async function askProjectsDefaultPath(): Promise<string | undefined> {
    const defaultDir = path.join(p.root, 'projects', 'default');
    const input = (await ask(rl, `项目默认目录 [${defaultDir}]: `)).trim();
    const resolved = input || defaultDir;
    if (!path.isAbsolute(resolved)) {
      console.log('  ⚠ 需要绝对路径，已跳过');
      return undefined;
    }
    if (!fs.existsSync(resolved)) {
      const create = (await ask(rl, `  目录不存在，是否创建？[Y/n]: `)).trim().toLowerCase();
      if (create === '' || create === 'y' || create === 'yes') {
        fs.mkdirSync(resolved, { recursive: true });
        console.log(`  ✓ 已创建 ${resolved}`);
      } else {
        return undefined;
      }
    }
    return resolved;
  }

  try {
    if (exists) {
      const ans = (await ask(rl, `配置文件已存在: ${defaultsPath}\n  是否覆盖？[y/N] `)).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') {
        const chosen = await askBaseagent();
        const projectsDefaultPath = await askProjectsDefaultPath();
        writeDefaults(chosen, available, projectsDefaultPath);
        console.log(`\n✓ 已覆盖: ${defaultsPath}`);
        console.log(`  active_baseagent: ${chosen}\n`);
      } else {
        console.log('  已跳过（保留现有配置）\n');
      }
    } else {
      const chosen = await askBaseagent();
      const projectsDefaultPath = await askProjectsDefaultPath();
      writeDefaults(chosen, available, projectsDefaultPath);
      console.log(`\n✓ 已创建: ${defaultsPath}`);
      console.log(`  active_baseagent: ${chosen}\n`);
    }

    // ── 5. 提示创建 agent ──
    const { agents } = loadAllAgents();
    if (agents.length === 0) {
      console.log('提示：尚无 agent，运行以下命令创建：');
      console.log('  evolclaw agent new <aid>.agentid.pub');
    }
  } finally {
    try { rl.close(); } catch { /* ignore */ }
  }
}

// ==================== Instance Selection (shared with init-channel) ====================

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
  instances: Array<{ name: string;[key: string]: any }>
): Promise<InstanceChoice | null> {
  const typeLabel = channelType === 'feishu' ? '飞书' : channelType === 'wechat' ? '微信' : channelType === 'dingtalk' ? '钉钉' : channelType === 'qqbot' ? 'QQ机器人' : channelType === 'wecom' ? '企业微信' : channelType.toUpperCase();
  console.log(`\n发现已有 ${typeLabel} 配置：`);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const id = inst.aid || inst.appId || inst.botId || inst.clientId || inst.token?.slice(0, 16) || '';
    const suffix = id ? ` (${id})` : '';
    console.log(`  ${letters[i]}. ${inst.name}${suffix}`);
  }
  const addLetter = letters[instances.length];
  console.log(`  ${addLetter}. 添加新配置`);
  console.log('');

  const validOptions = letters.slice(0, instances.length + 1).split('');
  let choice = '';
  while (!validOptions.includes(choice)) {
    choice = (await new Promise<string>(r => rl.question('请选择: ', r))).trim().toLowerCase();
    if (!validOptions.includes(choice)) {
      console.log(`无效选择，请输入 ${validOptions.join('/')}`);
    }
  }

  const choiceIndex = letters.indexOf(choice);
  if (choiceIndex === instances.length) {
    let name = '';
    while (!name) {
      name = (await new Promise<string>(r => rl.question('请输入新配置名称: ', r))).trim();
      if (!name) console.log('  名称不能为空');
      if (instances.some(i => i.name === name)) {
        console.log(`  名称 "${name}" 已存在，请换一个`);
        name = '';
      }
    }
    return { action: 'add', name };
  }

  const target = instances[choiceIndex];
  console.log(`\n已选择：${target.name}`);
  const confirm = (await new Promise<string>(r => rl.question(`⚠️ 即将覆盖该配置，确认？(y/N) `, r))).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('已取消');
    return null;
  }

  return { action: 'overwrite', index: choiceIndex, name: target.name };
}

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { resolvePaths, ensureDataDirs } from '../paths.js';
import { commandExists } from '../utils/cross-platform.js';
import { scanInstances } from '../utils/instance-registry.js';
import { saveDefaultsSafe, loadAllAgents, migrateProcessConfigIfNeeded, loadEvolclawConfig, saveEvolclawConfig } from '../config-store.js';
import { generateControlAid } from '../aun/aid/control-aid.js';
import { getCodexAppServerAvailability, isCodexAppServerAvailable } from '../agents/codex-runner.js';

// ==================== Helpers ====================

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

const BASEAGENT_CANDIDATES = ['claude', 'codex', 'gemini'] as const;
type Baseagent = typeof BASEAGENT_CANDIDATES[number];

function isBaseagentAvailable(baseagent: Baseagent): boolean {
  if (baseagent === 'codex') return isCodexAppServerAvailable();
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

/** 启动门禁判定：缺控制 AID 且处于交互式终端时，应进 init 向导补全。
 *  非 TTY（restart-monitor/systemd/管道）即使缺 aid 也不进 init（无法交互），由 daemon 侧 warn 兜底。 */
export function needsControlAidInit(aid: string | undefined, isTty: boolean): boolean {
  return !aid && isTty;
}

/** 解析用户输入的 owner AID 列表：按空白/逗号分隔，去空、去重、按 isValid 分流。
 *  空输入 → valid:[]（视为跳过）。 */
export function parseOwnerAids(raw: string, isValid: (aid: string) => boolean): { valid: string[]; invalid: string[] } {
  const tokens = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    if (isValid(t)) {
      if (!valid.includes(t)) valid.push(t);
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid };
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
    console.log('  - codex CLI with app-server');
    console.log('\n安装后重新运行 evolclaw init');
    return;
  }

  console.log('检测到可用的 baseagent:');
  for (const b of available) console.log(`  ● ${b}`);
  console.log('');

  const defaultsPath = p.defaultsConfig;
  const defaultsExisted = fs.existsSync(defaultsPath);
  // “已初始化”以 evolclaw.json 为准：文件存在且控制 AID 已生成。
  // 删除 evolclaw.json（aid 丢失）即视为未初始化，向导会重新补全 aid + owners。
  const initialized = fs.existsSync(p.evolclawJson) && !!loadEvolclawConfig().aid;

  // ── 3. 非交互式分支 ──
  if (options?.nonInteractive) {
    if (initialized && !options.force) {
      // 已初始化（evolclaw.json + aid）且未 --force：不重写 defaults，但仍落到共享 tail（幂等补全）
      console.log(`配置已存在: ${p.evolclawJson}（加 --force 可覆盖）`);
    } else {
      let chosen: Baseagent;
      if (options.baseagent) {
        if (!BASEAGENT_CANDIDATES.includes(options.baseagent as Baseagent)) {
          console.log(`❌ 无效 baseagent: ${options.baseagent}（可选: ${BASEAGENT_CANDIDATES.join('/')}）`);
          return; // 硬错误：不落 tail
        }
        if (!available.includes(options.baseagent as Baseagent)) {
          const reason = options.baseagent === 'codex'
            ? getCodexAppServerAvailability().reason
            : undefined;
          console.log(`❌ ${options.baseagent} 当前环境不可用${reason ? `：${reason}` : `（可用: ${available.join('/')}）`}`);
          return; // 硬错误：不落 tail
        }
        chosen = options.baseagent as Baseagent;
      } else {
        chosen = pickDefault(available);
      }

      writeDefaults(chosen, available);
      console.log(`✓ 已${defaultsExisted ? '覆盖' : '创建'}: ${defaultsPath}`);
      console.log(`  active_baseagent: ${chosen}`);
    }
    // 落到共享 tail（不 return）
  } else {
    // ── 4. 交互式分支（rl 生命周期封装在内部函数，tail 不引用 rl）──
    await runInteractive();
  }

  // ── 共享 tail（单一出口）：提示创建 agent + 生成控制 AID ──
  // 种入网关配置：从 env / settings.json 导入 baseUrl+apiKey 到 defaults（幂等）
  const { reconcileBaseagentDefaults } = await import('../core/baseagent-seed.js');
  const seedResult = reconcileBaseagentDefaults();
  if (seedResult.seeded) {
    console.log(`✓ 网关配置已导入 defaults（baseUrl: ${seedResult.baseUrl || '—'}，来源: ${seedResult.source || '—'}）`);
    if (seedResult.deletedFromSettings.length > 0) {
      console.log(`  已从 ~/.claude/settings.json 移除: ${seedResult.deletedFromSettings.join(', ')}`);
    }
  }

  await initTail();

  // ── 内部函数 ──

  async function runInteractive(): Promise<void> {
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
      if (defaultsExisted) {
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
    } finally {
      try { rl.close(); } catch { /* ignore */ }
    }
  }

}

/** 补全控制 AID + owners（可单独调用，不走 baseagent 向导）。 */
export async function initTail(): Promise<void> {
  // 提示创建 agent（两分支汇合后执行一次）
  const { agents } = loadAllAgents();
  if (agents.length === 0) {
    console.log('\n提示：尚无 agent，运行以下命令创建：');
    console.log('  evolclaw agent new <aid>.agentid.pub');
  }

  // 控制 AID：daemon 进程身份。缺失则生成并写回 evolclaw.json（幂等：已存在则跳过）。
  const evc = loadEvolclawConfig();
  if (evc.aid) {
    console.log(`✓ 控制 AID 已存在: ${evc.aid}`);
  } else {
    try {
      const { aid } = await generateControlAid();
      saveEvolclawConfig({ ...evc, $schema_version: evc.$schema_version ?? 1, aid });
      console.log(`✓ 已生成控制 AID: ${aid}`);
    } catch (e: any) {
      console.error(`⚠️ 控制 AID 生成失败（Gateway 不可达？联网后重跑 evolclaw init 补全）: ${e?.message || e}`);
    }
  }

  // 配置进程级管理者（owners）：仅交互式 + aid 已配置 + owners 未配置时询问
  const evcForOwners = loadEvolclawConfig();
  if (process.stdin.isTTY && evcForOwners.aid && (!evcForOwners.owners || evcForOwners.owners.length === 0)) {
    console.log('\n📡 进程级管理者绑定 — 请用 evol app 扫描二维码\n');
    try {
      const { runDaemonOwnerQrBindFlow } = await import('./init-channel.js');
      const result = await runDaemonOwnerQrBindFlow('append');
      if (result?.boundAid) {
        console.log(`  ✓ 已配置管理者: ${result.boundAid}`);
      } else {
        await promptOwnersManually();
      }
    } catch (e: any) {
      console.log(`  ⚠ 扫码绑定不可用: ${e?.message || e}`);
      await promptOwnersManually();
    }
  }

  async function promptOwnersManually(): Promise<void> {
    const { isValidAid } = await import('../aun/aid/index.js');
    const rlOwners = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const raw = (await ask(rlOwners,
        '\n请输入 EvolClaw 管理者 AID: ')).trim();
      if (raw) {
        const { valid, invalid } = parseOwnerAids(raw, isValidAid);
        if (invalid.length > 0) console.log(`  ⚠ 跳过非法 AID: ${invalid.join(', ')}`);
        if (valid.length > 0) {
          saveEvolclawConfig({ ...loadEvolclawConfig(), owners: valid });
          console.log(`  ✓ 已配置管理者: ${valid.join(', ')}`);
        } else {
          console.log('  未输入合法 AID，已跳过 owners 配置');
        }
      } else {
        console.log('  已跳过 owners 配置（可日后编辑 evolclaw.json 或重跑 evolclaw init）');
      }
    } finally {
      try { rlOwners.close(); } catch { /* ignore */ }
    }
  }

  // ECWeb：交互式 + 未配置时询问是否启用
  if (process.stdin.isTTY) {
    const evcEcweb = loadEvolclawConfig();
    if (evcEcweb.ecweb?.enabled === undefined) {
      const rlEcweb = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (await ask(rlEcweb, '\n是否在 evolclaw start 时自动启动 ECWeb 控制台？[y/N] ')).trim().toLowerCase();
        if (ans === 'y' || ans === 'yes') {
          saveEvolclawConfig({ ...loadEvolclawConfig(), ecweb: { enabled: true } });
          console.log('  ✓ 已启用 ECWeb（evolclaw start 将自动在后台启动）');
          console.log('  提示：首次访问运行 ec watch web 查看配对码和 URL');
        } else {
          saveEvolclawConfig({ ...loadEvolclawConfig(), ecweb: { enabled: false } });
          console.log('  已跳过（可日后运行 ec watch web 手动启动，或编辑 evolclaw.json）');
        }
      } finally {
        try { rlEcweb.close(); } catch {}
      }
    }
  }

  // 初始化完成总结
  console.log('\n✓ EvolClaw 初始化完成');
  const finalCfg = loadEvolclawConfig();
  console.log(`  控制 AID: ${finalCfg.aid || '(未配置)'}`);
  console.log(`  管理者: ${finalCfg.owners?.join(', ') || '(未配置)'}`);
  console.log(`  ECWeb 自启动: ${finalCfg.ecweb?.enabled ? '已启用' : '已禁用'}`);

  const { agents: finalAgents } = loadAllAgents();
  if (finalAgents.length === 0) {
    console.log('\n📌 下一步：创建 agent');
    console.log('  evolclaw agent new <your-aid>.agentid.pub');
    console.log('  evolclaw init feishu    # 绑定飞书');
    console.log('  evolclaw start          # 启动服务');
  } else {
    console.log(`\n✓ 已有 ${finalAgents.length} 个 agent，可直接运行:`);
    console.log('  evolclaw start');
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

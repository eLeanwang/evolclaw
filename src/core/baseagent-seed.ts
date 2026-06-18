/**
 * baseagent-seed.ts — 网关配置种入（reconcile）。
 *
 * 幂等函数 `reconcileBaseagentDefaults()`：
 *   - 若 defaults.baseagents.claude.baseUrl 已有非空值 → 跳过（已种入或手动配）
 *   - 若为空 → 按优先级从 process.env / ~/.claude/settings.json 读取 baseUrl+apiKey
 *   - 种入 defaults.baseagents.claude（saveDefaultsSafe 深合并 + 自动备份）
 *   - 若来源是 settings.json → 删除 settings.json 的 env 块中已导入的 key（消除 #8500 覆盖风险）
 *
 * 设计动机详见 plan：
 *   Claude Code v2.0.1 起 settings.json env 块覆盖进程环境变量，evolclaw 注入的
 *   ANTHROPIC_BASE_URL 会被压制。本模块把 settings.json 的值"提前收编"到 evolclaw 的
 *   显式配置里，再删掉 settings.json 里的源——环境变量重新生效。
 *
 * 调用点：install/init、daemon 启动、agent create（均幂等，多次调用安全）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolvePaths } from '../paths.js';
import { saveDefaultsSafe } from '../config-store.js';
import { logger } from '../utils/logger.js';

// ── Settings.json 读写 ──

const SETTINGS_PATH = () => path.join(os.homedir(), '.claude', 'settings.json');

function readClaudeSettings(): any {
  try {
    const p = SETTINGS_PATH();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return null;
}

function writeClaudeSettings(settings: any): void {
  const p = SETTINGS_PATH();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}

// ── Defaults 原始读取（不走 expandEnvRefs，看盘上原始值） ──

function readDefaultsRaw(): any {
  try {
    const p = path.join(resolvePaths().agentsDir, 'defaults.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return null;
}

// ── 占位 URL 判断（复用 baseagent.ts 逻辑） ──

function isPlaceholderUrl(v: string | undefined): boolean {
  if (!v) return true;
  return v.includes('api.anthropic.com');
}

// ── Core ──

export interface ReconcileResult {
  seeded: boolean;
  baseUrl?: string;
  apiKey?: string;         // 种入的 key 引用（$ENV:...）或掩码
  source?: 'env' | 'settings';
  deletedFromSettings: string[];  // 从 settings.json 删除的 key 名
}

/**
 * 幂等 reconcile：若 defaults 缺 baseUrl/apiKey，从 env / settings.json 导入。
 * 导入后删除 settings.json 的对应 env key（消除 #8500 覆盖）。
 */
export function reconcileBaseagentDefaults(): ReconcileResult {
  const result: ReconcileResult = { seeded: false, deletedFromSettings: [] };

  // 1. 读 defaults 原始值（未展开 $ENV）
  const defaults = readDefaultsRaw();
  const claudeBlock = defaults?.baseagents?.claude;
  const currentBaseUrl = claudeBlock?.baseUrl;
  const currentApiKey = claudeBlock?.apiKey;

  // 已有非空 baseUrl → 跳过（幂等）
  if (currentBaseUrl && !isPlaceholderUrl(currentBaseUrl)) {
    return result;
  }

  // 2. 从 process.env / settings.json 取候选
  const settings = readClaudeSettings();
  const settingsEnv = settings?.env as Record<string, string> | undefined;

  // baseUrl 优先级：process.env > settings.json env 块
  const envBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const settingsBaseUrl = settingsEnv?.ANTHROPIC_BASE_URL;

  const candidateBaseUrl = (!isPlaceholderUrl(envBaseUrl) ? envBaseUrl : undefined)
    || (!isPlaceholderUrl(settingsBaseUrl) ? settingsBaseUrl : undefined);

  // apiKey 优先级：process.env > settings.json env 块
  const envApiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  const settingsApiKey = settingsEnv?.ANTHROPIC_AUTH_TOKEN;
  const candidateApiKey = envApiKey || settingsApiKey;

  if (!candidateBaseUrl && !candidateApiKey) {
    return result;  // 无候选，跳过
  }

  // 3. 种入 defaults.baseagents.claude
  const patch: Record<string, unknown> = {};

  if (candidateBaseUrl && !currentBaseUrl) {
    patch.baseUrl = candidateBaseUrl;
    result.baseUrl = candidateBaseUrl;
    result.source = (candidateBaseUrl === envBaseUrl && envBaseUrl) ? 'env' : 'settings';
  }

  if (candidateApiKey && !currentApiKey) {
    // apiKey 存为 $ENV 引用而非明文（与网关模块策略一致）
    if (candidateApiKey === envApiKey && envApiKey) {
      patch.apiKey = '$ENV:ANTHROPIC_AUTH_TOKEN';
      result.apiKey = '$ENV:ANTHROPIC_AUTH_TOKEN';
    } else {
      patch.apiKey = '$ENV:ANTHROPIC_AUTH_TOKEN';
      result.apiKey = '$ENV:ANTHROPIC_AUTH_TOKEN';
    }
  }

  if (Object.keys(patch).length === 0) {
    return result;
  }

  try {
    saveDefaultsSafe({ baseagents: { claude: patch } } as any);
    result.seeded = true;
    logger.info(`[baseagent-seed] 种入 defaults.baseagents.claude: ${Object.keys(patch).join(', ')}（来源: ${result.source || 'env'}）`);
  } catch (e) {
    logger.warn(`[baseagent-seed] 写入 defaults 失败: ${e}`);
    return result;
  }

  // 4. 若来源是 settings.json → 【已禁用删除】保留 settings.json 以兼容 claude cli
  if (settings && settingsEnv) {
    const keysToMigrate: string[] = [];

    if (patch.baseUrl && settingsBaseUrl && !isPlaceholderUrl(settingsBaseUrl)) {
      keysToMigrate.push('ANTHROPIC_BASE_URL');
    }
    if (patch.apiKey && settingsApiKey) {
      keysToMigrate.push('ANTHROPIC_AUTH_TOKEN');
    }

    if (keysToMigrate.length > 0) {
      logger.info(`[baseagent-seed] 已从 ~/.claude/settings.json 迁移配置: ${keysToMigrate.join(', ')} → defaults.json (原 settings.json 保留以兼容 claude cli)`);
      result.deletedFromSettings = []; // 不再删除，返回空数组
    }
  }

  return result;
}

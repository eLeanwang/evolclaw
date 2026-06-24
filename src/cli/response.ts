/**
 * `evolclaw response` —— 响应模式管理命令集。
 *
 * 查看/切换/配置会话的响应模式。作用域由 --self/--peer 决定。
 *
 * 三级作用域（越具体越优先：关系 > agent > 全局）：
 *   (无)             → 全局   defaults.json
 *   --self           → agent  config.json
 *   --self --peer    → 关系   relations/<peerKey>/config.json
 *
 * 改某作用域后，对应范围所有会话的下一条消息即时生效。
 * 设计见 docs/response-system/command-reference.md。
 */

import { isHelpFlag, wantsHelp, getArgValue } from './help.js';
import {
  readField, writeField, determineFieldScope, normalizePeer, ModelScopeError,
  type ScopeSelector,
} from '../core/model/field-scope.js';
import { BUILTIN_MODE_META, findBuiltinMeta } from '../response-modes/builtin-meta.js';
import type { ResponseModesConfig } from '../types.js';

const FIELD = 'response_modes';

function emit(formatJson: boolean, payload: any, textFn: () => string): void {
  if (formatJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(textFn());
  }
}

function fail(formatJson: boolean, code: string, message: string): never {
  if (formatJson) {
    console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
  } else {
    console.error(`❌ ${message} (${code})`);
  }
  process.exit(1);
}

/** 解析 --self / --peer 为作用域选择器 */
function parseSelector(args: string[], formatJson: boolean): ScopeSelector {
  const self = getArgValue(args, '--self');
  const peerRaw = getArgValue(args, '--peer');
  let peerKey: string | undefined;
  if (peerRaw !== undefined) {
    try { peerKey = normalizePeer(peerRaw); }
    catch (e) { if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message); throw e; }
  }
  if (peerKey && !self) {
    fail(formatJson, 'PEER_WITHOUT_SELF', '--peer 必须配合 --self 使用');
  }
  return { self, peerKey };
}

/**
 * 写操作的作用域解析：要求至少 agent 级（--self）。
 * response_modes 是行为参数，不落 defaults（与 model 命令一致，全局作用域已退场）。
 */
function parseWriteSelector(args: string[], formatJson: boolean): ScopeSelector {
  const sel = parseSelector(args, formatJson);
  if (!sel.self) {
    fail(formatJson, 'SELF_REQUIRED', 'response_modes 从 agent 级起：写操作必须提供 --self（全局默认不承载行为参数）');
  }
  return sel;
}

/** 统一捕获写入异常（ConfigError / ModelScopeError），显示友好错误 */
function safeWrite(formatJson: boolean, fn: () => void): void {
  try {
    fn();
  } catch (e: any) {
    const code = e?.code ?? 'WRITE_FAILED';
    const msg = e?.message ?? String(e);
    fail(formatJson, code, msg);
  }
}

/** 读取指定作用域生效的 response_modes 配置 */
function readConfig(sel: ScopeSelector): ResponseModesConfig | undefined {
  const scope = determineFieldScope(sel);
  return readField<ResponseModesConfig>(scope, sel, FIELD);
}

const HELP = `用法: evolclaw response <command> [options]

Commands:
  list                列出所有响应模式（内置 + 元数据）
  current             显示当前作用域生效的默认模式 + 配置
  info <mode-id>      查看单个模式详情（场景/配置参数）
  set <mode-id>       设置默认模式（--scene 指定 private/group）
  reset               清除指定作用域的 response_modes 设置
  config [<mode-id>]  查看模式配置参数
  config set <k> <v>  修改模式配置参数（--mode 指定模式）

作用域（由参数决定，越具体越优先：关系 > agent > 全局）:
  (无参数)                       全局默认  → defaults.json
  --self <aid>                   agent级   → config.json
  --self <aid> --peer <X>        关系级    → relations/<peerKey>/config.json

Options:
  --self <aid>        本端 AID
  --peer <X>          对端：channelType#channelId 或裸 aid（裸 aid 视为 aun#<aid>）
  --scene <s>         场景：private | group（set 专用，默认 private）
  --mode <id>         模式 id（config set 专用）
  --format json       输出 JSON
  --help, -h          各子命令均支持

示例:
  evolclaw response list
  evolclaw response current --self bot.agentid.pub
  evolclaw response info dual-session
  evolclaw response set dual-session --self bot.agentid.pub --scene group
  evolclaw response set workflow --self bot.agentid.pub --peer aun#team.group.com
  evolclaw response config dual-session --self bot.agentid.pub
  evolclaw response config set relevance_threshold 0.8 --mode dual-session --self bot.agentid.pub
  evolclaw response reset --self bot.agentid.pub --peer alice.agentid.pub`;

// ── list ────────────────────────────────────────────────────────────────

function cmdList(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const scene = getArgValue(args, '--scene') as 'private' | 'group' | undefined;
  const modes = scene
    ? BUILTIN_MODE_META.filter(m => m.applicableScenes.includes(scene))
    : BUILTIN_MODE_META;

  emit(formatJson, { ok: true, modes }, () => {
    const lines = ['内置响应模式:'];
    for (const m of modes) {
      const scenes = m.applicableScenes.join(', ');
      lines.push(`  ${m.id.padEnd(20)} ${m.displayName.padEnd(14)} [${scenes}]`);
      lines.push(`  ${' '.repeat(20)} ${m.description}`);
    }
    return lines.join('\n');
  });
}

// ── current ─────────────────────────────────────────────────────────────

function cmdCurrent(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseSelector(args, formatJson);
  const cfg = readConfig(sel);
  const scope = determineFieldScope(sel);

  emit(formatJson, { ok: true, scope, config: cfg ?? null }, () => {
    if (!cfg) return `当前作用域(${scope})未设置 response_modes，使用系统兜底（private→interactive, group→proactive）`;
    const lines = [`响应模式配置（作用域: ${scope}）:`];
    if (cfg.default_private) lines.push(`  单聊默认: ${cfg.default_private}`);
    if (cfg.default_group) lines.push(`  群聊默认: ${cfg.default_group}`);
    if (cfg.overrides && Object.keys(cfg.overrides).length) {
      lines.push('  覆盖:');
      for (const [k, v] of Object.entries(cfg.overrides)) lines.push(`    ${k} → ${v.mode}`);
    }
    return lines.join('\n');
  });
}

// ── info ────────────────────────────────────────────────────────────────

function cmdInfo(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const id = args.find(a => !a.startsWith('--') && a !== 'info');
  if (!id) fail(formatJson, 'MISSING_ID', 'info 需要模式 id');
  const meta = findBuiltinMeta(id!);
  if (!meta) fail(formatJson, 'UNKNOWN_MODE', `未知模式: ${id}`);

  emit(formatJson, { ok: true, mode: meta }, () => {
    const lines = [
      `模式: ${meta!.id}`,
      `显示名: ${meta!.displayName}`,
      `类型: ${meta!.type}`,
      `描述: ${meta!.description}`,
      `适用场景: ${meta!.applicableScenes.join(', ')}`,
    ];
    const props = meta!.configSchema?.properties;
    if (props && Object.keys(props).length) {
      lines.push('配置参数:');
      for (const [k, v] of Object.entries(props)) {
        const def = (v as any).default !== undefined ? ` 默认: ${JSON.stringify((v as any).default)}` : '';
        lines.push(`  ${k.padEnd(22)} (${(v as any).type}) ${(v as any).description ?? ''}${def}`);
      }
    }
    return lines.join('\n');
  });
}

// ── set ─────────────────────────────────────────────────────────────────

function cmdSet(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const id = args.find(a => !a.startsWith('--') && a !== 'set');
  if (!id) fail(formatJson, 'MISSING_ID', 'set 需要模式 id');
  const meta = findBuiltinMeta(id!);
  if (!meta) fail(formatJson, 'UNKNOWN_MODE', `未知模式: ${id}`);

  const scene = (getArgValue(args, '--scene') as 'private' | 'group') ?? 'private';
  if (scene !== 'private' && scene !== 'group') {
    fail(formatJson, 'INVALID_SCENE', `--scene 必须是 private 或 group，得到: ${scene}`);
  }
  if (!meta!.applicableScenes.includes(scene)) {
    fail(formatJson, 'SCENE_MISMATCH', `模式 ${id} 不适用于 ${scene} 场景（适用: ${meta!.applicableScenes.join(', ')}）`);
  }

  const sel = parseWriteSelector(args, formatJson);
  const scope = determineFieldScope(sel);
  const cfg = (readField<ResponseModesConfig>(scope, sel, FIELD) || {}) as ResponseModesConfig;

  if (scene === 'private') cfg.default_private = id!;
  else cfg.default_group = id!;

  safeWrite(formatJson, () => writeField(scope, sel, FIELD, cfg));

  emit(formatJson, { ok: true, scope, scene, mode: id }, () =>
    `✓ 已设置 ${scene} 默认响应模式为 ${id}（作用域: ${scope}）`);
}

// ── reset ───────────────────────────────────────────────────────────────

function cmdReset(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseWriteSelector(args, formatJson);
  const scope = determineFieldScope(sel);
  safeWrite(formatJson, () => writeField(scope, sel, FIELD, undefined));
  emit(formatJson, { ok: true, scope }, () => `✓ 已清除作用域(${scope})的 response_modes 设置`);
}

// ── config ──────────────────────────────────────────────────────────────

function cmdConfig(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }

  // config set <key> <value>
  if (args[1] === 'set') {
    return cmdConfigSet(args, formatJson);
  }

  // config [<mode-id>]：查看模式配置
  const modeId = args.find(a => !a.startsWith('--') && a !== 'config');
  const sel = parseSelector(args, formatJson);
  const cfg = readConfig(sel);
  const configs = cfg?.configs ?? {};

  if (modeId) {
    emit(formatJson, { ok: true, mode: modeId, config: configs[modeId] ?? {} }, () =>
      `${modeId} 配置: ${JSON.stringify(configs[modeId] ?? {}, null, 2)}`);
  } else {
    emit(formatJson, { ok: true, configs }, () =>
      `所有模式配置: ${JSON.stringify(configs, null, 2)}`);
  }
}

function cmdConfigSet(args: string[], formatJson: boolean): void {
  // args: ['config', 'set', '<key>', '<value>', ...flags]
  const key = args[2];
  const rawValue = args[3];
  const modeId = getArgValue(args, '--mode');

  if (!modeId) fail(formatJson, 'MISSING_MODE', 'config set 需要 --mode <id>');
  if (!key || rawValue === undefined) fail(formatJson, 'MISSING_KV', 'config set 需要 <key> <value>');
  if (!findBuiltinMeta(modeId!)) fail(formatJson, 'UNKNOWN_MODE', `未知模式: ${modeId}`);

  // 值解析：尝试 JSON（数字/布尔/数组），失败则当字符串
  let value: any = rawValue;
  try { value = JSON.parse(rawValue!); } catch { /* keep string */ }

  const sel = parseWriteSelector(args, formatJson);
  const scope = determineFieldScope(sel);
  const cfg = (readField<ResponseModesConfig>(scope, sel, FIELD) || {}) as ResponseModesConfig;
  if (!cfg.configs) cfg.configs = {};
  if (!cfg.configs[modeId!]) cfg.configs[modeId!] = {};
  cfg.configs[modeId!][key!] = value;

  safeWrite(formatJson, () => writeField(scope, sel, FIELD, cfg));

  emit(formatJson, { ok: true, scope, mode: modeId, key, value }, () =>
    `✓ 已设置 ${modeId}.${key} = ${JSON.stringify(value)}（作用域: ${scope}）`);
}

// ── dispatch ──────────────────────────────────────────────────────────────

export async function cmdResponse(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';

  if (!sub || isHelpFlag(sub)) {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case 'list':    return cmdList(args, formatJson);
    case 'current': return cmdCurrent(args, formatJson);
    case 'info':    return cmdInfo(args, formatJson);
    case 'set':     return cmdSet(args, formatJson);
    case 'reset':   return cmdReset(args, formatJson);
    case 'config':  return cmdConfig(args, formatJson);
    default:
      fail(formatJson, 'UNKNOWN_SUBCOMMAND', `未知子命令: ${sub}（response --help 查看用法）`);
  }
}

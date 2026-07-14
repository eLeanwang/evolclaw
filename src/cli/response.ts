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
import { ResponseModeRegistry } from '../response-system/registry.js';
import { registerBuiltinModes } from '../response-system/modes/index.js';
import type { ResponseMode } from '../response-system/types.js';
import type { ResponseModeParams } from '../types.js';

const RESPONSE_MODE_FIELD = 'responseMode';
const RESPONSE_MODE_PARAMS_FIELD = 'responseModeParams';

/**
 * CLI 侧的响应模式清单 = 真实注册表（registerBuiltinModes 纯函数、无 daemon 依赖）。
 * 保证 ec response list/info/set 看到的与运行时实际注册的一致。
 */
function buildRegistry(): ResponseModeRegistry {
  const reg = new ResponseModeRegistry();
  registerBuiltinModes(reg);
  return reg;
}

/** 从模式实例提取展示用元数据（供 list/info 输出）。 */
function modeMeta(m: ResponseMode) {
  return {
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    applicableScenes: m.applicableScenes,
    type: m.type,
    configSchema: m.configSchema,
  };
}

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
 * responseMode 是行为参数，不落 defaults（与 model 命令一致，全局作用域已退场）。
 */
function parseWriteSelector(args: string[], formatJson: boolean): ScopeSelector {
  const sel = parseSelector(args, formatJson);
  if (!sel.self) {
    fail(formatJson, 'SELF_REQUIRED', 'responseMode 从 agent 级起：写操作必须提供 --self（全局默认不承载行为参数）');
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

/** 读取指定作用域生效的 responseMode 标量 */
function readResponseMode(sel: ScopeSelector): string | undefined {
  const scope = determineFieldScope(sel);
  return readField<string>(scope, sel, RESPONSE_MODE_FIELD);
}

/** 读取指定作用域生效的 responseModeParams 字典 */
function readResponseModeParams(sel: ScopeSelector): ResponseModeParams | undefined {
  const scope = determineFieldScope(sel);
  return readField<ResponseModeParams>(scope, sel, RESPONSE_MODE_PARAMS_FIELD);
}

const HELP = `用法: evolclaw response <command> [options]

Commands:
  list                列出所有响应模式（内置 + 元数据）
  current             显示当前作用域生效的模式 + 参数
  info <mode-id>      查看单个模式详情（场景/配置参数）
  set <mode-id>       设置响应模式
  reset               清除指定作用域的 responseMode 设置
  config <mode-id>    查看指定模式的配置参数
  config set <k> <v>  修改模式配置参数（--mode 指定模式）

作用域（由参数决定，越具体越优先：关系 > agent）:
  --self <aid>                   agent级   → config.json
  --self <aid> --peer <X>        关系级    → relations/<peerKey>/config.json

Options:
  --self <aid>        本端 AID
  --peer <X>          对端：channelType#channelId 或裸 aid（裸 aid 视为 aun#<aid>）
  --mode <id>         模式 id（config set 专用）
  --format json       输出 JSON
  --help, -h          各子命令均支持

示例:
  evolclaw response list
  evolclaw response current --self bot.agentid.pub
  evolclaw response info dual-session
  evolclaw response set single-session --self bot.agentid.pub
  evolclaw response set workflow --self bot.agentid.pub --peer aun#team.group.com
  evolclaw response config dual-session --self bot.agentid.pub
  evolclaw response config set debounceMs 5000 --mode dual-session --self bot.agentid.pub
  evolclaw response reset --self bot.agentid.pub --peer alice.agentid.pub`;

// ── list ────────────────────────────────────────────────────────────────

function cmdList(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const reg = buildRegistry();
  const preferred = reg.getPreferredId();
  const modes = reg.list().map(modeMeta);

  emit(formatJson, { ok: true, modes, preferred }, () => {
    const lines = ['已注册响应模式:'];
    for (const m of modes) {
      const scenes = m.applicableScenes.join(', ');
      const star = m.id === preferred ? ' ★首选' : '';
      lines.push(`  ${m.id.padEnd(20)} ${m.displayName.padEnd(14)} [${scenes}]${star}`);
      lines.push(`  ${' '.repeat(20)} ${m.description}`);
    }
    return lines.join('\n');
  });
}

// ── current ─────────────────────────────────────────────────────────────

function cmdCurrent(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseSelector(args, formatJson);
  const mode = readResponseMode(sel);
  const params = readResponseModeParams(sel);
  const scope = determineFieldScope(sel);

  emit(formatJson, { ok: true, scope, responseMode: mode ?? null, responseModeParams: params ?? null }, () => {
    const lines = [`响应模式配置（作用域: ${scope}）:`];
    if (mode) {
      lines.push(`  当前模式: ${mode}`);
    } else {
      lines.push(`  当前模式: (未设置，使用注册表首选)`);
    }
    if (params && Object.keys(params).length) {
      lines.push('  模式参数:');
      for (const [modeId, cfg] of Object.entries(params)) {
        lines.push(`    ${modeId}: ${JSON.stringify(cfg)}`);
      }
    }
    return lines.join('\n');
  });
}

// ── info ────────────────────────────────────────────────────────────────

function cmdInfo(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const id = args.find(a => !a.startsWith('--') && a !== 'info');
  if (!id) fail(formatJson, 'MISSING_ID', 'info 需要模式 id');
  const mode = buildRegistry().get(id!);
  if (!mode) fail(formatJson, 'UNKNOWN_MODE', `未知模式: ${id}`);
  const meta = modeMeta(mode!);

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
  if (!buildRegistry().has(id!)) fail(formatJson, 'UNKNOWN_MODE', `未知模式: ${id}`);

  const sel = parseWriteSelector(args, formatJson);
  const scope = determineFieldScope(sel);

  safeWrite(formatJson, () => writeField(scope, sel, RESPONSE_MODE_FIELD, id));

  emit(formatJson, { ok: true, scope, mode: id }, () =>
    `✓ 已设置响应模式为 ${id}（作用域: ${scope}）`);
}

// ── reset ───────────────────────────────────────────────────────────────

function cmdReset(args: string[], formatJson: boolean): void {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseWriteSelector(args, formatJson);
  const scope = determineFieldScope(sel);

  safeWrite(formatJson, () => {
    writeField(scope, sel, RESPONSE_MODE_FIELD, undefined);
    writeField(scope, sel, RESPONSE_MODE_PARAMS_FIELD, undefined);
  });

  emit(formatJson, { ok: true, scope }, () =>
    `✓ 已清除响应模式配置（作用域: ${scope}）`);
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
  const params = readResponseModeParams(sel) ?? {};

  if (modeId) {
    emit(formatJson, { ok: true, mode: modeId, config: params[modeId] ?? {} }, () =>
      `${modeId} 配置: ${JSON.stringify(params[modeId] ?? {}, null, 2)}`);
  } else {
    emit(formatJson, { ok: true, responseModeParams: params }, () =>
      `所有模式配置: ${JSON.stringify(params, null, 2)}`);
  }
}

function cmdConfigSet(args: string[], formatJson: boolean): void {
  // args: ['config', 'set', '<key>', '<value>', ...flags]
  const key = args[2];
  const rawValue = args[3];
  const modeId = getArgValue(args, '--mode');

  if (!modeId) fail(formatJson, 'MISSING_MODE', 'config set 需要 --mode <id>');
  if (!key || rawValue === undefined) fail(formatJson, 'MISSING_KV', 'config set 需要 <key> <value>');
  if (!buildRegistry().has(modeId!)) fail(formatJson, 'UNKNOWN_MODE', `未知模式: ${modeId}`);

  // 值解析：尝试 JSON（数字/布尔/数组），失败则当字符串
  let value: any = rawValue;
  try { value = JSON.parse(rawValue!); } catch { /* keep string */ }

  const sel = parseWriteSelector(args, formatJson);
  const scope = determineFieldScope(sel);
  const params = (readResponseModeParams(sel) || {}) as ResponseModeParams;
  if (!params[modeId!]) params[modeId!] = {};
  params[modeId!][key!] = value;

  safeWrite(formatJson, () => writeField(scope, sel, RESPONSE_MODE_PARAMS_FIELD, params));

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

/**
 * `evolclaw model` —— 面向 agent 的模型管理命令集。
 *
 * 三级作用域由参数决定：
 *   (无)             → 全局   defaults.json
 *   --self           → agent  config.json
 *   --self --peer    → 关系   relations/<peerKey>/preferences.json
 *
 * 改某作用域后，对应范围所有会话的下一条消息即时生效（运行时按 关系>agent>全局 解析）。
 * 与对话内 slash（/model /setmodel /effort /baseagent）互不影响。
 * 设计见 docs/model-command-design.md。
 */

import { isHelpFlag, wantsHelp } from './help.js';
import {
  ModelScopeError, normalizePeer, determineScope, activeBaseagent,
  readScope, writeScope, clearScope, resolveEffectiveModel,
  type ScopeSelector, type ModelScope,
} from '../core/model/model-scope.js';
import { getCatalog, getModelInfo } from '../core/model/model-catalog.js';

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

const SCOPE_LABEL: Record<ModelScope, string> = {
  global: '全局', agent: 'agent级', relation: '关系级',
};

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** 输出 JSON 并退出（success=false 时 exit 1）。 */
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

/**
 * 解析 --self / --peer 为作用域选择器。
 */
function parseSelector(args: string[], formatJson: boolean): ScopeSelector {
  const self = getArgValue(args, '--self');
  const peerRaw = getArgValue(args, '--peer');

  let peerKey: string | undefined;
  if (peerRaw !== undefined) {
    try {
      peerKey = normalizePeer(peerRaw);
    } catch (e) {
      if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message);
      throw e;
    }
  }

  const sel: ScopeSelector = { self, peerKey };
  // 触发依赖校验（PEER_WITHOUT_SELF）
  try {
    determineScope(sel);
  } catch (e) {
    if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message);
    throw e;
  }
  return sel;
}

const HELP = `用法: evolclaw model <command> [options]

Commands:
  list                列出可用模型，标注各作用域命中
  current             显示按优先级解析后实际生效的模型 + 来源
  info <model-id>     查看单个模型详情（厂商/上下文/价格/模态/effort/状态）
  use <model-id>      设置模型（作用域由 --self/--peer 决定）
  reset               清除指定作用域的设置，回落上一级
  effort <level>      设置推理强度（low|medium|high|xhigh|max|auto）

作用域（由参数决定，越具体越优先：关系 > agent > 全局）:
  (无参数)                       全局默认  → defaults.json
  --self <aid>                   agent级   → config.json
  --self <aid> --peer <X>        关系级    → relations/<peerKey>/preferences.json

改某作用域后，对应范围所有会话的下一条消息即时生效。

Options:
  --self <aid>        本端 AID
  --peer <X>          对端：channelType#channelId 或裸 aid（裸 aid 视为 aun#<aid>）
  --effort <level>    （use 专用）同时设置推理强度
  --format json       输出 JSON
  --help, -h          各子命令均支持

示例:
  evolclaw model list
  evolclaw model current --self bot.agentid.pub --peer aun#alice.agentid.pub
  evolclaw model info deepseek-v4-pro
  evolclaw model use opus
  evolclaw model use deepseek-v4-pro --self bot.agentid.pub --peer alice.agentid.pub
  evolclaw model effort high --self bot.agentid.pub
  evolclaw model reset --self bot.agentid.pub --peer alice.agentid.pub`;

async function dispatch(sub: string, args: string[], formatJson: boolean): Promise<void> {
  switch (sub) {
    case 'list':    return await cmdList(args, formatJson);
    case 'current': return await cmdCurrent(args, formatJson);
    case 'info':    return await cmdInfo(args, formatJson);
    case 'use':     return await cmdUse(args, formatJson);
    case 'reset':   return await cmdReset(args, formatJson);
    case 'effort':  return await cmdEffort(args, formatJson);
    default:
      fail(formatJson, 'UNKNOWN_SUBCOMMAND', `未知子命令: ${sub}（model --help 查看用法）`);
  }
}

// ── list ──────────────────────────────────────────────────────────────

const ICON: Record<ModelScope, string> = {
  global: '⬡', agent: '◆', relation: '★',
};

async function cmdList(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseSelector(args, formatJson);
  const ba = activeBaseagent(sel.self);
  const cat = await getCatalog(sel.self, ba);
  const resolved = resolveEffectiveModel(sel, ba);

  // 各作用域当前值（仅可达作用域）
  const scopes: Partial<Record<ModelScope, { model?: string; effort?: string }>> = {};
  scopes.global = readScope('global', sel, ba);
  if (sel.self) scopes.agent = readScope('agent', sel, ba);
  if (sel.self && sel.peerKey) scopes.relation = readScope('relation', sel, ba);

  emit(formatJson, {
    ok: true,
    effective: { model: resolved.model ?? null, source: resolved.source ?? null },
    scopes,
    catalogSource: cat.source,
    models: cat.models,
  }, () => {
    const lines: string[] = [];
    lines.push(`当前生效: ${resolved.model ?? '(未设置，回落 SDK 默认)'}` +
      (resolved.source ? `  (来源: ${SCOPE_LABEL[resolved.source]})` : ''));
    lines.push('');
    const srcTag = cat.source === 'mock' ? ' [mock]'
      : cat.source === 'remote' ? ' [remote]'
      : '';
    lines.push(`可用模型 (${cat.models.length})${srcTag}:`);
    const byScope = (m: string): string => {
      const tags: string[] = [];
      for (const s of ['relation', 'agent', 'global'] as ModelScope[]) {
        if (scopes[s]?.model === m) tags.push(`${ICON[s]}${SCOPE_LABEL[s]}`);
      }
      return tags.join(' ');
    };
    for (const e of cat.models) {
      const live = resolved.model === e.id ? '✓' : ' ';
      const tag = byScope(e.id);
      lines.push(`  ${live} ${e.id.padEnd(28)} ${tag}`.trimEnd());
    }
    return lines.join('\n');
  });
}

// ── current ───────────────────────────────────────────────────────────

async function cmdCurrent(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseSelector(args, formatJson);
  const ba = activeBaseagent(sel.self);
  const resolved = resolveEffectiveModel(sel, ba);

  emit(formatJson, {
    ok: true,
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    source: resolved.source ?? null,
    chain: resolved.chain.map(c => ({ scope: c.scope, model: c.model ?? null, hit: c.hit })),
  }, () => {
    const lines: string[] = [];
    lines.push(`当前生效模型: ${resolved.model ?? '(未设置，回落 SDK 默认)'}`);
    lines.push(`推理强度:     ${resolved.effort ?? 'auto'}`);
    lines.push(`来源:         ${resolved.source ? SCOPE_LABEL[resolved.source] : '无'}`);
    const chain = resolved.chain.map(c =>
      `${SCOPE_LABEL[c.scope]}${c.hit ? ' ✓' : ''}${c.model ? `(${c.model})` : ''}`).join(' > ');
    lines.push(`解析链:       ${chain}`);
    return lines.join('\n');
  });
}

// ── info ──────────────────────────────────────────────────────────────

async function cmdInfo(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const modelId = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  if (!modelId) fail(formatJson, 'MISSING_MODEL_ID', 'info 需要 <model-id>');
  const self = getArgValue(args, '--self');
  const info = await getModelInfo(modelId!, self);

  emit(formatJson, { ok: true, ...info }, () => {
    const price = info.pricing;
    const fmtPrice = (v: number | null) => v === null ? '— (mock)' : `$${v} / 1M tokens`;
    return [
      `模型: ${info.id}`,
      `  厂商:       ${info.owned_by}`,
      `  上下文窗口: ${info.context_window ?? '—'} tokens`,
      `  最大输出:   ${info.max_output_tokens ?? '—'} tokens`,
      `  输入价格:   ${fmtPrice(price?.input_per_mtok ?? null)}`,
      `  输出价格:   ${fmtPrice(price?.output_per_mtok ?? null)}`,
      `  支持模态:   ${info.modalities.join(', ')}${info.mocked ? ' (mock)' : ''}`,
      `  推理强度:   ${info.supports_effort ? '支持' : '不支持'}`,
      `  状态:       ${info.status === 'available' ? '✓ 可用' : info.status}`,
    ].join('\n');
  });
}

// ── use / effort / reset 共用写入逻辑 ───────────────────────────────────

function describeWrite(scope: ModelScope, sel: ScopeSelector, model: string | null, effort: string | null, formatJson: boolean): void {
  emit(formatJson, {
    ok: true,
    scope,
    self: sel.self ?? null,
    peerKey: sel.peerKey ?? null,
    model: model ?? undefined,
    effort: effort ?? undefined,
  }, () => {
    const lines = ['✓ 已设置', `  作用域: ${SCOPE_LABEL[scope]}` +
      (sel.peerKey ? ` (${sel.peerKey})` : '') + (sel.self ? ` [self=${sel.self}]` : '')];
    if (model !== null) lines.push(`  模型:   ${model}`);
    if (effort !== null) lines.push(`  推理强度: ${effort}`);
    lines.push('  生效:   该范围所有会话的下一条消息起生效。');
    return lines.join('\n');
  });
}

async function cmdUse(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const modelId = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  if (!modelId) fail(formatJson, 'MISSING_MODEL_ID', 'use 需要 <model-id>');

  const sel = parseSelector(args, formatJson);
  const scope = determineScope(sel);
  const ba = activeBaseagent(sel.self);

  // 校验模型在 catalog 中
  const cat = await getCatalog(sel.self, ba);
  if (!cat.models.some(m => m.id === modelId)) {
    fail(formatJson, 'UNKNOWN_MODEL', `模型不在目录中: ${modelId}（model list 查看可用模型）`);
  }

  const effort = getArgValue(args, '--effort');
  if (effort !== undefined && !ALL_EFFORTS.includes(effort)) {
    fail(formatJson, 'INVALID_EFFORT', `无效推理强度: ${effort}（${ALL_EFFORTS.join('/')})`);
  }
  const effortVal = effort === 'auto' ? null : (effort ?? undefined);

  try {
    writeScope(scope, sel, ba, { model: modelId, effort: effortVal as any });
  } catch (e) {
    if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message);
    throw e;
  }
  describeWrite(scope, sel, modelId!, effort ?? null, formatJson);
}

async function cmdEffort(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const level = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  if (!level) fail(formatJson, 'INVALID_EFFORT', 'effort 需要 <level>（low|medium|high|xhigh|max|auto）');
  if (!ALL_EFFORTS.includes(level!)) {
    fail(formatJson, 'INVALID_EFFORT', `无效推理强度: ${level}（${ALL_EFFORTS.join('/')})`);
  }

  const sel = parseSelector(args, formatJson);
  const scope = determineScope(sel);
  const ba = activeBaseagent(sel.self);
  const val = level === 'auto' ? null : level!;

  try {
    writeScope(scope, sel, ba, { effort: val });
  } catch (e) {
    if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message);
    throw e;
  }
  describeWrite(scope, sel, null, level!, formatJson);
}

async function cmdReset(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseSelector(args, formatJson);
  const scope = determineScope(sel);
  const ba = activeBaseagent(sel.self);

  try {
    clearScope(scope, sel, ba);
  } catch (e) {
    if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message);
    throw e;
  }

  emit(formatJson, {
    ok: true, scope, self: sel.self ?? null, peerKey: sel.peerKey ?? null,
  }, () => {
    return `✓ 已清除 ${SCOPE_LABEL[scope]} 设置，回落上一级（该范围所有会话下条消息生效）`;
  });
}

export async function cmdModel(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';

  if (!sub || isHelpFlag(sub)) {
    console.log(HELP);
    return;
  }

  await dispatch(sub, args, formatJson);
}

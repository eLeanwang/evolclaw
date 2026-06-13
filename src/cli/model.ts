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

import { isHelpFlag, wantsHelp, getArgValue } from './help.js';
import {
  ModelScopeError, normalizePeer, determineScope, activeBaseagent,
  readScope, writeScope, clearScope, resolveEffectiveModel,
  type ScopeSelector, type ModelScope,
} from '../core/model/config-scope.js';
import { loadDefaults, loadAgent } from '../config-store.js';
import { resolveAnthropicConfig } from '../agents/baseagent.js';
import { getCatalog, getModelInfo } from '../core/model/model-catalog.js';

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

const SCOPE_LABEL: Record<ModelScope, string> = {
  global: '全局', agent: 'agent级', role: '角色级', relation: '关系级',
};

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
  check               诊断网关连通性与模型可用性（分阶段输出进度）

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
  evolclaw model reset --self bot.agentid.pub --peer alice.agentid.pub
  evolclaw model check --self bot.agentid.pub`;

async function dispatch(sub: string, args: string[], formatJson: boolean): Promise<void> {
  switch (sub) {
    case 'list':    return await cmdList(args, formatJson);
    case 'current': return await cmdCurrent(args, formatJson);
    case 'info':    return await cmdInfo(args, formatJson);
    case 'use':     return await cmdUse(args, formatJson);
    case 'reset':   return await cmdReset(args, formatJson);
    case 'effort':  return await cmdEffort(args, formatJson);
    case 'check':   return await cmdCheck(args, formatJson);
    default:
      fail(formatJson, 'UNKNOWN_SUBCOMMAND', `未知子命令: ${sub}（model --help 查看用法）`);
  }
}

// ── list ──────────────────────────────────────────────────────────────

const ICON: Record<ModelScope, string> = {
  global: '⬡', agent: '◆', role: '●', relation: '★',
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

// ── check ─────────────────────────────────────────────────────────────

interface CheckStep {
  label: string;
  ok: boolean;
  detail: string;
  ms?: number;
}

/** 带超时的 fetch，返回 Response 或 null（超时/失败）。 */
async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** 解析网关 baseUrl 和 apiKey（复用 resolveCreds 逻辑，但从 CLI 层调用）。 */
function resolveGatewayCreds(self?: string): { baseUrl?: string; apiKey?: string } {
  try {
    const defaults = loadDefaults();
    const agentCfg = self ? loadAgent(self) : null;
    const block: any = agentCfg?.baseagents || defaults?.baseagents || {};
    const claudeCfg = block.claude || {};
    const r = resolveAnthropicConfig({ agents: { claude: claudeCfg } } as any, claudeCfg);
    return { baseUrl: r.baseUrl, apiKey: r.apiKey };
  } catch {
    return {};
  }
}

/** 对单个模型发一次最小探测请求，返回延迟 ms 或错误信息。
 *  按网关风格顺序探测：Anthropic Messages API → OpenAI chat completions → 仅列表校验
 */
async function probeModel(baseUrl: string, apiKey: string | undefined, modelId: string, timeoutMs: number): Promise<{ ok: boolean; ms: number; error?: string; style?: string }> {
  const base = baseUrl.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = apiKey
    ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }
    : {};

  // 风格 1：Anthropic Messages API
  {
    const t0 = Date.now();
    const resp = await fetchWithTimeout(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders },
      body: JSON.stringify({ model: modelId, max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }),
    }, timeoutMs);
    const ms = Date.now() - t0;
    if (resp && resp.ok) return { ok: true, ms, style: 'anthropic' };
    if (resp && resp.status >= 400 && resp.status < 500) {
      // 4xx 说明网关支持此风格，但模型不可用
      let errMsg = `HTTP ${resp.status}`;
      try { const j: any = await resp.json(); errMsg = j?.error?.message || j?.detail || j?.message || errMsg; } catch { /* ignore */ }
      return { ok: false, ms, error: String(errMsg).slice(0, 80), style: 'anthropic' };
    }
    // 非 4xx（超时/连接失败/5xx）→ 继续尝试下一种风格
  }

  // 风格 2：OpenAI chat completions
  {
    const t0 = Date.now();
    const resp = await fetchWithTimeout(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ model: modelId, max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }),
    }, timeoutMs);
    const ms = Date.now() - t0;
    if (resp && resp.ok) {
      // 校验响应体有 choices 字段，否则可能是网关假装成功
      try {
        const j: any = await resp.json();
        if (j?.choices || j?.id) return { ok: true, ms, style: 'openai' };
      } catch { /* ignore */ }
    }
    if (resp && resp.status >= 400 && resp.status < 500) {
      let errMsg = `HTTP ${resp.status}`;
      try { const j: any = await resp.json(); errMsg = j?.error?.message || j?.detail || j?.message || errMsg; } catch { /* ignore */ }
      return { ok: false, ms, error: String(errMsg).slice(0, 80), style: 'openai' };
    }
  }

  // 两种风格都探测不到：无法判断可用性
  return { ok: false, ms: 0, error: '网关不支持标准探测（无法确认可用性）', style: 'unknown' };
}

async function cmdCheck(args: string[], formatJson: boolean): Promise<void> {
  if (wantsHelp(args)) { console.log(HELP); return; }
  const sel = parseSelector(args, formatJson);
  const ba = activeBaseagent(sel.self);
  const steps: CheckStep[] = [];
  const log = (step: CheckStep) => {
    steps.push(step);
    if (!formatJson) {
      const icon = step.ok ? '✓' : '✗';
      const ms = step.ms !== undefined ? ` (${step.ms}ms)` : '';
      console.log(`[${icon}] ${step.label.padEnd(14)} ${step.detail}${ms}`);
    }
  };

  const { baseUrl, apiKey } = resolveGatewayCreds(sel.self);

  // ── 阶段 1：DNS + 连通性 ──────────────────────────────────────────
  if (!formatJson) console.log('\n网关诊断\n' + '─'.repeat(50));

  if (!baseUrl) {
    log({ label: '网关地址', ok: false, detail: '未配置自定义网关（baseUrl），使用官方 Anthropic 端点' });
  } else {
    // DNS + TCP：用一次 HEAD 请求探测
    const t0 = Date.now();
    const pingResp = await fetchWithTimeout(baseUrl.replace(/\/+$/, '') + '/v1/models', {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }, 4000);
    const pingMs = Date.now() - t0;
    if (!pingResp) {
      log({ label: '网关连通', ok: false, detail: `${baseUrl} 无法连接（DNS/TCP 失败）`, ms: pingMs });
    } else {
      log({ label: '网关连通', ok: true, detail: baseUrl, ms: pingMs });
    }
  }

  // ── 阶段 2：认证 + 模型列表 ─────────────────────────────────────
  if (!formatJson) console.log('');
  const cat = await getCatalog(sel.self, ba);
  const modelIds = cat.models.filter(m => m.owned_by !== 'alias').map(m => m.id);

  if (cat.source === 'mock') {
    log({ label: '模型列表', ok: false, detail: `无法获取远端列表，使用内置 mock（${modelIds.length} 个）` });
  } else {
    log({ label: '模型列表', ok: true, detail: `来源: ${cat.source}，共 ${modelIds.length} 个模型` });
  }

  // ── 阶段 3：当前配置模型 ──────────────────────────────────────────
  if (!formatJson) console.log('');
  const resolved = resolveEffectiveModel(sel, ba);
  const configuredModel = resolved.model;

  if (!configuredModel) {
    log({ label: '配置模型', ok: true, detail: '未配置（将使用 base agent 默认模型）' });
  } else {
    log({ label: '配置模型', ok: true, detail: `${configuredModel}（来源: ${resolved.source ?? '未知'}）` });
  }

  // ── 阶段 4：模型可用性探测 ────────────────────────────────────────
  // 仅在有自定义网关时才做 API 探测（官方端点跳过，避免消耗 token）
  const probeResults: { id: string; displayId: string; ok: boolean; ms: number; error?: string }[] = [];

  if (baseUrl) {
    if (!formatJson) console.log('\n模型可用性探测\n' + '─'.repeat(50));

    // 别名解析：从目录里找别名对应的完整 ID
    const aliasMap = new Map<string, string>(); // alias → full id
    for (const entry of cat.models) {
      if (entry.owned_by === 'alias') {
        // 找目录中与别名前缀匹配的完整 ID
        const match = cat.models.find(m => m.owned_by !== 'alias' && m.id.includes(entry.id));
        if (match) aliasMap.set(entry.id, match.id);
      }
    }
    const resolveId = (id: string) => aliasMap.get(id) ?? id;

    // 优先探测当前配置的模型（解析别名），其余为非别名 ID
    const configResolved = configuredModel ? resolveId(configuredModel) : undefined;
    const allProbeIds = [
      ...(configResolved ? [{ display: configuredModel!, probe: configResolved }] : []),
      ...modelIds
        .filter(id => id !== configResolved)
        .map(id => ({ display: id, probe: id })),
    ];

    // 轮次 1：配置模型 + 1 个额外（并发 2，快速验证主要路径）
    const round1 = allProbeIds.slice(0, 2);
    const r1 = await Promise.all(round1.map(({ display, probe }) =>
      probeModel(baseUrl!, apiKey, probe, 5000).then(r => ({ id: display, displayId: display, ...r }))
    ));
    probeResults.push(...r1);
    if (!formatJson) r1.forEach(r => log({ label: r.id.slice(0, 20), ok: r.ok, detail: r.ok ? '可用' : (r.error ?? '不可用'), ms: r.ms }));

    // 轮次 2：剩余，2 个一组（避免触发限速）
    const rest = allProbeIds.slice(2);
    for (let i = 0; i < rest.length; i += 2) {
      const batch = rest.slice(i, i + 2);
      const br = await Promise.all(batch.map(({ display, probe }) =>
        probeModel(baseUrl!, apiKey, probe, 5000).then(r => ({ id: display, displayId: display, ...r }))
      ));
      probeResults.push(...br);
      if (!formatJson) br.forEach(r => log({ label: r.id.slice(0, 20), ok: r.ok, detail: r.ok ? '可用' : (r.error ?? '不可用'), ms: r.ms }));
    }
  } else {
    if (!formatJson) console.log('\n（跳过模型探测：未配置自定义网关）');
  }

  // ── 汇总 ─────────────────────────────────────────────────────────
  const availableModels = probeResults.filter(r => r.ok).map(r => r.id);
  const configModelOk = configuredModel ? probeResults.find(r => r.id === configuredModel)?.ok : undefined;

  if (!formatJson) {
    console.log('\n' + '─'.repeat(50));
    if (configuredModel && configModelOk === false) {
      console.log(`⚠️  当前配置的模型 ${configuredModel} 不可用`);
      if (availableModels.length > 0) {
        console.log(`   可用模型：${availableModels.slice(0, 3).join('、')}${availableModels.length > 3 ? ` 等 ${availableModels.length} 个` : ''}`);
      }
    } else if (configuredModel && configModelOk === true) {
      console.log(`✓  当前配置的模型 ${configuredModel} 可用`);
    } else if (!baseUrl) {
      console.log(`✓  使用官方 Anthropic 端点，无需探测`);
    }
  } else {
    emit(formatJson, {
      ok: true,
      steps,
      configuredModel: configuredModel ?? null,
      configModelAvailable: configModelOk ?? null,
      availableModels,
      catalogSource: cat.source,
    }, () => '');
  }
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

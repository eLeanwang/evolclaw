/**
 * `evolclaw config` —— 配置体系底层通用入口（config-system-design-v2.md §十二 + addendum）。
 *
 * 16 子命令：get set unset show list validate init effective fields
 *            snapshot prune history diff restore current boots
 * selector：--self / --peer / --default / --process
 *
 * 字段落点由 schema 自动判定（config=H / behavior=HA）；H/HA 权限闸由 EVOLCLAW_SESSION_ID
 * （agent 托管环境）决定。ec model / ec ctl 是高频操作的语义化快捷，最终都经 ConfigManager。
 */

import { isHelpFlag, wantsHelp, getArgValue } from './help.js';
import { normalizePeer, ModelScopeError } from '../core/model/config-scope.js';
import {
  ConfigTarget, read, write, ensureFile, resolveEffective, resolveAgentConfig, resolveBehavior,
  routeField, listFields, initConfigManager, ConfigError,
  type Selector, type FieldRoute,
} from '../core/config/config-manager.js';
import {
  snapshot, restore, diffVersions, listAllVersions, readCurrent, prune, collectConfigFiles,
} from '../core/config/snapshot.js';
import { readBootLog } from '../core/config/boot-log.js';
import { loadSchema } from '../core/config/schema-registry.js';
import { resolvePaths } from '../paths.js';

type Scope = 'process' | 'defaults' | 'agent' | 'relation';

// ── 输出助手（对齐 cli/model.ts）────────────────────────────────────────────

function emit(formatJson: boolean, payload: any, textFn: () => string): void {
  if (formatJson) console.log(JSON.stringify(payload, null, 2));
  else console.log(textFn());
}

function fail(formatJson: boolean, code: string, message: string): never {
  if (formatJson) console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
  else console.error(`❌ ${message} (${code})`);
  process.exit(1);
}

/** agent 托管环境标志（runner 注入 EVOLCLAW_SESSION_ID）。 */
function isAgentEnv(): boolean {
  return !!process.env.EVOLCLAW_SESSION_ID;
}

/** 某顶层字段是否归属 behavior(HA) schema。 */
function isBehaviorField(top: string): boolean {
  return loadSchema('behavior').fields.has(top);
}

// ── selector 解析（design §十二 + D1 --process）──────────────────────────────

interface ParsedScope {
  scope: Scope;
  sel: Selector;
}

/** 解析 --self/--peer/--default/--process。forWrite=true 时无 selector 报错（fail-closed）。 */
function parseScope(args: string[], formatJson: boolean, forWrite: boolean): ParsedScope {
  const self = getArgValue(args, '--self');
  const peerRaw = getArgValue(args, '--peer');
  const isDefault = args.includes('--default');
  const isProcess = args.includes('--process') || args.includes('--evolclaw');

  // 互斥校验
  const exclusive = [isProcess, isDefault, !!self].filter(Boolean).length;
  if (isProcess && (self || isDefault)) fail(formatJson, 'SELECTOR_CONFLICT', '--process 不能与 --self/--default 同用');
  if (isDefault && self) fail(formatJson, 'SELECTOR_CONFLICT', '--default 不能与 --self 同用');

  if (isProcess) return { scope: 'process', sel: {} };
  if (isDefault) return { scope: 'defaults', sel: {} };

  if (self) {
    let peerKey: string | undefined;
    if (peerRaw !== undefined) {
      try { peerKey = normalizePeer(peerRaw); }
      catch (e) { if (e instanceof ModelScopeError) fail(formatJson, e.code, e.message); throw e; }
    }
    return { scope: peerKey ? 'relation' : 'agent', sel: { self, peerKey } };
  }
  if (peerRaw !== undefined) fail(formatJson, 'PEER_WITHOUT_SELF', '--peer 必须配合 --self 使用');

  // 无任何 selector
  if (forWrite) {
    fail(formatJson, 'SELECTOR_REQUIRED',
      '写操作必须指定作用域：--self <aid> [--peer <peerKey>] | --default | --process（防误写全局）');
  }
  void exclusive;
  return { scope: 'agent', sel: {} }; // 读操作全局视角（无 self → 仅 defaults 可达）
}

// ── 权限闸（H/HA）────────────────────────────────────────────────────────────

function gateWrite(route: FieldRoute, formatJson: boolean): void {
  if (isAgentEnv() && route.permission === 'H') {
    fail(formatJson, 'FORBIDDEN_H_WRITE',
      `agent 托管环境不可写 H 字段（落 ${route.schema}）；仅人可改。`);
  }
}

function gateHumanOnly(op: string, formatJson: boolean): void {
  if (isAgentEnv()) fail(formatJson, 'FORBIDDEN', `${op} 仅人可执行（agent 托管环境被拒）`);
}

// ── 字段值解析（按 schema 类型）──────────────────────────────────────────────

function coerceValue(raw: string, route: FieldRoute): unknown {
  if (route.merge === 'list') return [raw]; // 单元素，写入时 append-union（D11）
  if (route.enum) return raw;
  // scalar：尝试 number/bool，否则字符串
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** 点路径 set：把 a.b.c=value 套进对象。返回顶层字段名。 */
function setNested(obj: Record<string, any>, dotPath: string, value: unknown): string {
  const parts = dotPath.split('.');
  const top = parts[0];
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return top;
}

function getNested(obj: any, dotPath: string): unknown {
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── 命令实现 ──────────────────────────────────────────────────────────────────

function cmdGet(args: string[], formatJson: boolean): void {
  const field = positional(args, 1);
  if (!field) fail(formatJson, 'MISSING_FIELD', 'get 需要 <field>');
  const { scope, sel } = parseScope(args, formatJson, false);

  if (scope === 'process') {
    const cfg = read(ConfigTarget.Process, sel) || {};
    const val = getNested(cfg, field!);
    return emit(formatJson, { ok: true, field, value: val ?? null, scope }, () =>
      `${field} = ${JSON.stringify(val ?? null)}  (process，链外单层)`);
  }
  // effective 值 + 解析链：合并 H + behavior
  const eff = resolveEffective(sel);
  const top = field!.split('.')[0];
  let route: FieldRoute;
  try { route = routeField(top, scope === 'defaults' ? 'defaults' : scope); }
  catch (e) { return failFromConfigErr(e, formatJson); }
  const value = route.permission === 'HA' ? getNested(eff.behavior, field!) : getNested(eff, field!);
  emit(formatJson, {
    ok: true, field, value: value ?? null, scope,
    permission: route.permission, file: route.schema,
  }, () => {
    const tag = route.permission === 'HA' ? '[behavior]' : '[config]';
    return `${field} = ${JSON.stringify(value ?? null)}  ${tag}`;
  });
}

function cmdSet(args: string[], formatJson: boolean): void {
  const field = positional(args, 1);
  const value = positional(args, 2);
  if (!field || value === undefined) fail(formatJson, 'MISSING_ARG', 'set 需要 <field> <value>');
  const { scope, sel } = parseScope(args, formatJson, true);

  const top = field!.split('.')[0];

  // D7：--default + behavior 字段 → reject（先于通用路由判定——defaults schema 没有 behavior 字段，
  // 否则会先抛 UNKNOWN_FIELD 掩盖真实语义）。
  if (scope === 'defaults' && isBehaviorField(top)) {
    fail(formatJson, 'DEFAULT_BEHAVIOR_REJECT',
      'behavior 链无 defaults 层：请逐 agent 设置（--self <aid>），或将该字段上提为 config/H 字段');
  }

  let route: FieldRoute;
  try { route = routeField(top, scope); }
  catch (e) { return failFromConfigErr(e, formatJson); }

  gateWrite(route, formatJson);

  const target = route.target;
  const existing = (read<Record<string, any>>(target, sel) as Record<string, any>) || {};
  const coerced = coerceValue(value!, route);

  // D11：单文件内 list set = append-union
  if (route.merge === 'list') {
    const prev = getNested(existing, field!);
    const prevArr = Array.isArray(prev) ? prev : [];
    const merged = [...new Set([...prevArr, ...(coerced as unknown[])].map(v => typeof v === 'object' ? JSON.stringify(v) : v))]
      .map(v => { try { return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v; } catch { return v; } });
    setNested(existing, field!, merged);
  } else {
    setNested(existing, field!, coerced);
  }

  try {
    ensureFile(target, sel);
    write(target, existing, sel);
  } catch (e) { return failFromConfigErr(e, formatJson); }

  emit(formatJson, { ok: true, field, value: coerced, scope, permission: route.permission, file: route.schema }, () =>
    `✓ 已设置 ${field} = ${JSON.stringify(coerced)}  [${route.permission === 'HA' ? 'behavior' : 'config'}/${scope}]\n  生效：该范围所有会话下条消息起。`);
}

function cmdUnset(args: string[], formatJson: boolean): void {
  const field = positional(args, 1);
  if (!field) fail(formatJson, 'MISSING_FIELD', 'unset 需要 <field>');
  const { scope, sel } = parseScope(args, formatJson, true);

  if (scope === 'process') fail(formatJson, 'UNSET_PROCESS_REJECT', 'evolclaw.json 无下层可回落，unset --process 被拒（请直接编辑文件）');

  const top = field!.split('.')[0];
  if (scope === 'defaults' && isBehaviorField(top)) {
    fail(formatJson, 'DEFAULT_BEHAVIOR_REJECT', 'behavior 链无 defaults 层，无法 unset');
  }
  let route: FieldRoute;
  try { route = routeField(top, scope); }
  catch (e) { return failFromConfigErr(e, formatJson); }
  gateWrite(route, formatJson);

  const existing = (read<Record<string, any>>(route.target, sel) as Record<string, any>);
  if (!existing) return emit(formatJson, { ok: true, field, removed: false }, () => `（${field} 在该层未设置，无需删除）`);
  // 删点路径末端
  const parts = field!.split('.');
  let cur: any = existing;
  for (let i = 0; i < parts.length - 1; i++) { if (cur == null) break; cur = cur[parts[i]]; }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
  try { write(route.target, existing, sel); } catch (e) { return failFromConfigErr(e, formatJson); }
  emit(formatJson, { ok: true, field, removed: true, scope }, () => `✓ 已删除 ${field}（${scope} 层），回落下一层。`);
}

function cmdShow(args: string[], formatJson: boolean): void {
  const { scope, sel } = parseScope(args, formatJson, false);
  const target = scope === 'process' ? ConfigTarget.Process
    : scope === 'defaults' ? ConfigTarget.Defaults
    : scope === 'relation' ? ConfigTarget.Relation : ConfigTarget.Agent;
  // show 看单层原始内容，不展开 ${VAR}
  const cfg = read(target, sel) || {};
  let behavior: any = null;
  if (scope === 'agent') behavior = read(ConfigTarget.AgentBehavior, sel);
  if (scope === 'relation') behavior = read(ConfigTarget.RelationBehavior, sel);
  emit(formatJson, { ok: true, scope, config: cfg, behavior }, () => {
    const out = [`# ${scope} config (原始，未合并，凭证显示 \${VAR})`, JSON.stringify(cfg, null, 2)];
    if (behavior) out.push(`# ${scope} behavior`, JSON.stringify(behavior, null, 2));
    return out.join('\n');
  });
}

function cmdEffective(args: string[], formatJson: boolean): void {
  const { scope, sel } = parseScope(args, formatJson, false);
  if (scope === 'process') {
    const cfg = read(ConfigTarget.Process, sel) || {};
    return emit(formatJson, { ok: true, scope, effective: cfg }, () => JSON.stringify(cfg, null, 2));
  }
  const eff = resolveEffective(sel);
  emit(formatJson, { ok: true, scope, effective: eff }, () => JSON.stringify(eff, null, 2));
}

function cmdFields(args: string[], formatJson: boolean): void {
  const { scope } = parseScope(args, formatJson, false);
  const fields = listFields(scope === 'defaults' ? 'defaults' : scope === 'process' ? 'process' : scope);
  emit(formatJson, { ok: true, scope, fields }, () => {
    const lines = [`# ${scope} 可设字段（来源 schema）`];
    for (const f of fields) {
      const en = f.enum ? `  enum=[${f.enum.join('|')}]` : '';
      lines.push(`  ${pad(f.field, 20)} ${f.permission === 'HA' ? 'HA' : 'H '}  merge=${pad(f.merge, 6)}${en}`);
    }
    return lines.join('\n');
  });
}

function cmdList(args: string[], formatJson: boolean): void {
  // 列出所有配置文件及存在状态——委托扫描
  const root = resolvePaths().root;
  const files = collectConfigFiles(root);
  emit(formatJson, { ok: true, files }, () => `配置文件（${files.length}）:\n` + files.map(f => `  ✓ ${f}`).join('\n'));
}

function cmdValidate(args: string[], formatJson: boolean): void {
  // 简化：用 ConfigManager.write 的 schema 校验逻辑——这里只读+逐层校验
  const { scope, sel } = parseScope(args, formatJson, false);
  const targets: Array<{ t: ConfigTarget; s?: Selector }> = [];
  if (scope === 'process') targets.push({ t: ConfigTarget.Process });
  else if (scope === 'defaults') targets.push({ t: ConfigTarget.Defaults });
  else if (scope === 'agent') { targets.push({ t: ConfigTarget.Agent, s: sel }, { t: ConfigTarget.AgentBehavior, s: sel }); }
  else if (scope === 'relation') { targets.push({ t: ConfigTarget.Relation, s: sel }, { t: ConfigTarget.RelationBehavior, s: sel }); }

  const results: Array<{ target: string; ok: boolean; error?: string }> = [];
  for (const { t, s } of targets) {
    const cfg = read(t, s);
    if (cfg === null) { results.push({ target: t, ok: true, error: '(不存在，跳过)' }); continue; }
    try { write(t, cfg, s); results.push({ target: t, ok: true }); }
    catch (e) { results.push({ target: t, ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  const allOk = results.every(r => r.ok);
  emit(formatJson, { ok: allOk, results }, () =>
    results.map(r => `${r.ok ? '✓' : '✗'} ${r.target}${r.error ? '  ' + r.error : ''}`).join('\n'));
}

function cmdInit(args: string[], formatJson: boolean): void {
  gateHumanOnly('config init', formatJson);
  const { scope, sel } = parseScope(args, formatJson, true);
  const target = scope === 'process' ? ConfigTarget.Process
    : scope === 'defaults' ? ConfigTarget.Defaults
    : scope === 'relation' ? ConfigTarget.Relation : ConfigTarget.Agent;
  try {
    ensureFile(target, sel);
    if (scope === 'agent') ensureFile(ConfigTarget.AgentBehavior, sel);
    if (scope === 'relation') ensureFile(ConfigTarget.RelationBehavior, sel);
  } catch (e) { return failFromConfigErr(e, formatJson); }
  emit(formatJson, { ok: true, scope }, () => `✓ 已为 ${scope} 作用域物化骨架配置文件`);
}

// ── 快照子命令 ────────────────────────────────────────────────────────────────

function cmdSnapshot(args: string[], formatJson: boolean): void {
  gateHumanOnly('config snapshot', formatJson);
  const full = args.includes('--full');
  const desc = getArgValue(args, '--desc');
  const r = snapshot('manual', { full, description: desc });
  emit(formatJson, { ok: true, ...r }, () =>
    r.created ? `✓ 已创建快照 ${r.version}（${r.type}）` : `（无变化，未建版本：${r.reason}）`);
}

function cmdPrune(args: string[], formatJson: boolean): void {
  gateHumanOnly('config prune', formatJson);
  const yes = args.includes('--yes');
  const keepFull = numArg(args, '--keep-full');
  const keepDelta = numArg(args, '--keep-delta');
  const r = prune({ keepFull, keepDelta, dryRun: !yes });
  emit(formatJson, { ok: true, dryRun: !yes, ...r }, () => {
    if (!yes) return `[dry-run] 将删除 ${r.wouldDelete.length} 个版本：${r.wouldDelete.join(', ')}\n  加 --yes 真正执行。`;
    return `✓ 已删除 ${r.deleted.length} 个版本：${r.deleted.join(', ')}`;
  });
}

function cmdHistory(args: string[], formatJson: boolean): void {
  const versions = listAllVersions();
  emit(formatJson, { ok: true, versions }, () =>
    versions.map(v => `${pad(v.version, 6)} ${pad(v.type, 6)} ${v.trigger.padEnd(16)} ${v.createdAt}  ${v.description || ''}`).join('\n') || '(无快照)');
}

function cmdDiff(args: string[], formatJson: boolean): void {
  const v1 = positional(args, 1), v2 = positional(args, 2);
  if (!v1 || !v2) fail(formatJson, 'MISSING_ARG', 'diff 需要 <v1> <v2>');
  const d = diffVersions(v1!, v2!);
  if ('error' in d) fail(formatJson, 'VERSION_NOT_FOUND', d.error);
  emit(formatJson, { ok: true, ...d }, () => {
    const lines: string[] = [];
    for (const f of (d as any).added) lines.push(`+ ${f}`);
    for (const f of (d as any).modified) lines.push(`~ ${f}`);
    for (const f of (d as any).deleted) lines.push(`- ${f}`);
    return lines.join('\n') || '(无差异)';
  });
}

function cmdRestore(args: string[], formatJson: boolean): void {
  gateHumanOnly('config restore', formatJson);
  const version = positional(args, 1);
  if (!version) fail(formatJson, 'MISSING_ARG', 'restore 需要 <version>');
  const r = restore(version!);
  if (!r.ok) fail(formatJson, 'RESTORE_FAILED', r.error || 'restore failed');
  emit(formatJson, { ...r, ok: true }, () => `✓ 已恢复到 ${r.version}（${r.appliedFiles} 个文件），current.json 已更新。`);
}

function cmdCurrent(args: string[], formatJson: boolean): void {
  const cur = readCurrent();
  const boots = readBootLog(1);
  const last = boots[0];
  const fellBack = last?.fellBack && last.actualVersion;
  emit(formatJson, { ok: true, current: cur, lastBoot: last ?? null }, () => {
    const lines: string[] = [];
    lines.push(`选定版本: ${cur ? `${cur.full} / ${cur.delta}` : '(无 current.json)'}`);
    if (fellBack) {
      lines.push(`⚠ 选定版本未实际启动；实际运行 actualVersion=${last.actualVersion!.delta}（上次启动回落）`);
    }
    return lines.join('\n');
  });
}

function cmdBoots(args: string[], formatJson: boolean): void {
  const n = numArg(args, '-n') ?? numArg(args, '--num') ?? 10;
  const boots = readBootLog(n);
  emit(formatJson, { ok: true, boots }, () =>
    boots.map(b => `${b.bootedAt}  ${b.startMethod.padEnd(9)} selected=${b.selectedVersion?.delta ?? '-'} actual=${b.actualVersion?.delta ?? '-'}${b.fellBack ? ' ⚠fellBack' : ''}`).join('\n') || '(无启动记录)');
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function positional(args: string[], idx: number): string | undefined {
  const v = args[idx];
  return v && !v.startsWith('--') ? v : undefined;
}
function numArg(args: string[], flag: string): number | undefined {
  const v = getArgValue(args, flag);
  return v !== undefined ? Number(v) : undefined;
}
function pad(s: string, n: number): string { return (s || '').padEnd(n); }

function failFromConfigErr(e: unknown, formatJson: boolean): never {
  if (e instanceof ConfigError) fail(formatJson, e.code, e.message);
  fail(formatJson, 'CONFIG_ERROR', e instanceof Error ? e.message : String(e));
}

const HELP = `用法: evolclaw config <command> [options]

参数读写:
  get <field>              读 effective 值 + 来源标注
  set <field> <value>      写参数（scope 由 selector 推断，config/behavior 自动判定）
  unset <field>            删除某层显式设置，回落下一层
  show                     查看某一层文件原始内容（不合并，凭证显示 \${VAR}）
  effective                打印合并后的全部生效配置 + 来源
  fields [<field>]         列出可设字段（类型/归属/枚举，来源 schema）
  list                     列出所有配置文件
  validate                 按 schema 校验
  init                     按 schema 物化骨架文件（仅人）

快照/回滚:
  snapshot [--full] [--desc "..."]   立即创建快照（仅人）
  prune [--keep-full N] [--keep-delta N] [--yes]   清理旧快照（仅人，默认 dry-run）
  history                            列出快照版本
  diff <v1> <v2>                     对比两版本
  restore <version>                  恢复到指定版本（仅人）
  current                            显示 current.json 选定版本（回落时告警）
  boots [-n N]                       查看启动历史

作用域 selector:
  --self <aid>             agent 层
  --self <aid> --peer <X>  relation 层
  --default                defaults 层（写操作必须显式带）
  --process                evolclaw.json 进程级（链外单 H）
  (写操作三者全无 → 拒绝)

通用:
  --format json            输出 JSON
  --help, -h               帮助`;

async function dispatch(sub: string, args: string[], formatJson: boolean): Promise<void> {
  switch (sub) {
    case 'get': return cmdGet(args, formatJson);
    case 'set': return cmdSet(args, formatJson);
    case 'unset': return cmdUnset(args, formatJson);
    case 'show': return cmdShow(args, formatJson);
    case 'effective': return cmdEffective(args, formatJson);
    case 'fields': return cmdFields(args, formatJson);
    case 'list': return cmdList(args, formatJson);
    case 'validate': return cmdValidate(args, formatJson);
    case 'init': return cmdInit(args, formatJson);
    case 'snapshot': return cmdSnapshot(args, formatJson);
    case 'prune': return cmdPrune(args, formatJson);
    case 'history': return cmdHistory(args, formatJson);
    case 'diff': return cmdDiff(args, formatJson);
    case 'restore': return cmdRestore(args, formatJson);
    case 'current': return cmdCurrent(args, formatJson);
    case 'boots': return cmdBoots(args, formatJson);
    default:
      fail(formatJson, 'UNKNOWN_SUBCOMMAND', `未知子命令: ${sub}（config --help 查看用法）`);
  }
}

export async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';
  if (!sub || isHelpFlag(sub)) { console.log(HELP); return; }
  if (wantsHelp(args) && sub !== undefined && positional(args, 1) === undefined && args.includes('--help')) {
    // 子命令级 help 仍打总 help（简化）
  }
  try { initConfigManager(); }
  catch (e) { fail(formatJson, 'SCHEMA_INIT_FAILED', e instanceof Error ? e.message : String(e)); }
  await dispatch(sub, args, formatJson);
}

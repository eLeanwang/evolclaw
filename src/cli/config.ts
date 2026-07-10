/**
 * `evolclaw config` —— 配置体系底层通用入口。
 *
 * 16 子命令：get set unset show list validate init effective fields
 *            snapshot prune history diff restore current boots
 * selector：--self / --peer / --default / --process
 *
 * v3 设计：所有参数统一在 config.json，权限控制在 API 层。
 */

import { isHelpFlag, wantsHelp, getArgValue } from './help.js';
import {
  ConfigTarget, read, write, ensureFile, resolveEffective,
  listFields, initConfigManager, ConfigError,
  resolveEffectiveWithSources,
  type Selector,
} from '../config/config-manager.js';
import {
  snapshot, restore, diffVersions, listAllVersions, readCurrent, prune, collectConfigFiles,
} from '../config/snapshot.js';
import { readBootLog } from '../config/boot-log.js';
import { resolvePaths } from '../paths.js';
import { parseConfigSelector } from './config-selector.js';
import { resolveConfigOperation } from '../config/resolved-config-op.js';
import { executeResolvedConfigOperation, type ConfigExecutionResult } from '../config/config-operation-service.js';
import { ipcQuery, type IpcConfigOpResponse } from '../ipc.js';

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

/** 转换权限标记：内部 H/HA → 输出 human-only/configurable */
function formatPermission(permission: string): string {
  if (permission === 'H') return 'human-only';
  if (permission === 'HA') return 'configurable';
  return permission;
}

/** agent 托管环境标志（runner 注入 EVOLCLAW_SESSION_ID）。 */
function isAgentEnv(): boolean {
  return !!process.env.EVOLCLAW_SESSION_ID;
}

// ── selector 解析 ──────────────────────────────────────────────────────────

interface ParsedScope {
  scope: Scope;
  sel: Selector;
}

/** 解析 --self/--peer/--default/--process。forWrite=true 时无 selector 报错（fail-closed）。 */
function parseScope(args: string[], formatJson: boolean, forWrite: boolean): ParsedScope {
  const parsed = parseConfigSelector(args, { requireSelector: forWrite });
  if (!parsed.ok) fail(formatJson, parsed.code, parsed.reason);
  return {
    scope: parsed.scope,
    sel: {
      ...(parsed.self ? { self: parsed.self } : {}),
      ...(parsed.peerKey ? { peerKey: parsed.peerKey } : {}),
    },
  };
}

// ── 权限控制 ────────────────────────────────────────────────────────────

function gateHumanOnly(op: string, formatJson: boolean): void {
  if (isAgentEnv()) fail(formatJson, 'FORBIDDEN', `${op} 仅人可执行（agent 托管环境被拒）`);
}

// ── 命令实现 ──────────────────────────────────────────────────────────────────

function renderConfigExecution(result: ConfigExecutionResult, formatJson: boolean): void {
  if (!result.ok) fail(formatJson, result.code, result.error);
  if (result.subcommand === 'get') {
    const payload = {
      ok: true,
      field: result.field,
      value: result.value,
      scope: result.scope,
      ...(result.source ? { source: result.source } : {}),
    };
    return emit(formatJson, payload, () => {
      if (!result.source) return `${result.field} = ${JSON.stringify(result.value)}  (${result.scope})`;
      const sourceLabel = result.source.target === ConfigTarget.Defaults ? 'defaults' :
        result.source.target === ConfigTarget.Agent ? 'agent' :
        result.source.target === ConfigTarget.Relation ? 'relation' : result.source.target;
      return `${result.field} = ${JSON.stringify(result.value)}  [来自: ${sourceLabel}]`;
    });
  }
  if (result.subcommand === 'set') {
    return emit(formatJson, {
      ok: true,
      field: result.field,
      value: result.value,
      scope: result.scope,
      permission: formatPermission(result.permission),
      file: result.file,
    }, () => `✓ 已设置 ${result.field} = ${JSON.stringify(result.value)}  [config/${result.scope}]\n  生效：该范围所有会话下条消息起。`);
  }
  emit(formatJson, {
    ok: true,
    field: result.field,
    removed: result.removed,
    ...(result.removed ? { scope: result.scope } : {}),
  }, () => result.removed
    ? `✓ 已删除 ${result.field}（${result.scope} 层），回落下一层。`
    : `（${result.field} 在该层未设置，无需删除）`);
}

function runLocalFieldConfig(args: string[], formatJson: boolean): void {
  const resolved = resolveConfigOperation(['config', ...args]);
  if (!resolved.ok) fail(formatJson, resolved.code, resolved.reason);
  renderConfigExecution(executeResolvedConfigOperation(resolved.op), formatJson);
}

async function runManagedFieldConfig(args: string[], formatJson: boolean): Promise<void> {
  const sessionId = process.env.EVOLCLAW_SESSION_ID;
  if (!sessionId) fail(formatJson, 'NO_SESSION', 'EVOLCLAW_SESSION_ID 未设置');
  let response: IpcConfigOpResponse | null;
  try {
    response = await ipcQuery<IpcConfigOpResponse>(resolvePaths().socket, {
      type: 'config.op',
      argv: ['config', ...args],
      sessionId,
    }, 10_000);
  } catch {
    response = null;
  }
  if (!response) fail(formatJson, 'DAEMON_UNAVAILABLE', '无法连接 evolclaw 服务');
  if (!response.ok || !response.result) fail(formatJson, response.code || 'CONFIG_AUTH_FAILED', response.error || 'config operation failed');
  renderConfigExecution(response.result, formatJson);
}

function cmdShow(args: string[], formatJson: boolean): void {
  const { scope, sel } = parseScope(args, formatJson, false);
  const targets = targetsForScope(scope, sel);
  // show 看单层原始内容，不展开 ${VAR}
  const configs: Record<string, unknown> = {};
  for (const { t, s } of targets) {
    configs[t] = read(t, s) || {};
  }
  emit(formatJson, { ok: true, scope, configs }, () => {
    const lines = [`# ${scope} config (原始，未合并，凭证显示 \${VAR})`];
    for (const { t } of targets) {
      lines.push(`\n## ${t}\n${JSON.stringify(configs[t], null, 2)}`);
    }
    return lines.join('\n');
  });
}

function cmdEffective(args: string[], formatJson: boolean): void {
  const { scope, sel } = parseScope(args, formatJson, false);
  if (scope === 'process') {
    const cfg = read(ConfigTarget.Process, sel) || {};
    return emit(formatJson, { ok: true, scope, effective: cfg }, () => JSON.stringify(cfg, null, 2));
  }

  // 使用来源追踪函数
  const effWithSources = resolveEffectiveWithSources(sel);

  if (formatJson) {
    // JSON 格式：返回带来源的完整对象
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(effWithSources)) {
      result[key] = {
        value: item.value,
        source: item.source.target
      };
    }
    emit(formatJson, { ok: true, scope, effective: result }, () => '');
  } else {
    // 文本格式：每个字段一行，带来源标注
    const lines: string[] = [];
    for (const [key, item] of Object.entries(effWithSources)) {
      const sourceLabel = item.source.target === ConfigTarget.Defaults ? 'defaults' :
                         item.source.target === ConfigTarget.Agent ? 'agent' :
                         item.source.target === ConfigTarget.Relation ? 'relation' : item.source.target;
      const valueStr = typeof item.value === 'object'
        ? JSON.stringify(item.value)
        : JSON.stringify(item.value);
      lines.push(`${key}: ${valueStr}  [${sourceLabel}]`);
    }
    emit(formatJson, { ok: true, scope }, () => lines.join('\n'));
  }
}

function cmdFields(args: string[], formatJson: boolean): void {
  const { scope } = parseScope(args, formatJson, false);
  const fields = listFields(scope === 'defaults' ? 'defaults' : scope === 'process' ? 'process' : scope);

  // JSON 输出时转换权限标记
  const fieldsFormatted = formatJson
    ? fields.map(f => ({ ...f, permission: formatPermission(f.permission) }))
    : fields;

  emit(formatJson, { ok: true, scope, fields: fieldsFormatted }, () => {
    const lines = [`# ${scope} 可设字段（来源 schema）`];
    for (const f of fields) {
      const perm = formatPermission(f.permission);
      const en = f.enum ? `  enum=[${f.enum.join('|')}]` : '';
      lines.push(`  ${pad(f.field, 20)} ${pad(perm, 12)}  merge=${pad(f.merge, 6)}${en}`);
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
  const targets = targetsForScope(scope, sel);

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
  const targets = targetsForScope(scope, sel);
  try {
    for (const { t, s } of targets) ensureFile(t, s);
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
    if (cur) {
      lines.push(`当前版本: ${cur.delta}（基于完整快照 ${cur.full}）`);
    } else {
      lines.push('(无 current.json)');
    }
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

function targetsForScope(scope: Scope, sel?: Selector): Array<{ t: ConfigTarget; s?: Selector }> {
  if (scope === 'process') return [{ t: ConfigTarget.Process }];
  if (scope === 'defaults') return [{ t: ConfigTarget.Defaults }];
  if (scope === 'agent') return [
    { t: ConfigTarget.Agent, s: sel },
  ];
  return [
    { t: ConfigTarget.Relation, s: sel },
  ];
}

function failFromConfigErr(e: unknown, formatJson: boolean): never {
  if (e instanceof ConfigError) fail(formatJson, e.code, e.message);
  fail(formatJson, 'CONFIG_ERROR', e instanceof Error ? e.message : String(e));
}

const HELP = `用法: evolclaw config <command> [options]

参数读写:
  get <field>              读 effective 值 + 来源标注
  set <field> <value>      写参数（scope 由 selector 推断，自动判定写入目标）
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
  const isFieldCommand = sub === 'get' || sub === 'set' || sub === 'unset';
  if (isAgentEnv()) {
    if (!isFieldCommand) fail(formatJson, 'FORBIDDEN_AGENT_CONFIG', `Agent 托管环境不允许 config ${sub}`);
    await runManagedFieldConfig(args, formatJson);
    return;
  }
  try { initConfigManager(); }
  catch (e) { fail(formatJson, 'SCHEMA_INIT_FAILED', e instanceof Error ? e.message : String(e)); }
  if (isFieldCommand) {
    runLocalFieldConfig(args, formatJson);
    return;
  }
  await dispatch(sub, args, formatJson);
}

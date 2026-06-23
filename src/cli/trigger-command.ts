import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc.js';
import { isHelpFlag } from './help.js';
import {
  normalizeTriggerDefinition,
  resolveScriptPath,
} from '../trigger/validation.js';
import { isScriptFeedbackConfig, type TriggerCreateFile, type TriggerDefinition } from '../trigger/types.js';

export async function cmdTrigger(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || isHelpFlag(sub)) {
    printHelp();
    return;
  }

  if (sub === 'template') {
    handleTemplate(args.slice(1));
    return;
  }

  const rest = args.slice(1);
  const json = hasFlag(rest, '--json') || flagValue(rest, '--format') === 'json';

  try {
    switch (sub) {
      case 'list':
        await listTriggers(rest, json);
        return;
      case 'show':
        await showTrigger(rest, json);
        return;
      case 'create':
        await createTrigger(rest, json);
        return;
      case 'update':
        await updateTrigger(rest, json);
        return;
      case 'enable':
      case 'disable':
        await setEnabled(rest, sub === 'enable', json);
        return;
      case 'cancel':
        await cancelTrigger(rest, json);
        return;
      case 'run':
        await runTrigger(rest, json);
        return;
      default:
        throw new Error(`unknown trigger subcommand: ${sub}`);
    }
  } catch (err: any) {
    if (json) console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
    else console.error(err?.message || String(err));
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`用法: evolclaw trigger <subcommand>

命令:
  list --agent <aid> [--all] [--json]
  show --agent <aid> <triggerId> [--json]
  create --file <trigger.json|trigger-dir> [--enable] [--json]
    OR
  create --agent <aid> --cron <expr> --prompt <text> [--enable] [其他flag]
  update --agent <aid> <triggerId> --file <trigger.json> [--json]
  enable --agent <aid> <triggerId>
  disable --agent <aid> <triggerId>
  cancel --agent <aid> <triggerId>
  run --agent <aid> <triggerId> [--dry-run] [--json]
  template list|show <name> [--json]

Flag 模式支持的参数（与 /trigger 命令一致）:
  --delay <时长> | --at <ISO时间> | --cron <表达式> | --every <时长>
  --prompt <文本>
  --script <路径> --runtime <node|python|bash>
  --mode <agent|direct>
  --on-fail <notify|silent>  --on-noop <notify|silent>
  --tz <时区> (仅 cron)
  --channel <名称> --channelid <ID>
  --session <latest|current|thread>
  --name <名称>`);
}

async function listTriggers(args: string[], json: boolean): Promise<void> {
  const agentAid = requireFlag(args, '--agent');
  const res = await request({ type: 'trigger.list', agentAid, all: hasFlag(args, '--all') });
  if (json) return printJson(res);
  const triggers = res.triggers as TriggerDefinition[];
  if (triggers.length === 0) {
    console.log('(无 trigger)');
    return;
  }
  for (const t of triggers) {
    console.log(`${t.enabled ? 'on ' : 'off'}  ${t.id}  ${t.name}  ${sourceLabel(t)}`);
  }
}

async function showTrigger(args: string[], json: boolean): Promise<void> {
  const agentAid = requireFlag(args, '--agent');
  const triggerId = positional(args, 0, ['--agent']);
  const res = await request({ type: 'trigger.show', agentAid, triggerId });
  if (json) return printJson(res);
  const t = res.definition as TriggerDefinition;
  console.log(`${t.name} (${t.id})`);
  console.log(`agent: ${t.agentAid}`);
  console.log(`enabled: ${t.enabled}`);
  console.log(`source: ${sourceLabel(t)}`);
  if (t.processing.mode === 'script') console.log(`script: ${t.processing.script.runtime} ${t.processing.script.path}`);
  if (isScriptFeedbackConfig(t.feedback)) {
    console.log(`feedback: success=${t.feedback.onSuccess.mode}, noop=${t.feedback.onNoop?.mode ?? 'none'}, failure=${t.feedback.onFailure.mode}`);
  } else {
    console.log(`feedback: ${t.feedback.mode}`);
  }
  const active = Array.isArray(res.active) ? res.active : [];
  console.log(`active runs: ${active.length}`);
  const recent = Array.isArray(res.recentRuns) ? res.recentRuns : [];
  if (recent.length > 0) {
    console.log('recent:');
    for (const r of recent.slice(0, 5)) {
      console.log(`  ${r.status.padEnd(9)} ${r.reason ?? ''} ${new Date(r.finishedAt).toISOString()} ${r.runId}`);
    }
  }
}

async function createTrigger(args: string[], json: boolean): Promise<void> {
  // Support two modes: --file (full JSON) or flags (parser-based)
  if (hasFlag(args, '--file')) {
    const file = requireFlag(args, '--file');
    const { definition, files } = loadDefinitionWithFiles(file);
    const res = await request({
      type: 'trigger.create',
      definition,
      files,
      enable: hasFlag(args, '--enable') ? true : undefined,
    }, 30_000);
    if (json) return printJson(res);
    console.log(`✓ created ${res.trigger.id} (${res.trigger.name})`);
    return;
  }

  // Flag mode: use parser
  const { parseTriggerSet } = await import('../trigger/parser.js');
  const flagStr = args.filter(a => a !== '--enable' && a !== '--json' && !a.startsWith('--format')).join(' ');
  const parseResult = parseTriggerSet(flagStr);
  if (!parseResult.ok) {
    throw new Error(parseResult.error);
  }

  const parsed = parseResult.value;
  const agentAid = parsed.agentId;
  if (!agentAid) {
    throw new Error('flag 模式需要 --agent <aid> 参数');
  }
  if (!parsed.targetChannel || !parsed.targetChannelId) {
    throw new Error('flag 模式需要显式指定 --channel <channelKey> --channelid <id>');
  }
  if (parsed.targetSessionStrategy === 'current') {
    throw new Error('flag 模式没有当前会话上下文，不支持 --session current');
  }

  // Build minimal definition from parsed flags (server will normalize)
  const now = Date.now();
  const session = {
    channelKey: parsed.targetChannel || '',
    channelId: parsed.targetChannelId || '',
    strategy: parsed.targetThreadId ? 'thread' as const : parsed.targetSessionStrategy,
    ...(parsed.targetThreadId ? { thread: { mode: 'reuse' as const, threadId: parsed.targetThreadId === 'true' ? undefined : parsed.targetThreadId } } : {}),
  };
  const script = parsed.scriptPath ? {
    path: parsed.scriptPath,
    runtime: parsed.scriptRuntime!,
    args: parsed.scriptArgs,
    timeoutMs: 30_000,
  } : undefined;
  const mode = parsed.mode === 'agent-runner' ? 'agent-session' : parsed.mode;
  const definition: any = {
    $schema_version: 2,
    agentAid,
    name: parsed.name || `trigger-${now.toString(36)}`,
    enabled: hasFlag(args, '--enable'),
    createdAt: now,
    updatedAt: now,
    source: sourceFromParsed(parsed),
    session,
    processing: script
      ? { mode: 'script', script }
      : { mode: 'prompt', prompt: parsed.prompt },
    feedback: feedbackFromParsed(parsed, mode, script !== undefined),
    reliability: { concurrency: 'forbid', missedPolicy: 'run_once', scriptRetry: { maxAttempts: 0, backoffMs: 30_000 } },
  };

  const res = await request({
    type: 'trigger.create',
    definition,
    files: [],
    enable: hasFlag(args, '--enable') ? true : undefined,
  }, 30_000);
  if (json) return printJson(res);
  console.log(`✓ created ${res.trigger.id} (${res.trigger.name})`);
}

function sourceFromParsed(parsed: any): any {
  if (parsed.scheduleType === 'delay') return { type: 'delay', afterMs: Number(parsed.scheduleValue) };
  if (parsed.scheduleType === 'at') return { type: 'at', at: parsed.scheduleValue };
  if (parsed.scheduleType === 'cron') {
    const src: any = { type: 'cron', expression: parsed.scheduleValue };
    if (parsed.timezone) src.timezone = parsed.timezone;
    return src;
  }
  if (parsed.scheduleType === 'interval') return { type: 'interval', everyMs: Number(parsed.scheduleValue) };
  throw new Error(`unsupported scheduleType: ${parsed.scheduleType}`);
}

function feedbackFromParsed(parsed: any, mode: string | undefined, hasScript: boolean): any {
  const feedbackMode = mode || (hasScript ? 'direct-message' : 'agent-session');
  const target = parsed.targetChannelId ? {
    channelKey: parsed.targetChannel || '',
    channelType: 'unknown',  // Will be resolved by server
    channelName: parsed.targetChannel || '',
    channelId: parsed.targetChannelId,
    sessionStrategy: parsed.targetSessionStrategy,
  } : undefined;

  const onFailureMode = parsed.onFailure || 'notify';
  const onNoopMode = parsed.onNoop || 'silent';

  if (!hasScript) {
    return {
      mode: feedbackMode,
      target,
    };
  }

  return {
    onSuccess: {
      mode: feedbackMode,
      target,
      template: parsed.prompt || '{{result.text}}',
    },
    onNoop: onNoopMode === 'notify' && target ? { mode: 'direct-message', target, template: '{{error.message}}' } : { mode: 'none' },
    onFailure: onFailureMode === 'notify' && target ? { mode: 'direct-message', target, template: '❌ 触发器执行失败：{{error.message}}' } : { mode: 'none' },
  };
}

async function updateTrigger(args: string[], json: boolean): Promise<void> {
  const agentAid = requireFlag(args, '--agent');
  const file = requireFlag(args, '--file');
  const triggerId = positional(args, 0, ['--agent', '--file']);
  const { definition, files } = loadDefinitionWithFiles(file);
  const res = await request({ type: 'trigger.update', agentAid, triggerId, definition, files }, 30_000);
  if (json) return printJson(res);
  console.log(`✓ updated ${res.trigger.id} (${res.trigger.name})`);
}

async function setEnabled(args: string[], enabled: boolean, json: boolean): Promise<void> {
  const agentAid = requireFlag(args, '--agent');
  const triggerId = positional(args, 0, ['--agent']);
  const res = await request({ type: 'trigger.setEnabled', agentAid, triggerId, enabled });
  if (json) return printJson(res);
  console.log(`✓ ${enabled ? 'enabled' : 'disabled'} ${res.trigger.id}`);
}

async function cancelTrigger(args: string[], json: boolean): Promise<void> {
  const agentAid = requireFlag(args, '--agent');
  const triggerId = positional(args, 0, ['--agent']);
  const res = await request({ type: 'trigger.cancel', agentAid, triggerId });
  if (json) return printJson(res);
  console.log(`✓ cancelled ${res.trigger.id}`);
}

async function runTrigger(args: string[], json: boolean): Promise<void> {
  const agentAid = requireFlag(args, '--agent');
  const triggerId = positional(args, 0, ['--agent']);
  const res = await request({ type: 'trigger.run', agentAid, triggerId, dryRun: hasFlag(args, '--dry-run') }, 120_000);
  if (json) return printJson(res);
  const result = res.result;
  console.log(`${result.status}${result.reason ? ` (${result.reason})` : ''}: ${result.runId}`);
  if (result.error) console.log(result.error);
}

function handleTemplate(args: string[]): void {
  const sub = args[0] || 'list';
  const json = hasFlag(args, '--json') || flagValue(args, '--format') === 'json';
  if (sub === 'list') {
    if (json) printJson({ ok: true, templates: [] });
    else console.log('(无内置 trigger template)');
    return;
  }
  if (sub === 'show') {
    const name = args.find(a => !a.startsWith('-') && a !== 'show');
    if (!name) throw new Error('missing template name');
    if (json) printJson({ ok: false, error: `template not found: ${name}` });
    else console.log(`template not found: ${name}`);
    return;
  }
  throw new Error(`unknown template subcommand: ${sub}`);
}

async function request(cmd: { type: string; [key: string]: unknown }, timeoutMs = 10_000): Promise<any> {
  const res = await ipcQuery<any>(resolvePaths().socket, cmd, timeoutMs);
  if (!res) throw new Error('错误: 无法连接 evolclaw 服务');
  if (res.ok === false || res.error) throw new Error(res.error || 'trigger command failed');
  return res;
}

function loadDefinitionWithFiles(inputPath: string): { definition: TriggerDefinition; files: TriggerCreateFile[] } {
  const stat = fs.statSync(inputPath);
  const baseDir = stat.isDirectory() ? inputPath : path.dirname(inputPath);
  const jsonPath = stat.isDirectory() ? path.join(inputPath, 'trigger.json') : inputPath;
  const definition = normalizeTriggerDefinition(JSON.parse(fs.readFileSync(jsonPath, 'utf-8')));
  const files: TriggerCreateFile[] = [];
  if (definition.processing.mode === 'script') {
    const scriptAbs = resolveScriptPath(baseDir, definition.processing.script.path);
    const relativePath = path.relative(baseDir, scriptAbs).replace(/\\/g, '/');
    files.push({ relativePath, contentBase64: fs.readFileSync(scriptAbs).toString('base64') });
  }
  return { definition, files };
}

function sourceLabel(t: TriggerDefinition): string {
  switch (t.source.type) {
    case 'delay': return `delay ${t.source.afterMs}ms`;
    case 'at': return `at ${t.source.at}`;
    case 'cron': return `cron ${t.source.expression}${t.source.timezone ? ` (${t.source.timezone})` : ''}`;
    case 'interval': return `interval ${t.source.everyMs}ms`;
    case 'event': return `event ${t.source.eventPattern}`;
  }
}

function requireFlag(args: string[], name: string): string {
  const value = flagValue(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefixed = args.find(a => a.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positional(args: string[], index: number, flagsWithValue: string[]): string {
  const skip = new Set<number>();
  for (const flag of flagsWithValue) {
    const idx = args.indexOf(flag);
    if (idx >= 0) { skip.add(idx); skip.add(idx + 1); }
  }
  const values = args.filter((a, i) => !skip.has(i) && !a.startsWith('-'));
  const value = values[index];
  if (!value) throw new Error('missing triggerId');
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

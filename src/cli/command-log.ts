/**
 * 命令集执行日志 —— 每执行一条 `ec` 命令追加一行 JSONL。日志按天切分（一天一个文件，
 * 文件名 commands-YYYYMMDD.jsonl）。
 *
 * 挂在唯一 choke-point（src/cli/index.ts 的 main() 第一行），所有子命令必经，
 * 无需改动任何具体命令集代码。
 *
 * 两级落盘：
 *   - 汇总日志 $EVOLCLAW_HOME/logs/commands-YYYYMMDD.jsonl：所有命令（不论有无 AID）都记
 *     一份，一处看全貌；记录带 selfAid，按 agent 过滤一行 grep 即可。
 *   - per-agent 日志 agents/<aid>/logs/commands-YYYYMMDD.jsonl：能同步解析出 self-AID 时
 *     额外再记一份，便于单独查看某个 agent。
 *
 * 原则：日志写失败静默降级，绝不影响命令执行（沿用 log-writer.ts 的取舍）。
 */
import fs from 'fs';
import path from 'path';
import { agentLogsDir, resolvePaths } from '../paths.js';
import { getArgValue } from './help.js';
import { readTaskRuntimeContextFromEnv } from '../core/task-runtime-context.js';

/**
 * 同步解析当前执行者 self-AID（零延迟，绝不走 IPC）。
 * 优先级：--as <aid> > EVOLCLAW_SELF_AID > runtime context 里的 selfAid。
 */
function resolveSelfAid(args: string[]): string | undefined {
  return (
    getArgValue(args, '--as') ||
    process.env.EVOLCLAW_SELF_AID ||
    readTaskRuntimeContextFromEnv()?.selfAid
  );
}

/**
 * 记录一条命令执行。同步、best-effort。
 * @param cmd  子命令（args[0]，缺省时为 'start'）
 * @param args 完整 argv 原样
 */
export function logCliCommand(cmd: string, args: string[]): void {
  const selfAid = resolveSelfAid(args);
  const line =
    JSON.stringify({
      ts: localTimestamp(),
      cmd,
      // 完整命令行，可直接拷贝执行（含 ec 前缀，含空格的参数自动加引号）
      command: `ec ${args.map(shellQuote).join(' ')}`,
      selfAid: selfAid || undefined,
      sessionId: process.env.EVOLCLAW_SESSION_ID || undefined,
    }) + '\n';

  const fileName = `commands-${dayTag()}.jsonl`;
  // 汇总日志：所有命令（不论有无 AID）都记一份，一处看全貌。
  appendLine(resolvePaths().logs, fileName, line);
  // per-agent 日志：有 AID 时再额外记一份到该 agent 自己的 logs/，便于单独查看。
  if (selfAid) appendLine(agentLogsDir(selfAid), fileName, line);
}

/** 本地时间字符串 YYYY-MM-DD HH:mm:ss（不含时区偏移，直接可读）。 */
function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 拼命令行时给单个参数按需加引号：含空格/引号/特殊字符才包一层单引号。 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** 本地日期 tag YYYYMMDD，用于日志文件按天切分（一天一个文件）。 */
function dayTag(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 追加一行到 <dir>/<fileName>，best-effort——写失败静默降级，绝不影响命令执行。 */
function appendLine(dir: string, fileName: string, line: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, fileName), line);
  } catch {
    // 日志不能影响业务
  }
}

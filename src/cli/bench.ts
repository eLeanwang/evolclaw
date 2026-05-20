import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { aidList, aidCreate } from '../aun/aid/identity.js';
import { msgSend, msgPull } from '../aun/msg/index.js';
import type { MsgError } from '../aun/msg/p2p.js';
import { getPackageRoot } from '../paths.js';

const execFileAsync = promisify(execFile);

// ==================== ANSI ====================

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RST = '\x1b[0m';

function ok(msg: string) { return `  ${GREEN}✓${RST} ${msg}`; }
function fail(msg: string) { return `  ${RED}✗${RST} ${msg}`; }
function warn(msg: string) { return `  ${YELLOW}!${RST} ${msg}`; }

// ==================== Types ====================

type SizeClass = 'S' | 'M' | 'L';

interface SendTask {
  seq: number;
  from: string;
  to: string;
  sizeClass: SizeClass;
  text: string;
}

interface SendResult {
  seq: number;
  sizeClass: SizeClass;
  ok: boolean;
  sendMs: number;
  serverTimestamp?: number;
  sendTimestamp: number;
  from: string;
  to: string;
  error?: string;
}

interface RecvRecord {
  seq: number;
  sizeClass: SizeClass;
  sendTimestamp: number;
  serverTimestamp: number;
}

interface BenchMetrics {
  sent: number;
  received: number;
  lossRate: number;
  throughput: number;
  latencyAvg: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  sendTimeAvg: number;
}

// ==================== Helpers ====================

const PADDING_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function makePadding(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += PADDING_ALPHABET[i % PADDING_ALPHABET.length];
  return s;
}

function targetSize(cls: SizeClass): number {
  switch (cls) {
    case 'S': return 50;
    case 'M': return 500;
    case 'L': return 5000;
  }
}

function buildMessageText(seq: number, cls: SizeClass, timestamp: number, sessionId: string): string {
  const header = `[bench:${sessionId}:${String(seq).padStart(4, '0')}:${cls}:${timestamp}] `;
  const padLen = Math.max(0, targetSize(cls) - header.length);
  return header + makePadding(padLen);
}

const BENCH_RE = /^\[bench:([a-f0-9]+):(\d+):([SML]):(\d+)\]\s/;

function parseMessage(text: string, sessionId: string): { seq: number; sizeClass: SizeClass; sendTimestamp: number } | null {
  const m = text.match(BENCH_RE);
  if (!m || m[1] !== sessionId) return null;
  return { seq: parseInt(m[2], 10), sizeClass: m[3] as SizeClass, sendTimestamp: parseInt(m[4], 10) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ==================== Promise Pool ====================

async function runPool<T>(tasks: (() => Promise<T>)[], concurrency: number, onDone?: (result: T, idx: number) => void): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIdx < tasks.length) {
      const i = nextIdx++;
      results[i] = await tasks[i]();
      onDone?.(results[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ==================== Progress Display ====================

function renderProgress(done: number, total: number, rate: number, counts: Record<SizeClass, number>): string {
  const width = 20;
  const filled = Math.round((done / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `  Sending [${CYAN}${bar}${RST}] ${done}/${total}  (${BOLD}${rate.toFixed(1)}${RST} msg/s)  S:${counts.S} M:${counts.M} L:${counts.L}`;
}

function clearLine() {
  process.stdout.write('\r\x1b[K');
}

// ==================== Table Rendering ====================

function pad(s: string, w: number, align: 'left' | 'right' = 'right'): string {
  if (s.length >= w) return s.slice(0, w);
  return align === 'left' ? s + ' '.repeat(w - s.length) : ' '.repeat(w - s.length) + s;
}

function renderTable(all: BenchMetrics, bySize: Record<SizeClass, BenchMetrics>, meta: { aids: number; concurrency: number; duration: number }): string {
  const W = 10;
  const LW = 17;

  function fmtNum(n: number): string { return String(n); }
  function fmtPct(n: number): string { return n.toFixed(1) + '%'; }
  function fmtRate(n: number): string { return n.toFixed(1) + '/s'; }
  function fmtMs(n: number): string { return Math.round(n) + 'ms'; }

  const rows: [string, string, string, string, string][] = [
    ['Sent',         fmtNum(all.sent),       fmtNum(bySize.S.sent),       fmtNum(bySize.M.sent),       fmtNum(bySize.L.sent)],
    ['Received',     fmtNum(all.received),   fmtNum(bySize.S.received),   fmtNum(bySize.M.received),   fmtNum(bySize.L.received)],
    ['Loss %',       fmtPct(all.lossRate),   fmtPct(bySize.S.lossRate),   fmtPct(bySize.M.lossRate),   fmtPct(bySize.L.lossRate)],
    ['Throughput',   fmtRate(all.throughput), fmtRate(bySize.S.throughput),fmtRate(bySize.M.throughput),fmtRate(bySize.L.throughput)],
    ['Latency avg',  fmtMs(all.latencyAvg),  fmtMs(bySize.S.latencyAvg), fmtMs(bySize.M.latencyAvg), fmtMs(bySize.L.latencyAvg)],
    ['Latency P50',  fmtMs(all.latencyP50),  fmtMs(bySize.S.latencyP50), fmtMs(bySize.M.latencyP50), fmtMs(bySize.L.latencyP50)],
    ['Latency P95',  fmtMs(all.latencyP95),  fmtMs(bySize.S.latencyP95), fmtMs(bySize.M.latencyP95), fmtMs(bySize.L.latencyP95)],
    ['Latency P99',  fmtMs(all.latencyP99),  fmtMs(bySize.S.latencyP99), fmtMs(bySize.M.latencyP99), fmtMs(bySize.L.latencyP99)],
    ['Send time avg',fmtMs(all.sendTimeAvg), fmtMs(bySize.S.sendTimeAvg),fmtMs(bySize.M.sendTimeAvg),fmtMs(bySize.L.sendTimeAvg)],
  ];

  const sep = `├${'─'.repeat(LW)}┼${'─'.repeat(W)}┼${'─'.repeat(W)}┼${'─'.repeat(W)}┼${'─'.repeat(W)}┤`;
  const top = `┌${'─'.repeat(LW)}┬${'─'.repeat(W)}┬${'─'.repeat(W)}┬${'─'.repeat(W)}┬${'─'.repeat(W)}┐`;
  const bot = `└${'─'.repeat(LW)}┴${'─'.repeat(W)}┴${'─'.repeat(W)}┴${'─'.repeat(W)}┴${'─'.repeat(W)}┘`;

  function row(cells: [string, string, string, string, string]): string {
    return `│${pad(cells[0], LW, 'left')}│${pad(cells[1], W)}│${pad(cells[2], W)}│${pad(cells[3], W)}│${pad(cells[4], W)}│`;
  }

  const lines: string[] = [
    '',
    `${BOLD}  AUN Messaging Benchmark Results${RST}`,
    '',
    top,
    row([' Metric', 'All', 'Small', 'Medium', 'Large']),
    sep,
    ...rows.map(r => row([' ' + r[0], r[1], r[2], r[3], r[4]])),
    sep,
    row([' AIDs used', String(meta.aids), '', '', '']),
    row([' Concurrency', String(meta.concurrency), '', '', '']),
    row([' Duration', meta.duration.toFixed(2) + 's', '', '', '']),
    bot,
    '',
  ];
  return lines.join('\n');
}

// ==================== Metrics Calculation ====================

function computeMetrics(results: SendResult[], received: RecvRecord[], durationSec: number): BenchMetrics {
  const sent = results.filter(r => r.ok).length;
  const recvCount = received.length;
  const lossRate = sent > 0 ? ((sent - recvCount) / sent) * 100 : 0;
  const throughput = durationSec > 0 ? sent / durationSec : 0;

  const latencies = received
    .map(r => r.serverTimestamp - r.sendTimestamp)
    .filter(l => l >= 0)
    .sort((a, b) => a - b);

  const latencyAvg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const latencyP50 = percentile(latencies, 50);
  const latencyP95 = percentile(latencies, 95);
  const latencyP99 = percentile(latencies, 99);

  const sendTimes = results.filter(r => r.ok).map(r => r.sendMs);
  const sendTimeAvg = sendTimes.length > 0 ? sendTimes.reduce((a, b) => a + b, 0) / sendTimes.length : 0;

  return { sent, received: recvCount, lossRate, throughput, latencyAvg, latencyP50, latencyP95, latencyP99, sendTimeAvg };
}

function filterBySize(results: SendResult[], received: RecvRecord[], cls: SizeClass, durationSec: number): BenchMetrics {
  return computeMetrics(
    results.filter(r => r.sizeClass === cls),
    received.filter(r => r.sizeClass === cls),
    durationSec,
  );
}

// ==================== Auth Benchmark ====================

interface AuthResult {
  aid: string;
  ok: boolean;
  authMs: number;
  error?: string;
}

async function benchAuth(aids: string[], concurrency: number, aunPath?: string, slotId?: string): Promise<AuthResult[]> {
  const { createShortConnection } = await import('../aun/rpc/index.js');
  const tasks = aids.map(aid => async (): Promise<AuthResult> => {
    const start = Date.now();
    try {
      const conn = await createShortConnection(aid, { aunPath, slotId: slotId ?? 'bench' });
      await conn.close();
      return { aid, ok: true, authMs: Date.now() - start };
    } catch (e: any) {
      return { aid, ok: false, authMs: Date.now() - start, error: e.message };
    }
  });
  return runPool(tasks, concurrency);
}

// ==================== Switch-Account Benchmark ====================

interface SwitchResult {
  seq: number;
  from: string;
  to: string;
  ok: boolean;
  totalMs: number;
  sendTimestamp: number;
  serverTimestamp?: number;
}

async function benchSwitch(aids: string[], rounds: number, aunPath?: string, useCli?: boolean, slotId?: string): Promise<{ results: SwitchResult[]; durationSec: number }> {
  const results: SwitchResult[] = [];
  const start = Date.now();
  let seq = 0;
  const slot = slotId ?? 'bench';

  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < aids.length; i++) {
      const from = aids[i];
      const to = aids[(i + 1) % aids.length];
      const sendTs = Date.now();
      const text = `[switch:${String(seq).padStart(4, '0')}:${sendTs}] ping`;
      const t0 = Date.now();

      let ok = false;
      let serverTimestamp: number | undefined;

      if (useCli) {
        const res = await cliSend(from, to, text, slot);
        ok = res.ok;
        serverTimestamp = res.timestamp;
      } else {
        const res = await msgSend({ from, to, body: { mode: 'text', text }, slotId: slot, aunPath });
        ok = res.ok;
        serverTimestamp = res.ok ? (res as any).timestamp : undefined;
      }

      const totalMs = Date.now() - t0;
      results.push({ seq: seq++, from, to, ok, totalMs, sendTimestamp: sendTs, serverTimestamp });
    }
  }

  return { results, durationSec: (Date.now() - start) / 1000 };
}

// ==================== CLI Mode Helpers ====================

async function cliSend(from: string, to: string, text: string, slotId: string): Promise<{ ok: boolean; timestamp?: number; error?: string }> {
  const path = (await import('path')).default;
  const bin = path.join(getPackageRoot(), 'dist', 'cli', 'index.js');
  try {
    const { stdout } = await execFileAsync('node', [bin, 'msg', 'send', from, to, text, '--app', slotId, '--format', 'json'], { timeout: 30000 });
    const res = JSON.parse(stdout.trim());
    return { ok: true, timestamp: res.timestamp };
  } catch (e: any) {
    const stderr = e.stderr || e.message || String(e);
    return { ok: false, error: stderr.slice(0, 200) };
  }
}

async function cliPull(from: string, slotId: string, afterSeq?: number): Promise<{ ok: boolean; messages?: any[]; error?: string }> {
  const path = (await import('path')).default;
  const bin = path.join(getPackageRoot(), 'dist', 'cli', 'index.js');
  const pullArgs = [bin, 'msg', 'pull', from, '--app', slotId, '--format', 'json', '--limit', '200'];
  if (afterSeq !== undefined) pullArgs.push('--after-seq', String(afterSeq));
  try {
    const { stdout } = await execFileAsync('node', pullArgs, { timeout: 30000 });
    const res = JSON.parse(stdout.trim());
    return { ok: true, messages: res.messages ?? [] };
  } catch (e: any) {
    return { ok: false, error: (e.stderr || e.message || '').slice(0, 200) };
  }
}

async function cliAuth(aid: string, slotId: string): Promise<{ ok: boolean; authMs: number }> {
  const path = (await import('path')).default;
  const bin = path.join(getPackageRoot(), 'dist', 'cli', 'index.js');
  const start = Date.now();
  try {
    await execFileAsync('node', [bin, 'msg', 'online', aid, aid, '--app', slotId, '--format', 'json'], { timeout: 15000 });
    return { ok: true, authMs: Date.now() - start };
  } catch {
    return { ok: false, authMs: Date.now() - start };
  }
}

// ==================== Main Command ====================

export async function cmdBench(args: string[]): Promise<void> {
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    console.log(`用法: evolclaw bench [options]

AUN 消息系统性能基准测试。使用多个本地 AID 并发互发消息，
测量吞吐量、延迟、丢失率，以及认证性能和账号切换性能。

Options:
  --aids N          使用的 AID 数量 (默认 3, 范围 2-10)
  --rounds N        每个 AID 发送的消息轮数 (默认 20)
  --concurrency N   最大并发发送数 (默认 5)
  --wait N          发送后等待传播的秒数 (默认 3)
  --cli             使用 CLI 子进程调用（测试完整命令行链路，含进程启动开销）
  --aun-path <path> 自定义 AUN 目录
  --format json     以 JSON 输出结果

示例:
  evolclaw bench --aids 5 --rounds 10
  evolclaw bench --aids 3 --rounds 50 --concurrency 10
  evolclaw bench --cli --aids 3 --rounds 5`);
    return;
  }

  const numAids = Math.min(10, Math.max(2, parseInt(getArgValue(args, '--aids') || '3', 10)));
  const rounds = Math.max(1, parseInt(getArgValue(args, '--rounds') || '20', 10));
  const concurrency = Math.max(1, parseInt(getArgValue(args, '--concurrency') || '5', 10));
  const waitSec = Math.max(1, parseInt(getArgValue(args, '--wait') || '3', 10));
  const aunPath = getArgValue(args, '--aun-path');
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';
  const cliMode = args.includes('--cli');
  const sessionId = crypto.randomBytes(4).toString('hex');
  const benchSlot = `bench-${sessionId}`;

  if (!formatJson) {
    console.log(`\n${BOLD}  evolclaw bench${RST} — AUN 消息性能基准测试`);
    console.log(`  ${'━'.repeat(50)}`);
    console.log(`  ${DIM}模式: ${cliMode ? 'CLI 子进程（含进程启动开销）' : 'SDK 直调（纯网络性能）'}${RST}\n`);
  }

  // ── Phase 1: Prepare AIDs ──
  if (!formatJson) console.log(`${DIM}  Phase 1: 准备 AIDs${RST}`);

  const allAids = aidList(aunPath);
  const withKey = allAids.filter(a => a.hasPrivateKey).map(a => a.aid);
  const aids: string[] = [];

  if (!formatJson) console.log(ok(`本地找到 ${withKey.length} 个有私钥的 AID，正在验证可用性...`));

  // Suppress SDK error logs during probe (broken AIDs are expected)
  const origError = console.error;
  console.error = () => {};

  // Probe all AIDs with keys to find working ones
  const probeAll = await benchAuth(withKey, concurrency, aunPath);
  const workingAids = probeAll.filter(r => r.ok).map(r => r.aid);

  console.error = origError;

  if (workingAids.length >= numAids) {
    aids.push(...workingAids.slice(0, numAids));
    if (!formatJson) console.log(ok(`选取 ${numAids} 个可用 AID（共 ${workingAids.length} 个认证通过）`));
  } else {
    aids.push(...workingAids);
    const need = numAids - workingAids.length;
    if (!formatJson) console.log(warn(`仅 ${workingAids.length} 个可用，需创建 ${need} 个新 AID`));
    for (let i = 0; i < need; i++) {
      const hex = crypto.randomBytes(4).toString('hex');
      const newAid = `bench-${hex}.agentid.pub`;
      try {
        await aidCreate(newAid, { aunPath });
        aids.push(newAid);
        if (!formatJson) console.log(ok(`创建 ${newAid}`));
      } catch (e: any) {
        if (!formatJson) console.log(fail(`创建 ${newAid} 失败: ${e.message}`));
      }
    }
  }

  if (aids.length < 2) {
    console.error(`${RED}  ✗ 可用 AID 不足 2 个，无法测试${RST}`);
    process.exit(1);
  }

  if (!formatJson) {
    console.log(`    ${DIM}AIDs: ${aids.join(', ')}${RST}\n`);
  }

  // ── Phase 2: Auth Benchmark ──
  if (!formatJson) console.log(`${DIM}  Phase 2: 认证性能测试${RST}`);

  const authRounds = 3;
  const authTasks: string[] = [];
  for (let r = 0; r < authRounds; r++) authTasks.push(...aids);

  let authResults: AuthResult[];
  if (cliMode) {
    const cliAuthTasks = authTasks.map(aid => async (): Promise<AuthResult> => {
      const r = await cliAuth(aid, benchSlot);
      return { aid, ok: r.ok, authMs: r.authMs };
    });
    authResults = await runPool(cliAuthTasks, concurrency);
  } else {
    authResults = await benchAuth(authTasks, concurrency, aunPath, benchSlot);
  }
  const authOk = authResults.filter(r => r.ok);
  const authFail = authResults.filter(r => !r.ok);
  const authTimes = authOk.map(r => r.authMs).sort((a, b) => a - b);
  const authAvg = authTimes.length > 0 ? authTimes.reduce((a, b) => a + b, 0) / authTimes.length : 0;
  const authP50 = percentile(authTimes, 50);
  const authP95 = percentile(authTimes, 95);

  if (!formatJson) {
    console.log(ok(`认证 ${authOk.length}/${authResults.length} 次成功  avg=${Math.round(authAvg)}ms  P50=${authP50}ms  P95=${authP95}ms`));
    if (authFail.length > 0) console.log(fail(`${authFail.length} 次认证失败`));
    console.log('');
  }

  // ── Phase 3: Concurrent Send ──
  if (!formatJson) console.log(`${DIM}  Phase 3: 并发消息发送（混合大小：S/M/L）${RST}`);

  const totalMsgs = rounds * aids.length;
  const tasks: SendTask[] = [];
  const sizeClasses: SizeClass[] = ['S', 'M', 'L'];
  for (let i = 0; i < totalMsgs; i++) {
    const fromIdx = i % aids.length;
    let toIdx = Math.floor(Math.random() * (aids.length - 1));
    if (toIdx >= fromIdx) toIdx++;
    const cls = sizeClasses[i % 3];
    tasks.push({
      seq: i,
      from: aids[fromIdx],
      to: aids[toIdx],
      sizeClass: cls,
      text: '',
    });
  }

  const sendResults: SendResult[] = [];
  const counts: Record<SizeClass, number> = { S: 0, M: 0, L: 0 };
  const sendStart = Date.now();
  let lastRender = 0;

  const sendFns = tasks.map(t => async (): Promise<SendResult> => {
    const sendTs = Date.now();
    const text = buildMessageText(t.seq, t.sizeClass, sendTs, sessionId);
    const t0 = Date.now();
    try {
      if (cliMode) {
        const res = await cliSend(t.from, t.to, text, benchSlot);
        const sendMs = Date.now() - t0;
        return {
          seq: t.seq, sizeClass: t.sizeClass, ok: res.ok, sendMs,
          serverTimestamp: res.timestamp, sendTimestamp: sendTs,
          from: t.from, to: t.to, error: res.error,
        };
      }
      const res = await msgSend({
        from: t.from, to: t.to,
        body: { mode: 'text', text },
        slotId: benchSlot, aunPath,
      });
      const sendMs = Date.now() - t0;
      return {
        seq: t.seq, sizeClass: t.sizeClass, ok: res.ok, sendMs,
        serverTimestamp: res.ok ? (res as any).timestamp : undefined,
        sendTimestamp: sendTs, from: t.from, to: t.to,
        error: !res.ok ? (res as MsgError).error : undefined,
      };
    } catch (e: any) {
      return {
        seq: t.seq, sizeClass: t.sizeClass, ok: false,
        sendMs: Date.now() - t0, sendTimestamp: sendTs,
        from: t.from, to: t.to, error: e.message || String(e),
      };
    }
  });

  await runPool(sendFns, concurrency, (r) => {
    sendResults.push(r);
    counts[r.sizeClass]++;
    const now = Date.now();
    if (!formatJson && (now - lastRender > 100 || sendResults.length === totalMsgs)) {
      lastRender = now;
      const elapsed = (now - sendStart) / 1000;
      const rate = sendResults.length / Math.max(elapsed, 0.001);
      clearLine();
      process.stdout.write(renderProgress(sendResults.length, totalMsgs, rate, counts));
    }
  });

  const sendDuration = (Date.now() - sendStart) / 1000;
  if (!formatJson) {
    clearLine();
    const okCount = sendResults.filter(r => r.ok).length;
    console.log(ok(`发送完成 ${okCount}/${totalMsgs}  耗时 ${sendDuration.toFixed(2)}s  ${(okCount / sendDuration).toFixed(1)} msg/s`));
    console.log('');
  }

  // ── Phase 4: Pull & Verify ──
  if (!formatJson) console.log(`${DIM}  Phase 4: 拉取消息验证（等待 ${waitSec}s 传播）${RST}`);
  await new Promise(r => setTimeout(r, waitSec * 1000));

  const received: RecvRecord[] = [];
  const receivedSeqs = new Set<number>();

  async function pullAll(): Promise<void> {
    for (let i = 0; i < aids.length; i++) {
      const aid = aids[i];
      let afterSeq: number | undefined = undefined;
      for (let page = 0; page < 20; page++) {
        let messages: any[] = [];
        if (cliMode) {
          const res = await cliPull(aid, '', afterSeq);
          if (!res.ok) {
            if (!formatJson) console.log(fail(`拉取 ${aid} 失败: ${res.error}`));
            break;
          }
          messages = res.messages ?? [];
        } else {
          let res: any;
          try {
            res = await msgPull({ from: aid, slotId: '', limit: 200, afterSeq, aunPath });
          } catch (e: any) {
            if (!formatJson) console.log(fail(`拉取 ${aid} 异常: ${e.message}`));
            break;
          }
          if (!res.ok) {
            if (!formatJson) console.log(fail(`拉取 ${aid} 失败: ${res.error}`));
            break;
          }
          messages = res.messages ?? [];
        }
        for (const m of messages) {
          const text = typeof m.payload?.text === 'string' ? m.payload.text as string : '';
          const parsed = parseMessage(text, sessionId);
          if (parsed && !receivedSeqs.has(parsed.seq)) {
            receivedSeqs.add(parsed.seq);
            received.push({
              seq: parsed.seq,
              sizeClass: parsed.sizeClass,
              sendTimestamp: parsed.sendTimestamp,
              serverTimestamp: m.timestamp,
            });
          }
          afterSeq = Math.max(afterSeq ?? 0, m.seq);
        }
        if (messages.length < 200) break;
      }
      if (!formatJson) {
        clearLine();
        process.stdout.write(`  Pulling [${CYAN}${'█'.repeat(i + 1)}${'░'.repeat(aids.length - i - 1)}${RST}] ${i + 1}/${aids.length}  recv=${received.length}`);
      }
    }
  }

  const sentSeqs = new Set(sendResults.filter(r => r.ok).map(r => r.seq));
  for (let retry = 0; retry < 3; retry++) {
    await pullAll();
    const missing = [...sentSeqs].filter(s => !receivedSeqs.has(s)).length;
    if (missing === 0) break;
    if (!formatJson) {
      clearLine();
      console.log(warn(`重试 ${retry + 1}/3  缺失 ${missing} 条，等待 2s 后再拉...`));
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!formatJson) {
    clearLine();
    console.log(ok(`拉取完成  收到 ${received.length}/${sentSeqs.size} 条消息`));
    console.log('');
  }

  // ── Phase 5: Switch-Account Benchmark ──
  if (!formatJson) console.log(`${DIM}  Phase 5: 频繁切换账号收发测试${RST}`);

  const switchRounds = Math.max(2, Math.min(rounds, 5));
  const switchOut = await benchSwitch(aids, switchRounds, aunPath, cliMode, benchSlot);
  const switchOkResults = switchOut.results.filter(r => r.ok);
  const switchLatencies = switchOkResults
    .filter(r => r.serverTimestamp !== undefined)
    .map(r => (r.serverTimestamp as number) - r.sendTimestamp)
    .filter(l => l >= 0)
    .sort((a, b) => a - b);
  const switchSendTimes = switchOkResults.map(r => r.totalMs).sort((a, b) => a - b);
  const switchAvgLatency = switchLatencies.length > 0 ? switchLatencies.reduce((a, b) => a + b, 0) / switchLatencies.length : 0;
  const switchAvgSendMs = switchSendTimes.length > 0 ? switchSendTimes.reduce((a, b) => a + b, 0) / switchSendTimes.length : 0;
  const switchThroughput = switchOut.durationSec > 0 ? switchOkResults.length / switchOut.durationSec : 0;

  if (!formatJson) {
    console.log(ok(`切换发送 ${switchOkResults.length}/${switchOut.results.length}  耗时 ${switchOut.durationSec.toFixed(2)}s  ${switchThroughput.toFixed(1)} msg/s`));
    console.log(`    ${DIM}avg latency=${Math.round(switchAvgLatency)}ms  avg send=${Math.round(switchAvgSendMs)}ms  P95 send=${percentile(switchSendTimes, 95)}ms${RST}`);
    console.log('');
  }

  // ── Phase 6: Compute Metrics & Output ──
  const all = computeMetrics(sendResults, received, sendDuration);
  const bySize: Record<SizeClass, BenchMetrics> = {
    S: filterBySize(sendResults, received, 'S', sendDuration),
    M: filterBySize(sendResults, received, 'M', sendDuration),
    L: filterBySize(sendResults, received, 'L', sendDuration),
  };

  const missingSeqs = [...sentSeqs].filter(s => !receivedSeqs.has(s));

  if (formatJson) {
    console.log(JSON.stringify({
      ok: true,
      config: { aids: aids.length, rounds, concurrency, waitSec, cliMode },
      aids,
      auth: {
        attempts: authResults.length,
        ok: authOk.length,
        failed: authFail.length,
        avgMs: Math.round(authAvg),
        p50Ms: authP50,
        p95Ms: authP95,
      },
      messaging: {
        all,
        bySize,
        durationSec: sendDuration,
        missingSeqs,
      },
      switchAccount: {
        rounds: switchRounds,
        attempts: switchOut.results.length,
        ok: switchOkResults.length,
        durationSec: switchOut.durationSec,
        throughput: switchThroughput,
        avgLatencyMs: Math.round(switchAvgLatency),
        avgSendMs: Math.round(switchAvgSendMs),
      },
    }, null, 2));
    return;
  }

  console.log(renderTable(all, bySize, { aids: aids.length, concurrency, duration: sendDuration }));

  // 附加指标
  const W2 = 22;
  console.log(`${BOLD}  附加性能指标${RST}\n`);
  console.log(`  ${pad('认证平均耗时', W2, 'left')} ${BOLD}${Math.round(authAvg)}ms${RST}  (P50=${authP50}ms, P95=${authP95}ms, 样本 ${authOk.length})`);
  console.log(`  ${pad('认证失败次数', W2, 'left')} ${authFail.length > 0 ? RED : GREEN}${authFail.length}${RST}`);
  console.log(`  ${pad('切换账号 throughput', W2, 'left')} ${BOLD}${switchThroughput.toFixed(1)} msg/s${RST}  (${switchOkResults.length} 次，${switchOut.durationSec.toFixed(2)}s)`);
  console.log(`  ${pad('切换账号 avg latency', W2, 'left')} ${BOLD}${Math.round(switchAvgLatency)}ms${RST}`);
  console.log(`  ${pad('切换账号 avg send', W2, 'left')} ${BOLD}${Math.round(switchAvgSendMs)}ms${RST}`);
  console.log('');

  // 带宽估算
  const totalBytes = sendResults.filter(r => r.ok).reduce((sum, r) => sum + targetSize(r.sizeClass), 0);
  const bandwidthKBps = sendDuration > 0 ? (totalBytes / 1024) / sendDuration : 0;
  console.log(`  ${pad('总发送字节', W2, 'left')} ${BOLD}${(totalBytes / 1024).toFixed(1)} KB${RST}`);
  console.log(`  ${pad('带宽（发送方向）', W2, 'left')} ${BOLD}${bandwidthKBps.toFixed(1)} KB/s${RST}`);
  console.log('');

  // 丢失消息列表
  if (missingSeqs.length > 0) {
    console.log(`${YELLOW}  ⚠ 丢失 ${missingSeqs.length} 条消息${RST}`);
    const sample = missingSeqs.slice(0, 10);
    console.log(`    ${DIM}seq: ${sample.join(', ')}${missingSeqs.length > 10 ? ` ... +${missingSeqs.length - 10}` : ''}${RST}`);
  } else {
    console.log(`${GREEN}  ✓ 零丢失，所有 ${all.sent} 条消息全部送达${RST}`);
  }
  console.log('');
}


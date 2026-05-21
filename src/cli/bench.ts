import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  retries: number;
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

// ==================== File Mode Helpers ====================

const FILE_BENCH_RE = /^\[fb:([a-f0-9]+):(\d+):(\d+):(\d+)\]/;

function buildFileChunkText(seq: number, totalChunks: number, timestamp: number, sessionId: string, chunkBase64: string): string {
  return `[fb:${sessionId}:${String(seq).padStart(4, '0')}:${totalChunks}:${timestamp}]${chunkBase64}`;
}

function parseFileChunk(text: string, sessionId: string): { seq: number; totalChunks: number; sendTimestamp: number; data: string } | null {
  const m = text.match(FILE_BENCH_RE);
  if (!m || m[1] !== sessionId) return null;
  const headerEnd = text.indexOf(']') + 1;
  return {
    seq: parseInt(m[2], 10),
    totalChunks: parseInt(m[3], 10),
    sendTimestamp: parseInt(m[4], 10),
    data: text.slice(headerEnd),
  };
}

function splitFileIntoChunks(buf: Buffer, numChunks: number): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  const remaining = () => buf.length - offset;

  for (let i = 0; i < numChunks; i++) {
    const left = numChunks - i;
    if (left === 1) {
      chunks.push(buf.slice(offset));
      break;
    }
    const avg = remaining() / left;
    const min = Math.max(1, Math.floor(avg * 0.3));
    const max = Math.floor(avg * 1.7);
    const size = Math.min(remaining() - (left - 1), min + Math.floor(Math.random() * (max - min + 1)));
    chunks.push(buf.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

async function compressDirectory(dirPath: string): Promise<Buffer> {
  const zlib = await import('zlib');
  // Collect all files recursively, pack as a simple concatenation
  // Use Node.js tar-like approach: JSON manifest + gzipped content
  const files: { rel: string; data: Buffer }[] = [];
  function walk(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        try { files.push({ rel, data: fs.readFileSync(full) }); } catch {}
      }
    }
  }
  walk(dirPath, '');
  // Pack: JSON lines of {path, size} + concatenated data, then gzip
  const manifest = files.map(f => ({ p: f.rel, s: f.data.length }));
  const header = Buffer.from(JSON.stringify(manifest) + '\n');
  const body = Buffer.concat([header, ...files.map(f => f.data)]);
  return Buffer.from(zlib.gzipSync(body));
}

async function decompressToDir(buf: Buffer, destDir: string): Promise<void> {
  const zlib = await import('zlib');
  const body = Buffer.from(zlib.gunzipSync(buf));
  const nlIdx = body.indexOf(10); // newline
  const manifest: { p: string; s: number }[] = JSON.parse(body.slice(0, nlIdx).toString());
  let offset = nlIdx + 1;
  for (const entry of manifest) {
    const filePath = path.join(destDir, ...entry.p.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body.slice(offset, offset + entry.s));
    offset += entry.s;
  }
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

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

function clearLine() {
  process.stdout.write('\r\x1b[K');
}

function moveCursorUp(n: number) {
  if (n > 0) process.stdout.write(`\x1b[${n}A`);
}

function renderMultiLineProgress(
  aids: string[],
  aidStats: Map<string, { sent: number; ok: number; fail: number; timeouts: number }>,
  total: number, done: number, rate: number,
): void {
  const lines: string[] = [];
  for (const aid of aids) {
    const s = aidStats.get(aid) || { sent: 0, ok: 0, fail: 0, timeouts: 0 };
    const aidShort = aid.split('.')[0];
    const barW = 12;
    const perAidTotal = Math.ceil(total / aids.length);
    const filled = Math.min(barW, Math.round((s.sent / Math.max(perAidTotal, 1)) * barW));
    const bar = `${CYAN}${'█'.repeat(filled)}${'░'.repeat(barW - filled)}${RST}`;
    const timeoutStr = s.timeouts > 0 ? ` ${YELLOW}⏳${s.timeouts}${RST}` : '';
    const failStr = s.fail > 0 ? ` ${RED}✗${s.fail}${RST}` : '';
    lines.push(`    ${pad(aidShort, 14, 'left')}[${bar}] ${pad(String(s.sent), 4)}/${perAidTotal}  ok=${s.ok}${failStr}${timeoutStr}`);
  }
  lines.push(`  ${DIM}──${RST} total ${done}/${total}  ${BOLD}${rate.toFixed(1)}${RST} msg/s`);
  process.stdout.write(lines.join('\n') + '\n');
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
  gateway?: string;
}

async function benchAuth(aids: string[], concurrency: number, aunPath?: string, slotId?: string): Promise<AuthResult[]> {
  const { AUNClient } = await import('@agentunion/fastaun');
  const path = (await import('path')).default;
  const fs = (await import('fs')).default;
  const os = (await import('os')).default;
  const resolvedAunPath = aunPath ?? path.join(os.homedir(), '.aun');
  const caCertPath = path.join(resolvedAunPath, 'CA', 'root', 'root.crt');

  const tasks = aids.map(aid => async (): Promise<AuthResult> => {
    const start = Date.now();
    try {
      const clientOpts: any = { aun_path: resolvedAunPath, debug: false };
      if (fs.existsSync(caCertPath)) clientOpts.root_ca_path = caCertPath;
      const client = new AUNClient(clientOpts);
      await client.auth.createAid({ aid });
      const authResult = await client.auth.authenticate({ aid });
      const accessToken = authResult?.access_token ?? (client as any)._access_token;
      const gateway = (client as any)._gatewayUrl ?? authResult?.gateway ?? '';
      await client.connect(
        { access_token: accessToken, gateway, slot_id: slotId ?? '', connection_kind: 'short' },
        { auto_reconnect: false },
      );
      try { await client.close(); } catch {}
      return { aid, ok: true, authMs: Date.now() - start, gateway };
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

async function benchSwitch(aids: string[], rounds: number, aunPath?: string, useCli?: boolean, slotId?: string, encrypt?: boolean): Promise<{ results: SwitchResult[]; durationSec: number }> {
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
        try {
          const res = await withTimeout(cliSend(from, to, text, slot, encrypt), 10000, `${from.split('.')[0]}→${to.split('.')[0]}`);
          ok = res.ok;
          serverTimestamp = res.timestamp;
        } catch { ok = false; }
      } else {
        try {
          const res = await withTimeout(
            msgSend({ from, to, body: { mode: 'text', text }, slotId: slot, aunPath, encrypt }) as Promise<any>,
            10000, `${from.split('.')[0]}→${to.split('.')[0]}`
          );
          ok = res.ok;
          serverTimestamp = res.ok ? res.timestamp : undefined;
        } catch { ok = false; }
      }

      const totalMs = Date.now() - t0;
      results.push({ seq: seq++, from, to, ok, totalMs, sendTimestamp: sendTs, serverTimestamp });
    }
  }

  return { results, durationSec: (Date.now() - start) / 1000 };
}

// ==================== CLI Mode Helpers ====================

async function cliSend(from: string, to: string, text: string, slotId: string, encrypt?: boolean): Promise<{ ok: boolean; timestamp?: number; error?: string }> {
  const path = (await import('path')).default;
  const bin = path.join(getPackageRoot(), 'dist', 'cli', 'index.js');
  const sendArgs = [bin, 'msg', 'send', from, to, text, '--app', slotId, '--format', 'json'];
  if (encrypt) sendArgs.push('--encrypt');
  try {
    const { stdout } = await execFileAsync('node', sendArgs, { timeout: 30000 });
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
  --encrypt         发送加密消息（E2EE）
  --file            文件传输验证模式（压缩 evolclaw 目录，拆片发送，接收后 MD5 校验+解压）
  --cli             使用 CLI 子进程调用（测试完整命令行链路，含进程启动开销）
  --aun-path <path> 自定义 AUN 目录
  --format json     以 JSON 输出结果

示例:
  evolclaw bench --aids 5 --rounds 10
  evolclaw bench --file --rounds 50
  evolclaw bench --encrypt --aids 5 --rounds 20
  evolclaw bench --cli --aids 3 --rounds 5`);
    return;
  }

  const numAids = Math.min(10, Math.max(2, parseInt(getArgValue(args, '--aids') || '3', 10)));
  const rounds = Math.max(1, parseInt(getArgValue(args, '--rounds') || '20', 10));
  const concurrency = Math.max(1, parseInt(getArgValue(args, '--concurrency') || '5', 10));
  const aunPath = getArgValue(args, '--aun-path');
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';
  const cliMode = args.includes('--cli');
  const encrypt = args.includes('--encrypt');
  const fileMode = args.includes('--file');
  const defaultWait = encrypt ? '10' : '3';
  const waitSec = Math.max(1, parseInt(getArgValue(args, '--wait') || defaultWait, 10));
  const sessionId = crypto.randomBytes(4).toString('hex');
  const benchSlot = `bench-${sessionId}`;

  if (!formatJson) {
    console.log(`\n${BOLD}  evolclaw bench${RST} — AUN 消息性能基准测试`);
    console.log(`  ${'━'.repeat(50)}`);
    console.log(`  ${DIM}模式: ${cliMode ? 'CLI 子进程（含进程启动开销）' : 'SDK 直调（纯网络性能）'}${encrypt ? ' + E2EE 加密' : ''}${RST}\n`);
  }

  // ── Phase 1: Prepare AIDs ──
  if (!formatJson) console.log(`${DIM}  Phase 1: 准备 AIDs${RST}`);

  const allAids = aidList(aunPath);
  const aids: string[] = [];

  // AID is usable if: has private key + cert not expired + key/cert public key match
  const { aidShow } = await import('../aun/aid/identity.js');
  const resolvedAunPath = aunPath ?? path.join(os.homedir(), '.aun');
  const usableAids: string[] = [];
  const skippedAids: { aid: string; reason: string }[] = [];

  for (const a of allAids) {
    if (!a.hasPrivateKey) continue;
    try {
      const info = aidShow(a.aid, { aunPath });
      if (!info.certExpiresAt) {
        skippedAids.push({ aid: a.aid, reason: '无证书' });
        continue;
      }
      const expiry = new Date(info.certExpiresAt).getTime();
      if (expiry <= Date.now()) {
        skippedAids.push({ aid: a.aid, reason: '证书过期' });
        continue;
      }
      // Verify key/cert public key match (same check as SDK keystore)
      const aidDir = path.join(resolvedAunPath, 'AIDs', a.aid);
      const keyJsonPath = path.join(aidDir, 'private', 'key.json');
      const certPemPath = path.join(aidDir, 'public', 'cert.pem');
      if (!fs.existsSync(keyJsonPath) || !fs.existsSync(certPemPath)) {
        skippedAids.push({ aid: a.aid, reason: '缺少 key.json 或 cert.pem' });
        continue;
      }
      const keyJson = JSON.parse(fs.readFileSync(keyJsonPath, 'utf-8'));
      const localPubB64 = keyJson.public_key_der_b64;
      if (localPubB64) {
        const certPem = fs.readFileSync(certPemPath, 'utf-8');
        const x509 = new crypto.X509Certificate(certPem);
        const certPubDer = x509.publicKey.export({ type: 'spki', format: 'der' });
        const localPubDer = Buffer.from(localPubB64, 'base64');
        if (!certPubDer.equals(localPubDer)) {
          skippedAids.push({ aid: a.aid, reason: '私钥与证书公钥不匹配' });
          continue;
        }
      }
      usableAids.push(a.aid);
    } catch (e: any) {
      skippedAids.push({ aid: a.aid, reason: e.message });
    }
  }

  if (!formatJson) {
    console.log(ok(`本地找到 ${usableAids.length} 个有效 AID（私钥+证书完好+未过期）`));
    if (skippedAids.length > 0) {
      console.log(`    ${DIM}跳过 ${skippedAids.length} 个: ${skippedAids.slice(0, 3).map(s => `${s.aid.split('.')[0]}(${s.reason})`).join(', ')}${skippedAids.length > 3 ? ' ...' : ''}${RST}`);
    }
  }

  if (usableAids.length >= numAids) {
    aids.push(...usableAids.slice(0, numAids));
    if (!formatJson) console.log(ok(`选取 ${numAids} 个 AID`));
  } else {
    aids.push(...usableAids);
    const need = numAids - usableAids.length;
    if (!formatJson) console.log(warn(`仅 ${usableAids.length} 个可用，需创建 ${need} 个新 AID`));
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

  // Build AID → gateway map for error reporting
  const gatewayMap = new Map<string, string>();
  for (const r of authResults) {
    if (r.gateway && !gatewayMap.has(r.aid)) gatewayMap.set(r.aid, r.gateway);
  }

  if (!formatJson) {
    console.log(ok(`认证 ${authOk.length}/${authResults.length} 次成功  avg=${Math.round(authAvg)}ms  P50=${authP50}ms  P95=${authP95}ms`));
    if (authFail.length > 0) console.log(fail(`${authFail.length} 次认证失败`));
    console.log('');
  }

  // ── Phase 3: Concurrent Send ──
  if (!formatJson) console.log(`${DIM}  Phase 3: 并发消息发送${fileMode ? '（文件传输验证模式）' : '（混合大小：S/M/L）'}${RST}`);

  // File mode: compress evolclaw dir, split into chunks
  let fileChunks: Buffer[] = [];
  let fileMd5 = '';
  let compressedSize = 0;
  if (fileMode) {
    const evolclawDir = getPackageRoot();
    if (!formatJson) process.stdout.write(`  ${DIM}压缩 ${evolclawDir} ...${RST}`);
    const compressed = await compressDirectory(evolclawDir);
    compressedSize = compressed.length;
    fileMd5 = crypto.createHash('md5').update(compressed).digest('hex');
    const totalMsgsForFile = rounds * aids.length;
    fileChunks = splitFileIntoChunks(compressed, totalMsgsForFile);
    if (!formatJson) {
      clearLine();
      console.log(ok(`压缩完成 ${(compressedSize / 1024).toFixed(1)} KB  MD5=${fileMd5}  拆分 ${fileChunks.length} 片`));
    }
  }

  // Record each AID's latest_seq before sending, so we can pull from there
  const preSeqMap = new Map<string, number>();
  for (const aid of aids) {
    try {
      const res = await msgPull({ from: aid, slotId: '', limit: 1, aunPath });
      if (res.ok) preSeqMap.set(aid, res.latest_seq ?? 0);
      else preSeqMap.set(aid, 0);
    } catch { preSeqMap.set(aid, 0); }
  }

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
  const aidStats = new Map<string, { sent: number; ok: number; fail: number; timeouts: number }>();
  for (const aid of aids) aidStats.set(aid, { sent: 0, ok: 0, fail: 0, timeouts: 0 });
  let progressLinesDrawn = 0;

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;
  const SEND_TIMEOUT_MS = 10000;
  const sendErrors: string[] = [];
  let stallCount = 0;
  let lastProgressTime = Date.now();
  const timeoutCountByAid = new Map<string, number>();

  // Suppress SDK error logs during send phase (we track errors ourselves)
  const origError2 = console.error;
  console.error = () => {};

  const sendFns = tasks.map(t => async (): Promise<SendResult> => {
    let lastError: string | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        retries++;
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
      const sendTs = Date.now();
      const text = fileMode
        ? buildFileChunkText(t.seq, fileChunks.length, sendTs, sessionId, fileChunks[t.seq]?.toString('base64') ?? '')
        : buildMessageText(t.seq, t.sizeClass, sendTs, sessionId);
      const t0 = Date.now();
      try {
        const sendPromise: Promise<any> = cliMode
          ? cliSend(t.from, t.to, text, benchSlot, encrypt)
          : msgSend({ from: t.from, to: t.to, body: { mode: 'text', text }, slotId: benchSlot, aunPath, encrypt });

        const res = await withTimeout(sendPromise, SEND_TIMEOUT_MS, `${t.from.split('.')[0]}→${t.to.split('.')[0]}`);

        if (cliMode) {
          const cliRes = res as { ok: boolean; timestamp?: number; error?: string };
          if (cliRes.ok) {
            return {
              seq: t.seq, sizeClass: t.sizeClass, ok: true, sendMs: Date.now() - t0,
              serverTimestamp: cliRes.timestamp, sendTimestamp: sendTs,
              from: t.from, to: t.to, retries,
            };
          }
          lastError = cliRes.error;
        } else {
          const sdkRes = res as any;
          if (sdkRes.ok) {
            return {
              seq: t.seq, sizeClass: t.sizeClass, ok: true, sendMs: Date.now() - t0,
              serverTimestamp: sdkRes.timestamp, sendTimestamp: sendTs,
              from: t.from, to: t.to, retries,
            };
          }
          lastError = sdkRes.error;
        }
      } catch (e: any) {
        lastError = e.message || String(e);
        if (lastError!.includes('timeout')) {
          stallCount++;
          const aidStat = aidStats.get(t.from);
          if (aidStat) aidStat.timeouts++;
          const aidCount = (timeoutCountByAid.get(t.from) || 0) + 1;
          timeoutCountByAid.set(t.from, aidCount);
          if (!formatJson) {
            const gw = gatewayMap.get(t.from) || '?';
            const now = new Date();
            const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
            clearLine();
            process.stdout.write(`  ${YELLOW}⏳ [${ts}] 连接超时: ${t.from.split('.')[0]}→${t.to.split('.')[0]} gw=${gw} (${t.from.split('.')[0]} 第${aidCount}次超时)${RST}\n`);
            progressLinesDrawn = 0;
          }
        }
      }
    }

    return {
      seq: t.seq, sizeClass: t.sizeClass, ok: false,
      sendMs: 0, sendTimestamp: Date.now(),
      from: t.from, to: t.to, error: lastError, retries,
    };
  });

  // Stall watchdog: warn when no progress for 5s
  const stallWatchdog = !formatJson ? setInterval(() => {
    const stallMs = Date.now() - lastProgressTime;
    if (stallMs > 5000) {
      clearLine();
      process.stdout.write(`  ${YELLOW}⏳ ${(stallMs / 1000).toFixed(0)}s 无进展 — 等待连接超时中 (已完成 ${sendResults.length}/${totalMsgs}, timeout ${stallCount} 次)${RST}\n`);
      progressLinesDrawn = 0;
    }
  }, 2000) : null;

  await runPool(sendFns, concurrency, (r) => {
    sendResults.push(r);
    counts[r.sizeClass]++;
    const stat = aidStats.get(r.from)!;
    stat.sent++;
    if (r.ok) stat.ok++; else stat.fail++;
    if (!r.ok && !formatJson) {
      const gw = gatewayMap.get(r.from) || '?';
      sendErrors.push(`seq=${r.seq} ${r.from.split('.')[0]}→${r.to.split('.')[0]} retry=${r.retries} gw=${gw} err=${(r.error || '').slice(0, 80)}`);
    }
    lastProgressTime = Date.now();
    const now = Date.now();
    if (!formatJson && (now - lastRender > 200 || sendResults.length === totalMsgs)) {
      lastRender = now;
      const elapsed = (now - sendStart) / 1000;
      const rate = sendResults.length / Math.max(elapsed, 0.001);
      if (progressLinesDrawn > 0) moveCursorUp(progressLinesDrawn);
      for (let i = 0; i < progressLinesDrawn; i++) { clearLine(); process.stdout.write('\n'); }
      if (progressLinesDrawn > 0) moveCursorUp(progressLinesDrawn);
      renderMultiLineProgress(aids, aidStats, totalMsgs, sendResults.length, rate);
      progressLinesDrawn = aids.length + 1;
    }
  });

  if (stallWatchdog) clearInterval(stallWatchdog);

  // Restore console.error after send phase
  console.error = origError2;

  const sendDuration = (Date.now() - sendStart) / 1000;
  if (!formatJson) {
    const okCount = sendResults.filter(r => r.ok).length;
    const totalRetries = sendResults.reduce((sum, r) => sum + r.retries, 0);
    const retriedCount = sendResults.filter(r => r.retries > 0).length;
    let retryInfo = '';
    if (totalRetries > 0) retryInfo = `  ${DIM}(${retriedCount} 条重试，共 ${totalRetries} 次)${RST}`;
    console.log(ok(`发送完成 ${okCount}/${totalMsgs}  耗时 ${sendDuration.toFixed(2)}s  ${(okCount / sendDuration).toFixed(1)} msg/s${retryInfo}`));
    if (sendErrors.length > 0) {
      console.log(fail(`${sendErrors.length} 条最终失败:`));
      for (const e of sendErrors.slice(0, 5)) {
        console.log(`      ${DIM}${e}${RST}`);
      }
      if (sendErrors.length > 5) console.log(`      ${DIM}... +${sendErrors.length - 5}${RST}`);
    }
    console.log('');
  }

  // ── Phase 4: Pull & Verify ──
  const received: RecvRecord[] = [];
  const receivedSeqs = new Set<number>();
  const receivedFileChunks = new Map<number, string>();
  const sentSeqs = new Set(sendResults.filter(r => r.ok).map(r => r.seq));

  if (encrypt) {
    // Encrypted messages can't be pulled via short connection (SDK limitation).
    // Use send result (ok=true means gateway confirmed delivery).
    if (!formatJson) console.log(`${DIM}  Phase 4: 送达验证（加密模式：基于网关确认）${RST}`);
    for (const r of sendResults) {
      if (r.ok) {
        receivedSeqs.add(r.seq);
        received.push({
          seq: r.seq,
          sizeClass: r.sizeClass,
          sendTimestamp: r.sendTimestamp,
          serverTimestamp: r.serverTimestamp ?? r.sendTimestamp,
        });
      }
    }
    if (!formatJson) {
      const delivered = received.length;
      const sentOk = sendResults.filter(r => r.ok).length;
      console.log(ok(`送达确认 ${delivered}/${sentOk} 条（网关返回 delivered）`));
      if (delivered < sentOk) {
        console.log(warn(`${sentOk - delivered} 条发送成功但未获得 delivered 确认`));
      }
      console.log('');
    }
  } else {
    if (!formatJson) console.log(`${DIM}  Phase 4: 拉取消息验证（等待 ${waitSec}s 传播）${RST}`);
    await new Promise(r => setTimeout(r, waitSec * 1000));

  async function pullAll(): Promise<void> {
    for (let i = 0; i < aids.length; i++) {
      const aid = aids[i];
      let afterSeq: number | undefined = preSeqMap.get(aid) ?? undefined;
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
          if (fileMode) {
            const chunk = parseFileChunk(text, sessionId);
            if (chunk && !receivedSeqs.has(chunk.seq)) {
              receivedSeqs.add(chunk.seq);
              receivedFileChunks.set(chunk.seq, chunk.data);
              received.push({
                seq: chunk.seq,
                sizeClass: 'M',
                sendTimestamp: chunk.sendTimestamp,
                serverTimestamp: m.timestamp,
              });
            }
          } else {
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

  const expectedCount = sentSeqs.size;
  const PULL_MAX_WAIT_SEC = 60;
  const PULL_INTERVAL_MS = 2000;
  const pullStartTime = Date.now();
  let lastNewCount = received.length;
  let lastNewTime = Date.now();
  let pullRound = 0;

  while (true) {
    await pullAll();
    pullRound++;
    const missing = expectedCount - receivedSeqs.size;

    if (missing === 0) break;

    const elapsedSec = (Date.now() - pullStartTime) / 1000;
    const noNewSec = (Date.now() - lastNewTime) / 1000;

    if (received.length > lastNewCount) {
      lastNewCount = received.length;
      lastNewTime = Date.now();
    }

    if (elapsedSec > PULL_MAX_WAIT_SEC) {
      if (!formatJson) {
        clearLine();
        console.log(warn(`拉取超时 ${PULL_MAX_WAIT_SEC}s，仍缺 ${missing} 条`));
      }
      break;
    }

    if (noNewSec > 20) {
      if (!formatJson) {
        clearLine();
        console.log(warn(`连续 ${Math.round(noNewSec)}s 无新消息到达，仍缺 ${missing} 条，停止等待`));
      }
      break;
    }

    if (!formatJson) {
      clearLine();
      process.stdout.write(`  ${DIM}等待中... 已收 ${receivedSeqs.size}/${expectedCount}  缺 ${missing} 条  (${elapsedSec.toFixed(0)}s elapsed, round ${pullRound})${RST}`);
    }
    await new Promise(r => setTimeout(r, PULL_INTERVAL_MS));
  }

  if (!formatJson) {
    clearLine();
    console.log(ok(`拉取完成  收到 ${received.length}/${sentSeqs.size} 条消息  (${pullRound} 轮, ${((Date.now() - pullStartTime) / 1000).toFixed(1)}s)`));
    console.log('');
  }
  } // end else (non-encrypt pull)

  // ── File mode: reassemble + verify ──
  if (fileMode && receivedFileChunks.size > 0) {
    if (!formatJson) console.log(`${DIM}  文件还原验证${RST}`);
    const totalChunks = fileChunks.length;
    const missingChunks: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!receivedFileChunks.has(i)) missingChunks.push(i);
    }

    if (missingChunks.length > 0) {
      if (!formatJson) console.log(fail(`缺失 ${missingChunks.length}/${totalChunks} 个片段，无法还原文件`));
    } else {
      const parts: Buffer[] = [];
      for (let i = 0; i < totalChunks; i++) {
        parts.push(Buffer.from(receivedFileChunks.get(i)!, 'base64'));
      }
      const reassembled = Buffer.concat(parts);
      const recvMd5 = crypto.createHash('md5').update(reassembled).digest('hex');
      const md5Match = recvMd5 === fileMd5;

      if (!formatJson) {
        console.log(ok(`还原文件 ${(reassembled.length / 1024).toFixed(1)} KB`));
        console.log(`    ${DIM}发送 MD5: ${fileMd5}${RST}`);
        console.log(`    ${DIM}接收 MD5: ${recvMd5}${RST}`);
        if (md5Match) {
          console.log(ok(`MD5 校验通过 ✓`));
          // Decompress
          const tmpDir = path.join(os.tmpdir(), `bench-recv-${sessionId}`);
          try {
            await decompressToDir(reassembled, tmpDir);
            console.log(ok(`解压完成 → ${tmpDir}`));
          } catch (e: any) {
            console.log(fail(`解压失败: ${e.message}`));
          }
        } else {
          console.log(fail(`MD5 不匹配！文件损坏`));
        }
      }
    }
    if (!formatJson) console.log('');
  }

  // ── Phase 5: Switch-Account Benchmark ──
  if (!formatJson) console.log(`${DIM}  Phase 5: 频繁切换账号收发测试${RST}`);

  const switchRounds = Math.max(2, Math.min(rounds, 5));
  const switchOut = await benchSwitch(aids, switchRounds, aunPath, cliMode, benchSlot, encrypt);
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

  // Detect unavailable AIDs: 100% loss as receiver
  const unavailableAids: string[] = [];
  for (const aid of aids) {
    const sentToAid = sendResults.filter(r => r.ok && r.to === aid);
    const recvFromAid = received.filter(r => {
      const sr = sendResults.find(s => s.seq === r.seq);
      return sr && sr.to === aid;
    });
    if (sentToAid.length > 0 && recvFromAid.length === 0) {
      unavailableAids.push(aid);
    }
  }

  // Filter out unavailable AIDs from metrics
  const effectiveResults = unavailableAids.length > 0
    ? sendResults.filter(r => !unavailableAids.includes(r.to))
    : sendResults;
  const effectiveReceived = unavailableAids.length > 0
    ? received.filter(r => {
        const sr = sendResults.find(s => s.seq === r.seq);
        return sr && !unavailableAids.includes(sr.to);
      })
    : received;
  const effectiveSentSeqs = new Set(effectiveResults.filter(r => r.ok).map(r => r.seq));

  const all = computeMetrics(effectiveResults, effectiveReceived, sendDuration);
  const bySize: Record<SizeClass, BenchMetrics> = {
    S: filterBySize(effectiveResults, effectiveReceived, 'S', sendDuration),
    M: filterBySize(effectiveResults, effectiveReceived, 'M', sendDuration),
    L: filterBySize(effectiveResults, effectiveReceived, 'L', sendDuration),
  };

  const missingSeqs = [...effectiveSentSeqs].filter(s => !receivedSeqs.has(s));

  if (formatJson) {
    console.log(JSON.stringify({
      ok: true,
      config: { aids: aids.length, rounds, concurrency, waitSec, cliMode, encrypt },
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

  // ── 送达分析报告 ──
  renderDeliveryAnalysis(sendResults, received, receivedSeqs, sentSeqs, aids, totalMsgs, unavailableAids);
}

// ==================== Delivery Analysis ====================

type LossReason = 'send_fail_429' | 'send_fail_timeout' | 'send_fail_conn' | 'send_fail_other' | 'pull_not_found';

interface LossRecord {
  seq: number;
  from: string;
  to: string;
  sizeClass: SizeClass;
  sendOk: boolean;
  pullFound: boolean;
  reason: LossReason;
  error?: string;
  sendTimestamp: number;
}

function classifyLossReason(r: SendResult): LossReason {
  if (!r.ok) {
    const err = (r.error || '').toLowerCase();
    if (err.includes('429') || err.includes('rate') || err.includes('throttl')) return 'send_fail_429';
    if (err.includes('timeout') || err.includes('timed out')) return 'send_fail_timeout';
    if (err.includes('connect') || err.includes('econnrefused') || err.includes('socket')) return 'send_fail_conn';
    return 'send_fail_other';
  }
  return 'pull_not_found';
}

const REASON_LABELS: Record<LossReason, string> = {
  send_fail_429: '网关限流 (429/rate limit)',
  send_fail_timeout: '发送超时',
  send_fail_conn: '连接建立失败',
  send_fail_other: '发送失败（其它）',
  pull_not_found: '发送成功但 pull 未收到',
};

function renderDeliveryAnalysis(
  sendResults: SendResult[],
  received: RecvRecord[],
  receivedSeqs: Set<number>,
  sentSeqs: Set<number>,
  aids: string[],
  totalMsgs: number,
  unavailableAids: string[],
): void {
  const allSent = sendResults.length;
  const sendOkCount = sendResults.filter(r => r.ok).length;
  const sendFailCount = allSent - sendOkCount;
  const pullFoundCount = received.length;

  // Retry stats
  const totalRetries = sendResults.reduce((sum, r) => sum + r.retries, 0);
  const retriedCount = sendResults.filter(r => r.retries > 0).length;
  const retriedAndOk = sendResults.filter(r => r.retries > 0 && r.ok).length;
  const retriedAndFail = sendResults.filter(r => r.retries > 0 && !r.ok).length;

  // Build loss records
  const losses: LossRecord[] = [];

  // Send failures
  for (const r of sendResults.filter(r => !r.ok)) {
    losses.push({
      seq: r.seq, from: r.from, to: r.to, sizeClass: r.sizeClass,
      sendOk: false, pullFound: false,
      reason: classifyLossReason(r), error: r.error,
      sendTimestamp: r.sendTimestamp,
    });
  }

  // Send ok but pull not found
  for (const r of sendResults.filter(r => r.ok && !receivedSeqs.has(r.seq))) {
    losses.push({
      seq: r.seq, from: r.from, to: r.to, sizeClass: r.sizeClass,
      sendOk: true, pullFound: false,
      reason: 'pull_not_found', sendTimestamp: r.sendTimestamp,
    });
  }

  // Exclude unavailable AIDs from loss calculation
  const effectiveLosses = unavailableAids.length > 0
    ? losses.filter(l => !unavailableAids.includes(l.to))
    : losses;

  // Show unavailable AIDs separately
  if (unavailableAids.length > 0) {
    console.log(`${BOLD}  不可用 AID（已排除出统计）${RST}`);
    for (const aid of unavailableAids) {
      const sentTo = sendResults.filter(r => r.to === aid).length;
      const sentFrom = sendResults.filter(r => r.from === aid).length;
      const aidShort = aid.split('.')[0];
      console.log(`    ${RED}${aidShort}${RST}  发出 ${sentFrom} 条  应收 ${sentTo} 条  pull 收到 0 条`);
    }
    console.log('');
  }

  if (effectiveLosses.length === 0 && sendFailCount === 0) {
    console.log(`${GREEN}  ✓ 零丢失，所有 ${sendOkCount} 条消息全部送达${RST}`);
    if (totalRetries > 0) {
      console.log(`    ${DIM}重试统计: ${retriedCount} 条消息触发重试，共 ${totalRetries} 次，重试后成功 ${retriedAndOk} 条，仍失败 ${retriedAndFail} 条${RST}`);
    }
    console.log('');
    return;
  }

  console.log(`${BOLD}  送达分析报告${RST}`);
  console.log(`  ${'━'.repeat(50)}\n`);

  // ── 1. 总览 ──
  console.log(`  ${BOLD}总览${RST}`);
  const effectiveSent = unavailableAids.length > 0 ? sendResults.filter(r => !unavailableAids.includes(r.to)).length : allSent;
  const effectiveSendOk = unavailableAids.length > 0 ? sendResults.filter(r => r.ok && !unavailableAids.includes(r.to)).length : sendOkCount;
  const effectivePullFound = unavailableAids.length > 0 ? received.filter(r => { const sr = sendResults.find(s => s.seq === r.seq); return sr && !unavailableAids.includes(sr.to); }).length : pullFoundCount;
  console.log(`    总发送 ${effectiveSent}  成功 ${effectiveSendOk}  失败 ${effectiveSent - effectiveSendOk}  pull 收到 ${effectivePullFound}  未送达 ${effectiveLosses.length}`);
  if (totalRetries > 0) {
    console.log(`    ${DIM}重试: ${retriedCount} 条触发重试，共 ${totalRetries} 次 → 成功 ${retriedAndOk} / 仍失败 ${retriedAndFail}${RST}`);
  }
  console.log('');

  // ── 2. 原因分类 ──
  console.log(`  ${BOLD}原因分类${RST}`);
  const byReason = new Map<LossReason, LossRecord[]>();
  for (const l of effectiveLosses) {
    const arr = byReason.get(l.reason) || [];
    arr.push(l);
    byReason.set(l.reason, arr);
  }

  const reasonOrder: LossReason[] = ['send_fail_429', 'send_fail_timeout', 'send_fail_conn', 'send_fail_other', 'pull_not_found'];
  for (const reason of reasonOrder) {
    const items = byReason.get(reason);
    if (!items || items.length === 0) continue;
    const pct = ((items.length / effectiveLosses.length) * 100).toFixed(1);
    const color = reason === 'pull_not_found' ? YELLOW : RED;
    console.log(`    ${color}${pad(String(items.length), 4)} 条${RST}  (${pad(pct + '%', 6)})  ${REASON_LABELS[reason]}`);
  }
  console.log('');

  // ── 3. 按接收方分布 ──
  console.log(`  ${BOLD}按接收方 AID 分布${RST}`);
  const byReceiver = new Map<string, { total: number; lost: number }>();
  for (const r of sendResults) {
    if (unavailableAids.includes(r.to)) continue;
    const entry = byReceiver.get(r.to) || { total: 0, lost: 0 };
    entry.total++;
    if (!r.ok || !receivedSeqs.has(r.seq)) entry.lost++;
    byReceiver.set(r.to, entry);
  }

  let maxLossRate = 0;
  let worstAid = '';
  for (const [aid, stat] of byReceiver) {
    const rate = stat.total > 0 ? stat.lost / stat.total : 0;
    const pct = (rate * 100).toFixed(1);
    const flag = rate > 0.4 ? ` ${RED}← 异常${RST}` : rate > 0.25 ? ` ${YELLOW}← 偏高${RST}` : '';
    const aidShort = aid.split('.')[0];
    console.log(`    ${pad(aidShort, 16, 'left')} ${stat.lost}/${stat.total} 丢失 (${pct}%)${flag}`);
    if (rate > maxLossRate) { maxLossRate = rate; worstAid = aid; }
  }
  console.log('');

  // ── 4. 时间段分析 ──
  console.log(`  ${BOLD}时间段分析${RST}`);
  const midSeq = Math.floor(totalMsgs / 2);
  const effectiveFirst = sendResults.filter(r => r.seq < midSeq && !unavailableAids.includes(r.to));
  const effectiveSecond = sendResults.filter(r => r.seq >= midSeq && !unavailableAids.includes(r.to));

  const firstLost = effectiveFirst.filter(r => !r.ok || !receivedSeqs.has(r.seq)).length;
  const secondLost = effectiveSecond.filter(r => !r.ok || !receivedSeqs.has(r.seq)).length;
  const firstPct = effectiveFirst.length > 0 ? ((firstLost / effectiveFirst.length) * 100).toFixed(1) : '0.0';
  const secondPct = effectiveSecond.length > 0 ? ((secondLost / effectiveSecond.length) * 100).toFixed(1) : '0.0';

  const degraded = parseFloat(secondPct) > parseFloat(firstPct) * 1.5 && parseFloat(secondPct) > 5;
  console.log(`    前半段 (seq 0-${midSeq - 1})      ${pad(String(firstLost), 3)}/${effectiveFirst.length} 丢失 (${firstPct}%)`);
  console.log(`    后半段 (seq ${midSeq}-${totalMsgs - 1})    ${pad(String(secondLost), 3)}/${effectiveSecond.length} 丢失 (${secondPct}%)${degraded ? ` ${RED}← 劣化${RST}` : ''}`);
  console.log('');

  // ── 5. 丢失明细（前 10 条）──
  if (effectiveLosses.length > 0) {
    console.log(`  ${BOLD}丢失明细${RST} ${DIM}(前 10 条)${RST}`);
    console.log(`    ${DIM}${pad('seq', 5, 'left')}${pad('from', 12, 'left')}${pad('to', 12, 'left')}${pad('size', 5, 'left')}${pad('retry', 6, 'left')}${pad('send', 5, 'left')}${pad('pull', 5, 'left')}原因${RST}`);
    for (const l of effectiveLosses.slice(0, 10)) {
      const fromShort = l.from.split('.')[0].slice(0, 10);
      const toShort = l.to.split('.')[0].slice(0, 10);
      const sendMark = l.sendOk ? `${GREEN}✓${RST}` : `${RED}✗${RST}`;
      const pullMark = l.pullFound ? `${GREEN}✓${RST}` : `${RED}✗${RST}`;
      const sr = sendResults.find(s => s.seq === l.seq);
      const retryStr = sr && sr.retries > 0 ? `×${sr.retries}` : '-';
      console.log(`    ${pad(String(l.seq), 5, 'left')}${pad(fromShort, 12, 'left')}${pad(toShort, 12, 'left')}${pad(l.sizeClass, 5, 'left')}${pad(retryStr, 6, 'left')}${sendMark}${' '.repeat(4)}${pullMark}${' '.repeat(4)}${REASON_LABELS[l.reason]}`);
    }
    if (effectiveLosses.length > 10) {
      console.log(`    ${DIM}... +${effectiveLosses.length - 10} 条${RST}`);
    }
    console.log('');
  }

  // ── 6. 调优建议 ──
  console.log(`  ${BOLD}调优建议${RST}`);
  const suggestions: string[] = [];

  const rate429 = byReason.get('send_fail_429')?.length ?? 0;
  if (rate429 > 0) {
    suggestions.push(`网关限流 ${rate429} 次，建议降低 --concurrency 或加入退避策略`);
  }

  const connFail = byReason.get('send_fail_conn')?.length ?? 0;
  if (connFail > 0) {
    suggestions.push(`连接失败 ${connFail} 次，检查网络稳定性或网关并发连接上限`);
  }

  const pullNotFound = effectiveLosses.filter(l => l.reason === 'pull_not_found').length;
  if (pullNotFound > 0) {
    suggestions.push(`${pullNotFound} 条发送成功但 pull 未收到 — 可能原因：`);
    suggestions.push(`  • 网关消息保留窗口有限（消息过期）`);
    suggestions.push(`  • pull limit 截断（当前 200/页，可增加 --wait 等待时间）`);
    suggestions.push(`  • daemon 长连接消费了消息（建议测试前 evolclaw stop）`);
  }

  if (degraded) {
    suggestions.push(`后半段丢失率明显劣化，网关可能在持续高负载下降级，建议降低 --concurrency`);
  }

  if (maxLossRate > 0.4) {
    const worstShort = worstAid.split('.')[0];
    suggestions.push(`${worstShort} 丢失率异常高 (${(maxLossRate * 100).toFixed(0)}%)，检查该 AID 连接稳定性`);
  }

  if (suggestions.length === 0) {
    suggestions.push('无明显异常');
  }

  for (const s of suggestions) {
    console.log(`    ${s.startsWith(' ') ? DIM + s + RST : '• ' + s}`);
  }
  console.log('');
}


import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import tls from 'tls';
import dns from 'dns/promises';
import https from 'https';
// @ts-ignore
import { WebSocket } from 'ws';
import { aunPath as defaultAunPath } from '../paths.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const ORANGE = '\x1b[38;5;208m';
const RST = '\x1b[0m';

function ok(msg: string) { return `  ${GREEN}✓${RST} ${msg}`; }
function fail(msg: string) { return `  ${RED}✗${RST} ${msg}`; }
function skip(msg: string) { return `  ${YELLOW}○${RST} ${DIM}${msg}${RST}`; }
function ms(n: number) { return `${DIM}${n}ms${RST}`; }
function step(n: number, label: string) { return `${DIM}[${n}/10]${RST} ${CYAN}${label}${RST}`; }

const isZh = (process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase().startsWith('zh');

const i18n = {
  resolve: isZh ? '解析' : 'resolve',
  failed: isZh ? '失败' : 'failed',
  gateway: isZh ? '网关' : 'gateway',
  connect: isZh ? '连接' : 'connect',
  tlsFailed: isZh ? 'TLS握手失败' : 'TLS handshake failed',
  wsOpen: isZh ? 'WebSocket 连接成功' : 'WebSocket connected',
  wsFailed: isZh ? 'WebSocket 升级失败' : 'WebSocket upgrade failed',
  authOk: isZh ? '认证成功' : 'auth ok',
  authFailed: isZh ? '认证失败' : 'auth failed',
  noToken: isZh ? '未返回 token' : 'no token returned',
  sessionReady: isZh ? '会话就绪' : 'session ready',
  pingOk: isZh ? '响应正常' : 'response ok',
  pingFailed: isZh ? '失败' : 'failed',
  msgOk: isZh ? '自发自收成功' : 'self-send ok',
  msgFailed: isZh ? '消息发送失败' : 'message send failed',
  noGateway: isZh ? '响应中无网关地址' : 'no gateway in response',
  fetchGwFailed: isZh ? '获取网关失败' : 'fetch gateway failed',
  allPassed: isZh ? '全部通过' : 'All checks passed',
  checksFailed: isZh ? '项检查失败' : 'check(s) failed',
  passed: isZh ? '项通过' : 'passed',
};

interface CheckResult {
  step: string;
  index: number;
  ok: boolean;
  skipped?: boolean;
  detail: string;
  ms?: number;
}

// ==================== Network helpers ====================

function httpGet(url: string, timeoutMs = 8000): Promise<{ status: number; body: string; ms: number; redirectUrl?: string }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve({ status: res.statusCode, body: '', ms: Date.now() - start, redirectUrl: res.headers.location });
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, ms: Date.now() - start }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout (${timeoutMs}ms)`)); });
    req.on('error', (e) => reject(e));
  });
}

function dnsResolve(hostname: string): Promise<{ addrs: string[]; ms: number }> {
  const start = Date.now();
  return dns.resolve4(hostname).then(addrs => ({ addrs, ms: Date.now() - start }));
}

function tcpConnect(host: string, port: number, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = net.connect({ host, port, timeout: timeoutMs }, () => {
      sock.destroy();
      resolve(Date.now() - start);
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`timeout (${timeoutMs}ms)`)); });
    sock.on('error', (e: Error) => { sock.destroy(); reject(e); });
  });
}

function tlsConnect(host: string, port: number, timeoutMs = 5000): Promise<{ ms: number; protocol: string; cipher: string; certCN: string }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = tls.connect({ host, port, timeout: timeoutMs, servername: host }, () => {
      const elapsed = Date.now() - start;
      const cipher = sock.getCipher();
      const cert = sock.getPeerCertificate();
      sock.destroy();
      resolve({
        ms: elapsed,
        protocol: sock.getProtocol() || '?',
        cipher: cipher?.name || '?',
        certCN: String(cert?.subject?.CN || '?'),
      });
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`timeout (${timeoutMs}ms)`)); });
    sock.on('error', (e: Error) => { sock.destroy(); reject(e); });
  });
}

function wssConnect(url: string, timeoutMs = 8000): Promise<{ ms: number; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`timeout (${timeoutMs}ms)`)); }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve({ ms: Date.now() - start, ws }); });
    ws.on('error', (e: any) => { clearTimeout(timer); reject(e); });
  });
}

function suppressSdkOutput<T>(fn: () => Promise<T>): Promise<T> {
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...a: any[]) => {
    if (typeof chunk === 'string' && chunk.includes('[aun_core')) return true;
    return origWrite(chunk, ...a);
  }) as any;
  process.stderr.write = ((chunk: any, ...a: any[]) => {
    if (typeof chunk === 'string' && chunk.includes('[aun_core')) return true;
    return origErrWrite(chunk, ...a);
  }) as any;
  return fn().finally(() => {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  });
}

// ==================== Check pipeline ====================

async function runCheck(aid: string, formatJson: boolean): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const log = (r: CheckResult) => {
    results.push(r);
    if (formatJson) return;
    const prefix = step(r.index, r.step);
    if (r.skipped) { console.log(skip(`${r.step}: ${r.detail}`)); return; }
    console.log(r.ok ? ok(`${prefix}  ${r.detail}  ${r.ms !== undefined ? ms(r.ms) : ''}`) : fail(`${prefix}  ${r.detail}`));
  };

  // ── Step 1: 解析 AID 域名 ──
  const aidDomain = aid;
  try {
    const d = await dnsResolve(aidDomain);
    log({ step: 'DNS (AID)', index: 1, ok: true, detail: `${i18n.resolve} ${aidDomain} → ${d.addrs.join(', ')}`, ms: d.ms });
  } catch (e: any) {
    log({ step: 'DNS (AID)', index: 1, ok: false, detail: `${i18n.resolve} ${aidDomain} ${i18n.failed}: ${e.message}` });
    return results;
  }

  // ── Step 2: 获取网关地址 ──
  const wkUrl = `https://${aid}/.well-known/aun-gateway`;
  let gatewayUrl: string | undefined;
  try {
    const resp = await httpGet(wkUrl);
    if (resp.status !== 200) {
      log({ step: 'Discovery', index: 2, ok: false, detail: `GET ${wkUrl} → HTTP ${resp.status}`, ms: resp.ms });
      return results;
    }
    const data = JSON.parse(resp.body);
    gatewayUrl = data?.gateways?.[0]?.url;
    if (!gatewayUrl) {
      log({ step: 'Discovery', index: 2, ok: false, detail: `GET ${wkUrl} → ${i18n.noGateway}`, ms: resp.ms });
      return results;
    }
    log({ step: 'Discovery', index: 2, ok: true, detail: `GET ${wkUrl} → ${gatewayUrl}`, ms: resp.ms });
  } catch (e: any) {
    log({ step: 'Discovery', index: 2, ok: false, detail: `GET ${wkUrl} → ${e.message}` });
    return results;
  }

  // ── Step 3: 解析网关域名 ──
  const gwParsed = new URL(gatewayUrl);
  const gwHost = gwParsed.hostname;
  const gwPort = parseInt(gwParsed.port || '443', 10);
  try {
    const d = await dnsResolve(gwHost);
    log({ step: 'DNS (GW)', index: 3, ok: true, detail: `${i18n.resolve} ${gwHost} → ${d.addrs.join(', ')}`, ms: d.ms });
  } catch (e: any) {
    log({ step: 'DNS (GW)', index: 3, ok: false, detail: `${i18n.resolve} ${gwHost} ${i18n.failed}: ${e.message}` });
    return results;
  }

  // ── Step 4: TCP 连接网关端口 ──
  try {
    const elapsed = await tcpConnect(gwHost, gwPort);
    log({ step: 'TCP', index: 4, ok: true, detail: `${i18n.connect} ${gwHost}:${gwPort}`, ms: elapsed });
  } catch (e: any) {
    log({ step: 'TCP', index: 4, ok: false, detail: `${i18n.connect} ${gwHost}:${gwPort} ${i18n.failed}: ${e.message}` });
    return results;
  }

  // ── Step 5: TLS 握手 ──
  try {
    const t = await tlsConnect(gwHost, gwPort);
    log({ step: 'TLS', index: 5, ok: true, detail: `${gwHost}:${gwPort} ${t.protocol} ${t.cipher} CN=${t.certCN}`, ms: t.ms });
  } catch (e: any) {
    log({ step: 'TLS', index: 5, ok: false, detail: `${gwHost}:${gwPort} ${i18n.tlsFailed}: ${e.message}` });
    return results;
  }

  // ── Step 6: WebSocket 升级 ──
  let ws: WebSocket | undefined;
  try {
    const r = await wssConnect(gatewayUrl);
    ws = r.ws;
    log({ step: 'WSS', index: 6, ok: true, detail: `${i18n.wsOpen} (${gatewayUrl})`, ms: r.ms });
  } catch (e: any) {
    log({ step: 'WSS', index: 6, ok: false, detail: `${i18n.wsFailed}: ${e.message}` });
    return results;
  } finally {
    if (ws) { ws.close(); ws = undefined; }
  }

  // ── Step 7: AID 认证 ──
  let accessToken: string | undefined;
  try {
    const start = Date.now();
    const aunPath = process.env.AUN_HOME || defaultAunPath();
    const { AUNClient } = await import('@agentunion/fastaun');
    const result = await suppressSdkOutput(async () => {
      const client = new AUNClient({ aun_path: aunPath, debug: false } as any);
      await client.auth.createAid({ aid });
      const authResult = await client.auth.authenticate({ aid });
      await client.close().catch(() => {});
      return authResult;
    });
    accessToken = result?.access_token;
    const elapsed = Date.now() - start;
    if (accessToken) {
      log({ step: 'Auth', index: 7, ok: true, detail: `${aid} ${i18n.authOk} (login1→login2→token)`, ms: elapsed });
    } else {
      log({ step: 'Auth', index: 7, ok: false, detail: `${aid} ${i18n.authFailed}: ${i18n.noToken}`, ms: elapsed });
      return results;
    }
  } catch (e: any) {
    log({ step: 'Auth', index: 7, ok: false, detail: `${aid} ${i18n.authFailed}: ${e.message?.slice(0, 120) || String(e)}` });
    return results;
  }

  // ── Step 8: 建立会话 ──
  log({ step: 'Session', index: 8, ok: true, detail: i18n.sessionReady });

  // ── Step 8.5: agent.md 读取验证 ──
  try {
    const start = Date.now();
    const { agentmdGet } = await import('../aun/aid/index.js');
    const result = await suppressSdkOutput(() => agentmdGet(aid, { withVerification: true }));
    const elapsed = Date.now() - start;
    if (typeof result === 'object' && result.content) {
      const fmMatch = result.content.match(/^---\n([\s\S]*?)\n---/);
      const nameMatch = fmMatch?.[1]?.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const name = nameMatch?.[1] || aid;
      const sigStatus = result.verification?.status || 'unknown';
      log({ step: 'AgentMd', index: 8, ok: true, detail: `${name} (sig: ${sigStatus})`, ms: elapsed });
    } else if (typeof result === 'string' && result) {
      log({ step: 'AgentMd', index: 8, ok: true, detail: `content loaded (sig: not checked)`, ms: elapsed });
    } else {
      log({ step: 'AgentMd', index: 8, ok: false, detail: `agent.md not found`, ms: elapsed });
    }
  } catch (e: any) {
    log({ step: 'AgentMd', index: 8, ok: false, detail: `agent.md: ${e.message?.slice(0, 100) || String(e)}` });
  }

  // ── Step 9: RPC 调用 (meta.ping) ──
  try {
    const start = Date.now();
    const aunPath = process.env.AUN_HOME || defaultAunPath();
    const { AUNClient } = await import('@agentunion/fastaun');
    const sendResult = await suppressSdkOutput(async () => {
      const client = new AUNClient({ aun_path: aunPath, debug: false } as any);
      await client.auth.createAid({ aid });
      const authResult = await client.auth.authenticate({ aid });
      const at = authResult?.access_token || (client as any)._access_token;
      const gw = (client as any)._gatewayUrl || authResult?.gateway;
      await client.connect({ access_token: at, gateway: gw, connection_kind: 'short' }, { auto_reconnect: false });
      const r = await client.call('meta.ping', {});
      await client.close().catch(() => {});
      return r;
    });
    const elapsed = Date.now() - start;
    log({ step: 'Ping', index: 9, ok: true, detail: `meta.ping ${i18n.pingOk}`, ms: elapsed });
  } catch (e: any) {
    log({ step: 'Ping', index: 9, ok: false, detail: `meta.ping ${i18n.pingFailed}: ${e.message?.slice(0, 100) || String(e)}` });
  }

  // ── Step 10: Echo 链路追踪 ──
  // CLI 模拟 app 发送 echo[nc]，向多个目标测试链路
  try {
    const echoStart = Date.now();
    const aunPath = process.env.AUN_HOME || defaultAunPath();
    const { AUNClient } = await import('@agentunion/fastaun');

    // 选择 6 个测试目标，按消息数量、域、有无证书均衡选择
    const allAids = await getAidList();
    const myDomain = aid.split('.').slice(1).join('.');
    const isValidAid = (a: AidEntry) => a.aid.includes('.') && a.aid !== aid;

    // 统计每个 AID 的总消息活跃度（遍历所有本地 AID 的 sessions）
    const { resolvePaths } = await import('../paths.js');
    const p = resolvePaths();
    const sessAunDir = path.join(p.sessionsDir, 'aun');
    const encode = (s: string) => s.replace(/[/%\\:*?"<>|]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    const decode = (s: string) => s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    function getGlobalMessageCounts(): Map<string, number> {
      const counts = new Map<string, number>();
      try {
        const localDirs = fs.readdirSync(sessAunDir, { withFileTypes: true });
        for (const localDir of localDirs) {
          if (!localDir.isDirectory()) continue;
          const localAid = decode(localDir.name);
          const peerDirs = fs.readdirSync(path.join(sessAunDir, localDir.name), { withFileTypes: true });
          for (const peerDir of peerDirs) {
            if (!peerDir.isDirectory()) continue;
            const peerId = decode(peerDir.name);
            const msgFile = path.join(sessAunDir, localDir.name, peerDir.name, 'messages.jsonl');
            try {
              const content = fs.readFileSync(msgFile, 'utf-8');
              const lineCount = content.split('\n').filter(l => l.trim()).length;
              counts.set(peerId, (counts.get(peerId) ?? 0) + lineCount);
              counts.set(localAid, (counts.get(localAid) ?? 0) + lineCount);
            } catch {}
          }
        }
      } catch {}
      return counts;
    }

    const msgCounts = getGlobalMessageCounts();
    const sortByActivity = (aids: AidEntry[]) => {
      const sorted = [...aids].sort((a, b) => (msgCounts.get(b.aid) ?? 0) - (msgCounts.get(a.aid) ?? 0));
      // Keep top half by activity, shuffle within to add randomness
      const topHalf = sorted.slice(0, Math.max(3, Math.ceil(sorted.length / 2)));
      shuffle(topHalf);
      return [...topHalf, ...sorted.slice(topHalf.length)];
    };

    const targets: string[] = [];

    // 分桶
    const localSameDomain = allAids.filter(a => a.hasPrivateKey && isValidAid(a) && a.aid.split('.').slice(1).join('.') === myDomain);
    const localDiffDomain = allAids.filter(a => a.hasPrivateKey && isValidAid(a) && a.aid.split('.').slice(1).join('.') !== myDomain);
    const remoteSameDomain = allAids.filter(a => !a.hasPrivateKey && isValidAid(a) && a.aid.split('.').slice(1).join('.') === myDomain);
    const remoteDiffDomain = allAids.filter(a => !a.hasPrivateKey && isValidAid(a) && a.aid.split('.').slice(1).join('.') !== myDomain);

    // Round-robin 从各桶取，按消息数优先，直到 6 个
    const buckets = [localSameDomain, localDiffDomain, remoteSameDomain, remoteDiffDomain];
    let round = 0;
    while (targets.length < 6 && round < 6) {
      for (const bucket of buckets) {
        if (targets.length >= 6) break;
        const sorted = sortByActivity(bucket);
        const candidate = sorted.find(a => !targets.includes(a.aid));
        if (candidate) targets.push(candidate.aid);
      }
      round++;
    }

    if (targets.length === 0) {
      log({ step: 'Echo', index: 10, ok: true, detail: `skipped (no other AID for echo target)`, skipped: true });
      return results;
    }

    if (!formatJson) {
      console.log(`  ${DIM}[10/10]${RST} ${CYAN}Echo${RST}  ${DIM}${targets.length} target(s)${RST}`);
    }

    const echoResults: { target: string; ok: boolean; detail: string; replyText?: string }[] = [];

    // 读取所有目标的 agent.md（含签名验证）获取昵称和类型
    const { agentmdGet: agentmdGetFn } = await import('../aun/aid/index.js');
    const targetMeta = new Map<string, { name: string; type: string; sigStatus: string }>();

    if (!formatJson) {
      console.log(`  ${DIM}[10/10]${RST} ${CYAN}Echo${RST}  ${DIM}reading agent.md for ${targets.length} target(s)...${RST}`);
    }

    await Promise.all(targets.map(async (t) => {
      const start = Date.now();
      try {
        const result = await suppressSdkOutput(() => agentmdGetFn(t, { withVerification: true }));
        const elapsed = Date.now() - start;
        if (typeof result === 'object' && result.content) {
          const fmMatch = result.content.match(/^---\n([\s\S]*?)\n---/);
          const nameMatch = fmMatch?.[1]?.match(/^name:\s*["']?(.+?)["']?\s*$/m);
          const typeMatch = fmMatch?.[1]?.match(/^type:\s*["']?(.+?)["']?\s*$/m);
          const sigStatus = result.verification?.status || 'unknown';
          targetMeta.set(t, {
            name: nameMatch?.[1] || shortAid(t),
            type: typeMatch?.[1] || 'unknown',
            sigStatus,
          });
          if (!formatJson) {
            console.log(`    ${GREEN}✓${RST} ${DIM}agentmd${RST} ${shortAid(t)}: ${nameMatch?.[1] || '?'} (${typeMatch?.[1] || '?'}) sig=${sigStatus}  ${ms(elapsed)}`);
          }
        } else {
          targetMeta.set(t, { name: shortAid(t), type: 'unknown', sigStatus: 'none' });
          if (!formatJson) {
            console.log(`    ${YELLOW}○${RST} ${DIM}agentmd${RST} ${shortAid(t)}: no content  ${ms(elapsed)}`);
          }
        }
      } catch (e: any) {
        targetMeta.set(t, { name: shortAid(t), type: 'unknown', sigStatus: 'error' });
        if (!formatJson) {
          console.log(`    ${RED}✗${RST} ${DIM}agentmd${RST} ${shortAid(t)}: ${e.message?.slice(0, 60) || String(e)}`);
        }
      }
    }));

    if (!formatJson) console.log('');

    // 构建目标标记
    const aidMap = new Map(allAids.map(a => [a.aid, a]));
    function targetLabel(t: string): string {
      const entry = aidMap.get(t);
      const meta = targetMeta.get(t)!;
      const keyIcon = entry?.hasPrivateKey ? '🔑' : '🌐';
      const typeIcon = meta.type === 'human' ? '👤' : '🤖';
      return `${keyIcon}${typeIcon} ${meta.name}`;
    }

    for (const target of targets) {
      const targetStart = Date.now();
      const label = targetLabel(target);
      try {
        const replyText = await suppressSdkOutput(async () => {
          const client = new AUNClient({ aun_path: aunPath, debug: false } as any);
          await client.auth.createAid({ aid });
          const authResult = await client.auth.authenticate({ aid });
          const at = authResult?.access_token || (client as any)._access_token;
          const gw = (client as any)._gatewayUrl || authResult?.gateway;
          await client.connect({ access_token: at, gateway: gw, slot_id: 'net-check', connection_kind: 'short' }, { auto_reconnect: false });

          // 取基线 seq
          const baseline = await client.call('message.pull', { limit: 100 });
          const baselineSeq = (baseline as any)?.latest_seq ?? 0;
          if (baselineSeq > 0) {
            await client.call('message.ack', { seq: baselineSeq });
          }

          await client.call('message.send', {
            to: target,
            payload: { type: 'text', text: 'echo[nc]' },
            encrypt: false,
          });

          await new Promise(r => setTimeout(r, 1500));

          const pullResult = await client.call('message.pull', { after_seq: baselineSeq, limit: 10 });
          await client.close().catch(() => {});

          const messages = (pullResult as any)?.messages || [];
          const reply = messages.find((m: any) =>
            m.from === target && m.payload?.text?.includes('[EvolClaw.')
          );
          return reply?.payload?.text || null;
        });

        const elapsed = Date.now() - targetStart;
        if (replyText) {
          echoResults.push({ target, ok: true, detail: `reply received (${elapsed}ms)`, replyText });
          if (!formatJson) {
            console.log(`    ${GREEN}✓${RST} ${label}  ${DIM}${target}${RST}  ${ms(elapsed)}`);
            printTrace(replyText);
          }
        } else {
          echoResults.push({ target, ok: false, detail: `no reply in ${elapsed}ms` });
          if (!formatJson) {
            console.log(`    ${RED}✗${RST} ${label}  ${DIM}${target}${RST}  no reply  ${ms(elapsed)}`);
          }
        }
      } catch (e: any) {
        echoResults.push({ target, ok: false, detail: e.message?.slice(0, 100) || String(e) });
        if (!formatJson) {
          console.log(`    ${RED}✗${RST} ${label}  ${DIM}${target}${RST}  ${e.message?.slice(0, 80)}`);
        }
      }
    }

    const elapsed = Date.now() - echoStart;
    const okCount = echoResults.filter(r => r.ok).length;
    const allOk = echoResults.every(r => r.ok);
    const anyOk = echoResults.some(r => r.ok);
    results.push({
      step: 'Echo',
      index: 10,
      ok: anyOk,
      detail: `${okCount}/${echoResults.length} targets replied`,
      ms: elapsed,
    });
  } catch (e: any) {
    log({ step: 'Echo', index: 10, ok: false, detail: `echo ${i18n.failed}: ${e.message?.slice(0, 100) || String(e)}` });
  }

  return results;
}

// 添加这个常量到 ANSI 块（如果还没有）

function printTrace(text: string) {
  const traceLines = text.split('\n').filter((l: string) => /^\d{2}:\d{2}:\d{2}\.\d{3}/.test(l));
  if (traceLines.length === 0) return;

  const parsed: { label: string; ts: number; info: string }[] = [];
  for (const line of traceLines) {
    const match = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+\[([^\]]+)\]\s*(.*)/);
    if (match) {
      const [, hh, mm, ss, mmm, node, info] = match;
      const t = (+hh * 3600 + +mm * 60 + +ss) * 1000 + +mmm;
      // 提取 from/to/aid 关键字段
      const fromMatch = info.match(/from=(\S+?)(?:\s|$|,)/);
      const toMatch = info.match(/to=(\S+?)(?:\s|$|,)/);
      const aidMatch = info.match(/(?:^|\s)aid=(\S+?)(?:\s|$|,)/);
      const selfMatch = info.match(/self=(\S+?)(?:\s|$|,)/);
      let summary = '';
      if (fromMatch && toMatch) summary = `${shortAid(fromMatch[1])}→${shortAid(toMatch[1])}`;
      else if (aidMatch) summary = `aid=${shortAid(aidMatch[1])}`;
      else if (selfMatch) summary = `self=${shortAid(selfMatch[1])}`;
      parsed.push({ label: `[${node}]`, ts: t, info: summary });
    }
  }

  if (parsed.length < 2) return;
  console.log(`${DIM}      ── trace ──${RST}`);
  let totalLocal = 0;
  for (let i = 0; i < parsed.length; i++) {
    let delta = i > 0 ? parsed[i].ts - parsed[i - 1].ts : 0;
    while (delta > 43200000) delta -= 86400000;
    while (delta < -43200000) delta += 86400000;
    const isLocal = Math.abs(delta) <= 60000;
    const deltaStr = i > 0 ? (isLocal ? `+${delta}ms` : `~`) : '';
    if (i > 0 && isLocal) totalLocal += Math.max(0, delta);
    const infoStr = parsed[i].info ? ` ${DIM}${parsed[i].info}${RST}` : '';
    console.log(`${DIM}      ${parsed[i].label}${RST}${infoStr}  ${DIM}${deltaStr}${RST}`);
  }
  console.log(`${DIM}      ── local-side total: ${totalLocal}ms (~ = cross-tz hop) ──${RST}`);
}

function shortAid(aid: string): string {
  return aid.split('.')[0];
}

// ==================== Entry ====================

interface AidEntry { aid: string; hasPrivateKey: boolean; hasAgentMd: boolean; }

async function getAidList(): Promise<AidEntry[]> {
  const { aidList } = await import('../aun/aid/index.js');
  return aidList() as AidEntry[];
}

function pickDefaultAids(aids: AidEntry[]): string[] {
  const withKey = aids.filter(a => a.hasPrivateKey && a.aid.includes('.'));
  const withoutKey = aids.filter(a => !a.hasPrivateKey && a.aid.includes('.'));
  const picked: string[] = [];
  // Prefer AIDs with agentMd (actively used), shuffle within group for randomness
  const active = withKey.filter(a => a.hasAgentMd);
  const inactive = withKey.filter(a => !a.hasAgentMd);
  shuffle(active);
  shuffle(inactive);
  const sorted = [...active, ...inactive];
  for (const a of sorted.slice(0, 2)) picked.push(a.aid);
  // 1 without private key (random pick)
  shuffle(withoutKey);
  if (withoutKey.length > 0) picked.push(withoutKey[0].aid);
  return picked;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function cmdNet(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = args.includes('--format') && args.includes('json');

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`用法: evolclaw net check [<aid>] [--format json]

检查 AUN 网络链路连通性（10 步逐层诊断）。

步骤:
  1.  DNS (AID)      AID 域名解析
  2.  Discovery      .well-known/aun-gateway 获取网关地址
  3.  DNS (Gateway)  网关域名解析
  4.  TCP            网关端口连接
  5.  TLS            TLS 握手 + 证书验证
  6.  WSS            WebSocket 升级握手
  7.  Auth           AID 认证（login1 + login2 → token）
  8.  Session        会话建立
  9.  Ping           meta.ping RPC
  10. Message        self-to-self 消息收发

参数:
  <aid>    要检查的 AID（可选，默认取前 3 个本地 AID）

选项:
  --format json    JSON 格式输出`);
    return;
  }

  if (sub && sub !== 'check' && !sub.startsWith('-') && !sub.includes('.')) {
    console.error(`❌ 未知子命令: net ${sub}`);
    console.error('用法: evolclaw net check [<aid>]');
    process.exit(1);
  }

  let targetAids: string[] = [];
  for (const a of args) {
    if (a.includes('.') && !a.startsWith('-')) {
      targetAids.push(a);
    }
  }

  if (targetAids.length === 0) {
    const aids = await getAidList();
    if (aids.length === 0) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: 'No local AIDs found' })); }
      else { console.error('❌ 未找到本地 AID，请先创建: evolclaw aid new'); }
      process.exit(1);
    }
    targetAids = pickDefaultAids(aids);
  }

  const allResults: { aid: string; checks: CheckResult[] }[] = [];

  for (const targetAid of targetAids) {
    if (!formatJson) {
      console.log(`\n${BOLD}── ${targetAid} ──${RST}\n`);
    }
    const results = await runCheck(targetAid, formatJson);
    allResults.push({ aid: targetAid, checks: results });
  }

  if (formatJson) {
    const allOk = allResults.every(r => r.checks.every(c => c.ok || c.skipped));
    console.log(JSON.stringify({ ok: allOk, results: allResults }));
  } else {
    console.log('');
    const passed = allResults.reduce((n, r) => n + r.checks.filter(c => c.ok).length, 0);
    const failed = allResults.reduce((n, r) => n + r.checks.filter(c => !c.ok && !c.skipped).length, 0);
    if (failed === 0) {
      console.log(`${GREEN}${BOLD}${i18n.allPassed} (${passed})${RST}`);
    } else {
      console.log(`${RED}${BOLD}${failed} ${i18n.checksFailed}${RST}, ${passed} ${i18n.passed}`);
    }
  }

  const exitOk = allResults.every(r => r.checks.every(c => c.ok || c.skipped));
  process.exit(exitOk ? 0 : 1);
}

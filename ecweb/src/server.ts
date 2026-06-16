/**
 * Watch Web 服务 — 本地浏览器监控面板后端。
 *
 * - HTTP: 静态资源 + 配对 API
 * - WebSocket: 订阅式实时推送（aid / msg / session）
 * - 鉴权: 6 位配对码（5 分钟有效）→ token（30 天，有访问自动续期），持久化到磁盘
 * - 安全: 绑定 0.0.0.0（支持远程访问），token 校验，只读
 *
 * 与 evolclaw 的唯一通信：启动时发 ping 检查 protocolVersion（soft 校验）。
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { resolvePaths } from './paths.js';
import { ipcQuery } from './ipc-client.js';
import { setDebugLog, dlog } from './debug-log.js';
import type { WatchSource, ViewKind } from './sources/types.js';
import { aidSource } from './sources/aid.js';
import { msgSource } from './sources/msg.js';
import { sessionSource, buildBindMap } from './sources/session.js';
import { cacheSource } from './sources/cache.js';
import { systemSource } from './sources/system.js';
import { triggersSource } from './sources/triggers.js';
import { monitorSource } from './sources/monitor.js';
import { gatewaySource } from './sources/gateway.js';
import { queryStatsForDashboard, queryStatsExplorer, queryStatsByPeer, queryStatsByAgent, queryStatsOverview, queryUsageDetail, queryUsedModels } from './sources/stats.js';
import { getSessionsAunDir, listLocalAids, listPeers, readMessages } from './fs-utils.js';
import { ccProjectsDir } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30天（滑动窗口：每次有效访问刷新 lastActive 自动续期）
const PAIRING_TTL_MS = 5 * 60 * 1000;       // 5min
const DEFAULT_PORT = 42705;
const PROTOCOL_VERSION = 1;                  // 与 evolclaw ping response 对齐的软校验版本

const SOURCES: Record<ViewKind, WatchSource> = { agents: aidSource, msg: msgSource, session: sessionSource, cache: cacheSource, system: systemSource, triggers: triggersSource, monitor: monitorSource, gateway: gatewaySource };

// ECWeb 自身版本：渲染 System 页时随快照下发（不走 daemon IPC，ECWeb 就是这个进程）。
function readEcwebVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg?.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const ECWEB_VERSION = readEcwebVersion();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ── Token store ──

interface TokenRecord { token: string; createdAt: number; lastActive: number; label: string; }
interface TokenStore { tokens: TokenRecord[]; }

function tokenStorePath(): string {
  const dir = resolvePaths().instanceDir;
  const current = path.join(dir, 'ecweb-tokens.json');
  const legacy = path.join(dir, 'watch-web-tokens.json');
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    try { fs.renameSync(legacy, current); } catch {}
  }
  return current;
}

function loadTokens(): TokenStore {
  try {
    const store = JSON.parse(fs.readFileSync(tokenStorePath(), 'utf-8')) as TokenStore;
    if (Array.isArray(store.tokens)) return store;
  } catch {}
  return { tokens: [] };
}

function saveTokens(store: TokenStore): void {
  try {
    fs.mkdirSync(resolvePaths().instanceDir, { recursive: true });
    const tmp = tokenStorePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, tokenStorePath());
  } catch {}
}

function pruneExpired(store: TokenStore, now: number): boolean {
  const before = store.tokens.length;
  store.tokens = store.tokens.filter(t => now - t.lastActive < TOKEN_TTL_MS);
  return store.tokens.length !== before;
}

function validateAndRenew(token: string, now: number): boolean {
  if (!token) return false;
  const store = loadTokens();
  const changed = pruneExpired(store, now);
  const rec = store.tokens.find(t => t.token === token);
  if (rec) { rec.lastActive = now; saveTokens(store); return true; }
  if (changed) saveTokens(store);
  return false;
}

// ── Static ──

// 经 AUN Service Proxy 转发时，proxy-server 注入 x-forwarded-prefix 头，
// 值为外部前缀（如 /evolai/ecweb）。把它作为 <base href> 注入 index.html，
// 使相对路径资源（style.css / app.js / api / ws）在带不带尾斜杠时都正确解析。
// 本地直连无此头，<base> 注入为 "/"，行为不变。
function forwardedPrefix(req: http.IncomingMessage): string {
  const raw = req.headers['x-forwarded-prefix'];
  const value = (Array.isArray(raw) ? raw[0] : raw || '').trim();
  // 安全：只接受形如 /a/b 的简单路径，拒绝含协议、双斜杠、引号、尖括号等的值
  if (!value || !/^\/[A-Za-z0-9._~%/-]*$/.test(value)) return '';
  return value.replace(/\/+$/, '');  // 去尾斜杠，注入时统一补
}

function injectBaseHref(html: string, prefix: string): string {
  const base = prefix ? `${prefix}/` : '/';
  const tag = `<base href="${base}">`;
  // 若已有 <base> 则替换，否则插在 <head> 之后
  if (/<base\b[^>]*>/i.test(html)) return html.replace(/<base\b[^>]*>/i, tag);
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not Found'); return; }
    const ext = path.extname(file);
    // index.html 注入 <base href>，适配 AUN Service Proxy 前缀
    if (ext === '.html') {
      const prefix = forwardedPrefix(req);
      const html = injectBaseHref(data.toString('utf-8'), prefix);
      res.writeHead(200, { 'Content-Type': MIME[ext] });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Helpers ──

function parseUrl(rawUrl: string): { path: string; query: Record<string, string> } {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return { path: rawUrl, query: {} };
  const query: Record<string, string> = {};
  for (const pair of rawUrl.slice(qIdx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return { path: rawUrl.slice(0, qIdx), query };
}

function handleStatsApi(req: http.IncomingMessage, res: http.ServerResponse): void {
  const { path: urlPath, query } = parseUrl(req.url || '');
  res.setHeader('Content-Type', 'application/json');

  if (urlPath === '/api/stats/dashboard') {
    const data = queryStatsForDashboard();
    if (!data) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'stats unavailable (node:sqlite missing or no data)' }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify(data));
    }
  } else if (urlPath === '/api/stats/explorer') {
    const params: any = {};
    if (query.from) params.from_ts = Number(query.from);
    if (query.to)   params.to_ts = Number(query.to);
    if (query.agent) params.agent_aid = query.agent;
    if (query.peer)  params.peer_key = query.peer;
    if (query.model) params.model = query.model;
    if (query.granularity) params.granularity = query.granularity;
    const data = queryStatsExplorer(params);
    res.writeHead(200);
    res.end(JSON.stringify(data));
  } else if (urlPath === '/api/stats/peers') {
    const params: any = {};
    if (query.from) params.from_ts = Number(query.from);
    if (query.to)   params.to_ts = Number(query.to);
    if (query.agent) params.agent_aid = query.agent;
    if (query.limit) params.limit = Number(query.limit);
    const data = queryStatsByPeer(params);
    res.writeHead(200);
    res.end(JSON.stringify(data));
  } else if (urlPath === '/api/stats/agents') {
    // 返回所有agent列表（与智能体管理页面一致，从aidSource获取）
    aidSource.snapshot().then(snapshot => {
      const agents = (snapshot?.agents || []).map((ag: any) => ({
        agent_aid: ag.aid,
        agent_name: ag.displayName || null
      }));
      res.writeHead(200);
      res.end(JSON.stringify(agents));
    }).catch(err => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to fetch agents' }));
    });
    return;
  } else if (urlPath === '/api/stats/overview') {
    // 从查询参数中获取时间范围和筛选条件
    const params: { from_ts?: number; to_ts?: number; agent_aid?: string; peer_key?: string } = {};
    if (query.from) params.from_ts = Number(query.from);
    if (query.to)   params.to_ts = Number(query.to);
    if (query.agent) params.agent_aid = String(query.agent);
    if (query.peer) params.peer_key = String(query.peer);

    const tokenStats = queryStatsOverview(params);

    // session count: 使用 bindMap 按 agent 和 peer 筛选
    let sessionCount = 0;
    try {
      // 构建 agentSessionId → agent_aid 的映射
      const bindMap = buildBindMap();

      // 如果指定了 peer_key，提取并解码 channelId
      let targetChannelId: string | undefined;
      if (params.peer_key) {
        const parts = params.peer_key.split('#');
        if (parts.length >= 4) {
          // aun#{agent}#main#{channelId}，需要解码 URL 编码
          targetChannelId = decodeURIComponent(parts[3]);
        }
      }

      const base = ccProjectsDir();
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const projectDir = path.join(base, d.name);
        try {
          const sessionFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
          for (const sessionFile of sessionFiles) {
            const sessionId = sessionFile.replace('.jsonl', '');

            // 如果指定了 agent 或 peer，检查该会话是否匹配
            if (params.agent_aid || targetChannelId) {
              const bindInfo = bindMap.get(sessionId);
              if (!bindInfo) continue;

              // 检查 agent
              if (params.agent_aid && bindInfo.selfAID !== params.agent_aid) continue;

              // 检查 peer
              if (targetChannelId && bindInfo.channelId !== targetChannelId) continue;
            }

            // 如果有时间范围限制，检查会话文件的修改时间
            if (params.from_ts || params.to_ts) {
              const stat = fs.statSync(path.join(projectDir, sessionFile));
              const mtime = stat.mtimeMs;
              if (params.from_ts && mtime < params.from_ts) continue;
              if (params.to_ts && mtime > params.to_ts) continue;
            }
            sessionCount++;
          }
        } catch {}
      }
    } catch {}

    // message counts: scan aun dir, 根据时间范围和 agent/peer 过滤
    let msgIn = 0, msgOut = 0;
    try {
      const aunDir = getSessionsAunDir();
      const aids = params.agent_aid ? [params.agent_aid] : listLocalAids(aunDir);

      for (const aid of aids) {
        const peers = params.peer_key ? [params.peer_key] : listPeers(aunDir, aid);

        for (const peer of peers) {
          for (const m of readMessages(aunDir, aid, peer)) {
            // 根据消息时间戳过滤
            if (params.from_ts && m.ts < params.from_ts) continue;
            if (params.to_ts && m.ts > params.to_ts) continue;

            if (m.dir === 'in') msgIn++; else msgOut++;
          }
        }
      }
    } catch {}
    res.writeHead(200);
    res.end(JSON.stringify({ token_stats: tokenStats, session_count: sessionCount, msg_in: msgIn, msg_out: msgOut }));
  } else if (urlPath === '/api/stats/detail') {
    // 模型访问明细查询
    const params: { from_ts?: number; to_ts?: number; agent_aid?: string; model?: string; limit?: number; offset?: number } = {};
    if (query.from) params.from_ts = Number(query.from);
    if (query.to)   params.to_ts = Number(query.to);
    if (query.agent) params.agent_aid = query.agent;
    if (query.model) params.model = String(query.model);
    params.limit = Number(query.limit) || 50; // 默认限制50条
    params.offset = Number(query.offset) || 0; // 默认从0开始

    const result = queryUsageDetail(params);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } else if (urlPath === '/api/stats/models') {
    // 获取指定时间范围内使用过的模型列表
    const params: { from_ts?: number; to_ts?: number } = {};
    if (query.from) params.from_ts = Number(query.from);
    if (query.to)   params.to_ts = Number(query.to);

    const models = queryUsedModels(params);
    res.writeHead(200);
    res.end(JSON.stringify(models));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

// 仅 localhost 可访问（取配对码）：直连 socket 地址必须是回环。
// 不信任 x-forwarded-for（代理头可伪造），只看真实 TCP 来源。
function isLocalhost(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 判定「真本地直连」：socket 地址是回环 AND 无 x-aun-provider-aid 头。
 * proxy-server 回连本地时 remoteAddress 也是 127.0.0.1，但会注入 x-aun-provider-aid
 * 可信头（访客伪造的 x-aun-* 会被 proxy-server 剥掉）。只有真本地直连时两条件同时满足。
 * 真本地直连免配对（自动发 token），隧道/远程需配对码。
 */
function isLocalDirect(req: http.IncomingMessage): boolean {
  if (!isLocalhost(req)) return false;
  const providerAid = req.headers['x-aun-provider-aid'];
  return !providerAid || (Array.isArray(providerAid) ? providerAid.length === 0 : !providerAid.trim());
}

function genPairingCode(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// ── Pair handler ──

function handlePair(req: http.IncomingMessage, res: http.ServerResponse, pairingCode: string, pairingExpiry: number, log: (s: string) => void): void {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    const ip = clientIp(req);
    let code = '';
    try { code = String(JSON.parse(body).code || ''); } catch {}
    if (Date.now() > pairingExpiry) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, reason: '配对码已过期，请重启 watch' }));
      log(`✗ 配对失败（码已过期） from ${ip}`);
      return;
    }
    if (code !== pairingCode) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, reason: '配对码错误' }));
      log(`✗ 配对失败（码错误: ${code}） from ${ip}`);
      return;
    }
    const now = Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    const store = loadTokens();
    pruneExpired(store, now);
    store.tokens.push({ token, createdAt: now, lastActive: now, label: ip });
    saveTokens(store);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, token }));
    log(`✓ 配对成功 from ${ip}（token 缓存 30 天，有访问自动续期）`);
  });
}

/**
 * 本地直连免配对：自动发 token。远程（隧道或真远程）需配对码。
 * 本地直连判定：socket 来源是回环 AND 无 x-aun-provider-aid 头（非隧道）。
 */
function issueLocalDirectToken(req: http.IncomingMessage, log: (s: string) => void): string | null {
  if (!isLocalDirect(req)) return null;
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  const store = loadTokens();
  pruneExpired(store, now);
  const ip = clientIp(req);
  store.tokens.push({ token, createdAt: now, lastActive: now, label: `local-direct:${ip}` });
  saveTokens(store);
  log(`✓ 本地直连自动授权 from ${ip}`);
  return token;
}

// ── WebSocket connection ──

function handleConnection(ws: WebSocket, req: http.IncomingMessage, log: (s: string) => void): void {
  const ip = clientIp(req);
  let unsubscribe: (() => void) | null = null;
  let currentView: ViewKind | null = null;
  log(`◆ WS 连接 from ${ip}`);

  const send = (obj: any) => {
    if (ws.readyState === ws.OPEN) try { ws.send(JSON.stringify(obj)); } catch {}
  };

  const switchSubscription = async (view: ViewKind, params: Record<string, any>) => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    currentView = view;
    const source = SOURCES[view];
    if (!source) { send({ type: 'error', message: `unknown view: ${view}` }); return; }
    // System 视图：把 ECWeb 自身版本合并进快照（前端版本卡用）
    const decorate = (data: any) => (view === 'system' && data ? { ...data, ecwebVersion: ECWEB_VERSION } : data);
    try { send({ type: 'snapshot', view, data: decorate(await source.snapshot(params)) }); }
    catch (e: any) { send({ type: 'error', message: `snapshot failed: ${e?.message || e}` }); }
    unsubscribe = source.subscribe(params, (data) => {
      if (currentView === view) send({ type: 'delta', view, data: decorate(data) });
    });
  };

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') { send({ type: 'pong' }); return; }
    if (msg.type === 'subscribe' && msg.view) {
      const params: Record<string, any> = {};
      if (msg.aid) params.aid = msg.aid;
      if (msg.peer) params.peer = msg.peer;
      if (msg.sessionId) params.sessionId = msg.sessionId;
      if (msg.project) params.project = msg.project;
      if (msg.agent) params.agent = msg.agent;
      dlog(`▸ 订阅 ${msg.view}${msg.aid ? ` aid=${String(msg.aid).split('.')[0]}` : ''}${msg.peer ? ` peer=${String(msg.peer).split('.')[0]}` : ''}${msg.sessionId ? ` session=${String(msg.sessionId).slice(0, 8)}` : ''} from ${ip}`);
      await switchSubscription(msg.view as ViewKind, params);
      return;
    }
    if (msg.type === 'menu' && msg.payload) {
      const p = resolvePaths();
      const resp = await ipcQuery<{ ok: boolean; response?: any; error?: string }>(
        p.socket, { type: 'menu.exec', payload: msg.payload }, 5000,
      );
      if (resp?.ok) {
        send({ type: 'menu.response', requestId: msg.requestId, data: resp.response });
      } else {
        send({ type: 'menu.response', requestId: msg.requestId, data: {
          type: 'menu.response', id: msg.payload?.id ?? '',
          error: { code: 'INTERNAL', message: resp?.error ?? 'daemon unreachable' },
        } });
      }
      return;
    }
  });

  // NAT keepalive: ping every 25s to prevent middlebox from cutting the connection
  let alive = true;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) { clearInterval(heartbeat); return; }
    if (!alive) { ws.terminate(); return; }
    alive = false;
    ws.ping();
  }, 25000);
  ws.on('pong', () => { alive = true; });

  ws.on('close', () => { clearInterval(heartbeat); if (unsubscribe) { unsubscribe(); unsubscribe = null; } log(`◇ WS 断开 from ${ip}`); });
  ws.on('error', () => {});
}

// ── Port binding ──

/** 跨平台：查端口上的 LISTENING 进程 PID（清理被占端口用）。 */
function findPidsOnPort(port: number): number[] {
  const pids = new Set<number>();
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8', windowsHide: true }).stdout || '';
      for (const line of out.split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) {
          const pid = Number(m[2]);
          if (pid && pid !== process.pid) pids.add(pid);
        }
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).stdout || '';
      for (const l of out.split('\n')) {
        const pid = parseInt(l.trim(), 10);
        if (pid && pid !== process.pid) pids.add(pid);
      }
    }
  } catch { /* netstat/lsof 缺失或无匹配 */ }
  return [...pids];
}

/** 杀掉占用目标端口的旧进程（强制）。 */
function killPidsOnPort(port: number, log: (s: string) => void): boolean {
  let killed = false;
  for (const pid of findPidsOnPort(port)) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
      else process.kill(pid, 'SIGKILL');
      log(`⚠ 端口 ${port} 被旧进程 PID ${pid} 占用，已终止`);
      killed = true;
    } catch { /* 已退出或无权限 */ }
  }
  return killed;
}

function sleepMs(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function bindPort(server: http.Server, preferred: number, log: (s: string) => void): Promise<{ port: number; displaced: boolean }> {
  return new Promise((resolve, reject) => {
    let killedOnce = false;
    const tryBind = (port: number) => {
      server.once('error', async (err: any) => {
        if (err.code === 'EADDRINUSE' && !killedOnce) {
          // 默认行为：杀掉占用端口的旧进程并重试本端口（而非 +1 漂移），避免端口被占。
          killedOnce = true;
          killPidsOnPort(port, log);
          await sleepMs(600);
          tryBind(port);
        } else {
          reject(err);
        }
      });
      server.listen(port, '0.0.0.0', () => resolve({ port, displaced: false }));
    };
    tryBind(preferred);
  });
}

// ── Main export ──

export interface WatchWebHandle { url: string; port: number; displaced: boolean; pairingCode: string; close(): Promise<void>; }

export async function startWatchWebServer(opts: { port?: number; log?: (s: string) => void } = {}): Promise<WatchWebHandle> {
  const log = opts.log || (() => {});
  setDebugLog(log);

  // soft 版本校验：ping daemon 检查 protocolVersion
  const p = resolvePaths();
  const pingResp = await ipcQuery<{ pong: boolean; pid?: number; protocolVersion?: number }>(p.socket, { type: 'ping' }, 1000);
  if (pingResp && pingResp.protocolVersion !== undefined && pingResp.protocolVersion < PROTOCOL_VERSION) {
    log(`⚠️  evolclaw protocolVersion=${pingResp.protocolVersion}，watch 期望 >=${PROTOCOL_VERSION}，部分功能可能异常`);
  }

  let pairingCode = genPairingCode();
  let pairingExpiry = Date.now() + PAIRING_TTL_MS;
  function freshPairing() {
    if (Date.now() > pairingExpiry) {
      pairingCode = genPairingCode();
      pairingExpiry = Date.now() + PAIRING_TTL_MS;
      log(`↺ 配对码已刷新：${pairingCode}（5 分钟有效）`);
    }
    return { code: pairingCode, expiresAt: pairingExpiry };
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url || '') === '/api/pair-code') {
      // 取码 API：仅真本地直连可用（socket 回环 + 无 x-aun-provider-aid）。
      // 隧道回连虽然 socket 也是 127.0.0.1，但有 x-aun-provider-aid 头 → 拒绝，
      // 防止远程访客通过隧道拿到配对码（安全漏洞）。
      if (!isLocalDirect(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      const { code, expiresAt } = freshPairing();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, expiresAt }));
    } else if (req.method === 'POST' && (req.url || '').startsWith('/api/pair')) {
      // 配对 API：远程（隧道/真远程）需要配对码；本地直连自动发 token 跳过配对。
      const autoToken = issueLocalDirectToken(req, log);
      if (autoToken) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: autoToken }));
        return;
      }
      handlePair(req, res, pairingCode, pairingExpiry, log);
    } else if (req.method === 'GET' && (req.url || '').startsWith('/api/stats/')) {
      // Stats API — 本地直连自动发 token（免鉴权），远程需鉴权
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const { query } = parseUrl(req.url || '');
      let token = bearerToken || query.token || '';
      if (!token) {
        const autoToken = issueLocalDirectToken(req, log);
        if (autoToken) token = autoToken;
      }
      if (!token || !validateAndRenew(token, Date.now())) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      handleStatsApi(req, res);
    } else {
      serveStatic(req, res);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { query } = parseUrl(req.url || '');
    // 本地直连免 token；远程需 token。
    const authed = isLocalDirect(req) || validateAndRenew(query.token || '', Date.now());
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authed) {
        log(`✗ WS 拒绝（无效 token） from ${clientIp(req)}`);
        ws.close(4001, 'invalid-token');
        return;
      }
      handleConnection(ws, req, log);
    });
  });

  const { port, displaced } = await bindPort(server, opts.port ?? DEFAULT_PORT, log);

  return {
    url: `http://0.0.0.0:${port}`,
    port,
    displaced,
    pairingCode,
    close(): Promise<void> {
      return new Promise((resolve) => {
        // 强制断开所有 WS 客户端（graceful close 握手可能永不完成）
        for (const client of wss.clients) try { client.terminate(); } catch {}
        wss.close();
        // server.close() 仅停止接受新连接，会等待存量连接（含 HTTP keep-alive、已升级的 WS）排空，
        // 否则回调永不触发 → 进程挂起。Node 18.2+ 用 closeAllConnections() 强制关闭。
        server.close(() => resolve());
        try { server.closeAllConnections(); } catch {}
      });
    },
  };
}

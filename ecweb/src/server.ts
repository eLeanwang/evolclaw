/**
 * Watch Web 服务 — 本地浏览器监控面板后端。
 *
 * - HTTP: 静态资源 + 配对 API
 * - WebSocket: 订阅式实时推送（aid / msg / session）
 * - 鉴权: 6 位配对码（5 分钟有效）→ token（24h，有访问自动续期），持久化到磁盘
 * - 安全: 绑定 0.0.0.0（支持远程访问），token 校验，只读
 *
 * 与 evolclaw 的唯一通信：启动时发 ping 检查 protocolVersion（soft 校验）。
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { resolvePaths } from './paths.js';
import { ipcQuery } from './ipc-client.js';
import { setDebugLog, dlog } from './debug-log.js';
import type { WatchSource, ViewKind } from './sources/types.js';
import { aidSource } from './sources/aid.js';
import { msgSource } from './sources/msg.js';
import { sessionSource } from './sources/session.js';
import { cacheSource } from './sources/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;  // 24h
const PAIRING_TTL_MS = 5 * 60 * 1000;       // 5min
const DEFAULT_PORT = 42705;
const PROTOCOL_VERSION = 1;                  // 与 evolclaw ping response 对齐的软校验版本

const SOURCES: Record<ViewKind, WatchSource> = { aid: aidSource, msg: msgSource, session: sessionSource, cache: cacheSource };

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
  return path.join(resolvePaths().instanceDir, 'watch-web-tokens.json');
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

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '?';
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
    log(`✓ 配对成功 from ${ip}（token 缓存 24h）`);
  });
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
    try { send({ type: 'snapshot', view, data: await source.snapshot(params) }); }
    catch (e: any) { send({ type: 'error', message: `snapshot failed: ${e?.message || e}` }); }
    unsubscribe = source.subscribe(params, (data) => {
      if (currentView === view) send({ type: 'delta', view, data });
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
      dlog(`▸ 订阅 ${msg.view}${msg.aid ? ` aid=${String(msg.aid).split('.')[0]}` : ''}${msg.peer ? ` peer=${String(msg.peer).split('.')[0]}` : ''}${msg.sessionId ? ` session=${String(msg.sessionId).slice(0, 8)}` : ''} from ${ip}`);
      await switchSubscription(msg.view as ViewKind, params);
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

function bindPort(server: http.Server, preferred: number): Promise<{ port: number; displaced: boolean }> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryBind = (port: number) => {
      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) { attempt++; tryBind(port + 1); }
        else reject(err);
      });
      server.listen(port, '0.0.0.0', () => resolve({ port, displaced: port !== preferred }));
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
      const { code, expiresAt } = freshPairing();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, expiresAt }));
    } else if (req.method === 'POST' && (req.url || '').startsWith('/api/pair')) {
      handlePair(req, res, pairingCode, pairingExpiry, log);
    } else {
      serveStatic(req, res);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { query } = parseUrl(req.url || '');
    const authed = validateAndRenew(query.token || '', Date.now());
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authed) {
        log(`✗ WS 拒绝（无效 token） from ${clientIp(req)}`);
        ws.close(4001, 'invalid-token');
        return;
      }
      handleConnection(ws, req, log);
    });
  });

  const { port, displaced } = await bindPort(server, opts.port ?? DEFAULT_PORT);

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

/**
 * Watch Web 服务 — 本地浏览器监控面板的后端。
 *
 * - HTTP: 静态资源 + 配对 API
 * - WebSocket: 订阅式实时推送（aid / msg / session）
 * - 鉴权: 6 位配对码（5 分钟有效）→ token（24h，有访问自动续期），持久化到磁盘
 * - 安全: 绑定 0.0.0.0（支持远程访问），token 校验，只读
 *
 * 借鉴 Kite 控制台：配对码换 token、首消息鉴权、订阅式推送、访问日志。
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { resolvePaths } from '../../paths.js';
import { setDebugLog, dlog } from './debug-log.js';
import type { WatchSource, ViewKind } from './sources/types.js';
import { aidSource } from './sources/aid.js';
import { msgSource } from './sources/msg.js';
import { sessionSource } from './sources/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;     // 24 小时
const PAIRING_TTL_MS = 5 * 60 * 1000;          // 配对码 5 分钟
const DEFAULT_PORT = 20030;

const SOURCES: Record<ViewKind, WatchSource> = {
  aid: aidSource,
  msg: msgSource,
  session: sessionSource,
};

interface TokenRecord {
  token: string;
  createdAt: number;
  lastActive: number;
  label: string;   // 配对时的简短描述（IP 等）
}

interface TokenStore {
  tokens: TokenRecord[];
}

export interface WatchWebHandle {
  url: string;
  port: number;
  pairingCode: string;
  close(): Promise<void>;
}

// ── Token 持久化 ──

function tokenStorePath(): string {
  return path.join(resolvePaths().instanceDir, 'watch-web-tokens.json');
}

function loadTokens(): TokenStore {
  try {
    const raw = fs.readFileSync(tokenStorePath(), 'utf-8');
    const store = JSON.parse(raw) as TokenStore;
    if (Array.isArray(store.tokens)) return store;
  } catch { /* missing or corrupt */ }
  return { tokens: [] };
}

function saveTokens(store: TokenStore): void {
  try {
    fs.mkdirSync(resolvePaths().instanceDir, { recursive: true });
    const tmp = tokenStorePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, tokenStorePath());
  } catch { /* best effort */ }
}

function pruneExpired(store: TokenStore, now: number): boolean {
  const before = store.tokens.length;
  store.tokens = store.tokens.filter(t => now - t.lastActive < TOKEN_TTL_MS);
  return store.tokens.length !== before;
}

/** 校验 token，命中则续期（更新 lastActive）并持久化 */
function validateAndRenew(token: string, now: number): boolean {
  if (!token) return false;
  const store = loadTokens();
  const changed = pruneExpired(store, now);
  const rec = store.tokens.find(t => t.token === token);
  if (rec) {
    rec.lastActive = now;
    saveTokens(store);
    return true;
  }
  if (changed) saveTokens(store);
  return false;
}

// ── 静态资源 ──

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  // 防目录穿越
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── 主入口 ──

type LogFn = (line: string) => void;

function genPairingCode(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

export async function startWatchWebServer(opts: { port?: number; log?: LogFn } = {}): Promise<WatchWebHandle> {
  const log: LogFn = opts.log || (() => {});
  setDebugLog(log);   // 把日志 writer 注入各 source，建立调试闭环
  const pairingCode = genPairingCode();
  const pairingExpiry = Date.now() + PAIRING_TTL_MS;

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (req.method === 'POST' && url === '/api/pair') {
      handlePair(req, res, pairingCode, pairingExpiry, log);
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { query } = parseUrl(req.url || '');
    const token = query.token || '';
    if (!validateAndRenew(token, Date.now())) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      log(`✗ WS 拒绝（无效 token） from ${req.socket.remoteAddress}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, log);
    });
  });

  const port = await bindPort(server, opts.port ?? DEFAULT_PORT);
  const url = `http://0.0.0.0:${port}`;

  return {
    url,
    port,
    pairingCode,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          try { client.close(); } catch { /* ignore */ }
        }
        wss.close();
        server.close(() => resolve());
      });
    },
  };
}

// ── 配对 ──

function handlePair(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pairingCode: string,
  pairingExpiry: number,
  log: LogFn,
): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    const ip = clientIp(req);
    let code = '';
    try { code = String(JSON.parse(body).code || ''); } catch { /* bad json */ }

    if (Date.now() > pairingExpiry) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: '配对码已过期，请重启 watch web' }));
      log(`✗ 配对失败（码已过期） from ${ip}`);
      return;
    }
    if (code !== pairingCode) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: '配对码错误' }));
      log(`✗ 配对失败（码错误: ${code}） from ${ip}`);
      return;
    }
    // 配对成功，发放持久 token
    const now = Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    const store = loadTokens();
    pruneExpired(store, now);
    store.tokens.push({ token, createdAt: now, lastActive: now, label: ip });
    saveTokens(store);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token }));
    log(`✓ 配对成功 from ${ip}（token 已缓存，24h 有效）`);
  });
}

// ── URL 解析 ──

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

// ── WebSocket 连接 ──

function handleConnection(ws: WebSocket, req: http.IncomingMessage, log: LogFn): void {
  const ip = clientIp(req);
  let unsubscribe: (() => void) | null = null;
  let currentView: ViewKind | null = null;
  log(`◆ WS 连接 from ${ip}`);

  const send = (obj: any) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  };

  const switchSubscription = async (view: ViewKind, params: Record<string, any>) => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    currentView = view;
    const source = SOURCES[view];
    if (!source) { send({ type: 'error', message: `unknown view: ${view}` }); return; }
    try {
      const snap = await source.snapshot(params);
      send({ type: 'snapshot', view, data: snap });
    } catch (e: any) {
      send({ type: 'error', message: `snapshot failed: ${e?.message || e}` });
    }
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
      log(`▸ 订阅 ${msg.view}` +
        `${msg.project ? ` project=${String(msg.project).slice(-24)}` : ''}` +
        `${msg.aid ? ` aid=${String(msg.aid).split('.')[0]}` : ''}` +
        `${msg.peer ? ` peer=${String(msg.peer).split('.')[0]}` : ''}` +
        `${msg.sessionId ? ` session=${String(msg.sessionId).slice(0, 8)}` : ''} from ${ip}`);
      await switchSubscription(msg.view as ViewKind, params);
    }
  });

  ws.on('close', () => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    log(`◇ WS 断开 from ${ip}`);
  });
  ws.on('error', () => { /* swallow; close 会触发清理 */ });
}

// ── 端口绑定（首选端口被占则 +1，最多尝试 10 次）──

function bindPort(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryBind = (port: number) => {
      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
          attempt++;
          tryBind(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, '0.0.0.0', () => resolve(port));
    };
    tryBind(preferred);
  });
}


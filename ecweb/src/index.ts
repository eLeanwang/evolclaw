#!/usr/bin/env node
/**
 * ecweb — EvolClaw 监控面板独立程序。
 *
 * 用法:
 *   ecweb [--port 20030] [--home <EVOLCLAW_HOME>]
 *
 * 通过 EVOLCLAW_HOME 定位 evolclaw 数据目录，启动 HTTP+WS 服务，浏览器配对码登录。
 * 与 evolclaw daemon 通过 IPC socket（live 状态）+ 文件系统（历史数据）旁路通信。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── 解析参数 ──
const argv = process.argv.slice(2);
let port: number | undefined;
let home: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port' || a === '-p') port = Number(argv[++i]);
  else if (a === '--home' || a === '-h') home = argv[++i];
  else if (a === '--help') {
    process.stdout.write(`ecweb — EvolClaw 监控面板\n\n用法:\n  ecweb [--port 20030] [--home <EVOLCLAW_HOME>]\n\n选项:\n  --port, -p   监听端口（默认 20030，占用则自动 +1）\n  --home       EVOLCLAW_HOME 数据目录（默认读环境变量或 ~/.evolclaw）\n`);
    process.exit(0);
  }
}

// --home 优先级最高：写入环境变量，paths.ts 读取
if (home) process.env.EVOLCLAW_HOME = path.resolve(home);

// 延迟到环境变量设置后再导入（paths.ts 缓存 root）
const { resolvePaths } = await import('./paths.js');
const { startWatchWebServer } = await import('./server.js');

const p = resolvePaths();

// 校验 home 目录存在
if (!fs.existsSync(p.root)) {
  process.stderr.write(`❌ EVOLCLAW_HOME 不存在: ${p.root}\n   用 --home 指定正确路径，或设置 EVOLCLAW_HOME 环境变量。\n`);
  process.exit(1);
}

const useColor = !!process.stdout.isTTY;
const RST = useColor ? '\x1b[0m' : '';
const DIM = useColor ? '\x1b[2m' : '';
const BOLD = useColor ? '\x1b[1m' : '';
const CYAN = useColor ? '\x1b[36m' : '';
const GREEN = useColor ? '\x1b[32m' : '';
const YELLOW = useColor ? '\x1b[33m' : '';

const logLine = (line: string) => {
  const t = new Date();
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  process.stdout.write(`${DIM}${ts}${RST} ${line}\n`);
};

// 调试日志文件
const logFile = path.join(p.logs, 'watch-web.log');
try {
  fs.mkdirSync(p.logs, { recursive: true });
  fs.writeFileSync(logFile, `# ecweb debug log\n# started ${new Date().toISOString()} pid=${process.pid}\n`);
} catch {}
const fileLog = (line: string) => {
  const t = new Date();
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  try { fs.appendFileSync(logFile, `${ts} ${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`); } catch {}
};
const log = (line: string) => { logLine(line); fileLog(line); };

let handle;
try {
  handle = await startWatchWebServer({ port, log });
} catch (e: any) {
  process.stderr.write(`❌ 启动失败: ${e?.message || e}\n`);
  process.exit(1);
}

// 注册 instance 文件
fs.mkdirSync(p.instanceDir, { recursive: true });
const instanceFile = path.join(p.instanceDir, `watch-web-${process.pid}.json`);
try {
  fs.writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), startedAtIso: new Date().toISOString(), type: 'watch-web', port: handle.port }, null, 2));
} catch {}

// 列出访问地址
const ifaces = os.networkInterfaces();
const lanIps: string[] = [];
for (const list of Object.values(ifaces)) {
  for (const ni of list || []) {
    if (ni.family === 'IPv4' && !ni.internal) lanIps.push(ni.address);
  }
}

process.stdout.write(`\n${BOLD}${CYAN}🔭 EvolClaw Watch${RST}  ${DIM}(home: ${p.root})${RST}\n\n`);
process.stdout.write(`  ${BOLD}配对码:${RST}  ${GREEN}${BOLD}${handle.pairingCode}${RST}  ${DIM}(5 分钟内有效，配对后 token 缓存 24h 自动续期)${RST}\n\n`);
process.stdout.write(`  ${BOLD}本机:${RST}    http://localhost:${handle.port}\n`);
for (const ip of lanIps) process.stdout.write(`  ${BOLD}局域网:${RST}  http://${ip}:${handle.port}\n`);
process.stdout.write(`\n  ${DIM}绑定 0.0.0.0，远程可访问。Ctrl-C 退出。${RST}\n`);
process.stdout.write(`  ${DIM}调试日志: ${logFile}${RST}\n\n`);

const cleanup = () => {
  try { fs.unlinkSync(instanceFile); } catch {}
  handle.close().finally(() => process.exit(0));
};
process.on('exit', () => { try { fs.unlinkSync(instanceFile); } catch {} });
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key: Buffer) => {
    // Ctrl-C (0x03) 或 q 退出
    if (key[0] === 0x03 || key.toString() === 'q') {
      logLine(`${YELLOW}退出中…${RST}`);
      cleanup();
    }
  });
}

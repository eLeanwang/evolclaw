import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolvePaths, getPackageRoot } from '../paths.js';
import { decodeDirSegment, readAllJsonlLines } from '../core/session/session-fs-store.js';
import { isHandoffStateMessage } from '../core/message/message-log.js';

// ==================== Types ====================

export interface MessageLogEntry {
  ts: number;
  time: string;
  dir: 'in' | 'out';
  from: string;
  to: string;
  chatType: 'private' | 'group';
  groupId: string | null;
  msgId: string | null;
  msgType: string;
  content: string;
  replyTo: string | null;
  agent: string | null;
  model: string | null;
  permMode: string | null;
  durationMs: number | null;
  numTurns?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  encrypt?: boolean;
  chatmode?: string;
  source?: 'daemon' | 'cli' | 'msg' | 'ctl' | 'owner-inject' | 'handoff';
}

export interface PeerInfo {
  peerId: string;
  peerName: string | null;
  inbound: number;
  outbound: number;
  lastAt: number;
}

export interface AidInfo {
  aid: string;
  totalIn: number;
  totalOut: number;
  peerCount: number;
}

interface WatchMsgState {
  activePanel: 'scope' | 'stats' | 'messages';
  localAids: AidInfo[];
  scopeIndex: number;
  selectedLocalAid: string | null;
  peers: PeerInfo[];
  statsIndex: number;
  selectedPeer: string | null;
  messages: MessageLogEntry[];
  messageScrollOffset: number;
  dirty: boolean;
}

// ==================== ANSI ====================

const isTTY = !!process.stdout.isTTY;
const RST = isTTY ? '\x1b[0m' : '';
const DIM = isTTY ? '\x1b[2m' : '';
const BOLD = isTTY ? '\x1b[1m' : '';
const CYAN = isTTY ? '\x1b[36m' : '';
const GREEN = isTTY ? '\x1b[32m' : '';
const BLUE = isTTY ? '\x1b[34m' : '';
const ORANGE = isTTY ? '\x1b[38;5;208m' : '';
const MAGENTA = isTTY ? '\x1b[35m' : '';
const YELLOW = isTTY ? '\x1b[33m' : '';
const BG_SEL = isTTY ? '\x1b[48;5;236m' : '';  // dark gray background for selected row

// ==================== Helpers ====================

function visualWidth(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of stripped) {
    const code = ch.charCodeAt(0);
    w += (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) ||
         (code >= 0xff00 && code <= 0xffef) ? 2 : 1;
  }
  return w;
}

function padRight(s: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(s));
  return s + ' '.repeat(pad);
}

function truncate(s: string, maxWidth: number): string {
  let w = 0;
  let i = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const cw = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) ||
               (code >= 0xff00 && code <= 0xffef) ? 2 : 1;
    if (w + cw > maxWidth - 1) return s.slice(0, i) + '…';
    w += cw;
    i += ch.length;
  }
  return s;
}

function wrapText(s: string, lineWidth: number, maxLines: number): string[] {
  const result: string[] = [];
  let remaining = s;
  while (remaining.length > 0 && result.length < maxLines) {
    let w = 0;
    let cutIdx = 0;
    for (const ch of remaining) {
      const code = ch.charCodeAt(0);
      const cw = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) ||
                 (code >= 0xff00 && code <= 0xffef) ? 2 : 1;
      if (w + cw > lineWidth) break;
      w += cw;
      cutIdx += ch.length;
    }
    if (cutIdx === 0) break;
    const isLast = result.length === maxLines - 1;
    if (isLast && cutIdx < remaining.length) {
      result.push(truncate(remaining, lineWidth));
    } else {
      result.push(remaining.slice(0, cutIdx));
    }
    remaining = remaining.slice(cutIdx);
  }
  if (result.length === 0) result.push('');
  return result;
}

function formatTimeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
}

function getCodeTime(pkgRoot: string): string {
  let latestMtime = 0;
  const scanDir = fs.existsSync(path.join(pkgRoot, 'dist')) ? path.join(pkgRoot, 'dist') : path.join(pkgRoot, 'src');
  const scanRecursive = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanRecursive(full); continue; }
        if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
          const mt = fs.statSync(full).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        }
      }
    } catch {}
  };
  scanRecursive(scanDir);
  if (!latestMtime) return '?';
  const d = new Date(latestMtime);
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

function shortAid(aid: string): string {
  return aid.split('.')[0];
}

// ==================== Data Layer ====================

export function getSessionsAunDir(): string {
  const p = resolvePaths();
  return path.join(p.sessionsDir, 'aun');
}

export function listLocalAids(aunDir: string): string[] {
  try {
    return fs.readdirSync(aunDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => decodeDirSegment(e.name));
  } catch { return []; }
}

export function listPeers(aunDir: string, localAid: string): string[] {
  const aidDir = path.join(aunDir, encodeSegment(localAid));
  try {
    return fs.readdirSync(aidDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => decodeDirSegment(e.name));
  } catch { return []; }
}

export function readMessages(aunDir: string, localAid: string, peerId: string): MessageLogEntry[] {
  const msgPath = path.join(aunDir, encodeSegment(localAid), encodeSegment(peerId), 'messages.jsonl');
  return readAllJsonlLines<MessageLogEntry>(msgPath).filter(m => !isHandoffStateMessage(m as any));
}

function readPeerName(aunDir: string, localAid: string, peerId: string): string | null {
  const activePath = path.join(aunDir, encodeSegment(localAid), encodeSegment(peerId), 'active.json');
  try {
    const data = JSON.parse(fs.readFileSync(activePath, 'utf-8'));
    return data?.metadata?.peerName || null;
  } catch { return null; }
}

function encodeSegment(s: string): string {
  return s.replace(/[/%\\:*?"<>|]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

export function loadAidInfo(aunDir: string, aid: string): AidInfo {
  const peers = listPeers(aunDir, aid);
  let totalIn = 0, totalOut = 0;
  for (const peer of peers) {
    const msgs = readMessages(aunDir, aid, peer);
    for (const m of msgs) {
      if (m.dir === 'in') totalIn++;
      else totalOut++;
    }
  }
  return { aid, totalIn, totalOut, peerCount: peers.length };
}

export function loadPeerInfos(aunDir: string, localAid: string): PeerInfo[] {
  const peers = listPeers(aunDir, localAid);
  const infos: PeerInfo[] = [];
  for (const peerId of peers) {
    const msgs = readMessages(aunDir, localAid, peerId);
    let inbound = 0, outbound = 0, lastAt = 0;
    for (const m of msgs) {
      if (m.dir === 'in') inbound++;
      else outbound++;
      if (m.ts > lastAt) lastAt = m.ts;
    }
    const peerName = readPeerName(aunDir, localAid, peerId);
    infos.push({ peerId, peerName, inbound, outbound, lastAt });
  }
  infos.sort((a, b) => b.lastAt - a.lastAt);
  return infos;
}

export function loadAllMessages(aunDir: string, localAid: string): MessageLogEntry[] {
  const peers = listPeers(aunDir, localAid);
  const all: MessageLogEntry[] = [];
  for (const peer of peers) {
    all.push(...readMessages(aunDir, localAid, peer));
  }
  all.sort((a, b) => a.ts - b.ts);
  if (all.length > 1000) return all.slice(-1000);
  return all;
}

// ==================== Rendering ====================

function renderScrollbar(totalLines: number, visibleLines: number, offset: number, height: number): string[] {
  if (totalLines <= visibleLines) return Array(height).fill(' ');
  const thumbSize = Math.max(1, Math.floor(height * visibleLines / totalLines));
  const maxOffset = totalLines - visibleLines;
  const thumbPos = Math.floor((maxOffset - offset) / maxOffset * (height - thumbSize));
  const bar: string[] = [];
  for (let i = 0; i < height; i++) {
    bar.push(i >= thumbPos && i < thumbPos + thumbSize ? `${DIM}█${RST}` : `${DIM}░${RST}`);
  }
  return bar;
}

function renderScopePanel(state: WatchMsgState, width: number, height: number): string[] {
  const lines: string[] = [];
  const title = `${DIM}─ Scope ─${RST}`;
  lines.push(padRight(title, width));

  const isActive = state.activePanel === 'scope';
  for (let i = 0; i < state.localAids.length && lines.length < height; i++) {
    const a = state.localAids[i];
    const sel = isActive && i === state.scopeIndex;
    const chosen = state.selectedLocalAid === a.aid;
    const bg = sel ? BG_SEL : '';
    const marker = sel ? `${bg}${CYAN}${BOLD}▸ ` : (chosen ? `${CYAN}  ` : '  ');
    const name = truncate(shortAid(a.aid), width - 4);
    lines.push(padRight(`${marker}${name}${RST}`, width));
    const statsBg = sel ? BG_SEL : '';
    const stats = `${statsBg}  ${DIM}↓${a.totalIn} ↑${a.totalOut} peers:${a.peerCount}${RST}`;
    lines.push(padRight(stats, width));
    if (lines.length < height) lines.push(padRight('', width));
  }

  while (lines.length < height) lines.push(padRight('', width));
  return lines.slice(0, height);
}

function renderStatsPanel(state: WatchMsgState, width: number, height: number): string[] {
  const lines: string[] = [];
  const title = `${DIM}─ Stats ─${RST}`;
  lines.push(padRight(title, width));

  if (!state.selectedLocalAid) {
    lines.push(padRight(`${DIM}  select an AID${RST}`, width));
    while (lines.length < height) lines.push(padRight('', width));
    return lines.slice(0, height);
  }

  const isActive = state.activePanel === 'stats';
  const now = Date.now();

  // "All" item at index 0
  const allSel = isActive && state.statsIndex === 0;
  const allBg = allSel ? BG_SEL : '';
  const allMarker = allSel ? `${allBg}${CYAN}${BOLD}▸ ` : '  ';
  lines.push(padRight(`${allMarker}All (${state.peers.length} peers)${RST}`, width));
  if (lines.length < height) lines.push(padRight('', width));

  for (let i = 0; i < state.peers.length && lines.length < height; i++) {
    const p = state.peers[i];
    const sel = isActive && state.statsIndex === i + 1;
    const bg = sel ? BG_SEL : '';
    const marker = sel ? `${bg}${CYAN}${BOLD}▸ ` : '  ';
    const displayName = p.peerName || shortAid(p.peerId);
    const name = truncate(displayName, width - 4);
    lines.push(padRight(`${marker}${name}${RST}`, width));
    const detailBg = sel ? BG_SEL : '';
    const ago = p.lastAt ? formatTimeAgo(now - p.lastAt) : '-';
    const detail = `${detailBg}  ${DIM}↓${p.inbound} ↑${p.outbound}  ${ago}${RST}`;
    lines.push(padRight(detail, width));
    if (lines.length < height) lines.push(padRight('', width));
  }

  while (lines.length < height) lines.push(padRight('', width));
  return lines.slice(0, height);
}

// ==================== Messages Panel ====================

function renderMessagesPanel(state: WatchMsgState, width: number, height: number): string[] {
  const lines: string[] = [];
  const lastTs = state.messages.length > 0 ? state.messages[state.messages.length - 1].ts : 0;
  const lastTimeStr = lastTs ? formatDateTime(lastTs) : '--';
  const title = `${DIM}─ Messages (${state.messages.length}, last: ${lastTimeStr}) ─${RST}`;
  lines.push(padRight(title, width));

  const contentHeight = height - 1;
  const msgs = state.messages;
  const totalMsgs = msgs.length;

  const msgWidth = width - 3;
  const contentLineWidth = msgWidth - 2;
  const maxContentLines = 3;

  // 先构造每条消息的渲染行，从最末尾的可见消息往回收集，直到填满 contentHeight
  function renderOneMsg(m: MessageLogEntry): string[] {
    const time = formatDateTime(m.ts);
    const dir = m.dir === 'in' ? `${GREEN}↓${RST}` : `${BLUE}↑${RST}`;
    const isGroup = m.chatType === 'group';
    const chatTag = isGroup ? `${MAGENTA}[群聊]${RST}` : '';
    const encLabel = m.encrypt ? '密文' : '明文';
    const modeLabel = m.chatmode === 'proactive' ? '自主' : '响应';
    const metaTags = (m.encrypt != null || m.chatmode) ? `${MAGENTA}[${encLabel}|${modeLabel}]${RST}` : '';
    // observer 插话：醒目标记，与对端真实消息区分
    const injectTag = m.source === 'owner-inject' ? `${YELLOW}[插话]${RST}` : '';
    let typeTag = '';
    if (m.dir === 'out' && m.source !== 'owner-inject') {
      const rawSource = (m as any).source as string | undefined;
      // 4 种来源: daemon | ctl | msg | cli
      const source = (rawSource === 'ctl' || rawSource === 'msg' || rawSource === 'cli') ? rawSource : 'daemon';
      const method = m.msgType === 'thought' ? 'thought' : 'send';
      typeTag = `${DIM}[${source}|${method}]${RST}`;
    }
    const byteLen = Buffer.byteLength(m.content, 'utf-8');
    const lenTag = `${DIM}${formatNumber(byteLen)}B${RST}`;
    const fromDisplay = isGroup && m.groupId && m.dir === 'in' ? m.groupId : m.from.split('.')[0];
    const toDisplay = isGroup && m.groupId && m.dir === 'out' ? m.groupId : m.to.split('.')[0];
    const header = `${DIM}${time}${RST} ${dir}${chatTag}${injectTag}${metaTags}${typeTag} ${ORANGE}${fromDisplay}${RST}${DIM}→${RST}${GREEN}${toDisplay}${RST} ${lenTag}`;
    const out: string[] = [padRight(header, msgWidth)];
    const rawContent = m.content.replace(/\n/g, ' ');
    const wrappedLines = wrapText(rawContent, contentLineWidth, maxContentLines);
    for (const wl of wrappedLines) {
      out.push(padRight(`  ${wl}`, msgWidth));
    }
    return out;
  }

  // 从 endIdx-1 开始倒序，往回累积，直到行数填满 contentHeight
  const endIdx = Math.max(0, totalMsgs - state.messageScrollOffset);
  const collected: string[][] = []; // 每条消息的行数组
  let totalLines = 0;
  let firstShownIdx = endIdx; // 首条可见消息的下标
  for (let i = endIdx - 1; i >= 0; i--) {
    const rendered = renderOneMsg(msgs[i]);
    if (totalLines + rendered.length > contentHeight && collected.length > 0) break;
    collected.unshift(rendered);
    totalLines += rendered.length;
    firstShownIdx = i;
    if (totalLines >= contentHeight) break;
  }

  const visibleMsgCount = endIdx - firstShownIdx;
  const scrollbar = renderScrollbar(totalMsgs, visibleMsgCount, state.messageScrollOffset, contentHeight);

  // 正序输出（旧→新）
  for (const rendered of collected) {
    for (const line of rendered) {
      if (lines.length - 1 >= contentHeight) break;
      const sbIdx = lines.length - 1;
      lines.push(`${line} ${scrollbar[sbIdx] || ' '}`);
    }
    if (lines.length - 1 >= contentHeight) break;
  }

  while (lines.length < height) {
    const sbIdx = lines.length - 1;
    lines.push(padRight('', msgWidth) + ` ${scrollbar[sbIdx] || ' '}`);
  }

  return lines.slice(0, height);
}

// ==================== Main Render ====================

function renderFrame(state: WatchMsgState): string {
  const cols = process.stdout.columns || 120;
  const rows = (process.stdout.rows || 40);

  const bodyHeight = rows - 4;

  const leftW = Math.max(20, Math.floor(cols * 0.20));
  const midW = Math.max(24, Math.floor(cols * 0.22));
  const rightW = Math.max(40, cols - leftW - midW - 4);

  const leftLines = renderScopePanel(state, leftW, bodyHeight);
  const midLines = renderStatsPanel(state, midW, bodyHeight);
  const msgLines = renderMessagesPanel(state, rightW, bodyHeight);

  const sep = `${DIM}│${RST}`;
  let buf = '\x1b[H';

  const topBorder = `${DIM}┌${'─'.repeat(leftW)}┬${'─'.repeat(midW)}┬${'─'.repeat(rightW + 1)}┐${RST}`;
  buf += `\x1b[2K${topBorder}\n`;

  for (let i = 0; i < bodyHeight; i++) {
    const l = leftLines[i] || padRight('', leftW);
    const m = midLines[i] || padRight('', midW);
    const r = msgLines[i] || padRight('', rightW);
    buf += `\x1b[2K${sep}${l}${sep}${m}${sep}${r}${sep}\n`;
  }

  const bottomBorder = `${DIM}├${'─'.repeat(leftW)}┴${'─'.repeat(midW)}┴${'─'.repeat(rightW + 1)}┤${RST}`;
  buf += `\x1b[2K${bottomBorder}\n`;

  const helpText = `Tab: panel  ↑↓: nav  Enter: select  Backspace: back  ESC: exit`;
  const helpLine = `${DIM}│ ${helpText.slice(0, cols - 4)} ${RST}`;
  buf += `\x1b[2K${helpLine}\n`;
  const closeBorder = `${DIM}└${'─'.repeat(cols - 2)}┘${RST}`;
  buf += `\x1b[2K${closeBorder}`;

  return buf;
}

// ==================== Main ====================

export async function cmdWatchMsg(): Promise<void> {
  const aunDir = getSessionsAunDir();
  if (!fs.existsSync(aunDir)) {
    console.log('No session data found.');
    return;
  }

  let watcher: fs.FSWatcher | null = null;

  const state: WatchMsgState = {
    activePanel: 'scope',
    localAids: [],
    scopeIndex: 0,
    selectedLocalAid: null,
    peers: [],
    statsIndex: 0,
    selectedPeer: null,
    messages: [],
    messageScrollOffset: 0,
    dirty: true,
  };

  function loadScope() {
    const aids = listLocalAids(aunDir);
    state.localAids = aids.map(aid => loadAidInfo(aunDir, aid));
    state.localAids.sort((a, b) => (b.totalIn + b.totalOut) - (a.totalIn + a.totalOut));
  }

  function selectAid(aid: string) {
    state.selectedLocalAid = aid;
    state.peers = loadPeerInfos(aunDir, aid);
    state.statsIndex = 0;
    state.selectedPeer = null;
    state.messages = loadAllMessages(aunDir, aid);
    state.messageScrollOffset = 0;
    startWatching(aid);
  }

  function selectPeer(peerId: string | null) {
    state.selectedPeer = peerId;
    if (!state.selectedLocalAid) return;
    if (peerId) {
      state.messages = readMessages(aunDir, state.selectedLocalAid, peerId);
      if (state.messages.length > 1000) state.messages = state.messages.slice(-1000);
    } else {
      state.messages = loadAllMessages(aunDir, state.selectedLocalAid);
    }
    state.messageScrollOffset = 0;
  }

  function startWatching(aid: string) {
    if (watcher) { watcher.close(); watcher = null; }
    const aidDir = path.join(aunDir, encodeSegment(aid));
    try {
      watcher = fs.watch(aidDir, { recursive: true }, (_, filename) => {
        if (filename && filename.endsWith('messages.jsonl')) {
          refreshData();
          render();
        }
      });
    } catch { /* directory may not exist */ }
  }

  function refreshData() {
    if (!state.selectedLocalAid) return;
    state.peers = loadPeerInfos(aunDir, state.selectedLocalAid);
    const prevCount = state.messages.length;
    if (state.selectedPeer) {
      state.messages = readMessages(aunDir, state.selectedLocalAid, state.selectedPeer);
      if (state.messages.length > 1000) state.messages = state.messages.slice(-1000);
    } else {
      state.messages = loadAllMessages(aunDir, state.selectedLocalAid);
    }
    // 有新消息时自动滚到底部
    if (state.messages.length > prevCount) {
      state.messageScrollOffset = 0;
    }
    // Also refresh scope stats for the selected AID
    const idx = state.localAids.findIndex(a => a.aid === state.selectedLocalAid);
    if (idx >= 0) {
      state.localAids[idx] = loadAidInfo(aunDir, state.selectedLocalAid!);
    }
  }

  function render() {
    process.stdout.write(renderFrame(state));
  }

  function cleanup() {
    if (watcher) { watcher.close(); watcher = null; }
    clearInterval(pollTimer);
    if (process.stdin.isTTY) try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
  }

  function handleKey(data: Buffer) {
    // ESC
    if (data[0] === 0x1b && data.length === 1) { cleanup(); process.exit(0); }
    // Ctrl+C
    if (data[0] === 0x03) { cleanup(); process.exit(0); }

    // Arrow keys
    if (data[0] === 0x1b && data[1] === 0x5b) {
      const code = data[2];
      if (code === 0x41) handleUp();
      else if (code === 0x42) handleDown();
      else if (code === 0x43) handleRight();
      else if (code === 0x44) handleLeft();
      else if (code === 0x35) handlePageUp();   // Page Up: \x1b[5~
      else if (code === 0x36) handlePageDown(); // Page Down: \x1b[6~
      render();
      return;
    }

    // Tab
    if (data[0] === 0x09) { handleRight(); render(); return; }
    // Shift+Tab (some terminals: \x1b[Z)
    if (data[0] === 0x1b && data[1] === 0x5b && data[2] === 0x5a) { handleLeft(); render(); return; }

    // Enter
    if (data[0] === 0x0d) { handleEnter(); render(); return; }
    // Backspace
    if (data[0] === 0x7f || data[0] === 0x08) { handleBackspace(); render(); return; }
  }

  function handleUp() {
    if (state.activePanel === 'scope') {
      state.scopeIndex = Math.max(0, state.scopeIndex - 1);
    } else if (state.activePanel === 'stats') {
      state.statsIndex = Math.max(0, state.statsIndex - 1);
    } else if (state.activePanel === 'messages') {
      state.messageScrollOffset = Math.min(
        Math.max(0, state.messages.length - 5),
        state.messageScrollOffset + 3
      );
    }
  }

  function handleDown() {
    if (state.activePanel === 'scope') {
      state.scopeIndex = Math.min(state.localAids.length - 1, state.scopeIndex + 1);
    } else if (state.activePanel === 'stats') {
      state.statsIndex = Math.min(state.peers.length, state.statsIndex + 1);
    } else if (state.activePanel === 'messages') {
      state.messageScrollOffset = Math.max(0, state.messageScrollOffset - 3);
    }
  }

  function handleLeft() {
    if (state.activePanel === 'messages') state.activePanel = 'stats';
    else if (state.activePanel === 'stats') state.activePanel = 'scope';
  }

  function handleRight() {
    if (state.activePanel === 'scope') state.activePanel = 'stats';
    else if (state.activePanel === 'stats') state.activePanel = 'messages';
  }

  function handlePageUp() {
    if (state.activePanel === 'messages') {
      const pageSize = (process.stdout.rows || 40) - 6;
      state.messageScrollOffset = Math.min(
        Math.max(0, state.messages.length - 5),
        state.messageScrollOffset + pageSize
      );
    }
  }

  function handlePageDown() {
    if (state.activePanel === 'messages') {
      const pageSize = (process.stdout.rows || 40) - 6;
      state.messageScrollOffset = Math.max(0, state.messageScrollOffset - pageSize);
    }
  }

  function handleEnter() {
    if (state.activePanel === 'scope' && state.localAids.length > 0) {
      const aid = state.localAids[state.scopeIndex];
      selectAid(aid.aid);
      state.activePanel = 'stats';
    } else if (state.activePanel === 'stats') {
      if (state.statsIndex === 0) {
        selectPeer(null);
      } else {
        const peer = state.peers[state.statsIndex - 1];
        if (peer) selectPeer(peer.peerId);
      }
      state.activePanel = 'messages';
    }
  }

  function handleBackspace() {
    if (state.activePanel === 'messages') {
      state.activePanel = 'stats';
      state.messageScrollOffset = 0;
    } else if (state.activePanel === 'stats') {
      state.activePanel = 'scope';
      state.selectedLocalAid = null;
      state.peers = [];
      state.messages = [];
      if (watcher) { watcher.close(); watcher = null; }
    }
  }

  // ── Init ──
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  loadScope();
  process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');
  render();

  // 定时轮询：5 秒检查一次，有变化才刷新
  let lastMsgCount = state.messages.length;
  let lastMsgTs = state.messages.length > 0 ? state.messages[state.messages.length - 1].ts : 0;
  const pollTimer = setInterval(() => {
    if (!state.selectedLocalAid) return;
    refreshData();
    const newCount = state.messages.length;
    const newTs = newCount > 0 ? state.messages[newCount - 1].ts : 0;
    if (newCount !== lastMsgCount || newTs !== lastMsgTs) {
      lastMsgCount = newCount;
      lastMsgTs = newTs;
      render();
    }
  }, 5000);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
  }

  // Keep process alive
  await new Promise<void>(() => {});
}

import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolvePaths, getPackageRoot } from '../paths.js';
import { decodeDirSegment, readAllJsonlLines } from '../core/session/session-fs-store.js';

// ==================== Types ====================

interface MessageLogEntry {
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
}

interface PeerInfo {
  peerId: string;
  peerName: string | null;
  inbound: number;
  outbound: number;
  lastAt: number;
}

interface AidInfo {
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

function formatTimeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
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

function getSessionsAunDir(): string {
  const p = resolvePaths();
  return path.join(p.sessionsDir, 'aun');
}

function listLocalAids(aunDir: string): string[] {
  try {
    return fs.readdirSync(aunDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => decodeDirSegment(e.name));
  } catch { return []; }
}

function listPeers(aunDir: string, localAid: string): string[] {
  const aidDir = path.join(aunDir, encodeSegment(localAid));
  try {
    return fs.readdirSync(aidDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => decodeDirSegment(e.name));
  } catch { return []; }
}

function readMessages(aunDir: string, localAid: string, peerId: string): MessageLogEntry[] {
  const msgPath = path.join(aunDir, encodeSegment(localAid), encodeSegment(peerId), 'messages.jsonl');
  return readAllJsonlLines<MessageLogEntry>(msgPath);
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

function loadAidInfo(aunDir: string, aid: string): AidInfo {
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

function loadPeerInfos(aunDir: string, localAid: string): PeerInfo[] {
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

function loadAllMessages(aunDir: string, localAid: string): MessageLogEntry[] {
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
  const title = `${DIM}─ Messages ─${RST}`;
  lines.push(padRight(title, width));

  const contentHeight = height - 1;
  const msgs = state.messages;
  const totalMsgs = msgs.length;
  const visibleCount = contentHeight;
  const startIdx = Math.max(0, totalMsgs - visibleCount - state.messageScrollOffset);
  const endIdx = Math.min(totalMsgs, startIdx + visibleCount);
  const scrollbar = renderScrollbar(totalMsgs, visibleCount, state.messageScrollOffset, contentHeight);

  const msgWidth = width - 3;
  for (let i = startIdx; i < endIdx; i++) {
    const m = msgs[i];
    const time = formatDateTime(m.ts);
    const dir = m.dir === 'in' ? `${GREEN}↓${RST}` : `${BLUE}↑${RST}`;
    const from = shortAid(m.from);
    const to = shortAid(m.to);
    const header = `${DIM}${time}${RST} ${dir} ${ORANGE}${from}${RST}${DIM}→${RST}${GREEN}${to}${RST}`;
    const headerLine = padRight(header, msgWidth);
    const sbIdx = lines.length - 1;
    lines.push(`${headerLine} ${scrollbar[sbIdx] || ' '}`);

    if (lines.length - 1 < contentHeight) {
      const content = truncate(m.content.replace(/\n/g, ' '), msgWidth - 2);
      const contentLine = padRight(`  ${content}`, msgWidth);
      const sbIdx2 = lines.length - 1;
      lines.push(`${contentLine} ${scrollbar[sbIdx2] || ' '}`);
    }
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
  const rows = (process.stdout.rows || 40) - 3;

  const leftW = Math.max(20, Math.floor(cols * 0.20));
  const midW = Math.max(24, Math.floor(cols * 0.22));
  const rightW = Math.max(40, cols - leftW - midW - 4);
  const bodyHeight = rows - 2;

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

  const pkgRoot = getPackageRoot();
  const helpLine = `${DIM}│ Tab: panel  ↑↓: nav  Enter: select  Backspace: back  ESC: exit  ${pkgRoot}${RST}`;
  buf += `\x1b[2K${helpLine}\n`;
  const closeBorder = `${DIM}└${'─'.repeat(cols - 2)}┘${RST}`;
  buf += `\x1b[2K${closeBorder}\n`;

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
    if (state.selectedPeer) {
      state.messages = readMessages(aunDir, state.selectedLocalAid, state.selectedPeer);
      if (state.messages.length > 1000) state.messages = state.messages.slice(-1000);
    } else {
      state.messages = loadAllMessages(aunDir, state.selectedLocalAid);
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

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKey);
  }

  // Keep process alive
  await new Promise<void>(() => {});
}

/* EvolClaw Watch — 前端 WS 客户端 + 三 tab 渲染 */

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'ecWatchToken';
const LANG_KEY = 'ecWatchLang';

// ── 国际化 (i18n) ──
const translations = {
  'zh-CN': {
    'tab.agents': 'Agents',
    'tab.messages': 'Messages',
    'tab.sessions': 'Sessions',
    'tab.triggers': 'Triggers',
    'tab.cache': 'Cache',
    'tab.system': 'System',
    'tab.gateway': 'AgentGateway',
    'tab.usage': 'Usage',
    'tab.monitor': 'Monitor',
    'status.connecting': '连接中…',
    'status.connected': '已连接',
    'status.disconnected': '已断开',
    'action.logout': '退出',
  },
  'en-US': {
    'tab.agents': 'Agents',
    'tab.messages': 'Messages',
    'tab.sessions': 'Sessions',
    'tab.triggers': 'Triggers',
    'tab.cache': 'Cache',
    'tab.system': 'System',
    'tab.gateway': 'AgentGateway',
    'tab.usage': 'Usage',
    'tab.monitor': 'Monitor',
    'status.connecting': 'Connecting…',
    'status.connected': 'Connected',
    'status.disconnected': 'Disconnected',
    'action.logout': 'Logout',
  }
};

let currentLang = localStorage.getItem(LANG_KEY) || 'zh-CN';

function t(key) {
  return translations[currentLang]?.[key] || key;
}

function updateI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = text;
    } else if (el.hasAttribute('title')) {
      el.title = text;
    } else {
      el.textContent = text;
    }
  });
}

function toggleLang() {
  currentLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
  localStorage.setItem(LANG_KEY, currentLang);
  updateI18n();
}

// ── 基础路径 ──
// 本地直连时页面在 "/"，经 AUN Service Proxy 时页面在 "/ecweb/"。
// 取当前页面所在目录（含尾斜杠）作为所有 API/WS 的前缀，使绝对路径在两种
// 部署下都正确（proxy-server 用首段路径选服务，前缀不能丢）。
const BASE = location.pathname.replace(/[^/]*$/, '');
const apiUrl = (p) => BASE + p.replace(/^\/+/, '');

// ── 配对 ──
async function pair(code) {
  const resp = await fetch(apiUrl('api/pair'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return resp.json();
}

// 本地直连免配对：用空码探测，服务端若判定本地直连会直接发 token。
// 远程（隧道/真远程）会返回配对码错误，此时回落到配对页。
async function tryLocalAutoPair() {
  try {
    const res = await pair('');
    if (res && res.ok && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token);
      return true;
    }
  } catch {}
  return false;
}

function showPairPage(hint) {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  $('#pair-page').style.display = 'flex';
  $('#app').style.display = 'none';
  if (hint) $('#pair-error').textContent = hint;
}
function showApp() {
  $('#pair-page').style.display = 'none';
  $('#app').style.display = 'flex';
  $('#pair-error').textContent = '';
}

function initPairUI() {
  const input = $('#pair-input');
  const btn = $('#pair-btn');
  const err = $('#pair-error');
  const submit = async () => {
    const code = input.value.trim();
    if (code.length !== 6) { err.textContent = '请输入 6 位配对码'; return; }
    btn.disabled = true; err.textContent = '';
    try {
      const res = await pair(code);
      if (res.ok) {
        localStorage.setItem(TOKEN_KEY, res.token);
        showApp();
        startApp();
      } else {
        err.textContent = res.reason || '配对失败';
      }
    } catch {
      err.textContent = '网络错误';
    } finally {
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  input.focus();
}

// ── WebSocket 客户端（自动重连）──
let ws = null;
let reconnectDelay = 1000;
let currentView = 'agents';
let pendingSub = null;        // 重连后要恢复的订阅
const state = { agents: null, msg: null, session: null, cache: null, system: null, triggers: null, monitor: null, gateway: null };

function setConnStatus(text, cls) {
  const el = $('#conn-status');
  el.textContent = text;
  el.className = 'conn-status' + (cls ? ' ' + cls : '');
}

function connect() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showPairPage(); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${BASE}ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    setConnStatus('● 已连接', 'ok');
    reconnectDelay = 1000;
    subscribe(currentView, pendingSub || {});
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'error') { console.warn('server error:', msg.message); return; }
    if (msg.type === 'menu.response') {
      const pend = _menuPending[msg.requestId];
      if (pend) { delete _menuPending[msg.requestId]; pend.resolve(msg.data); }
      return;
    }
    if (msg.type === 'snapshot' || msg.type === 'delta') {
      // system 视图保留客户端写入的 check/upgrade，防止 3s 轮询覆盖
      if (msg.view === 'system' && state.system) {
        state.system = {
          ...msg.data,
          check: state.system.check ?? msg.data.check,
          upgrade: state.system.upgrade ?? msg.data.upgrade,
        };
      } else {
        state[msg.view] = msg.data;
      }
      if (msg.view === currentView) renderView(currentView);
    }
  };

  ws.onclose = (ev) => {
    if (ev.code === 4001) {
      localStorage.removeItem(TOKEN_KEY);
      showPairPage('token 已失效，请重新配对');
      return;
    }
    setConnStatus('○ 重连中…', 'err');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

function subscribe(view, params) {
  pendingSub = params;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', view, ...params }));
  }
}

// ── Menu 写请求（update/action）：经 WS menu 消息，requestId 配对响应 ──
const _menuPending = {};
let _menuSeq = 0;
function menuSend(payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('未连接')); return; }
    const requestId = 'ecw-' + (++_menuSeq);
    const withId = { ...payload, id: payload.id || requestId };
    _menuPending[requestId] = { resolve, reject };
    setTimeout(() => {
      if (_menuPending[requestId]) { delete _menuPending[requestId]; reject(new Error('timeout')); }
    }, 6000);
    ws.send(JSON.stringify({ type: 'menu', requestId, payload: withId }));
  });
}

// 心跳
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}, 20000);

// ── Tab 切换 ──
let msgSel = { aid: null, peer: null };
let sessSel = { sessionId: null, project: null };
let trigSel = { agent: null };
let sessSearch = '';
let sessFilterNormal = false; // true=只显示有效会话（userMsgs >= 2）
let sessChatMode = false;   // false=完整视图，true=对话视图（折叠处理过程）
let monRange = '2m';        // Monitor 时间窗口：2m / 10m / 1h

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  // 切换时按当前选择恢复订阅
  if (view === 'msg') subscribe('msg', { aid: msgSel.aid, peer: msgSel.peer });
  else if (view === 'session') subscribe('session', { sessionId: sessSel.sessionId, project: sessSel.project });
  else if (view === 'cache') subscribe('cache', {});
  else if (view === 'system') subscribe('system', {});
  else if (view === 'triggers') subscribe('triggers', { agent: trigSel.agent });
  else if (view === 'monitor') subscribe('monitor', { range: monRange });
  else if (view === 'gateway') subscribe('gateway', {});
  else subscribe('agents', {});
  if (state[view]) renderView(view);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchView(tab.dataset.view);
  });
}

function renderView(view) {
  if (view === 'agents') renderAgents(state.agents);
  else if (view === 'msg') renderMsg(state.msg);
  else if (view === 'session') renderSession(state.session);
  else if (view === 'cache') renderCache(state.cache);
  else if (view === 'system') renderSystem(state.system);
  else if (view === 'triggers') renderTriggers(state.triggers);
  else if (view === 'monitor') renderMonitor(state.monitor);
  else if (view === 'gateway') renderGateway(state.gateway);
}

// ── 工具 ──
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function shortAid(aid) { return String(aid || '').split('.')[0]; }
function fmtBytes(b) {
  if (!b) return '0';
  const u = ['B', 'KB', 'MB', 'GB']; let i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + u[i];
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
// 秒数 → 可读时长（如 3d 2h / 5h 12m / 8m 3s）
function fmtDur(sec) {
  if (sec == null) return '—';
  const s = Math.floor(Number(sec) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sx = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sx}s`;
  return `${sx}s`;
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// semver 比较：-1 (a<b) / 0 / 1 (a>b)，剥离 pre-release 标签
function compareVer(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// ── Agents 视图（对齐终端 watch aid：状态点前置 + 名字为主 + 两行 + 工作态着色 + 顶部统计条）──

// 逐 AID 异步操作状态（取代全局 _agentBusy）：aid → 操作中的描述文字
const _agentOps = new Map(); // Map<aid, string>
let _agentBusy = false;  // 保留兼容旧引用，不再用于阻塞渲染
let _agSubtab = 'enabled'; // 'enabled' | 'disabled'

// 工作状态徽标：一旦收到过消息就不再回 connected。
// stopped → connected(仅首次连接无消息时) → idle(收到第一条后) → working → idle ...
function agentStateBadge(s, agStatus, connStatus) {
  if (agStatus === 'stopped' || connStatus === 'disconnected' || connStatus === 'failed')
    return '<span class="state-badge stopped">停止</span>';
  if (connStatus === 'reconnecting')
    return '<span class="state-badge stopped">重连中</span>';
  if ((s.processing || 0) > 0)
    return '<span class="state-badge working">working</span>';
  // 收到过消息 → 永远是 idle，不再回到 connected
  if ((s.messagesReceived || 0) > 0 || (s.messagesSent || 0) > 0)
    return '<span class="state-badge idle">idle</span>';
  return '<span class="state-badge connected">connected</span>';
}

// 发送方式图标标记
const MSG_KIND_META = { send: { icon: '💬', label: '回复' }, thought: { icon: '💭', label: '思考' }, inject: { icon: '📥', label: '注入' }, notify: { icon: '🔔', label: '通知' } };
// 消息详情流用：jsonl 持久化的 msgType 词汇（text 为普通回复，不另标）
const MSG_TYPE_META = { thought: { icon: '💭', label: '思考' }, image: { icon: '🖼️', label: '图片' }, file: { icon: '📎', label: '文件' }, command: { icon: '⌘', label: '命令' } };
function msgTagsHtml(kind, encrypt, chatmode, dir) {
  let h = '';
  // 'send' 仅出向才是「回复」；入向是用户输入，不打回复标记
  const km = (kind === 'send' && dir === 'in') ? null : MSG_KIND_META[kind];
  if (km) h += `<span class="mtag${kind === 'send' ? ' mtag-reply' : ''}">${km.icon}${km.label}</span>`;
  if (encrypt != null) h += `<span class="mtag">${encrypt ? '🔒密文' : '明文'}</span>`;
  if (chatmode) h += `<span class="mtag">${chatmode === 'proactive' ? '自主' : (chatmode === 'inject' ? '注入' : '响应')}</span>`;
  return h;
}

// 消息行：方向箭头 + 标记 + 对端 + 文字
function agentPreviewHtml(s) {
  const clip = (t) => esc(String(t).replace(/\n/g, ' ').slice(0, 80));
  const line = (dir, peer, text, kind, encrypt, chatmode) => {
    const arrow = dir === 'in' ? '<span class="arrow-in">↓</span>' : '<span class="arrow-out">↑</span>';
    const tags = msgTagsHtml(kind, encrypt, chatmode, dir);
    const peerHtml = peer ? `<span class="peer">${esc(shortAid(peer))}</span>: ` : '';
    const textCls = dir === 'in' ? 'text-in' : 'text-out';
    return `${arrow}${tags ? ' ' + tags + ' ' : ' '}${peerHtml}<span class="${textCls}">${clip(text)}</span>`;
  };
  if ((s.processing || 0) > 0 && s.lastReceivedText)
    return line('in', s.lastReceivedFrom, s.lastReceivedText, s.lastReceivedKind, s.lastReceivedEncrypt, s.lastReceivedChatmode);
  const recvTs = s.lastReceivedAt || 0, sentTs = s.lastSentAt || 0;
  if (!recvTs && !sentTs) return '';
  if (sentTs > recvTs && s.lastSentText)
    return line('out', s.lastSentTo, s.lastSentText, s.lastSentKind, s.lastSentEncrypt, s.lastSentChatmode);
  if (s.lastReceivedText)
    return line('in', s.lastReceivedFrom, s.lastReceivedText, s.lastReceivedKind, s.lastReceivedEncrypt, s.lastReceivedChatmode);
  return '';
}

// HTML tooltip（最近 N 轮）：时间 + 彩色箭头 + 方式 + 对端 + 文字
// 渲染为隐藏的内容持有节点（.msg-tip-src）；实际展示由 initMsgTipFloat 的浮层负责
function recentMsgTooltipHtml(recent) {
  if (!recent || !recent.length) return '';
  let h = '<div class="msg-tip-src">';
  for (const m of recent) {
    const rcls = m.dir === 'in' ? 'tip-row-in' : 'tip-row-out';
    const arrow = m.dir === 'in' ? '↓' : '↑';
    // 'send' 仅出向才是「回复」；入向是用户输入，不打回复标记
    const km = (m.kind === 'send' && m.dir === 'in') ? null : MSG_KIND_META[m.kind];
    const kh = km ? `<span class="tip-kind${m.kind === 'send' ? ' tip-kind-reply' : ''}">${km.icon}${km.label}</span>` : '';
    const enc = m.encrypt != null ? `<span class="tip-flag">${m.encrypt ? '🔒密文' : '明文'}</span>` : '';
    const mode = m.chatmode ? `<span class="tip-flag">${m.chatmode === 'proactive' ? '自主' : (m.chatmode === 'inject' ? '注入' : '响应')}</span>` : '';
    const peer = m.peer ? esc(shortAid(m.peer)) : '';
    const text = esc(String(m.text).replace(/\n/g, ' ').slice(0, 140));
    const time = m.ts ? `<span class="tip-time">${fmtTime(m.ts)}</span>` : '';
    h += `<div class="tip-row ${rcls}">${time}${arrow}${kh}${enc}${mode} <b>${peer}</b> ${text}</div>`;
  }
  return h + '</div>';
}

// 单例浮层 tooltip：固定定位、自动翻转上下、横向夹取，确保始终在可视区域内；
// 鼠标可移动到 tooltip 上而不消失（延迟隐藏 + 进入取消）。
function initMsgTipFloat() {
  if (initMsgTipFloat._done) return;
  initMsgTipFloat._done = true;

  let floatEl = null, hideTimer = null, curWrap = null;
  const GAP = 8, MARGIN = 8;

  function ensureFloat() {
    if (floatEl) return floatEl;
    floatEl = document.createElement('div');
    floatEl.id = 'msg-tip-float';
    floatEl.className = 'msg-tip';
    document.body.appendChild(floatEl);
    floatEl.addEventListener('mouseenter', cancelHide);
    floatEl.addEventListener('mouseleave', scheduleHide);
    return floatEl;
  }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function scheduleHide() { cancelHide(); hideTimer = setTimeout(hideNow, 180); }
  function hideNow() { cancelHide(); curWrap = null; if (floatEl) floatEl.classList.remove('show'); }

  function position(wrap) {
    const f = floatEl;
    const r = wrap.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const fw = f.offsetWidth, fh = f.offsetHeight;
    // 纵向：优先放上方；上方放不下则放下方；都放不下则在视口内夹取
    let top;
    if (r.top - GAP - fh >= MARGIN) top = r.top - GAP - fh;
    else if (r.bottom + GAP + fh <= vh - MARGIN) top = r.bottom + GAP;
    else top = Math.max(MARGIN, Math.min(vh - MARGIN - fh, r.top - GAP - fh));
    // 横向：对齐左缘，超出右界则左移，再夹取左界
    let left = r.left;
    if (left + fw > vw - MARGIN) left = vw - MARGIN - fw;
    if (left < MARGIN) left = MARGIN;
    f.style.top = Math.round(top) + 'px';
    f.style.left = Math.round(left) + 'px';
  }

  function show(wrap) {
    const src = wrap.querySelector('.msg-tip-src');
    if (!src || !src.innerHTML.trim()) return;
    const f = ensureFloat();
    cancelHide();
    if (curWrap !== wrap) { f.innerHTML = src.innerHTML; curWrap = wrap; }
    f.classList.add('show');
    position(wrap);
  }

  document.addEventListener('mouseover', (e) => {
    const wrap = e.target.closest && e.target.closest('.ag-msg-wrap');
    if (wrap) show(wrap);
  });
  document.addEventListener('mouseout', (e) => {
    const wrap = e.target.closest && e.target.closest('.ag-msg-wrap');
    if (!wrap) return;
    const to = e.relatedTarget;
    if (to && (wrap.contains(to) || (floatEl && floatEl.contains(to)))) return;
    scheduleHide();
  });
  // 滚动时隐藏，避免浮层与行脱节
  window.addEventListener('scroll', hideNow, true);
}

// 顶部统计条：Gateway / AIDs total·connected·offline / Messages ↓↑ / Traffic ↓↑ / Version·PID·Uptime
function agentsStatsBar(data, aids, stats) {
  const connected = aids.filter(a => (a.status || 'connected') === 'connected').length;
  const offline = aids.length - connected;
  let recv = 0, sent = 0, bin = 0, bout = 0;
  for (const s of stats) {
    recv += s.messagesReceived || 0; sent += s.messagesSent || 0;
    bin += s.bytesReceived || 0; bout += s.bytesSent || 0;
  }
  const gws = [...new Set(aids.filter(a => a.gatewayUrl).map(a => a.gatewayUrl))];
  const gw = gws.length ? gws.map(esc).join(', ') : '—';
  const st = data.status || {};
  const pid = st.pid != null ? st.pid : '—';
  const uptime = st.uptime != null ? fmtDur(st.uptime / 1000) : '—';
  const ver = data.version || '—';

  let h = '<div class="agents-stats">';
  h += `<span class="sg"><span class="sg-k">Gateway</span><span class="sg-gw">${gw}</span></span>`;
  h += `<span class="sg"><span class="sg-k">AIDs</span>${aids.length} total · <span class="num-on">${connected} 在线</span>` +
    `${offline ? ` · <span class="num-off">${offline} 离线</span>` : ''}</span>`;
  h += `<span class="sg"><span class="sg-k">Messages</span><span class="in">↓${recv}</span> <span class="out">↑${sent}</span></span>`;
  h += `<span class="sg"><span class="sg-k">Traffic</span><span class="in">↓${fmtBytes(bin)}</span> <span class="out">↑${fmtBytes(bout)}</span></span>`;
  h += `<span class="sg"><span class="sg-k">Version</span>${esc(ver)} · <span class="sg-k">PID</span>${pid} · <span class="sg-k">Uptime</span>${uptime}</span>`;
  h += '</div>';
  return h;
}

// 操作列 HTML（启用页）：停止/启动 + 清空队列(conditional) + ···(禁用/重载/编辑/md/删除)
function agentOpsHtml(aid, ag, s) {
  if (_agentOps.has(aid)) {
    return `<div class="agent-ops agent-ops-busy"><span class="ops-busy-label">${esc(_agentOps.get(aid) || '操作中…')}</span></div>`;
  }
  const queued = s.queued || 0;
  const running = ag.status === 'running';
  let h = `<div class="agent-ops" data-aid="${esc(aid)}" data-status="${esc(ag.status)}">`;
  if (running) h += `<button class="ctrl-btn ops-stop" data-op="stop">停止</button>`;
  else         h += `<button class="ctrl-btn ops-start" data-op="start">启动</button>`;
  if (queued > 0) h += `<button class="ctrl-btn ops-clear-queue" data-op="clear-queue" title="清空 ${queued} 条待处理消息">清空队列</button>`;
  h += `<div class="ops-more"><button class="ctrl-btn ops-more-btn" data-op="more">···</button>` +
    `<div class="ops-dropdown">` +
    `<button class="ops-dd-item" data-op="toggle">禁用</button>` +
    `<button class="ops-dd-item" data-op="reload">重载配置</button>` +
    `<button class="ops-dd-item" data-op="edit">编辑配置</button>` +
    `<a class="ops-dd-item" href="https://${esc(aid)}/agent.md" target="_blank" rel="noopener">查看 agent.md ↗</a>` +
    `<button class="ops-dd-item danger" data-op="delete">删除 Agent</button>` +
    `</div></div>`;
  h += '</div>';
  return h;
}

function renderAgents(data) {
  const el = $('#view-agents');
  if (!data) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (el.querySelector('.ops-more.open')) return;

  const allAgents = data.agents || [];
  const aids = data.aids || [];
  const statsByAid = {};
  for (const s of (data.stats || [])) statsByAid[s.aid] = s;
  const aidConnByAid = {};
  for (const a of aids) aidConnByAid[a.aid] = a;

  const enabledCount = allAgents.filter(ag => ag.status !== 'disabled').length;
  const disabledCount = allAgents.filter(ag => ag.status === 'disabled').length;

  // 子标签栏
  let html = '<div class="agents-toolbar">' +
    `<div class="ag-subtabs">` +
    `<button class="ag-subtab${_agSubtab === 'enabled' ? ' active' : ''}" data-subtab="enabled">启用 (${enabledCount})</button>` +
    `<button class="ag-subtab${_agSubtab === 'disabled' ? ' active' : ''}" data-subtab="disabled">禁用 (${disabledCount})</button>` +
    `</div>` +
    `<button class="ctrl-btn" id="agent-new-btn">+ 新建</button>` +
    '</div>';

  if (!data.daemonRunning) {
    html += '<div class="banner">⚠ EvolClaw 主进程未运行，仅显示最近活动记录</div>';
  }

  if (_agSubtab === 'disabled') {
    const disabledAgents = allAgents.filter(ag => ag.status === 'disabled');
    if (!disabledAgents.length) {
      html += '<div class="empty">暂无禁用 Agent</div>';
    } else {
      html += '<table><thead><tr><th>Agent</th><th>项目路径</th><th>操作</th></tr></thead><tbody>';
      for (const ag of disabledAgents) {
        const busy = _agentOps.has(ag.aid);
        const ops = busy
          ? `<div class="agent-ops agent-ops-busy"><span class="ops-busy-label">${esc(_agentOps.get(ag.aid) || '操作中…')}</span></div>`
          : `<div class="agent-ops" data-aid="${esc(ag.aid)}" data-status="disabled"><button class="ctrl-btn ops-enable" data-op="toggle">启用</button></div>`;
        html += `<tr class="ag-main">` +
          `<td><div class="ag-id"><span class="dot off"></span><span class="ag-id-text"><span class="ag-name">${esc(ag.displayName || shortAid(ag.aid))}</span><span class="ag-aid">${esc(ag.aid)}</span></span></div></td>` +
          `<td style="font-size:11px;font-family:monospace">${esc(ag.projectPath || '—')}</td>` +
          `<td class="agent-ops-cell">${ops}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    el.innerHTML = html;
    bindAgentsEvents(el);
    return;
  }

  // ── 启用页 ──
  // 按收发消息总数降序排序（活跃的排前面）
  const totalMsgs = (ag) => {
    const s = statsByAid[ag.aid] || {};
    return (s.messagesReceived || 0) + (s.messagesSent || 0);
  };
  const enabledAgents = allAgents.filter(ag => ag.status !== 'disabled')
    .sort((a, b) => totalMsgs(b) - totalMsgs(a));
  if (!enabledAgents.length) {
    html += '<div class="empty">暂无启用 Agent</div>';
    el.innerHTML = html;
    bindAgentsEvents(el);
    return;
  }

  html += '<table><thead><tr>' +
    '<th>AID</th><th>工作</th><th>队列</th><th>模型</th><th>运行</th><th>收</th><th>发</th>' +
    '<th>入字节</th><th>出字节</th><th>对端数量</th><th>最后活动</th><th>操作</th>' +
    '</tr></thead><tbody>';

  for (const ag of enabledAgents) {
    const s = statsByAid[ag.aid] || {};
    const conn = aidConnByAid[ag.aid] || {};
    const connStatus = conn.status || (ag.status === 'running' ? 'connected' : 'disconnected');
    const dotCls = connStatus === 'connected' ? 'on' : (connStatus === 'reconnecting' ? 'idle' : 'off');
    const name = s.selfName || ag.displayName || shortAid(ag.aid);
    const uptime = (connStatus === 'connected' && conn.lastConnectedAt) ? fmtDur((Date.now() - conn.lastConnectedAt) / 1000) : '—';
    const lastTs = Math.max(s.lastReceivedAt || 0, s.lastSentAt || 0, ag.lastActivity || 0);
    const preview = agentPreviewHtml(s);
    // 队列数：不含正在处理的那条
    const rawQueued = s.queued || 0;
    const queued = rawQueued;
    const queueCell = queued > 0 ? `<span class="ag-queue-num">${queued}</span>` : '<span style="color:var(--dim)">0</span>';
    const model = ag.model || ag.baseagent || '—';

    const idCell = `<div class="ag-id"><span class="dot ${dotCls}" title="${esc(connStatus)}"></span>` +
      `<span class="ag-id-text"><span class="ag-name">${esc(name)}</span>` +
      `<span class="ag-aid">${esc(ag.aid)}</span></span></div>`;

    html += `<tr class="ag-main">` +
      `<td>${idCell}</td>` +
      `<td>${agentStateBadge(s, ag.status, connStatus)}</td>` +
      `<td>${queueCell}</td>` +
      `<td style="font-size:11px;color:var(--dim)">${esc(model)}</td>` +
      `<td>${uptime}</td>` +
      `<td>${s.messagesReceived ?? 0}</td><td>${s.messagesSent ?? 0}</td>` +
      `<td>${fmtBytes(s.bytesReceived)}</td><td>${fmtBytes(s.bytesSent)}</td>` +
      `<td>${s.uniquePeerCount ?? conn.peerCount ?? 0}</td>` +
      `<td>${fmtAgo(lastTs)}</td>` +
      `<td class="agent-ops-cell">${agentOpsHtml(ag.aid, ag, s)}</td>` +
      '</tr>';
    // 自定义 tooltip（HTML，hover 显示）
    const recent = (s.recentMessages || []);
    const tipHtml = recentMsgTooltipHtml(recent);

    html += `<tr class="ag-sub"><td colspan="12"><div class="ag-info">` +
      (ag.projectPath ? `<div class="ag-path">${esc(ag.projectPath)}</div>` : '') +
      (preview ? `<div class="ag-msg-wrap">${tipHtml}<div class="ag-msg">${preview}</div></div>` : '') +
      '</div></td></tr>';
  }
  html += '</tbody></table>';
  if (data.daemonRunning) {
    html += agentsStatsBar(data, aids, data.stats || []);
  }
  el.innerHTML = html;
  bindAgentsEvents(el);
}

// ── Cache 视图（daemon 统一 FileCache 运行统计）──
// fmtNum 复用文件内既有定义（千分位缩写）。
function hitRate(c) {
  const denom = (c.hits || 0) + (c.misses || 0);
  return denom ? (c.hits / denom) : null;
}
function fmtPct(r) {
  if (r == null) return '—';
  return (r * 100).toFixed(1) + '%';
}
function rateCls(r) {
  if (r == null) return '';
  if (r >= 0.9) return 'on';
  if (r >= 0.6) return 'idle';
  return 'off';
}
// group 名按用途归类，给出友好标签：config:<aid> / agent-files:<aid> 提取 aid
function groupLabel(g) {
  if (g.startsWith('agent-files:')) return { kind: 'agent', label: shortAid(g.slice('agent-files:'.length)), sub: '身份层' };
  if (g.startsWith('config:')) return { kind: 'agent', label: shortAid(g.slice('config:'.length)), sub: 'config' };
  if (g === 'config') return { kind: 'global', label: 'defaults', sub: '全局' };
  if (g === 'relation-prefs') return { kind: 'relation', label: 'relation-prefs', sub: '关系模型偏好' };
  if (g === 'kits') return { kind: 'kits', label: 'kits', sub: 'manifest/fragment/md' };
  return { kind: 'other', label: g, sub: '' };
}

function renderCache(data) {
  const el = $('#view-cache');
  if (!data) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (!data.daemonRunning) {
    el.innerHTML = '<div class="banner">⚠ EvolClaw 主进程未运行，无缓存统计可显示</div>';
    return;
  }
  if (!data.supported || !data.stats) {
    el.innerHTML = '<div class="banner">⚠ 当前 EvolClaw 版本不支持 cache-stats（请升级 daemon）</div>';
    return;
  }
  const s = data.stats;
  const t = s.totals;
  const occ = s.occupancy || {};
  // 全部组占用合计
  let totalBytes = 0;
  for (const g in occ) totalBytes += occ[g].bytes || 0;

  let html = '';

  // ① 总览卡片
  const rate = hitRate(t);
  html += '<div class="cache-cards">';
  html += card('命中率', fmtPct(rate), rateCls(rate), `${fmtNum(t.hits)} 命中 / ${fmtNum(t.misses)} 未命中`);
  html += card('读取总数', fmtNum(t.gets), '', `${fmtNum(t.hits)} hit · ${fmtNum(t.misses)} miss`);
  html += card('缓存条目', fmtNum(s.size), '', fmtBytes(totalBytes) + ' 近似内存');
  html += card('stat 检查', fmtNum(t.statChecks), '', 'mtime 策略每读一次');
  html += card('重读', fmtNum(t.reReads), '', '带外改后自动重读');
  html += card('驱逐', fmtNum(t.evictions), t.evictions ? 'idle' : '', 'LRU 超限');
  html += card('失效', fmtNum(t.invalidations), '', 'reload/单刷清除');
  html += card('统计起始', fmtAgo(s.since) + ' 前', '', fmtTime(s.since));
  html += '</div>';

  // ② 按 group 表（每组命中率 + 占用 + 容量水位）
  html += '<h3 class="cache-h">按缓存组</h3>';
  html += '<table><thead><tr>' +
    '<th>组</th><th>类型</th><th>读取</th><th>命中</th><th>未命中</th><th>命中率</th>' +
    '<th>重读</th><th>驱逐</th><th>条目</th><th>内存</th><th>容量</th>' +
    '</tr></thead><tbody>';
  const groups = Object.keys(s.byGroup).sort((a, b) => (s.byGroup[b].gets || 0) - (s.byGroup[a].gets || 0));
  for (const g of groups) {
    const c = s.byGroup[g];
    const o = occ[g] || { size: 0, bytes: 0, cap: null };
    const gl = groupLabel(g);
    const r = hitRate(c);
    let capCell = '—';
    if (o.cap != null) {
      const pct = o.cap ? Math.round((o.size / o.cap) * 100) : 0;
      const cls = pct >= 90 ? 'off' : (pct >= 70 ? 'idle' : 'on');
      capCell = `<span class="dot ${cls}"></span>${o.size}/${o.cap}`;
    }
    html += '<tr>' +
      `<td>${esc(gl.label)}${gl.sub ? ` <span style="color:var(--dim)">${esc(gl.sub)}</span>` : ''}</td>` +
      `<td><span class="tag tag-${gl.kind}">${esc(gl.kind)}</span></td>` +
      `<td>${fmtNum(c.gets)}</td><td>${fmtNum(c.hits)}</td><td>${fmtNum(c.misses)}</td>` +
      `<td><span class="dot ${rateCls(r)}"></span>${fmtPct(r)}</td>` +
      `<td>${fmtNum(c.reReads)}</td><td>${fmtNum(c.evictions)}</td>` +
      `<td>${o.size}</td><td>${fmtBytes(o.bytes)}</td><td>${capCell}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';

  // ③ 按 policy 表
  html += '<h3 class="cache-h">按策略</h3>';
  html += '<table><thead><tr>' +
    '<th>策略</th><th>读取</th><th>命中</th><th>未命中</th><th>命中率</th><th>stat 检查</th><th>重读</th>' +
    '</tr></thead><tbody>';
  const POLICY_DESC = { 'on-reload': '靠 reload 刷新，平时零检查', 'manual': '显式单刷', 'mtime': '每读 statSync 门控' };
  for (const pol of ['on-reload', 'mtime', 'manual']) {
    const c = s.byPolicy[pol];
    if (!c || !c.gets) continue;
    const r = hitRate(c);
    html += '<tr>' +
      `<td>${esc(pol)} <span style="color:var(--dim)">${esc(POLICY_DESC[pol] || '')}</span></td>` +
      `<td>${fmtNum(c.gets)}</td><td>${fmtNum(c.hits)}</td><td>${fmtNum(c.misses)}</td>` +
      `<td><span class="dot ${rateCls(r)}"></span>${fmtPct(r)}</td>` +
      `<td>${fmtNum(c.statChecks)}</td><td>${fmtNum(c.reReads)}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';

  html += '<div class="cache-note">注：config/defaults 与关系级 preferences 的读取也已并入本统计；' +
    '渲染后结果（按 vars）不缓存，故不在此列。</div>';

  el.innerHTML = html;
}

function card(label, value, valCls, sub) {
  return `<div class="cache-card">` +
    `<div class="cc-label">${esc(label)}</div>` +
    `<div class="cc-value ${valCls || ''}">${esc(value)}</div>` +
    `<div class="cc-sub">${esc(sub || '')}</div>` +
    `</div>`;
}

// ── Messages 视图 ──
function renderMsg(data) {
  if (!data) return;
  const aids = data.aids || [];
  const peers = data.peers || [];
  const messages = data.messages || [];

  // 左：AID 列表
  let aidsHtml = '<div class="col-title">AID</div>';
  for (const a of aids) {
    const sel = a.aid === msgSel.aid ? ' sel' : '';
    aidsHtml += `<div class="list-item${sel}" data-aid="${esc(a.aid)}">` +
      `<div class="name">${esc(shortAid(a.aid))}</div>` +
      `<div class="sub">↓${a.totalIn} ↑${a.totalOut} · ${a.peerCount} peers</div></div>`;
  }
  $('#msg-aids').innerHTML = aidsHtml;
  $('#msg-aids').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { msgSel = { aid: item.dataset.aid, peer: null }; subscribe('msg', msgSel); };
  });

  // 中：对端列表
  let peersHtml = '<div class="col-title">Peers</div>';
  if (msgSel.aid) {
    const allSel = msgSel.peer === null ? ' sel' : '';
    peersHtml += `<div class="list-item${allSel}" data-peer=""><div class="name">All</div>` +
      `<div class="sub">${peers.length} peers</div></div>`;
    for (const p of peers) {
      const sel = p.peerId === msgSel.peer ? ' sel' : '';
      peersHtml += `<div class="list-item${sel}" data-peer="${esc(p.peerId)}">` +
        `<div class="name">${esc(p.peerName || shortAid(p.peerId))}</div>` +
        `<div class="sub">↓${p.inbound} ↑${p.outbound} · ${fmtAgo(p.lastAt)}</div></div>`;
    }
  } else {
    peersHtml += '<div class="empty">← 选择一个 AID</div>';
  }
  $('#msg-peers').innerHTML = peersHtml;
  $('#msg-peers').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { msgSel = { aid: msgSel.aid, peer: item.dataset.peer || null }; subscribe('msg', msgSel); };
  });

  // 右：消息流
  const stream = $('#msg-stream');
  if (!msgSel.aid) { stream.innerHTML = '<div class="empty">选择 AID 查看消息</div>'; return; }
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
  let msgHtml = '';
  for (const m of messages) {
    const cls = m.dir === 'in' ? 'in' : 'out';
    const arrow = m.dir === 'in' ? '↓' : '↑';
    const from = shortAid(m.from), to = shortAid(m.to);
    const tags = [];
    if (m.chatType === 'group') tags.push('群聊');
    // 消息详情流的 kind 来自 jsonl 的 msgType（text/thought/image/file/command），
    // 与 agents 页内存态的 MsgKind（send/thought/inject/notify）不是同一套词汇。
    const mt = MSG_TYPE_META[m.msgType];
    if (mt) tags.push(`${mt.icon}${mt.label}`);
    if (m.encrypt != null) tags.push(m.encrypt ? '🔒密文' : '明文');
    if (m.chatmode) tags.push(m.chatmode === 'proactive' ? '自主' : (m.chatmode === 'inject' ? '注入' : '响应'));
    const tagHtml = tags.map(t => `<span class="tag">${esc(t)}</span>`).join('');
    msgHtml += `<div class="bubble ${cls}">` +
      `<div class="meta">${fmtTime(m.ts)} ${arrow} ${esc(from)}→${esc(to)}${tagHtml}</div>` +
      `<div class="body">${esc(m.content)}</div></div>`;
  }
  stream.innerHTML = msgHtml || '<div class="empty">暂无消息</div>';
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

// ── Sessions 视图 ──
function renderSession(data) {
  if (!data) return;
  const projects = data.projects || [];
  const transcripts = data.transcripts || [];
  const turns = data.turns || [];
  // 项目选择：用户显式选过就以本地状态为准（避免 stale snapshot 把下拉拨回去）；
  // 否则跟随服务端解析出的默认项目。
  if (!sessSel.project) sessSel.project = data.project || null;
  // 若本次 snapshot 不是当前选中项目的数据（stale），忽略其列表，等正确的回来
  if (sessSel.project && data.project && data.project !== sessSel.project) {
    return;
  }

  // 搜索过滤
  const q = sessSearch.trim().toLowerCase();
  const filtered = transcripts
    .filter(t => !sessFilterNormal || (t.userMsgs || 0) >= 2)
    .filter(t => !q || (t.title || '').toLowerCase().includes(q) || (t.firstUser || '').toLowerCase().includes(q));

  // 左栏：过滤条 + 列表
  const projOpts = projects.map(p =>
    `<option value="${esc(p.encoded)}"${p.encoded === sessSel.project ? ' selected' : ''}>${esc(p.label)} (${p.count})</option>`
  ).join('');
  const normalCount = transcripts.filter(t => (t.userMsgs || 0) >= 2).length;
  let listHtml = '<div class="sess-filter">' +
    `<select id="sess-project">${projOpts}</select>` +
    `<input id="sess-search" type="text" placeholder="搜索标题/首条消息…" value="${esc(sessSearch)}">` +
    `<button id="sess-filter-btn" class="ctrl-btn${sessFilterNormal ? ' active' : ''}" title="只显示有效会话（≥2 条用户消息）">有效 ${normalCount}</button>` +
    `<div class="sess-count">${filtered.length} / ${transcripts.length} 个会话</div></div>` +
    '<div class="sess-items">';

  if (!filtered.length) {
    listHtml += '<div class="empty">' + (transcripts.length ? '无匹配会话' : '该项目暂无会话') + '</div>';
  }
  for (const t of filtered) {
    const sel = t.id === sessSel.sessionId ? ' sel' : '';
    const title = t.title || t.firstUser || t.id.slice(0, 8);
    let badge = '';
    if (t.bound) {
      const dot = t.online ? '<span class="dot on"></span>' : '<span class="dot idle"></span>';
      badge = `<span class="bind-badge">${dot}${esc(t.boundChannel || '')}·${esc(shortAid(t.boundPeer || ''))}</span>`;
    }
    const msgs = `<span class="msg-count" title="用户输入 ${t.userMsgs || 0} 条 / 共 ${t.totalMsgs || 0} 条消息">💬 ${t.userMsgs || 0}/${t.totalMsgs || 0}</span>`;
    listHtml += `<div class="list-item${sel}" data-sid="${esc(t.id)}">` +
      `<div class="name">${esc(title)}</div>` +
      `<div class="sub">${fmtAgo(t.lastActivity)} · ${msgs}${t.gitBranch ? ' · ' + esc(t.gitBranch) : ''}${badge}</div>` +
      '</div>';
  }
  listHtml += '</div>';
  $('#sess-list').innerHTML = listHtml;

  // 绑定交互（注意保持搜索框焦点）
  const projSel = $('#sess-project');
  if (projSel) projSel.onchange = () => {
    sessSel = { sessionId: null, project: projSel.value };
    sessSearch = '';
    subscribe('session', { project: sessSel.project });
  };
  const filterBtn = $('#sess-filter-btn');
  if (filterBtn) filterBtn.onclick = () => { sessFilterNormal = !sessFilterNormal; renderSession(state.session); };
  const searchEl = $('#sess-search');
  if (searchEl) {
    searchEl.oninput = () => { sessSearch = searchEl.value; renderSession(state.session); };
    if (q) { searchEl.focus(); searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length); }
  }
  $('#sess-list').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { sessSel = { sessionId: item.dataset.sid, project: sessSel.project }; subscribe('session', sessSel); };
  });

  // 右：transcript 详情
  const detail = $('#sess-detail');
  if (!sessSel.sessionId) { detail.innerHTML = '<div class="empty">选择会话查看 CC 日志</div>'; return; }
  if (!turns.length) { detail.innerHTML = '<div class="empty">该会话暂无内容</div>'; return; }
  const h = data.header || {};
  const atBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 60;
  let html = renderSessHeader(h);
  // 视图切换工具条
  html += '<div class="sess-toolbar">' +
    `<button class="view-toggle${sessChatMode ? ' active' : ''}" id="chat-toggle">` +
    `${sessChatMode ? '💬 对话视图' : '📜 完整视图'}</button>` +
    `<span class="toolbar-hint">${sessChatMode ? '只看用户与 Agent 的对话，处理过程已折叠' : '显示全部消息'}</span>` +
    '</div>';
  html += '<div class="turn-list">' + (sessChatMode ? renderChatView(turns) : renderFullView(turns)) + '</div>';
  detail.innerHTML = html;

  const toggle = $('#chat-toggle');
  if (toggle) toggle.onclick = () => { sessChatMode = !sessChatMode; renderSession(state.session); };
  if (atBottom) detail.scrollTop = detail.scrollHeight;
}

// 完整视图：所有轮次按 4 类渲染
function renderFullView(turns) {
  let html = '';
  for (const t of turns) {
    const cat = t.category || t.role;
    const c = CAT_META[cat] || CAT_META.system;
    const usage = (t.inputTokens || t.outputTokens)
      ? `<span class="turn-usage">${esc(t.model || '')} · in ${t.inputTokens || 0} / out ${t.outputTokens || 0}</span>` : '';
    html += `<div class="turn cat-${cat}">` +
      `<div class="turn-head"><span class="turn-role">${c.icon} ${c.label}</span>` +
      `<span class="turn-time">${t.ts ? fmtTime(t.ts) : ''}</span>${usage}</div>` +
      `<div class="turn-blocks">${renderBlocks(t.blocks || [])}</div></div>`;
  }
  return html;
}

// 对话视图：仿微信。只显示用户输入(左) + ec msg send 发出的消息(右)，
// 其余连续的处理过程折叠成一个可展开的「处理过程」分隔条。
function renderChatView(turns) {
  // 先把 turns 摊平成「对话项」与「处理项」的线性序列
  const items = [];  // {type:'in'|'out'|'proc', ...}
  for (const t of turns) {
    if (t.category === 'user_input') {
      const text = (t.blocks || []).filter(b => b.kind === 'text').map(b => b.text).join('\n');
      items.push({ type: 'in', text, ts: t.ts });
      continue;
    }
    // 找该轮里的 ec msg send 发送块（可能多条）
    const sends = (t.blocks || []).filter(b => b.kind === 'tool_use' && b.chat);
    if (sends.length) {
      for (const s of sends) items.push({ type: 'out', text: s.chat.text, peer: s.chat.peer, self: s.chat.self, ts: t.ts });
    }
    // 该轮里非对话的内容 → 处理过程（含思考/其他工具/结果/模型纯文本）
    const procBlocks = (t.blocks || []).filter(b => !(b.kind === 'tool_use' && b.chat));
    if (procBlocks.length && !(t.category === 'user_input')) {
      items.push({ type: 'proc', cat: t.category, blocks: procBlocks, ts: t.ts });
    }
  }

  // 合并连续的 proc 项为一组，渲染成可折叠分隔条
  let html = '';
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.type === 'in') {
      html += `<div class="chat-row in"><div class="chat-bubble">${esc(it.text)}</div>` +
        `<div class="chat-time">${it.ts ? fmtTime(it.ts) : ''}</div></div>`;
      i++;
    } else if (it.type === 'out') {
      const peer = it.peer ? shortAid(it.peer) : '';
      html += `<div class="chat-row out"><div class="chat-bubble">${esc(it.text)}</div>` +
        `<div class="chat-time">${it.ts ? fmtTime(it.ts) : ''}${peer ? ' → ' + esc(peer) : ''}</div></div>`;
      i++;
    } else {
      // 收集连续 proc
      const group = [];
      while (i < items.length && items[i].type === 'proc') { group.push(items[i]); i++; }
      let inner = '';
      for (const g of group) {
        const c = CAT_META[g.cat] || CAT_META.system;
        inner += `<div class="turn cat-${g.cat}"><div class="turn-head"><span class="turn-role">${c.icon} ${c.label}</span>` +
          `<span class="turn-time">${g.ts ? fmtTime(g.ts) : ''}</span></div>` +
          `<div class="turn-blocks">${renderBlocks(g.blocks)}</div></div>`;
      }
      html += `<details class="proc-group"><summary>⋯ ${group.length} 条处理过程（思考·工具·结果）</summary><div class="proc-body">${inner}</div></details>`;
    }
  }
  if (!html) html = '<div class="empty">该会话没有用户对话消息</div>';
  return html;
}

// 类别展示元数据
const CAT_META = {
  user_input:   { label: '用户输入', icon: '🟢' },
  model_output: { label: '模型输出', icon: '🔵' },
  tool_call:    { label: '工具调用', icon: '🟣' },
  tool_result:  { label: '工具结果', icon: '🟠' },
  msg_send:     { label: '发送消息', icon: '📤' },
  system:       { label: '系统', icon: '⚪' },
};

function renderSessHeader(h) {
  if (!h || !h.sessionId) return '';
  const title = h.title || h.sessionId.slice(0, 8);
  const tok = (h.inputTokens || h.outputTokens)
    ? `<span class="sh-stat">🔢 in ${fmtNum(h.inputTokens)} / out ${fmtNum(h.outputTokens)}</span>` : '';
  const ctx = h.contextTokens
    ? `<span class="sh-stat" title="最后一轮喂给模型的完整上下文大小">📐 ${fmtNum(h.contextTokens)} ctx</span>` : '';
  const cost = h.costUsd != null && h.costUsd > 0
    ? `<span class="sh-stat" title="累计费用（按模型定价估算）">💰 $${h.costUsd < 0.01 ? h.costUsd.toFixed(4) : h.costUsd.toFixed(2)}</span>` : '';
  let bind = '';
  if (h.bound) {
    const dot = h.online ? '<span class="dot on"></span>在线' : '<span class="dot idle"></span>离线';
    bind = `<span class="sh-stat">🔗 ${esc(h.boundChannel || '')} · ${esc(shortAid(h.boundPeer || ''))} ${dot}</span>`;
  }
  return '<div class="sess-header">' +
    `<div class="sh-title">${esc(title)}</div>` +
    '<div class="sh-stats">' +
    `<span class="sh-stat" title="用户输入 ${h.userMsgs || 0} 条 / 共 ${h.totalMsgs || 0} 条消息">💬 ${h.userMsgs || 0}/${h.totalMsgs || 0} 条</span>` +
    (h.model ? `<span class="sh-stat">🤖 ${esc(h.model)}</span>` : '') +
    tok + ctx + cost +
    (h.gitBranch ? `<span class="sh-stat">🌿 ${esc(h.gitBranch)}</span>` : '') +
    (h.version ? `<span class="sh-stat">cc ${esc(h.version)}</span>` : '') +
    bind +
    '</div>' +
    renderCatBar(h.counts) +
    `<div class="sh-path" title="${esc(h.cwd || '')}">${esc(h.cwd || '')}</div>` +
    '</div>';
}

function renderCatBar(counts) {
  if (!counts) return '';
  const items = [
    ['user_input', counts.userInput],
    ['model_output', counts.modelOutput],
    ['tool_call', counts.toolCall],
    ['tool_result', counts.toolResult],
    ['msg_send', counts.msgSend],
  ];
  let s = '<div class="sh-cats">';
  for (const [cat, n] of items) {
    const m = CAT_META[cat];
    s += `<span class="cat-chip cat-${cat}"><span class="cat-swatch"></span>${m.label} ${n || 0}</span>`;
  }
  return s + '</div>';
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const TOOL_ICONS = {
  Read: '📄', Write: '✏️', Edit: '✏️', MultiEdit: '✏️', NotebookEdit: '✏️',
  Bash: '⌘', Glob: '🔍', Grep: '🔍', Task: '🤖', WebFetch: '🌐', WebSearch: '🌐',
};

function renderBlocks(blocks) {
  let out = '';
  for (const b of blocks) {
    if (b.kind === 'text') {
      out += `<div class="blk blk-text">${esc(b.text)}</div>`;
    } else if (b.kind === 'thinking') {
      out += `<details class="blk blk-thinking"><summary>💭 思考</summary><div class="blk-thinking-body">${esc(b.text)}</div></details>`;
    } else if (b.kind === 'tool_use') {
      const icon = TOOL_ICONS[b.tool] || '🔧';
      let params = '';
      for (const p of (b.params || [])) {
        params += `<div class="tool-param"><span class="pk">${esc(p.k)}</span><code class="pv">${esc(p.v)}</code></div>`;
      }
      out += `<div class="blk blk-tool"><div class="tool-head">${icon} <span class="tool-name">${esc(b.tool)}</span></div>${params}</div>`;
    } else if (b.kind === 'tool_result') {
      const cls = b.isError ? 'blk-result err' : 'blk-result';
      out += `<details class="blk ${cls}"><summary>${b.isError ? '✗ 结果' : '↳ 结果'}</summary><pre class="result-body">${esc(b.text)}</pre></details>`;
    }
  }
  return out;
}

// ── 通用 Menu 协议辅助（mResp / toast，供 Agents / System / Triggers 复用）──

// 提取 menu.response 的 data/error
function mResp(r) {
  if (!r) return { error: { code: 'INTERNAL', message: 'no response' } };
  if (r.error) return { error: r.error };
  return { data: r.data };
}

function toast(text, isErr) {
  let el = $('#ctrl-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ctrl-toast';
    el.className = 'ctrl-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = 'ctrl-toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'ctrl-toast'; }, 2600);
}

// ── Agents 操作 ──
// （_agentBusy 已在 Agents 视图顶部声明，仅 agentOpNew 仍在用）

// 设置某 aid 的操作状态并立即刷新对应行的按钮区（不重渲整表）
function setAgentOp(aid, label) {
  if (label == null) _agentOps.delete(aid); else _agentOps.set(aid, label);
  const cell = document.querySelector(`.agent-ops[data-aid="${CSS.escape(aid)}"], .agent-ops-busy[data-aid="${CSS.escape(aid)}"]`)?.closest('td');
  if (!cell || !state.agents) return;
  const ag = (state.agents.agents || []).find(x => x.aid === aid);
  if (!ag) return;
  if (ag.status === 'disabled') {
    // 禁用页：只有启用按钮 / 操作中态
    cell.innerHTML = _agentOps.has(aid)
      ? `<div class="agent-ops agent-ops-busy"><span class="ops-busy-label">${esc(_agentOps.get(aid) || '操作中…')}</span></div>`
      : `<div class="agent-ops" data-aid="${esc(aid)}" data-status="disabled"><button class="ctrl-btn ops-enable" data-op="toggle">启用</button></div>`;
  } else {
    const statsByAid = {};
    for (const s of (state.agents.stats || [])) statsByAid[s.aid] = s;
    cell.innerHTML = agentOpsHtml(aid, ag, statsByAid[aid] || {});
  }
  bindOpsCell(cell, aid, ag.status);
}

function bindOpsCell(cell, aid, status) {
  cell.querySelectorAll('button[data-op]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const op = btn.dataset.op;
      if (op === 'more') {
        const more = btn.closest('.ops-more');
        const wasOpen = more.classList.contains('open');
        document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
        if (!wasOpen) more.classList.add('open');
        e.stopPropagation();
        return;
      }
      if (op === 'edit') agentOpEdit(aid);
      else if (op === 'reload') agentOpReload(aid);
      else if (op === 'toggle') agentOpToggle(aid, status);
      else if (op === 'delete') agentOpDelete(aid);
      else if (op === 'clear-queue') agentOpClearQueue(aid);
      else if (op === 'stop') agentOpStop(aid);
      else if (op === 'start') agentOpStart(aid);
      else if (op === 'mute') agentOpMute(aid);
      else if (op === 'unmute') agentOpUnmute(aid);
    });
  });
}

// click-outside 关闭下拉：全局只绑一次（避免每次重渲染叠加监听器）
let _opsOutsideBound = false;
function ensureOpsOutsideClose() {
  if (_opsOutsideBound) return;
  _opsOutsideBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.ops-more')) return; // 点在菜单内不关
    document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
  });
}

function bindAgentsEvents(el) {
  el.querySelector('#agent-new-btn')?.addEventListener('click', agentOpNew);
  ensureOpsOutsideClose();
  // 子标签切换：仅切视图变量并重渲，不重新订阅
  el.querySelectorAll('.ag-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.subtab;
      if (tab && tab !== _agSubtab) { _agSubtab = tab; renderAgents(state.agents); }
    });
  });
  el.querySelectorAll('.agent-ops').forEach(div => {
    const aid = div.dataset.aid;
    const status = div.dataset.status;
    bindOpsCell(div.closest('td'), aid, status);
  });
}

// 异步操作包装：设置 "操作中" 状态、执行、清除
async function withAgentOp(aid, label, fn) {
  setAgentOp(aid, label);
  try { await fn(); }
  finally { setAgentOp(aid, null); }
}

async function agentOpReload(aid, force = false) {
  await withAgentOp(aid, '重载中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'reload', args: { aid, force } }));
    if (r.error?.code === 'BUSY') {
      if (confirm(r.error.message + '\n确认强制重载？')) { setAgentOp(aid, null); return agentOpReload(aid, true); }
      return;
    }
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 已重载');
    subscribe('agents', {});
  });
}

async function agentOpToggle(aid, status) {
  const action = status === 'disabled' ? 'enable' : 'disable';
  const label = action === 'disable' ? '禁用中…' : '启用中…';
  await withAgentOp(aid, label, async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action, args: { aid } }));
    if (r.error?.code === 'BUSY') {
      if (confirm(r.error.message + `\n确认强制${action === 'disable' ? '禁用' : '启用'}？`)) {
        const r2 = mResp(await menuSend({ type: 'menu.action', name: 'agent', action, args: { aid, force: true } }));
        if (r2.error) toast(r2.error.message || r2.error.code, true);
        else {
          toast(`✓ 已${action === 'disable' ? '禁用' : '启用'}`);
          // 禁用后立即切到禁用页；启用后等数据刷新（agent 需先完成启动才移到启用页）
          if (action === 'disable') _agSubtab = 'disabled';
          subscribe('agents', {});
        }
      }
      return;
    }
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(`✓ 已${action === 'disable' ? '禁用' : '启用'}`);
    if (action === 'disable') _agSubtab = 'disabled';
    subscribe('agents', {});
  });
}

async function agentOpDelete(aid) {
  if (!confirm(`删除 Agent ${aid}？\n此操作不可恢复。`)) return;
  const purge = confirm('同时清除 agent 数据目录？');
  await withAgentOp(aid, '删除中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'delete', args: { aid, purge } }));
    if (r.error?.code === 'BUSY') {
      if (confirm(r.error.message + '\n确认强制删除？')) {
        const r2 = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'delete', args: { aid, purge, force: true } }));
        if (r2.error) toast(r2.error.message || r2.error.code, true);
        else { toast('✓ 已删除'); subscribe('agents', {}); }
      }
      return;
    }
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 已删除');
    subscribe('agents', {});
  });
}

async function agentOpClearQueue(aid) {
  if (!confirm(`清空 ${aid} 的待处理消息队列？`)) return;
  await withAgentOp(aid, '清空中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'queue-clear', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(`✓ 已清空 ${r.data?.cleared ?? 0} 条待处理消息`);
    subscribe('agents', {});
  });
}

async function agentOpStop(aid) {
  await withAgentOp(aid, '停止中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'stop', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 已停止');
    subscribe('agents', {});
  });
}

async function agentOpStart(aid) {
  await withAgentOp(aid, '启动中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'start', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 已启动');
    subscribe('agents', {});
  });
}

async function agentOpMute(aid) {
  await withAgentOp(aid, '禁言中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'mute', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 已禁言');
    subscribe('agents', {});
  });
}

async function agentOpUnmute(aid) {
  await withAgentOp(aid, '解禁中…', async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'unmute', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 已解禁');
    subscribe('agents', {});
  });
}

async function agentOpNew() {
  const aid = prompt('Agent AID（如 mybot.agentid.pub）：');
  if (!aid) return;
  const name = prompt('显示名：') || aid.split('.')[0];
  const baseagent = prompt('后端（claude / codex / gemini）：', 'claude') || 'claude';
  _agentBusy = true;
  try {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'create', args: { aid, name, baseagent } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast('✓ 创建请求已受理，稍后刷新查看');
    setTimeout(() => subscribe('agents', {}), 3000);
  } catch (e) { toast(e.message, true); }
  finally { _agentBusy = false; }
}

async function agentOpEdit(aid) {
  await withAgentOp(aid, '查询中…', async () => {
    const qr = await menuSend({ type: 'menu.query', name: 'agent', args: { aid } });
    const q = mResp(qr);
    if (q.error) { toast(q.error.message || q.error.code, true); return; }
    const cfg = q.data;
    setAgentOp(aid, null); // 查询完毕先恢复，等用户填完 prompt
    const projectRaw = prompt('项目路径：', cfg.config?.projects?.defaultPath || '');
    const ownersRaw = prompt('Owners（逗号分隔 AID）：', (cfg.config?.owners || []).join(', '));
    const patch = {};
    if (projectRaw !== null) patch.projects = { defaultPath: projectRaw };
    if (ownersRaw !== null) patch.owners = ownersRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (!Object.keys(patch).length) return;
    setAgentOp(aid, '保存中…');
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'update', args: { aid, patch } }));
    if (r.error) toast(r.error.message || r.error.code, true);
    else toast('✓ 配置已保存，点「重载」生效');
  });
}

// ── System 视图 ──
function channelHealthRow(c) {
  const dot = c.connected ? 'on' : (c.aidStatus === 'reconnecting' || c.aidStatus === 'kicked' ? 'idle' : 'off');
  let meta = '';
  if (c.aidStatus && c.aidStatus !== 'connected') meta += ` <span style="color:var(--dim)">${esc(c.aidStatus)}</span>`;
  if (c.reconnectCount > 0) meta += ` <span style="color:var(--dim)">重连 ${c.reconnectCount}</span>`;
  if (c.flapCount > 0) meta += ` <span style="color:var(--red)">抖动 ${c.flapCount}</span>`;
  const reason = c.kickReason || c.lastError;
  if (reason && !c.connected) meta += ` <span style="color:var(--red)" title="${esc(reason)}">"${esc(reason)}"</span>`;
  return `<div class="ch-row"><span class="dot ${dot}"></span>${esc(c.type)}${c.instName && c.instName !== c.type ? ' ' + esc(c.instName) : ''}${meta}</div>`;
}

function agentHealthCard(ag) {
  const dot = ag.status === 'running' ? 'on' : ag.status === 'disabled' ? 'idle' : 'off';
  let h = `<div class="agent-health-card">`;
  h += `<div class="ahc-head"><span class="dot ${dot}"></span><span class="ahc-aid">${esc(ag.aid || ag.name)}</span><span class="ahc-status">${esc(ag.status)}</span></div>`;
  // 项目路径
  if (ag.projectPath) h += `<div class="ahc-row"><span class="ahc-k">项目</span><span class="ahc-v ahc-path" title="${esc(ag.projectPath)}">${esc(ag.projectPath)}</span></div>`;
  // 后端
  const backend = [ag.baseagent, ag.model, ag.effort].filter(Boolean).map(esc).join(' · ');
  h += `<div class="ahc-row"><span class="ahc-k">后端</span><span class="ahc-v">${backend || '—'}</span></div>`;
  // 渠道
  let chans = '';
  for (const c of (ag.channels || [])) chans += channelHealthRow(c);
  h += `<div class="ahc-row"><span class="ahc-k">渠道</span><span class="ahc-v">${chans || '<span style="color:var(--dim)">无</span>'}</span></div>`;
  // 负载
  const load = `${ag.processing ?? 0} 处理中 · ${ag.pending ?? 0} 待处理 · ${ag.activeSessions ?? 0} 会话`;
  h += `<div class="ahc-row"><span class="ahc-k">负载</span><span class="ahc-v">${load}</span></div>`;
  // 活动
  if (ag.lastActivity) h += `<div class="ahc-row"><span class="ahc-k">活动</span><span class="ahc-v">${fmtAgo(ag.lastActivity)} 前</span></div>`;
  // 错误
  if (ag.error) h += `<div class="ahc-err">⚠ ${esc(String(ag.error).slice(0, 120))}</div>`;
  h += '</div>';
  return h;
}

function renderSystem(data) {
  const el = $('#view-system');
  if (!data) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  const sys = data.system || {};
  const up = data.upgrade;
  const chk = data.check;

  const vcard = (label, local, upInfo) => {
    let badge = '';
    if (upInfo?.hasUpdate && upInfo.remote) badge = ` <span style="color:var(--accent)">⬆ ${esc(upInfo.remote)}</span>`;
    else if (upInfo?.remote) badge = ` <span style="color:var(--dim)">✓ 最新</span>`;
    return `<div class="cache-card"><div class="card-label">${esc(label)}</div><div class="card-val">${esc(local || '—')}${badge}</div></div>`;
  };

  let html = '<div class="sys-wrap">';

  // ① 版本卡
  html += '<div class="cache-cards" style="margin-bottom:16px">';
  html += vcard('evolclaw', sys.version, up?.evolclaw);
  html += vcard('FASTAUN', sys.fastaunVersion, up?.fastaun);
  html += vcard('ECWEB', data.ecwebVersion, up?.ecweb ? {
    remote: up.ecweb.remote,
    hasUpdate: !!(up.ecweb.remote && data.ecwebVersion && compareVer(data.ecwebVersion, up.ecweb.remote) < 0),
  } : null);
  html += `<div class="cache-card"><div class="card-label">NodeJS</div><div class="card-val">${esc(sys.node || '—')}</div></div>`;
  html += `<div class="cache-card"><div class="card-label">运行时间</div><div class="card-val">${esc(fmtDur(sys.uptime))}</div></div>`;
  html += `<div class="cache-card"><div class="card-label">PID</div><div class="card-val">${sys.pid || '—'}</div></div>`;
  html += '</div>';

  // ② 操作区
  const devHint = up?.devMode ? ' <span style="color:var(--dim);font-size:0.85em">⏭ 开发模式，升级需手动操作</span>' : '';
  html += '<div class="sys-actions" style="margin-bottom:16px">' +
    '<button class="ctrl-btn" id="sys-check-btn">🔍 健康检查</button> ' +
    '<button class="ctrl-btn" id="sys-upgrade-btn">⬆ 检查更新</button> ' +
    '<button class="ctrl-btn danger" id="sys-restart-btn">⟳ 重启服务</button>' +
    devHint +
    '</div>';

  // ③ 健康快照
  if (chk) {
    html += '<div class="sys-health">';
    // 队列 + 近 1 小时（数字卡片同一行）
    html += '<div class="cache-cards" style="margin-bottom:8px">';
    html += `<div class="cache-card"><div class="card-label">队列</div><div class="card-val">${chk.queue?.pending ?? 0} 待 · ${chk.queue?.processing ?? 0} 处理中</div></div>`;
    const h = chk.lastHour;
    if (h) {
      const errDetail = h.errors > 0 ? ` (${Object.entries(h.errorsByType || {}).map(([t, c]) => `${t}:${c}`).join(', ')})` : '';
      const avg = h.completed > 0 ? ` · 均 ${(h.avgResponseMs / 1000).toFixed(1)}s` : '';
      html += `<div class="cache-card"><div class="card-label">近 1 小时</div><div class="card-val">收 ${h.received} · 完 ${h.completed} · 错 ${h.errors}${errDetail} · 断 ${h.interrupts}${avg}</div></div>`;
    }
    html += '</div>';
    // 每个 EvolAgent 一张卡片：后端 + 渠道健康 + 负载
    if (chk.evolagents?.length) {
      html += '<div class="agent-health-grid">';
      for (const ag of chk.evolagents) html += agentHealthCard(ag);
      html += '</div>';
    }
    // 未归属任何 EvolAgent 的渠道（系统级 / DefaultAgent）
    if (chk.unownedChannels?.length) {
      html += '<div class="cache-card" style="margin-top:8px"><div class="card-label">未归属渠道</div>';
      for (const c of chk.unownedChannels) html += channelHealthRow(c);
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
  bindSystemEvents(el, data);
}

function bindSystemEvents(el, data) {
  el.querySelector('#sys-check-btn')?.addEventListener('click', async () => {
    try {
      const r = mResp(await menuSend({ type: 'menu.action', name: 'system', action: 'check' }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      state.system = { ...(state.system || {}), check: r.data };
      renderSystem(state.system);
    } catch (e) { toast(e.message, true); }
  });
  el.querySelector('#sys-upgrade-btn')?.addEventListener('click', async () => {
    try {
      const r = mResp(await menuSend({ type: 'menu.action', name: 'system', action: 'upgrade' }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      state.system = { ...(state.system || {}), upgrade: r.data };
      renderSystem(state.system);
    } catch (e) { toast(e.message, true); }
  });
  el.querySelector('#sys-restart-btn')?.addEventListener('click', async () => {
    if (!confirm('确认重启服务？当前所有连接将断开。')) return;
    try {
      await menuSend({ type: 'menu.action', name: 'system', action: 'restart' });
      toast('重启中…');
    } catch (e) { toast(e.message, true); }
  });
}

// ── Gateway 视图（网关 = baseagent 后端接入配置） ──
// 数据来自 daemon menu.query name=gateway（apiKey 已掩码）。
// 写操作走 menuSend({name:'gateway', ...})：update/test/delete。

// 各 baseagent 类型的可编辑字段定义（驱动编辑表单与展示）
const GATEWAY_FIELDS = {
  claude: [
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://gateway.example.com（留空=官方）' },
    { key: 'model', label: '默认模型', placeholder: 'opus / sonnet / claude-...' },
    { key: 'effort', label: 'Effort', placeholder: 'low / medium / high / xhigh / max' },
  ],
  codex: [
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://gateway.example.com（留空=官方）' },
    { key: 'model', label: '默认模型', placeholder: 'gpt-5.2-codex / ...' },
    { key: 'effort', label: 'Effort', placeholder: 'low / medium / high' },
    { key: 'reasoning', label: 'Reasoning', placeholder: '（可选）' },
  ],
  gemini: [
    { key: 'model', label: '默认模型', placeholder: 'gemini-2.5-flash / ...' },
    { key: 'mode', label: '模式', placeholder: 'cli / sdk' },
    { key: 'cliPath', label: 'CLI 路径', placeholder: 'gemini' },
    { key: 'project', label: 'GCP Project', placeholder: '（Vertex 用）' },
    { key: 'location', label: 'Location', placeholder: 'us-central1' },
  ],
};

const GATEWAY_TYPE_ICON = { claude: '🟣', codex: '🟢', gemini: '🔵' };

// 标记每条网关的运行时测试结果：`${scope}#${type}` → { ok, latency, modelCount, error }
const _gwTest = new Map();
let _gwEditing = null;  // 当前编辑中的网关 key（`${scope}#${type}`）或 'new'

function gwKey(scope, type) { return scope + '#' + type; }

function renderGateway(data) {
  const el = $('#view-gateway');
  console.log('[gateway-debug] renderGateway 被调用');
  console.log('[gateway-debug] data 完整内容:', JSON.stringify(data, null, 2));

  if (!data) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (data.error) {
    el.innerHTML = `<div class="empty">⚠ ${esc(data.error)}</div>`;
    return;
  }
  const gateways = data.gateways || [];
  const scopes = data.scopes || ['defaults'];
  const envMismatch = data.envMismatch || { hasMismatch: false, mismatches: [] };

  console.log('[gateway-debug] envMismatch 完整内容:', JSON.stringify(envMismatch, null, 2));
  console.log('[gateway-debug] envMismatch.hasMismatch:', envMismatch.hasMismatch);
  console.log('[gateway-debug] envMismatch.mismatches:', envMismatch.mismatches);
  console.log('[gateway-debug] envMismatch.debug 是否存在:', !!envMismatch.debug);
  console.log('[gateway-debug] envMismatch.debug 内容:', envMismatch.debug);

  // 显示调试信息
  if (envMismatch.debug) {
    console.log('[gateway-debug] 找到 debug 信息:');
    console.log('[gateway-debug] - 进程环境变量:', envMismatch.debug.processEnv);
    console.log('[gateway-debug] - .env 文件内容:', envMismatch.debug.rootEnvFile);
    console.log('[gateway-debug] - defaults 配置:', envMismatch.debug.defaultsConfig);
  } else {
    console.log('[gateway-debug] 警告：没有找到 debug 信息！');
  }

  // 按 scope 分组
  const byScope = new Map();
  for (const s of scopes) byScope.set(s, []);
  for (const g of gateways) {
    if (!byScope.has(g.scope)) byScope.set(g.scope, []);
    byScope.get(g.scope).push(g);
  }

  let html = '<div class="gw-wrap">';

  // 环境变量配置不一致横幅提醒
  if (envMismatch.hasMismatch) {
    console.log('[gateway-debug] 显示横幅提醒');
    html += '<div class="gw-env-mismatch-banner">';
    html += '<div class="gw-env-mismatch-icon">⚠️</div>';
    html += '<div class="gw-env-mismatch-content">';
    html += '<div class="gw-env-mismatch-title">配置与本地环境配置不一致</div>';
    html += '<div class="gw-env-mismatch-desc">检测到 ' + envMismatch.mismatches.length + ' 个配置项与进程环境变量不一致：</div>';

    // 显示详细的不一致信息
    html += '<div class="gw-mismatch-details">';

    // 过滤掉敏感字段（apiKey, token 等）
    const visibleMismatches = envMismatch.mismatches.filter(m => {
      const fieldLower = m.field.toLowerCase();
      return !fieldLower.includes('key') && !fieldLower.includes('token') && !fieldLower.includes('secret');
    });

    if (visibleMismatches.length === 0) {
      html += '<div class="gw-mismatch-empty-hint">检测到的配置不一致项均为敏感信息，已隐藏显示。</div>';
    }

    for (const m of visibleMismatches) {
      const scope = m.aid === 'defaults' ? '🌐 全局默认配置' : `📁 Agent: ${shortAid(m.aid)}`;

      // 提取环境变量名
      let envVarName = m.envVarName || '';
      if (!envVarName && m.configValue && m.configValue.startsWith('$ENV:')) {
        envVarName = m.configValue.replace('$ENV:', '');
      }

      // 获取实际值
      const processValue = m.processValue || envMismatch.debug?.processEnv?.[envVarName] || '(进程环境中未设置)';
      const configValue = m.configValue || '(未设置)';

      // 判断是引用型还是实际值型
      const isReference = configValue.startsWith('$ENV:');

      html += '<div class="gw-mismatch-item">';
      html += '<div class="gw-mismatch-header-row">';
      html += '<span class="gw-mismatch-scope">' + esc(scope) + '</span>';
      html += '<span class="gw-mismatch-field">baseagent:' + esc(m.type) + ' · ' + esc(m.field) + '</span>';
      html += '</div>';
      html += '<div class="gw-mismatch-info">';

      if (isReference) {
        // 引用型：配置文件使用 $ENV:XXX 引用，但进程环境有值
        html += '<div class="gw-info-row">';
        html += '<span class="gw-info-label">进程环境变量:</span>';
        html += '<code class="gw-info-value">' + esc(envVarName) + '</code>';
        html += '</div>';

        html += '<div class="gw-info-row">';
        html += '<span class="gw-info-label">当前值:</span>';
        html += '<span class="gw-info-value gw-value-env">✓ ' + esc(processValue) + '</span>';
        html += '</div>';

        html += '<div class="gw-info-hint">💡 配置文件引用环境变量，同步将持久化当前值</div>';
      } else {
        // 实际值型：配置文件直接写了值，但与进程环境不一致
        html += '<div class="gw-info-row">';
        html += '<span class="gw-info-label">进程环境变量:</span>';
        html += '<span class="gw-info-value gw-value-env">✓ ' + esc(processValue) + '</span>';
        html += '</div>';

        html += '<div class="gw-info-row">';
        html += '<span class="gw-info-label">配置文件当前值:</span>';
        html += '<span class="gw-info-value gw-value-config gw-value-diff">✗ ' + esc(configValue) + '</span>';
        html += '</div>';

        html += '<div class="gw-info-hint">💡 配置文件值与进程环境变量不一致，同步将更新配置文件</div>';
      }

      html += '</div>';
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="gw-env-mismatch-help">';
    html += '💡 <strong>同步说明：</strong>将从<strong>进程环境变量</strong>读取值，写入到<strong>配置文件</strong>中（defaults.json 或 agents/&lt;aid&gt;/config.json）。';
    html += '</div>';

    html += '</div>';
    html += '<div class="gw-env-mismatch-actions">';
    html += '<button class="ctrl-btn gw-sync-global" title="同步到全局默认配置（defaults.json）">同步全局配置</button> ';
    html += '<button class="ctrl-btn gw-sync-all" title="同步到全局配置 + 所有 Agent 配置">同步所有 Agent</button> ';
    html += '<button class="ctrl-btn gw-sync-select" title="选择特定 Agent 进行同步">指定 Agent 同步</button> ';
    html += '<button class="ctrl-btn gw-dismiss-banner" title="暂时忽略">×</button>';
    html += '</div>';
    html += '</div>';
  } else {
    console.log('[gateway-debug] 没有不一致，不显示横幅');
  }

  html += '<div class="gw-intro">网关 = 各 AI 后端（baseagent）的接入配置。Base URL 即网关地址，留空走官方端点。' +
    'API Key 仅接受 <code>$ENV:变量名</code> 引用，明文不会在此显示或写入。</div>';

  // 只展示全局默认配置块（用于编辑）
  for (const [scope, list] of byScope) {
    if (scope !== 'defaults') continue;  // 跳过 per-agent 原始配置块（已在下方 effective 展示）
    const scopeLabel = '🌐 全局默认 (defaults)';
    html += `<div class="gw-scope">`;
    html += `<div class="gw-scope-head"><span class="gw-scope-title">${scopeLabel}</span>` +
      `<button class="ctrl-btn gw-add" data-scope="${esc(scope)}">+ 添加网关</button></div>`;
    html += '<div class="gw-cards">';
    if (!list.length) {
      html += '<div class="empty" style="padding:12px">该作用域暂无网关配置</div>';
    } else {
      for (const g of list) html += gatewayCard(g);
    }
    html += '</div></div>';
  }

  // ── Agent 使用配置（effective）：紧凑表格 + 编辑按钮 ──
  const effective = data.effective || [];
  if (effective.length > 0) {
    html += '<div class="gw-effective-section">';
    html += '<div class="gw-scope-head"><span class="gw-scope-title">📋 Agent 网关配置</span></div>';
    html += '<table class="gw-eff-table"><thead><tr>' +
      '<th>Agent</th><th>Base Agent</th><th>Base URL</th><th>模型</th><th>API Key</th><th>Effort</th><th>来源</th><th>操作</th>' +
      '</tr></thead><tbody>';
    for (const eff of effective) {
      const f = eff.fields || {};
      const blockSrc = eff.blockSource || 'defaults';
      const srcCls = blockSrc === 'agent' ? 'gw-src-agent' : 'gw-src-defaults';
      const srcLabel = blockSrc === 'agent' ? '⚡ agent' : '🔗 默认';
      const baseUrlVal = f.baseUrl?.value || '';
      const modelVal = f.model?.value || '';
      const keyVal = f.apiKey?.value || '';
      const effortVal = f.effort?.value || '';

      html += `<tr class="gw-eff-tr${blockSrc === 'defaults' ? ' gw-eff-tr-inherited' : ''}">` +
        `<td class="gw-eff-td-aid" title="${esc(eff.aid)}">${esc(shortAid(eff.aid))}</td>` +
        `<td>${GATEWAY_TYPE_ICON[eff.type] || ''} ${esc(eff.type)}</td>` +
        `<td class="gw-eff-td-url" title="${esc(baseUrlVal)}">${baseUrlVal ? esc(baseUrlVal) : '<span class="gw-dim">官方</span>'}</td>` +
        `<td>${modelVal ? esc(modelVal) : '<span class="gw-dim">—</span>'}</td>` +
        `<td>${keyVal ? esc(keyVal) : '<span class="gw-dim">—</span>'}</td>` +
        `<td>${effortVal ? esc(effortVal) : '<span class="gw-dim">—</span>'}</td>` +
        `<td><span class="gw-eff-src-tag ${srcCls}">${srcLabel}</span></td>` +
        `<td class="gw-eff-td-actions">` +
          `<button class="ctrl-btn gw-eff-edit" data-aid="${esc(eff.aid)}" data-type="${esc(eff.type)}" title="编辑该 agent 的网关配置">编辑</button>` +
          `<button class="ctrl-btn gw-eff-models" data-aid="${esc(eff.aid)}" data-type="${esc(eff.type)}" title="查看网关支持的模型及价格">查看网关配置</button>` +
        `</td>` +
        `</tr>`;
    }
    html += '</tbody></table></div>';
  }

  html += '</div>';
  el.innerHTML = html;
  bindGatewayEvents(el, data);
}

function gatewayCard(g) {
  const key = gwKey(g.scope, g.type);
  const icon = GATEWAY_TYPE_ICON[g.type] || '⚙';
  const test = _gwTest.get(key);

  // 连通性测试状态点
  let dot = '<span class="gw-dot gw-dot-unknown" title="未测试"></span>';
  if (test) {
    if (test.ok) dot = `<span class="gw-dot gw-dot-ok" title="${test.latency}ms · ${test.modelCount} 模型"></span>`;
    else dot = `<span class="gw-dot gw-dot-err" title="${esc(test.error || '失败')}"></span>`;
  }

  // API Key 展示
  let keyHtml;
  if (!g.apiKeyMask) keyHtml = '<span class="gw-dim">未配置</span>';
  else if (g.apiKeyIsEnvRef) keyHtml = `<code class="gw-env">${esc(g.apiKeyMask)}</code>`;
  else keyHtml = '<span class="gw-dim" title="明文密钥已隐藏，建议改用 $ENV 引用">*** (明文)</span>';

  const rows = [];
  rows.push(['Base URL', g.baseUrl ? esc(g.baseUrl) : '<span class="gw-dim">官方端点</span>']);
  rows.push(['默认模型', g.model ? esc(g.model) : '<span class="gw-dim">—</span>']);
  rows.push(['API Key', keyHtml]);
  if (g.effort) rows.push(['Effort', esc(g.effort)]);
  if (g.reasoning) rows.push(['Reasoning', esc(g.reasoning)]);
  if (g.mode) rows.push(['模式', esc(g.mode)]);
  if (g.cliPath) rows.push(['CLI 路径', esc(g.cliPath)]);
  if (g.project) rows.push(['Project', esc(g.project)]);
  if (g.location) rows.push(['Location', esc(g.location)]);

  let html = `<div class="gw-card" data-key="${esc(key)}">`;
  html += `<div class="gw-card-head">${dot}<span class="gw-card-icon">${icon}</span>` +
    `<span class="gw-card-title">${esc(g.name)}</span>` +
    `<span class="gw-card-type">${esc(g.type)}</span></div>`;
  html += '<div class="gw-card-body">';
  for (const [label, val] of rows) {
    html += `<div class="gw-row"><span class="gw-row-label">${esc(label)}</span><span class="gw-row-val">${val}</span></div>`;
  }
  html += '</div>';
  html += '<div class="gw-card-actions">';
  const testable = g.type === 'claude' || g.type === 'codex';
  if (testable) html += `<button class="ctrl-btn gw-test" data-scope="${esc(g.scope)}" data-type="${esc(g.type)}">⚡ 测试</button> `;
  html += `<button class="ctrl-btn gw-edit" data-scope="${esc(g.scope)}" data-type="${esc(g.type)}">✎ 编辑</button> `;
  html += `<button class="ctrl-btn danger gw-del" data-scope="${esc(g.scope)}" data-type="${esc(g.type)}">🗑 删除</button>`;
  html += '</div>';
  html += '</div>';
  return html;
}

// 编辑/新增弹窗
function openGatewayEditor(scope, type, existing, scopes) {
  const isNew = !existing;
  const fields = GATEWAY_FIELDS[type] || GATEWAY_FIELDS.claude;

  let html = '<div class="gw-modal-backdrop" id="gw-modal-backdrop"><div class="gw-modal">';
  html += `<div class="gw-modal-head">${isNew ? '添加网关' : '编辑网关'}</div>`;
  html += '<div class="gw-modal-body">';

  // scope 选择（新增时可选，编辑时锁定）
  html += '<label class="gw-field"><span class="gw-field-label">作用域</span>';
  if (isNew) {
    html += '<select id="gw-f-scope">';
    for (const s of (scopes || ['defaults'])) {
      const lbl = s === 'defaults' ? '全局默认' : shortAid(s);
      html += `<option value="${esc(s)}"${s === scope ? ' selected' : ''}>${esc(lbl)}</option>`;
    }
    html += '</select>';
  } else {
    html += `<input id="gw-f-scope" type="text" value="${esc(scope)}" disabled>`;
  }
  html += '</label>';

  // type 选择（新增时可选，编辑时锁定）
  html += '<label class="gw-field"><span class="gw-field-label">后端类型</span>';
  if (isNew) {
    html += '<select id="gw-f-type">';
    for (const t of ['claude', 'codex', 'gemini']) {
      html += `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`;
    }
    html += '</select>';
  } else {
    html += `<input id="gw-f-type" type="text" value="${esc(type)}" disabled>`;
  }
  html += '</label>';

  // 动态字段
  html += '<div id="gw-dyn-fields">';
  for (const f of fields) {
    const val = existing ? (existing[f.key] || '') : '';
    html += `<label class="gw-field"><span class="gw-field-label">${esc(f.label)}</span>` +
      `<input class="gw-dyn" data-key="${esc(f.key)}" type="text" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"></label>`;
  }
  html += '</div>';

  // API Key（仅 $ENV 引用）
  const curKey = existing && existing.apiKeyIsEnvRef ? existing.apiKeyMask : '';
  html += '<label class="gw-field"><span class="gw-field-label">API Key 引用</span>' +
    `<input id="gw-f-apikey" type="text" value="${esc(curKey)}" placeholder="$ENV:ANTHROPIC_AUTH_TOKEN（留空不改）"></label>`;
  html += '<div class="gw-hint">仅支持环境变量引用，格式 <code>$ENV:变量名</code>。明文密钥请写入环境变量后引用。</div>';

  html += '</div>';  // body
  html += '<div class="gw-modal-actions">' +
    '<button class="ctrl-btn" id="gw-cancel">取消</button> ' +
    '<button class="ctrl-btn primary" id="gw-save">保存</button>' +
    '</div>';
  html += '</div></div>';

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstChild);

  const backdrop = $('#gw-modal-backdrop');
  const close = () => { try { backdrop.remove(); } catch {} };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  $('#gw-cancel').onclick = close;

  // 新增时切换 type 重建动态字段
  if (isNew) {
    $('#gw-f-type').onchange = (e) => {
      const newType = e.target.value;
      const dyn = $('#gw-dyn-fields');
      const fs2 = GATEWAY_FIELDS[newType] || GATEWAY_FIELDS.claude;
      dyn.innerHTML = fs2.map(f =>
        `<label class="gw-field"><span class="gw-field-label">${esc(f.label)}</span>` +
        `<input class="gw-dyn" data-key="${esc(f.key)}" type="text" value="" placeholder="${esc(f.placeholder || '')}"></label>`
      ).join('');
    };
  }

  $('#gw-save').onclick = async () => {
    const fScope = $('#gw-f-scope').value;
    const fType = $('#gw-f-type').value;
    const patch = {};
    document.querySelectorAll('#gw-dyn-fields .gw-dyn').forEach(inp => {
      patch[inp.dataset.key] = inp.value.trim();
    });
    const apiKey = $('#gw-f-apikey').value.trim();
    if (apiKey) {
      if (!apiKey.startsWith('$ENV:')) { toast('API Key 必须是 $ENV:变量名 引用', true); return; }
      patch.apiKey = apiKey;
    }
    try {
      const r = mResp(await menuSend({
        type: 'menu.update', name: 'gateway',
        value: JSON.stringify({ scope: fScope, type: fType, patch }),
      }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      toast(r.data && r.data.reloaded ? '已保存并重载' : '已保存（未重载）');
      close();
      subscribe('gateway', {});  // 刷新
    } catch (e) { toast(e.message, true); }
  };
}

function bindGatewayEvents(el, data) {
  const scopes = data.scopes || ['defaults'];
  const findGw = (scope, type) => (data.gateways || []).find(g => g.scope === scope && g.type === type);
  const envMismatch = data.envMismatch || { hasMismatch: false, mismatches: [] };

  // 环境变量同步横幅按钮
  const syncGlobalBtn = el.querySelector('.gw-sync-global');
  const syncAllBtn = el.querySelector('.gw-sync-all');
  const syncSelectBtn = el.querySelector('.gw-sync-select');
  const dismissBtn = el.querySelector('.gw-dismiss-banner');

  if (syncGlobalBtn) {
    syncGlobalBtn.addEventListener('click', async () => {
      // 显示详细的确认对话框
      const confirmMsg =
        '🔄 同步到全局默认配置\n\n' +
        '操作说明：\n' +
        '• 从：进程环境变量（process.env）\n' +
        '• 到：agents/defaults.json（全局默认配置）\n' +
        '• 影响：所有未单独配置的 Agent 将使用新值\n\n' +
        '将会同步以下环境变量到配置文件：\n' +
        (envMismatch.debug?.processEnv ?
          Object.entries(envMismatch.debug.processEnv).map(([k, v]) => `  • ${k}: ${v}`).join('\n') :
          '  • ANTHROPIC_AUTH_TOKEN\n  • ANTHROPIC_BASE_URL') +
        '\n\n⚠️ 配置文件将被更新，原有值会被覆盖。\n\n确认同步？';

      if (!confirm(confirmMsg)) return;

      syncGlobalBtn.disabled = true;
      const orig = syncGlobalBtn.textContent;
      syncGlobalBtn.textContent = '同步中…';
      try {
        const r = mResp(await menuSend({
          type: 'menu.action', name: 'gateway', action: 'sync-env',
          args: { syncType: 'global' },
        }));
        if (r.error) { toast(r.error.message || r.error.code, true); return; }
        toast(`✓ 已同步到全局配置`);
        subscribe('gateway', {}); // 刷新视图
      } catch (e) {
        toast(e.message, true);
      } finally {
        syncGlobalBtn.disabled = false;
        syncGlobalBtn.textContent = orig;
      }
    });
  }

  if (syncAllBtn) {
    syncAllBtn.addEventListener('click', async () => {
      const agentCount = (data.scopes || []).filter(s => s !== 'defaults').length;
      const confirmMsg =
        '🔄 同步到全局配置 + 所有 Agent 配置\n\n' +
        '操作说明：\n' +
        '• 从：进程环境变量（process.env）\n' +
        '• 到：agents/defaults.json + agents/<aid>/config.json\n' +
        `• 影响：全局配置 + ${agentCount} 个 Agent 的配置文件\n\n` +
        '将会同步以下环境变量到所有配置文件：\n' +
        (envMismatch.debug?.processEnv ?
          Object.entries(envMismatch.debug.processEnv).map(([k, v]) => `  • ${k}: ${v}`).join('\n') :
          '  • ANTHROPIC_AUTH_TOKEN\n  • ANTHROPIC_BASE_URL') +
        '\n\n⚠️ 所有 Agent 的配置文件将被更新，原有值会被覆盖。\n\n确认同步？';

      if (!confirm(confirmMsg)) return;

      syncAllBtn.disabled = true;
      const orig = syncAllBtn.textContent;
      syncAllBtn.textContent = '同步中…';
      try {
        const r = mResp(await menuSend({
          type: 'menu.action', name: 'gateway', action: 'sync-env',
          args: { syncType: 'all-agents' },
        }));
        if (r.error) { toast(r.error.message || r.error.code, true); return; }
        toast(`✓ 已同步 ${agentCount + 1} 个配置文件`);
        subscribe('gateway', {}); // 刷新视图
      } catch (e) {
        toast(e.message, true);
      } finally {
        syncAllBtn.disabled = false;
        syncAllBtn.textContent = orig;
      }
    });
  }

  if (syncSelectBtn) {
    syncSelectBtn.addEventListener('click', () => {
      openAgentSelectModal(data, scopes);
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      const banner = el.querySelector('.gw-env-mismatch-banner');
      if (banner) banner.style.display = 'none';
    });
  }

  // 添加
  el.querySelectorAll('.gw-add').forEach(btn => {
    btn.addEventListener('click', () => {
      openGatewayEditor(btn.dataset.scope, 'claude', null, scopes);
    });
  });

  // 编辑
  el.querySelectorAll('.gw-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = findGw(btn.dataset.scope, btn.dataset.type);
      openGatewayEditor(btn.dataset.scope, btn.dataset.type, g, scopes);
    });
  });

  // Effective 表格编辑
  el.querySelectorAll('.gw-eff-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const aid = btn.dataset.aid;
      const type = btn.dataset.type;
      const existing = findGw(aid, type);
      openGatewayEditor(aid, type, existing, scopes);
    });
  });

  // 测试
  el.querySelectorAll('.gw-test').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { scope, type } = btn.dataset;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '测试中…';
      try {
        const r = mResp(await menuSend({
          type: 'menu.action', name: 'gateway', action: 'test',
          args: { scope, type },
        }));
        if (r.error) {
          _gwTest.set(gwKey(scope, type), { ok: false, error: r.error.message || r.error.code });
          toast(r.error.message || r.error.code, true);
        } else {
          _gwTest.set(gwKey(scope, type), r.data);
          toast(r.data.ok ? `✓ ${r.data.latency}ms · ${r.data.modelCount} 模型` : `✗ ${r.data.error || '失败'}`, !r.data.ok);
        }
        renderGateway(state.gateway);
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  });

  // 删除
  el.querySelectorAll('.gw-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { scope, type } = btn.dataset;
      const label = scope === 'defaults' ? '全局默认' : shortAid(scope);
      if (!confirm(`确认删除 ${label} 的 ${type} 网关配置？`)) return;
      try {
        const r = mResp(await menuSend({
          type: 'menu.action', name: 'gateway', action: 'delete',
          args: { scope, type },
        }));
        if (r.error) { toast(r.error.message || r.error.code, true); return; }
        toast(r.data && r.data.reloaded ? '已删除并重载' : '已删除');
        subscribe('gateway', {});
      } catch (e) { toast(e.message, true); }
    });
  });

  // Effective 表格「查看网关配置」按钮：拉模型+价格，弹窗展示
  el.querySelectorAll('.gw-eff-models').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { aid, type } = btn.dataset;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '加载中…';
      try {
        const r = mResp(await menuSend({
          type: 'menu.action', name: 'gateway', action: 'models',
          args: { scope: aid, type },
        }));
        if (r.error) { toast(r.error.message || r.error.code, true); return; }
        showGatewayConfigModal(shortAid(aid), type, r.data);
      } catch (e) {
        toast(e.message, true);
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  });
}

// Agent 选择模态框（用于同步指定 Agent 的环境变量）
function openAgentSelectModal(data, scopes) {
  const agents = scopes.filter(s => s !== 'defaults');

  let html = '<div class="gw-modal-backdrop" id="gw-agent-select-backdrop"><div class="gw-modal">';
  html += '<div class="gw-modal-head">选择要同步的 Agent</div>';
  html += '<div class="gw-modal-body">';
  html += '<div class="gw-hint">请选择需要同步环境变量配置的 Agent（可多选）</div>';
  html += '<div class="gw-agent-select-list">';

  if (!agents.length) {
    html += '<div class="empty">暂无可用的 Agent</div>';
  } else {
    for (const aid of agents) {
      html += `<label class="gw-agent-select-item">` +
        `<input type="checkbox" class="gw-agent-checkbox" value="${esc(aid)}">` +
        `<span class="gw-agent-label">${esc(shortAid(aid))}</span>` +
        `<span class="gw-agent-aid" title="${esc(aid)}">${esc(aid)}</span>` +
        `</label>`;
    }
  }

  html += '</div></div>';
  html += '<div class="gw-modal-actions">' +
    '<button class="ctrl-btn" id="gw-agent-cancel">取消</button> ' +
    '<button class="ctrl-btn primary" id="gw-agent-sync">同步选中的 Agent</button>' +
    '</div>';
  html += '</div></div>';

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstChild);

  const backdrop = $('#gw-agent-select-backdrop');
  const close = () => { try { backdrop.remove(); } catch {} };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  $('#gw-agent-cancel').onclick = close;

  $('#gw-agent-sync').onclick = async () => {
    const checkboxes = backdrop.querySelectorAll('.gw-agent-checkbox:checked');
    const selectedAids = Array.from(checkboxes).map(cb => cb.value);

    if (selectedAids.length === 0) {
      toast('请至少选择一个 Agent', true);
      return;
    }

    if (!confirm(`确认同步全局配置 + ${selectedAids.length} 个 Agent 的环境变量？`)) return;

    const btn = $('#gw-agent-sync');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '同步中…';

    try {
      const r = mResp(await menuSend({
        type: 'menu.action', name: 'gateway', action: 'sync-env',
        args: { syncType: 'specific-agents', targetAids: selectedAids },
      }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      toast(`已同步 ${r.data.count} 个配置文件`);
      close();
      subscribe('gateway', {}); // 刷新视图
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  };
}

// 网关配置弹窗：模型 + 官方价格 + 网关价格（可编辑）
function showGatewayConfigModal(aidLabel, type, data) {
  const models = data.models || [];
  const usdToCny = data.usdToCny || 7; // 汇率，默认 7

  // 按模型系列分组
  const groups = new Map();
  for (const m of models) {
    const id = m.id || m.name || '';
    let series = 'other';
    if (id.startsWith('claude')) series = 'claude';
    else if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3')) series = 'gpt';
    else if (id.startsWith('gemini')) series = 'gemini';
    else if (id.startsWith('deepseek')) series = 'deepseek';
    else if (id.startsWith('kimi')) series = 'kimi';
    else if (id.startsWith('glm')) series = 'glm';
    else if (id.startsWith('MiniMax')) series = 'minimax';

    if (!groups.has(series)) groups.set(series, []);
    groups.get(series).push(m);
  }

  const seriesNames = {
    claude: 'Claude 系列',
    gpt: 'GPT 系列',
    gemini: 'Gemini 系列',
    deepseek: 'DeepSeek 系列',
    kimi: 'Kimi 系列',
    glm: 'GLM 系列',
    minimax: 'MiniMax 系列',
    other: '其他模型'
  };

  let html = '<div class="gw-modal-backdrop" id="gw-config-backdrop"><div class="gw-modal gw-modal-wide">';
  html += `<div class="gw-modal-head">${esc(aidLabel)} · ${esc(type)} 网关配置 <span style="font-weight:normal;color:var(--dim);font-size:12px">（${models.length} 个模型 · 汇率: ${usdToCny.toFixed(2)}）</span></div>`;
  html += '<div class="gw-modal-body">';

  if (!models.length) {
    html += '<div class="empty">网关未返回模型列表</div>';
  } else {
    // 按系列渲染表格
    const sortedSeries = ['claude', 'gpt', 'gemini', 'deepseek', 'kimi', 'glm', 'minimax', 'other']
      .filter(s => groups.has(s));

    for (const series of sortedSeries) {
      const seriesModels = groups.get(series);
      html += `<div class="gw-model-series">`;
      html += `<div class="gw-series-header" data-series="${series}">
        <span class="gw-series-toggle">▼</span>
        <span class="gw-series-title">${seriesNames[series] || series}</span>
        <span class="gw-series-count">${seriesModels.length} 个模型</span>
      </div>`;
      html += `<div class="gw-series-content" data-series="${series}">`;
      html += '<table class="gw-price-table"><thead><tr>' +
        '<th>模型</th>' +
        '<th colspan="4">官方价格（USD/1M tokens）</th>' +
        '<th colspan="4">网关价格（USD/1M tokens）</th>' +
        '<th>来源</th><th></th>' +
        '</tr><tr class="gw-price-subhead">' +
        '<th></th>' +
        '<th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th>' +
        '<th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th>' +
        '<th></th><th></th>' +
        '</tr></thead><tbody>';

      for (const m of seriesModels) {
        const srcLabel = { gateway: '网关接口', local: '本地配置', none: '—' }[m.officialSource] || '—';
        const srcCls = { gateway: 'gw-src-gateway', local: 'gw-src-local', none: 'gw-src-none' }[m.officialSource] || '';
        const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
        const off = m.official || {};
        const gw = m.gateway || {};
        html += `<tr class="gw-price-row">` +
          `<td class="gw-price-model" title="${esc(m.id)}"><code>${esc(m.id)}</code></td>` +
          `<td>${fmt(off.input)}</td><td>${fmt(off.output)}</td><td>${fmt(off.cache_read)}</td><td>${fmt(off.cache_write)}</td>` +
          `<td>${fmt(gw.input)}</td><td>${fmt(gw.output)}</td><td>${fmt(gw.cache_read)}</td><td>${fmt(gw.cache_write)}</td>` +
          `<td><span class="gw-eff-src-tag ${srcCls}">${srcLabel}</span></td>` +
          `<td><button class="ctrl-btn gw-price-edit" data-model="${esc(m.id)}" data-scope="${esc(data.scope)}" data-type="${esc(type)}">改价</button></td>` +
          `</tr>`;
      }
      html += '</tbody></table>';
      html += '</div></div>';
    }
  }

  html += '</div>';
  html += '<div class="gw-modal-actions"><button class="ctrl-btn primary" id="gw-config-close">关闭</button></div>';
  html += '</div></div>';

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstChild);
  const backdrop = $('#gw-config-backdrop');
  const close = () => { try { backdrop.remove(); } catch {} };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  $('#gw-config-close').onclick = close;

  // 展开/收起功能
  backdrop.querySelectorAll('.gw-series-header').forEach(header => {
    header.addEventListener('click', () => {
      const series = header.dataset.series;
      const content = backdrop.querySelector(`.gw-series-content[data-series="${series}"]`);
      const toggle = header.querySelector('.gw-series-toggle');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        toggle.textContent = '▼';
      } else {
        content.style.display = 'none';
        toggle.textContent = '▶';
      }
    });
  });

  // 改价按钮
  backdrop.querySelectorAll('.gw-price-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const modelId = btn.dataset.model;
      const scope = btn.dataset.scope;
      const gwType = btn.dataset.type;
      showPriceEditModal(modelId, scope, gwType, () => {
        close();
        // 重新拉取并展示
        setTimeout(async () => {
          const r = mResp(await menuSend({
            type: 'menu.action', name: 'gateway', action: 'models',
            args: { scope, type: gwType },
          }));
          if (!r.error) showGatewayConfigModal(aidLabel, gwType, r.data);
        }, 100);
      });
    });
  });
}

// 改价弹窗：四个输入框（input/output/cache_read/cache_write）
function showPriceEditModal(modelId, scope, type, onSaved) {
  let html = '<div class="gw-modal-backdrop" id="gw-price-edit-backdrop"><div class="gw-modal">';
  html += `<div class="gw-modal-head">修改网关价格<div class="gw-modal-subtitle">模型: ${esc(modelId)}</div></div>`;
  html += '<div class="gw-modal-body">';
  html += '<div class="gw-hint">留空的字段不修改。单位：USD / 1M tokens。</div>';
  html += '<label class="gw-field"><span class="gw-field-label">Input</span><input id="gw-price-input" type="number" step="0.01" min="0" placeholder="5.0"></label>';
  html += '<label class="gw-field"><span class="gw-field-label">Output</span><input id="gw-price-output" type="number" step="0.01" min="0" placeholder="25.0"></label>';
  html += '<label class="gw-field"><span class="gw-field-label">Cache Read</span><input id="gw-price-cache-read" type="number" step="0.01" min="0" placeholder="0.5"></label>';
  html += '<label class="gw-field"><span class="gw-field-label">Cache Write</span><input id="gw-price-cache-write" type="number" step="0.01" min="0" placeholder="6.25"></label>';
  html += '</div>';
  html += '<div class="gw-modal-actions">' +
    '<button class="ctrl-btn" id="gw-price-cancel">取消</button> ' +
    '<button class="ctrl-btn primary" id="gw-price-save">保存</button></div>';
  html += '</div></div>';

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstChild);
  const backdrop = $('#gw-price-edit-backdrop');
  const close = () => { try { backdrop.remove(); } catch {} };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  $('#gw-price-cancel').onclick = close;

  $('#gw-price-save').onclick = async () => {
    const pricing = {};
    const inp = parseFloat($('#gw-price-input').value);
    const out = parseFloat($('#gw-price-output').value);
    const cr = parseFloat($('#gw-price-cache-read').value);
    const cw = parseFloat($('#gw-price-cache-write').value);
    if (!isNaN(inp) && inp >= 0) pricing.input = inp;
    if (!isNaN(out) && out >= 0) pricing.output = out;
    if (!isNaN(cr) && cr >= 0) pricing.cache_read = cr;
    if (!isNaN(cw) && cw >= 0) pricing.cache_write = cw;
    if (!Object.keys(pricing).length) { toast('至少填一个字段', true); return; }

    try {
      const r = mResp(await menuSend({
        type: 'menu.action', name: 'gateway', action: 'set-price',
        args: { modelId, pricing },
      }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      toast('价格已保存到用户覆盖层');
      close();
      if (onSaved) onSaved();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

// ── Triggers 视图 ──
function trigStatusBadge(status) {
  const map = {
    active:    ['活跃', 'trig-badge-active'],
    fired:     ['已触发', 'trig-badge-fired'],
    cancelled: ['已取消', 'trig-badge-cancelled'],
    expired:   ['已过期', 'trig-badge-expired'],
  };
  const [label, cls] = map[status] || [status, 'trig-badge-fired'];
  return `<span class="trig-badge ${cls}">${esc(label)}</span>`;
}

function renderTriggers(data) {
  if (!data) { $('#view-triggers').innerHTML = '<div class="empty">加载中…</div>'; return; }
  const agents = data.agents || [];
  const triggers = data.triggers || [];
  const selAid = data.selectedAgent;

  // 左列：agent 列表（仿 msg list-item 风格）
  let aHtml = '<div class="col-title">Agent</div>';
  if (!agents.length) aHtml += '<div class="empty">暂无 Agent</div>';
  for (const ag of agents) {
    const sel = ag.value === selAid ? ' sel' : '';
    aHtml += `<div class="list-item${sel}" data-aid="${esc(ag.value)}">` +
      `<div class="name">${esc(ag.label)}</div>` +
      `<div class="sub">${esc(ag.value)}</div></div>`;
  }
  $('#trig-agents').innerHTML = aHtml;
  $('#trig-agents').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { trigSel.agent = item.dataset.aid; subscribe('triggers', { agent: trigSel.agent }); };
  });

  // 右列：table，每字段一列
  const el = $('#trig-table');
  if (!selAid) { el.innerHTML = '<div class="empty" style="padding:16px">← 选择 Agent 查看触发器</div>'; return; }
  if (!triggers.length) { el.innerHTML = '<div class="empty" style="padding:16px">该 Agent 暂无触发器</div>'; return; }

  let html = '<table><thead><tr>' +
    '<th>状态</th><th>名称</th><th>ID</th><th>类型</th><th>表达式</th>' +
    '<th>上次触发</th><th>下次触发</th><th>触发次数</th><th>失败次数</th><th>最后结果</th><th>Session 策略</th>' +
    '<th>目标渠道</th><th>渠道 ID</th><th>渠道类型</th>' +
    '<th>创建者</th><th>创建渠道</th><th>创建时间</th><th>操作</th>' +
    '</tr></thead><tbody>';
  for (const t of triggers) {
    const status = t.status || 'active';
    const active = status === 'active';
    html += `<tr class="${active ? '' : 'trig-done'}">` +
      `<td>${trigStatusBadge(status)}</td>` +
      `<td>${esc(t.name ?? t.label ?? '')}</td>` +
      `<td>${esc(t.id ?? t.value ?? '')}</td>` +
      `<td>${esc(t.scheduleType ?? '')}</td>` +
      `<td>${t.scheduleType === 'at' && t.scheduleValue ? fmtTime(new Date(t.scheduleValue).getTime()) : esc(t.scheduleValue ?? '')}</td>` +
      `<td>${t.lastFiredAt ? fmtTime(t.lastFiredAt) : '—'}</td>` +
      `<td>${t.nextFireAt ? fmtTime(t.nextFireAt) : '—'}</td>` +
      `<td>${t.fireCount ?? 0}</td>` +
      `<td>${t.failCount ? `<span style="color:var(--red)">${t.failCount}</span>` : '0'}</td>` +
      `<td>${t.lastResult ? esc(t.lastResult) : '—'}</td>` +
      `<td>${esc(t.targetSessionStrategy ?? '')}</td>` +
      `<td>${esc(t.targetChannel ?? '')}</td>` +
      `<td>${esc(t.targetChannelId ?? '')}</td>` +
      `<td>${esc(t.targetChannelType ?? '')}</td>` +
      `<td>${esc(t.createdByPeerId ?? '')}</td>` +
      `<td>${esc(t.createdByChannel ?? '')}</td>` +
      `<td>${t.createdAt ? fmtTime(t.createdAt) : '—'}</td>` +
      `<td>${active
        ? `<button class="ctrl-btn danger" data-trigid="${esc(t.id ?? t.value ?? '')}" data-trigname="${esc(t.name ?? t.label ?? '')}">取消</button>`
        : '—'}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;

  el.querySelectorAll('button[data-trigid]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const nameOrId = btn.dataset.trigid;
      const label = btn.dataset.trigname;
      if (!confirm(`取消触发器「${label}」？`)) return;
      try {
        const r = mResp(await menuSend({
          type: 'menu.action', name: 'trigger', action: 'cancel',
          args: { nameOrId }, agent: selAid,
        }));
        if (r.error) toast(r.error.message || r.error.code, true);
        else { toast('✓ 已取消'); subscribe('triggers', { agent: trigSel.agent }); }
      } catch (e) { toast(e.message, true); }
    });
  });
}


function startApp() {
  initTabs();
  connect();
  $('#logout-btn').onclick = () => {
    localStorage.removeItem(TOKEN_KEY);
    showPairPage('已退出配对');
  };
}

// ── 主题切换 ──
function initTheme() {
  const saved = localStorage.getItem('ecTheme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = saved === 'dark' ? '☀️' : '🌙';
    btn.onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('ecTheme', next);
      btn.textContent = next === 'dark' ? '☀️' : '🌙';
      if (_hourlyChart) { _hourlyChart.dispose(); _hourlyChart = null; }
      if (_modelChart) { _modelChart.dispose(); _modelChart = null; }
      ['_monCpu', '_monMem', '_monMsg', '_monErr'].forEach(function (k) {
        if (window[k]) { window[k].dispose(); window[k] = null; }
      });
      loadUsageDashboard();
      if (currentView === 'monitor') renderMonitor(state.monitor);
    };
  }
}

// ── Usage Dashboard ──
let _hourlyChart = null;
let _modelChart = null;

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

async function loadUsageDashboard() {
  let data;
  try {
    const resp = await fetch(apiUrl('api/stats/dashboard'), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) data = null;
    else data = await resp.json();
  } catch { data = null; }

  // 无数据时渲染默认空状态
  const t = (data && data.today) ? data.today : { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_hit_rate: 0, call_count: 0 };
  var cards = $('#usage-cards');
  if (cards) {
    cards.innerHTML =
      '<div class="usage-card"><div class="card-value">' + fmtTokens(t.input_tokens) + '</div><div class="card-label">Input</div></div>' +
      '<div class="usage-card"><div class="card-value">' + fmtTokens(t.output_tokens) + '</div><div class="card-label">Output</div></div>' +
      '<div class="usage-card"><div class="card-value">' + fmtTokens(t.cache_read_tokens) + '</div><div class="card-label">Cache Read</div></div>' +
      '<div class="usage-card"><div class="card-value">' + (t.cache_hit_rate * 100).toFixed(1) + '%</div><div class="card-label">Cache Hit</div></div>' +
      '<div class="usage-card"><div class="card-value">' + t.call_count + '</div><div class="card-label">Calls</div></div>';
  }

  // Hourly stacked bar
  var hourlyEl = $('#usage-hourly-chart');
  if (hourlyEl && data.hourly && data.hourly.length) {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (!_hourlyChart) _hourlyChart = echarts.init(hourlyEl, isDark ? 'dark' : null);
    var hours = data.hourly.map(function(h) { return (h.hour.split(' ')[1] || h.hour); });
    _hourlyChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Input', 'Output', 'Cache'], top: 0, textStyle: { fontSize: 11 } },
      grid: { top: 30, bottom: 24, left: 50, right: 16 },
      xAxis: { type: 'category', data: hours, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { formatter: function(v) { return fmtTokens(v); } } },
      series: [
        { name: 'Input', type: 'bar', stack: 'tokens', data: data.hourly.map(function(h) { return h.input_tokens; }), itemStyle: { color: '#4f6ef7' } },
        { name: 'Output', type: 'bar', stack: 'tokens', data: data.hourly.map(function(h) { return h.output_tokens; }), itemStyle: { color: '#38a169' } },
        { name: 'Cache', type: 'bar', stack: 'tokens', data: data.hourly.map(function(h) { return h.cache_read_tokens; }), itemStyle: { color: '#dd6b20', opacity: 0.6 } },
      ]
    });
  }

  // Model pie
  var modelEl = $('#usage-model-chart');
  if (modelEl && data.top_models && data.top_models.length) {
    var isDark2 = document.documentElement.getAttribute('data-theme') === 'dark';
    if (!_modelChart) _modelChart = echarts.init(modelEl, isDark2 ? 'dark' : null);
    _modelChart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie', radius: ['35%', '70%'], center: ['50%', '55%'],
        label: { fontSize: 10 },
        data: data.top_models.map(function(m) { return { name: m.model.split('/').pop(), value: m.total_tokens }; }),
      }]
    });
  }

  // Top peers table
  var peersEl = $('#usage-top-peers');
  if (peersEl && data.top_peers && data.top_peers.length) {
    peersEl.innerHTML =
      '<thead><tr><th>#</th><th>Peer</th><th>Tokens</th><th>Calls</th></tr></thead>' +
      '<tbody>' + data.top_peers.map(function(p, i) {
        return '<tr><td>' + (i + 1) + '</td><td>' + p.peer_key + '</td><td>' + fmtTokens(p.total_tokens) + '</td><td>' + p.call_count + '</td></tr>';
      }).join('') + '</tbody>';
  }

}

// ── Usage Overview（全时段总览）──
async function loadUsageOverview() {
  let data;
  try {
    const resp = await fetch(apiUrl('api/stats/overview'), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    data = resp.ok ? await resp.json() : null;
  } catch { data = null; }

  const ts = (data && data.token_stats && data.token_stats.all_time) ? data.token_stats.all_time
    : { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, call_count: 0, cost_usd: 0, cost_cny: 0 };
  const sessionCount = (data && data.session_count) || 0;
  const msgIn = (data && data.msg_in) || 0;
  const msgOut = (data && data.msg_out) || 0;
  const totalIn = ts.input_tokens + ts.cache_read_tokens;
  const hitRate = totalIn > 0 ? (ts.cache_read_tokens / totalIn) * 100 : 0;

  const cardsEl = $('#ov-cards');
  if (cardsEl) {
    cardsEl.innerHTML = [
      ovCard(sessionCount, '会话数'),
      ovCard(msgIn, '收到消息'),
      ovCard(msgOut, '发出消息'),
      ovCard(ts.call_count, '模型调用'),
      ovCard(fmtTokens(ts.input_tokens), '输入 Token'),
      ovCard(fmtTokens(ts.output_tokens), '输出 Token'),
      ovCard(fmtTokens(ts.cache_creation_tokens), '缓存创建'),
      ovCard(fmtTokens(ts.cache_read_tokens), '缓存命中'),
      ovCard(hitRate.toFixed(1) + '%', '缓存命中率'),
      ovCard(fmtCost(ts.cost_usd, ts.cost_cny), '总花费'),
    ].join('');
  }

  const agentTbl = $('#ov-agent-table');
  const agents = (data && data.token_stats && data.token_stats.by_agent) || [];
  if (agentTbl) {
    if (!agents.length) {
      agentTbl.innerHTML = '<tbody><tr><td>暂无数据</td></tr></tbody>';
    } else {
      agentTbl.innerHTML =
        '<thead><tr><th>Agent</th><th>调用</th><th>输入</th><th>输出</th><th>缓存创建</th><th>缓存命中</th><th>花费</th></tr></thead>' +
        '<tbody>' + agents.map(function(a) {
          var name = a.agent_aid ? a.agent_aid.split('.')[0] : '(unknown)';
          return '<tr><td title="' + esc(a.agent_aid) + '">' + esc(name) + '</td>' +
            '<td>' + a.call_count + '</td>' +
            '<td>' + fmtTokens(a.input_tokens) + '</td>' +
            '<td>' + fmtTokens(a.output_tokens) + '</td>' +
            '<td>' + fmtTokens(a.cache_creation_tokens) + '</td>' +
            '<td>' + fmtTokens(a.cache_read_tokens) + '</td>' +
            '<td>' + fmtCost(a.cost_usd, a.cost_cny) + '</td></tr>';
        }).join('') + '</tbody>';
    }
  }
}

function ovCard(value, label) {
  return '<div class="usage-card"><div class="card-value">' + value + '</div><div class="card-label">' + label + '</div></div>';
}

function fmtCost(usd, cny) {
  var parts = [];
  if (usd > 0) parts.push('$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)));
  if (cny > 0) parts.push('¥' + (cny < 0.01 ? cny.toFixed(4) : cny.toFixed(2)));
  return parts.length ? parts.join(' / ') : '$0';
}

// ── Usage subtab switching ──
function initUsageSubtabs() {
  var btns = document.querySelectorAll('.usage-subtab');
  btns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      btns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var target = btn.getAttribute('data-subview');
      document.querySelectorAll('.usage-subpanel').forEach(function(p) {
        p.classList.remove('active');
        p.style.display = '';
      });
      var panel = $('#usage-' + target);
      if (panel) { panel.classList.add('active'); panel.style.display = ''; }
      if (target === 'overview') loadUsageOverview();
      else if (target === 'dashboard') loadUsageDashboard();
      else if (target === 'explorer') initExplorer();
    });
  });
}

// ── Explorer ──
var _explorerChart = null;
var _explorerInited = false;
var _expSelection = { type: null, key: null }; // { type: 'agent'|'peer', key: string } or null

function initExplorer() {
  if (_explorerInited) return;
  _explorerInited = true;
  var btn = $('#exp-query-btn');
  if (btn) btn.onclick = runExplorerQuery;
  // Default date range: last 7 days
  var now = new Date();
  var from = new Date(now.getTime() - 7 * 86400000);
  var fromEl = $('#exp-from');
  var toEl = $('#exp-to');
  if (fromEl) fromEl.value = from.toISOString().slice(0, 10);
  if (toEl) toEl.value = now.toISOString().slice(0, 10);
  // Load sidebar lists
  loadExplorerSidebar();
}

async function loadExplorerSidebar() {
  var token = localStorage.getItem(TOKEN_KEY);
  var headers = { Authorization: 'Bearer ' + token };
  try {
    var [agentsResp, peersResp] = await Promise.all([
      fetch(apiUrl('api/stats/agents'), { headers }),
      fetch(apiUrl('api/stats/peers'), { headers }),
    ]);
    var agents = agentsResp.ok ? await agentsResp.json() : [];
    var peers = peersResp.ok ? await peersResp.json() : [];
    renderExplorerSidebar(agents, peers);
  } catch {}
}

function renderExplorerSidebar(agents, peers) {
  var agentList = $('#exp-agent-list');
  var peerList = $('#exp-peer-list');
  if (!agentList || !peerList) return;

  // "All" item for agents
  var allHtml = '<div class="exp-sidebar-item active" data-type="all" data-key="">' +
    '<span class="item-name">全部</span></div>';

  agentList.innerHTML = allHtml + agents.map(function(a) {
    var name = a.agent_aid ? a.agent_aid.split('.')[0] : 'unknown';
    return '<div class="exp-sidebar-item" data-type="agent" data-key="' + escHtml(a.agent_aid) + '">' +
      '<span class="item-name" title="' + escHtml(a.agent_aid) + '">' + escHtml(name) + '</span>' +
      '<span class="item-meta">' + fmtTokens(a.input_tokens + a.output_tokens) + '</span></div>';
  }).join('');

  peerList.innerHTML = peers.map(function(p) {
    var name = p.peer_key || 'unknown';
    // 简化显示：去掉 channel# 前缀中的 aun#，保留核心部分
    var display = name.replace(/^aun#/, '').split('.')[0];
    return '<div class="exp-sidebar-item" data-type="peer" data-key="' + escHtml(p.peer_key) + '">' +
      '<span class="item-name" title="' + escHtml(name) + '">' + escHtml(display) + '</span>' +
      '<span class="item-meta">' + fmtTokens((p.input_tokens || 0) + (p.output_tokens || 0)) + '</span></div>';
  }).join('');

  // Bind click events
  var allItems = document.querySelectorAll('#exp-agent-list .exp-sidebar-item, #exp-peer-list .exp-sidebar-item');
  allItems.forEach(function(el) {
    el.addEventListener('click', function() {
      // Clear active from all
      allItems.forEach(function(x) { x.classList.remove('active'); });
      el.classList.add('active');
      var type = el.getAttribute('data-type');
      var key = el.getAttribute('data-key');
      if (type === 'all') {
        _expSelection = { type: null, key: null };
        $('#exp-selected-name').textContent = '全部';
      } else {
        _expSelection = { type: type, key: key };
        $('#exp-selected-name').textContent = key;
      }
      runExplorerQuery();
    });
  });
}

function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function runExplorerQuery() {
  var params = new URLSearchParams();
  var fromEl = $('#exp-from');
  var toEl = $('#exp-to');
  if (fromEl && fromEl.value) params.set('from', String(new Date(fromEl.value + 'T00:00:00').getTime()));
  if (toEl && toEl.value) params.set('to', String(new Date(toEl.value + 'T23:59:59').getTime()));
  // Inject selection from sidebar
  if (_expSelection.type === 'agent' && _expSelection.key) params.set('agent', _expSelection.key);
  if (_expSelection.type === 'peer' && _expSelection.key) params.set('peer', _expSelection.key);
  var modelEl = $('#exp-model');
  if (modelEl && modelEl.value) params.set('model', modelEl.value);
  var granEl = $('#exp-granularity');
  if (granEl) params.set('granularity', granEl.value);

  var data;
  try {
    var resp = await fetch(apiUrl('api/stats/explorer?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) return;
    data = await resp.json();
  } catch { return; }

  // Show/hide detail cards
  var cardsEl = $('#exp-detail-cards');
  if (data && data.length) {
    var totIn = 0, totOut = 0, totCache = 0, totCalls = 0;
    data.forEach(function(r) { totIn += r.input_tokens; totOut += r.output_tokens; totCache += r.cache_read_tokens; totCalls += r.call_count; });
    if (cardsEl) {
      cardsEl.style.display = 'flex';
      cardsEl.innerHTML =
        '<div class="usage-card"><div class="card-value">' + fmtTokens(totIn) + '</div><div class="card-label">Input</div></div>' +
        '<div class="usage-card"><div class="card-value">' + fmtTokens(totOut) + '</div><div class="card-label">Output</div></div>' +
        '<div class="usage-card"><div class="card-value">' + fmtTokens(totCache) + '</div><div class="card-label">Cache Read</div></div>' +
        '<div class="usage-card"><div class="card-value">' + totCalls + '</div><div class="card-label">Calls</div></div>';
    }
  } else {
    if (cardsEl) cardsEl.style.display = 'none';
  }

  if (!data || !data.length) {
    var tbl = $('#usage-explorer-table');
    if (tbl) tbl.innerHTML = '<tr><td>No data for selected range.</td></tr>';
    var chartEl = $('#usage-explorer-chart');
    if (chartEl && _explorerChart) { _explorerChart.dispose(); _explorerChart = null; }
    return;
  }

  // Chart
  var chartEl = $('#usage-explorer-chart');
  if (chartEl) {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (_explorerChart) { _explorerChart.dispose(); _explorerChart = null; }
    _explorerChart = echarts.init(chartEl, isDark ? 'dark' : null);
    var periods = data.map(function(r) { return r.period; });
    _explorerChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Input', 'Output'], top: 0, textStyle: { fontSize: 11 } },
      grid: { top: 30, bottom: 30, left: 60, right: 16 },
      xAxis: { type: 'category', data: periods, axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: 'value', axisLabel: { formatter: function(v) { return fmtTokens(v); } } },
      series: [
        { name: 'Input', type: 'line', data: data.map(function(r) { return r.input_tokens; }), smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#4f6ef7' } },
        { name: 'Output', type: 'line', data: data.map(function(r) { return r.output_tokens; }), smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#38a169' } },
      ]
    });
  }

  // Table
  var tbl = $('#usage-explorer-table');
  if (tbl) {
    tbl.innerHTML =
      '<thead><tr><th>Period</th><th>Input</th><th>Output</th><th>Cache↑</th><th>CacheHit</th><th>Calls</th></tr></thead>' +
      '<tbody>' + data.map(function(r) {
        return '<tr><td>' + r.period + '</td><td>' + fmtTokens(r.input_tokens) + '</td><td>' + fmtTokens(r.output_tokens) +
          '</td><td>' + fmtTokens(r.cache_creation_tokens) + '</td><td>' + fmtTokens(r.cache_read_tokens) +
          '</td><td>' + r.call_count + '</td></tr>';
      }).join('') + '</tbody>';
  }
}

// ── Monitor ──────────────────────────────────────
// 绑定时间范围切换按钮（只绑一次）
let _monRangeBound = false;
function bindMonRangeTabs() {
  if (_monRangeBound) return;
  var tabs = document.querySelectorAll('#view-monitor .mon-range');
  if (!tabs.length) return;
  tabs.forEach(function (btn) {
    btn.onclick = function () {
      monRange = btn.dataset.range;
      document.querySelectorAll('#view-monitor .mon-range').forEach(function (b) {
        b.classList.toggle('active', b.dataset.range === monRange);
      });
      // 切范围 → 重新订阅（源按 range 返回不同分辨率的 history）
      subscribe('monitor', { range: monRange });
    };
  });
  _monRangeBound = true;
}

function renderMonitor(data) {
  var wrap = $('#view-monitor .mon-layout');
  if (!wrap) return;
  bindMonRangeTabs();
  if (!data) { return; }
  if (!data.daemonRunning) {
    // 不清空骨架，仅在卡片区提示，避免破坏 toolbar
    var cardsEl0 = $('#mon-cards');
    if (cardsEl0) cardsEl0.innerHTML = '<div class="empty" style="grid-column:1/-1">daemon 未运行</div>';
    return;
  }

  var s = data.snapshot;
  // history 是三档分辨率对象 { fine, mid, coarse }；按当前范围选一档
  var rangeKey = { '2m': 'fine', '10m': 'mid', '1h': 'coarse' }[monRange] || 'fine';
  var hist = data.history || {};
  var h = Array.isArray(hist) ? hist : (hist[rangeKey] || []);
  var sys = s.system || {};
  var lh = (s.stats && s.stats.lastHour) || {};
  var recentErrs = (s.stats && s.stats.recentErrors) || [];
  var errRate = (lh.received > 0) ? ((lh.errors / lh.received) * 100).toFixed(1) + '%' : '0%';
  var agents = s.agents || [];
  var connected = agents.filter(function (a) { return a.status === 'connected'; }).length;

  // ── Stat cards ──
  var sysMemPct = (sys.memTotal > 0) ? Math.round((sys.memUsed / sys.memTotal) * 100) : 0;
  var cards = [
    ['Uptime', fmtDur(s.uptimeMs / 1000)],
    ['消息 (1h)', lh.received || 0],
    ['在线 Agent', connected + '/' + agents.length],
    ['平均响应', Math.round(lh.avgResponseMs || 0) + 'ms'],
    ['错误率', errRate],
    ['进程 CPU', (s.cpuPercent != null ? s.cpuPercent : 0) + '%'],
    ['系统 CPU', (sys.cpuPercent != null ? sys.cpuPercent : 0) + '%'],
    ['进程内存', fmtBytes(s.memory ? s.memory.rss : 0)],
    ['系统内存', sysMemPct + '%'],
  ];
  $('#mon-cards').innerHTML = cards.map(function (c) {
    return '<div class="usage-card"><div class="card-value">' + c[1] + '</div><div class="card-label">' + c[0] + '</div></div>';
  }).join('');

  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var ts = h.map(function (p) { return new Date(p.ts).toLocaleTimeString(); });
  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
  var cProc = css('--accent'), cSys = css('--orange');

  // ── CPU dual-line：进程 vs 系统 ──
  monDualLine('mon-cpu-chart', '_monCpu', ts, isDark, 'CPU 占用',
    [
      { name: 'evolclaw 进程', data: h.map(function (p) { return p.procCpu; }), color: cProc },
      { name: '整机系统', data: h.map(function (p) { return p.sysCpu != null ? p.sysCpu : null; }), color: cSys },
    ],
    function (v) { return Number(v).toFixed(1) + '%'; }, [0, 100]);

  // ── Memory dual-line：进程 RSS vs 系统已用 ──
  monDualLine('mon-mem-chart', '_monMem', ts, isDark, '内存占用',
    [
      { name: 'evolclaw RSS', data: h.map(function (p) { return p.procRss; }), color: cProc },
      { name: '系统已用', data: h.map(function (p) { return p.sysMemUsed != null ? p.sysMemUsed : null; }), color: cSys },
    ],
    function (v) { return fmtBytes(v); }, null);

  // ── Message activity bar chart ──
  var msgEl = $('#mon-msg-chart');
  if (msgEl) {
    if (!window._monMsg) window._monMsg = echarts.init(msgEl, isDark ? 'dark' : null);
    window._monMsg.setOption({
      title: { text: '近一小时活动', left: 'center', top: 4, textStyle: { fontSize: 12, color: isDark ? '#e6edf3' : '#1a202c' } },
      tooltip: { trigger: 'axis' },
      grid: { top: 36, bottom: 24, left: 44, right: 12 },
      xAxis: { type: 'category', data: ['Received', 'Completed', 'Errors', 'Interrupts', 'ToolErr'], axisLabel: { fontSize: 9 } },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{
        type: 'bar', barWidth: '45%',
        data: [
          { value: lh.received || 0, itemStyle: { color: css('--accent') } },
          { value: lh.completed || 0, itemStyle: { color: css('--green') } },
          { value: lh.errors || 0, itemStyle: { color: css('--red') } },
          { value: lh.interrupts || 0, itemStyle: { color: css('--orange') } },
          { value: lh.toolErrors || 0, itemStyle: { color: css('--blue') } },
        ],
      }],
      animation: false,
    });
  }

  // ── Error breakdown donut ──
  var errEntries = Object.entries(lh.errorsByType || {});
  var errEl = $('#mon-err-chart');
  if (errEl) {
    if (errEntries.length) {
      if (!window._monErr) window._monErr = echarts.init(errEl, isDark ? 'dark' : null);
      window._monErr.setOption({
        title: { text: '错误分布', left: 'center', top: 4, textStyle: { fontSize: 12, color: isDark ? '#e6edf3' : '#1a202c' } },
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        series: [{
          type: 'pie', radius: ['32%', '64%'], center: ['50%', '56%'],
          label: { fontSize: 10 },
          data: errEntries.map(function (e) { return { name: e[0], value: e[1] }; }),
        }],
        animation: false,
      });
    } else {
      if (window._monErr) { window._monErr.dispose(); window._monErr = null; }
      errEl.innerHTML = '<div class="empty" style="padding:24px;font-size:12px">近一小时无错误</div>';
    }
  }

  // ── Per-agent table ──
  var dotMap = { connected: 'on', reconnecting: 'idle', aid_blocked: 'idle', kicked: 'off', kicked_no_retry: 'off', failed: 'off', disabled: 'off' };
  $('#mon-agent-table-wrap').innerHTML =
    '<div class="mon-section-title">各 Agent 运行状态</div>' +
    '<table class="usage-table"><thead><tr>' +
    '<th>Agent</th><th>状态</th><th>收</th><th>发</th><th>流入</th><th>流出</th><th>对端</th><th>队列</th><th>处理中</th>' +
    '</tr></thead><tbody>' +
    (agents.length ? agents.map(function (a) {
      var st = a.stats || {};
      var dot = dotMap[a.status] || 'off';
      return '<tr>' +
        '<td title="' + esc(a.aid) + '">' + esc(a.agentName || shortAid(a.aid)) + '</td>' +
        '<td><span class="dot ' + dot + '"></span>' + esc(a.status) + '</td>' +
        '<td>' + (st.messagesReceived || 0) + '</td>' +
        '<td>' + (st.messagesSent || 0) + '</td>' +
        '<td>' + fmtBytes(st.bytesReceived || 0) + '</td>' +
        '<td>' + fmtBytes(st.bytesSent || 0) + '</td>' +
        '<td>' + (st.uniquePeerCount || 0) + '</td>' +
        '<td>' + (st.queued || 0) + '</td>' +
        '<td>' + (st.processing ? '⚙ ' + st.processing : 0) + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="9" style="text-align:center;color:var(--dim)">暂无 Agent</td></tr>') +
    '</tbody></table>';

  // ── Recent errors（替换原 Channels 位置）──
  $('#mon-err-list').innerHTML =
    '<div class="mon-section-title">最近错误 <span class="mon-section-sub">(最多 50 条)</span></div>' +
    (recentErrs.length
      ? '<div class="mon-err-rows">' + recentErrs.map(function (e) {
          var who = e.agentName ? shortAid(e.agentName) : '—';
          var tag = e.kind === 'tool'
            ? '<span class="mon-err-tag tag-tool">工具</span>'
            : '<span class="mon-err-tag tag-task">任务</span>';
          var label = e.kind === 'tool' ? (e.toolName || 'tool') : (e.errorType || 'error');
          var msg = e.message ? esc(e.message) : '';
          return '<div class="mon-err-row">' +
            '<span class="mon-err-time">' + fmtAgo(e.ts) + '</span>' +
            tag +
            '<span class="mon-err-aid" title="' + esc(e.agentName || '') + '">' + esc(who) + '</span>' +
            '<span class="mon-err-kind">' + esc(label) + '</span>' +
            '<span class="mon-err-msg" title="' + msg + '">' + msg + '</span>' +
            '</div>';
        }).join('') + '</div>'
      : '<div class="empty" style="padding:24px;font-size:12px">暂无错误记录</div>');
}

// 双线时序图（进程 + 系统）。series: [{name,data,color}]
function monDualLine(elId, varKey, times, isDark, title, series, fmtY, yRange) {
  var el = $('#' + elId);
  if (!el) return;
  if (!window[varKey]) window[varKey] = echarts.init(el, isDark ? 'dark' : null);
  window[varKey].setOption({
    title: { text: title, left: 'center', top: 4, textStyle: { fontSize: 12, color: isDark ? '#e6edf3' : '#1a202c' } },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var lines = [params[0].axisValue];
        params.forEach(function (pt) {
          if (pt.value == null) return;
          lines.push(pt.marker + pt.seriesName + ': ' + (fmtY ? fmtY(pt.value) : pt.value));
        });
        return lines.join('<br/>');
      },
    },
    grid: { top: 36, bottom: 24, left: 56, right: 12 },
    xAxis: { type: 'category', data: times, boundaryGap: false, axisLabel: { fontSize: 9 } },
    yAxis: {
      type: 'value',
      min: (yRange ? yRange[0] : 0),
      max: (yRange ? yRange[1] : undefined),
      axisLabel: { formatter: fmtY ? function (v) { return fmtY(v); } : '{value}' },
    },
    series: series.map(function (sr) {
      return {
        name: sr.name, type: 'line', data: sr.data, smooth: true, symbol: 'none',
        connectNulls: true,
        lineStyle: { width: 2, color: sr.color },
        areaStyle: { color: sr.color, opacity: 0.08 },
        itemStyle: { color: sr.color },
      };
    }),
    animation: false,
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initPairUI();
  initMsgTipFloat();

  // 初始化语言切换
  const langBtn = $('#lang-btn');
  if (langBtn) {
    langBtn.addEventListener('click', toggleLang);
  }
  updateI18n(); // 应用当前语言

  // 已有 token 直接进；否则先试本地直连免配对，失败再回落配对页。
  if (!localStorage.getItem(TOKEN_KEY)) {
    await tryLocalAutoPair();
  }
  if (localStorage.getItem(TOKEN_KEY)) {
    showApp();
    startApp();
    loadUsageDashboard();
    loadUsageOverview();
    initUsageSubtabs();
  } else {
    showPairPage();
  }
});

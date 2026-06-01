/* EvolClaw Watch — 前端 WS 客户端 + 三 tab 渲染 */

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'ecWatchToken';

// ── 配对 ──
async function pair(code) {
  const resp = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return resp.json();
}

function showPairPage() {
  $('#pair-page').style.display = 'flex';
  $('#app').style.display = 'none';
}
function showApp() {
  $('#pair-page').style.display = 'none';
  $('#app').style.display = 'flex';
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
    } catch (e) {
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
let currentView = 'aid';
let pendingSub = null;        // 重连后要恢复的订阅
const state = { aid: null, msg: null, session: null };

function setConnStatus(text, cls) {
  const el = $('#conn-status');
  el.textContent = text;
  el.className = 'conn-status' + (cls ? ' ' + cls : '');
}

function connect() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showPairPage(); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

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
    if (msg.type === 'snapshot' || msg.type === 'delta') {
      state[msg.view] = msg.data;
      if (msg.view === currentView) renderView(currentView);
    }
  };

  ws.onclose = (ev) => {
    if (ev.code === 1006 || ev.code === 4001) {
      // 可能是 token 失效
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

// 心跳
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}, 20000);

// ── Tab 切换 ──
let msgSel = { aid: null, peer: null };
let sessSel = { sessionId: null, project: null };
let sessSearch = '';

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  // 切换时按当前选择恢复订阅
  if (view === 'msg') subscribe('msg', { aid: msgSel.aid, peer: msgSel.peer });
  else if (view === 'session') subscribe('session', { sessionId: sessSel.sessionId, project: sessSel.project });
  else subscribe('aid', {});
  if (state[view]) renderView(view);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchView(tab.dataset.view);
  });
}

function renderView(view) {
  if (view === 'aid') renderAid(state.aid);
  else if (view === 'msg') renderMsg(state.msg);
  else if (view === 'session') renderSession(state.session);
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
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── AID 视图 ──
function renderAid(data) {
  const el = $('#view-aid');
  if (!data) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  const aids = data.aids || [];
  const statsByAid = {};
  for (const s of (data.stats || [])) statsByAid[s.aid] = s;

  let html = '';
  if (!data.daemonRunning) {
    html += '<div class="banner">⚠ EvolClaw 主进程未运行，仅显示最近活动记录</div>';
  }
  if (!aids.length) {
    html += '<div class="empty">暂无 AID</div>';
    el.innerHTML = html;
    return;
  }

  html += '<table><thead><tr>' +
    '<th>状态</th><th>AID</th><th>收</th><th>发</th><th>系统</th>' +
    '<th>入字节</th><th>出字节</th><th>peers</th><th>重连</th><th>最后活动</th><th>最近消息</th>' +
    '</tr></thead><tbody>';

  for (const a of aids) {
    const s = statsByAid[a.aid] || {};
    const status = a.status || (a.lastEvent === 'disconnected' ? 'disconnected' : 'connected');
    const dotCls = status === 'connected' ? 'on' : (status === 'reconnecting' ? 'idle' : 'off');
    const name = s.selfName || a.agentName || '';
    const lastTs = Math.max(s.lastReceivedAt || 0, s.lastSentAt || 0, a.lastActivity || 0);
    let preview = '';
    if (s.lastReceivedText && (s.lastReceivedAt || 0) >= (s.lastSentAt || 0)) {
      preview = '↓ ' + shortAid(s.lastReceivedFrom) + ': ' + s.lastReceivedText;
    } else if (s.lastSentText) {
      preview = '↑ ' + shortAid(s.lastSentTo) + ': ' + s.lastSentText;
    }
    html += '<tr>' +
      `<td><span class="dot ${dotCls}"></span>${esc(status)}</td>` +
      `<td>${esc(shortAid(a.aid))}${name ? ` <span style="color:var(--dim)">(${esc(name)})</span>` : ''}</td>` +
      `<td>${s.messagesReceived ?? 0}</td><td>${s.messagesSent ?? 0}</td>` +
      `<td>${s.systemReceived ?? 0}/${s.systemSent ?? 0}</td>` +
      `<td>${fmtBytes(s.bytesReceived)}</td><td>${fmtBytes(s.bytesSent)}</td>` +
      `<td>${s.uniquePeerCount ?? a.peerCount ?? 0}</td><td>${a.reconnectCount ?? 0}</td>` +
      `<td>${fmtAgo(lastTs)}</td>` +
      `<td class="preview">${esc(preview.replace(/\n/g, ' ').slice(0, 80))}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
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
    if (m.encrypt != null) tags.push(m.encrypt ? '密文' : '明文');
    if (m.chatmode) tags.push(m.chatmode === 'proactive' ? '自主' : '响应');
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
  const filtered = q
    ? transcripts.filter(t => (t.title || '').toLowerCase().includes(q) || (t.firstUser || '').toLowerCase().includes(q))
    : transcripts;

  // 左栏：过滤条 + 列表
  const projOpts = projects.map(p =>
    `<option value="${esc(p.encoded)}"${p.encoded === sessSel.project ? ' selected' : ''}>${esc(p.label)} (${p.count})</option>`
  ).join('');
  let listHtml = '<div class="sess-filter">' +
    `<select id="sess-project">${projOpts}</select>` +
    `<input id="sess-search" type="text" placeholder="搜索标题/首条消息…" value="${esc(sessSearch)}">` +
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
  for (const t of turns) {
    const usage = (t.inputTokens || t.outputTokens)
      ? `<span class="turn-usage">${esc(t.model || '')} · in ${t.inputTokens || 0} / out ${t.outputTokens || 0}</span>` : '';
    const roleLabel = { user: '用户', assistant: 'Claude', system: '系统' }[t.role] || t.role;
    html += `<div class="turn ${esc(t.role)}">` +
      `<div class="turn-head"><span class="turn-role">${esc(roleLabel)}</span>` +
      `<span class="turn-time">${t.ts ? fmtTime(t.ts) : ''}</span>${usage}</div>` +
      `<div class="turn-blocks">${renderBlocks(t.blocks || [])}</div></div>`;
  }
  detail.innerHTML = html;
  if (atBottom) detail.scrollTop = detail.scrollHeight;
}

function renderSessHeader(h) {
  if (!h || !h.sessionId) return '';
  const title = h.title || h.sessionId.slice(0, 8);
  const tok = (h.inputTokens || h.outputTokens)
    ? `<span class="sh-stat">🔢 in ${fmtNum(h.inputTokens)} / out ${fmtNum(h.outputTokens)}</span>` : '';
  let bind = '';
  if (h.bound) {
    const dot = h.online ? '<span class="dot on"></span>在线' : '<span class="dot idle"></span>离线';
    bind = `<span class="sh-stat">🔗 ${esc(h.boundChannel || '')} · ${esc(shortAid(h.boundPeer || ''))} ${dot}</span>`;
  }
  return '<div class="sess-header">' +
    `<div class="sh-title">${esc(title)}</div>` +
    '<div class="sh-stats">' +
    `<span class="sh-stat">💬 ${h.totalTurns || 0} 轮</span>` +
    (h.model ? `<span class="sh-stat">🤖 ${esc(h.model)}</span>` : '') +
    tok +
    (h.gitBranch ? `<span class="sh-stat">🌿 ${esc(h.gitBranch)}</span>` : '') +
    (h.version ? `<span class="sh-stat">cc ${esc(h.version)}</span>` : '') +
    bind +
    '</div>' +
    `<div class="sh-path" title="${esc(h.cwd || '')}">${esc(h.cwd || '')}</div>` +
    '</div>';
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

// ── 启动 ──
function startApp() {
  initTabs();
  connect();
}

window.addEventListener('DOMContentLoaded', () => {
  initPairUI();
  if (localStorage.getItem(TOKEN_KEY)) {
    showApp();
    startApp();
  } else {
    showPairPage();
  }
});






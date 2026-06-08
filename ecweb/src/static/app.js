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
let currentView = 'aid';
let pendingSub = null;        // 重连后要恢复的订阅
const state = { aid: null, msg: null, session: null, cache: null, control: null };

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
    if (msg.type === 'menu.response') {
      const pend = _menuPending[msg.requestId];
      if (pend) { delete _menuPending[msg.requestId]; pend.resolve(msg.data); }
      return;
    }
    if (msg.type === 'snapshot' || msg.type === 'delta') {
      state[msg.view] = msg.data;
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
let sessSearch = '';
let sessChatMode = false;   // false=完整视图，true=对话视图（折叠处理过程）

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  // 切换时按当前选择恢复订阅
  if (view === 'msg') subscribe('msg', { aid: msgSel.aid, peer: msgSel.peer });
  else if (view === 'session') subscribe('session', { sessionId: sessSel.sessionId, project: sessSel.project });
  else if (view === 'cache') subscribe('cache', {});
  else if (view === 'control') subscribe('control', {});
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
  else if (view === 'cache') renderCache(state.cache);
  else if (view === 'control') renderControl(state.control);
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

// ── Control 视图（通用 Menu 协议客户端）──

// 能力矩阵（协议 §3，cli 不暴露）
const MENU_CAPS = {
  pwd:        { query: true, group: 'System' },
  system:     { query: true, actions: ['check', 'restart', 'upgrade'], group: 'System' },
  baseagent:  { query: true, options: true, update: true, group: 'Agent 配置' },
  model:      { query: true, options: true, update: true, group: 'Agent 配置' },
  effort:     { query: true, options: true, update: true, group: 'Agent 配置' },
  chatmode:   { query: true, options: true, update: true, group: 'Agent 配置' },
  permission: { query: true, options: true, update: true, group: 'Agent 配置' },
  activity:   { query: true, options: true, update: true, group: 'Agent 配置' },
  dispatch:   { query: true, options: true, update: true, group: 'Agent 配置' },
  session:    { query: true, options: true, actions: ['stop', 'new', 'delete', 'compact', 'fork', 'switch'], group: '会话' },
  agent:      { options: true, actions: ['create', 'delete', 'enable', 'disable'], group: 'EvolAgent' },
  trigger:    { options: true, update: true, actions: ['set', 'cancel'], group: '触发器' },
};
const CTRL_ORDER = ['System', 'Agent 配置', '会话', 'EvolAgent', '触发器'];

let _ctrlBusy = false;  // 写操作进行中，避免轮询重渲染打断交互

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

function renderControl(data) {
  const el = $('#view-control');
  if (!data) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (_ctrlBusy) return;  // 交互中，跳过本次轮询渲染
  if (!data.daemonRunning) {
    el.innerHTML = '<div class="banner">⚠ EvolClaw 主进程未运行，Control 不可用</div>';
    return;
  }

  // 按 group 聚合
  const groups = {};
  for (const name of Object.keys(MENU_CAPS)) {
    const g = MENU_CAPS[name].group;
    (groups[g] ||= []).push(name);
  }

  let html = '<div class="ctrl-wrap">';
  for (const g of CTRL_ORDER) {
    if (!groups[g]) continue;
    html += `<section class="ctrl-section"><h2 class="ctrl-h">${esc(g)}</h2><div class="ctrl-grid">`;
    for (const name of groups[g]) {
      html += renderMenuCard(name, MENU_CAPS[name], data);
    }
    html += '</div></section>';
  }
  html += '</div>';
  el.innerHTML = html;
  bindControlEvents(el, data);
}

// ── 启动 ──
function startApp() {
  initTabs();
  connect();
  $('#logout-btn').onclick = () => {
    localStorage.removeItem(TOKEN_KEY);
    showPairPage('已退出配对');
  };
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






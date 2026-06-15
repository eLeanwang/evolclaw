/**
 * ec stats — Token 用量统计 CLI 命令。
 */

import { resolveRoot } from '../paths.js';
import { wantsHelp, getArgValue } from './help.js';
import { queryAggregated, queryTodaySummary, querySessionTurns, queryContextBreakdown, queryTopPeers, queryTopModels, queryMessageAggregated, queryPeerList, querySummary, queryPeerDaily, queryTaskModelCalls, querySessionModelCalls, type Granularity, type StatsFilter } from '../core/stats/query.js';
import { getBudgetStatus } from '../core/stats/budget.js';

const HELP = `ec stats — Token 用量与费用统计

Usage: ec stats [options]

时间范围:
  (无参数)                今日概览
  --today                 同上
  --hour                  最近 24 小时，按小时分组
  --week                  本周
  --month                 本月
  --from <date> --to <date>   任意区间（YYYY-MM-DD）

维度过滤（可组合）:
  --agent <aid>           指定 agent
  --peer <X>             对端（裸 AID 自动前缀 aun#，或 channel#id 格式）
  --model <model-id>      指定模型
  --session <id>          指定会话

聚合粒度:
  --by hour|day|week|month|model|peer|agent

快捷视图:
  --session <id>          单个会话明细
  --session <id> --last   会话最后一轮用量 + 累计（等价 status.completed）
  --context <id>          会话 context breakdown 细目
  --budget                预算状态
  --top-peers [--limit N] 对端排行
  --sql "<query>"         直接执行只读 SQL
  --rebuild               全量重建日聚合表 usage_daily（运维兜底/排查）
  --peers [--limit N]    私聊对端列表（带累计 token/calls/活跃日）
  --groups [--limit N]   群聊列表（同上）
  --summary              指定时间范围总消耗汇总（token/USD/CNY）
  --peer-detail <id>     指定对端 AID 或 peer_key，按天返回消耗明细
  --task-calls <taskId>   一个 task 的逐次大模型调用明细
  --session-calls <id>    一个会话的逐次大模型调用明细

输出格式:
  --format json           JSON 输出
  --help, -h              显示此帮助

示例:
  ec stats
  ec stats --month --agent bot.agentid.pub
  ec stats --peer alice.aid.pub
  ec stats --session abc123 --format json`;

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const BLUE  = '\x1b[34m';
const CYAN  = '\x1b[36m';
const YELLOW= '\x1b[33m';
const RED   = '\x1b[31m';

function fail(formatJson: boolean, code: string, message: string): never {
  if (formatJson) {
    console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
  } else {
    console.error(`❌ ${message} (${code})`);
  }
  process.exit(1);
}

function pad(s: string, n: number): string { return s.padEnd(n); }
function padR(s: string, n: number): string { return s.padStart(n); }
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return (n / 1_073_741_824).toFixed(1) + 'GB';
  if (n >= 1_048_576)     return (n / 1_048_576).toFixed(1) + 'MB';
  if (n >= 1_024)         return (n / 1_024).toFixed(1) + 'KB';
  return n + 'B';
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || '').length)));
  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  console.log(headers.map((h, i) => ` ${pad(h, widths[i])} `).join('│'));
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((c, i) => ` ${pad(c || '', widths[i])} `).join('│'));
  }
}

function parseDateArg(s: string): number {
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d.getTime();
}

export async function handleStats(args: string[]): Promise<void> {
  // Help
  if (wantsHelp(args)) { console.log(HELP); return; }

  const home = resolveRoot();
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  const isJson = flags.format === 'json';

  // 全量重建日聚合表（运维兜底/排查），不依赖时间范围。
  if (flags.rebuild) {
    const { rebuildDailyRollup, getDb } = await import('../core/stats/db.js');
    const { resolvePrices } = await import('../core/stats/price-resolver.js');
    const startedAt = Date.now();

    // 步骤1：回填 usage_events 的 cost 字段（只处理 cost_official_usd IS NULL 的行）
    console.log(`${CYAN}正在回填历史事件的费用数据...${RESET}`);
    const db = getDb(home);
    if (!db) fail(isJson, 'REBUILD_FAILED', 'usage_events 回填失败（DB 不可用）');

    const allEvents = db.prepare(`SELECT * FROM usage_events WHERE cost_official_usd IS NULL`).all() as any[];
    let updated = 0;
    const batchSize = 1000;

    for (let i = 0; i < allEvents.length; i += batchSize) {
      db.exec('BEGIN');
      const batch = allEvents.slice(i, i + batchSize);
      for (const event of batch) {
        const prices = resolvePrices(home, event);  // 不传 gatewayPricing，全走本地 JSONL
        db.prepare(`
          UPDATE usage_events
          SET cost_official_usd = ?, cost_official_cny = ?,
              cost_gateway_usd = ?, cost_gateway_cny = ?
          WHERE id = ?
        `).run(
          prices.official?.usd ?? null, prices.official?.cny ?? null,
          prices.gateway?.usd ?? null, prices.gateway?.cny ?? null,
          event.id
        );
        updated++;
      }
      db.exec('COMMIT');
      if (!isJson && (i + batch.length) % 5000 === 0) {
        console.log(`  已处理 ${i + batch.length}/${allEvents.length} 条事件...`);
      }
    }
    console.log(`${GREEN}✓ 回填完成：${updated} 条事件${RESET}`);

    // 步骤2：重建 usage_daily（会自动聚合 cost 字段）
    console.log(`${CYAN}正在重建日聚合表...${RESET}`);
    const n = rebuildDailyRollup(home);
    const ms = Date.now() - startedAt;

    if (n < 0) fail(isJson, 'REBUILD_FAILED', 'usage_daily 重建失败（DB 不可用或 SQL 错误）');
    if (isJson) { console.log(JSON.stringify({ ok: true, events_backfilled: updated, daily_rows: n, duration_ms: ms }, null, 2)); }
    else { console.log(`${GREEN}✓ usage_daily 重建完成：${n} 行，总耗时 ${ms}ms${RESET}`); }
    return;
  }

  // Determine time range
  let from_ts: number | undefined;
  let to_ts: number | undefined;
  let granularity: Granularity = 'day';

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (flags.from && typeof flags.from === 'string') {
    from_ts = parseDateArg(flags.from);
    if (flags.to && typeof flags.to === 'string') to_ts = parseDateArg(flags.to);
  } else if (flags.hour) {
    from_ts = Date.now() - 24 * 60 * 60 * 1000;
    granularity = 'hour';
  } else if (flags.week) {
    const dayOfWeek = now.getDay();
    from_ts = todayStart - dayOfWeek * 86400000;
    granularity = 'day';
  } else if (flags.month) {
    from_ts = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    granularity = 'day';
  } else {
    // default: today
    from_ts = todayStart;
    granularity = 'hour';
  }

  // Granularity override
  if (flags.by && typeof flags.by === 'string') {
    if (['hour', 'day', 'week', 'month', 'model', 'peer', 'agent'].includes(flags.by)) {
      granularity = flags.by as Granularity;
    }
  }

  // Filter
  const filter: StatsFilter = { from_ts, to_ts };
  if (flags.agent && typeof flags.agent === 'string') filter.agent_aid = flags.agent;
  if (flags.peer && typeof flags.peer === 'string') {
    // AUN 简写：不含 # 时默认 aun 渠道
    filter.peer_key = flags.peer.includes('#') ? flags.peer : `aun#${encodeURIComponent(flags.peer)}`;
  }
  if (flags.model && typeof flags.model === 'string') filter.model = flags.model;
  if (flags.session && typeof flags.session === 'string') filter.session_id = flags.session;

  // ── 结构化查询：私聊/群聊列表、总消耗汇总、对端按天明细 ──────────────────
  if (flags.peers || flags.groups) {
    const peerType = flags.peers ? 'private' : 'group';
    const limit = typeof flags.limit === 'string' ? parseInt(flags.limit) || 50 : 50;
    const rows = queryPeerList(home, { peer_type: peerType, from_ts, to_ts, agent_aid: filter.agent_aid, limit });
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`\n${BOLD}📊 ${peerType === 'private' ? '私聊' : '群聊'}列表${RESET}\n`);
    if (!rows.length) { console.log('  (无数据)'); return; }
    const headers = ['#', 'Peer ID', 'Tokens', 'Calls', 'Sessions', 'First', 'Last'];
    const tableRows = rows.map((r, i) => [
      String(i + 1), r.peer_id, fmtTokens(r.total_tokens), String(r.calls),
      String(r.session_count), r.first_day, r.last_day,
    ]);
    printTable(headers, tableRows);
    console.log();
    return;
  }

  if (flags.summary) {
    const result = querySummary(home, { from_ts, to_ts, agent_aid: filter.agent_aid, peer_key: filter.peer_key });
    if (isJson) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`\n${BOLD}📊 用量汇总${RESET}\n`);
    console.log(`  Input:         ${fmtTokens(result.input_tokens)}`);
    console.log(`  Output:        ${fmtTokens(result.output_tokens)}`);
    console.log(`  Cache read:    ${fmtTokens(result.cache_read_tokens)}`);
    console.log(`  Cache write:   ${fmtTokens(result.cache_creation_tokens)}`);
    console.log(`  Total tokens:  ${fmtTokens(result.total_tokens)}`);
    console.log(`  Calls:         ${result.calls}`);
    const totalIn = result.input_tokens + result.cache_read_tokens;
    const cacheHitRate = totalIn > 0 ? (result.cache_read_tokens / totalIn * 100).toFixed(1) : '0.0';
    console.log(`  Cache hit:     ${cacheHitRate}%`);
    console.log();
    console.log(`${BOLD}Cost:${RESET}`);
    if (result.cost_official_usd > 0 || result.cost_official_cny > 0) {
      console.log(`  Official:      ${GREEN}$${result.cost_official_usd.toFixed(4)}${RESET}  ¥${result.cost_official_cny.toFixed(4)}`);
    }
    if (result.cost_gateway_usd > 0 || result.cost_gateway_cny > 0) {
      console.log(`  Gateway:       ${GREEN}$${result.cost_gateway_usd.toFixed(4)}${RESET}  ¥${result.cost_gateway_cny.toFixed(4)}`);
    }
    console.log();
    return;
  }

  if (flags['peer-detail'] && typeof flags['peer-detail'] === 'string') {
    const input = flags['peer-detail'];
    // 含 # 视为完整 peer_key（精确匹配），否则视为裸 peer_id（LIKE 匹配）
    const peerOpts = input.includes('#')
      ? { peer_key: input, from_ts, to_ts, agent_aid: filter.agent_aid }
      : { peer_id: input,  from_ts, to_ts, agent_aid: filter.agent_aid };
    const rows = queryPeerDaily(home, peerOpts);
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('No data for the specified peer and range.'); return; }
    console.log(`\n${BOLD}📊 对端明细 — ${input}${RESET}\n`);
    const headers = ['Day', 'Input', 'Output', 'Cache', 'Calls', 'HitRate', 'USD', 'CNY'];
    const tableRows = rows.map(r => [
      r.period, fmtTokens(r.input_tokens), fmtTokens(r.output_tokens),
      fmtTokens(r.cache_read_tokens), String(r.call_count),
      (r.cache_hit_rate * 100).toFixed(0) + '%',
      r.usd > 0 ? '$' + r.usd.toFixed(4) : '—',
      r.cny > 0 ? '¥' + r.cny.toFixed(4) : '—',
    ]);
    printTable(headers, tableRows);
    console.log();
    return;
  }

  // 逐次大模型调用明细
  if ((flags['task-calls'] && typeof flags['task-calls'] === 'string') ||
      (flags['session-calls'] && typeof flags['session-calls'] === 'string')) {
    const byTask = typeof flags['task-calls'] === 'string';
    const key = (byTask ? flags['task-calls'] : flags['session-calls']) as string;
    const rows = byTask ? queryTaskModelCalls(home, key) : querySessionModelCalls(home, key);
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('No model calls found.'); return; }
    console.log(`\n${BOLD}📊 大模型调用明细 — ${key}${RESET}\n`);
    const headers = ['#', 'Model', 'Input', 'Output', 'CacheR', 'CacheW', 'Task', 'Deg'];
    const tableRows = rows.map(r => [
      String(r.call_index),
      r.model.split('-').slice(0, 3).join('-'),
      fmtTokens(r.input_tokens), fmtTokens(r.output_tokens),
      fmtTokens(r.cache_read_tokens), fmtTokens(r.cache_creation_tokens),
      r.task_id, r.degraded ? 'Y' : '',
    ]);
    printTable(headers, tableRows);
    console.log();
    return;
  }

  // Special views
  if (flags.sql && typeof flags.sql === 'string') {
    // 直接执行 SQL（只读，仅 SELECT）
    const sql = flags.sql.trim();
    if (!/^\s*select/i.test(sql)) {
      console.error('Only SELECT queries are allowed.');
      return;
    }
    const { openReadonlyDb, getDbPath } = await import('../core/stats/db.js');
    const db = openReadonlyDb(getDbPath(home));
    if (!db) { console.error('Stats DB not available.'); return; }
    try {
      const rows = db.prepare(sql).all() as any[];
      if (isJson) { console.log(JSON.stringify(rows, null, 2)); }
      else if (rows.length === 0) { console.log('(empty result)'); }
      else {
        const keys = Object.keys(rows[0]);
        printTable(keys, rows.map(r => keys.map(k => String(r[k] ?? ''))));
      }
    } catch (e: any) {
      console.error(`SQL error: ${e.message || e}`);
    } finally { db.close(); }
    return;
  }

  if (flags.budget) {
    const status = getBudgetStatus(home, filter.agent_aid, filter.peer_key);
    if (isJson) { console.log(JSON.stringify(status, null, 2)); return; }
    console.log(`\n${BOLD}📊 Budget Status${RESET}\n`);
    console.log(`  Daily limit:       ${status.daily_limit_usd >= 0 ? '$' + status.daily_limit_usd.toFixed(2) : 'unlimited'}`);
    console.log(`  Daily used:        ${GREEN}$${status.daily_used_usd.toFixed(4)}${RESET}`);
    console.log(`  Daily remaining:   ${status.daily_remaining_usd >= 0 ? '$' + status.daily_remaining_usd.toFixed(2) : 'unlimited'}`);
    console.log(`  Monthly limit:     ${status.monthly_limit_usd >= 0 ? '$' + status.monthly_limit_usd.toFixed(2) : 'unlimited'}`);
    console.log(`  Monthly used:      ${GREEN}$${status.monthly_used_usd.toFixed(4)}${RESET}`);
    console.log(`  Monthly remaining: ${status.monthly_remaining_usd >= 0 ? '$' + status.monthly_remaining_usd.toFixed(2) : 'unlimited'}`);
    console.log(`  Usage:             ${status.pct_used > 80 ? RED : status.pct_used > 60 ? YELLOW : GREEN}${status.pct_used.toFixed(1)}%${RESET}`);
    console.log(`  Hard blocked:      ${status.hard_blocked ? RED + 'YES' + RESET : 'no'}`);
    console.log(`  Soft warn:         ${status.soft_warn ? YELLOW + 'yes' + RESET : 'no'}`);
    console.log(`  Auto warn:         ${status.auto_warn ? YELLOW + 'yes' + RESET : 'no'}`);
    console.log();
    return;
  }

  if (flags.context && typeof flags.context === 'string') {
    const rows = queryContextBreakdown(home, flags.context);
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('No context breakdown data for this session.'); return; }
    console.log(`\n${BOLD}📊 Context Breakdown — session ${flags.context}${RESET}\n`);
    const headers = ['Turn', 'System', 'Tools', 'MCP', 'Agents', 'Memory', 'Skills', 'Messages', 'Free', 'Total', 'Max'];
    const tableRows = rows.map(r => [
      String(r.turn_count),
      fmtTokens(r.system_prompt ?? 0), fmtTokens(r.system_tools ?? 0),
      fmtTokens(r.mcp_tools ?? 0), fmtTokens(r.custom_agents ?? 0),
      fmtTokens(r.memory_files ?? 0), fmtTokens(r.skills ?? 0),
      fmtTokens(r.messages ?? 0), fmtTokens(r.free_space ?? 0),
      fmtTokens(r.total_estimated ?? 0), fmtTokens(r.max_tokens ?? 0),
    ]);
    printTable(headers, tableRows);
    console.log();
    return;
  }

  if (flags['top-peers']) {
    const limit = typeof flags.limit === 'string' ? parseInt(flags.limit) || 10 : 10;
    const rows = queryTopPeers(home, filter, limit);
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`\n${BOLD}📊 Top Peers${RESET}\n`);
    const headers = ['#', 'Peer', 'Tokens', 'Calls'];
    const tableRows = rows.map((r, i) => [
      String(i + 1), r.peer_key, fmtTokens(r.total_tokens), String(r.call_count),
    ]);
    printTable(headers, tableRows);
    console.log();
    return;
  }

  if (flags['top-models']) {
    const limit = typeof flags.limit === 'string' ? parseInt(flags.limit) || 10 : 10;
    const rows = queryTopModels(home, filter, limit);
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`\n${BOLD}📊 Top Models${RESET}\n`);
    const headers = ['#', 'Model', 'Tokens', 'Calls'];
    const tableRows = rows.map((r, i) => [
      String(i + 1), r.model, fmtTokens(r.total_tokens), String(r.call_count),
    ]);
    printTable(headers, tableRows);
    console.log();
    return;
  }

  if (flags.traffic) {
    const rows = queryMessageAggregated(home, granularity, filter);
    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('No traffic data for the selected range.'); return; }
    const periodLabel = flags.hour ? 'Last 24h' : flags.week ? 'This Week' : flags.month ? 'This Month' : 'Today';
    console.log(`\n${BOLD}📊 ${periodLabel} — Network Traffic${RESET}\n`);
    const headers = ['Period', 'Msg In', 'Msg Out', 'Bytes In', 'Bytes Out'];
    const tableRows = rows.map(r => [
      r.period,
      String(r.msg_in), String(r.msg_out),
      fmtBytes(r.bytes_in), fmtBytes(r.bytes_out),
    ]);
    printTable(headers, tableRows);
    const totIn = rows.reduce((s, r) => s + r.msg_in, 0);
    const totOut = rows.reduce((s, r) => s + r.msg_out, 0);
    const totBIn = rows.reduce((s, r) => s + r.bytes_in, 0);
    const totBOut = rows.reduce((s, r) => s + r.bytes_out, 0);
    console.log(`\n  ${DIM}Total: in=${totIn} out=${totOut} bytes_in=${fmtBytes(totBIn)} bytes_out=${fmtBytes(totBOut)}${RESET}\n`);
    return;
  }

  if (flags.session && typeof flags.session === 'string') {
    const rows = querySessionTurns(home, flags.session);

    // --last: 返回最后一轮用量 + 会话累计（与 status.completed metadata 等价）
    if (flags.last) {
      if (!rows.length) {
        if (isJson) { console.log(JSON.stringify({ ok: false, error: 'No usage data for this session' }, null, 2)); }
        else { console.log('No usage data for this session.'); }
        return;
      }
      const last = rows[rows.length - 1];
      const totIn = rows.reduce((s, r) => s + r.input_tokens, 0);
      const totOut = rows.reduce((s, r) => s + r.output_tokens, 0);
      const totCacheRead = rows.reduce((s, r) => s + r.cache_read_tokens, 0);
      const totCacheCreation = rows.reduce((s, r) => s + r.cache_creation_tokens, 0);
      const totUsd = rows.reduce((s, r) => s + r.usd, 0);
      const totCny = rows.reduce((s, r) => s + r.cny, 0);
      const totOfficialUsd = rows.reduce((s, r) => s + r.cost_official_usd, 0);
      const totOfficialCny = rows.reduce((s, r) => s + r.cost_official_cny, 0);
      const totGatewayUsd = rows.reduce((s, r) => s + r.cost_gateway_usd, 0);
      const totGatewayCny = rows.reduce((s, r) => s + r.cost_gateway_cny, 0);
      const totCacheAll = totIn + totCacheRead;
      const sessionCacheHitRate = totCacheAll > 0 ? totCacheRead / totCacheAll : 0;

      // model_spec
      const { resolveModelSpec } = await import('../core/stats/billing.js');
      const spec = resolveModelSpec(home, last.model);

      const result = {
        turn: {
          input_tokens: last.input_tokens,
          output_tokens: last.output_tokens,
          cache_read_tokens: last.cache_read_tokens,
          cache_creation_tokens: last.cache_creation_tokens,
          model: last.model,
          cost_usd: last.usd,
          cost_cny: last.cny,
          // 原价 + 网关实际价
          cost: {
            official: { usd: last.cost_official_usd, cny: last.cost_official_cny },
            gateway:  { usd: last.cost_gateway_usd,  cny: last.cost_gateway_cny },
          },
          cache_hit_rate: last.cache_read_tokens / ((last.input_tokens + last.cache_read_tokens) || 1),
          context_window_pct: last.context_window_pct ?? 0,
          duration_ms: last.duration_ms ?? 0,
        },
        session_total: {
          input_tokens: totIn,
          output_tokens: totOut,
          cache_read_tokens: totCacheRead,
          cache_creation_tokens: totCacheCreation,
          cost_usd: totUsd,
          cost_cny: totCny,
          cost: {
            official: { usd: totOfficialUsd, cny: totOfficialCny },
            gateway:  { usd: totGatewayUsd,  cny: totGatewayCny },
          },
          call_count: rows.length,
          cache_hit_rate: sessionCacheHitRate,
        },
        model_spec: {
          context_window: spec.context_window,
          max_input_tokens: spec.max_input_tokens,
          max_output_tokens: spec.max_output_tokens,
        },
      };

      if (isJson) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`\n${BOLD}📊 Session Last Turn — ${flags.session}${RESET}\n`);
      console.log(`  Model:         ${CYAN}${result.turn.model}${RESET}`);
      console.log(`  Input:         ${fmtTokens(result.turn.input_tokens)}`);
      console.log(`  Output:        ${fmtTokens(result.turn.output_tokens)}`);
      console.log(`  Cache read:    ${fmtTokens(result.turn.cache_read_tokens)}`);
      console.log(`  Cache hit:     ${(result.turn.cache_hit_rate * 100).toFixed(1)}%`);
      console.log(`  Context:       ${result.turn.context_window_pct}%`);
      console.log(`  Cost:          ${result.turn.cost_usd > 0 ? GREEN + '$' + result.turn.cost_usd.toFixed(4) + RESET : ''}${result.turn.cost_cny > 0 ? GREEN + ' ¥' + result.turn.cost_cny.toFixed(4) + RESET : ''}`);
      console.log(`  Duration:      ${result.turn.duration_ms}ms`);
      console.log(`\n  ${DIM}Session total: input=${fmtTokens(result.session_total.input_tokens)} output=${fmtTokens(result.session_total.output_tokens)} USD=$${totUsd.toFixed(4)} CNY=¥${totCny.toFixed(4)} calls=${result.session_total.call_count}${RESET}\n`);
      return;
    }

    if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('No usage data for this session.'); return; }
    console.log(`\n${BOLD}📊 Session ${flags.session}${RESET}\n`);
    const headers = ['Time', 'Model', 'Input', 'Output', 'Cache', 'Ctx%', 'USD', 'CNY'];
    const tableRows = rows.map(r => {
      const t = new Date(r.ts).toLocaleTimeString();
      return [
        t, r.model.split('-').slice(0, 2).join('-'),
        fmtTokens(r.input_tokens), fmtTokens(r.output_tokens),
        fmtTokens(r.cache_read_tokens),
        r.context_window_pct != null ? r.context_window_pct.toFixed(0) + '%' : '—',
        r.usd > 0 ? '$' + r.usd.toFixed(4) : '—',
        r.cny > 0 ? '¥' + r.cny.toFixed(4) : '—',
      ];
    });
    printTable(headers, tableRows);
    // Totals
    const totIn = rows.reduce((s, r) => s + r.input_tokens, 0);
    const totOut = rows.reduce((s, r) => s + r.output_tokens, 0);
    const totUsd = rows.reduce((s, r) => s + r.usd, 0);
    const totCny = rows.reduce((s, r) => s + r.cny, 0);
    console.log(`\n  ${DIM}Total: input=${fmtTokens(totIn)} output=${fmtTokens(totOut)} USD=$${totUsd.toFixed(4)} CNY=¥${totCny.toFixed(4)} turns=${rows.length}${RESET}\n`);
    return;
  }

  // Default: aggregated view
  const rows = queryAggregated(home, granularity, filter);
  if (isJson) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('No usage data for the selected range.'); return; }

  const periodLabel = flags.hour ? 'Last 24h' : flags.week ? 'This Week' : flags.month ? 'This Month' : 'Today';
  console.log(`\n${BOLD}📊 ${periodLabel} — Token Usage${RESET}\n`);

  const headers = ['Period', 'Input', 'Output', 'Cache↑', 'CacheHit', 'Calls', 'HitRate'];
  const tableRows = rows.map(r => [
    r.period,
    fmtTokens(r.input_tokens), fmtTokens(r.output_tokens),
    fmtTokens(r.cache_creation_tokens), fmtTokens(r.cache_read_tokens),
    String(r.call_count),
    (r.cache_hit_rate * 100).toFixed(0) + '%',
  ]);
  printTable(headers, tableRows);

  // Summary
  const totIn = rows.reduce((s, r) => s + r.input_tokens, 0);
  const totOut = rows.reduce((s, r) => s + r.output_tokens, 0);
  const totCalls = rows.reduce((s, r) => s + r.call_count, 0);
  const totCacheRead = rows.reduce((s, r) => s + r.cache_read_tokens, 0);
  const overallHit = (totIn + totCacheRead) > 0 ? (totCacheRead / (totIn + totCacheRead) * 100).toFixed(1) : '0';
  console.log(`\n  ${DIM}Total: input=${fmtTokens(totIn)} output=${fmtTokens(totOut)} calls=${totCalls} cache_hit_rate=${overallHit}%${RESET}\n`);
}

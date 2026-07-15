import path from 'path';
import { getArgValue, isHelpFlag, wantsHelp } from './help.js';

function formatTimeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  return `${day}天前`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ==================== Agent ====================

export async function cmdAgent(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';

  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw agent <command>

Commands:
  list                    列出所有 agent
  show <aid>              查看 agent 详情（身份 + 配置 + 连接 + 会话 + 路径）
  new [aid]               交互式创建 agent
  new <aid> --non-interactive ...  非交互式创建
  enable <aid>            启用 agent
  disable <aid>           停用 agent
  get <aid> <key>         读取单个配置字段（支持点路径）
  set <aid> <key> <val>   修改单个配置字段（支持点路径）
  rename <aid> <name>     修改 agent.md 中的显示名称
  ready <aid>              标记 bootstrap 完成，进入 active 状态
  reload [aid]            热重载配置（无参数=全量 resync）
  delete <aid> [--purge]  删除 agent

Options:
  --format json           输出 JSON 格式
  --help, -h              各子命令均支持，查看详细用法

示例:
  evolclaw agent list
  evolclaw agent show mybot.agentid.pub
  evolclaw agent new mybot.agentid.pub
  evolclaw agent enable mybot.agentid.pub
  evolclaw agent get mybot.agentid.pub active_baseagent
  evolclaw agent set mybot.agentid.pub active_baseagent codex
  evolclaw agent rename mybot.agentid.pub "New Name"
  evolclaw agent ready mybot.agentid.pub
  evolclaw agent delete mybot.agentid.pub --purge`);
    return;
  }

  const {
    agentList, agentShow, agentCreateInteractive, agentCreateNonInteractive,
    agentReload, agentEnable, agentDisable,
    agentGet, agentSet, agentRename, agentDelete, agentReady,
  } = await import('./agent.js');

  // --- list ---
  if (sub === 'list') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent list [--format json]

列出所有 agent，显示名称、状态、渠道、项目、基座、最后活跃时间。`);
      return;
    }
    const result = await agentList();
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.agents.length === 0) {
      console.log('No agents configured.');
      return;
    }
    // 表头跟随系统语言
    const isChinese = (process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase().includes('zh');
    const headers = isChinese
      ? { name: '名称', personal: 'Personal名', status: '状态', channels: '渠道', project: '项目', baseagent: '基座', lastActive: '最后活跃' }
      : { name: 'NAME', personal: 'PERSONAL', status: 'STATUS', channels: 'CHANNELS', project: 'PROJECT', baseagent: 'BASEAGENT', lastActive: 'LAST ACTIVE' };

    // 计算各列实际需要的宽度
    let maxNameLen = headers.name.length;
    let maxPersonalLen = headers.personal.length;
    let maxStatusLen = headers.status.length;
    let maxChannelsLen = headers.channels.length;
    let maxProjectLen = headers.project.length;
    let maxBaseagentLen = headers.baseagent.length;

    for (const info of result.agents) {
      maxNameLen = Math.max(maxNameLen, info.name.length);
      maxPersonalLen = Math.max(maxPersonalLen, (info.personalName || '—').length);
      maxStatusLen = Math.max(maxStatusLen, (info.status || 'stopped').length);
      const channelsStr = info.channels?.length > 0 ? info.channels.join(', ') : '—';
      maxChannelsLen = Math.max(maxChannelsLen, channelsStr.length);
      const projectStr = info.projectPath ? path.basename(info.projectPath) : '—';
      maxProjectLen = Math.max(maxProjectLen, projectStr.length);
      maxBaseagentLen = Math.max(maxBaseagentLen, (info.baseagent || '—').length);
    }

    // 加 2 作为列间距
    const colName = maxNameLen + 2;
    const colPersonal = maxPersonalLen + 2;
    const colStatus = maxStatusLen + 2;
    const colChannels = maxChannelsLen + 1;
    const colProject = maxProjectLen + 2;
    const colBaseagent = maxBaseagentLen + 2;

    console.log(
      headers.name.padEnd(colName) + headers.personal.padEnd(colPersonal) + headers.status.padEnd(colStatus) + headers.channels.padEnd(colChannels) +
      headers.project.padEnd(colProject) + headers.baseagent.padEnd(colBaseagent) + headers.lastActive
    );
    for (const info of result.agents) {
      const name = info.name;
      const personal = info.personalName || '—';
      const status = info.status || 'stopped';
      const channels = info.channels?.length > 0 ? info.channels.join(', ') : '—';
      const project = info.projectPath ? path.basename(info.projectPath) : '—';
      const baseagent = info.baseagent || '—';
      const lastActive = info.lastActivity ? formatTimeAgo(Date.now() - info.lastActivity) : '—';
      console.log(
        name.padEnd(colName) + personal.padEnd(colPersonal) + status.padEnd(colStatus) + channels.padEnd(colChannels) +
        project.padEnd(colProject) + baseagent.padEnd(colBaseagent) + lastActive
      );
    }
    return;
  }

  // --- new ---
  if (sub === 'new') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent new [aid]                    交互式创建
     evolclaw agent new <aid> --non-interactive [选项]

非交互模式选项:
  --baseagent <claude|codex|gemini>   默认: PATH 中第一个可用
  --project <absolute path>           必填
  --owner <aid>
  --name <display-name>
  --description <text>
  --force                             覆盖已有 config.json
  --format json                       输出 JSON

示例:
  evolclaw agent new mybot.agentid.pub
  evolclaw agent new mybot.agentid.pub --non-interactive --project /abs/path --baseagent claude`);
      return;
    }
    const name = args[1];
    const nonInteractive = args.includes('--non-interactive');
    if (nonInteractive) {
      if (!name) {
        console.error('Usage: evolclaw agent new <aid> --non-interactive ...');
        process.exit(1);
      }
      const getArg = (flag: string): string | undefined => {
        const idx = args.indexOf(flag);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
      };
      const result = await agentCreateNonInteractive({
        aid: name,
        baseagent: getArg('--baseagent'),
        project: getArg('--project') || '',
        owner: getArg('--owner'),
        name: getArg('--name'),
        description: getArg('--description'),
        force: args.includes('--force'),
      });
      if (!result.ok) {
        if (formatJson) { console.log(JSON.stringify(result)); }
        else { console.error(`❌ ${result.error}`); }
        process.exit(1);
      }
      if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`✓ Created: ${result.configPath}`);
        console.log(result.agentmdUploaded
          ? '  ✓ agent.md 已发布'
          : '  ⚠ agent.md 上传失败（可用 evolclaw aid agentmd put 重试）');
        console.log(result.hotLoaded
          ? '  ✓ 已热重载，agent 已上线'
          : result.hotLoadError
            ? `  ✗ 热重载失败：${result.hotLoadError}`
            : '  ⚠ 服务未运行，下次 evolclaw start 时生效');
        if (result.ownerBoundAid) {
          console.log(`  ✓ agent owner 已绑定: ${result.ownerBoundAid}`);
        } else if (result.ownerBindSkipped) {
          console.log('  ⚠ agent owner 未通过二维码绑定');
        }
      }
    } else {
      const result = await agentCreateInteractive({ suggestedName: name });
      if (!result.ok) {
        if (formatJson) { console.log(JSON.stringify(result)); }
        else { console.error(`❌ ${result.error}`); }
        process.exit(1);
      }
      if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`\n✓ Created: ${result.configPath}`);
        console.log(result.agentmdUploaded
          ? '  ✓ agent.md 已发布'
          : '  ⚠ agent.md 上传失败（可用 evolclaw aid agentmd put 重试）');
        console.log(result.hotLoaded
          ? '  ✓ 已热重载，agent 已上线'
          : result.hotLoadError
            ? `  ✗ 热重载失败：${result.hotLoadError}`
            : '  ⚠ 服务未运行，下次 evolclaw start 时生效');
        if (result.ownerBoundAid) {
          console.log(`  ✓ agent owner 已绑定: ${result.ownerBoundAid}`);
        } else if (result.ownerBindSkipped) {
          console.log('  ⚠ agent owner 未通过二维码绑定');
        }
      }
    }
    return;
  }

  // --- sync-aids (deprecated, commented out) ---
  // if (sub === 'sync-aids') {
  //   const result = await agentSyncAids();
  //   if (!result.ok) {
  //     if (formatJson) { console.log(JSON.stringify(result)); }
  //     else { console.error(`❌ ${result.error}`); }
  //     process.exit(1);
  //   }
  //   if (formatJson) {
  //     console.log(JSON.stringify(result, null, 2));
  //     return;
  //   }
  //   if (result.created.length === 0) {
  //     console.log('所有本地 AID 都已有对应 agent，无需同步。');
  //   } else {
  //     console.log(`✓ 同步完成：新建 ${result.created.length} 个 agent（模板: ${result.template}）`);
  //     for (const aid of result.created) console.log(`  ✓ ${aid}`);
  //     if (result.hotReloaded) console.log('  ✓ 已热加载到运行中的进程');
  //     else console.log('  evolclaw 未运行，新 agent 将在下次启动时加载。');
  //   }
  //   return;
  // }

  // --- reload ---
  if (sub === 'reload') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent reload [aid] [--format json]

热重载 agent 配置。
  无参数      全量 resync（扫磁盘，新增上线、删除下线、修改热更新）
  <aid>       仅热重载指定 agent`);
      return;
    }
    const target = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const result = await agentReload(target);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`✗ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (target) {
      console.log(`✓ Agent "${target}" reloaded`);
    } else {
      console.log('✓ Agent resync 完成:');
      for (const line of (result.results || [])) console.log(`  ${line}`);
    }
    return;
  }

  // --- enable ---
  if (sub === 'enable') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent enable <aid> [--format json]

启用 agent。若服务运行中会热重载，否则下次 evolclaw start 时生效。`);
      return;
    }
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent enable <aid>'); process.exit(1); }
    const result = await agentEnable(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} enabled${result.reloaded ? ' (hot-reloaded)' : ''}`); }
    return;
  }

  // --- disable ---
  if (sub === 'disable') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent disable <aid> [--format json]

停用 agent。若服务运行中会热重载离线，否则在配置中标记为禁用。`);
      return;
    }
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent disable <aid>'); process.exit(1); }
    const result = await agentDisable(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} disabled${result.reloaded ? ' (hot-reloaded)' : ''}`); }
    return;
  }

  // --- get ---
  if (sub === 'get') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent get <aid> <key> [--format json]

读取单个配置字段。key 支持点路径，如 "channels.aun.enabled"。

示例:
  evolclaw agent get mybot.agentid.pub active_baseagent
  evolclaw agent get mybot.agentid.pub observable
  evolclaw agent get mybot.agentid.pub channels.aun.enabled`);
      return;
    }
    const aid = args[1];
    const key = args[2];
    if (!aid || !key) { console.error('用法: evolclaw agent get <aid> <key>'); process.exit(1); }
    const result = await agentGet(aid, key);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else {
      const val = result.value;
      console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
    }
    return;
  }

  // --- set ---
  if (sub === 'set') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent set <aid> <key> <value> [--format json]

修改单个配置字段。key 支持点路径。修改后若服务运行中会自动热重载。

示例:
  evolclaw agent set mybot.agentid.pub active_baseagent codex
  evolclaw agent set mybot.agentid.pub observable true
  evolclaw agent set mybot.agentid.pub observable false
  evolclaw agent set mybot.agentid.pub channels.aun.enabled true`);
      return;
    }
    const aid = args[1];
    const key = args[2];
    const val = args[3];
    if (!aid || !key || val === undefined) { console.error('用法: evolclaw agent set <aid> <key> <value>'); process.exit(1); }
    const result = await agentSet(aid, key, val);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} ${key} = ${JSON.stringify(result.value)}${result.reloaded ? ' (hot-reloaded)' : ''}`); }
    return;
  }

  // --- ready ---
  if (sub === 'ready') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent ready <aid> [--format json]

标记 agent bootstrap 已完成，将 lifecycle 切换为 active。该命令允许 agent 在工具调用中自报完成。`);
      return;
    }
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent ready <aid>'); process.exit(1); }
    const result = await agentReady(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} lifecycle=active${result.reloaded ? ' (runtime updated)' : ' (daemon offline or not updated)'}`); }
    return;
  }

  // --- delete ---
  if (sub === 'delete') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent delete <aid> [--purge] [--format json]

删除 agent 的配置。
  --purge   同时清除该 agent 的会话、消息、日志等运行时数据
  默认       仅删除 config.json，运行时数据保留`);
      return;
    }
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent delete <aid> [--purge]'); process.exit(1); }
    const purge = args.includes('--purge');
    const result = await agentDelete(aid, purge);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} deleted${purge ? ' (purged)' : ''}`); }
    return;
  }

  // --- show ---
  if (sub === 'show') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent show <aid> [--format json]

查看 agent 详情：身份、配置、连接状态、会话路径等。`);
      return;
    }
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent show <aid>'); process.exit(1); }
    const result = await agentShow(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(result.error); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printAgentShowHuman(result);
    return;
  }

  // --- rename ---
  if (sub === 'rename') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw agent rename <aid> <name> [--format json]

修改本地 AIDs/<aid>/agent.md 中的 name 字段。`);
      return;
    }
    const aid = args[1];
    const name = args[2];
    if (!aid || !name) { console.error('用法: evolclaw agent rename <aid> <name>'); process.exit(1); }
    const result = await agentRename(aid, name);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(result.error); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} renamed to ${result.name}`); }
    return;
  }

  // --- default: `evolclaw agent <aid>` (shorthand for show) ---
  const result = await agentShow(sub);
  if (!result.ok) {
    if (formatJson) { console.log(JSON.stringify(result)); }
    else { console.error(result.error); }
    process.exit(1);
  }
  if (formatJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printAgentShowHuman(result);
}

function printAgentShowHuman(result: any): void {
  console.log(`${result.aid} (${result.status})\n`);
  if (result.identity.name || result.identity.description) {
    console.log('  Identity');
    if (result.identity.name) console.log(`    Name:         ${result.identity.name}`);
    if (result.identity.description) console.log(`    Description:  ${result.identity.description}`);
    console.log('');
  }
  console.log('  Config');
  console.log(`    Baseagent:    ${result.config.baseagent || '—'}`);
  if (result.config.model) console.log(`    Model:        ${result.config.model}`);
  if (result.config.effort) console.log(`    Effort:       ${result.config.effort}`);
  if (result.config.chatmode) console.log(`    Chatmode:     private=${result.config.chatmode.private}  group=${result.config.chatmode.group}`);
  console.log(`    Channels:     ${result.config.channels.length > 0 ? result.config.channels.join(', ') : '—'}`);
  console.log('');
  if (result.connection) {
    const c = result.connection;
    console.log('  Connection');
    console.log(`    Status:       ${c.status}`);
    console.log(`    Uptime:       ${c.uptime_ms != null ? formatDurationMs(c.uptime_ms) : '—'}`);
    console.log(`    Reconnects:   ${c.reconnect_count}`);
    console.log(`    Msgs recv:    ${c.messages_received}`);
    console.log(`    Msgs sent:    ${c.messages_sent}`);
    console.log(`    Bytes in:     ${formatBytes(c.bytes_received)}`);
    console.log(`    Bytes out:    ${formatBytes(c.bytes_sent)}`);
    console.log(`    Last recv:    ${c.last_received_at ? formatTimeAgo(Date.now() - new Date(c.last_received_at).getTime()) : '—'}`);
    console.log(`    Last sent:    ${c.last_sent_at ? formatTimeAgo(Date.now() - new Date(c.last_sent_at).getTime()) : '—'}`);
    console.log(`    Peers:        ${c.unique_peer_count}`);
    console.log('');
  } else {
    console.log('  Connection      (daemon offline)');
    console.log('');
  }
  console.log('  Sessions');
  console.log(`    Active:       ${result.sessions.active}`);
  console.log(`    Last active:  ${result.sessions.last_activity ? formatTimeAgo(Date.now() - new Date(result.sessions.last_activity).getTime()) : '—'}`);
  console.log('');
  console.log('  Paths');
  console.log(`    Config:       ${result.paths.config}`);
  console.log(`    Agent.md:     ${result.paths.agent_md}`);
  console.log(`    Project:      ${result.paths.project || '—'}`);
  console.log(`    Data:         ${result.paths.data}`);
}

function formatDurationMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return `${min}m${String(s).padStart(2, '0')}s`;
  const hour = Math.floor(min / 60);
  const m = min % 60;
  if (hour < 24) return `${hour}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  const day = Math.floor(hour / 24);
  return `${day}d${hour % 24}h${String(m).padStart(2, '0')}m`;
}

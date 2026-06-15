import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc.js';
import { isHelpFlag } from './help.js';

interface QueueItem {
  status: 'active' | 'pending';
  sessionKey: string;
  channelType: string;
  channelId: string;
  projectPath: string;
  peerName?: string;
  preview: string;
  messageId?: string;
  elapsedMs?: number;
}

export async function cmdQueue(args: string[]): Promise<void> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    console.log(`用法: evolclaw queue --agent <aid> [选项]

查询与操作 EvolAgent 的消息队列。

查询:
  --agent <aid>           必填，目标 agent（如 mybot.agentid.pub）
  --showid                显示 messageId
  --full                  显示完整消息内容（不截断）
  --format json           以 JSON 格式输出

操作:
  --clear                 清空该 agent 的所有待处理消息
  --cancel <messageId>    取消指定消息
  --interrupt --sessionkey <key>  打断指定 session 的处理中任务

示例:
  evolclaw queue --agent mybot.agentid.pub
  evolclaw queue --agent mybot.agentid.pub --showid
  evolclaw queue --agent mybot.agentid.pub --clear
  evolclaw queue --agent mybot.agentid.pub --cancel msg_d4e5f6
  evolclaw queue --agent mybot.agentid.pub --interrupt --sessionkey feishu#oc_abc123#main`);
    process.exit(0);
  }

  // 解析参数
  const agentIdx = args.indexOf('--agent');
  if (agentIdx === -1 || agentIdx + 1 >= args.length) {
    console.error('❌ 缺少 --agent <aid> 参数');
    process.exit(1);
  }
  const agent = args[agentIdx + 1];
  const showId = args.includes('--showid');
  const full = args.includes('--full');
  const formatJson = args.includes('--format json');
  const clear = args.includes('--clear');
  const cancelIdx = args.indexOf('--cancel');
  const cancelMsgId = cancelIdx >= 0 && cancelIdx + 1 < args.length ? args[cancelIdx + 1] : undefined;
  const interrupt = args.includes('--interrupt');
  const sessionKeyIdx = args.indexOf('--sessionkey');
  const sessionKey = sessionKeyIdx >= 0 && sessionKeyIdx + 1 < args.length ? args[sessionKeyIdx + 1] : undefined;

  // 构建 IPC 请求
  const action = clear ? 'clear'
    : cancelMsgId ? 'cancel'
    : interrupt ? 'interrupt'
    : undefined;

  const socketPath = resolvePaths().socket;
  const result = await ipcQuery(socketPath, {
    type: 'queue-snapshot',
    agent,
    action,
    messageId: cancelMsgId,
    sessionKey,
  });

  if (!result) {
    console.error('错误: 无法连接 evolclaw 服务');
    process.exit(1);
  }

  const r = result as any;

  // 操作结果
  if (action) {
    if (r.ok) {
      if (action === 'clear') console.log(`✅ 已清空 ${r.cleared ?? 0} 条待处理消息`);
      else if (action === 'cancel') console.log(`✅ 已取消消息`);
      else if (action === 'interrupt') console.log(`✅ 已打断处理中任务`);
    } else {
      console.error(r.error || '执行失败');
      process.exit(1);
    }
    return;
  }

  // 查询结果
  const items: QueueItem[] = r.items || [];
  if (formatJson) {
    console.log(JSON.stringify({ items }, null, 2));
    return;
  }
  console.log(renderQueueItemsCli(items, showId, full, agent));
}

function renderQueueItemsCli(items: QueueItem[], showId: boolean, full: boolean, aid: string): string {
  const lines: string[] = [`${aid} — 队列 (${items.length} 条)`, ''];

  if (items.length === 0) {
    lines.push('(无队列消息)');
    return lines.join('\n');
  }

  // 计算列宽
  const maxSessionKeyLen = Math.max(...items.map(i => i.sessionKey.length));
  const maxIdLen = showId ? Math.max(...items.map(i => i.messageId?.length ?? 0)) : 0;
  const maxNameLen = Math.max(...items.map(i => (i.peerName ? `[${i.peerName}]`.length : 0)));
  const elapsedColWidth = 5;

  for (const item of items) {
    const parts: string[] = [' '];
    // 状态列
    const status = item.status === 'active' ? '[active]' : '[pending]';
    parts.push(` ${status.padEnd(10)} `);
    // sessionKey 列
    parts.push(` ${item.sessionKey.padEnd(maxSessionKeyLen)}  `);
    // messageId 列（可选）
    if (showId) {
      parts.push(` ${(item.messageId || '').padEnd(maxIdLen)}  `);
    }
    // 发送者列
    if (item.peerName) {
      parts.push(` [${item.peerName}]`.padEnd(maxNameLen + 2) + '  ');
    }
    // 时长列
    let elapsed = '—';
    if (item.elapsedMs != null) {
      const sec = Math.round(item.elapsedMs / 1000);
      elapsed = sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
    }
    parts.push(` ${elapsed.padEnd(elapsedColWidth)}  `);
    // 内容列
    const content = full ? item.preview.replace(/\.\.\.$/, '') : item.preview;
    parts.push(`"${content}"`);
    lines.push(parts.join(''));
  }

  return lines.join('\n');
}

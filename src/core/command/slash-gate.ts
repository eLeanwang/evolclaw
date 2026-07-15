import type { OutboundPayload, Session } from '../../types.js';
import type { AgentRunnerFull } from '../../agents/runner-types.js';
import type { SessionManager } from '../session/session-manager.js';
import type { MessageQueue } from '../message/message-queue.js';

// 支持的命令列表
const commands = ['/new', '/pwd', '/help', '/evolhelp', '/status', '/restart', '/reload', '/model', '/setmodel', '/effort', '/baseagent', '/slist', '/session', '/rename', '/stop', '/compact', '/repair', '/fork', '/del', '/perm', '/file', '/check', '/rewind', '/activity', '/chatmode', '/mentionmode', '/ask', '/resume', '/aid', '/rpc', '/storage', '/agent', '/trigger', '/upgrade'];
const deprecatedCommands = ['/clear'];

// 命令别名映射
const aliases: Record<string, string> = {
  '/s': '/session',
  '/name': '/rename',
  '/rw': '/rewind',
  '/base': '/baseagent',
};

// 命令快速路径前缀（所有命令都不进入消息队列）
const quickCommandPrefixes = ['/new', '/pwd', '/help', '/evolhelp', '/status', '/restart', '/reload', '/model', '/setmodel', '/effort', '/baseagent', '/slist', '/session', '/rename', '/repair', '/fork', '/stop', '/clear', '/compact', '/del', '/perm', '/file', '/check', '/s ', '/name', '/rewind', '/rw', '/rw ', '/activity', '/chatmode', '/mentionmode', '/ask', '/resume', '/base ', '/aid', '/rpc', '/storage', '/agent', '/trigger', '/upgrade'];

/**
 * 计算两个字符串的 Levenshtein 距离（编辑距离）
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // 替换
          matrix[i][j - 1] + 1,     // 插入
          matrix[i - 1][j] + 1      // 删除
        );
      }
    }
  }

  return matrix[len1][len2];
}

export function isQuickCommand(content: string): boolean {
  return content === '/s' || quickCommandPrefixes.some(cmd => content.startsWith(cmd));
}

export function normalizeSlashContent(content: string): string {
  for (const [alias, full] of Object.entries(aliases)) {
    if (content === alias || content.startsWith(alias + ' ')) {
      return content.replace(alias, full);
    }
  }
  return content;
}

export function isRecognizedSlashCommand(content: string): boolean {
  return commands.some(cmd => content.startsWith(cmd)) ||
    deprecatedCommands.some(cmd => content === cmd || content.startsWith(cmd + ' '));
}

export function guardThreadCommand(content: string, threadId?: string): OutboundPayload | undefined {
  if (!threadId) return undefined;
  const threadBlocked = ['/new', '/slist', '/s', '/session', '/fork', '/del'];
  const isBlocked = threadBlocked.some(c => content === c || content.startsWith(c + ' '));
  const isBaseagentSwitch = content.startsWith('/baseagent ');
  const isBaseAliasSwitch = content.startsWith('/base ');
  if (!isBlocked && !isBaseagentSwitch && !isBaseAliasSwitch) return undefined;
  return { kind: 'command.error', text: '⚠️ 话题中不支持此命令' };
}

export function guardRoleCommand(content: string, activeChatType: string, isAdmin: boolean): OutboundPayload | undefined {
  if (!content.startsWith('/')) return undefined;

  // visitor/member 在群聊和私聊中均可访问的只读命令：纯查询形态（带参写操作由各 handler 内部守卫拦截）
  const userGroupCommands = [
    '/status', '/help', '/evolhelp', '/check', '/chatmode', '/mentionmode',
    '/model', '/setmodel', '/effort', '/baseagent', '/perm', '/activity', '/stop',
    '/resume', '/trigger',
  ];
  const userCommands = activeChatType === 'group' && !isAdmin
    ? userGroupCommands
    : [
        ...userGroupCommands,
        // 私聊 visitor/member 额外可用：会话自管理 + 私聊专属的 /rewind 历史查看
        '/slist', '/new', '/session', '/rename', '/name', '/del', '/s ', '/rewind',
      ];
  const isUserCommand = userCommands.some(cmd =>
    content === cmd.trimEnd() || content.startsWith(cmd)
  );
  if (isUserCommand || isAdmin) return undefined;
  return {
    kind: 'command.error',
    text: activeChatType === 'group'
      ? '❌ 无权限：当前群聊仅支持 /status 和 /help'
      : '❌ 无权限：此命令仅限管理员使用',
  };
}

export async function guardIdleCommand(opts: {
  content: string;
  threadId?: string;
  channel: string;
  channelId: string;
  activeSession?: Session;
  activeAgent?: AgentRunnerFull;
  sessionManager: SessionManager;
  messageQueue?: MessageQueue;
  getAgentForSession: (session: Session) => AgentRunnerFull;
}): Promise<OutboundPayload | undefined> {
  // 空闲检查：某些命令需要等待当前会话空闲
  // 原则：仅对"写/破坏性"形态拦截，纯读/用法提示的无参形态始终放行
  // - 始终需要 idle（无参即写）：/compact /repair /fork /new
  // - 仅带参时需要 idle（无参是列表/用法）：/session /baseagent /rewind
  // - /chatmode：在 handler 内部自行做写操作的 idle 检查
  // - /mentionmode：在 handler 内部自行做写操作的 idle 检查
  const idleAlways = ['/compact', '/repair', '/fork', '/new'];
  const idleWhenArg = ['/session', '/baseagent', '/rewind'];
  const needsIdle =
    idleAlways.some(cmd => opts.content === cmd || opts.content.startsWith(cmd + ' ')) ||
    idleWhenArg.some(cmd => opts.content.startsWith(cmd + ' '));
  if (!needsIdle) return undefined;

  if (opts.threadId) {
    // 话题中：检查话题 session 是否在处理（不创建）
    const threadSession = await opts.sessionManager.getThreadSession(opts.channel, opts.channelId, opts.threadId);
    if (threadSession) {
      let hasActiveStream = false;
      try {
        hasActiveStream = opts.getAgentForSession(threadSession).hasActiveStream(threadSession.id);
      } catch {
        // Runner mismatch should not block recovery commands such as /baseagent.
      }
      const isBusy = hasActiveStream || opts.messageQueue?.isProcessing(threadSession.id);
      if (isBusy) {
        return { kind: 'command.error', text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
      }
    }
  } else if (opts.activeSession) {
    const isBusy = (opts.activeAgent?.hasActiveStream(opts.activeSession.id) ?? false) ||
      opts.messageQueue?.isProcessing(opts.activeSession.id);
    if (isBusy) {
      return { kind: 'command.error', text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
    }
  }

  return undefined;
}

export function guardKnownCommand(content: string): OutboundPayload | undefined {
  // 检查是否以 / 开头（可能是命令）
  if (!content.startsWith('/')) return undefined;

  const inputCmd = content.split(' ')[0];
  const isValidCommand = isRecognizedSlashCommand(content);
  if (isValidCommand) return undefined;

  const similar = commands.find(cmd => {
    const distance = levenshteinDistance(inputCmd, cmd);
    return distance <= 2;
  });

  if (similar) {
    return { kind: 'command.error', text: `❌ 未知命令: ${inputCmd}\n💡 你是不是想输入: ${similar}\n\n输入 /help 查看所有可用命令` };
  }
  return { kind: 'command.error', text: `❌ 未知命令: ${inputCmd}\n\n输入 /help 查看所有可用命令` };
}

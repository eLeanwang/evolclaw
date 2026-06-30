import { type InteractionRequest, type OutboundPayload, type ReplyContext, type Session } from '../../types.js';
import type { PermissionDecision } from '../permission.js';
import { hasModelSwitcher, hasPermissionController } from '../../agents/runner-types.js';
import { getCodexEfforts } from '../../agents/codex-runner.js';
import { buildEnvelope } from '../message/message-utils.js';
import { resolvePaths, getPackageRoot } from '../../paths.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { checkLatestVersion, getLocalVersion, isLinkedInstall, compareVersions } from '../../utils/npm-ops.js';
import { loadEvolclawConfig } from '../../config-store.js';
import { isProcessLevelOwner } from './menu-handler.js';
import { execAgentAction } from '../message/command-handler-agent-control.js';
import { resolvePermissionMode, writeRelationPermissionMode } from '../model/config-scope.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import { modelMatches, resolveCommandModelResolution } from './model-resolve.js';
import { filterModelsForRole, validateModelSelectionForRole } from '../model/model-permission.js';
import { displaySessionTitle } from '../session/session-title.js';
import {
  guardIdleCommand,
  guardKnownCommand,
  guardRoleCommand,
  guardThreadCommand,
  isRecognizedSlashCommand,
  normalizeSlashContent,
} from './slash-gate.js';

const allEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = typeof allEfforts[number];
const PERMISSION_MODE_KEYS = ['auto', 'bypass', 'readonly', 'plan', 'edit', 'request', 'noask'] as const;
const PERMISSION_MODE_USAGE = PERMISSION_MODE_KEYS.join('|');

function getAvailableEfforts(agent: any, model: string): readonly Effort[] {
  if (agent.name === 'claude') return allEfforts;
  if (agent.name === 'codex') return getCodexEfforts(model) as readonly Effort[];
  return [];
}

function modelDisplayLabel(agent: any, model: string): string {
  const full = agent.resolveModelId?.(model);
  return full && full !== model ? `${model} (${full})` : model;
}

function formatIdleTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

function getAgentBusyInfo(handler: any, aid: string | undefined, excludeSessionKey?: string): { count: number; processing: Array<{ queueKey: string; agentName: string }>; agentName: string } | null {
  if (!aid || !handler.agentRegistry) return null;
  const handle = handler.agentRegistry.get(aid) ?? null;
  const agentName = handle?.name;
  if (!agentName) return null;
  const processing = handler.messageQueue?.getProcessingDetailsByAgent?.(agentName, excludeSessionKey) ?? [];
  const queueCount = handler.messageQueue?.getQueueLengthByAgent?.(agentName, excludeSessionKey) ?? 0;
  return { count: processing.length + queueCount, processing, agentName };
}

function getAgentBusyCount(handler: any, aid: string | undefined, excludeSessionKey?: string): number | null {
  return getAgentBusyInfo(handler, aid, excludeSessionKey)?.count ?? null;
}

async function getGitWorkingDirInfo(projectPath: string): Promise<string | null> {
  try {
    const { execFileSync } = await import('child_process');

    // 获取分支名
    const branchOutput = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 1000
    });
    const branch = branchOutput.trim();
    if (!branch) return null;

    // 检查文件状态
    const statusOutput = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 1000
    });

    // 解析文件状态统计
    const stats = { modified: 0, added: 0, deleted: 0, untracked: 0 };
    const lines = statusOutput.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      if (line.length < 2) continue;

      const index = line[0];    // staged status
      const worktree = line[1]; // unstaged status

      if (line.startsWith('??')) {
        stats.untracked++;
      } else if (index === 'A') {
        stats.added++;
      } else if (index === 'D' || worktree === 'D') {
        stats.deleted++;
      } else if (index === 'M' || worktree === 'M' || index === 'R' || index === 'C') {
        stats.modified++;
      }
    }

    // 组装显示信息
    const parts: string[] = [branch];

    const isDirty = lines.length > 0;
    if (isDirty) {
      parts[0] = branch + '*'; // 分支名后加 * 表示有修改

      const fileParts: string[] = [];
      if (stats.modified > 0) fileParts.push(`!${stats.modified}`);
      if (stats.added > 0) fileParts.push(`+${stats.added}`);
      if (stats.deleted > 0) fileParts.push(`-${stats.deleted}`);
      if (stats.untracked > 0) fileParts.push(`?${stats.untracked}`);

      if (fileParts.length > 0) {
        parts.push(`[${fileParts.join(' ')}]`);
      }
    }

    // 获取 ahead/behind 信息
    try {
      const revOutput = execFileSync(
        'git',
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        { cwd: projectPath, timeout: 1000, encoding: 'utf8' }
      );
      const revParts = revOutput.trim().split(/\s+/);
      if (revParts.length === 2) {
        const behind = parseInt(revParts[0], 10) || 0;
        const ahead = parseInt(revParts[1], 10) || 0;
        if (ahead > 0 || behind > 0) {
          const aheadBehind: string[] = [];
          if (ahead > 0) aheadBehind.push(`↑${ahead}`);
          if (behind > 0) aheadBehind.push(`↓${behind}`);
          parts.push(aheadBehind.join(' '));
        }
      }
    } catch {
      // No upstream or error, skip ahead/behind
    }

    return parts.join(' ');
  } catch (err) {
    return null; // git 命令失败时静默返回 null
  }
}

export async function handleSlashCommand(this: any, 
  content: string,
  channel: string,
  channelId: string,
  sendMessage?: (channelId: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => Promise<void>,
  userId?: string,
  threadId?: string,
  chatType?: string,
  source?: 'user' | 'card-trigger',
  messageId?: string,
  selfAID?: string,
  overrideIdentity?: import('../../types.js').SessionIdentity,
): Promise<OutboundPayload | null | undefined> {
  // 卡片回调的 chatType 不可靠（飞书 bot 单聊 chatId 也是 oc_ 前缀），
  // 不应覆盖 session 中已有的正确值
  if (source === 'card-trigger') chatType = undefined;

  // 解析身份（按实例名）
  const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
  const policy = this.getPolicy(channel);

  // 按当前会话选择 agent 后端。懒加载，避免错配 session 卡住 /baseagent 等恢复命令。
  const activeSession = await this.sessionManager.getActiveSession(channel, channelId);
  let activeAgent: any | undefined;
  const getActiveAgent = () => {
    if (!activeAgent) activeAgent = this.getAgent(channel, activeSession?.baseagent);
    return activeAgent;
  };
  const getActiveAgentIfAvailable = () => {
    try {
      return activeSession ? getActiveAgent() : undefined;
    } catch {
      return undefined;
    }
  };

  // 规范化命令（将别名转换为完整命令）
  const normalizedContent = normalizeSlashContent(content);

  if (normalizedContent !== content) {
    logger.debug(`[CommandHandler] normalized: "${content}" -> "${normalizedContent}"`);
  }
  logger.info(`[CommandHandler] handle: channel=${channel} channelId=${channelId} cmd="${normalizedContent.split(' ')[0]}" user=${userId ?? 'n/a'} role=${identity?.role ?? 'n/a'}`);

  // Agent-owned 通道：禁止项目切换和 agent 切换
  // 权限检查：区分用户级命令和管理级命令
  const isOwner = identity.role === 'owner';
  const isAdmin = identity.role === 'owner' || identity.role === 'admin';
  const activeChatType = activeSession?.chatType || 'private';
  const getExistingSessionForCommand = async (): Promise<Session | undefined> => {
    if (threadId) return await this.sessionManager.getThreadSession(channel, channelId, threadId);
    return activeSession;
  };

  const threadGuard = guardThreadCommand(normalizedContent, threadId);
  if (threadGuard) return threadGuard;

  // daemon owner 判定（缓存一次，后续 /restart /reload 复用）
  const evolclawConfig = loadEvolclawConfig();
  const isDaemonOwner = isProcessLevelOwner(userId, evolclawConfig.owners);

  // roleGuard 仅对进程级命令（/restart /reload）放行 daemon owner 绕过，
  // 其余命令严格按 agent-channel 的 isAdmin 判定，不越权。
  const isProcessLevelSlash = normalizedContent === '/restart' || normalizedContent === '/reload' || normalizedContent.startsWith('/reload ');
  const roleGuard = guardRoleCommand(normalizedContent, activeChatType, isAdmin || (isDaemonOwner && isProcessLevelSlash));
  if (roleGuard) return roleGuard;

  const idleGuard = await guardIdleCommand({
    content: normalizedContent,
    threadId,
    channel,
    channelId,
    activeSession,
    activeAgent: getActiveAgentIfAvailable(),
    sessionManager: this.sessionManager,
    messageQueue: this.messageQueue,
    getAgentForSession: session => this.getAgent(channel, session.baseagent),
  });
  if (idleGuard) return idleGuard;

  const knownGuard = guardKnownCommand(normalizedContent);
  if (knownGuard) return knownGuard;

  const isCmd = isRecognizedSlashCommand(normalizedContent);
  if (!isCmd) return undefined;

  // /help 命令不需要会话
  if (normalizedContent === '/help') {
    const appendProcessCommands = (lines: string[]) => {
      if (!isDaemonOwner) return;
      lines.push(
        '',
        '🛠️ 进程级运维：',
        '  /restart - 重启服务',
        '  /reload [aid] - 热重载 Agent 配置',
      );
    };

    if (!isAdmin && activeChatType === 'group') {
      const lines = [
        '可用命令：',
        '',
        '其他：',
        '  /status - 显示会话状态',
        '  /check - 检查渠道健康',
        '  /help - 显示此帮助信息',
      ];
      appendProcessCommands(lines);
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    if (!isAdmin) {
      const lines = [
        '可用命令：',
        '',
        '🔄 会话管理：',
        '  /new [名称] - 创建新会话（清空历史请用此命令，可选命名）',
        '  /s [cli|名称|序号|uuid] - 列出或切换会话（cli 查看未导入的 CLI 会话）',
        '  /name <新名称> - 重命名当前会话',
        '  /del <名称> - 删除指定会话（仅解绑，不删除文件）',
        '  /status - 显示会话状态',
        '  /check - 检查渠道健康',
        '',
        '❓ 帮助：',
        '  /help - 显示此帮助信息',
      ];
      appendProcessCommands(lines);
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // admin+ 基础命令
    const lines = [
      '可用命令：',
      '',
      '📁 项目：',
      '  /pwd - 显示当前项目路径',
      '',
      '🔄 会话管理：',
      '  /new [名称] - 创建新会话（清空历史请用此命令，可选命名）',
      '  /s [cli|名称|序号|uuid] - 列出或切换会话（cli 查看未导入的 CLI 会话）',
      '  /name <新名称> - 重命名当前会话',
      '  /del <名称> - 删除指定会话（仅解绑，不删除文件）',
      '  /fork [名称] - 分支当前会话（从当前对话点创建分支）',
      '  /rewind [N] [chat|file|all] - 查看历史/撤销指定轮次（别名: /rw）',
      '  /compact - 压缩会话上下文（减少 token 用量）',
      '',
      '🤖 Agent 与模型：',
      '  /baseagent [name] - 查看或切换 Agent 后端（别名: /base）',
      '  /model [model] - 查看或切换模型',
      '  /effort [level] - 查看或切换推理强度',
      '',
      '💬 聊天设置：',
      '  /activity [all|none] - 查看/控制中间输出显示模式',
      '  /chatmode [interactive|proactive] - 查看/切换会话模式（被动响应或主动推进）',
      '  /dispatch [mention|broadcast] - 查看/切换群聊分发模式（仅@响应或广播响应，仅群聊）',
      '',
      '🔐 权限管理：',
      '  /perm - 查看当前权限模式',
      ...(isAdmin ? [`  /perm <${PERMISSION_MODE_USAGE}> - 切换权限模式`] : []),
      '  /perm allow|always|deny - 审批权限请求',
      '',
      '🛠️ 运维：',
      '  /status - 显示会话状态',
      '  /stop - 中断当前任务',
      '  /check - 检查渠道状态',
      ...(isDaemonOwner ? [
        '  /restart - 重启服务',
        '  /reload [aid] - 热重载 Agent 配置',
      ] : []),
      ...(!isDaemonOwner && isAdmin ? [
        '  /reload - 热重载当前 Agent 配置',
      ] : []),
      ...(isAdmin ? [
        '',
        '🧰 工具：',
        `  /file ${isOwner ? '[channel] ' : ''}<path> - 发送项目内文件`,
      ] : []),
      '',
      '❓ 帮助：',
      '  /help - 显示此帮助信息',
    ];
    return { kind: 'command.result' as const, text: lines.join('\n') };
  }

  // /evolhelp 命令：返回 JSON 格式的命令列表（供程序解析）
  if (normalizedContent === '/evolhelp') {
    type CmdEntry = { command: string; aliases?: string[]; args?: string; description: string; category: string; roles: string[] };
    const cmds: CmdEntry[] = [];

    // 项目
    cmds.push({ command: '/pwd', description: '显示当前项目路径', category: '项目', roles: ['admin', 'owner'] });

    // 会话管理
    cmds.push({ command: '/new', args: '[名称]', description: '创建新会话（清空历史请用此命令，可选命名）', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
    cmds.push({ command: '/s', aliases: ['/session', '/slist'], args: '[cli|名称|序号|uuid]', description: '列出或切换会话', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
    cmds.push({ command: '/name', aliases: ['/rename'], args: '<新名称>', description: '重命名当前会话', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
    cmds.push({ command: '/del', args: '<名称>', description: '删除指定会话（仅解绑，不删除文件）', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
    if (isAdmin) {
      cmds.push({ command: '/fork', args: '[名称]', description: '分支当前会话（从当前对话点创建分支）', category: '会话管理', roles: ['admin', 'owner'] });
      cmds.push({ command: '/rewind', aliases: ['/rw'], args: '[N] [chat|file|all]', description: '查看历史/撤销指定轮次', category: '会话管理', roles: ['admin', 'owner'] });
      cmds.push({ command: '/compact', description: '压缩会话上下文（减少 token 用量）', category: '会话管理', roles: ['admin', 'owner'] });
    }

    // Agent 与模型
    if (isAdmin) {
      cmds.push({ command: '/baseagent', aliases: ['/base'], args: '[name]', description: '查看或切换 Agent 后端', category: 'Agent 与模型', roles: ['admin', 'owner'] });
      cmds.push({ command: '/model', args: '[model]', description: '查看或切换模型', category: 'Agent 与模型', roles: ['admin', 'owner'] });
      cmds.push({ command: '/effort', args: '[level]', description: '查看或切换推理强度', category: 'Agent 与模型', roles: ['admin', 'owner'] });
    }

    // 权限管理
    if (isAdmin) {
      cmds.push({ command: '/perm', args: `<${PERMISSION_MODE_USAGE}>`, description: '查看或切换当前权限模式', category: '权限管理', roles: ['admin', 'owner'] });
      cmds.push({ command: '/perm', args: 'allow|always|deny', description: '审批权限请求', category: '权限管理', roles: ['admin', 'owner'] });
    }

    // 运维
    cmds.push({ command: '/status', description: '显示会话状态', category: '运维', roles: ['guest', 'admin', 'owner'] });
    cmds.push({ command: '/stop', description: '中断当前任务', category: '运维', roles: ['admin', 'owner'] });
    cmds.push({ command: '/check', description: '检查渠道状态', category: '运维', roles: ['guest', 'admin', 'owner'] });
    if (isAdmin) {
      cmds.push({ command: '/activity', args: '[all|none]', description: '查看/控制中间输出显示模式', category: '聊天设置', roles: ['admin', 'owner'] });
    }
    if (isDaemonOwner) {
      cmds.push({ command: '/restart', description: '重启服务', category: '运维', roles: ['daemon-owner'] });
      cmds.push({ command: '/reload', args: '[aid]', description: '热重载 Agent 配置', category: '运维', roles: ['daemon-owner'] });
    }
    if (!isDaemonOwner && isAdmin) {
      cmds.push({ command: '/reload', description: '热重载当前 Agent 配置', category: '运维', roles: ['admin', 'owner'] });
    }
    if (isAdmin) {
      cmds.push({ command: '/file', args: isOwner ? '[channel] <path>' : '<path>', description: '发送项目内文件', category: '工具', roles: ['admin', 'owner'] });
    }

    // 聊天设置
    if (isAdmin) {
      cmds.push({ command: '/chatmode', args: '[interactive|proactive]', description: '查看/切换会话模式（被动响应或主动推进）', category: '聊天设置', roles: ['admin', 'owner'] });
      cmds.push({ command: '/dispatch', args: '[mention|broadcast]', description: '查看/切换群聊分发模式（仅@响应或广播响应）', category: '聊天设置', roles: ['admin', 'owner'] });
    }

    // 交互
    cmds.push({ command: '/ask', args: '<选项>', description: '回答 Agent 的交互式问题', category: '运维', roles: ['guest', 'admin', 'owner'] });

    // 帮助
    cmds.push({ command: '/help', description: '显示帮助信息', category: '帮助', roles: ['guest', 'admin', 'owner'] });

    const categories = [...new Set(cmds.map(c => c.category))];
    return { kind: 'command.result' as const, text: JSON.stringify({ commands: cmds, categories }) };
  }

  // /perm 命令：权限模式切换 + 权限审批（快速路径，不进入消息队列）
  if (normalizedContent.startsWith('/perm')) {
    const args = normalizedContent.slice(5).trim();

    // 权限审批和关系级模式依附于现有会话；查询/审批不应隐式创建空会话。
    const permSession = await getExistingSessionForCommand();
    if (!permSession) return { kind: 'command.result' as const, text: '当前没有活跃会话' };
    const permAgent = this.getAgent(channel, permSession.baseagent);

    // 关系级 scope 选择器：用于读/写关系级 permissionMode
    const permSelfAid = selfAID ?? this.resolveSelfAID(channel);
    const permChannelType = this.resolveChannelType(channel);
    const permPeerKeyId = permSession.chatType === 'group'
      ? (permSession.metadata?.groupId || channelId)
      : (userId || permSession.metadata?.peerId);
    const permPeerKey = (permChannelType && permPeerKeyId)
      ? formatPeerKey(permChannelType, permPeerKeyId)
      : undefined;
    const permRole = permSession.identity?.role || identity.role || 'anonymous';
    const permScope = { self: permSelfAid || undefined, peerKey: permPeerKey, role: permRole };

    // /perm（无参数）：显示当前模式和可选模式
    if (!args) {
      if (!hasPermissionController(permAgent)) {
        return { kind: 'command.error' as const, text: '❌ 权限控制不可用' };
      }
      const currentMode = resolvePermissionMode(permScope);
      const modes = permAgent.listModes();

      // 尝试发送 CommandCard 卡片
      {
        const availableModes = modes.filter(m => m.available);
        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `perm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: permSession.id,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '🔐 权限模式',
            body: availableModes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.nameZh}) - ${m.description}`).join('\n'),
            buttons: availableModes.map(m => ({
              label: m.key === currentMode ? `✓ ${m.key}` : m.key,
              command: `/perm ${m.key}`,
              style: (m.key === currentMode ? 'primary' : 'default') as 'primary' | 'default',
              disabled: m.key === currentMode,
            })),
          },
        };

        const replyCtx = this.getReplyContext(permSession);
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }
    }

    const parts = args.split(/\s+/);

    // /perm <mode> 或 /perm allow|always|deny：切换模式 / 快捷审批
    if (parts.length === 1) {
      const arg = parts[0];

      // /perm allow|always|deny：快捷审批
      // 优先走 InteractionRouter fallback（统一降级路径）
      if (arg === 'allow' || arg === 'always' || arg === 'deny') {
        const fb = await this.handleInteractionFallback('perm', arg, permSession.id, userId);
        if (fb.matched) return { kind: 'command.result' as const, text: fb.result ?? '✓ 已回答' };

        // fallback 不命中：走 permissionGateway 直接审批（兼容旧路径）
        if (!this.permissionGateway) {
          return { kind: 'command.error' as const, text: '❌ 权限审批未启用' };
        }
        const pendingIds = this.permissionGateway.getPendingRequests(permSession.id);
        if (pendingIds.length === 0) {
          return { kind: 'command.error' as const, text: '❌ 当前没有待审批的权限请求' };
        }
        if (pendingIds.length > 1) {
          return { kind: 'command.error' as const, text: `❌ 当前有 ${pendingIds.length} 个待审批请求，请指定 requestId：\n${pendingIds.map((id: string) => `  /perm ${id} ${arg}`).join('\n')}` };
        }
        const requestId = pendingIds[0];
        const decision: PermissionDecision = arg;
        this.permissionGateway.resolvePermission(permSession.id, requestId, decision);
        const labels: Record<PermissionDecision, string> = {
          allow: '✓ 已授权（本次），继续执行……',
          always: '✓ 已授权（始终允许该工具），继续执行……',
          deny: '✓ 已拒绝'
        };
        return { kind: 'command.result' as const, text: labels[decision] };
      }

      // /perm <mode>：切换权限模式
      if (hasPermissionController(permAgent)) {
        const modes = permAgent.listModes();
        const matched = modes.find(m => m.key === arg);
        if (matched) {
          if (!matched.available) {
            return { kind: 'command.error' as const, text: `❌ ${matched.key} 模式当前不可用：${matched.unavailableReason}` };
          }
          // 关系级权限模式切换允许 owner/admin；guest 只能查询当前模式。
          if (!isAdmin) {
            return { kind: 'command.error' as const, text: '❌ 权限模式切换仅限管理员' };
          }
          // 写关系级 config.json（运行时按 关系>角色>出厂默认 解析）；无法定位 self/peer 时跳过写入（仅响应）
          if (permScope.self && permScope.peerKey) {
            writeRelationPermissionMode(permScope.self, permScope.peerKey, arg);
          }
          if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
          return { kind: 'command.result' as const, text: `✓ 权限模式已切换为: ${matched.key} (${matched.nameZh})\n${matched.description}` };
        }
      }
      // 不是已知模式名也不是 allow/deny
      const modeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : PERMISSION_MODE_USAGE;
      return { kind: 'command.error' as const, text: `❌ 未知参数: ${arg}\n用法: /perm <${modeKeys}> 或 /perm allow|always|deny` };
    }

    // 双参数不再支持，提示正确用法
    const allModeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : PERMISSION_MODE_USAGE;
    return { kind: 'command.error' as const, text: `❌ 未知参数: ${args}\n用法: /perm <${allModeKeys}> 或 /perm allow|always|deny` };
  }

  // /ask 命令：回答 AskUserQuestion / ExitPlanMode 的交互式问题
  if (normalizedContent.startsWith('/ask')) {
    const args = normalizedContent.slice(4).trim();
    const askSession = await getExistingSessionForCommand();
    if (!args) {
      if (!askSession) return { kind: 'command.result' as const, text: '当前没有待回答的问题' };
      const pendingIds = this.interactionRouter?.getPending(askSession.id) || [];
      if (pendingIds.length === 0) return { kind: 'command.result' as const, text: '当前没有待回答的问题' };
      return { kind: 'command.result' as const, text: `当前有 ${pendingIds.length} 个待回答问题，请回复 /ask <选项>` };
    }

    if (!askSession) return { kind: 'command.error' as const, text: '❌ 当前没有待回答的问题' };

    const fb = await this.handleInteractionFallback('ask', args, askSession.id, userId);
    if (fb.matched) return { kind: 'command.result' as const, text: fb.result ?? '✓ 已回答' };
    return { kind: 'command.error' as const, text: '❌ 当前没有待回答的问题' };
  }

  // /resume 命令：返回当前项目的 Claude 会话记录（JSON）
  if (normalizedContent === '/resume' || normalizedContent.startsWith('/resume ')) {
    const resumeSession = await getExistingSessionForCommand();
    if (!resumeSession) return { kind: 'command.result' as const, text: '当前没有活跃会话' };

    try {
      const { encodePath } = await import('../../utils/cross-platform.js');
      const homeDir = os.homedir();
      const encodedPath = encodePath(resumeSession.projectPath);
      const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

      if (!fs.existsSync(projectDir)) {
        return { kind: 'command.error' as const, text: '❌ 未找到 Claude 会话记录目录' };
      }

      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      if (jsonlFiles.length === 0) {
        return { kind: 'command.error' as const, text: '❌ 当前项目没有 Claude 会话记录' };
      }

      const sessions: Array<{
        sessionId: string;
        lastMessageTime: string;
        firstUserMessage: string;
        model: string;
        turns: number;
        branch: string;
      }> = [];

      for (const file of jsonlFiles) {
        const filePath = path.join(projectDir, file);
        const sessionId = file.replace('.jsonl', '');
        let lastTimestamp = '';
        let firstUserMessage = '';
        let model = '';
        let branch = '';
        let turns = 0;

        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());

          for (const line of lines) {
            const event = JSON.parse(line);

            if (event.timestamp && event.timestamp > lastTimestamp) {
              lastTimestamp = event.timestamp;
            }

            if (event.gitBranch && !branch) {
              branch = event.gitBranch;
            }

            if (event.type === 'user' && event.message?.role === 'user') {
              const msgContent = event.message.content;
              const isToolResult = Array.isArray(msgContent) && msgContent.every((c: any) => c.type === 'tool_result');
              if (!isToolResult) {
                turns++;
                if (!firstUserMessage) {
                  if (typeof msgContent === 'string') {
                    firstUserMessage = msgContent.slice(0, 100);
                  } else if (Array.isArray(msgContent)) {
                    const textBlock = msgContent.find((c: any) => c.type === 'text');
                    if (textBlock?.text) {
                      firstUserMessage = textBlock.text.slice(0, 100);
                    }
                  }
                }
              }
            }

            if (event.type === 'assistant' && event.message?.model && !model) {
              model = event.message.model;
            }
          }
        } catch {
          continue;
        }

        if (!lastTimestamp) continue;

        sessions.push({
          sessionId,
          lastMessageTime: lastTimestamp,
          firstUserMessage: firstUserMessage || '(无消息)',
          model: model || 'unknown',
          turns,
          branch: branch || 'unknown',
        });
      }

      sessions.sort((a, b) => b.lastMessageTime.localeCompare(a.lastMessageTime));

      return { kind: 'command.result' as const, text: JSON.stringify(sessions, null, 2) };
    } catch (error) {
      logger.error('[CommandHandler] /resume failed:', error);
      return { kind: 'command.error' as const, text: `❌ 读取会话记录失败: ${error instanceof Error ? error.message : '未知错误'}` };
    }
  }

  // /baseagent 命令：查看或切换 Agent 后端
  if (normalizedContent === '/baseagent' || normalizedContent.startsWith('/baseagent ')) {
    const args = normalizedContent.slice(10).trim();
    const owningAgent = this.agentRegistry?.resolveByChannel(channel);
    // 切换（带参）会修改 agent 默认 baseagent，仅 owner 可操作；无参查询对所有人放开
    if (args && !isOwner) {
      return { kind: 'command.error' as const, text: '❌ 无权限：切换 baseagent 仅限 owner 使用' };
    }
    const available = this.getAvailableBaseagents(channel);

    if (!args) {
      // currentAgent: 当前 session 的 baseagent，或该 channel 所属 evolagent 的 baseagent
      const currentAgent = activeSession?.baseagent
        || this.agentRegistry?.resolveByChannel(channel)?.baseagent
        || this.parseDefaultBaseagent();
      const defaultAgent = owningAgent?.baseagent || this.parseDefaultBaseagent();

      // 尝试发送 CommandCard 卡片
      if (this.interactionRouter && available.length > 1) {
        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `agent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: activeSession?.id || `agent-${Date.now()}`,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '🔌 切换 Agent',
            buttons: available.map((a: string) => ({
              label: a === defaultAgent ? `✓ ${a}` : a,
              command: `/baseagent ${a}`,
              style: (a === defaultAgent ? 'primary' : 'default') as 'primary' | 'default',
              disabled: a === defaultAgent,
            })),
          },
        };

        const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isOwner });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }

      // 降级：文本
      const list = available.map((a: string) => `${a === defaultAgent ? ' ✓' : '  '} ${a}`).join('\n');
      const canSwitchAgent = isOwner;
      if (canSwitchAgent) {
        return { kind: 'command.result' as const, text: `当前会话: ${currentAgent}\n新会话默认: ${defaultAgent}\n\n可用:\n${list}\n用法: /baseagent <name>` };
      }
      return { kind: 'command.result' as const, text: `当前 Agent: ${currentAgent}` };
    }

    if (!available.includes(args)) {
      return { kind: 'command.error' as const, text: `❌ 未知 Agent: ${args}\n可用: ${available.join(', ')}` };
    }

    if (!owningAgent) {
      return { kind: 'command.error' as const, text: '❌ 当前 channel 无绑定 agent，无法设置默认 baseagent' };
    }

    const previousDefaultBaseagent = owningAgent.baseagent || this.parseDefaultBaseagent();
    const currentSessionAgent = activeSession?.baseagent || previousDefaultBaseagent;
    owningAgent.setActiveBaseagent(args);
    this.eventBus.publish({
      type: 'agent:baseagent-changed',
      aid: owningAgent.aid,
      baseagent: args,
      previousBaseagent: previousDefaultBaseagent,
      scope: 'default',
      timestamp: Date.now(),
    });
    const projectName = this.getProjectName(owningAgent.projectPath);
    const agentSwitchResponse = [
      `✓ 已设置默认 baseagent: ${args}`,
      `  Agent: ${owningAgent.name}`,
      `  项目: ${projectName}`,
      '',
      `⚠️ 当前会话仍在使用 ${currentSessionAgent}，切换不会立即生效。`,
      `  发送 /new 创建新会话，或开启新话题，即可用上 ${args}。`,
    ].join('\n');

    return { kind: 'command.result' as const, text: agentSwitchResponse };
  }

  // /setmodel 命令：返回 JSON 格式的模型列表（供程序解析）
  if (normalizedContent === '/setmodel' || normalizedContent.startsWith('/setmodel ')) {
    const setmodelSession = await getExistingSessionForCommand();
    const fallbackBaseagent = setmodelSession?.baseagent || this.agentRegistry?.resolveByChannel(channel)?.baseagent || this.parseDefaultBaseagent();
    const setmodelAgent = this.getAgent(channel, fallbackBaseagent);

    const setmodelState = resolveCommandModelResolution({
      agent: setmodelAgent,
      session: setmodelSession,
      selfAid: selfAID ?? this.resolveSelfAID(channel),
      channelType: this.resolveChannelType(channel),
      channelId,
      userId,
      role: identity.role,
    });
    const currentModel = hasModelSwitcher(setmodelAgent) ? (setmodelState.model || setmodelAgent.getModel()) : setmodelAgent.name;
    const efforts = getAvailableEfforts(setmodelAgent, currentModel);
    const currentEffort = setmodelState.effort || 'auto';

    const now = Math.floor(Date.now() / 1000);
    const rawModelIds = hasModelSwitcher(setmodelAgent) ? await setmodelAgent.listModels() : [];
    const modelIds = hasModelSwitcher(setmodelAgent)
      ? filterModelsForRole(identity.role, fallbackBaseagent, rawModelIds, (setmodelAgent as any).resolveModelId?.bind(setmodelAgent))
      : rawModelIds;
    const modelListData = {
      object: 'list',
      data: modelIds.map(id => ({ id, object: 'model', created: now, owned_by: setmodelAgent.name === 'codex' ? 'openai' : 'anthropic' })),
    };

    return { kind: 'command.result' as const, text: JSON.stringify({
              current_model: currentModel,
              current_effort: currentEffort,
              available_efforts: efforts,
              models: modelListData,
            }, null, 2) };
  }

  // /model 命令：查看或切换模型/推理强度
  if (normalizedContent.startsWith('/model')) {
    const args = normalizedContent.slice(6).trim();

    // 带参（切换/调整）需 admin+；无参查询仍允许低权限查看当前模型。
    // Must happen before runner lookup so unavailable-session recovery errors
    // do not mask authorization failures.
    if (args && !isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：切换模型仅限管理员使用' };

    if (!args) {
      const modelSession = await getExistingSessionForCommand();
      const fallbackBaseagent = modelSession?.baseagent || this.agentRegistry?.resolveByChannel(channel)?.baseagent || this.parseDefaultBaseagent();
      const modelAgent = this.getAgent(channel, fallbackBaseagent);
      const modelState = resolveCommandModelResolution({
        agent: modelAgent,
        session: modelSession,
        selfAid: selfAID ?? this.resolveSelfAID(channel),
        channelType: this.resolveChannelType(channel),
        channelId,
        userId,
        role: identity.role,
      });
      const rawModels = hasModelSwitcher(modelAgent) ? await modelAgent.listModels() : [];
      const models = hasModelSwitcher(modelAgent)
        ? filterModelsForRole(identity.role, fallbackBaseagent, rawModels, (modelAgent as any).resolveModelId?.bind(modelAgent))
        : rawModels;
      const currentModel = hasModelSwitcher(modelAgent) ? (modelState.model || modelAgent.getModel()) : modelAgent.name;
      const efforts = getAvailableEfforts(modelAgent, currentModel);
      const currentEffort = modelState.effort || 'auto';

      // 尝试发送 CommandCard 卡片
      if (this.interactionRouter && models.length > 0) {
        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `model-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: modelSession?.id || `model-${Date.now()}`,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '🤖 切换模型',
            buttons: models.map((m: string) => {
              const display = modelDisplayLabel(modelAgent, m);
              return {
                label: modelMatches(modelAgent, m, currentModel) ? `✓ ${display}` : display,
                command: `/model ${m}`,
                style: (modelMatches(modelAgent, m, currentModel) ? 'primary' : 'default') as 'primary' | 'default',
                disabled: modelMatches(modelAgent, m, currentModel),
              };
            }),
          },
        };

        const replyCtx = modelSession ? this.getReplyContext(modelSession) : undefined;
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }

      // 降级：文本
      const modelList = models.map((m: string) => `  ${modelMatches(modelAgent, m, currentModel) ? '✓' : ' '} ${modelDisplayLabel(modelAgent, m)}`).join('\n');
      const effortHint = efforts.length > 0
        ? `\n推理强度: ${currentEffort === 'auto' ? 'auto (SDK默认)' : currentEffort}  (使用 /effort 调整)`
        : '';
      if (isAdmin) {
        return { kind: 'command.result' as const, text: `当前模型: ${modelDisplayLabel(modelAgent, currentModel)}${effortHint}\n\n可用模型：\n${modelList}\n\n用法: /model <模型>` };
      }
      return { kind: 'command.result' as const, text: `当前模型: ${modelDisplayLabel(modelAgent, currentModel)}${effortHint}` };
    }

    // 切换模型写入 agent/baseagent 配置；没有活跃会话时也不应创建空会话。
    const modelSession = await getExistingSessionForCommand();
    const fallbackBaseagent = modelSession?.baseagent || this.agentRegistry?.resolveByChannel(channel)?.baseagent || this.parseDefaultBaseagent();
    const modelAgent = this.getAgent(channel, fallbackBaseagent);
    const modelState = resolveCommandModelResolution({
      agent: modelAgent,
      session: modelSession,
      selfAid: selfAID ?? this.resolveSelfAID(channel),
      channelType: this.resolveChannelType(channel),
      channelId,
      userId,
      role: identity.role,
    });

    const models = hasModelSwitcher(modelAgent) ? await modelAgent.listModels() : [];
    const allowedModels = hasModelSwitcher(modelAgent)
      ? filterModelsForRole(identity.role, fallbackBaseagent, models, (modelAgent as any).resolveModelId?.bind(modelAgent))
      : models;

    const parts = args.split(/\s+/);
    let newModel: string | undefined;
    let newEffort: Effort | undefined;

    if (parts.length === 1) {
      const arg = parts[0];
      const currentModel = hasModelSwitcher(modelAgent) ? (modelState.model || modelAgent.getModel()) : modelAgent.name;
      const efforts = getAvailableEfforts(modelAgent, currentModel);
      // effort 相关参数统一转发到 /effort
      if ((efforts as readonly string[]).includes(arg) || arg === 'auto') {
        const delegated = await this.handle(`/effort ${arg}`, channel, channelId, undefined, userId, threadId);
        return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
      } else if ((allEfforts as readonly string[]).includes(arg)) {
        return { kind: 'command.error' as const, text: `⚠️ 请使用 /effort ${arg} 调整推理强度` };
      } else {
        const resolvedArg = hasModelSwitcher(modelAgent) ? ((modelAgent as any).resolveModelId?.(arg) ?? arg) : arg;
        if (models.includes(resolvedArg)) {
          newModel = resolvedArg;
        } else if (models.includes(arg)) {
          newModel = arg;
        } else {
          const modelList = allowedModels.map((m: string) => `  ${modelMatches(modelAgent, m, currentModel) ? '✓' : ' '} ${modelDisplayLabel(modelAgent, m)}`).join('\n');
          const effortHint = efforts.length > 0 ? `\n\n推理强度请使用 /effort 命令` : '';
          return { kind: 'command.error' as const, text: `❌ 无效参数: ${arg}\n\n可用模型：\n${modelList}${effortHint}` };
        }
      }
    } else {
      // 双参数：model effort
      const [modelArgRaw, effortArg] = parts;
      const modelArg = hasModelSwitcher(modelAgent)
          ? (models.includes(modelArgRaw) ? modelArgRaw : ((modelAgent as any).resolveModelId?.(modelArgRaw) ?? modelArgRaw))
        : modelArgRaw;
      if (!models.includes(modelArg)) {
        return { kind: 'command.error' as const, text: `❌ 无效的模型ID: ${modelArgRaw}` };
      }
      const targetEfforts = getAvailableEfforts(modelAgent, modelArg);
      if (targetEfforts.length === 0) {
        return { kind: 'command.error' as const, text: `⚠️ ${modelArg} 不支持推理强度设置` };
      }
      if (!(targetEfforts as readonly string[]).includes(effortArg)) {
        const errorLabel = (allEfforts as readonly string[]).includes(effortArg) ? '⚠️' : '❌';
        return { kind: 'command.result' as const, text: `${errorLabel} ${modelArg} 不支持 ${effortArg} 推理强度\n可选: ${targetEfforts.join(' / ')}` };
      }
      newModel = modelArg;
      newEffort = effortArg as Effort;
    }

    // 运行时 model/effort 切换已通过 EvolAgent.setBaseagentModel/setBaseagentEffort 持久化

    if (newModel) {
      const decision = validateModelSelectionForRole({
        role: identity.role,
        baseagent: fallbackBaseagent,
        requestedModel: newModel,
        models,
        resolveModelId: (modelAgent as any).resolveModelId?.bind(modelAgent),
      });
      if (!decision.ok) {
        return { kind: 'command.error' as const, text: decision.message || `invalid model: ${newModel}` };
      }
      newModel = decision.model || newModel;
    }

    const isCodexAgent = modelAgent.name === 'codex';
    const changes: string[] = [];

    if (newModel) {
      modelAgent.setModel?.(newModel);
      this.eventBus.publish({
        type: 'runner:model-changed',
        sessionId: modelSession?.id,
        agentName: this.agentRegistry?.resolveByChannel(channel)?.name,
        baseagent: modelSession?.baseagent || modelAgent.name,
        model: newModel,
        effort: newEffort,
        timestamp: Date.now()
      });
      changes.push(`模型: ${newModel}`);
    }

    if (newEffort) {
      modelAgent.setEffort?.(newEffort);
      if (!newModel) {
        this.eventBus.publish({
          type: 'runner:model-changed',
          sessionId: modelSession?.id,
          agentName: this.agentRegistry?.resolveByChannel(channel)?.name,
          baseagent: modelSession?.baseagent || modelAgent.name,
          effort: newEffort,
          timestamp: Date.now(),
        });
      }
      changes.push(`推理强度: ${newEffort}`);
    }

    // 持久化：agent-owned channel 写到 agent.json；default 走原"就近原则"
    if (newModel) {
      const err = this.persistBaseagentModel(channel, modelAgent.name, newModel);
      if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
    }
    if (newEffort) {
      const err = this.persistBaseagentEffort(channel, modelAgent.name, newEffort);
      if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
    }

    if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
    return { kind: 'command.result' as const, text: `✓ 已切换\n  ${changes.join('\n  ')}` };
  }

  // /effort 命令：查看或切换推理强度
  if (normalizedContent.startsWith('/effort')) {
    const args = normalizedContent.slice(7).trim();

    if (!args) {
      const effortSession = await getExistingSessionForCommand();
      const fallbackBaseagent = effortSession?.baseagent || this.agentRegistry?.resolveByChannel(channel)?.baseagent || this.parseDefaultBaseagent();
      const effortAgent = this.getAgent(channel, fallbackBaseagent);
      const effortState = resolveCommandModelResolution({
        agent: effortAgent,
        session: effortSession,
        selfAid: selfAID ?? this.resolveSelfAID(channel),
        channelType: this.resolveChannelType(channel),
        channelId,
        userId,
        role: identity.role,
      });

      const currentModel = hasModelSwitcher(effortAgent) ? (effortState.model || effortAgent.getModel()) : effortAgent.name;
      const efforts = getAvailableEfforts(effortAgent, currentModel);
      const currentEffort = effortState.effort || 'auto';

      if (efforts.length === 0) {
        return { kind: 'command.error' as const, text: '⚠️ 当前模型不支持推理强度设置' };
      }

      // /effort（无参数）：显示当前推理强度 + 发送 CommandCard 卡片
      if (this.interactionRouter) {
        const allItems = [...efforts, 'auto'];
        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `effort-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: effortSession?.id || `effort-${Date.now()}`,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '⚡ 推理强度',
            buttons: allItems.map(e => ({
              label: e === currentEffort ? `✓ ${e}` : e,
              command: `/effort ${e}`,
              style: (e === currentEffort ? 'primary' : 'default') as 'primary' | 'default',
              disabled: e === currentEffort,
            })),
          },
        };

        const replyCtx = effortSession ? this.getReplyContext(effortSession) : undefined;
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }

      // 降级：文本
      const effortDisplay = currentEffort === 'auto' ? 'auto (SDK默认)' : currentEffort;
      const effortOptions = [...efforts, 'auto'].join(' / ');
      if (isAdmin) {
        return { kind: 'command.result' as const, text: `推理强度: ${effortDisplay}  可选: ${effortOptions}  用法: /effort <level>` };
      }
      return { kind: 'command.result' as const, text: `推理强度: ${effortDisplay}` };
    }

    const effortSession = await getExistingSessionForCommand();
    const fallbackBaseagent = effortSession?.baseagent || this.agentRegistry?.resolveByChannel(channel)?.baseagent || this.parseDefaultBaseagent();
    const effortAgent = this.getAgent(channel, fallbackBaseagent);
    const effortState = resolveCommandModelResolution({
      agent: effortAgent,
      session: effortSession,
      selfAid: selfAID ?? this.resolveSelfAID(channel),
      channelType: this.resolveChannelType(channel),
      channelId,
      userId,
      role: identity.role,
    });

    const currentModel = hasModelSwitcher(effortAgent) ? (effortState.model || effortAgent.getModel()) : effortAgent.name;
    const efforts = getAvailableEfforts(effortAgent, currentModel);
    const currentEffort = effortState.effort || 'auto';

    if (efforts.length === 0) {
      return { kind: 'command.error' as const, text: '⚠️ 当前模型不支持推理强度设置' };
    }

    // 带参（切换）需 admin+；无参查询已在上方返回
    if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：切换推理强度仅限管理员使用' };

    // /effort auto：恢复 SDK 默认
    if (args === 'auto') {
      effortAgent.setEffort?.(undefined);
      const err = this.persistBaseagentEffort(channel, effortAgent.name, undefined);
      if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
      this.eventBus.publish({
        type: 'runner:model-changed',
        sessionId: effortSession?.id,
        agentName: this.agentRegistry?.resolveByChannel(channel)?.name,
        baseagent: effortSession?.baseagent || effortAgent.name,
        effort: 'auto',
        timestamp: Date.now(),
      });
      if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
      return { kind: 'command.result' as const, text: '✓ 推理强度已恢复为 auto (SDK默认)' };
    }

    // /effort <level>：切换推理强度
    if (!(efforts as readonly string[]).includes(args)) {
      if ((allEfforts as readonly string[]).includes(args)) {
        return { kind: 'command.error' as const, text: `⚠️ ${currentModel} 不支持 ${args} 推理强度\n可选: ${efforts.join(' / ')}` };
      }
      return { kind: 'command.error' as const, text: `❌ 无效参数: ${args}\n可选: ${efforts.join(' / ')} / auto` };
    }

    const newEffort = args as Effort;
    effortAgent.setEffort?.(newEffort);

    const err = this.persistBaseagentEffort(channel, effortAgent.name, newEffort);
    if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
    this.eventBus.publish({
      type: 'runner:model-changed',
      sessionId: effortSession?.id,
      agentName: this.agentRegistry?.resolveByChannel(channel)?.name,
      baseagent: effortSession?.baseagent || effortAgent.name,
      effort: newEffort,
      timestamp: Date.now(),
    });

    if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
    return { kind: 'command.result' as const, text: `✓ 推理强度: ${newEffort}` };
  }

  // /reload [aid] — 热重载 agent 配置
  // daemon owner：可 reload 任意 aid（无参则 reload 自身所在 agent）
  // agent channel owner/admin：仅可 reload 自身 agent
  if (normalizedContent === '/reload' || normalizedContent.startsWith('/reload ')) {
    const aidArg = normalizedContent.slice('/reload'.length).trim() || undefined;
    const selfAid = this.agentRegistry?.resolveByChannel(channel)?.aid;

    // 权限判断：daemon owner 或 agent channel 的 owner/admin
    if (!isDaemonOwner && !isAdmin) {
      return { kind: 'command.error' as const, text: '❌ 无权限：/reload 仅限 daemon owner 或 agent owner/admin 使用' };
    }
    // agent channel 的 owner/admin 不能跨 agent reload
    if (!isDaemonOwner && aidArg && aidArg !== selfAid) {
      return { kind: 'command.error' as const, text: '❌ 无权限：跨 agent reload 仅限 daemon owner 使用' };
    }

    const targetAid = aidArg ?? selfAid;
    if (!targetAid) {
      return { kind: 'command.error' as const, text: '❌ 无法确定目标 agent，请指定 aid：/reload <aid>' };
    }

    // 繁忙检查（同 menu /agent reload）
    const busyInfo = getAgentBusyInfo(this, targetAid);
    if (busyInfo && busyInfo.count > 0) {
      const processingLines = busyInfo.processing.map(p => {
        const sessionId = p.queueKey.split('::')[0] || '?';
        return `  · ${sessionId.slice(0, 32)}...`;
      }).join('\n');
      return { kind: 'command.error' as const, text: `❌ 该 Agent 有 ${busyInfo.count} 个任务执行中，无法 reload。\n\n处理中：\n${processingLines}\n\n等待任务完成后重试，通常 30-60 秒。` };
    }

    const res = await execAgentAction('reload', { aid: targetAid }, userId ?? '', this.eventBus);
    if ('error' in res) return { kind: 'command.error' as const, text: `❌ reload 失败：${res.error}` };
    return { kind: 'command.result' as const, text: `✅ Agent ${targetAid} 配置已重载` };
  }

  // /agent, /aid, /rpc, /storage — 仅限 ctl 调用，slash 输入拒绝
  if (normalizedContent === '/agent' || normalizedContent.startsWith('/agent ') ||
      normalizedContent === '/aid' || normalizedContent.startsWith('/aid ') ||
      normalizedContent === '/rpc' || normalizedContent.startsWith('/rpc ') ||
      normalizedContent === '/storage' || normalizedContent.startsWith('/storage ')) {
    return { kind: 'command.error' as const, text: '❌ 此命令仅限 ctl 调用，不支持 slash 输入' };
  }


  if (normalizedContent === '/activity' || normalizedContent.startsWith('/activity ')) {
    const activityArg = normalizedContent.slice(9).trim();
    // 带参（写操作）需 admin+；无参查询对所有人开放（owner 门在具体切换点还有一道）
    if (activityArg && !isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限管理员使用' };

    // proactive 模式下流式输出全部静默，activity 配置无意义
    if (activeSession?.chatMode === 'proactive') {
      return { kind: 'command.error' as const, text: '❌ 当前会话为 proactive 模式，不支持 activity 配置（流式输出已全部静默）' };
    }

    const modeMap: Record<string, 'all' | 'none'> = {
      all: 'all',
      none: 'none',
    };

    const currentMode = this.agentRegistry?.getShowActivities?.(channel) ?? 'all';

    // 模式描述列表（用于 body 和文本降级）。show_activities 收敛为 all|none：
    // all = 私聊显示中间输出；none = 全部静默（群聊本就强制 proactive、不发活动）。
    const modeDescriptions: { key: string; configVal: string; label: string }[] = [
      { key: 'all', configVal: 'all', label: '私聊显示' },
      { key: 'none', configVal: 'none', label: '全部静默' },
    ];

    if (!activityArg) {
      // 尝试发送 CommandCard 卡片
      {
        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `activity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: activeSession?.id || '',
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '📋 中间输出模式',
            body: modeDescriptions.map(m =>
              `${m.configVal === currentMode ? '✓' : '•'} **${m.key}** (${m.label})`
            ).join('\n'),
            buttons: modeDescriptions.map(m => ({
              label: m.configVal === currentMode ? `✓ ${m.key}` : m.key,
              command: `/activity ${m.key}`,
              style: (m.configVal === currentMode ? 'primary' : 'default') as 'primary' | 'default',
              disabled: m.configVal === currentMode,
            })),
          },
        };

        const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isOwner });
        if (cardResult === null) return null;
        // 卡片降级：fall through 到下方文本输出
      }

      // 降级：文本
      const modeList = modeDescriptions.map(m => {
        const prefix = m.configVal === currentMode ? '✓' : '•';
        return `  ${prefix} ${m.key} — ${m.label}`;
      }).join('\n');
      if (isOwner) {
        return { kind: 'command.result' as const, text: `中间输出: ${currentMode}  用法: /activity <all|none>` };
      }
      return { kind: 'command.result' as const, text: `中间输出: ${currentMode}` };
    }

    const newMode = modeMap[activityArg];
    if (!newMode) {
      return { kind: 'command.error' as const, text: `❌ 无效参数: ${activityArg}\n可选: all / none` };
    }

    const label = modeDescriptions.find(m => m.configVal === newMode)?.label || newMode;

    if (newMode === currentMode) {
      return { kind: 'command.result' as const, text: `📋 中间输出模式已是 ${activityArg}（${label}）` };
    }

    // 切换操作仅 owner
    if (!isOwner) return { kind: 'command.error' as const, text: '❌ 中间输出模式切换仅限 owner' };

    if (this.agentRegistry?.setShowActivities) {
      this.agentRegistry.setShowActivities(channel, newMode);
    } else {
      return { kind: 'command.error' as const, text: `⚠️ 找不到通道 "${channel}" 所属的 self-agent，无法持久化` };
    }
    if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
    return { kind: 'command.result' as const, text: `✅ 中间输出模式: ${activityArg}（${label}）` };
  }

  // /chatmode 命令：查看/切换 session 会话模式（interactive | proactive）
  // - 查看：所有人可用
  // - 设置：单聊任何角色可设置；群聊仅管理员可设置
  if (normalizedContent === '/chatmode' || normalizedContent.startsWith('/chatmode ')) {
    const arg = normalizedContent.slice(9).trim();
    if (!arg) {
      const existingChatmodeSession = await getExistingSessionForCommand();
      const fallbackMode = this.agentRegistry?.resolveByChannel(channel)?.config?.chatmode?.private;
      const currentMode = existingChatmodeSession?.chatMode || fallbackMode || 'interactive';
      const chatmodeChatType = existingChatmodeSession?.chatType || activeChatType;
      const isGroup = chatmodeChatType === 'group';
      if (isGroup) {
        return { kind: 'command.result' as const, text: `📋 会话模式: proactive（群聊强制）` };
      }
      // 尝试发送 CommandCard 卡片
      const modes = [
        { key: 'interactive', name: '交互模式', desc: '被动响应：收到消息时才回复，回复直接显示' },
        { key: 'proactive', name: '主动模式', desc: '主动推进：流式输出静默，由 Agent 自调 ctl send 发声' },
      ];
      const interaction: InteractionRequest = {
        type: 'interaction',
        id: `chatmode-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        channelId,
        sessionId: existingChatmodeSession?.id || `chatmode-${Date.now()}`,
        initiatorId: userId,
        kind: {
          kind: 'command-card',
          title: '🔄 会话模式',
          body: modes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.name}) - ${m.desc}`).join('\n'),
          buttons: modes.map(m => ({
            label: m.key === currentMode ? `✓ ${m.key}` : m.key,
            command: `/chatmode ${m.key}`,
            style: (m.key === currentMode ? 'primary' : 'default') as 'primary' | 'default',
            disabled: m.key === currentMode,
          })),
        },
      };

      const replyCtx = existingChatmodeSession ? this.getReplyContext(existingChatmodeSession) : undefined;
      const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
      if (cardResult === null) return null;
      // 卡片降级：fall through 到下方文本输出

      // 降级：文本
      return { kind: 'command.result' as const, text: `会话模式: ${currentMode}  用法: /chatmode <interactive|proactive>` };
    }

    const chatmodeSession = await getExistingSessionForCommand();
    if (!chatmodeSession) return { kind: 'command.error' as const, text: '❌ 当前没有活跃会话，无法切换会话模式' };

    const currentMode = chatmodeSession.chatMode || 'interactive';
    const chatmodeChatType = chatmodeSession.chatType || activeChatType;
    const isGroup = chatmodeChatType === 'group';
    const canSwitch = !isGroup;

    if (arg !== 'interactive' && arg !== 'proactive') {
      return { kind: 'command.error' as const, text: `❌ 无效模式: ${arg}\n可选: interactive / proactive` };
    }

    // 群聊强制 proactive，不可切换
    if ((chatmodeSession.chatType || activeChatType) === 'group') {
      return { kind: 'command.error' as const, text: '❌ 群聊强制 proactive 模式，不可切换' };
    }

    if (arg === currentMode) {
      return { kind: 'command.result' as const, text: `📋 当前会话模式已是 ${arg}` };
    }

    // 仅在真正需要切换时才要求会话空闲
    if (threadId) {
      const threadSession = await this.sessionManager.getThreadSession(channel, channelId, threadId);
      if (threadSession) {
        const threadAgent = this.getAgent(channel, threadSession.baseagent);
        if (threadAgent.hasActiveStream(threadSession.id) || this.messageQueue?.isProcessing(threadSession.id)) {
          return { kind: 'command.error' as const, text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
        }
      }
    } else if (getActiveAgent().hasActiveStream(chatmodeSession.id) || this.messageQueue?.isProcessing(chatmodeSession.id)) {
      return { kind: 'command.error' as const, text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
    }

    await this.sessionManager.updateSession(chatmodeSession.id, { chatMode: arg });
    this.eventBus.publish({ type: 'session:chat-mode-changed', sessionId: chatmodeSession.id, mode: arg, timestamp: Date.now() });
    if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
    return { kind: 'command.result' as const, text: `✅ 会话模式已切换: ${arg}` };
  }

  // /dispatch 命令：查看/切换群聊分发模式（mention | broadcast）
  // 仅群聊可用；群聊中设置需管理员权限
  if (normalizedContent === '/dispatch' || normalizedContent.startsWith('/dispatch ')) {
    const dispatchSession = await getExistingSessionForCommand();
    if (!dispatchSession) return { kind: 'command.error' as const, text: '❌ 当前没有活跃会话' };

    const dispatchChatType = dispatchSession.chatType || activeChatType;
    if (dispatchChatType !== 'group') {
      return { kind: 'command.error' as const, text: '❌ /dispatch 仅在群聊中可用' };
    }

    const arg = normalizedContent.slice(9).trim();
    const currentMode = dispatchSession.metadata?.dispatchModeOverride ?? dispatchSession.metadata?.dispatchMode ?? null;

    if (!arg) {
      const displayMode = currentMode ?? '未设置（跟随群设置）';
      // 尝试发送 CommandCard 卡片
      if (isAdmin) {
        const modes = [
          { key: 'mention', name: '提及模式', desc: '仅当被 @ 提及（含 @all）时响应群消息' },
          { key: 'broadcast', name: '广播模式', desc: '群内所有消息都触发响应' },
        ];
        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `dispatch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: dispatchSession.id,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '📡 分发模式',
            body: modes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.name}) - ${m.desc}`).join('\n'),
            buttons: modes.map(m => ({
              label: m.key === currentMode ? `✓ ${m.key}` : m.key,
              command: `/dispatch ${m.key}`,
              style: (m.key === currentMode ? 'primary' : 'default') as 'primary' | 'default',
              disabled: m.key === currentMode,
            })),
          },
        };

        const replyCtx = this.getReplyContext(dispatchSession);
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
        if (cardResult === null) return null;
        // 卡片降级：fall through 到下方文本输出
      }

      // 降级：文本
      if (isAdmin) {
        return { kind: 'command.result' as const, text: `分发模式: ${displayMode}  用法: /dispatch <mention|broadcast|clear>` };
      }
      return { kind: 'command.result' as const, text: `分发模式: ${displayMode}` };
    }

    if (arg !== 'mention' && arg !== 'broadcast' && arg !== 'clear') {
      return { kind: 'command.error' as const, text: `❌ 无效模式: ${arg}\n可选: mention / broadcast / clear\n用法: /dispatch <模式>` };
    }

    if (!isAdmin) {
      return { kind: 'command.error' as const, text: '❌ 无权限：群聊中切换分发模式仅限管理员使用' };
    }

    if (arg === 'clear') {
      if (!dispatchSession.metadata?.dispatchModeOverride) {
        return { kind: 'command.result' as const, text: '当前无本地覆盖，已跟随群设置' };
      }
      const { dispatchModeOverride: _, ...rest } = dispatchSession.metadata;
      await this.sessionManager.updateSession(dispatchSession.id, { metadata: rest });
      this.eventBus.publish({ type: 'session:dispatch-mode-changed', sessionId: dispatchSession.id, mode: undefined, timestamp: Date.now() });
      if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
      return { kind: 'command.result' as const, text: '✅ 已清除本地覆盖，将跟随群设置' };
    }

    if (arg === currentMode) {
      return { kind: 'command.result' as const, text: `当前已是 ${arg}` };
    }

    const metadata = { ...(dispatchSession.metadata || {}), dispatchModeOverride: arg };
    await this.sessionManager.updateSession(dispatchSession.id, { metadata });
    this.eventBus.publish({ type: 'session:dispatch-mode-changed', sessionId: dispatchSession.id, mode: arg, timestamp: Date.now() });
    if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
    return { kind: 'command.result' as const, text: `✅ 分发模式已切换: ${currentMode ?? '未设置'} → ${arg}` };
  }

  // /stop 命令：中断当前任务
  if (normalizedContent === '/stop') {
    const stopSession = await getExistingSessionForCommand();
    if (!stopSession) return { kind: 'command.result' as const, text: '当前没有正在处理的任务' };
    const stopAgent = this.getAgent(channel, stopSession.baseagent);
    const sessionKey = stopSession.id;

    const queueLength = this.messageQueue.getQueueLength(sessionKey);
    const hasActive = stopAgent.hasActiveStream(sessionKey);
    const isProcessing = this.messageQueue.isProcessing(sessionKey);

    if (queueLength === 0 && !hasActive && !isProcessing) {
      return { kind: 'command.result' as const, text: '当前没有正在处理的任务' };
    }

    await stopAgent.interrupt(sessionKey);
    // 发布中断事件，让 MessageProcessor 标记为 interrupted（而非 done）
    this.eventBus.publish({
      type: 'task:interrupted',
      sessionId: sessionKey,
      reason: 'stop',
      agentName: this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>',
    });
    // 强制清除 processing_state
    this.sessionManager.clearProcessing(sessionKey);
    return { kind: 'command.result' as const, text: '✓ 已发送中断信号，任务将尽快停止' };
  }

  // /clear 已移除：Claude/Codex/Gemini 对“清空当前 backend 历史”的语义不一致。
  // 统一使用 /new 创建新会话来开始全新上下文。
  if (normalizedContent === '/clear') {
    return { kind: 'command.error' as const, text: '⚠️ /clear 已移除\n\n请使用 /new [名称] 创建新会话来开始全新上下文。旧会话会保留，可通过 /s 查看或切换。' };
  }

  // /compact 命令：手动压缩会话上下文
  if (normalizedContent === '/compact') {
    const session = await getExistingSessionForCommand();
    if (!session) return { kind: 'command.error' as const, text: '❌ 当前没有活跃会话，无需压缩' };

    const sessionAgent = this.getAgent(channel, session.baseagent);
    if (!sessionAgent.capabilities?.compact) {
      return { kind: 'command.error' as const, text: `❌ 当前 Agent (${sessionAgent.name}) 不支持 /compact` };
    }

    if (!session.agentSessionId) {
      return { kind: 'command.error' as const, text: '❌ 当前会话没有历史记录，无需压缩' };
    }

    const projectPath = path.isAbsolute(session.projectPath)
      ? session.projectPath
      : path.resolve(process.cwd(), session.projectPath);

    const releaseLock = this.messageQueue.acquireLock(session.id);
    try {
      if (sendMessage) {
        await sendMessage(channelId, '⏳ 正在压缩会话上下文...', this.getReplyContext(session));
      }

      const compacted = await sessionAgent.compactSession(session.id, session.agentSessionId, projectPath);
      if (compacted) {
        return {
          kind: 'command.result' as const,
          text: '✅ 会话压缩完成',
        };
      } else {
        return { kind: 'command.error' as const, text: '❌ 会话压缩失败，请稍后重试' };
      }
    } finally {
      releaseLock();
    }
  }

  // 后续命令可读取现有会话，但不应在这里隐式创建新会话。
  // 真正需要新会话的命令应显式调用 createNewSession()。
  let session: Session | undefined;
  if (threadId) {
    session = await this.sessionManager.getThreadSession(channel, channelId, threadId);
  } else {
    session = await this.sessionManager.getActiveSession(channel, channelId);
  }

  // /status 命令：显示会话状态
  if (normalizedContent === '/status') {
    if (!session) {
      return { kind: 'command.result' as const, text: `📊 会话状态：当前没有活跃会话\n发送消息或使用 /new [名称] 创建会话` };
    }

    const sessionKey = this.getQueueKey(session, channel, channelId);
    const sessionAgent = this.getAgent(channel, session.baseagent);
    const isCurrentlyProcessing = this.messageQueue.isProcessing(sessionKey) || sessionAgent.hasActiveStream(sessionKey);
    const queueLength = this.messageQueue.getQueueLength(sessionKey);

    const isThread = !!session.threadId;
    let sessionStatus = isCurrentlyProcessing ? '处理中' : '空闲';
    // 处理中时显示时长
    if (isCurrentlyProcessing) {
      const elapsed = Date.now() - parseInt(session.processingState!, 10);
      if (!isNaN(elapsed) && elapsed > 0) {
        const sec = Math.floor(elapsed / 1000);
        sessionStatus = sec < 60 ? `处理中 (${sec}秒)` :
                        sec < 3600 ? `处理中 (${Math.floor(sec / 60)}分钟)` :
                        `处理中 (${Math.floor(sec / 3600)}小时)`;
      }
    }

    const projectName = this.getProjectName(session.projectPath);
    const owningAgent = this.getOwningAgent(channel);
    const agentName = owningAgent?.name ?? 'DefaultAgent';

    const health = await this.sessionManager.getHealthStatus(session.id);
    const timeSinceSuccess = Date.now() - health.lastSuccessTime;
    const timeStr = timeSinceSuccess < 60000 ? '刚刚' :
                    timeSinceSuccess < 3600000 ? `${Math.floor(timeSinceSuccess / 60000)}分钟前` :
                    `${Math.floor(timeSinceSuccess / 3600000)}小时前`;

    // 获取会话文件信息并同步 name
    let sessionTurns = 0;
    if (session.agentSessionId) {
      const fileInfo = this.sessionManager.getSessionFileInfo(session.projectPath, session.agentSessionId, session.baseagent);
      sessionTurns = fileInfo.turns;
      if (fileInfo.title && fileInfo.title !== session.name) {
        await this.sessionManager.renameSession(session.id, fileInfo.title);
        session.name = fileInfo.title;
      }
    }

    // 获取 git 工作目录信息
    const gitInfo = await getGitWorkingDirInfo(session.projectPath);

    const lines: string[] = [];
    const chatMode = session.chatMode || 'interactive';
    const dispatchMode = session.metadata?.dispatchModeOverride ?? session.metadata?.dispatchMode ?? '未设置（跟随群设置）';
    const chatModeLine = `会话模式: ${chatMode}`;
    const dispatchModeLine = session.chatType === 'group' ? `分发模式: ${dispatchMode}` : null;
    if (isAdmin) {
      lines.push(
        `📊 ${isThread ? '话题' : '会话'}状态 (Agent: ${agentName})：`,
        `渠道: ${this.resolveChannelType(channel)} / 项目: ${projectName} / 会话: ${displaySessionTitle(session.name, '(未命名)')}`,
        `会话ID: ${session.id}`,
        `项目路径: ${session.projectPath}`,
      );
      if (gitInfo) {
        lines.push(`Git: ${gitInfo}`);
      }
      lines.push(
        `会话状态: ${sessionStatus} / 轮数: ${sessionTurns}`,
        chatModeLine,
        ...(dispatchModeLine ? [dispatchModeLine] : []),
      );
      if (health.consecutiveErrors > 0) {
        lines.push(`异常计数: ${health.consecutiveErrors}`);
      }
      lines.push(
        `最后成功: ${timeStr}`,
        `${session.baseagent}会话: ${session.agentSessionId || '(未初始化)'}`,
        `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
        `更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`
      );
    } else {
      lines.push(
        `📊 ${isThread ? '话题' : '会话'}状态 (Agent: ${agentName})：`,
        `渠道: ${channel} / 项目: ${projectName} / ${session.baseagent}会话`,
      );
      if (gitInfo) {
        lines.push(`Git: ${gitInfo}`);
      }
      lines.push(
        `状态: ${sessionStatus} / 轮数: ${sessionTurns}`,
        chatModeLine,
        ...(dispatchModeLine ? [dispatchModeLine] : []),
        `最后活跃: ${timeStr}`
      );
    }

    if (health.lastError) {
      lines.push('');
      lines.push(`最后错误: ${health.lastErrorType || 'unknown'}`);
      lines.push(`错误信息: ${health.lastError.substring(0, 100)}`);
    }

    return { kind: 'command.result' as const, text: lines.join('\n') };
  }

  // /new 命令：创建新会话（支持命名）
  if (normalizedContent.startsWith('/new')) {
    const sessionName = normalizedContent.slice(4).trim() || undefined;

    if (sessionName) {
      const existing = await this.sessionManager.getSessionByName(channel, channelId, sessionName);
      if (existing) {
        return { kind: 'command.error' as const, text: `❌ 会话名称 "${sessionName}" 已存在，请使用其他名称` };
      }
    }

    const projectPath = this.getEffectiveDefaultPath(channel);

    if (sendMessage && session) {
      await sendMessage(
        channelId,
        `⏳ 正在创建新会话${sessionName ? `: ${sessionName}` : ''}...`,
        this.getReplyContext(session)
      );
    }

    const newSession = await this.sessionManager.createNewSession(
      channel,
      channelId,
      projectPath,
      sessionName,
      this.agentRegistry?.resolveByChannel(channel)?.baseagent || session?.baseagent || this.parseDefaultBaseagent()
    );

    const previousAgent = getActiveAgentIfAvailable();
    if (session && previousAgent) {
      // Reset agent backend state so the new
      // session starts with a fresh conversation history
      await previousAgent.clearSession(session.id, session.agentSessionId || '', session.projectPath);
      await previousAgent.closeSession(session.id);
    }

    const newAgent = this.agentRegistry?.resolveByChannel(channel);
    const newBaseagent = newSession.baseagent || newAgent?.baseagent || this.parseDefaultBaseagent();
    // 与 /model 卡片保持一致：按 关系>角色>agent 解析实际生效的 model/effort，
    // 不直接读 EvolAgent.model（那只是 agent 级静态配置，会无视关系/角色级覆盖）。
    const newRunner = this.getAgent(channel, newSession.baseagent);
    const newModelState = resolveCommandModelResolution({
      agent: newRunner,
      session: newSession,
      selfAid: selfAID ?? this.resolveSelfAID(channel),
      channelType: this.resolveChannelType(channel),
      channelId,
      userId,
      role: identity.role,
    });
    const backendModel = newModelState.model || newAgent?.model;
    const backendEffort = newModelState.effort || newAgent?.effort;
    const backendBits = [newBaseagent, backendModel, backendEffort].filter(Boolean).join(' · ');
    return { kind: 'command.result' as const, text: `✓ 已创建新会话${sessionName ? `: ${sessionName}` : ''}\n  项目: ${this.getProjectName(projectPath)}\n  后端: ${backendBits}\n  之前的对话历史已保留，可通过 /s 查看` };
  }

  // /check 命令：检查渠道状态（guest 可用，详情仅 admin）
  if (normalizedContent === '/check' || normalizedContent.startsWith('/check ')) {

    // 限定可见渠道：agent-owned 通道仅显示该 agent 名下的渠道；
    // __ecweb__ 是 ECWeb 系统级入口，展示全量渠道
    const checkOwningAgent = this.getOwningAgent(channel);
    let allowedChannels: Set<string>;
    if (checkOwningAgent) {
      allowedChannels = new Set(checkOwningAgent.channelInstanceNames());
    } else if (channel === '__ecweb__') {
      // ECWeb 全局视图：展示所有渠道
      allowedChannels = new Set(this.adapters.keys());
    } else {
      // default 范围：不再有 default channel 概念，等价于"所有 channel"
      const defaultNames: string[] = [];
      for (const [name] of this.adapters) {
        const owner = this.agentRegistry?.resolveByChannel(name);
        if (!owner) defaultNames.push(name);
      }
      allowedChannels = new Set(defaultNames);
    }

    // Default: show system health check (non-admin 仅看摘要)
    const checkAgentName = checkOwningAgent?.name ?? 'DefaultAgent';
    const checkDefaultBaseagent = checkOwningAgent?.baseagent ?? this.parseDefaultBaseagent();
    const checkBaseagent = activeSession?.baseagent ?? checkDefaultBaseagent;
    const lines: string[] = [`📡 渠道状态 (Agent: ${checkAgentName})：`];
    lines.push(`  Baseagent: ${checkBaseagent}`);
    if (checkDefaultBaseagent !== checkBaseagent) {
      lines.push(`  默认 Baseagent: ${checkDefaultBaseagent}`);
    }
    // Group by channelType
    const groups = new Map<string, Array<{ name: string; status: string }>>();
    for (const [name] of this.adapters) {
      if (!allowedChannels.has(name)) continue;
      const type = this.resolveChannelType(name);
      const ch = this.channelObjects.get(name);
      let status: string;
      if (ch?.getStatus) {
        const s = ch.getStatus();
        status = s.connected ? '✓ 已连接' : '⏳ 重连中';
      } else {
        status = '✓ 已注册';
      }
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push({ name, status });
    }

    if (!isAdmin) {
      // guest/user: 仅显示渠道健康摘要
      const total = [...groups.values()].flat().length;
      const healthy = [...groups.values()].flat().filter(i => i.status.includes('✓')).length;
      lines.push(`  ${healthy}/${total} 渠道正常`);
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    for (const [type, instances] of groups) {
      if (instances.length === 1) {
        lines.push(`  ${type}: ${instances[0].status}`);
      } else {
        const parts = instances.map(i => {
          const seg = i.name.split('#');
          const instName = seg.length >= 3 ? seg.slice(2).join('#') : i.name;
          return `${i.status.includes('✓') ? '✓' : '⏳'} ${instName}`;
        });
        lines.push(`  ${type}: ${parts.join(', ')}`);
      }
    }

    // 当前 agent 名（用于 agent 维度 stats / queue 查询）
    const currentAgentName = checkOwningAgent?.name ?? '<unknown>';
    // ECWeb 全局视图使用全局统计（不按 agent 过滤）
    const statsAgentName = channel === '__ecweb__' ? undefined : currentAgentName;

    // 队列状态（按当前 agent 维度）
    lines.push('', '📬 队列状态：');
    lines.push(`  待处理消息: ${this.messageQueue.getQueueLengthByAgent(currentAgentName)}`);
    lines.push(`  处理中队列: ${this.messageQueue.getProcessingCountByAgent(currentAgentName)}`);

    // 运行概况（全局，进程级）
    lines.push('', '🖥️ 运行概况：');
    const uptimeMs = this.statsCollector
      ? this.statsCollector.getSnapshot().uptimeMs
      : process.uptime() * 1000;
    lines.push(`  运行时间: ${this.formatUptime(uptimeMs)}`);

    // 近 1 小时统计（ECWeb 使用全局统计，agent-owned channel 使用 agent 统计）
    if (this.statsCollector) {
      const snap = this.statsCollector.getSnapshot(statsAgentName);
      const h = snap.lastHour;
      lines.push('', '📊 近 1 小时统计：');
      lines.push(`  收到消息: ${h.received}`);
      lines.push(`  完成处理: ${h.completed}`);
      if (h.errors > 0) {
        const breakdown = Object.entries(h.errorsByType).map(([t, c]) => `${t}: ${c}`).join(', ');
        lines.push(`  处理出错: ${h.errors} (${breakdown})`);
      } else {
        lines.push(`  处理出错: 0`);
      }
      if (h.toolErrors > 0) {
        const toolBreakdown = Object.entries(h.toolErrorsByName).map(([t, c]) => `${t}: ${c}`).join(', ');
        lines.push(`  工具失败: ${h.toolErrors} (${toolBreakdown})`);
      }
      lines.push(`  被中断: ${h.interrupts}`);
      if (h.completed > 0) {
        lines.push(`  平均响应耗时: ${(h.avgResponseMs / 1000).toFixed(1)}s`);
      }
    }

    const checkSnap = this.statsCollector?.getSnapshot(statsAgentName);

    // AUN 渠道的 per-AID 连接富状态（reconnect / flap / lastError / kick）
    const aidStateByName = new Map<string, any>();
    for (const [cname, cobj] of this.channelObjects) {
      if (typeof cobj?.getAidState === 'function') {
        try { aidStateByName.set(cname, cobj.getAidState()); } catch { /* ignore */ }
      }
    }
    // 单个渠道实例的健康快照：基础连接态 + AUN 富状态
    const channelHealth = (cname: string) => {
      const type = this.resolveChannelType(cname);
      const cobj = this.channelObjects.get(cname);
      const seg = cname.split('#');
      const instName = seg.length >= 3 ? seg.slice(2).join('#') : cname;
      const aidState = aidStateByName.get(cname);
      // cobj 缺失 = 渠道未注册（如 disabled agent），视为未连接；
      // cobj 存在但无 getStatus = 已注册的活实例，视为已连接。
      let connected = cobj ? (cobj.getStatus ? !!cobj.getStatus().connected : true) : false;
      const h: any = { name: cname, instName, type, connected };
      if (aidState) {
        connected = aidState.status === 'connected';
        h.connected = connected;
        h.aidStatus = aidState.status;
        h.reconnectCount = aidState.reconnectCount ?? 0;
        h.flapCount = aidState.flapCount ?? 0;
        if (aidState.lastConnectedAt) h.lastConnectedAt = aidState.lastConnectedAt;
        if (aidState.lastError) h.lastError = String(aidState.lastError).slice(0, 80);
        if (aidState.kickDetail?.reason) h.kickReason = String(aidState.kickDetail.reason).slice(0, 80);
      }
      return h;
    };

    // 以 EvolAgent 为中心聚合：后端 + 渠道健康 + 负载，并记录已归属渠道
    const ownedNames = new Set<string>();
    const evolagents = (this.agentRegistry?.list() ?? []).map((ag: any) => {
      const chans = (ag.channels ?? []).map((n: string) => { ownedNames.add(n); return channelHealth(n); });
      // 队列按 agentName 聚合，入队时 agentName === EvolAgent.aid（见 message-bridge enqueue）。
      // 这里必须用 ag.aid，不能用 ag.name —— toInfo 的 name 可能是 agent.md 的 displayName 短名，
      // 与队列里的 AID 不匹配会导致 processing/pending 恒为 0。
      const processing = this.messageQueue.getProcessingCountByAgent(ag.aid);
      const pending = this.messageQueue.getQueueLengthByAgent(ag.aid);
      return {
        name: ag.name, aid: ag.aid ?? '', status: ag.status,
        baseagent: ag.baseagent ?? null,
        model: ag.model ?? null,
        effort: ag.effort ?? null,
        projectPath: ag.projectPath ?? null,
        processing, pending,
        activeTasks: processing + pending,
        lastActivity: ag.lastActivity ?? 0,
        error: ag.error,
        channels: chans,
      };
    });
    // 未归属到任何 EvolAgent 的渠道（系统级 / DefaultAgent）
    const unownedChannels: any[] = [];
    for (const [cname] of this.adapters) {
      if (!allowedChannels.has(cname) || ownedNames.has(cname)) continue;
      unownedChannels.push(channelHealth(cname));
    }

    const structured = {
      channels: [...groups.entries()].map(([type, instances]) => ({ type, instances })),
      queue: {
        pending: this.messageQueue.getQueueLengthByAgent(currentAgentName),
        processing: this.messageQueue.getProcessingCountByAgent(currentAgentName),
      },
      baseagent: checkBaseagent,
      defaultBaseagent: checkDefaultBaseagent,
      uptimeMs,
      lastHour: checkSnap?.lastHour ?? null,
      evolagents,
      unownedChannels,
    };
    return { kind: 'command.result' as const, text: lines.join('\n'), structured } as any;
  }

  // /restart 命令：重启服务（进程级，仅 daemon owner）
  if (normalizedContent === '/restart') {
    // 进程级操作：必须是 daemon owner（evolclaw.json.owners），与 menu 协议 /system restart 一致。
    // agent-channel 的 owner 角色不足以重启整个 daemon。
    if (!isDaemonOwner) {
      return { kind: 'command.error' as const, text: '❌ 无权限：服务重启仅限 daemon owner 使用' };
    }
    const selfAid = this.agentRegistry?.resolveByChannel(channel)?.aid;
    // 排除当前会话（如果存在）。如果 activeSession 不存在，说明还没建立会话，
    // 此时检查所有任务；如果有其他会话在处理，仍然阻塞重启。
    const excludeKey = activeSession?.id;
    const busyInfo = getAgentBusyInfo(this, selfAid, excludeKey);
    if (busyInfo && busyInfo.count > 0) {
      // busyInfo.count > 0 说明【除当前会话外】还有其他会话的任务在执行
      const processingLines = busyInfo.processing.map(p => {
        const keyParts = p.queueKey.split('::');
        const sessionId = keyParts[0] || '?';
        return `  · session ${sessionId.slice(0, 32)}... (agent: ${p.agentName})`;
      }).join('\n');
      return {
        kind: 'command.error' as const,
        text: `❌ ${excludeKey ? '其他会话' : '该 Agent'} 有 ${busyInfo.count} 个任务执行中，无法重启。\n\n处理中的会话：\n${processingLines}\n\n建议：等待这些任务完成后重试。可通过 ec ctl status 查看队列状态；典型等待时间 30-60 秒，群聊大型任务可能更长。`,
      };
    }
    const allSessions = await this.sessionManager.listSessions(channel, channelId);
    const sessionsWithMessages = allSessions
      .filter((s: Session) => this.messageCache.hasMessages(s.id))
      .map((s: Session) => {
        const count = this.messageCache.getCount(s.id);
        return `${s.projectPath} 有 ${count} 条新消息`;
      });

    // 执行重启逻辑（共用于卡片回调和文本确认）
    const executeRestart = async () => {
      let replyContext: ReplyContext | undefined;
      if (threadId) {
        const threadSession = await this.sessionManager.getThreadSession(channel, channelId, threadId);
        if (threadSession) replyContext = this.getReplyContext(threadSession);
      }
      const restartInfo: Record<string, any> = {
        channel,
        channelId,
        timestamp: Date.now(),
        ...(replyContext?.replyToMessageId ? { rootId: replyContext.replyToMessageId } : {}),
      };
      fs.writeFileSync(path.join(resolvePaths().dataDir, 'restart-pending.json'), JSON.stringify(restartInfo));

      const { spawn } = await import('child_process');
      spawn('node', [path.join(getPackageRoot(), 'dist', 'cli', 'index.js'), 'restart-monitor'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root }
      }).unref();

      this.eventBus.publish({ type: 'system:restart', channel, channelId });

      // 先发送重启反馈消息，等待发送完成后再 kill 进程
      // 避免消息还没发出去进程就退出了
      const adapter = this.adapters.get(channel);
      if (adapter) {
        try {
          const envelope = buildEnvelope({
            taskId: `restart-${Date.now()}`,
            channel,
            channelId,
            agentName: 'system',
            chatmode: 'interactive',
            replyContext,
          });
          await adapter.send(envelope, { kind: 'command.result' as const, text: '🔄 服务正在重启，请稍候...（约 5 秒后恢复）' });
          // 等待消息发送完成后再延迟 kill
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          logger.error('[System] Failed to send restart notification:', err);
        }
      }

      // 发 SIGTERM 而非直接 process.exit(0)，让 index.ts 的 shutdown() 先
      // 正常关闭所有 channel（包括 Feishu WebSocket close frame），
      // 避免 Feishu 服务端因连接异常断开而重推未 ack 的消息给新进程。
      setTimeout(() => {
        logger.info('[System] Restarting by user command...');
        process.kill(process.pid, 'SIGTERM');
      }, 1000);
      return true;
    };

    // 文本确认流程
    if (sessionsWithMessages.length > 0) {
      const restartKey = `${channel}-${channelId}`;
      const restartConfirmFile = path.join(resolvePaths().dataDir, `restart-confirm-${restartKey}.json`);

      if (fs.existsSync(restartConfirmFile)) {
        const confirmInfo = JSON.parse(fs.readFileSync(restartConfirmFile, 'utf-8'));
        const now = Date.now();

        if (now - confirmInfo.timestamp < 10000) {
          fs.unlinkSync(restartConfirmFile);
        } else {
          fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: now }));
          return { kind: 'command.result' as const, text: sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。' };
        }
      } else {
        fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: Date.now() }));
        return { kind: 'command.result' as const, text: sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。' };
      }
    }

    await executeRestart();
    // executeRestart 内部已经发送了反馈消息，这里返回 null 避免重复发送
    return null;
  }

  // /upgrade 命令：检查版本更新，提示用户手动重启
  if (normalizedContent === '/upgrade') {
    if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：升级检查仅限管理员使用' };

    if (isLinkedInstall()) {
      return { kind: 'command.result' as const, text: '⏭ 开发模式，跳过升级检查' };
    }

    const localVer = getLocalVersion();
    const remoteVer = await checkLatestVersion();

    if (!remoteVer) {
      return { kind: 'command.result' as const, text: `⚠️ 无法连接 npm registry（当前版本 ${localVer}）` };
    }

    if (compareVersions(localVer, remoteVer) >= 0) {
      return { kind: 'command.result' as const, text: `✓ 已是最新版本 (${localVer})` };
    }

    return { kind: 'command.result' as const, text: `📦 发现新版本 ${localVer} → ${remoteVer}\n执行 /restart 升级` };
  }

  // /pwd 命令：显示当前项目路径
  if (normalizedContent === '/pwd') {
    if (!session) {
      const defaultProjectPath = this.agentRegistry?.resolveByChannel(channel)?.projectPath || this.getEffectiveDefaultPath(channel);
      const defaultConfigName = this.getConfiguredProjectName(defaultProjectPath);
      if (defaultConfigName) {
        return { kind: 'command.result' as const, text: `当前项目: ${defaultConfigName}\n路径: ${defaultProjectPath}` };
      }
      return { kind: 'command.result' as const, text: `当前项目: ${defaultProjectPath}` };
    }
    const configName = this.getConfiguredProjectName(session.projectPath);
    if (configName) {
      return { kind: 'command.result' as const, text: `当前项目: ${configName}\n路径: ${session.projectPath}` };
    }
    return { kind: 'command.result' as const, text: `当前项目: ${session.projectPath}` };
  }

  // /file 命令：发送项目内文件，支持 /file path 和 /file channel path
  if (normalizedContent.startsWith('/file')) {
    if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限管理员使用' };
    // 飞书会将 .md 等后缀自动转为 Markdown 链接: foo.md → [foo.md](http://foo.md/)
    // 还原: 将 [text](url) 替换为 text
    const rawArg = normalizedContent.slice(5).trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    if (!rawArg) {
      const usage = isOwner
        ? '用法: /file <相对路径> 或 /file <渠道> <相对路径>\n示例: /file src/index.ts\n示例: /file feishu report.md'
        : '用法: /file <相对路径>\n示例: /file src/index.ts';
      return { kind: 'command.result' as const, text: usage };
    }

    // 解析目标通道：第一个 token 按实例名匹配，再按 channelType 匹配
    const tokens = rawArg.split(/\s+/);
    let targetChannel = channel;
    let targetLabel = channel;
    let filePath = rawArg;
    if (tokens.length >= 2) {
      const spec = tokens[0];
      if (this.adapters.has(spec)) {
        // 精确实例名
        targetChannel = spec;
        targetLabel = spec;
        filePath = tokens.slice(1).join(' ');
      } else {
        // 按 channelType 查找第一个匹配的实例
        for (const [name] of this.adapters) {
          if ((this.channelTypeMap.get(name) || name) === spec) {
            targetChannel = name;
            targetLabel = spec;
            filePath = tokens.slice(1).join(' ');
            break;
          }
        }
      }
    }
    const isCrossChannel = targetChannel !== channel;

    // 跨通道不属于当前关系级操作，仍仅限 owner。
    if (isCrossChannel && identity.role !== 'owner') {
      return { kind: 'command.error' as const, text: '❌ 跨通道发送仅限 owner' };
    }

    // 找目标 adapter
    const targetAdapter = this.adapters.get(targetChannel);
    if (!targetAdapter) {
      return { kind: 'command.error' as const, text: `❌ 通道 ${targetLabel} 未启用或不存在` };
    }
    if (!targetAdapter.capabilities?.file) {
      return { kind: 'command.error' as const, text: `❌ 通道 ${targetLabel} 不支持文件发送` };
    }

    const sendSession = await getExistingSessionForCommand();
    const projectPath = sendSession?.projectPath || this.agentRegistry?.resolveByChannel(channel)?.projectPath || this.getEffectiveDefaultPath(channel);

    // 路径安全校验
    if (path.isAbsolute(filePath)) {
      return { kind: 'command.error' as const, text: '❌ 不支持绝对路径\n请使用项目内的相对路径' };
    }
    if (filePath.split(path.sep).includes('..') || filePath.split('/').includes('..')) {
      return { kind: 'command.error' as const, text: '❌ 不支持 .. 路径穿越' };
    }

    const resolvedPath = path.resolve(projectPath, filePath);

    // 存在性检查
    if (!fs.existsSync(resolvedPath)) {
      return { kind: 'command.error' as const, text: `❌ 文件不存在: ${filePath}` };
    }

    // 符号链接安全：realpath 后验证仍在项目目录内
    const realPath = fs.realpathSync(resolvedPath);
    const realProjectPath = fs.realpathSync(projectPath);
    if (!realPath.startsWith(realProjectPath + path.sep) && realPath !== realProjectPath) {
      return { kind: 'command.error' as const, text: '❌ 路径不允许: 文件不在项目目录内' };
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      return { kind: 'command.error' as const, text: '❌ 暂不支持发送目录\n目录打包发送将在后续版本支持' };
    }
    const MAX_SIZE = 10 * 1024 * 1024;
    if (stat.size > MAX_SIZE) {
      return { kind: 'command.error' as const, text: `❌ 文件过大: ${(stat.size / 1024 / 1024).toFixed(1)} MB (限制 10 MB)` };
    }

    // 找目标 channelId
    let targetChannelId = channelId;
    if (isCrossChannel) {
      const ownerPeerId = this.agentRegistry?.getOwner?.(targetChannel);
      targetChannelId = ownerPeerId ? (this.sessionManager.getOwnerChatId(targetChannel, ownerPeerId) ?? '') : '';
      if (!targetChannelId) {
        return { kind: 'command.error' as const, text: `❌ 未找到 ${targetLabel} 的私聊会话，请先在该通道发送一条消息` };
      }
    }

    // 发送文件
    try {
      const replyCtx = !isCrossChannel && sendSession ? this.getReplyContext(sendSession) : undefined;
      await targetAdapter.send(buildEnvelope({ channel: targetAdapter.channelName, channelId: targetChannelId, replyContext: replyCtx }), { kind: 'result.file', filePath: realPath });
      const sizeStr = stat.size < 1024 ? `${stat.size} B`
        : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)} KB`
        : `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
      return { kind: 'command.result' as const, text: isCrossChannel
                  ? `📎 文件已通过 ${targetLabel} 发送: ${filePath} (${sizeStr})`
                  : `✅ 已发送: ${filePath} (${sizeStr})` };
    } catch (error: any) {
      logger.error('[CommandHandler] /file failed:', error);
      return { kind: 'command.error' as const, text: `❌ 文件发送失败: ${error.message || error}` };
    }
  }

  // /slist 命令：列出当前项目的会话
  // /slist      — 仅 EvolClaw 会话
  // /slist cli  — 仅 CLI 会话（未导入的）
  if (normalizedContent === '/slist' || normalizedContent === '/slist cli') {
    if (!session) {
      return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话` };
    }

    const showCliOnly = normalizedContent === '/slist cli';

    // /slist cli — 仅显示 CLI 会话
    if (showCliOnly) {
      const canImportCli = policy.canImportCliSession(session.chatType || 'private', identity.role);
      if (!canImportCli) {
        return { kind: 'command.error' as const, text: '❌ 当前无权查看 CLI 会话' };
      }

      const cliSessions = await this.sessionManager.scanCliSessions(session.projectPath, session.baseagent);
      const sessions = await this.sessionManager.listSessions(channel, channelId);
      const currentProjectSessions = sessions.filter((s: Session) => s.projectPath === session.projectPath && s.baseagent === session.baseagent && !s.threadId);
      const dbSessionIds = new Set(currentProjectSessions.map((s: Session) => s.agentSessionId).filter(Boolean));
      const orphanCliSessions = cliSessions.filter((c: any) => !dbSessionIds.has(c.uuid));

      if (orphanCliSessions.length === 0) {
        return { kind: 'command.result' as const, text: `当前项目 ${path.basename(session.projectPath)} 没有未导入的 CLI 会话` };
      }

      // 构建显示数据（复用于卡片和文本）
      const cliDisplayItems = orphanCliSessions.map((c: any) => {
        const time = new Date(c.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const message = this.sessionManager.readSessionFirstMessage(session.projectPath, c.uuid, session.baseagent) || '(无消息)';
        const uuid = c.uuid.substring(0, 8);
        return { uuid, fullUuid: c.uuid, time, message };
      });

      // 尝试发送 CommandCard 卡片
      if (this.interactionRouter && cliDisplayItems.length > 0) {
        const bodyLines = cliDisplayItems.map((item: any) =>
          `• ${item.time}  (${item.uuid})  "${item.message}"`
        );

        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `slist-cli-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: session.id,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: `📋 ${path.basename(session.projectPath)} CLI 会话 (${cliDisplayItems.length})`,
            body: bodyLines.join('\n'),
            buttons: cliDisplayItems.map((item: any) => ({
              label: item.uuid,
              command: `/session ${item.uuid}`,
              style: 'default' as 'primary' | 'default',
            })),
          },
        };

        const replyCtx = this.getReplyContext(session);
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }

      // 降级：文本列表
      const lines = [`当前项目 ${path.basename(session.projectPath)} 的 CLI 会话 (共 ${orphanCliSessions.length} 个):`, ''];
      for (const item of cliDisplayItems) {
        lines.push(`  ${item.time}  (${item.uuid})  "${item.message}"`);
      }
      lines.push('');
      lines.push('使用 /s <8位uuid> 导入并切换到 CLI 会话');
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // /slist — 仅显示 EvolClaw 会话
    const sessions = await this.sessionManager.listSessions(channel, channelId);
    const currentProjectSessions = sessions.filter((s: Session) => s.projectPath === session.projectPath && s.baseagent === session.baseagent && !s.threadId);

    // 从 SDK 同步会话名称（发现 CLI 改名）
    try {
      const sdkSessions = await this.sessionManager.listSdkSessions(session.projectPath, session.baseagent);
      for (const sdkSession of sdkSessions) {
        if (!sdkSession.title) continue;
        const dbSession = currentProjectSessions.find((s: Session) => s.agentSessionId === sdkSession.sessionId);
        if (dbSession && sdkSession.title !== dbSession.name) {
          await this.sessionManager.renameSession(dbSession.id, sdkSession.title);
          dbSession.name = sdkSession.title;
        }
      }
    } catch (error) {
      logger.debug('[CommandHandler] SDK listSessions sync failed (non-critical):', error);
    }

    // 构建可显示会话列表（复用于卡片和文本）
    const maxDisplay = 10;

    const displaySessions: Array<{ session: any; index: number; isActive: boolean; name: string; status: string; idleTime: string; fileMissing: boolean }> = [];
    let displayIndex = 0;
    for (let i = 0; i < currentProjectSessions.length; i++) {
      const s = currentProjectSessions[i];
      if (displayIndex >= maxDisplay) break;

      const isActive = (s.metadata as any)?.isActive === true;
      displayIndex++;
      const name = displaySessionTitle(s.name, '(未命名)');
      const idleTime = formatIdleTime(Date.now() - s.updatedAt);
      const fileMissing = !!(s.agentSessionId && !this.sessionManager.checkSessionFileExists(s.projectPath, s.agentSessionId, s.baseagent));

      let status = '[空闲]';
      if (fileMissing) {
        status = '[会话文件缺失]';
      } else if (!!s.processingState) {
        status = '[处理中]';
      } else if (isActive) {
        status = '[活跃]';
      }

      displaySessions.push({ session: s, index: displayIndex, isActive, name, status, idleTime, fileMissing });
    }

    // 尝试发送 CommandCard 卡片（每个会话一个按钮，一键切换）
    if (this.interactionRouter && displaySessions.length >= 1) {
      const bodyLines = displaySessions.map(ds => {
        const prefix = ds.isActive ? '✓' : '•';
        const uuid = ds.session.agentSessionId ? `(${ds.session.agentSessionId.substring(0, 8)})` : '';
        const fileMark = ds.fileMissing ? '❌ ' : '';
        return `${prefix} ${ds.index}. ${fileMark}**${ds.name}** ${uuid}  ${ds.idleTime} ${ds.status}`;
      });

      const interaction: InteractionRequest = {
        type: 'interaction',
        id: `slist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        channelId,
        sessionId: session.id,
        initiatorId: userId,
        kind: {
          kind: 'command-card',
          title: `📋 ${path.basename(session.projectPath)} 会话列表`,
          body: bodyLines.join('\n'),
          buttons: displaySessions.map(ds => {
            const shortId = ds.session.agentSessionId ? ds.session.agentSessionId.substring(0, 8) : ds.name;
            return {
              label: ds.isActive ? `✓ ${ds.index}. ${shortId}` : `${ds.index}. ${shortId}`,
              command: `/session ${ds.index}`,
              style: (ds.isActive ? 'primary' : 'default') as 'primary' | 'default',
              disabled: ds.isActive,
            };
          }),
        },
      };

      const replyCtx = this.getReplyContext(session);
      const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx });
      if (cardResult === null) return null;
      return { kind: 'command.result' as const, text: cardResult };
    }

    // 降级：文本列表
    const lines = [`当前项目 ${path.basename(session.projectPath)} 的 [${session.baseagent}] 会话列表:`, ''];

    if (currentProjectSessions.length > 0) {
      for (const ds of displaySessions) {
        const prefix = ds.isActive ? '  ✓' : '   ';
        const num = `${ds.index}.`;
        const uuid = ds.session.agentSessionId ? `(${ds.session.agentSessionId.substring(0, 8)})` : '';
        if (ds.fileMissing) {
          lines.push(`${prefix} ${num} ❌ ${ds.name} ${uuid} - ${ds.idleTime} ${ds.status}`);
        } else {
          lines.push(`${prefix} ${num} ${ds.name} ${uuid} - ${ds.idleTime} ${ds.status}`);
        }
      }
      const hiddenCount = currentProjectSessions.length - displayIndex;
      if (hiddenCount > 0) {
        const parts: string[] = [];
        if (hiddenCount > 0) parts.push(`${hiddenCount} 个更早的会话`);
        lines.push(`\n  (已隐藏 ${parts.join('、')})`);
      }
      lines.push('');
    }

    lines.push('使用 /s <序号、name或8位uuid> 切换会话');
    lines.push('使用 /s cli 查看 CLI 会话');
    return { kind: 'command.result' as const, text: lines.join('\n') };
  }

  // /session（无参数）：直接复用 /slist 逻辑（含卡片交互）
  if (normalizedContent === '/session') {
    const delegated = await this.handle('/slist', channel, channelId, undefined, userId, threadId);
    return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
  }

  // /session cli（= /s cli）：列出未导入的 CLI 会话
  if (normalizedContent === '/session cli') {
    const delegated = await this.handle('/slist cli', channel, channelId, undefined, userId, threadId);
    return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
  }

  // /session 或 /s 命令：切换会话
  if (normalizedContent.startsWith('/session ')) {
    const sessionName = normalizedContent.slice(9).trim();

    if (!sessionName) return { kind: 'command.result' as const, text: '用法: /s <序号、会话名称或前8位UUID>' };

    let targetSession = await this.sessionManager.getSessionByName(channel, channelId, sessionName);

    // 序号切换：纯数字时按 /slist 显示的序号匹配（超过10个时隐藏非活跃话题会话）
    if (!targetSession && /^\d+$/.test(sessionName) && session) {
      const idx = parseInt(sessionName, 10);
      const allSessions = await this.sessionManager.listSessions(channel, channelId);
      const visibleSessions = allSessions.filter((s: Session) => s.projectPath === session.projectPath && s.baseagent === session.baseagent && !s.threadId);
      if (idx >= 1 && idx <= visibleSessions.length) {
        targetSession = visibleSessions[idx - 1];
      } else {
        return { kind: 'command.error' as const, text: `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /s 查看可用会话` };
      }
    }

    if (!targetSession && sessionName.length >= 8) {
      targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
    }

    if (targetSession?.threadId) {
      return { kind: 'command.error' as const, text: `❌ 话题会话不支持通过 /s 切换\n请在对应话题内继续对话` };
    }

    const canImport = policy.canImportCliSession(session?.chatType || 'private', identity.role);
    if (!targetSession && sessionName.length >= 8 && canImport) {
      const projectPaths = Object.values(this.projects);

      if (session) {
        projectPaths.unshift(session.projectPath);
      }

      for (const projectPath of projectPaths) {
        const currentBaseagent = session?.baseagent || this.primaryRunnerKey;
        const cliSessions = await this.sessionManager.scanCliSessions(projectPath, currentBaseagent);
        const cliSession = cliSessions.find((c: any) => c.uuid.startsWith(sessionName));

        if (cliSession) {
          const imported = await this.sessionManager.importCliSession(channel, channelId, projectPath, cliSession.uuid, currentBaseagent);
          this.eventBus.publish({ type: 'session:imported', sessionId: imported.id, agentSessionId: cliSession.uuid, projectPath });
          const projectName = this.getProjectName(projectPath);
          return { kind: 'command.result' as const, text: `✓ 已导入 CLI 会话: ${displaySessionTitle(imported.name, '(未命名)')}\n  项目: ${projectName}\n  将继续之前的对话历史` };
        }
      }
    }

    if (!targetSession) {
      return { kind: 'command.error' as const, text: `❌ 会话不存在: ${sessionName}\n使用 /s 查看可用会话` };
    }

    const lastInput = targetSession.agentSessionId
      ? this.sessionManager.readSessionLastUserMessage(targetSession.projectPath, targetSession.agentSessionId, targetSession.baseagent)
      : null;
    const lastInputLine = lastInput ? `\n  最后输入: "${lastInput}"` : '';

    if (!session) {
      const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);
      if (!switched) {
        return { kind: 'command.error' as const, text: `❌ 切换会话失败` };
      }
      if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
      return { kind: 'command.result' as const, text: `✓ 已切换到会话: ${displaySessionTitle(targetSession.name, sessionName)}\n  项目: ${path.basename(targetSession.projectPath)}${lastInputLine}` };
    }

    if (targetSession.id === session.id) {
      return { kind: 'command.result' as const, text: `当前已在会话: ${displaySessionTitle(targetSession.name, sessionName)}` };
    }

    // 阻止从主会话切换到话题会话
    if (!session.threadId && targetSession.threadId) {
      return { kind: 'command.error' as const, text: `❌ 无法从主会话切换到话题会话\n话题会话仅在对应话题内可用` };
    }

    const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);

    if (!switched) {
      return { kind: 'command.error' as const, text: `❌ 切换会话失败` };
    }

    this.eventBus.publish({ type: 'session:switched', sessionId: targetSession.id, fromSessionId: session.id, toSessionId: targetSession.id });

    const continueHint = lastInput ? '\n  将继续之前的对话历史' : '\n  当前会话未有发言';
    if (this.shouldSuppressCardTriggerResult(source, channel)) return null;
    return { kind: 'command.result' as const, text: `✓ 已切换到会话: ${displaySessionTitle(targetSession.name, sessionName)}${continueHint}${lastInputLine}` };
  }

  // /rename 或 /name 命令：重命名当前会话
  if (normalizedContent === '/rename' || normalizedContent === '/name') {
    return { kind: 'command.result' as const, text: '用法: /name <新名称> 或 /rename <新名称>' };
  }
  if (normalizedContent.startsWith('/rename ')) {
    const newName = normalizedContent.slice(8).trim();

    if (!newName) return { kind: 'command.result' as const, text: '用法: /name <新名称> 或 /rename <新名称>' };

    if (!session) {
      return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话
3. /session <名称> - 切换到已有会话` };
    }

    const existing = await this.sessionManager.getSessionByName(channel, channelId, newName);
    if (existing && existing.id !== session.id) {
      return { kind: 'command.error' as const, text: `❌ 会话名称 "${newName}" 已存在，请使用其他名称` };
    }

    const oldName = displaySessionTitle(session.name, '(未命名)');
    const success = await this.sessionManager.renameSession(session.id, newName);

    if (success && session.agentSessionId) {
      const renameAgent = this.getAgent(channel, session.baseagent);
      await renameAgent.setSessionName?.(session.agentSessionId, newName).catch((error: any) => {
        logger.debug('[CommandHandler] Backend session rename sync failed:', error);
      });
    }

    if (!success) {
      return { kind: 'command.error' as const, text: `❌ 重命名失败` };
    }

    this.eventBus.publish({ type: 'session:renamed', sessionId: session.id, oldName, newName });

    return { kind: 'command.result' as const, text: `✓ 已将当前会话重命名为: ${newName}` };
  }

  // /del 命令：删除指定会话（仅解绑，不删除文件）
  if (normalizedContent.startsWith('/del ')) {
    const sessionName = normalizedContent.slice(5).trim();

    if (!sessionName) return { kind: 'command.result' as const, text: '用法: /del <序号、会话名称或前8位UUID>' };

    if (!session) {
      return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话` };
    }

    // 权限检查：policy 控制谁可以删除会话
    if (!policy.canDeleteSession(session.chatType || 'private', identity.role)) {
      return { kind: 'command.error' as const, text: `❌ 无权限：群聊中仅管理员可删除会话` };
    }

    let targetSession = await this.sessionManager.getSessionByName(channel, channelId, sessionName);

    // 序号删除（与 /slist 显示序号一致）
    if (!targetSession && /^\d+$/.test(sessionName)) {
      const idx = parseInt(sessionName, 10);
      const allSessions = await this.sessionManager.listSessions(channel, channelId);
      const visibleSessions = allSessions.filter((s: Session) => s.projectPath === session.projectPath && s.baseagent === session.baseagent && !s.threadId);
      if (idx >= 1 && idx <= visibleSessions.length) {
        targetSession = visibleSessions[idx - 1];
      } else {
        return { kind: 'command.error' as const, text: `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /s 查看可用会话` };
      }
    }

    if (!targetSession && sessionName.length >= 8) {
      targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
    }

    if (targetSession?.threadId) {
      return { kind: 'command.error' as const, text: `❌ 请使用话题管理删除话题会话` };
    }

    if (!targetSession) {
      return { kind: 'command.error' as const, text: `❌ 会话不存在: ${sessionName}\n使用 /s 查看可用会话` };
    }

    if (targetSession.id === session.id) {
      return { kind: 'command.error' as const, text: `❌ 无法删除当前活跃会话\n请先切换到其他会话` };
    }

    const success = await this.sessionManager.unbindSession(targetSession.id);

    if (!success) {
      return { kind: 'command.error' as const, text: `❌ 删除失败` };
    }

    this.eventBus.publish({ type: 'session:deleted', sessionId: targetSession.id });

    const targetAgent = this.getAgent(channel, targetSession.baseagent);
    await targetAgent.closeSession(targetSession.id);

    return { kind: 'command.result' as const, text: `✓ 已删除会话: ${displaySessionTitle(targetSession.name, sessionName)}\n会话文件已保留，可通过 CLI 访问` };
  }

  // /fork 命令：分支当前会话
  if (normalizedContent === '/fork' || normalizedContent.startsWith('/fork ')) {
    const forkName = normalizedContent.slice(5).trim() || undefined;

    if (!session) {
      return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话，无法分支` };
    }

    if (!session.agentSessionId) {
      return { kind: 'command.error' as const, text: `❌ 当前会话尚未初始化对话，无法分支\n\n请先发送一条消息，然后再使用 /fork` };
    }

    const forkAgent = this.getAgent(channel, session.baseagent);
    if (!forkAgent.capabilities?.fork) {
      return { kind: 'command.error' as const, text: `❌ 当前 Agent (${forkAgent.name}) 不支持 /fork\n\n可使用 /new 创建新会话替代` };
    }

    try {
      const forkedSessionId = await forkAgent.forkSession!(session.agentSessionId, session.projectPath, forkName);
      const newSession = await this.sessionManager.createForkedSession(session, forkedSessionId, forkName);
      await forkAgent.updateSessionMetadata?.(forkedSessionId, {
        gitInfo: {
          branch: null,
          commitHash: null,
          repositoryUrl: null,
        },
        evolclawSessionId: newSession.id,
        sourceSessionId: session.id,
      }).catch((error: any) => {
        logger.debug('[CommandHandler] Backend fork metadata sync failed:', error);
      });

      this.eventBus.publish({ type: 'session:forked', sessionId: newSession.id, sourceSessionId: session.id, name: forkName });

      return { kind: 'command.result' as const, text: `✅ 会话已分支: ${displaySessionTitle(newSession.name, '(未命名)')}\n新会话已激活，可以继续对话\n\n使用 /s 查看所有会话，/s <名称> 切换回原会话` };
    } catch (error) {
      logger.error('[CommandHandler] Fork session failed:', error);
      return { kind: 'command.error' as const, text: `❌ 会话分支失败: ${error instanceof Error ? error.message : '未知错误'}` };
    }
  }

  // /rewind 命令：查看历史 / 回退会话
  if (normalizedContent === '/rewind' || normalizedContent.startsWith('/rewind ')) {
    const session = await getExistingSessionForCommand();
    if (!session) return { kind: 'command.error' as const, text: '❌ 当前没有活跃会话' };

    const rewindAgent = this.getAgent(channel, session.baseagent);

    if (!session.agentSessionId) {
      return { kind: 'command.error' as const, text: '❌ 当前会话无历史记录\n\n请先发送一条消息，然后再使用 /rewind' };
    }
    if (!rewindAgent.getSessionMessages) {
      return { kind: 'command.error' as const, text: `❌ 当前 Agent (${rewindAgent.name}) 不支持 /rewind` };
    }

    const args = normalizedContent.slice('/rewind'.length).trim();

    if (!args) {
      return { kind: 'command.result' as const, text: await this.handleRewindList(session, rewindAgent) };
    }

    // 带参（执行回退，会删除文件/改对话）需 admin+
    if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：回退操作仅限管理员使用' };

    const parts = args.split(/\s+/);
    const turnNum = parseInt(parts[0], 10);
    if (isNaN(turnNum) || turnNum < 1) {
      return { kind: 'command.error' as const, text: '❌ 无效轮次，用法：/rewind <N> chat|file|all（撤销第N轮）' };
    }

    const mode = parts[1]?.toLowerCase();
    if (!mode) {
      return { kind: 'command.error' as const, text: `❌ 请指定回退模式：/rewind ${turnNum} chat | file | all（撤销第${turnNum}轮）` };
    }
    if (!['chat', 'file', 'all'].includes(mode)) {
      return { kind: 'command.error' as const, text: `❌ 无效模式 "${mode}"，可选：chat | file | all` };
    }

    return { kind: 'command.result' as const, text: await this.handleRewind(session, rewindAgent, turnNum, mode as 'chat' | 'file' | 'all') };
  }

  // /repair 命令：检查并修复会话文件
  if (normalizedContent === '/repair') {
    const repairSession = await getExistingSessionForCommand();
    if (!repairSession) return { kind: 'command.result' as const, text: '当前没有活跃会话' };
    const repairAgent = this.getAgent(channel, repairSession.baseagent);
    const { checkSessionFile, backupSessionFile } = await import('../session/session-file-health.js');

    try {
      if (!repairSession.agentSessionId) {
        await this.sessionManager.resetHealthStatus(repairSession.id);
        return { kind: 'command.result' as const, text: `✓ 修复完成\n\n修复内容：\n- 未发现问题（新会话）\n- 已重置异常计数器` };
      }

      // 通过 agent 定位 session 文件
      const sessionFile = repairAgent.resolveSessionFile?.(repairSession.agentSessionId, repairSession.projectPath) ?? null;

      if (!sessionFile) {
        // 文件不存在（已被删除或从未创建），直接重置
        await this.sessionManager.resetHealthStatus(repairSession.id);
        return { kind: 'command.result' as const, text: `✓ 修复完成\n\n修复内容：\n- 会话文件不存在（可能已被清理）\n- 已重置异常计数器` };
      }

      const healthCheck = await checkSessionFile(sessionFile);

      if (healthCheck.corrupt) {
        const backupPath = await backupSessionFile(sessionFile);
        const fsPromises = await import('fs/promises');
        await fsPromises.unlink(sessionFile);
        await this.sessionManager.updateAgentSessionIdBySessionId(repairSession.id, '');
        repairAgent.updateSessionId(repairSession.id, '');
        await this.sessionManager.resetHealthStatus(repairSession.id);

        return { kind: 'command.result' as const, text: `✓ 修复完成\n\n检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n修复操作：\n- 已备份损坏文件\n- 已删除损坏文件\n- 已重置异常计数器\n\n备份位置：${backupPath}` };
      }

      if (healthCheck.issues.length > 0) {
        await this.sessionManager.resetHealthStatus(repairSession.id);
        return { kind: 'command.error' as const, text: `⚠️ 检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n建议使用 /new 创建新会话\n\n已重置异常计数器，可继续使用当前会话。` };
      }

      await this.sessionManager.resetHealthStatus(repairSession.id);
      return { kind: 'command.result' as const, text: `✓ 修复完成\n\n修复内容：\n- 未发现问题\n- 已重置异常计数器` };
    } catch (error: any) {
      logger.error('[Repair] Failed:', error);
      return { kind: 'command.error' as const, text: `❌ 修复失败: ${error.message}` };
    }
  }

  // /trigger 命令
  if (normalizedContent === '/trigger' || normalizedContent.startsWith('/trigger ')) {
    const text = await this.handleTrigger(normalizedContent, channel, channelId, userId ?? '', isAdmin, messageId, chatType, threadId);
    return { kind: 'command.result' as const, text };
  }

  return null;
}

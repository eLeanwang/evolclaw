import path from 'path';
import fs from 'fs';
import type { EventBus } from './event-bus.js';
import type { ChannelAdapter, ReplyContext, InteractionRequest, CrossSessionApprovalContext } from '../types.js';
import type { InteractionRouter } from './interaction-router.js';
import { renderActionAsText } from './interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from './message/message-utils.js';
import { appendMessageLog, buildOutboundEntry } from './message/message-log.js';
import { chatDirPath } from './session/session-fs-store.js';
import { resolvePaths } from '../paths.js';
import { logger } from '../utils/logger.js';
import { summarizeToolInput } from '../utils/tool-summary.js';

// 工具摘要/Edit diff 预览已迁至 utils/tool-summary.ts；此处再导出以保持既有引用路径兼容。
export { summarizeToolInput };

// 绝对禁止命令（所有角色、所有权限模式下都禁止，不可授权）
// 这些是系统级破坏操作，任何情况下都不应该允许
const ABSOLUTE_FORBIDDEN = [
  /\bshutdown\b/,             // 关机
  /\breboot\b/,               // 重启
  /\bmkfs\b/,                 // mkfs (格式化文件系统)
  /\bformat\s+[a-zA-Z]:/i,   // format C: (格式化磁盘)
  /\bdd\s+if=.*of=\/dev/,     // dd 写入磁盘设备（读取操作允许）
];

export type DangerousCommandKind =
  | 'rm-rf'
  | 'sudo'
  | 'chmod-777'
  | 'device-redirect'
  | 'windows-rd'
  | 'windows-del'
  | 'reg-delete'
  | 'net-stop'
  | 'process-kill'
  | 'git-destructive';

// 危险操作（需要用户审批才能执行）
// 这些操作有合理使用场景，但需要用户明确授权
const DANGEROUS_PATTERNS: Array<{
  kind: DangerousCommandKind;
  pattern: RegExp;
  reason: string;
}> = [
  { kind: 'rm-rf', pattern: /\brm\s+-\w*r\w*f/, reason: '递归删除文件/目录，操作不可逆' },
  { kind: 'sudo', pattern: /\bsudo\b/, reason: '以超级用户权限执行命令' },
  { kind: 'chmod-777', pattern: /\bchmod\s+777/, reason: '设置文件为完全开放权限（安全风险）' },
  { kind: 'device-redirect', pattern: />\s*\/dev\/(?!null\b)/, reason: '写入设备文件（可能影响系统）' },
  { kind: 'windows-rd', pattern: /\brd\s+\/s/i, reason: '递归删除目录，操作不可逆' },
  { kind: 'windows-del', pattern: /\bdel\s+\/[sfq]/i, reason: '强制/递归删除文件，操作不可逆' },
  { kind: 'reg-delete', pattern: /\breg\s+delete/i, reason: '删除注册表项（Windows 系统配置）' },
  { kind: 'net-stop', pattern: /\bnet\s+stop/i, reason: '停止系统服务（可能影响系统稳定性）' },
  { kind: 'process-kill', pattern: /\bpkill\b/, reason: '批量终止进程（可能影响系统稳定性）' },
  { kind: 'process-kill', pattern: /\bkillall\b/, reason: '批量终止进程（可能影响系统稳定性）' },
  { kind: 'git-destructive', pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 破坏性操作：重置工作区和暂存区，可能丢失未提交修改' },
  { kind: 'git-destructive', pattern: /\bgit\s+push\b[\s\S]*(?:--force|-f)\b/, reason: 'Git 破坏性操作：强制推送可能覆盖远端历史' },
  { kind: 'git-destructive', pattern: /\bgit\s+clean\b[\s\S]*-[^\s]*f[^\s]*/, reason: 'Git 破坏性操作：清理未跟踪文件，操作不可逆' },
  { kind: 'git-destructive', pattern: /\bgit\s+checkout\s+--\s+\./, reason: 'Git 破坏性操作：覆盖工作区文件，可能丢失未提交修改' },
  { kind: 'git-destructive', pattern: /\bgit\s+branch\s+-D\b/, reason: 'Git 破坏性操作：强制删除分支' },
];

// 只读模式写入命令黑名单
const READONLY_WRITE_PATTERNS = [
  /\bmkdir\b/, /\btouch\b/, /\btee\b/, /\bcp\b/, /\bmv\b/,
  /\brm\b/, /\brmdir\b/, /\bchmod\b/, /\bchown\b/, /\bln\b/,
  />>?\s/,
  /\bgit\s+(commit|push|merge|rebase|reset|stash|checkout|cherry-pick|revert|tag|branch\s+-[dDmM])/,
  /\bgit\s+am\b/,
  /\bnpm\s+(install|ci|uninstall|update|link|publish|run|exec|init)\b/,
  /\bnpx\b/, /\byarn\b/, /\bpnpm\b/, /\bpip\s+install\b/,
  /\bsed\s+-i\b/, /\bawk\s+-i\b/, /\bpatch\b/,
];

/**
 * 只读模式检查（用于 PreToolUse hook 和 canUseTool callback）
 * Write/Edit/NotebookEdit 仅允许写入 {projectPath}/.evolclaw/tmp/
 * Bash 拦截所有写入意图命令
 */
export function checkReadonly(
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
  context?: { sessionId?: string; channel?: string; peerId?: string; role?: string }
): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const filePath = (input.file_path || input.notebook_path) as string | undefined;
    if (!filePath) return { behavior: 'allow' };
    const tmpDir = path.join(projectPath, '.evolclaw', 'tmp') + path.sep;
    const resolved = path.resolve(projectPath, filePath) + (filePath.endsWith(path.sep) ? path.sep : '');
    if (!resolved.startsWith(tmpDir) && resolved !== tmpDir.slice(0, -1)) {
      logger.warn(`[ReadonlyCheck] 🔒 File write blocked: tool=${toolName} path=${filePath} session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`);
      return { behavior: 'deny', message: '🔒 只读模式：禁止修改项目文件。如需生成文件请写入 .evolclaw/tmp/ 目录' };
    }
  }

  if (toolName === 'Bash') {
    const cmd = (input.command as string) || '';
    for (const pattern of READONLY_WRITE_PATTERNS) {
      if (pattern.test(cmd)) {
        const cmdPreview = cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd;
        logger.warn(`[ReadonlyCheck] 🔒 Bash write blocked: cmd="${cmdPreview}" pattern=${pattern} session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`);
        return { behavior: 'deny', message: '🔒 只读模式：禁止执行写入操作' };
      }
    }
  }

  return { behavior: 'allow' };
}

/**
 * H 类文件保护（用于 PreToolUse hook）
 * H 类文件只有人能改，agent 不可直接写入
 */
const H_CLASS_PATTERNS = [
  /[/\\]evolclaw\.json$/,                                    // 进程级配置
  /[/\\]agents[/\\]defaults\.json$/,                         // 全局默认配置
  /[/\\]agents[/\\][^/\\]+[/\\]config\.json$/,               // agent 配置
  /[/\\]agents[/\\][^/\\]+[/\\]relations[/\\][^/\\]+[/\\]config\.json$/,  // relation 配置
  /[/\\]backups[/\\]config[/\\]/,                            // 快照目录
  /[/\\]\.snapshots[/\\]/,                                   // 快照目录（备用）
  /[/\\]CA[/\\]/,                                            // 证书根目录
  /[/\\]aids[/\\][^/\\]+[/\\](cert|keys)[/\\]/,              // 证书和密钥
  /[/\\]\.device_id$/,                                       // 设备标识
  /[/\\]\.env$/,                                             // 环境变量配置
  /[/\\]\.seed\./,                                           // seed 文件
  /[/\\]\.migrated-/,                                        // 迁移标记
  /\.json_$/,                                                // 备份文件（_ 后缀）
  /\.json\.migrated$/,                                       // 迁移归档
  /[/\\]defaults_\d+\.json$/,                                // defaults 历史备份
];

export function checkHClassWrite(
  toolName: string,
  input: Record<string, unknown>,
  context?: { sessionId?: string; channel?: string; peerId?: string; role?: string }
): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
  // 只检查写入类工具
  if (!['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
    return { behavior: 'allow' };
  }

  // 提取文件路径
  const filePath = (input.file_path ?? input.notebook_path ?? input.path ?? '') as string;
  if (!filePath) {
    return { behavior: 'allow' };
  }

  // 规范化路径分隔符（统一使用正斜杠）
  const normalized = filePath.replace(/\\/g, '/');

  // 检查是否匹配 H 类文件模式
  for (const pattern of H_CLASS_PATTERNS) {
    if (pattern.test(normalized)) {
      const fileBasename = path.basename(filePath);
      logger.warn(
        `[H-Class Protection] 🔒 Protected file write blocked: tool=${toolName} path=${filePath} ` +
        `session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`
      );

      // 根据文件类型返回不同的提示信息
      let suggestion = '';
      if (fileBasename === 'config.json' || fileBasename === 'defaults.json' || fileBasename === 'evolclaw.json') {
        suggestion = '\n\n💡 请使用配置命令操作：\n' +
                     '  • 查看配置：evolclaw config show --self <aid>\n' +
                     '  • 读取字段：evolclaw config get <field> --self <aid>\n' +
                     '  • 修改字段：evolclaw config set <field> <value> --self <aid>\n' +
                     '  • 帮助文档：evolclaw config --help';
      } else if (normalized.includes('/backups/config/') || normalized.includes('/.snapshots/')) {
        suggestion = '\n\n💡 快照由系统自动管理，请使用：\n' +
                     '  • 创建快照：evolclaw config snapshot --desc "说明"\n' +
                     '  • 查看历史：evolclaw config history\n' +
                     '  • 恢复快照：evolclaw config restore <version>';
      } else if (normalized.includes('/cert/') || normalized.includes('/keys/') || normalized.includes('/CA/')) {
        suggestion = '\n\n💡 证书和密钥由系统自动管理，请使用：\n' +
                     '  • 查看证书：evolclaw aid cert show <aid>\n' +
                     '  • 更新证书：evolclaw aid cert renew <aid>';
      }

      return {
        behavior: 'deny',
        message: `🔒 此文件受保护，agent 不可直接写入\n\n` +
                 `文件：${filePath}\n` +
                 `类型：配置/快照/证书等系统关键文件${suggestion}`
      };
    }
  }

  return { behavior: 'allow' };
}

/**
 * 绝对禁止检查（用于 PreToolUse hook）
 * 检查系统级破坏操作，这些命令任何情况下都不允许执行
 */
export async function checkBlacklist(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {

  // 只检查 Bash 工具，其余工具全部放行
  if (toolName === 'Bash') {
    const cmd = (input.command as string) || '';

    // 空命令直接放行
    if (!cmd || cmd.trim() === '') {
      return { behavior: 'allow', updatedInput: input };
    }

    // 检查绝对禁止命令（系统级破坏操作）
    for (const pattern of ABSOLUTE_FORBIDDEN) {
      if (pattern.test(cmd)) {
        const cmdPreview = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
        return {
          behavior: 'deny',
          message: `🚫 系统级危险操作已拦截\n命令：${cmdPreview}\n\n此类操作可能导致系统损坏，任何权限模式下都不允许执行。`
        };
      }
    }
  }

  // 默认允许
  return { behavior: 'allow', updatedInput: input };
}

/**
 * 危险命令检测（用于 canUseTool callback）
 * 检测需要用户审批的危险操作，返回是否匹配及风险说明
 */
export function checkDangerousCommand(
  toolName: string,
  input: Record<string, unknown>
): { isDangerous: false } | { isDangerous: true; kind: DangerousCommandKind; cacheKey: string; command: string; reason: string } {
  if (toolName !== 'Bash') {
    return { isDangerous: false };
  }

  const cmd = (input.command as string) || '';
  if (!cmd || cmd.trim() === '') {
    return { isDangerous: false };
  }

  // 检查危险操作模式
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(cmd)) {
      const cmdPreview = cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd;

      return {
        isDangerous: true,
        kind: rule.kind,
        cacheKey: `dangerous:${toolName}:${rule.kind}`,
        command: cmdPreview,
        reason: rule.reason
      };
    }
  }

  return { isDangerous: false };
}

export interface EvolclawSendCommand {
  scope: 'msg' | 'group' | 'ctl';
  action: 'send' | 'file';
  /** msg/group 的会话目标；ctl send/file 通过当前 ctl session 路由，不携带目标。 */
  targetId?: string;
}

const SHELL_CONTROL_RE = /[;&|`]|[$][(]|\r|\n/;

export function parseEvolclawSendCommand(command: string): EvolclawSendCommand | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL_RE.test(trimmed)) return null;

  const ctlMatch = trimmed.match(/^(?:ec|evolclaw)\s+ctl\s+(send|file)(?:\s|$)/);
  if (ctlMatch) {
    return { scope: 'ctl', action: ctlMatch[1] as 'send' | 'file' };
  }

  const sessionMatch = trimmed.match(/^(?:ec|evolclaw)\s+(msg|group)\s+(send|file)\s+\S+\s+(\S+)(?:\s|$)/);
  if (!sessionMatch) return null;
  return {
    scope: sessionMatch[1] as 'msg' | 'group',
    action: sessionMatch[2] as 'send' | 'file',
    targetId: sessionMatch[3],
  };
}

export function isEvolclawHandoffReturnCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL_RE.test(trimmed)) return false;
  return /^(?:ec|evolclaw)\s+handoff\s+return(?:\s|$)/.test(trimmed);
}

export function isEvolclawSendCommandForSession(
  toolName: string,
  input: Record<string, unknown>,
  channelId: string,
): boolean {
  if (toolName !== 'Bash') return false;
  const cmd = typeof input.command === 'string' ? input.command : '';
  const parsed = parseEvolclawSendCommand(cmd);
  if (!parsed) return false;
  if (parsed.scope === 'ctl') return true;
  return parsed.targetId === channelId;
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

export interface PermissionRequestContext {
  adapter?: ChannelAdapter;
  channelId?: string;
  replyContext?: ReplyContext;
  interactionRouter?: InteractionRouter;
  userId?: string;
  channel?: string;
  agentName?: string;
  taskId?: string;
  chatmode?: 'interactive' | 'proactive';
  role?: string;
  chatType?: 'private' | 'group';
  selfAid?: string;
  peerKey?: string;
  crossSessionApproval?: CrossSessionApprovalContext;
  flushPending?: () => Promise<void>;
}

export async function requestDangerousCommandPermission(
  gateway: PermissionGateway | undefined,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  sendPrompt: ((text: string) => Promise<void>) | undefined,
  context?: PermissionRequestContext
): Promise<{ matched: false } | { matched: true; decision: PermissionDecision }> {
  const dangerCheck = checkDangerousCommand(toolName, input);
  if (!dangerCheck.isDangerous) {
    return { matched: false };
  }

  if (gateway?.isAlwaysAllowed(dangerCheck.cacheKey)) {
    return { matched: true, decision: 'always' };
  }

  if (!gateway || !sendPrompt) {
    return { matched: true, decision: 'allow' };
  }

  const decision = await gateway.requestPermission(
    sessionId,
    dangerCheck.cacheKey,
    input,
    sendPrompt,
    context,
    `⚠️ ${dangerCheck.command}`,
    dangerCheck.reason
  );

  return { matched: true, decision };
}

interface PendingPermission {
  sessionId: string;
  toolName: string;
  resolve: (decision: PermissionDecision) => void;
  interactionRouter?: InteractionRouter;
}

interface PendingCrossSessionPermission extends PendingPermission {
  requestId: string;
  displaySummary: string;
  reason?: string;
  selfAid?: string;
  ownerAid: string;
  ownerChatDir?: string;
  originChatDir?: string;
  originChannelId?: string;
  originChatType?: 'private' | 'group';
  cardFallbackMsgId: string;
  expiresAt: number;
  interactionRouter?: InteractionRouter;
  timeout?: NodeJS.Timeout;
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();
  private crossSessionPending = new Map<string, PendingCrossSessionPermission>();
  private eventBus?: EventBus;

  /** 始终允许的工具缓存：toolName → Set<pattern> */
  private alwaysAllow = new Map<string, Set<string>>();

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * 检查工具是否已被标记为"始终允许"
   */
  isAlwaysAllowed(toolName: string): boolean {
    return this.alwaysAllow.has(toolName);
  }

  /**
   * 将工具标记为"始终允许"
   */
  addAlwaysAllow(toolName: string): void {
    if (!this.alwaysAllow.has(toolName)) {
      this.alwaysAllow.set(toolName, new Set());
    }
  }

  /**
   * 清除所有"始终允许"缓存（用于切换权限模式时重置）
   */
  clearAlwaysAllow(): void {
    this.alwaysAllow.clear();
  }

  /**
   * 获取所有"始终允许"的工具列表
   */
  getAlwaysAllowList(): string[] {
    return [...this.alwaysAllow.keys()];
  }

  private shouldUseCrossSessionApproval(context?: PermissionRequestContext): boolean {
    if (!context?.crossSessionApproval) return false;
    const role = context.role || 'none';
    if (role === 'owner' || role === 'admin') return false;
    if (context.userId && context.userId === context.crossSessionApproval.ownerAid) return false;
    return true;
  }

  private appendCrossSessionState(
    pending: PendingCrossSessionPermission,
    event: 'decided' | 'cancelled' | 'expired' | 'failed',
    auth: Record<string, unknown>,
    opts?: { replyTo?: string | null; consumedByMessageId?: string | null },
  ): void {
    if (!pending.ownerChatDir) return;
    try {
      fs.mkdirSync(pending.ownerChatDir, { recursive: true });
      appendMessageLog(pending.ownerChatDir, buildOutboundEntry({
        from: pending.selfAid || 'self',
        to: pending.ownerAid,
        chatType: 'private',
        groupId: null,
        msgId: `auth-${event}:${pending.requestId}`,
        msgType: 'handoff_state',
        content: '',
        replyTo: opts?.replyTo ?? pending.cardFallbackMsgId,
        source: 'handoff',
        handoff: {
          event,
          consumed_by_msg_id: opts?.consumedByMessageId ?? undefined,
          auth,
        },
      }));
    } catch (error) {
      logger.debug(`[PermissionGateway] append cross-session state failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private appendCrossSessionResult(
    pending: PendingCrossSessionPermission,
    decision: 'approved' | 'denied' | 'cancelled' | 'expired' | 'failed',
    auth: Record<string, unknown>,
  ): void {
    if (!pending.originChatDir) return;
    try {
      fs.mkdirSync(pending.originChatDir, { recursive: true });
      const approved = decision === 'approved';
      appendMessageLog(pending.originChatDir, buildOutboundEntry({
        from: pending.selfAid || 'self',
        to: pending.originChannelId || pending.sessionId,
        chatType: pending.originChatType ?? 'private',
        groupId: pending.originChatType === 'group' ? (pending.originChannelId || null) : null,
        msgId: `auth-return:${pending.requestId}:${decision}`,
        msgType: 'handoff_result',
        content: approved ? `owner 已批准临时授权：${pending.displaySummary}` : `owner 授权结果：${decision}`,
        replyTo: null,
        source: 'handoff',
        handoff: {
          kind: 'response_to_origin',
          request_content: pending.displaySummary,
          origin: {
            channel: 'aun',
            peerId: pending.ownerAid,
            peerType: 'human',
            role: 'owner',
          },
          auth,
        },
      }));
    } catch (error) {
      logger.debug(`[PermissionGateway] append cross-session result failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resolveCrossSessionPermission(
    sessionId: string,
    requestId: string,
    action: string,
    values?: Record<string, unknown>,
    operatorId?: string,
  ): boolean {
    const pending = this.crossSessionPending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;

    if (pending.timeout) clearTimeout(pending.timeout);
    this.crossSessionPending.delete(requestId);

    const cardMessageId = typeof values?.card_message_id === 'string'
      ? values.card_message_id
      : pending.cardFallbackMsgId;
    const approved = action === 'approve_once' || action === 'allow';
    const decision: PermissionDecision = approved ? 'allow' : 'deny';
    const auth = {
      kind: 'authorization_decision',
      request_id: requestId,
      challenge_id: requestId,
      decision: approved ? 'approved' : 'denied',
      action,
      operator_aid: operatorId,
      grant_id: approved ? `grant:${requestId}` : undefined,
      ttl_seconds: approved ? 1800 : undefined,
      max_uses: approved ? 1 : undefined,
    };

    this.appendCrossSessionState(pending, 'decided', auth, { replyTo: cardMessageId });
    this.appendCrossSessionResult(pending, approved ? 'approved' : 'denied', {
      kind: 'authorization_result',
      request_id: requestId,
      challenge_id: requestId,
      decision: approved ? 'approved' : 'denied',
      grant_id: approved ? `grant:${requestId}` : undefined,
      ttl_seconds: approved ? 1800 : undefined,
      max_uses: approved ? 1 : undefined,
    });

    pending.resolve(decision);
    this.eventBus?.publish({ type: 'permission:resolved', sessionId, requestId, approved });
    return true;
  }

  private expireCrossSessionPermission(sessionId: string, requestId: string, reason: 'expired' | 'cancelled' | 'failed'): boolean {
    const pending = this.crossSessionPending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;

    if (pending.timeout) clearTimeout(pending.timeout);
    pending.interactionRouter?.cancel(requestId);
    this.crossSessionPending.delete(requestId);

    const auth = {
      kind: 'authorization_result',
      request_id: requestId,
      challenge_id: requestId,
      decision: reason,
    };
    this.appendCrossSessionState(pending, reason, auth);
    this.appendCrossSessionResult(pending, reason, auth);
    pending.resolve('deny');
    if (reason === 'cancelled') {
      this.eventBus?.publish({
        type: 'permission:cancelled',
        sessionId,
        requestId,
        toolName: pending.toolName,
        reason,
      });
    } else {
      this.eventBus?.publish({
        type: 'permission:resolved',
        sessionId,
        requestId,
        toolName: pending.toolName,
        reason,
        approved: false,
      });
    }
    return true;
  }

  private async requestCrossSessionPermission(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sendPrompt: (text: string) => Promise<void>,
    context: PermissionRequestContext,
    displaySummary: string,
    reason?: string,
  ): Promise<PermissionDecision> {
    const approval = context.crossSessionApproval;
    const interactionRouter = context.interactionRouter;
    if (!approval || !interactionRouter) {
      await sendPrompt('当前会话权限不足，且没有可用的 owner 审批通道。');
      return 'deny';
    }

    const ttlMs = approval.approvalTtlMs && approval.approvalTtlMs > 0
      ? approval.approvalTtlMs
      : 20 * 60 * 1000;
    const expiresAt = Date.now() + ttlMs;
    const reasonLine = reason ? `\n原因：${reason}` : '';
    const originRole = approval.originRole || context.role || 'none';
    const body = [
      `来源：${approval.originPeerName || approval.originPeerId || approval.originChannelId || 'unknown'} (${originRole})`,
      `工具：${toolName}`,
      `操作：${displaySummary}${reasonLine}`,
      `有效期：${Math.round(ttlMs / 60000)} 分钟`,
    ].join('\n');

    const interaction: InteractionRequest = {
      type: 'interaction',
      id: requestId,
      kind: {
        kind: 'action',
        title: '临时授权申请',
        body,
        buttons: [
          { key: 'approve_once', label: '批准一次', style: 'primary' },
          { key: 'deny', label: '拒绝', style: 'danger' },
        ],
      },
      channelId: approval.ownerAid,
      sessionId,
      initiatorId: approval.ownerAid,
      expiresAt,
      fallback: { command: 'auth' },
    };

    if (context.flushPending) {
      try {
        await context.flushPending();
      } catch {
        // flush 失败不阻断审批请求
      }
    }

    const handoffAuth = {
      kind: 'authorization_request',
      request_id: requestId,
      challenge_id: requestId,
      approver_policy: 'agent_owner',
      approval_request_expires_at: new Date(expiresAt).toISOString(),
      requested_capabilities: [
        {
          namespace: 'tool',
          action: toolName,
          resource_selector: summarizeToolInput(toolName, toolInput),
        },
      ],
      reason,
      expected_actions: [displaySummary],
      risk: { level: 'medium', factors: ['cross_session_owner_approval'] },
      constraints_options: {
        ttl_seconds: [600, 1800, 3600],
        max_uses: [1],
        bindable: ['session', 'channelKey', 'agentInstance'],
      },
    };

    const ownerReplyContext: ReplyContext = {
      metadata: {
        source: 'handoff',
        chatmode: 'interactive',
        handoff: {
          kind: 'request_to_target',
          origin: {
            session_id: approval.originSessionId,
            message_id: approval.originMessageId,
            channel: approval.originChannel,
            peerId: approval.originPeerId,
            threadId: approval.originThreadId,
            peerName: approval.originPeerName,
            peerType: approval.originPeerType,
            role: originRole,
          },
          auth: handoffAuth,
        },
      },
    };

    const envelope = buildEnvelope({
      taskId: context.taskId,
      sessionId,
      channel: approval.adapter.channelName,
      channelId: approval.ownerAid,
      agentName: context.agentName,
      chatmode: 'interactive',
      replyContext: ownerReplyContext,
    });

    const sent = await sendInteractionPayload(
      approval.adapter,
      envelope,
      interaction,
      `临时授权申请\n${body}\n请在 AUN 卡片中选择批准或拒绝。`,
      ownerReplyContext,
    );
    if (!sent) {
      await sendPrompt('当前会话权限不足，向 owner 发送授权申请失败。');
      return 'deny';
    }

    return new Promise((resolve) => {
      const ownerChatDir = approval.selfAid
        ? chatDirPath(resolvePaths().sessionsDir, 'aun', approval.ownerAid, approval.selfAid)
        : undefined;
      const pending: PendingCrossSessionPermission = {
        sessionId,
        requestId,
        toolName,
        displaySummary,
        reason,
        resolve,
        selfAid: approval.selfAid,
        ownerAid: approval.ownerAid,
        ownerChatDir,
        originChatDir: approval.originChatDir,
        originChannelId: approval.originChannelId,
        originChatType: context.chatType,
        cardFallbackMsgId: `auth-card:${requestId}`,
        expiresAt,
        interactionRouter,
      };
      this.crossSessionPending.set(requestId, pending);
      interactionRouter.register(requestId, sessionId, (action, values, operatorId) => {
        this.resolveCrossSessionPermission(sessionId, requestId, action, values, operatorId);
      }, {
        initiatorId: approval.ownerAid,
        timeoutMs: ttlMs,
        onTimeout: () => this.expireCrossSessionPermission(sessionId, requestId, 'expired'),
        fallbackCommand: 'auth',
      });
      sendPrompt('当前会话权限不足，已向 owner 发送临时授权申请，等待审批。').catch(error => {
        logger.debug(`[PermissionGateway] cross-session notify origin failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  /**
   * 请求人工审批。返回三态决策。
   */
  async requestPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sendPrompt: (text: string) => Promise<void>,
    context?: PermissionRequestContext,
    summary?: string,
    reason?: string
  ): Promise<PermissionDecision> {
    // 如果已标记为始终允许，直接放行
    if (this.isAlwaysAllowed(toolName)) {
      return 'always';
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displaySummary = summary || summarizeToolInput(toolName, toolInput);
    const reasonLine = reason ? `\n原因：${reason}` : '';

    this.eventBus?.publish({ type: 'permission:requested', sessionId, requestId, toolName, input: displaySummary });

    if (this.shouldUseCrossSessionApproval(context)) {
      return this.requestCrossSessionPermission(
        sessionId,
        requestId,
        toolName,
        toolInput,
        sendPrompt,
        context!,
        displaySummary,
        reason,
      );
    }

    // 构造 ActionInteraction
    const interaction: InteractionRequest = {
      type: 'interaction',
      id: requestId,
      kind: {
        kind: 'action',
        title: '🔐 权限请求',
        body: `工具：${toolName}\n操作：${displaySummary}${reasonLine}`,
        buttons: [
          { key: 'allow',  label: '✅ 允许',     style: 'primary' },
          { key: 'always', label: '🔓 始终允许',  style: 'default' },
          { key: 'deny',   label: '❌ 拒绝',     style: 'danger' },
        ],
      },
      channelId: context?.channelId || '',
      sessionId,
      initiatorId: context?.userId,
      fallback: { command: 'perm' },
    };

    // 尝试富交互（走统一 adapter.send 入口）
    let interactionSent = false;
    if (context?.flushPending) {
      try {
        await context.flushPending();
      } catch {
        // flush 失败不应阻断权限请求发送
      }
    }
    if (context?.adapter && context.channelId) {
      try {
        const envelope = buildEnvelope({
          taskId: context.taskId,
          channel: context.channel ?? context.adapter.channelName,
          channelId: context.channelId,
          agentName: context.agentName,
          chatmode: context.chatmode,
          replyContext: context.replyContext,
        });
        const fallbackText = `🔐 权限请求 - ${toolName}\n${displaySummary}${reasonLine}\n回复 /perm allow 同意 / /perm always 始终允许 / /perm deny 拒绝`;
        const result = await sendInteractionPayload(
          context.adapter,
          envelope,
          interaction,
          fallbackText,
          context.replyContext,
        );
        interactionSent = !!result;
      } catch (err) {
        // sendInteractionPayload 已内部捕获，但保险起见再 try/catch
      }
    }

    // fallback 到文本
    if (!interactionSent) {
      await sendPrompt(renderActionAsText(interaction));
    }

    return new Promise((resolve) => {
      this.pending.set(requestId, { sessionId, toolName, resolve, interactionRouter: context?.interactionRouter });

      // 注册到 InteractionRouter（卡片和文本降级都注册，统一路由）
      if (context?.interactionRouter) {
        context.interactionRouter.register(requestId, sessionId, (action) => {
          this.resolvePermission(sessionId, requestId, action as PermissionDecision);
        }, { initiatorId: context?.userId, fallbackCommand: 'perm' });
      }
    });
  }

  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;

    // 如果是 always，缓存该工具
    if (decision === 'always') {
      this.addAlwaysAllow(pending.toolName);
    }

    pending.resolve(decision);
    this.pending.delete(requestId);
    this.eventBus?.publish({ type: 'permission:resolved', sessionId, requestId, approved: decision !== 'deny' });
    return true;
  }

  /** 中断时取消指定会话的所有 pending 权限请求 */
  cancelAll(sessionId: string, reason = 'cancelled'): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        pending.interactionRouter?.cancel(requestId);
        pending.resolve('deny');
        this.pending.delete(requestId);
        this.eventBus?.publish({
          type: 'permission:cancelled',
          sessionId,
          requestId,
          toolName: pending.toolName,
          reason,
        });
      }
    }
    for (const requestId of [...this.crossSessionPending.keys()]) {
      this.expireCrossSessionPermission(sessionId, requestId, 'cancelled');
    }
  }

  /** 获取指定会话的所有 pending requestId */
  getPendingRequests(sessionId: string): string[] {
    const ids: string[] = [];
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        ids.push(requestId);
      }
    }
    for (const [requestId, pending] of this.crossSessionPending.entries()) {
      if (pending.sessionId === sessionId) {
        ids.push(requestId);
      }
    }
    return ids;
  }
}

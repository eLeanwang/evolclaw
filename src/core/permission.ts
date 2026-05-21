import path from 'path';
import fs from 'fs';
import type { EventBus } from './event-bus.js';
import type { ChannelAdapter, ReplyContext, InteractionRequest } from '../types.js';
import type { InteractionRouter } from './interaction-router.js';
import { renderActionAsText } from './interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from './message/message-processor.js';

// 危险命令黑名单（正则表达式）
const DANGEROUS_PATTERNS = [
  // Unix
  /\brm\s+-\w*r\w*f/,        // rm -rf
  /\bsudo\b/,                 // sudo
  /\bmkfs\b/,                 // mkfs (格式化文件系统)
  /\bdd\s+if=/,               // dd (磁盘操作)
  /\bchmod\s+777/,            // chmod 777 (危险权限)
  />\s*\/dev\/(?!null\b)/,    // 重定向到设备文件（排除 /dev/null）
  /\bshutdown\b/,             // 关机
  /\breboot\b/,               // 重启
  // Windows
  /\bformat\s+[a-zA-Z]:/i,   // format C: (格式化磁盘)
  /\brd\s+\/s/i,              // rd /s (递归删除目录)
  /\bdel\s+\/[sfq]/i,        // del /f, /s, /q (强制删除)
  /\breg\s+delete/i,          // reg delete (删除注册表)
  /\bnet\s+stop/i,            // net stop (停止服务)
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
  projectPath: string
): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const filePath = (input.file_path || input.notebook_path) as string | undefined;
    if (!filePath) return { behavior: 'allow' };
    const tmpDir = path.join(projectPath, '.evolclaw', 'tmp') + path.sep;
    const resolved = path.resolve(projectPath, filePath) + (filePath.endsWith(path.sep) ? path.sep : '');
    if (!resolved.startsWith(tmpDir) && resolved !== tmpDir.slice(0, -1)) {
      return { behavior: 'deny', message: '🔒 只读模式：禁止修改项目文件。如需生成文件请写入 .evolclaw/tmp/ 目录' };
    }
  }

  if (toolName === 'Bash') {
    const cmd = (input.command as string) || '';
    for (const pattern of READONLY_WRITE_PATTERNS) {
      if (pattern.test(cmd)) {
        return { behavior: 'deny', message: '🔒 只读模式：禁止执行写入操作' };
      }
    }
  }

  return { behavior: 'allow' };
}

/**
 * 黑名单检查（用于 PreToolUse hook）
 * 检查危险命令模式，非黑名单一律放行
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

    // 检查黑名单
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          behavior: 'deny',
          message: `⛔ 危险命令被拦截: ${cmd.substring(0, 80)}`
        };
      }
    }
  }

  // 默认允许
  return { behavior: 'allow', updatedInput: input };
}

/**
 * 工具输入摘要（提取工具调用的可读描述，供权限审批和消息展示使用）
 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';

  const extractors: Record<string, (i: any) => string | undefined> = {
    'Read':  (i) => i.file_path,
    'Edit':  (i) => formatEditSummary(i),
    'Write': (i) => i.file_path,
    'Bash':  (i) => {
      const cmd = i.command?.substring(0, 80) || '';
      const desc = i.description;
      if (desc && cmd) return `${cmd} | ${desc}`;
      return cmd || desc;
    },
    'Grep':  (i) => `pattern: ${i.pattern}`,
    'Glob':  (i) => `pattern: ${i.pattern}`,
    'Agent': (i) => i.description || i.prompt?.substring(0, 80),
    'Skill': (i) => i.skill ? `${i.skill}${i.args ? ' ' + i.args : ''}` : undefined,
    'ExitPlanMode': (i) => {
      if (i.allowedPrompts?.length) {
        return `计划包含 ${i.allowedPrompts.length} 项操作权限`;
      }
      return '计划审批';
    },
    'TodoWrite': (i) => {
      if (Array.isArray(i.todos)) {
        return i.todos.map((t: any) => t.content || t.task || t.text).filter(Boolean).join(', ').substring(0, 80);
      }
      return undefined;
    },
    'TaskCreate': (i) => i.subject || i.description?.substring(0, 80),
    'TaskUpdate': (i) => i.status ? `${i.taskId} → ${i.status}` : i.taskId,
    'TaskOutput': (i) => `${i.task_id || '?'}${i.block === false ? ' (non-blocking)' : ''}${i.timeout ? ` timeout=${i.timeout}ms` : ''}`,
    'TaskStop': (i) => i.task_id || i.shell_id || '?',
    'NotebookEdit': (i) => i.notebook_path,
    'WebFetch': (i) => i.url,
    'WebSearch': (i) => i.query?.substring(0, 80),
  };

  const extractor = extractors[toolName];
  if (extractor) {
    const result = extractor(input);
    if (result) return result;
  }

  return (input as any).description
    || (input as any).subject
    || (input as any).file_path
    || (input as any).pattern
    || (input as any).command?.substring(0, 80)
    || (input as any).prompt?.substring(0, 80)
    || (input as any).query?.substring(0, 80)
    || (input as any).skill
    || (input as any).url
    || '';
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

/** 为 Edit 工具生成 diff 风格摘要 */
function formatEditSummary(input: any): string {
  const filePath = input.file_path || '';
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';

  if (!oldStr && !newStr) return filePath;

  const MAX_DIFF_LINES = 14;

  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // 尝试从文件中定位 old_string 的起始行号
  let startLine = 0; // 0-based; 0 means unknown
  if (filePath && oldStr) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx >= 0) {
        startLine = content.slice(0, idx).split('\n').length; // 1-based
      }
    } catch {
      // 文件不可读，行号留空
    }
  }

  const diffLines: string[] = [];

  // 找公共前缀行数
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }
  // 找公共后缀行数
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const CONTEXT = 2;
  // 计算行号宽度（用于对齐）
  const maxLineNo = startLine > 0 ? startLine + oldLines.length - 1 : 0;
  const newMaxLineNo = startLine > 0 ? startLine + prefixLen + (newLines.length - suffixLen - prefixLen) - 1 : 0;
  const padWidth = startLine > 0 ? Math.max(maxLineNo, newMaxLineNo).toString().length : 0;

  // 格式化一行：行号 + 标记 + 内容
  // 使用 Unicode 符号避免飞书 Markdown 将 "- " 解析为列表
  const fmtLine = (lineNo: number, marker: '−' | '＋' | ' ', text: string) => {
    if (startLine > 0) {
      return `${lineNo.toString().padStart(padWidth)} ${marker}  ${text}`;
    }
    return `${marker}  ${text}`;
  };

  // 上下文前缀（最多 CONTEXT 行）
  const ctxStart = Math.max(0, prefixLen - CONTEXT);
  for (let i = ctxStart; i < prefixLen; i++) {
    diffLines.push(fmtLine(startLine + i, ' ', oldLines[i]));
  }

  // 删除行
  const removedEnd = oldLines.length - suffixLen;
  for (let i = prefixLen; i < removedEnd && diffLines.length < MAX_DIFF_LINES; i++) {
    diffLines.push(fmtLine(startLine + i, '−', oldLines[i]));
  }

  // 新增行（行号从 prefixLen 位置开始递增）
  const addedEnd = newLines.length - suffixLen;
  for (let i = prefixLen; i < addedEnd && diffLines.length < MAX_DIFF_LINES; i++) {
    diffLines.push(fmtLine(startLine + i, '＋', newLines[i]));
  }

  // 上下文后缀（最多 CONTEXT 行）
  const ctxEnd = Math.min(oldLines.length, removedEnd + CONTEXT);
  for (let i = removedEnd; i < ctxEnd && diffLines.length < MAX_DIFF_LINES + 2; i++) {
    diffLines.push(fmtLine(startLine + i, ' ', oldLines[i]));
  }

  if (diffLines.length > MAX_DIFF_LINES + 2) {
    diffLines.splice(MAX_DIFF_LINES, diffLines.length, '  ...');
  }

  return `${filePath}\n\`\`\`\n${diffLines.join('\n')}\n\`\`\``;
}

interface PendingPermission {
  sessionId: string;
  toolName: string;
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();
  private timeout = 5 * 60 * 1000;
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

  /**
   * 请求人工审批。返回三态决策。
   */
  async requestPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sendPrompt: (text: string) => Promise<void>,
    context?: {
      adapter?: ChannelAdapter;
      channelId?: string;
      replyContext?: ReplyContext;
      interactionRouter?: InteractionRouter;
      userId?: string;
      channel?: string;
      agentName?: string;
      taskId?: string;
      chatmode?: 'interactive' | 'proactive';
    },
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
      this.pending.set(requestId, { sessionId, toolName, resolve, timer: setTimeout(() => {}, 0) });

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
    clearTimeout(pending.timer);

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
  cancelAll(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        pending.resolve('deny');
        this.pending.delete(requestId);
      }
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
    return ids;
  }
}

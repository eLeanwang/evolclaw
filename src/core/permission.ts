import path from 'path';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import type { EventBus } from './event-bus.js';
import type {
  ApprovalRoute,
  ApprovalRoutingContext,
  AuthorizationChallenge,
  ChannelAdapter,
  InteractionRequest,
  ReplyContext,
} from '../types.js';
import type { InteractionRouter } from './interaction-router.js';
import { renderActionAsText } from './interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from './message/message-utils.js';
import { logger } from '../utils/logger.js';
import { summarizeToolInput } from '../utils/tool-summary.js';
import {
  containsHClassReference,
  hClassGrantIncludesProtectedPath,
  isHClassPath,
} from './protected-paths.js';

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
  {
    kind: 'rm-rf',
    pattern: /\brm\b(?=[^;&|\r\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?:\s|=|$))(?=[^;&|\r\n]*\s(?:-[A-Za-z]*f[A-Za-z]*|--force)(?:\s|=|$))[^;&|\r\n]*/,
    reason: '递归删除文件/目录，操作不可逆',
  },
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

/**
 * 只读模式检查（用于 PreToolUse hook 和 canUseTool callback）
 * 显式读工具自动允许；写工具和未知工具拒绝。
 * Bash 无法可靠地从命令文本证明无副作用，因此默认拒绝；经过独立 EC
 * 命令鉴权的命令应由 runner 在调用本函数前放行。
 */
export function checkReadonly(
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
  context?: { sessionId?: string; channel?: string; peerId?: string; role?: string }
): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
  const readOnlyTools = new Set([
    'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'TaskList', 'TaskGet', 'ToolSearch',
  ]);
  if (readOnlyTools.has(toolName)) return { behavior: 'allow' };

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const filePath = (input.file_path || input.notebook_path) as string | undefined;
    logger.warn(`[ReadonlyCheck] 🔒 File write blocked: tool=${toolName} path=${filePath} project=${projectPath} session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`);
    return { behavior: 'deny', message: '🔒 只读模式：禁止写入或修改文件' };
  }

  if (toolName === 'Bash') {
    const cmd = (input.command as string) || '';
    const cmdPreview = cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd;
    logger.warn(`[ReadonlyCheck] 🔒 Bash blocked by default: cmd="${cmdPreview}" session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`);
    return { behavior: 'deny', message: '🔒 只读模式：Shell 命令无法证明无副作用，已拒绝执行' };
  }

  logger.warn(`[ReadonlyCheck] 🔒 Unknown tool blocked: tool=${toolName} session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`);
  return { behavior: 'deny', message: `🔒 只读模式：未声明为只读的工具 ${toolName} 已拒绝执行` };
}

/**
 * H 类文件保护（用于 PreToolUse hook）
 * H 类文件只能由受控的人类/daemon 路径处理，agent 不可直接访问
 */
function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringValues(entry, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output.push(key);
    collectStringValues(entry, output);
  }
}

function collectPermissionPathSpec(
  value: unknown,
  output: string[],
  projectRootSubpaths?: string[],
): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string') output.push(record.path);
  if (typeof record.pattern === 'string') output.push(record.pattern);
  if (record.type === 'special' && record.value && typeof record.value === 'object') {
    const special = record.value as Record<string, unknown>;
    const kind = special.kind;
    if (kind === 'project_roots') {
      const subpath = typeof special.subpath === 'string' && special.subpath ? special.subpath : '.';
      if (projectRootSubpaths) projectRootSubpaths.push(subpath);
      else output.push(subpath);
    } else if (kind === 'unknown' && typeof special.path === 'string' && special.path) {
      const unknownPath = special.path;
      const subpath = typeof special.subpath === 'string' && special.subpath ? special.subpath : undefined;
      output.push(subpath
        ? (path.isAbsolute(subpath) ? subpath : path.join(unknownPath, subpath))
        : unknownPath);
    }
  }
}

function collectFilesystemGrantPaths(
  value: unknown,
  output: string[],
  projectRootSubpaths?: string[],
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const profile = value as Record<string, unknown>;
  const fileSystem = profile.fileSystem ?? profile.filesystem;
  if (!fileSystem || typeof fileSystem !== 'object' || Array.isArray(fileSystem)) return;
  const fsProfile = fileSystem as Record<string, unknown>;

  for (const key of ['read', 'write']) {
    const paths = fsProfile[key];
    if (Array.isArray(paths)) {
      for (const candidate of paths) collectPermissionPathSpec(candidate, output, projectRootSubpaths);
    }
  }

  if (Array.isArray(fsProfile.entries)) {
    for (const entry of fsProfile.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.access === 'deny') continue;
      collectPermissionPathSpec(record.path, output, projectRootSubpaths);
    }
  }

  // Named-profile shaped overlays use path keys with read/write/deny values.
  for (const [candidate, access] of Object.entries(fsProfile)) {
    if (access === 'read' || access === 'write') {
      if (candidate === ':root') output.push(path.parse(process.cwd()).root);
      else if (candidate === ':workspace_roots') output.push('.');
      else if (![':minimal', ':tmpdir', ':slash_tmp'].includes(candidate)) output.push(candidate);
    }
    if (!access || typeof access !== 'object' || Array.isArray(access)) continue;
    for (const [subpath, nestedAccess] of Object.entries(access as Record<string, unknown>)) {
      if (nestedAccess !== 'read' && nestedAccess !== 'write') continue;
      if (candidate === ':root') output.push(path.resolve(path.parse(process.cwd()).root, subpath));
      else if (candidate === ':workspace_roots') output.push(subpath === '.' ? '.' : subpath);
      else if (![':minimal', ':tmpdir', ':slash_tmp'].includes(candidate)) output.push(path.join(candidate, subpath));
    }
  }
}

function collectExplicitFileChangePaths(record: Record<string, unknown>, output: string[]): boolean {
  const explicitPathKeys = ['path', 'filePath', 'file_path', 'movePath', 'move_path', 'destinationPath', 'targetPath'];
  const hasExplicitPath = explicitPathKeys.some(key => typeof record[key] === 'string');
  for (const key of explicitPathKeys) {
    if (typeof record[key] === 'string' && record[key]) output.push(record[key] as string);
  }
  if (record.kind && typeof record.kind === 'object') {
    collectExplicitFileChangePaths(record.kind as Record<string, unknown>, output);
  }
  return hasExplicitPath;
}

function collectFileChangePaths(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        collectExplicitFileChangePaths(entry as Record<string, unknown>, output);
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const hasExplicitPath = collectExplicitFileChangePaths(record, output);

  // Claude-style inputs are maps keyed by path; Codex v2 uses an array of
  // records with an explicit path field. Only treat keys as paths for the map
  // shape so diff text and metadata never become path candidates.
  if (!hasExplicitPath) {
    for (const [filePath, change] of Object.entries(record)) {
      if (filePath !== 'kind' && filePath !== 'type') output.push(filePath);
      if (change && typeof change === 'object' && !Array.isArray(change)) {
        collectExplicitFileChangePaths(change as Record<string, unknown>, output);
      }
    }
  }
}

function requestsFilesystemRoot(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(requestsFilesystemRoot);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.access !== 'deny') {
    const pathSpec = record.path;
    if (pathSpec && typeof pathSpec === 'object' && !Array.isArray(pathSpec)) {
      const pathRecord = pathSpec as Record<string, unknown>;
      const special = pathRecord.type === 'special' ? pathRecord.value : undefined;
      if (special && typeof special === 'object' && !Array.isArray(special)) {
        if ((special as Record<string, unknown>).kind === 'root') return true;
      }
    }
  }
  return Object.values(record).some(requestsFilesystemRoot);
}

export function checkHClassWrite(
  toolName: string,
  input: Record<string, unknown>,
  context?: {
    sessionId?: string;
    channel?: string;
    peerId?: string;
    role?: string;
    projectPath?: string;
    workspacePath?: string;
    root?: string;
  }
): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
  const paths: string[] = [];
  const grantPaths: string[] = [];
  const projectRootGrantSubpaths: string[] = [];
  if (['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'].includes(toolName)) {
    const filePath = input.file_path ?? input.notebook_path ?? input.path ?? input.pattern;
    if (typeof filePath === 'string' && filePath) paths.push(filePath);
  } else if (toolName === 'FileChange' || toolName === 'PermissionGrant') {
    const grantRoot = input.grantRoot;
    if (typeof grantRoot === 'string' && grantRoot) grantPaths.push(grantRoot);
    const fileChanges = input.fileChanges;
    collectFileChangePaths(fileChanges, paths);
    collectFilesystemGrantPaths(input.permissions, grantPaths, projectRootGrantSubpaths);
  } else if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.replace(/\\/g, '/') : '';
    if (containsHClassReference(command)) {
      logger.warn(
        `[H-Class Protection] 🔒 Protected path referenced by shell command: tool=${toolName} ` +
        `session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`
      );
      return {
        behavior: 'deny',
        message: '🔒 Shell 命令涉及受保护的 H 类配置/证书/快照路径，agent 不可直接操作',
      };
    }
    collectFilesystemGrantPaths(input.additionalPermissions, grantPaths, projectRootGrantSubpaths);
    collectFilesystemGrantPaths(input.permissions, grantPaths, projectRootGrantSubpaths);
  } else {
    collectStringValues(input, paths);
  }

  const pathOptions = { cwd: context?.projectPath, root: context?.root };
  if (requestsFilesystemRoot(input.permissions) || requestsFilesystemRoot(input.additionalPermissions)) {
    logger.warn(
      `[H-Class Protection] 🔒 Permission grant covers filesystem root: tool=${toolName} ` +
      `session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`
    );
    return {
      behavior: 'deny',
      message: '🔒 请求的文件系统根权限包含受保护的 H 类路径，已拒绝授权',
    };
  }
  for (const grantPath of grantPaths) {
    if (!grantPath) continue;
    if (containsHClassReference(grantPath) || hClassGrantIncludesProtectedPath(grantPath, pathOptions)) {
      logger.warn(
        `[H-Class Protection] 🔒 Permission grant covers protected paths: tool=${toolName} path=${grantPath} ` +
        `session=${context?.sessionId} channel=${context?.channel} peer=${context?.peerId} role=${context?.role}`
      );
      return {
        behavior: 'deny',
        message: '🔒 请求的文件系统权限范围包含受保护的 H 类路径，已拒绝授权',
      };
    }
  }
  const permissionWorkspace = context?.workspacePath ?? context?.projectPath;
  for (const subpath of projectRootGrantSubpaths) {
    // Codex `project_roots` is relative to the thread workspace, not to the
    // command/permission-request cwd. Keep the two coordinate systems apart.
    if (!permissionWorkspace) {
      return {
        behavior: 'deny',
        message: '🔒 无法确定 project_roots 权限的 thread workspace，已拒绝授权',
      };
    }
    const candidate = path.isAbsolute(subpath)
      ? subpath
      : path.resolve(permissionWorkspace, subpath);
    if (containsHClassReference(subpath) || hClassGrantIncludesProtectedPath(candidate, { root: context?.root })) {
      logger.warn(
        `[H-Class Protection] 🔒 project_roots grant covers protected paths: tool=${toolName} path=${subpath} ` +
        `workspace=${permissionWorkspace} session=${context?.sessionId} channel=${context?.channel} ` +
        `peer=${context?.peerId} role=${context?.role}`
      );
      return {
        behavior: 'deny',
        message: '🔒 请求的 project_roots 权限范围包含受保护的 H 类路径，已拒绝授权',
      };
    }
  }

  for (const filePath of paths) {
    const normalized = filePath.replace(/\\/g, '/');
    const matched = containsHClassReference(normalized) || isHClassPath(filePath, pathOptions);
    if (matched) {
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
const TRAILING_FD_DUPLICATION_RE = /(?:\s+\d*>&\d+)+\s*$/;

export function parseEvolclawSendCommand(command: string): EvolclawSendCommand | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const parseable = trimmed.replace(TRAILING_FD_DUPLICATION_RE, '').trimEnd();
  if (!parseable || SHELL_CONTROL_RE.test(parseable)) return null;

  const ctlMatch = parseable.match(/^(?:ec|evolclaw)\s+ctl\s+(send|file)(?:\s|$)/);
  if (ctlMatch) {
    return { scope: 'ctl', action: ctlMatch[1] as 'send' | 'file' };
  }

  const sessionMatch = parseable.match(/^(?:ec|evolclaw)\s+(msg|group)\s+(send|file)\s+\S+\s+(\S+)(?:\s|$)/);
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
  approvalRouting?: ApprovalRoutingContext;
  flushPending?: () => Promise<void>;
}

export async function requestDangerousCommandPermission(
  gateway: PermissionGateway | undefined,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  sendPrompt: ((text: string) => Promise<void>) | undefined,
  context?: PermissionRequestContext,
  grantScope = 'default',
): Promise<{ matched: false } | { matched: true; decision: PermissionDecision }> {
  const dangerCheck = checkDangerousCommand(toolName, input);
  if (!dangerCheck.isDangerous) {
    return { matched: false };
  }

  if (!gateway || !sendPrompt) {
    logger.warn(`[PermissionGateway] Dangerous operation denied because approval is unavailable: session=${sessionId} tool=${toolName}`);
    return { matched: true, decision: 'deny' };
  }

  const decision = await gateway.requestPermission(
    sessionId,
    dangerCheck.cacheKey,
    input,
    sendPrompt,
    context,
    `⚠️ ${dangerCheck.command}`,
    dangerCheck.reason,
    grantScope,
  );

  return { matched: true, decision };
}

interface PendingPermission {
  sessionId: string;
  toolName: string;
  inputFingerprint: string;
  grantScope: string;
  approverId: string;
  resolve: (decision: PermissionDecision) => void;
  interactionRouter?: InteractionRouter;
  timeout?: NodeJS.Timeout;
}

interface PendingCrossSessionPermission extends PendingPermission {
  requestId: string;
  displaySummary: string;
  reason?: string;
  inputFingerprint: string;
  interactionRouter?: InteractionRouter;
  timeout?: NodeJS.Timeout;
}

interface TemporaryPermissionGrant {
  expiresAt: number;
}

const SESSION_GRANT_TTL_MS = 30 * 60 * 1000;
const LOCAL_APPROVAL_TTL_MS = 20 * 60 * 1000;
const APPROVAL_DETAIL_LIMIT = 800;

function stablePermissionInput(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stablePermissionInput).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stablePermissionInput(record[key])}`).join(',')}}`;
}

function permissionInputFingerprint(input: Record<string, unknown>): string {
  return createHash('sha256').update(stablePermissionInput(input)).digest('hex');
}

function truncateApprovalDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > APPROVAL_DETAIL_LIMIT
    ? `${trimmed.slice(0, APPROVAL_DETAIL_LIMIT - 3)}...`
    : trimmed;
}

function formatApprovalTarget(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' || toolName.startsWith('dangerous:Bash:')) {
    const command = typeof input.command === 'string' ? input.command : '';
    if (command) return truncateApprovalDetail(command);
  }
  const summary = summarizeToolInput(toolName, input);
  if (summary) return truncateApprovalDetail(summary);
  return truncateApprovalDetail(stablePermissionInput(input));
}

function escapeApprovalMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()])/g, '\\$1')
    .replace(/^(\s*)(#{1,6}|>|[-+])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*\d+)\.(\s)/gm, '$1\\.$2');
}

function approvalInlineCode(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${text}${fence}`;
}

function approvalCodeBlock(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${value}\n${fence}`;
}

export function planApprovalRoute(
  challenge: AuthorizationChallenge,
  context?: PermissionRequestContext,
): ApprovalRoute {
  if (!challenge.grantable) {
    return { kind: 'unavailable', reason: 'challenge_not_grantable' };
  }
  const requesterId = context?.userId || '';
  if (!requesterId) return { kind: 'unavailable', reason: 'no_requester_approver' };
  if (challenge.approverPolicy === 'requester') {
    return { kind: 'local', approverId: requesterId };
  }

  const routing = context?.approvalRouting;
  const owners = Array.from(new Set((routing?.owners ?? []).filter(Boolean)));
  if (owners.length === 0) {
    return { kind: 'unavailable', reason: 'no_agent_owner_configured' };
  }
  if (context?.chatType !== 'group' && requesterId && owners.includes(requesterId)) {
    return { kind: 'local', approverId: requesterId };
  }

  const approverId = owners.find(owner => owner.includes('.'));
  if (!approverId) {
    return { kind: 'unavailable', reason: 'no_aun_owner_available' };
  }
  if (!routing?.ownerAdapter) {
    return { kind: 'unavailable', reason: 'owner_approval_channel_unavailable' };
  }
  return { kind: 'handoff', approverId, channel: 'aun', adapter: routing.ownerAdapter };
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();
  private crossSessionPending = new Map<string, PendingCrossSessionPermission>();
  private temporaryGrants = new Map<string, TemporaryPermissionGrant>();
  private eventBus?: EventBus;

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /** Clear all temporary grants when the permission context changes. */
  clearAlwaysAllow(): void {
    this.temporaryGrants.clear();
  }

  private temporaryGrantKey(sessionId: string, toolName: string, inputFingerprint: string, grantScope: string): string {
    return `${sessionId}\u0000${grantScope}\u0000${toolName}\u0000${inputFingerprint}`;
  }

  private pruneTemporaryGrants(now: number): void {
    for (const [key, grant] of this.temporaryGrants.entries()) {
      if (grant.expiresAt <= now) this.temporaryGrants.delete(key);
    }
  }

  hasTemporaryGrant(sessionId: string, toolName: string, toolInput: Record<string, unknown>, grantScope = 'default'): boolean {
    return !!this.getTemporaryGrant(sessionId, toolName, toolInput, grantScope);
  }

  private getTemporaryGrant(sessionId: string, toolName: string, toolInput: Record<string, unknown>, grantScope = 'default'): TemporaryPermissionGrant | undefined {
    const now = Date.now();
    this.pruneTemporaryGrants(now);
    const key = this.temporaryGrantKey(sessionId, toolName, permissionInputFingerprint(toolInput), grantScope);
    return this.temporaryGrants.get(key);
  }

  private addTemporaryGrant(
    pending: Pick<PendingPermission, 'sessionId' | 'toolName' | 'inputFingerprint' | 'grantScope'>,
  ): number {
    const now = Date.now();
    this.pruneTemporaryGrants(now);
    const expiresAt = now + SESSION_GRANT_TTL_MS;
    const key = this.temporaryGrantKey(pending.sessionId, pending.toolName, pending.inputFingerprint, pending.grantScope);
    this.temporaryGrants.set(key, { expiresAt });
    return expiresAt;
  }

  /** Legacy diagnostics alias. Grants are no longer tool-wide or permanent. */
  getAlwaysAllowList(): string[] {
    this.pruneTemporaryGrants(Date.now());
    return [...this.temporaryGrants.keys()];
  }

  private resolveCrossSessionPermission(
    sessionId: string,
    requestId: string,
    action: string,
    _values?: Record<string, unknown>,
    operatorId?: string,
  ): boolean {
    const pending = this.crossSessionPending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    if (operatorId !== pending.approverId) return false;

    if (pending.timeout) clearTimeout(pending.timeout);
    pending.interactionRouter?.cancel(requestId);
    this.crossSessionPending.delete(requestId);

    const sessionGrant = action === 'approve_session_30m';
    const approved = action === 'approve_once' || sessionGrant || action === 'allow';
    const decision: PermissionDecision = approved ? 'allow' : 'deny';
    if (sessionGrant) this.addTemporaryGrant(pending);

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
    challenge: AuthorizationChallenge,
    route: Extract<ApprovalRoute, { kind: 'handoff' }>,
    sendPrompt: (text: string) => Promise<void>,
    context: PermissionRequestContext,
    grantScope: string,
  ): Promise<PermissionDecision> {
    const approval = context.approvalRouting;
    const interactionRouter = context.interactionRouter;
    if (!approval || !interactionRouter) {
      await sendPrompt('当前会话权限不足，且没有可用的 owner 审批通道。');
      return 'deny';
    }

    const { id: requestId, toolName, toolInput, summary: displaySummary, reason } = challenge;
    const ttlMs = approval.approvalTtlMs && approval.approvalTtlMs > 0
      ? approval.approvalTtlMs
      : 20 * 60 * 1000;
    const expiresAt = Date.now() + ttlMs;
    const originRole = approval.originRole || context.role || 'none';
    const requesterId = approval.originPeerId || approval.originChannelId || 'unknown';
    const requester = approval.originPeerName
      ? `${approval.originPeerName} (${requesterId})`
      : requesterId;
    const originChannel = approval.originChannel || context.channel || 'unknown';
    const distinctSource = approval.originChannelId
      && approval.originChannelId !== requesterId
      ? approval.originChannelId
      : undefined;
    const approvalDeadline = new Date(expiresAt).toLocaleString('zh-CN', { hour12: false });
    const target = formatApprovalTarget(toolName, toolInput);
    const body = [
      '**申请信息**',
      '',
      `- **申请主体**：${approvalInlineCode(requester)} · role ${approvalInlineCode(originRole)} · via ${approvalInlineCode(originChannel)}`,
      ...(distinctSource ? [`- **来源会话**：${approvalInlineCode(distinctSource)}`] : []),
      '',
      '**请求执行**',
      '',
      `- **申请能力**：${approvalInlineCode(`tool:${toolName}`)}`,
      `- **预期动作**：${escapeApprovalMarkdown(displaySummary)}`,
      `- **申请原因**：${escapeApprovalMarkdown(reason || '工具运行时要求人工授权')}`,
      '',
      '**目标 / 参数**',
      '',
      approvalCodeBlock(target),
      '',
      '**风险与有效期**',
      '',
      '- **风险：中** · 跨会话临时授权，请核对目标和参数',
      `- **审批截止**：${escapeApprovalMarkdown(approvalDeadline)}（约 ${Math.round(ttlMs / 60000)} 分钟）`,
    ].join('\n');

    const interaction: InteractionRequest = {
      type: 'interaction',
      id: requestId,
      kind: {
        kind: 'action',
        title: '临时授权申请',
        body,
        bodyFormat: 'markdown',
        buttons: [
          { key: 'approve_once', label: '批准本次', style: 'primary' },
          { key: 'approve_session_30m', label: '本会话 30 分钟', style: 'default' },
          { key: 'deny', label: '拒绝', style: 'danger' },
        ],
      },
      channelId: route.approverId,
      sessionId,
      initiatorId: route.approverId || undefined,
      expiresAt,
      fallback: {
        command: 'perm',
        buttonArgMap: {
          approve_once: `${requestId} allow`,
          approve_session_30m: `${requestId} always`,
          deny: `${requestId} deny`,
        },
      },
    };

    // Register before delivery. Some adapters can surface a user response as
    // soon as send() completes; registering afterwards creates a narrow race
    // where a valid approval is visible to the user but dropped by the router.
    const decisionPromise = new Promise<PermissionDecision>((resolve) => {
      const pending: PendingCrossSessionPermission = {
        sessionId,
        requestId,
        toolName,
        displaySummary,
        reason,
        resolve,
        inputFingerprint: permissionInputFingerprint(toolInput),
        grantScope,
        approverId: route.approverId,
        interactionRouter,
      };
      this.crossSessionPending.set(requestId, pending);
      interactionRouter.register(requestId, sessionId, (action, values, operatorId) => {
        this.resolveCrossSessionPermission(sessionId, requestId, action, values, operatorId);
      }, {
        initiatorId: route.approverId,
        timeoutMs: ttlMs,
        onTimeout: () => this.expireCrossSessionPermission(sessionId, requestId, 'expired'),
        fallbackCommand: 'perm',
      });
    });

    if (context.flushPending) {
      try {
        await context.flushPending();
      } catch {
        // flush 失败不阻断审批请求
      }
    }

    const ownerReplyContext: ReplyContext = {
      metadata: {
        source: 'handoff',
        chatmode: 'interactive',
      },
    };

    const envelope = buildEnvelope({
      taskId: context.taskId,
      sessionId,
      channel: route.adapter.channelName,
      channelId: route.approverId,
      agentName: context.agentName,
      chatmode: 'interactive',
      replyContext: ownerReplyContext,
    });

    let sent = false;
    try {
      sent = !!await sendInteractionPayload(
        route.adapter,
        envelope,
        interaction,
        renderActionAsText(interaction),
        ownerReplyContext,
      );
    } catch (error) {
      logger.warn(`[PermissionGateway] Owner approval delivery failed: session=${sessionId} tool=${toolName} error=${error instanceof Error ? error.message : String(error)}`);
    }
    if (!sent) {
      this.expireCrossSessionPermission(sessionId, requestId, 'failed');
      try {
        await sendPrompt('当前会话权限不足，向 owner 发送授权申请失败。');
      } catch (error) {
        logger.debug(`[PermissionGateway] cross-session delivery failure notice failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return decisionPromise;
    }

    sendPrompt('当前会话权限不足，已向 owner 发送临时授权申请，等待审批。').catch(error => {
      logger.debug(`[PermissionGateway] cross-session notify origin failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return decisionPromise;
  }

  private failPendingPermission(sessionId: string, requestId: string, reason: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.interactionRouter?.cancel(requestId);
    this.pending.delete(requestId);
    pending.resolve('deny');
    this.eventBus?.publish({
      type: 'permission:resolved',
      sessionId,
      requestId,
      toolName: pending.toolName,
      reason,
      approved: false,
    });
    return true;
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
    reason?: string,
    grantScope = 'default',
  ): Promise<PermissionDecision> {
    if (!context?.userId) {
      await sendPrompt('当前操作需要授权，但无法验证申请人身份。');
      return 'deny';
    }
    const temporaryGrant = this.getTemporaryGrant(sessionId, toolName, toolInput, grantScope);
    if (temporaryGrant) {
      return 'allow';
    }

    const requestId = `perm-${randomUUID()}`;
    const displaySummary = summary || summarizeToolInput(toolName, toolInput);
    const reasonLine = reason ? `\n原因：${reason}` : '';
    const challenge: AuthorizationChallenge = {
      id: requestId,
      sessionId,
      toolName,
      toolInput,
      summary: displaySummary,
      reason,
      grantable: true,
      approverPolicy: context?.approvalRouting?.approverPolicy ?? 'requester',
      createdAt: Date.now(),
    };

    this.eventBus?.publish({ type: 'permission:requested', sessionId, requestId, toolName, input: displaySummary });

    const route = planApprovalRoute(challenge, context);
    if (route.kind === 'unavailable') {
      await sendPrompt(`当前操作需要授权，但审批人不可用（${route.reason}）。`);
      this.eventBus?.publish({
        type: 'permission:resolved',
        sessionId,
        requestId,
        toolName,
        reason: route.reason,
        approved: false,
      });
      return 'deny';
    }
    if (route.kind === 'handoff') {
      return this.requestCrossSessionPermission(
        sessionId,
        challenge,
        route,
        sendPrompt,
        context!,
        grantScope,
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
          { key: 'allow',  label: '✅ 允许本次', style: 'primary' },
          { key: 'always', label: '⏱ 同操作 30 分钟', style: 'default' },
          { key: 'deny',   label: '❌ 拒绝', style: 'danger' },
        ],
      },
      channelId: context?.channelId || '',
      sessionId,
      initiatorId: route.approverId,
      expiresAt: Date.now() + LOCAL_APPROVAL_TTL_MS,
      fallback: {
        command: 'perm',
        buttonArgMap: {
          allow: `${requestId} allow`,
          always: `${requestId} always`,
          deny: `${requestId} deny`,
        },
      },
    };

    // Register before delivery so an immediate card/text response cannot beat
    // the pending approval handler. The UUID keeps this pre-delivery slot from
    // being practically guessable.
    const decisionPromise = new Promise<PermissionDecision>((resolve) => {
      const pending: PendingPermission = {
        sessionId,
        toolName,
        inputFingerprint: permissionInputFingerprint(toolInput),
        grantScope,
        approverId: route.approverId,
        resolve,
        interactionRouter: context?.interactionRouter,
      };
      pending.timeout = setTimeout(() => {
        this.failPendingPermission(sessionId, requestId, 'expired');
      }, LOCAL_APPROVAL_TTL_MS);
      pending.timeout.unref?.();
      this.pending.set(requestId, pending);

      if (context?.interactionRouter) {
        context.interactionRouter.register(requestId, sessionId, (action, _values, operatorId) => {
          this.resolvePermission(sessionId, requestId, action as PermissionDecision, operatorId);
        }, { initiatorId: route.approverId || undefined, fallbackCommand: 'perm' });
      }
    });

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
        const fallbackText = `🔐 权限请求 - ${toolName}\n${displaySummary}${reasonLine}\n回复 /perm ${requestId} allow 允许本次 / /perm ${requestId} always 同操作授权 30 分钟 / /perm ${requestId} deny 拒绝`;
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
      try {
        await sendPrompt(renderActionAsText(interaction));
      } catch (error) {
        logger.warn(`[PermissionGateway] Approval delivery failed: session=${sessionId} tool=${toolName} error=${error instanceof Error ? error.message : String(error)}`);
        this.failPendingPermission(sessionId, requestId, 'delivery_failed');
      }
    }

    return decisionPromise;
  }

  resolvePermission(sessionId: string, requestId: string, decision: string, operatorId?: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    if (operatorId !== pending.approverId) return false;

    const normalizedDecision: PermissionDecision = decision === 'allow' || decision === 'always'
      ? decision
      : 'deny';

    // Legacy "always" now means this exact operation in this session for 30 minutes.
    // The backend receives a one-shot allow. Future identical operations must
    // return through this gateway so the exact fingerprint and TTL are checked.
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.interactionRouter?.cancel(requestId);
    pending.resolve(normalizedDecision === 'deny' ? 'deny' : 'allow');
    this.pending.delete(requestId);
    if (normalizedDecision === 'always') {
      this.addTemporaryGrant(pending);
    }
    this.eventBus?.publish({ type: 'permission:resolved', sessionId, requestId, approved: normalizedDecision !== 'deny' });
    return true;
  }

  /**
   * Resolve an explicitly named request from any channel/session. The request
   * remains bound to its authenticated approver, so knowing a UUID alone is
   * never sufficient to approve it.
   */
  resolvePermissionByRequestId(
    requestId: string,
    decision: PermissionDecision,
    operatorId?: string,
  ): boolean {
    const local = this.pending.get(requestId);
    if (local) {
      return this.resolvePermission(local.sessionId, requestId, decision, operatorId);
    }

    const crossSession = this.crossSessionPending.get(requestId);
    if (!crossSession) return false;
    const action = decision === 'always'
      ? 'approve_session_30m'
      : decision === 'allow'
        ? 'approve_once'
        : 'deny';
    return this.resolveCrossSessionPermission(
      crossSession.sessionId,
      requestId,
      action,
      undefined,
      operatorId,
    );
  }

  /** 中断时取消指定会话的所有 pending 权限请求 */
  cancelAll(sessionId: string, reason = 'cancelled'): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        if (pending.timeout) clearTimeout(pending.timeout);
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

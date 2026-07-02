/**
 * EC 命令权限控制 —— 独立模块
 *
 * 背景：`ec msg send` / `ec group send` / `ec ctl send` 等命令目前只在 Bash 工具
 * 白名单层面做会话内目标匹配（见 src/core/permission.ts 的
 * parseEvolclawSendCommand / isEvolclawSendCommandForSession），完全没有走
 * operation-based 角色权限模型（authorizeCommand()）。
 *
 * 本模块把 ec 命令归一化为 CommandIntent，并复用现有的
 * src/core/command/command-permission.ts 统一鉴权核心，使 ec 命令可以按角色
 * 通过 commandPermissions 精细授权（ownPeerOnly / groupOnly / requireControlChannel 等）。
 *
 * 范围说明（当前版本）：
 * - 仅覆盖 send / file 两个写操作（ec msg / ec group / ec ctl）。
 * - ec ctl status / ec ctl queue 等只读命令暂不纳入，仍走原有 Bash 白名单逻辑。
 *
 * 参照设计文档 docs/权限配置化与通用接口鉴权设计.md
 */

import { parseEvolclawSendCommand, type EvolclawSendCommand } from '../permission.js';
import { authorizeCommand } from './command-permission.js';
import { auditCommandAuthorization, hashArgv } from './command-audit.js';
import type { CommandAuthorizationContext, CommandAuthorizationDecision, CommandScope } from '../../types.js';

/**
 * ec 命令上下文 —— 由调用方（runner 的 Bash PreToolUse 钩子）提供。
 * 不包含 intent，intent 由本模块从 command 字符串解析生成。
 */
export type EcCommandAuthorizationContext = Omit<CommandAuthorizationContext, 'intent' | 'source'>;

/**
 * 把 ec 命令的 scope/action 映射为 operation id。
 * 与 operation-registry.ts 中注册的 ec.* operations 一一对应。
 */
function toOperationId(parsed: EvolclawSendCommand): string {
  return `ec.${parsed.scope}.${parsed.action}`;
}

/**
 * 根据 ec 命令的 scope 与调用上下文推导 CommandScope。
 * - ctl：控制通道操作 → 'control'
 * - msg/group：在关系（relation）中执行；若无法确定 self/peer 上下文则退化为 'agent'
 */
function resolveCommandScope(
  parsed: EvolclawSendCommand,
  ctx: EcCommandAuthorizationContext
): CommandScope {
  if (parsed.scope === 'ctl') return 'control';
  return ctx.selfAid ? 'relation' : 'agent';
}

/**
 * 解析一条 Bash command 字符串是否是 ec 命令，返回对应的 operation id。
 * 非 ec 命令、或无法识别的 ec 子命令（如 ctl status/queue）返回 null——
 * 调用方应回退到原有的工具层白名单/危险命令检测逻辑。
 */
export function parseEcOperationId(command: string): string | null {
  const parsed = parseEvolclawSendCommand(command);
  if (!parsed) return null;
  return toOperationId(parsed);
}

/**
 * 对一条 Bash command 字符串做 ec 命令鉴权。
 *
 * 返回 null 表示这不是一条可识别的 ec send/file 命令，调用方应继续走原有逻辑
 * （工具层白名单 / 危险命令检测），不代表允许或拒绝。
 *
 * 返回非 null 时即为最终鉴权结果，调用方应据此直接放行或拒绝，不应再叠加其他判断
 * （ec 命令已被专门归类为 ec.* operation，不应被 sudo/rm -rf 等通用危险模式误伤）。
 */
export function authorizeEcCommand(
  command: string,
  ctx: EcCommandAuthorizationContext
): CommandAuthorizationDecision | null {
  const parsed = parseEvolclawSendCommand(command);
  if (!parsed) return null;

  const operation = toOperationId(parsed);
  const scope = resolveCommandScope(parsed, ctx);

  const decision = authorizeCommand({
    ...ctx,
    source: 'agent-tool',
    intent: {
      operation,
      scope,
      source: 'agent-tool',
      args: {
        command,
        ...(parsed.targetId ? { peer: parsed.targetId, targetId: parsed.targetId } : {}),
      },
    },
  });

  void auditCommandAuthorization({
    ts: Date.now(),
    source: 'agent-tool',
    operation,
    scope,
    dangerous: false,
    actorId: ctx.actorId,
    selfAid: ctx.selfAid,
    peerKey: ctx.peerKey,
    channel: ctx.channel,
    channelId: ctx.channelId,
    role: ctx.role,
    isDaemonOwner: ctx.isDaemonOwner,
    fromControlChannel: ctx.fromControlChannel,
    decision: decision.allow ? 'allow' : 'deny',
    code: decision.allow ? undefined : decision.code,
    reason: decision.allow ? undefined : decision.reason,
    matchedRule: decision.matchedRule,
    argvHash: hashArgv(command.trim().split(/\s+/)),
  });

  return decision;
}

import type { CommandAuthorizationAuditEvent } from '../../types.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

export async function auditCommandAuthorization(
  event: CommandAuthorizationAuditEvent
): Promise<void> {
  const shouldAudit =
    event.source === 'menu.cli' ||
    event.decision === 'deny' ||
    (event.decision === 'allow' && event.dangerous) ||
    (event.source === 'agent-tool' && event.operation.startsWith('config.')) ||
    event.operation.startsWith('role.') ||
    event.operation === 'cli.exec.raw';

  if (!shouldAudit) return;

  const auditRecord = buildAuditRecord(event);
  logAuditEvent(auditRecord);
}

function buildAuditRecord(event: CommandAuthorizationAuditEvent): AuditRecord {
  return {
    ts: event.ts,
    source: event.source,
    operation: event.operation,
    scope: event.scope,
    dangerous: event.dangerous,
    actorId: redactIdentifier(event.actorId),
    selfAid: redactIdentifier(event.selfAid),
    peerKey: redactIdentifier(event.peerKey),
    channel: event.channel,
    channelId: redactIdentifier(event.channelId),
    role: event.role,
    isDaemonOwner: event.isDaemonOwner,
    fromControlChannel: event.fromControlChannel,
    taskId: event.taskId,
    messageId: event.messageId,
    decision: event.decision,
    code: event.code,
    reason: event.reason,
    matchedRule: event.matchedRule,
    argvHash: event.argvHash,
    argsSummary: event.argsSummary,
    durationMs: event.durationMs,
    exitCode: event.exitCode,
  };
}

function redactIdentifier(value?: string): string | undefined {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function logAuditEvent(record: AuditRecord): void {
  const level = record.decision === 'deny' ? 'warn' : 'info';
  const marker = record.decision === 'deny' ? 'DENY' : record.dangerous ? 'DANGEROUS_ALLOW' : 'ALLOW';
  const message = [
    `[CommandAudit:${marker}]`,
    `operation=${record.operation}`,
    `role=${record.role}`,
    `actor=${record.actorId || 'unknown'}`,
    record.taskId ? `task=${record.taskId}` : null,
    record.messageId ? `message=${record.messageId}` : null,
    record.code ? `code=${record.code}` : null,
    record.matchedRule ? `rule=${record.matchedRule}` : null,
    record.dangerous ? 'dangerous=true' : null,
  ]
    .filter(Boolean)
    .join(' ');

  logger[level](message);
  if (record.reason) logger[level](`  reason: ${record.reason}`);
  if (record.argvHash) logger[level](`  argvHash: ${record.argvHash}`);
}

export function hashArgv(argv: string[]): string {
  const joined = argv.join(' ');
  return crypto.createHash('sha256').update(joined).digest('hex').slice(0, 16);
}

interface AuditRecord {
  ts: number;
  source: string;
  operation: string;
  scope: string;
  dangerous: boolean;
  actorId?: string;
  selfAid?: string;
  peerKey?: string;
  channel?: string;
  channelId?: string;
  role: string;
  isDaemonOwner?: boolean;
  fromControlChannel?: boolean;
  taskId?: string;
  messageId?: string;
  decision: 'allow' | 'deny';
  code?: string;
  reason?: string;
  matchedRule?: string;
  argvHash?: string;
  argsSummary?: Record<string, unknown>;
  durationMs?: number;
  exitCode?: number;
}

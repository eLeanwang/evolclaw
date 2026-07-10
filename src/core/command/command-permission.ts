import type {
  CommandAuthorizationContext,
  CommandAuthorizationDecision,
  CommandPermission,
  CommandPermissionConstraints,
  CommandScope,
  FieldPermission,
  OperationCategory,
} from '../../types.js';
import { getRoleDefinition } from '../../config/roles.js';
import { isManagementRole } from '../../config/builtin-roles.js';
import {
  isCriticalAgentControlField,
  resolveRoleFieldPermission,
} from '../../config/config-field-policy.js';
import type { ResolvedConfigOp } from '../../config/resolved-config-op.js';
import { normalizePeer } from '../model/config-scope.js';
import { getOperationMeta } from './operation-registry.js';
import { formatPeerKey, parsePeerKey } from '../relation/peer-identity.js';

interface MatchResult {
  permission: CommandPermission;
  matchedRule: string;
  rank: number;
}

interface ConstraintCheckResult {
  ok: boolean;
  reason?: string;
}

export const USER_PLANE_CAPABILITY_CEILING = {
  allowOperations: new Set<string>([
    'model.list',
    'model.current',
    'model.use',
    'model.effort',
    'model.reset',
    'permission.current',
    'permission.answer',
    'chatmode.current',
    'chatmode.update',
    'dispatch.current',
    'session.list',
    'session.create',
    'session.rename',
    'trigger.list',
    'stats.summary',
    'stats.session',
    'stats.context',
    'file.list',
    'file.fetch',
    'ec.msg.send',
    'ec.msg.file',
    'ec.group.send',
    'ec.group.file',
    'config.get',
    'config.set',
    'config.unset',
  ]),
  denyOperations: new Set<string>([
    'role.assign',
    'role.revoke',
    'config.write',
    'gateway.write',
    'cli.exec.raw',
    'shell.exec',
    'rce.exec',
  ]),
  denyNamespaces: new Set<string>([
    'role',
    'agent',
    'system',
    'storage',
    'aid',
  ]),
  allowCategories: new Set<OperationCategory>(['read', 'write-own']),
  denyCategories: new Set<OperationCategory>(['write-agent', 'process', 'dangerous']),
};

export function authorizeCommand(
  ctx: CommandAuthorizationContext
): CommandAuthorizationDecision {
  return authorizeCommandInternal(ctx);
}

export function authorizeResolvedConfigOperation(
  op: ResolvedConfigOp,
  context: Omit<CommandAuthorizationContext, 'intent'>,
): CommandAuthorizationDecision {
  return authorizeCommandInternal({ ...context, intent: intentForResolvedConfig(op, context.source) }, op);
}

function authorizeCommandInternal(
  ctx: CommandAuthorizationContext,
  resolvedConfigOp?: ResolvedConfigOp,
): CommandAuthorizationDecision {
  const { intent, role } = ctx;
  const operation = intent.operation;
  const opMeta = getOperationMeta(operation);

  if (!opMeta) {
    return denyDecision(ctx, 'NOT_ALLOWED', `Unknown operation: ${operation}`, operation, intent.scope);
  }

  if (isFieldConfigOperation(operation) && !resolvedConfigOp) {
    return denyDecision(ctx, 'NOT_ALLOWED', 'Resolved config operation is required', operation, intent.scope, opMeta.dangerous);
  }
  if (resolvedConfigOp
    && (resolvedConfigOp.operationId !== operation || resolvedConfigOp.commandScope !== intent.scope)) {
    return denyDecision(ctx, 'NOT_ALLOWED', 'Resolved config operation does not match the command intent', operation, intent.scope, opMeta.dangerous);
  }

  if (ctx.chatType === 'group'
    && isConfigMutationOperation(operation)
    && intent.scope !== 'relation') {
    return denyDecision(
      ctx,
      'SCOPE_MISMATCH',
      'Group chats may only modify relation-scoped config',
      operation,
      intent.scope,
      opMeta.dangerous,
    );
  }

  if (opMeta.sources && !opMeta.sources.includes(ctx.source)) {
    return denyDecision(
      ctx,
      'NOT_ALLOWED',
      `Operation ${operation} is not available from source ${ctx.source}`,
      operation,
      intent.scope,
      opMeta.dangerous
    );
  }

  const roleDef = getRoleDefinition(role, ctx.selfAid);
  if (!roleDef) {
    return denyDecision(ctx, 'ROLE_ACCESS_DENIED', `Unknown role: ${role}`, operation, intent.scope, opMeta.dangerous);
  }

  if (roleDef.allowAccess === false) {
    return denyDecision(ctx, 'ROLE_ACCESS_DENIED', `Role ${role} is not allowed to access commands`, operation, intent.scope, opMeta.dangerous);
  }

  if (!isManagementRole(role) && !isUserPlaneOperationAllowed(operation, opMeta.category, opMeta.dangerous)) {
    return denyDecision(ctx, 'NOT_ALLOWED', `Operation ${operation} is outside the user permission plane`, operation, intent.scope, opMeta.dangerous);
  }

  if (!isManagementRole(role) && isFieldConfigOperation(operation)) {
    if (intent.scope !== 'relation') {
      return denyDecision(
        ctx,
        'SCOPE_MISMATCH',
        `Role ${role} may only access relation-scoped config`,
        operation,
        intent.scope,
        opMeta.dangerous,
      );
    }
    const relationCheck = checkCurrentRelation(ctx, resolvedConfigOp);
    if (!relationCheck.ok) {
      return denyDecision(
        ctx,
        'ARGUMENT_MISMATCH',
        relationCheck.reason || 'Config target is not the current relation',
        operation,
        intent.scope,
        opMeta.dangerous,
      );
    }
  }

  if (operation === 'config.write'
    && (intent.scope === 'agent' || intent.scope === 'relation')
    && (resolvedConfigOp
      ? isCriticalAgentControlField(resolvedConfigOp.field)
      : configKeysFromArgs(intent.args).some(isCriticalAgentControlField))
    && role !== 'owner') {
    return denyDecision(
      ctx,
      'NOT_ALLOWED',
      'Critical agent identity and role fields require owner permission',
      operation,
      intent.scope,
      opMeta.dangerous,
    );
  }

  const matchResult = matchCommandPermission(
    operation,
    opMeta.category,
    roleDef.commandPermissions || {},
    opMeta.dangerous
  );

  if (!matchResult) {
    return denyDecision(ctx, 'NO_PERMISSION', `Role ${role} has no permission for ${operation}`, operation, intent.scope, opMeta.dangerous);
  }

  const { permission, matchedRule } = matchResult;
  if (!permission.allow) {
    return denyDecision(
      ctx,
      'NOT_ALLOWED',
      permission.reason || `Role ${role} explicitly denies ${operation}`,
      operation,
      intent.scope,
      opMeta.dangerous,
      matchedRule
    );
  }

  if (!isManagementRole(role)
    && isFieldConfigOperation(operation)
    && matchedRule !== operation
    && matchedRule !== 'config.*') {
    return denyDecision(
      ctx,
      'NO_PERMISSION',
      `Role ${role} requires an explicit config permission`,
      operation,
      intent.scope,
      opMeta.dangerous,
      matchedRule,
    );
  }

  if (permission.constraints?.requireExplicitDangerousGrant && !isExplicitDangerousGrant(matchedRule, permission)) {
    return denyDecision(
      ctx,
      'DANGEROUS_NOT_GRANTED',
      `Operation ${operation} requires an explicit dangerous grant`,
      operation,
      intent.scope,
      opMeta.dangerous,
      matchedRule
    );
  }

  if (opMeta.dangerous && !isExplicitDangerousGrant(matchedRule, permission)) {
    return denyDecision(
      ctx,
      'DANGEROUS_NOT_GRANTED',
      `Dangerous operation ${operation} requires an explicit dangerous grant`,
      operation,
      intent.scope,
      opMeta.dangerous,
      matchedRule
    );
  }

  const allowedScopes = permission.scopes || opMeta.defaultScopes;
  if (!allowedScopes.includes(intent.scope)) {
    return denyDecision(
      ctx,
      'SCOPE_MISMATCH',
      `Scope ${intent.scope} is not in allowed scopes: ${allowedScopes.join(', ')}`,
      operation,
      intent.scope,
      opMeta.dangerous,
      matchedRule
    );
  }

  if (!isManagementRole(role) && isFieldConfigOperation(operation)) {
    const fieldPolicy = operation === 'config.get' ? 'behavior-read' : 'role-overridable-write';
    const fieldCheck = checkConfigFieldPolicy(ctx, fieldPolicy, resolvedConfigOp);
    if (!fieldCheck.ok) {
      return denyDecision(
        ctx,
        'ARGUMENT_MISMATCH',
        fieldCheck.reason || 'Config field is not allowed',
        operation,
        intent.scope,
        opMeta.dangerous,
        matchedRule,
      );
    }
  }

  if (permission.constraints) {
    const constraintCheck = checkConstraints(ctx, permission.constraints, resolvedConfigOp);
    if (!constraintCheck.ok) {
      return denyDecision(
        ctx,
        'ARGUMENT_MISMATCH',
        constraintCheck.reason || 'Command arguments do not satisfy permission constraints',
        operation,
        intent.scope,
        opMeta.dangerous,
        matchedRule
      );
    }
  }

  return {
    allow: true,
    operation,
    scope: intent.scope,
    role,
    dangerous: opMeta.dangerous,
    matchedRule,
    constraints: permission.constraints,
  };
}

function matchCommandPermission(
  operation: string,
  category: OperationCategory,
  commandPerms: Record<string, CommandPermission>,
  isDangerous: boolean
): MatchResult | null {
  const namespace = operation.split('.')[0];
  const matches: MatchResult[] = [];

  for (const [rule, permission] of Object.entries(commandPerms)) {
    const rank = getRuleRank(rule, permission, operation, namespace, category, isDangerous);
    if (rank > 0) {
      matches.push({ permission, matchedRule: rule, rank });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.rank - a.rank);
  return matches[0];
}

function getRuleRank(
  rule: string,
  permission: CommandPermission,
  operation: string,
  namespace: string,
  category: OperationCategory,
  isDangerous: boolean
): number {
  const denyOffset = permission.allow ? 0 : 1;
  if (rule === operation) return 1000 + denyOffset;
  if (rule === `${namespace}.*`) return 800 + denyOffset;
  if (rule.startsWith('category:') && rule.slice('category:'.length) === category) return 600 + denyOffset;
  if (rule === 'dangerous:*' && isDangerous) return 400 + denyOffset;
  if (rule === '*' && !isDangerous) return 200 + denyOffset;
  return 0;
}

function isExplicitDangerousGrant(rule: string, permission: CommandPermission): boolean {
  return permission.allow === true && permission.dangerous === true && (rule === 'dangerous:*' || !rule.includes('*') && !rule.startsWith('category:'));
}

function isUserPlaneOperationAllowed(operation: string, category: OperationCategory, dangerous: boolean): boolean {
  const namespace = operation.split('.')[0];
  if (dangerous) return false;
  if (USER_PLANE_CAPABILITY_CEILING.denyCategories.has(category)) return false;
  if (!USER_PLANE_CAPABILITY_CEILING.allowCategories.has(category)) return false;
  if (USER_PLANE_CAPABILITY_CEILING.denyOperations.has(operation)) return false;
  if (USER_PLANE_CAPABILITY_CEILING.denyNamespaces.has(namespace)) return false;
  return USER_PLANE_CAPABILITY_CEILING.allowOperations.has(operation);
}

function checkConstraints(
  ctx: CommandAuthorizationContext,
  constraints: CommandPermissionConstraints,
  resolvedConfigOp?: ResolvedConfigOp,
): ConstraintCheckResult {
  if (constraints.ownPeerOnly) {
    const peerCheck = checkOwnPeer(ctx);
    if (!peerCheck.ok) return peerCheck;
  }

  if (constraints.ownAgentOnly || constraints.targetCurrentAgentOnly) {
    const argSelf = stringArg(ctx.intent.args.self);
    if (argSelf && argSelf !== ctx.selfAid) {
      return { ok: false, reason: 'Only the current agent can be targeted' };
    }
  }

  if (constraints.requireAgentOwner && ctx.role !== 'owner') {
    return { ok: false, reason: 'This command requires agent owner permission' };
  }

  if (constraints.requireAgentAdmin && ctx.role !== 'owner' && ctx.role !== 'admin') {
    return { ok: false, reason: 'This command requires agent admin permission' };
  }

  if (constraints.privateOnly && ctx.chatType !== 'private') {
    return { ok: false, reason: 'This command is only allowed in private chats' };
  }

  if (constraints.groupOnly && ctx.chatType !== 'group') {
    return { ok: false, reason: 'This command is only allowed in group chats' };
  }

  if (constraints.requireDaemonOwner && !ctx.isDaemonOwner) {
    return { ok: false, reason: 'This command requires daemon owner permission' };
  }

  if (constraints.requireControlChannel && !ctx.fromControlChannel) {
    return { ok: false, reason: 'This command requires the control channel' };
  }

  if (constraints.forbiddenFlags) {
    for (const flag of constraints.forbiddenFlags) {
      if (ctx.intent.args[flag] !== undefined) {
        return { ok: false, reason: `Forbidden argument: --${flag}` };
      }
    }
  }

  if (constraints.allowedArgs) {
    for (const [key, allowedValues] of Object.entries(constraints.allowedArgs)) {
      const value = ctx.intent.args[key];
      if (value !== undefined && Array.isArray(allowedValues) && !allowedValues.includes(value as any)) {
        return { ok: false, reason: `Argument --${key} value ${String(value)} is not allowed` };
      }
    }
  }

  if (constraints.deniedArgs) {
    for (const [key, deniedValues] of Object.entries(constraints.deniedArgs)) {
      const value = ctx.intent.args[key];
      if (value !== undefined && Array.isArray(deniedValues) && deniedValues.includes(value as any)) {
        return { ok: false, reason: `Argument --${key} value ${String(value)} is denied` };
      }
    }
  }

  if (constraints.allowedConfigKeys) {
    const keyCheck = checkAllowedConfigKeys(ctx, constraints.allowedConfigKeys);
    if (!keyCheck.ok) return keyCheck;
  }

  if (constraints.allowedPrefixes) {
    const prefixCheck = checkAllowedPrefixes(ctx, constraints.allowedPrefixes);
    if (!prefixCheck.ok) return prefixCheck;
  }

  if (constraints.requireFieldOverride) {
    const fieldCheck = checkFieldOverride(ctx, constraints.requireFieldOverride);
    if (!fieldCheck.ok) return fieldCheck;
  }

  if (constraints.configFieldPolicy) {
    const fieldCheck = checkConfigFieldPolicy(ctx, constraints.configFieldPolicy, resolvedConfigOp);
    if (!fieldCheck.ok) return fieldCheck;
  }

  if (constraints.currentRelationOnly) {
    const relationCheck = checkCurrentRelation(ctx, resolvedConfigOp);
    if (!relationCheck.ok) return relationCheck;
  }

  return { ok: true };
}

function isFieldConfigOperation(operation: string): boolean {
  return operation === 'config.get' || operation === 'config.set' || operation === 'config.unset';
}

function isConfigMutationOperation(operation: string): boolean {
  return operation === 'config.set' || operation === 'config.unset' || operation === 'config.write';
}

function checkConfigFieldPolicy(
  ctx: CommandAuthorizationContext,
  policy: 'behavior-read' | 'role-overridable-write',
  resolvedConfigOp?: ResolvedConfigOp,
): ConstraintCheckResult {
  if (!resolvedConfigOp) return { ok: false, reason: 'Resolved config operation is required' };
  const field = resolvedConfigOp.field;
  if (!resolvedConfigOp.route || (resolvedConfigOp.fieldRule.class !== 'safe-scalar' && resolvedConfigOp.fieldRule.class !== 'safe-readonly-object')) {
    return { ok: false, reason: `Config field ${field} is not available to user roles` };
  }

  const roleDef = getRoleDefinition(ctx.role, ctx.selfAid);
  const fieldPermission = roleDef
    ? resolveRoleFieldPermission(roleDef.permissions || {}, field)
    : undefined;
  if (!fieldPermission) {
    return { ok: false, reason: `Role ${ctx.role} has no field permission for ${field}` };
  }
  if (policy === 'behavior-read') return { ok: true };
  if (!fieldPermission.allowOverride) {
    return { ok: false, reason: `Role ${ctx.role} cannot override ${field}` };
  }

  if (ctx.intent.operation === 'config.set') {
    return checkFieldValueAllowed(fieldPermission, resolvedConfigOp.value);
  }
  return { ok: true };
}

function checkCurrentRelation(ctx: CommandAuthorizationContext, resolvedConfigOp?: ResolvedConfigOp): ConstraintCheckResult {
  const requestedSelf = resolvedConfigOp?.self ?? stringArg(ctx.intent.args.self);
  if (!ctx.selfAid || !requestedSelf || requestedSelf !== ctx.selfAid) {
    return { ok: false, reason: 'Only the current agent relation can be targeted' };
  }

  const requestedPeer = resolvedConfigOp?.peerKey || stringArg(ctx.intent.args.peerKey) || stringArg(ctx.intent.args.peer);
  if (!ctx.peerKey || !requestedPeer) {
    return { ok: false, reason: 'Current relation context is required' };
  }

  try {
    if (normalizeRelationPeer(requestedPeer) !== normalizeRelationPeer(ctx.peerKey)) {
      return { ok: false, reason: 'Only the current relation can be targeted' };
    }
  } catch {
    return { ok: false, reason: 'Cannot verify the current relation target' };
  }
  return { ok: true };
}

function intentForResolvedConfig(op: ResolvedConfigOp, source: CommandAuthorizationContext['source']): CommandAuthorizationContext['intent'] {
  const dangerous = op.operationId === 'config.read' || op.operationId === 'config.write';
  return {
    operation: op.operationId,
    scope: op.commandScope,
    source,
    args: {
      field: op.field,
      ...(op.subcommand === 'set' ? { value: op.value } : {}),
      configScope: op.configScope,
      ...(op.self ? { self: op.self } : {}),
      ...(op.peerKey ? { peer: op.peerKey, peerKey: op.peerKey } : {}),
    },
    rawArgv: op.canonicalArgv,
    ...(dangerous ? { dangerous: true } : {}),
  };
}

function normalizeRelationPeer(peer: string): string {
  const legacyIndex = peer.indexOf('::');
  if (legacyIndex > 0) {
    return formatPeerKey(peer.slice(0, legacyIndex), peer.slice(legacyIndex + 2));
  }
  return normalizePeer(peer);
}

function checkAllowedConfigKeys(
  ctx: CommandAuthorizationContext,
  allowedConfigKeys: string[]
): ConstraintCheckResult {
  if (allowedConfigKeys.length === 0) return { ok: true };
  for (const key of configKeysFromArgs(ctx.intent.args)) {
    if (!allowedConfigKeys.includes(key)) {
      return { ok: false, reason: `Config key ${key} is not allowed` };
    }
  }
  return { ok: true };
}

function checkAllowedPrefixes(
  ctx: CommandAuthorizationContext,
  allowedPrefixes: string[]
): ConstraintCheckResult {
  if (allowedPrefixes.length === 0) return { ok: true };
  for (const value of prefixedValuesFromArgs(ctx.intent.args)) {
    if (!allowedPrefixes.some(prefix => value.startsWith(prefix))) {
      return { ok: false, reason: `Value ${value} does not match an allowed prefix` };
    }
  }
  return { ok: true };
}

function configKeysFromArgs(args: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const name of ['key', 'field', 'fieldPath', 'path', 'name', 'configKey']) {
    collectStringValues(args[name], keys);
  }
  for (const name of ['keys', 'fields', 'fieldPaths', 'paths', 'configKeys']) {
    collectStringValues(args[name], keys);
  }
  return [...keys];
}

function prefixedValuesFromArgs(args: Record<string, unknown>): string[] {
  const values = new Set<string>();
  for (const name of ['path', 'cwd', 'file', 'filePath', 'target', 'targetPath', 'prefix']) {
    collectStringValues(args[name], values);
  }
  for (const name of ['paths', 'files', 'filePaths', 'targets', 'targetPaths']) {
    collectStringValues(args[name], values);
  }
  return [...values];
}

function collectStringValues(value: unknown, out: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) {
    out.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.add(item);
  }
}

function checkOwnPeer(ctx: CommandAuthorizationContext): ConstraintCheckResult {
  const argPeer = stringArg(ctx.intent.args.peer);
  const argPeerKey = stringArg(ctx.intent.args.peerKey);
  const expectedPeerKey = ctx.peerKey || inferPeerKey(ctx);

  if (!argPeer && !argPeerKey) return { ok: true };

  const requestedPeerId = argPeer ? peerIdFromArg(argPeer) : undefined;
  const requestedPeerKeyId = argPeerKey ? peerIdFromArg(argPeerKey) : undefined;
  if (ctx.actorId) {
    if (requestedPeerId && requestedPeerId !== ctx.actorId) {
      return { ok: false, reason: 'Only the actor peer can be targeted' };
    }
    if (requestedPeerKeyId && requestedPeerKeyId !== ctx.actorId) {
      return { ok: false, reason: 'Only the actor peer can be targeted' };
    }
  }

  if (!expectedPeerKey) return { ok: false, reason: 'Cannot verify peer ownership' };

  const candidateKeys = new Set<string>();
  if (argPeerKey) candidateKeys.add(argPeerKey);
  if (argPeer) {
    candidateKeys.add(argPeer);
    const channelType = parseChannelType(expectedPeerKey);
    if (channelType) candidateKeys.add(formatPeerKey(channelType, argPeer));
    const legacyChannelType = parseLegacyChannelType(expectedPeerKey);
    if (legacyChannelType) candidateKeys.add(`${legacyChannelType}::${argPeer}`);
  }

  if (!candidateKeys.has(expectedPeerKey)) {
    return { ok: false, reason: 'Only the actor peer can be targeted' };
  }

  return { ok: true };
}

function peerIdFromArg(value: string): string {
  try {
    return parsePeerKey(value).channelId;
  } catch {
    const legacyIdx = value.indexOf('::');
    if (legacyIdx > 0) return value.slice(legacyIdx + 2);
    return value;
  }
}

function inferPeerKey(ctx: CommandAuthorizationContext): string | undefined {
  const actorId = ctx.actorId;
  const argPeer = stringArg(ctx.intent.args.peer);
  if (!actorId || !argPeer || argPeer !== actorId) return undefined;
  const channelType = typeof ctx.channel === 'string' ? ctx.channel.split('#')[0] : undefined;
  return channelType ? formatPeerKey(channelType, actorId) : undefined;
}

function parseChannelType(peerKey: string): string | undefined {
  try {
    return parsePeerKey(peerKey).channelType;
  } catch {
    return undefined;
  }
}

function parseLegacyChannelType(peerKey: string): string | undefined {
  const idx = peerKey.indexOf('::');
  return idx > 0 ? peerKey.slice(0, idx) : undefined;
}

function checkFieldOverride(ctx: CommandAuthorizationContext, field: string): ConstraintCheckResult {
  const roleDef = getRoleDefinition(ctx.role, ctx.selfAid);
  const fieldPermission = roleDef?.permissions?.[field];
  if (!fieldPermission) {
    return { ok: false, reason: `Role ${ctx.role} has no field permission for ${field}` };
  }
  if (!fieldPermission.allowOverride) {
    return { ok: false, reason: `Role ${ctx.role} cannot override ${field}` };
  }

  const value = valueForFieldOverride(ctx, field);
  if (value === undefined) return { ok: true };
  return checkFieldValueAllowed(fieldPermission, value);
}

function valueForFieldOverride(ctx: CommandAuthorizationContext, field: string): unknown {
  if (field.endsWith('.model')) return ctx.intent.args.model ?? ctx.intent.args.value;
  if (field.endsWith('.effort')) return ctx.intent.args.effort ?? ctx.intent.args.value;
  return ctx.intent.args.value ?? ctx.intent.args[field];
}

function checkFieldValueAllowed(permission: FieldPermission, value: unknown): ConstraintCheckResult {
  if (permission.allowedModels && typeof value === 'string') {
    const allowed = permission.allowedModels.some(pattern => globMatches(pattern, value));
    if (!allowed) return { ok: false, reason: `Model ${value} is not allowed for this role` };
  }

  if (permission.allowedValues && permission.allowedValues.length > 0) {
    if (!permission.allowedValues.includes(value as any)) {
      return { ok: false, reason: `Value ${String(value)} is not allowed for this role` };
    }
  }

  return { ok: true };
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function denyDecision(
  ctx: CommandAuthorizationContext,
  code: 'NO_PERMISSION' | 'NOT_ALLOWED' | 'SCOPE_MISMATCH' | 'ARGUMENT_MISMATCH' | 'DANGEROUS_NOT_GRANTED' | 'ROLE_ACCESS_DENIED',
  reason: string,
  operation: string,
  scope?: CommandScope,
  dangerous?: boolean,
  matchedRule?: string
): CommandAuthorizationDecision {
  return {
    allow: false,
    code,
    reason,
    operation,
    scope,
    role: ctx.role,
    dangerous,
    matchedRule,
  };
}

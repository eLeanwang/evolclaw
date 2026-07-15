import type { FieldPermission } from '../types.js';

export type ConfigFieldClass = 'safe-scalar' | 'safe-readonly-object' | 'sensitive' | 'unknown';

export interface ConfigFieldRule {
  class: ConfigFieldClass;
  rolePermissionKey?: string;
  valueKind?:
    | 'string'
    | 'baseagent'
    | 'boolean'
    | 'nonnegative-number'
    | 'positive-number'
    | 'effort'
    | 'chatmode'
    | 'dispatch'
    | 'show-activities'
    | 'permission-mode'
    | 'approvals-reviewer'
    | 'gemini-mode'
    | 'manifest-file'
    | 'session-renew-action';
}

export type ConfigFieldValueResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

const BEHAVIOR_TOP_FIELDS = new Set([
  'active_baseagent',
  'chatmode',
  'response_modes',
  'responseMode',
  'config',
  'flush_delay',
  'debounce',
  'dispatch',
  'show_activities',
  'proactive',
  'session_renew',
  'group_venue_sync',
  'render',
  'sessionManifests',
  'enable_rich_content',
  'permissionMode',
]);

const BASEAGENT_BEHAVIOR_FIELDS = new Set([
  'model',
  'effort',
  'reasoning',
  'agentProgressSummaries',
  'excludeDynamicSections',
  'enableRequestUserInput',
  'approvalsReviewer',
  'mode',
  'useVertex',
]);

const SUPPORTED_BASEAGENTS = new Set(['claude', 'codex', 'gemini', 'hermes']);
const SENSITIVE_TOP_FIELDS = new Set([
  '$schema_version',
  'aid',
  'enabled',
  'lifecycle',
  'initialized',
  'owners',
  'admins',
  'channels',
  'aun',
  'models',
  'projects',
  'capabilities',
  'debug',
  'observable',
  'roles',
  'extra_backup',
]);
const CRITICAL_AGENT_FIELDS = new Set(['owners', 'admins', 'roles']);

const PERMISSION_MODES = new Set(['readonly', 'auto', 'request', 'bypass']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function scalar(rolePermissionKey: string, valueKind: ConfigFieldRule['valueKind']): ConfigFieldRule {
  return { class: 'safe-scalar', rolePermissionKey, valueKind };
}

function readonlyObject(rolePermissionKey: string): ConfigFieldRule {
  return { class: 'safe-readonly-object', rolePermissionKey };
}

export function isBehaviorConfigFieldPath(fieldPath: string): boolean {
  const parts = fieldPath.split('.');
  if (parts[0] === 'baseagents') {
    return parts.length >= 3 && BASEAGENT_BEHAVIOR_FIELDS.has(parts[2]);
  }
  return BEHAVIOR_TOP_FIELDS.has(parts[0]);
}

export function resolveConfigFieldRule(fieldPath: string): ConfigFieldRule {
  const field = fieldPath.trim();
  if (!field) return { class: 'unknown' };
  const parts = field.split('.');
  const top = parts[0];

  if (SENSITIVE_TOP_FIELDS.has(top)) return { class: 'sensitive' };

  if (top === 'baseagents') {
    if (parts.length < 3) return { class: 'sensitive' };
    const [, baseagent, leaf] = parts;
    if (!SUPPORTED_BASEAGENTS.has(baseagent)) return { class: 'unknown' };
    const permissionKey = `baseagents.${baseagent}.${leaf}`;

    if (leaf === 'model' && parts.length === 3) return scalar(permissionKey, 'string');
    if ((leaf === 'effort' || leaf === 'reasoning') && parts.length === 3) return scalar(permissionKey, 'effort');
    if (baseagent === 'claude' && (leaf === 'agentProgressSummaries' || leaf === 'excludeDynamicSections') && parts.length === 3) {
      return scalar(permissionKey, 'boolean');
    }
    if (baseagent === 'codex' && leaf === 'enableRequestUserInput' && parts.length === 3) {
      return scalar(permissionKey, 'boolean');
    }
    if (baseagent === 'codex' && leaf === 'approvalsReviewer' && parts.length === 3) {
      return scalar(permissionKey, 'approvals-reviewer');
    }
    if (baseagent === 'gemini' && leaf === 'mode' && parts.length === 3) return scalar(permissionKey, 'gemini-mode');
    if (baseagent === 'gemini' && leaf === 'useVertex' && parts.length === 3) return scalar(permissionKey, 'boolean');

    return { class: 'sensitive' };
  }

  if (field === 'active_baseagent') return scalar(field, 'baseagent');
  if (field === 'flush_delay' || field === 'debounce') return scalar(field, 'nonnegative-number');
  if (field === 'dispatch') return scalar(field, 'dispatch');
  if (field === 'show_activities') return scalar(field, 'show-activities');
  if (field === 'enable_rich_content') return scalar(field, 'boolean');
  if (field === 'permissionMode') return scalar(field, 'permission-mode');
  if (field === 'responseMode') return scalar(field, 'string');

  if (top === 'chatmode') {
    if (parts.length === 1) return readonlyObject('chatmode');
    if (parts.length === 2 && ['private', 'group', 'nothuman'].includes(parts[1])) {
      return scalar('chatmode', 'chatmode');
    }
    return { class: 'unknown' };
  }

  if (top === 'response_modes') {
    if (parts.length === 1) return readonlyObject('response_modes');
    if (parts.length === 2 && (parts[1] === 'configs' || parts[1] === 'overrides')) return readonlyObject('response_modes');
    if (parts.length === 2 && (parts[1] === 'default_private' || parts[1] === 'default_group')) {
      return scalar('response_modes', 'string');
    }
    return { class: 'unknown' };
  }

  if (top === 'config') {
    if (parts.length === 1) return readonlyObject('config');
    if (parts.length === 2 && parts[1] === 'auxiliaryModel') return scalar('config', 'string');
    return { class: 'unknown' };
  }

  if (top === 'proactive') {
    if (parts.length === 1) return readonlyObject('proactive');
    if (parts.length === 2 && (parts[1] === 'pre_tool_1stmsgchk' || parts[1] === 'tool_use_reminder')) {
      return scalar('proactive', 'boolean');
    }
    return { class: 'unknown' };
  }

  if (top === 'session_renew') {
    if (parts.length === 1) return readonlyObject('session_renew');
    if (parts.length !== 2) return { class: 'unknown' };
    if (parts[1] === 'enabled') return scalar('session_renew', 'boolean');
    if (parts[1] === 'after_hours') return scalar('session_renew', 'positive-number');
    if (parts[1] === 'model') return scalar('session_renew', 'string');
    if (parts[1] === 'effort') return scalar('session_renew', 'effort');
    if (parts[1] === 'fallback_action') return scalar('session_renew', 'session-renew-action');
    return { class: 'unknown' };
  }

  if (top === 'render') {
    if (parts.length === 1) return readonlyObject('render');
    if (parts.length === 2 && ['private', 'group', 'inject'].includes(parts[1])) return scalar('render', 'string');
    return { class: 'unknown' };
  }

  if (top === 'sessionManifests') {
    if (parts.length === 1) return readonlyObject('sessionManifests');
    if (parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(parts[1])) return scalar('sessionManifests', 'manifest-file');
    return { class: 'unknown' };
  }

  if (top === 'group_venue_sync') return parts.length === 1
    ? readonlyObject('group_venue_sync')
    : { class: 'unknown' };

  return { class: 'unknown' };
}

export function isSafeBehaviorConfigField(fieldPath: string): boolean {
  const rule = resolveConfigFieldRule(fieldPath);
  return rule.class === 'safe-scalar' || rule.class === 'safe-readonly-object';
}

export function isCriticalAgentControlField(fieldPath: string): boolean {
  return CRITICAL_AGENT_FIELDS.has(fieldPath.split('.')[0]);
}

export function resolveRoleFieldPermission(
  permissions: Record<string, FieldPermission>,
  fieldPath: string,
): FieldPermission | undefined {
  const rule = resolveConfigFieldRule(fieldPath);
  if (!rule.rolePermissionKey) return undefined;
  return permissions[fieldPath] ?? permissions[rule.rolePermissionKey];
}

export function parseConfigFieldValue(fieldPath: string, rawValue: unknown): ConfigFieldValueResult {
  const rule = resolveConfigFieldRule(fieldPath);
  if (rule.class !== 'safe-scalar' || !rule.valueKind) {
    return { ok: false, reason: `Config field ${fieldPath} does not support scalar writes` };
  }
  if (typeof rawValue !== 'string') return { ok: false, reason: `Config field ${fieldPath} requires a string CLI value` };

  const raw = rawValue.trim();
  switch (rule.valueKind) {
    case 'string':
      return raw ? { ok: true, value: raw } : { ok: false, reason: `Config field ${fieldPath} cannot be empty` };
    case 'baseagent':
      return SUPPORTED_BASEAGENTS.has(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must name a supported baseagent` };
    case 'boolean':
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, reason: `Config field ${fieldPath} must be true or false` };
    case 'nonnegative-number': {
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0
        ? { ok: true, value }
        : { ok: false, reason: `Config field ${fieldPath} must be a non-negative number` };
    }
    case 'positive-number': {
      const value = Number(raw);
      return Number.isFinite(value) && value > 0
        ? { ok: true, value }
        : { ok: false, reason: `Config field ${fieldPath} must be a positive number` };
    }
    case 'effort':
      return EFFORTS.has(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be one of ${[...EFFORTS].join(', ')}; use unset for auto` };
    case 'chatmode':
      return raw === 'interactive' || raw === 'proactive'
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be interactive or proactive` };
    case 'dispatch':
      return raw === 'mention' || raw === 'broadcast'
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be mention or broadcast` };
    case 'show-activities':
      return raw === 'all' || raw === 'none'
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be all or none` };
    case 'permission-mode':
      return PERMISSION_MODES.has(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} has an invalid permission mode` };
    case 'approvals-reviewer':
      return ['user', 'auto_review', 'guardian_subagent'].includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} has an invalid approvals reviewer` };
    case 'gemini-mode':
      return raw === 'cli' || raw === 'sdk'
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be cli or sdk` };
    case 'manifest-file':
      return /^[A-Za-z0-9_-]+\.json$/.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be a JSON filename without path separators` };
    case 'session-renew-action':
      return raw === 'continue' || raw === 'new'
        ? { ok: true, value: raw }
        : { ok: false, reason: `Config field ${fieldPath} must be continue or new` };
  }
}

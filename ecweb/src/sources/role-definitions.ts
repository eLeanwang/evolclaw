/**
 * Role Definitions 数据源 — 管理角色定义及其权限配置
 *
 * 功能：
 * 1. 读取 roles.json 或内置角色配置
 * 2. 提供角色定义的 CRUD API
 * 3. WebSocket 推送角色配置变化
 *
 * 数据流：
 * - 读取：从 evolclaw/dist/config/roles.ts 导入 readRolesConfig
 * - 写入：保存到 .evolclaw/roles.json
 * - 推送：2秒轮询 + JSON diff
 */

import type { WatchSource } from './types.js';
import { getModelCatalogSnapshot, type ModelCatalogApiEntry } from './models.js';
import { resolveParentDistModule, toFileUrl } from './parent-package.js';
import { resolvePaths } from '../paths.js';

// 动态导入 evolclaw 主项目的角色配置模块
async function getRolesModule() {
  const rolesPath = resolveParentDistModule('config', 'roles.js');
  const cmPath = resolveParentDistModule('config', 'config-manager.js');
  const resolverPath = resolveParentDistModule('config', 'peer-role-resolver.js');

  // Windows 上需要转换为 file:// URL
  try {
    const rolesMod = await import(toFileUrl(rolesPath));
    const cmMod = await import(toFileUrl(cmPath));
    const resolverMod = await import(toFileUrl(resolverPath));

    if (!rolesMod.readRolesConfig) throw new Error('readRolesConfig not found in roles.js');
    if (!rolesMod.getBuiltinRolesConfig) throw new Error('getBuiltinRolesConfig not found in roles.js');
    if (!rolesMod.roleExists) throw new Error('roleExists not found in roles.js');
    if (!cmMod.read) throw new Error('read not found in config-manager.js');
    if (!cmMod.write) throw new Error('write not found in config-manager.js');
    if (!cmMod.ConfigTarget) throw new Error('ConfigTarget not found in config-manager.js');

    return {
      readRolesConfig: rolesMod.readRolesConfig as (selfAid?: string) => any,
      getBuiltinRolesConfig: rolesMod.getBuiltinRolesConfig as () => any,
      roleExists: rolesMod.roleExists as (role: string, selfAid?: string) => boolean,
      read: cmMod.read as (target: any, sel?: any) => any,
      write: cmMod.write as (target: any, value: any, sel?: any) => void,
      ConfigTarget: cmMod.ConfigTarget as any,
      resolver: resolverMod as any,
    };
  } catch (err) {
    console.error('[role-definitions] Failed to import roles modules:', err);
    throw err;
  }
}

async function getRoleConstraintsModule() {
  const constraintsPath = resolveParentDistModule('config', 'role-constraints.js');

  const mod = await import(toFileUrl(constraintsPath));
  if (!mod.isModelAllowedByPatterns) throw new Error('isModelAllowedByPatterns not found in role-constraints.js');
  return {
    isModelAllowedByPatterns: mod.isModelAllowedByPatterns as (model: string, allowedModels: string[]) => boolean,
  };
}

async function getOperationRegistryModule() {
  const registryPath = resolveParentDistModule('core', 'command', 'operation-registry.js');

  const mod = await import(toFileUrl(registryPath));
  if (!mod.listOperations) throw new Error('listOperations not found in operation-registry.js');
  return {
    listOperations: mod.listOperations as () => any[],
  };
}

interface RoleWriteAuth {
  localDirect?: boolean;
  actorAid?: string | null;
}

function isWriteMethod(method: string | undefined): boolean {
  return method === 'PUT' || method === 'POST' || method === 'DELETE';
}

function canManageRoleDefinitions(processConfig: any, auth: RoleWriteAuth, aid: string, resolver: any): boolean {
  if (auth.localDirect) return true;
  const actor = auth.actorAid || '';
  if (!actor) return false;
  if (Array.isArray(processConfig?.owners) && processConfig.owners.includes(actor)) return true;
  return !!aid && (
    !!resolver.isStaticAgentOwner?.(aid, actor)
    || !!resolver.isStaticAgentAdmin?.(aid, actor)
  );
}

const MODEL_PERMISSION_FIELD = 'baseagents.claude.model';
const MODEL_PATTERN_OPTIONS = ['*', 'claude-opus-*', 'claude-sonnet-*', 'claude-haiku-*'];
const COMMAND_PERMISSION_SCOPES = new Set(['relation', 'role', 'agent', 'process', 'filesystem', 'control', 'raw-cli']);
const COMMAND_CONSTRAINT_KEYS = new Set([
  'ownPeerOnly',
  'ownAgentOnly',
  'privateOnly',
  'groupOnly',
  'requireDaemonOwner',
  'requireControlChannel',
  'requireExplicitDangerousGrant',
  'requireFieldOverride',
  'allowedArgs',
  'deniedArgs',
  'forbiddenFlags',
  'allowedConfigKeys',
  'allowedPrefixes',
  'timeoutMs',
  'outputLimitBytes',
  'cwdPolicy',
  'envAllowlist',
]);
const COMMAND_BOOLEAN_CONSTRAINTS = new Set([
  'ownPeerOnly',
  'ownAgentOnly',
  'privateOnly',
  'groupOnly',
  'requireDaemonOwner',
  'requireControlChannel',
  'requireExplicitDangerousGrant',
]);
const COMMAND_STRING_ARRAY_CONSTRAINTS = new Set([
  'forbiddenFlags',
  'allowedConfigKeys',
  'allowedPrefixes',
  'envAllowlist',
]);
const COMMAND_INTEGER_CONSTRAINTS = new Set(['timeoutMs', 'outputLimitBytes']);
const ROLE_USAGE_COST_BASIS = new Set(['gateway', 'official']);
const ROLE_USAGE_SCOPES = new Set(['subject', 'role']);
const ROLE_USAGE_RESET_MODES = new Set(['never', 'daily', 'weekly', 'monthly']);
const ROLE_USAGE_CURRENCIES = new Set(['CNY', 'USD']);

type SelectionMode = 'pattern' | 'explicit' | 'mixed';

function sendJson(res: any, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function parseUrl(rawUrl: string): { path: string; query: Record<string, string> } {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return { path: rawUrl, query: {} };
  const query: Record<string, string> = {};
  for (const pair of rawUrl.slice(qIdx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return { path: rawUrl.slice(0, qIdx), query };
}

async function getAgentsFromIpc(): Promise<any[]> {
  try {
    const { ipcQuery } = await import('../ipc-client.js');
    const resp = await ipcQuery<{ ok: boolean; agents: any[] }>(
      resolvePaths().socket,
      { type: 'evolagent.list' },
      3000,
    );
    return resp?.agents ?? [];
  } catch {
    return [];
  }
}

function summarizeAgents(agents: any[]): any[] {
  return agents
    .filter(agent => agent?.aid)
    .map(agent => ({
      aid: agent.aid,
      displayName: agent.displayName ?? agent.personalName,
      name: agent.name,
    }));
}

function resolveRequestedAid(raw: unknown, agents: any[]): string | null {
  const requested = typeof raw === 'string' ? raw.trim() : '';
  if (requested) return requested;
  return agents.find(agent => agent?.aid)?.aid || null;
}

function isReservedRoleName(roleName: string): boolean {
  return roleName === 'owner' || roleName === 'admin';
}

function isValidUserRoleName(roleName: string): boolean {
  return /^[a-z0-9_-]+$/.test(roleName) && !isReservedRoleName(roleName);
}

function builtinUserRoles(modules: any): Set<string> {
  return new Set(Object.keys(modules.getBuiltinRolesConfig().roles || {}));
}

function readAgentConfig(modules: any, aid: string): any {
  return modules.read(modules.ConfigTarget.Agent, { self: aid }) || { aid, channels: [] };
}

function writeAgentConfig(modules: any, aid: string, config: any): void {
  modules.write(modules.ConfigTarget.Agent, { ...config, aid, channels: Array.isArray(config.channels) ? config.channels : [] }, { self: aid });
}

function getAgentRoleDefinitions(config: any): Record<string, any> {
  return config.roles?.definitions && typeof config.roles.definitions === 'object'
    ? config.roles.definitions
    : {};
}

function updateAgentRoles(modules: any, aid: string, updater: (roles: any, config: any) => void): any {
  const config = readAgentConfig(modules, aid);
  const roles = config.roles && typeof config.roles === 'object' ? { ...config.roles } : {};
  if (roles.definitions && typeof roles.definitions === 'object') {
    roles.definitions = { ...roles.definitions };
  }
  if (roles.defaultRoles && typeof roles.defaultRoles === 'object') {
    roles.defaultRoles = { ...roles.defaultRoles };
  }
  updater(roles, config);
  const next = { ...config, roles };
  writeAgentConfig(modules, aid, next);
  return next;
}

function normalizeDefaultRoleInput(value: unknown, current: string | null | undefined): string | null {
  if (value === null || value === '') return null;
  if (typeof value === 'string') return value;
  return current ?? null;
}

function validateRoleDefinitionName(roleName: string): string | null {
  if (!roleName || !/^[a-z0-9_-]+$/.test(roleName)) return 'Invalid role name';
  if (isReservedRoleName(roleName)) return 'owner/admin are management identities and cannot be user role definitions';
  return null;
}

function inferSelectionMode(allowedModels: string[] = []): SelectionMode {
  if (allowedModels.length === 0) return 'explicit';
  const patternCount = allowedModels.filter(m => m === '*' || m.endsWith('*')).length;
  if (patternCount === allowedModels.length) return 'pattern';
  if (patternCount === 0) return 'explicit';
  return 'mixed';
}

function normalizeStringList(value: any): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed) return null;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateScalarArrayMap(value: any, label: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const [argName, allowedValues] of Object.entries(value)) {
    if (!Array.isArray(allowedValues)) {
      errors.push(`${label}.${argName} must be an array`);
      continue;
    }
    for (const item of allowedValues) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) {
        errors.push(`${label}.${argName} entries must be string, number, or boolean`);
      }
    }
  }
}

function validateCommandPermissionConstraints(rule: string, constraints: any, errors: string[]): void {
  if (!isRecord(constraints)) {
    errors.push(`${rule}.constraints must be an object`);
    return;
  }

  for (const [key, value] of Object.entries(constraints)) {
    const label = `${rule}.constraints.${key}`;
    if (!COMMAND_CONSTRAINT_KEYS.has(key)) {
      errors.push(`${label} is not supported`);
      continue;
    }
    if (COMMAND_BOOLEAN_CONSTRAINTS.has(key) && typeof value !== 'boolean') {
      errors.push(`${label} must be a boolean`);
    } else if (key === 'requireFieldOverride' && typeof value !== 'string') {
      errors.push(`${label} must be a string`);
    } else if (COMMAND_STRING_ARRAY_CONSTRAINTS.has(key)) {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        errors.push(`${label} must be a string array`);
      }
    } else if (COMMAND_INTEGER_CONSTRAINTS.has(key)) {
      if (!Number.isInteger(value) || value < 0) errors.push(`${label} must be a non-negative integer`);
    } else if (key === 'cwdPolicy' && !['agentProject', 'evolclawHome', 'none'].includes(String(value))) {
      errors.push(`${label} must be agentProject, evolclawHome, or none`);
    } else if (key === 'allowedArgs' || key === 'deniedArgs') {
      validateScalarArrayMap(value, label, errors);
    }
  }
}

function validateCommandPermissions(value: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined) return { ok: true, errors };
  if (!isRecord(value)) {
    return { ok: false, errors: ['commandPermissions must be an object'] };
  }

  for (const [rule, permission] of Object.entries(value)) {
    if (!isRecord(permission)) {
      errors.push(`${rule} must be an object`);
      continue;
    }

    if (typeof permission.allow !== 'boolean') {
      errors.push(`${rule}.allow must be a boolean`);
    }
    if (permission.dangerous !== undefined && typeof permission.dangerous !== 'boolean') {
      errors.push(`${rule}.dangerous must be a boolean`);
    }
    if (permission.reason !== undefined && typeof permission.reason !== 'string') {
      errors.push(`${rule}.reason must be a string`);
    }
    if (permission.scopes !== undefined) {
      if (!Array.isArray(permission.scopes)) {
        errors.push(`${rule}.scopes must be an array`);
      } else {
        for (const scope of permission.scopes) {
          if (typeof scope !== 'string' || !COMMAND_PERMISSION_SCOPES.has(scope)) {
            errors.push(`${rule}.scopes contains unsupported scope: ${String(scope)}`);
          }
        }
      }
    }
    if (permission.constraints !== undefined) {
      validateCommandPermissionConstraints(rule, permission.constraints, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateRoleUsageLimits(value: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined) return { ok: true, errors };
  if (!isRecord(value)) {
    return { ok: false, errors: ['usageLimits must be an object'] };
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    errors.push('usageLimits.enabled must be a boolean');
  }
  if (value.resetMode !== undefined && !ROLE_USAGE_RESET_MODES.has(String(value.resetMode))) {
    errors.push('usageLimits.resetMode must be never, daily, weekly, or monthly');
  }
  if (value.currency !== undefined && !ROLE_USAGE_CURRENCIES.has(String(value.currency))) {
    errors.push('usageLimits.currency must be CNY or USD');
  }
  const amount = value.limitAmount;
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      errors.push('usageLimits.limitAmount must be a non-negative number or null');
    }
  }
  if (value.costBasis !== undefined && !ROLE_USAGE_COST_BASIS.has(String(value.costBasis))) {
    errors.push('usageLimits.costBasis must be gateway or official');
  }
  if (value.scope !== undefined && !ROLE_USAGE_SCOPES.has(String(value.scope))) {
    errors.push('usageLimits.scope must be subject or role');
  }
  return { ok: errors.length === 0, errors };
}

function normalizeRoleUsageLimits(value: any): any {
  if (value === undefined) return undefined;
  const out: any = {};
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
  if (ROLE_USAGE_RESET_MODES.has(String(value.resetMode))) out.resetMode = String(value.resetMode);
  if (ROLE_USAGE_CURRENCIES.has(String(value.currency))) out.currency = String(value.currency);
  const amount = value.limitAmount;
  if (amount === null) out.limitAmount = null;
  else if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) out.limitAmount = amount;
  if (ROLE_USAGE_COST_BASIS.has(String(value.costBasis))) out.costBasis = String(value.costBasis);
  if (ROLE_USAGE_SCOPES.has(String(value.scope))) out.scope = String(value.scope);
  return out;
}

function normalizeRoleDefinitionForSave(roleDef: any): any {
  if (!isRecord(roleDef) || roleDef.usageLimits === undefined) return roleDef;
  return { ...roleDef, usageLimits: normalizeRoleUsageLimits(roleDef.usageLimits) };
}

function getModelPermission(roleDef: any): any {
  const permissions = roleDef?.permissions;
  if (!permissions || typeof permissions !== 'object') return {};
  const perm = permissions[MODEL_PERMISSION_FIELD];
  return perm && typeof perm === 'object' ? perm : {};
}

function stripSelectionModeFromPermission(perm: any): any {
  if (!perm || typeof perm !== 'object') return perm;
  const { selectionMode: _selectionMode, ...rest } = perm;
  return rest;
}

function extractModelPermissionPayload(payload: any, currentPerm: any): { defaultModel: any; allowOverride: any; allowedModels: any } {
  const source = payload?.modelPermission && typeof payload.modelPermission === 'object'
    ? payload.modelPermission
    : payload;

  return {
    defaultModel: source.defaultModel ?? source.default ?? currentPerm.default,
    allowOverride: source.allowOverride ?? currentPerm.allowOverride ?? false,
    allowedModels: source.allowedModels ?? currentPerm.allowedModels,
  };
}

async function validateModelPermissionInput(input: { defaultModel: any; allowOverride: any; allowedModels: any }): Promise<{ ok: boolean; errors: string[]; value?: { defaultModel: string; allowOverride: boolean; allowedModels: string[] } }> {
  const errors: string[] = [];
  const defaultModel = typeof input.defaultModel === 'string' ? input.defaultModel.trim() : '';
  const allowedModels = normalizeStringList(input.allowedModels);
  const allowOverride = input.allowOverride;

  if (!defaultModel) errors.push('defaultModel must be a non-empty string');
  if (typeof allowOverride !== 'boolean') errors.push('allowOverride must be a boolean');
  if (!allowedModels || allowedModels.length === 0) errors.push('allowedModels must be a non-empty string array');

  if (defaultModel && allowedModels && allowedModels.length > 0) {
    const { isModelAllowedByPatterns } = await getRoleConstraintsModule();
    if (!isModelAllowedByPatterns(defaultModel, allowedModels)) {
      errors.push('defaultModel must be allowed by allowedModels');
    }
  }

  if (errors.length > 0 || !allowedModels) {
    return { ok: false, errors };
  }

  return { ok: true, errors: [], value: { defaultModel, allowOverride, allowedModels } };
}

async function validateRoleModelPermission(roleDef: any): Promise<{ ok: boolean; errors: string[] }> {
  const permissions = roleDef?.permissions;
  if (!permissions || typeof permissions !== 'object') return { ok: true, errors: [] };

  const perm = permissions[MODEL_PERMISSION_FIELD];
  if (!perm || typeof perm !== 'object') return { ok: true, errors: [] };
  permissions[MODEL_PERMISSION_FIELD] = stripSelectionModeFromPermission(perm);

  const result = await validateModelPermissionInput({
    defaultModel: permissions[MODEL_PERMISSION_FIELD].default,
    allowOverride: permissions[MODEL_PERMISSION_FIELD].allowOverride,
    allowedModels: permissions[MODEL_PERMISSION_FIELD].allowedModels,
  });
  return { ok: result.ok, errors: result.errors };
}

async function filterAllowedCatalogModels(models: ModelCatalogApiEntry[], allowedModels: string[]): Promise<ModelCatalogApiEntry[]> {
  const { isModelAllowedByPatterns } = await getRoleConstraintsModule();
  return models.filter(model => !model.isAlias && isModelAllowedByPatterns(model.id, allowedModels));
}

async function buildModelPermissionResponse(roleName: string, roleDef: any, override?: { defaultModel: string; allowOverride: boolean; allowedModels: string[] }): Promise<any> {
  const currentPerm = getModelPermission(roleDef);
  const defaultModel = override?.defaultModel ?? currentPerm.default ?? '';
  const allowOverride = override?.allowOverride ?? currentPerm.allowOverride ?? false;
  const allowedModels = override?.allowedModels ?? (Array.isArray(currentPerm.allowedModels) ? currentPerm.allowedModels : []);
  const catalog = await getModelCatalogSnapshot('claude');
  const matchingModels = await filterAllowedCatalogModels(catalog.models, allowedModels);

  return {
    role: roleName,
    field: MODEL_PERMISSION_FIELD,
    permission: {
      default: defaultModel,
      allowOverride,
      allowedModels,
    },
    selectionMode: inferSelectionMode(allowedModels),
    patternOptions: MODEL_PATTERN_OPTIONS,
    catalog,
    matchingModels,
    stats: {
      catalogTotal: catalog.models.filter(model => !model.isAlias).length,
      matchedTotal: matchingModels.length,
    }
  };
}

async function buildSnapshot(params: Record<string, any> = {}): Promise<any> {
  try {
    const modules = await getRolesModule();
    const agents = await getAgentsFromIpc();
    const aid = resolveRequestedAid(params.aid, agents);
    const config = modules.readRolesConfig(aid || undefined);
    return {
      ...config,
      aid,
      agents: summarizeAgents(agents),
    };
  } catch (err) {
    console.error('[role-definitions] Failed to build snapshot:', err);
    return { $schema_version: 1, aid: null, agents: [], roles: {}, error: String(err) };
  }
}

export const roleDefinitionsSource: WatchSource = {
  kind: 'roleDefinitions',

  async snapshot(params: Record<string, any> = {}): Promise<any> {
    return buildSnapshot(params);
  },

  subscribe(_params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await buildSnapshot(_params);
        const json = JSON.stringify(snap);
        if (json !== lastJson) {
          lastJson = json;
          push(snap);
        }
      } catch (err) {
        console.error('[role-definitions] Polling error:', err);
      }
    };

    // 立即执行一次
    tick();

    const timer = setInterval(tick, 2000); // 2秒轮询
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
};

// HTTP API handler
export async function handleRoleDefinitionsApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const modules = await getRolesModule();
    const { readRolesConfig, getBuiltinRolesConfig, read, ConfigTarget } = modules;
    const parsedUrl = parseUrl(req.url || '');
    const urlPath = parsedUrl.path;
    const agents = await getAgentsFromIpc();
    const aid = resolveRequestedAid(parsedUrl.query.aid, agents);
    const roleRoute = urlPath.match(/^\/api\/role-definitions\/([^/]+)$/);
    const roleNestedRoute = urlPath.match(/^\/api\/role-definitions\/([^/]+)\/([^/]+)$/);
    const decodeRoleName = (raw: string) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };

    if (req.method === 'GET' && urlPath === '/api/role-definitions/operations') {
      const { listOperations } = await getOperationRegistryModule();
      sendJson(res, 200, { operations: listOperations() });
      return;
    }

    if (isWriteMethod(req.method)) {
      if (!aid) {
        sendJson(res, 400, { error: 'aid is required' });
        return;
      }
      const processConfig = read(ConfigTarget.Process) || {};
      if (!canManageRoleDefinitions(processConfig, auth, aid, modules.resolver)) {
        console.warn('[role-definitions] Write forbidden:', {
          method: req.method,
          url: req.url,
          actorAid: auth.actorAid,
          localDirect: !!auth.localDirect
        });
        sendJson(res, 403, { error: 'forbidden: agent owner/admin required' });
        return;
      }
    }

    if (req.method === 'GET' && urlPath === '/api/role-definitions') {
      sendJson(res, 200, await buildSnapshot({ aid }));
      return;
    }

    if (req.method === 'PUT' && urlPath === '/api/role-definitions') {
      try {
        const incoming = await readJsonBody(req);
        const currentConfig = readRolesConfig(aid || undefined);

        if (incoming.roles && typeof incoming.roles === 'object') {
          for (const [roleName, roleDef] of Object.entries(incoming.roles)) {
            const nameError = validateRoleDefinitionName(roleName);
            if (nameError) {
              sendJson(res, 400, { error: `${nameError}: ${roleName}` });
              return;
            }
            const validation = await validateRoleModelPermission(roleDef);
            if (!validation.ok) {
              sendJson(res, 400, { error: `Invalid model permissions for role ${roleName}`, errors: validation.errors });
              return;
            }
            const commandValidation = validateCommandPermissions((roleDef as any)?.commandPermissions);
            if (!commandValidation.ok) {
              sendJson(res, 400, { error: `Invalid command permissions for role ${roleName}`, errors: commandValidation.errors });
              return;
            }
            const usageValidation = validateRoleUsageLimits((roleDef as any)?.usageLimits);
            if (!usageValidation.ok) {
              sendJson(res, 400, { error: `Invalid usage limits for role ${roleName}`, errors: usageValidation.errors });
              return;
            }
          }
        }

        updateAgentRoles(modules, aid!, (roles: any) => {
          if (incoming.defaultRoles && typeof incoming.defaultRoles === 'object') {
            roles.defaultRoles = {
              private: normalizeDefaultRoleInput(incoming.defaultRoles.private, currentConfig.defaultRoles?.private),
              group: normalizeDefaultRoleInput(incoming.defaultRoles.group, currentConfig.defaultRoles?.group),
            };
          }

          if (incoming.roles && typeof incoming.roles === 'object') {
            const nextDefinitions: Record<string, any> = {};
            for (const [roleName, roleDef] of Object.entries(incoming.roles)) {
              nextDefinitions[roleName] = normalizeRoleDefinitionForSave(roleDef);
            }
            roles.definitions = nextDefinitions;
          }
        });

        sendJson(res, 200, { ok: true, data: await buildSnapshot({ aid }) });
      } catch (err: any) {
        console.error('[role-definitions] Failed to update agent role config:', err);
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/role-definitions') {
      try {
        const data = await readJsonBody(req);
        const { name, description, permissions, commandPermissions, usageLimits } = data;

        const nameError = validateRoleDefinitionName(name);
        if (nameError) {
          sendJson(res, 400, { error: nameError });
          return;
        }

        const config = readRolesConfig(aid || undefined);
        if (config.roles[name]) {
          sendJson(res, 409, { error: 'Role already exists' });
          return;
        }

        const newRole = {
          description: typeof description === 'string' ? description : '',
          allowAccess: typeof data.allowAccess === 'boolean' ? data.allowAccess : true,
          permissions: isRecord(permissions) ? permissions : {},
          commandPermissions: isRecord(commandPermissions) ? commandPermissions : {}
        };
        const validation = await validateRoleModelPermission(newRole);
        if (!validation.ok) {
          sendJson(res, 400, { error: 'Invalid model permissions', errors: validation.errors });
          return;
        }
        const commandValidation = validateCommandPermissions(newRole.commandPermissions);
        if (!commandValidation.ok) {
          sendJson(res, 400, { error: 'Invalid command permissions', errors: commandValidation.errors });
          return;
        }
        const usageValidation = validateRoleUsageLimits(usageLimits);
        if (!usageValidation.ok) {
          sendJson(res, 400, { error: 'Invalid usage limits', errors: usageValidation.errors });
          return;
        }
        if (usageLimits !== undefined) {
          (newRole as any).usageLimits = normalizeRoleUsageLimits(usageLimits);
        }

        updateAgentRoles(modules, aid!, (roles: any) => {
          roles.definitions = { ...(roles.definitions || {}), [name]: newRole };
        });

        sendJson(res, 201, { ok: true, role: newRole });
      } catch (err: any) {
        console.error('[role-definitions] Failed to create role:', err);
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'GET' && roleNestedRoute?.[2] === 'configurable-models') {
      const roleName = decodeRoleName(roleNestedRoute[1]);
      const config = readRolesConfig(aid || undefined);
      const roleDef = config.roles[roleName];
      if (!roleDef) {
        sendJson(res, 404, { success: false, error: 'Role not found' });
        return;
      }

      const data = await buildModelPermissionResponse(roleName, roleDef);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === 'POST' && roleNestedRoute?.[2] === 'preview-models') {
      const roleName = decodeRoleName(roleNestedRoute[1]);
      const config = readRolesConfig(aid || undefined);
      const roleDef = config.roles[roleName];
      if (!roleDef) {
        sendJson(res, 404, { success: false, error: 'Role not found' });
        return;
      }

      const payload = await readJsonBody(req);
      const currentPerm = getModelPermission(roleDef);
      const validation = await validateModelPermissionInput(extractModelPermissionPayload(payload, currentPerm));
      if (!validation.ok || !validation.value) {
        sendJson(res, 400, { success: false, error: 'Invalid model permissions', errors: validation.errors });
        return;
      }

      const data = await buildModelPermissionResponse(roleName, roleDef, validation.value);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === 'PUT' && roleNestedRoute?.[2] === 'model-permissions') {
      const roleName = decodeRoleName(roleNestedRoute[1]);
      const config = readRolesConfig(aid || undefined);
      const roleDef = config.roles[roleName];
      if (!roleDef) {
        sendJson(res, 404, { success: false, error: 'Role not found' });
        return;
      }

      const payload = await readJsonBody(req);
      const currentPerm = getModelPermission(roleDef);
      const validation = await validateModelPermissionInput(extractModelPermissionPayload(payload, currentPerm));
      if (!validation.ok || !validation.value) {
        sendJson(res, 400, { success: false, error: 'Invalid model permissions', errors: validation.errors });
        return;
      }

      roleDef.permissions = roleDef.permissions && typeof roleDef.permissions === 'object'
        ? roleDef.permissions
        : {};
      const existingPerm = stripSelectionModeFromPermission(getModelPermission(roleDef));
      roleDef.permissions[MODEL_PERMISSION_FIELD] = {
        ...existingPerm,
        default: validation.value.defaultModel,
        allowOverride: validation.value.allowOverride,
        allowedModels: validation.value.allowedModels,
      };

      updateAgentRoles(modules, aid!, (roles: any) => {
        roles.definitions = { ...(roles.definitions || {}), [roleName]: roleDef };
      });
      const data = await buildModelPermissionResponse(roleName, roleDef, validation.value);
      sendJson(res, 200, { success: true, data });
      return;
    }

    if (req.method === 'POST' && roleNestedRoute?.[2] === 'reset') {
      const roleName = decodeRoleName(roleNestedRoute[1]);
      const builtinConfig = getBuiltinRolesConfig();
      const builtinRole = builtinConfig.roles[roleName];
      if (!builtinRole) {
        sendJson(res, 404, { error: 'Role not found in builtin config' });
        return;
      }

      updateAgentRoles(modules, aid!, (roles: any) => {
        const definitions = { ...(roles.definitions || {}) };
        delete definitions[roleName];
        if (Object.keys(definitions).length) roles.definitions = definitions;
        else delete roles.definitions;
      });

      sendJson(res, 200, { ok: true, role: builtinRole });
      return;
    }

    if (req.method === 'GET' && roleRoute) {
      const roleName = decodeRoleName(roleRoute[1]);
      const config = readRolesConfig(aid || undefined);
      const roleDef = config.roles[roleName];
      if (!roleDef) {
        sendJson(res, 404, { error: 'Role not found' });
        return;
      }

      sendJson(res, 200, roleDef);
      return;
    }

    if (req.method === 'DELETE' && roleRoute) {
      const roleName = decodeRoleName(roleRoute[1]);
      const builtinRoles = builtinUserRoles(modules);
      if (builtinRoles.has(roleName) || isReservedRoleName(roleName)) {
        sendJson(res, 403, { error: 'Cannot delete builtin or management role' });
        return;
      }

      const agentConfig = readAgentConfig(modules, aid!);
      const definitions = getAgentRoleDefinitions(agentConfig);
      if (!definitions[roleName]) {
        sendJson(res, 404, { error: 'Role not found' });
        return;
      }

      updateAgentRoles(modules, aid!, (roles: any) => {
        const nextDefinitions = { ...(roles.definitions || {}) };
        delete nextDefinitions[roleName];
        if (Object.keys(nextDefinitions).length) roles.definitions = nextDefinitions;
        else delete roles.definitions;
      });

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'PUT' && roleRoute) {
      try {
        const roleName = decodeRoleName(roleRoute[1]);
        const updates = await readJsonBody(req);
        const nameError = validateRoleDefinitionName(roleName);
        if (nameError) {
          sendJson(res, 400, { error: nameError });
          return;
        }

        const config = readRolesConfig(aid || undefined);
        const currentRole = config.roles[roleName];
        if (!currentRole) {
          sendJson(res, 404, { error: 'Role not found' });
          return;
        }

        const nextRole = {
          ...currentRole,
          ...updates
        };

        if (updates.permissions && typeof updates.permissions === 'object') {
          const mergedPermissions: Record<string, any> = { ...(currentRole.permissions || {}) };
          for (const [permKey, permValue] of Object.entries(updates.permissions)) {
            const currentPerm = mergedPermissions[permKey];
            if (
              currentPerm && typeof currentPerm === 'object' && !Array.isArray(currentPerm) &&
              permValue && typeof permValue === 'object' && !Array.isArray(permValue)
            ) {
              mergedPermissions[permKey] = { ...currentPerm, ...permValue };
            } else {
              mergedPermissions[permKey] = permValue;
            }
          }
          nextRole.permissions = mergedPermissions;
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'commandPermissions')) {
          const commandValidation = validateCommandPermissions(updates.commandPermissions);
          if (!commandValidation.ok) {
            sendJson(res, 400, { error: 'Invalid command permissions', errors: commandValidation.errors });
            return;
          }
          nextRole.commandPermissions = updates.commandPermissions;
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'usageLimits')) {
          const usageValidation = validateRoleUsageLimits(updates.usageLimits);
          if (!usageValidation.ok) {
            sendJson(res, 400, { error: 'Invalid usage limits', errors: usageValidation.errors });
            return;
          }
          nextRole.usageLimits = normalizeRoleUsageLimits(updates.usageLimits);
        }

        const validation = await validateRoleModelPermission(nextRole);
        if (!validation.ok) {
          sendJson(res, 400, { error: 'Invalid model permissions', errors: validation.errors });
          return;
        }

        updateAgentRoles(modules, aid!, (roles: any) => {
          roles.definitions = { ...(roles.definitions || {}), [roleName]: nextRole };
        });

        sendJson(res, 200, { ok: true });
      } catch (err: any) {
        console.error('[role-definitions] Failed to update role:', err);
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err: any) {
    console.error('[role-definitions] API error:', err);
    sendJson(res, 500, { error: err.message });
  }
}

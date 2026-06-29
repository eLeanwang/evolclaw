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

import fs from 'fs';
import path from 'path';
import type { WatchSource } from './types.js';
import { getModelCatalogSnapshot, type ModelCatalogApiEntry } from './models.js';

// 动态导入 evolclaw 主项目的角色配置模块
async function getRolesModule() {
  const rolesPath = path.join(process.cwd(), 'dist', 'config', 'roles.js');
  const cmPath = path.join(process.cwd(), 'dist', 'config', 'config-manager.js');

  if (!fs.existsSync(rolesPath) || !fs.existsSync(cmPath)) {
    throw new Error(`Roles modules not found (roles.js / config-manager.js). Is evolclaw built? cwd=${process.cwd()}`);
  }

  // Windows 上需要转换为 file:// URL
  const toUrl = (p: string) => process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;

  try {
    const rolesMod = await import(toUrl(rolesPath));
    const cmMod = await import(toUrl(cmPath));

    if (!rolesMod.readRolesConfig) throw new Error('readRolesConfig not found in roles.js');
    if (!rolesMod.getBuiltinRolesConfig) throw new Error('getBuiltinRolesConfig not found in roles.js');
    if (!cmMod.writeRoles) throw new Error('writeRoles not found in config-manager.js');
    if (!cmMod.read) throw new Error('read not found in config-manager.js');
    if (!cmMod.ConfigTarget) throw new Error('ConfigTarget not found in config-manager.js');

    return {
      readRolesConfig: rolesMod.readRolesConfig as () => any,
      getBuiltinRolesConfig: rolesMod.getBuiltinRolesConfig as () => any,
      writeRoles: cmMod.writeRoles as (full: any) => void,
      read: cmMod.read as (target: any, sel?: any) => any,
      ConfigTarget: cmMod.ConfigTarget as any,
    };
  } catch (err) {
    console.error('[role-definitions] Failed to import roles modules:', err);
    throw err;
  }
}

async function getRoleConstraintsModule() {
  const constraintsPath = path.join(process.cwd(), 'dist', 'config', 'role-constraints.js');

  if (!fs.existsSync(constraintsPath)) {
    throw new Error(`Role constraints module not found. Is evolclaw built? cwd=${process.cwd()}`);
  }

  const toUrl = (p: string) => process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;

  const mod = await import(toUrl(constraintsPath));
  if (!mod.isModelAllowedByPatterns) throw new Error('isModelAllowedByPatterns not found in role-constraints.js');
  return {
    isModelAllowedByPatterns: mod.isModelAllowedByPatterns as (model: string, allowedModels: string[]) => boolean,
  };
}

interface RoleWriteAuth {
  localDirect?: boolean;
  actorAid?: string | null;
}

function isWriteMethod(method: string | undefined): boolean {
  return method === 'PUT' || method === 'POST' || method === 'DELETE';
}

function canManageRoleDefinitions(processConfig: any, auth: RoleWriteAuth): boolean {
  if (auth.localDirect) return true;
  const actor = auth.actorAid || '';
  return !!actor && Array.isArray(processConfig?.owners) && processConfig.owners.includes(actor);
}

const MODEL_PERMISSION_FIELD = 'baseagents.claude.model';
const MODEL_PATTERN_OPTIONS = ['*', 'claude-opus-*', 'claude-sonnet-*', 'claude-haiku-*'];

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

async function buildSnapshot(): Promise<any> {
  try {
    const { readRolesConfig } = await getRolesModule();
    return readRolesConfig();
  } catch (err) {
    console.error('[role-definitions] Failed to build snapshot:', err);
    return { $schema_version: 1, roles: {}, error: String(err) };
  }
}

export const roleDefinitionsSource: WatchSource = {
  kind: 'roleDefinitions',

  async snapshot(): Promise<any> {
    return buildSnapshot();
  },

  subscribe(_params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await buildSnapshot();
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
    const { readRolesConfig, getBuiltinRolesConfig, writeRoles, read, ConfigTarget } = await getRolesModule();
    const urlPath = (req.url || '').split('?')[0];
    const roleRoute = urlPath.match(/^\/api\/role-definitions\/([^/]+)$/);
    const roleNestedRoute = urlPath.match(/^\/api\/role-definitions\/([^/]+)\/([^/]+)$/);
    const decodeRoleName = (raw: string) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    };

    if (isWriteMethod(req.method)) {
      const processConfig = read(ConfigTarget.Process) || {};
      if (!canManageRoleDefinitions(processConfig, auth)) {
        console.warn('[role-definitions] Write forbidden:', {
          method: req.method,
          url: req.url,
          actorAid: auth.actorAid,
          localDirect: !!auth.localDirect
        });
        sendJson(res, 403, { error: 'forbidden: process owner required' });
        return;
      }
    }

    if (req.method === 'GET' && urlPath === '/api/role-definitions') {
      sendJson(res, 200, readRolesConfig());
      return;
    }

    if (req.method === 'PUT' && urlPath === '/api/role-definitions') {
      try {
        const incoming = await readJsonBody(req);
        const config = readRolesConfig();

        if (incoming.defaultRoles && typeof incoming.defaultRoles === 'object') {
          config.defaultRoles = {
            private: typeof incoming.defaultRoles.private === 'string'
              ? incoming.defaultRoles.private
              : (config.defaultRoles?.private || 'anonymous'),
            group: typeof incoming.defaultRoles.group === 'string'
              ? incoming.defaultRoles.group
              : (config.defaultRoles?.group || 'guest'),
          };
        }

        if (incoming.roles && typeof incoming.roles === 'object') {
          for (const [roleName, roleDef] of Object.entries(incoming.roles)) {
            const validation = await validateRoleModelPermission(roleDef);
            if (!validation.ok) {
              sendJson(res, 400, {
                error: `Invalid model permissions for role ${roleName}`,
                errors: validation.errors
              });
              return;
            }
          }
          config.roles = incoming.roles;
        }

        writeRoles(config);
        sendJson(res, 200, { ok: true });
      } catch (err: any) {
        console.error('[role-definitions] Failed to update global config:', err);
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/role-definitions') {
      try {
        const data = await readJsonBody(req);
        const { name, description, permissions } = data;

        if (!name || !/^[a-z0-9_-]+$/.test(name)) {
          sendJson(res, 400, { error: 'Invalid role name' });
          return;
        }

        const config = readRolesConfig();
        if (config.roles[name]) {
          sendJson(res, 409, { error: 'Role already exists' });
          return;
        }

        const newRole = {
          description: typeof description === 'string' ? description : '',
          allowAccess: typeof data.allowAccess === 'boolean' ? data.allowAccess : true,
          permissions: permissions && typeof permissions === 'object' ? permissions : {}
        };
        const validation = await validateRoleModelPermission(newRole);
        if (!validation.ok) {
          sendJson(res, 400, { error: 'Invalid model permissions', errors: validation.errors });
          return;
        }

        config.roles[name] = newRole;
        writeRoles(config);

        sendJson(res, 201, { ok: true, role: config.roles[name] });
      } catch (err: any) {
        console.error('[role-definitions] Failed to create role:', err);
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'GET' && roleNestedRoute?.[2] === 'configurable-models') {
      const roleName = decodeRoleName(roleNestedRoute[1]);
      const config = readRolesConfig();
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
      const config = readRolesConfig();
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
      const config = readRolesConfig();
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

      writeRoles(config);
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

      const config = readRolesConfig();
      config.roles[roleName] = builtinRole;
      writeRoles(config);

      sendJson(res, 200, { ok: true, role: builtinRole });
      return;
    }

    if (req.method === 'GET' && roleRoute) {
      const roleName = decodeRoleName(roleRoute[1]);
      const config = readRolesConfig();
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
      const builtinRoles = ['owner', 'admin', 'member', 'guest', 'anonymous'];
      if (builtinRoles.includes(roleName)) {
        sendJson(res, 403, { error: 'Cannot delete builtin role' });
        return;
      }

      const config = readRolesConfig();
      if (!config.roles[roleName]) {
        sendJson(res, 404, { error: 'Role not found' });
        return;
      }

      delete config.roles[roleName];
      writeRoles(config);

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'PUT' && roleRoute) {
      try {
        const roleName = decodeRoleName(roleRoute[1]);
        const updates = await readJsonBody(req);
        const config = readRolesConfig();
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

        const validation = await validateRoleModelPermission(nextRole);
        if (!validation.ok) {
          sendJson(res, 400, { error: 'Invalid model permissions', errors: validation.errors });
          return;
        }

        config.roles[roleName] = nextRole;
        writeRoles(config);

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

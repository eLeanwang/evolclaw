import { getFieldPermission } from '../../config/roles.js';
import { isModelAllowedByPatterns } from '../../config/role-constraints.js';

export interface RoleModelPermission {
  defaultModel?: string;
  allowOverride: boolean;
  allowedModels?: string[];
  constrained: boolean;
}

export interface ModelPermissionDecision {
  ok: boolean;
  model?: string;
  code?: 'MODEL_OVERRIDE_DISABLED' | 'MODEL_NOT_ALLOWED' | 'INVALID_VALUE';
  message?: string;
}

type Resolver = (model: string) => string | undefined;

function normalizeBaseagent(baseagent?: string): string {
  return (baseagent || 'claude').trim() || 'claude';
}

export function getRoleModelPermission(role: string | undefined, baseagent: string | undefined, selfAid?: string): RoleModelPermission {
  const ba = normalizeBaseagent(baseagent);
  if (!role) return { allowOverride: false, constrained: true };
  const selected = getFieldPermission(role, `baseagents.${ba}.model`, selfAid);

  if (!selected || !Array.isArray(selected.allowedModels)) {
    return { allowOverride: true, constrained: false };
  }

  return {
    defaultModel: typeof selected.default === 'string' ? selected.default : undefined,
    allowOverride: selected.allowOverride !== false,
    allowedModels: selected.allowedModels,
    constrained: true,
  };
}

export function resolveCandidateModel(model: string, resolveModelId?: Resolver): string {
  return resolveModelId?.(model) || model;
}

export function isModelAllowedForRoleBaseagent(
  role: string | undefined,
  baseagent: string | undefined,
  model: string,
  resolveModelId?: Resolver,
  selfAid?: string,
): boolean {
  const permission = getRoleModelPermission(role, baseagent, selfAid);
  if (!permission.constrained) return true;
  const allowed = permission.allowedModels || [];
  const resolved = resolveCandidateModel(model, resolveModelId);
  return isModelAllowedByPatterns(model, allowed) || isModelAllowedByPatterns(resolved, allowed);
}

export function filterModelsForRole(
  role: string | undefined,
  baseagent: string | undefined,
  models: string[],
  resolveModelId?: Resolver,
  selfAid?: string,
): string[] {
  const permission = getRoleModelPermission(role, baseagent, selfAid);
  if (!permission.constrained) return models;

  return models.filter(model => isModelAllowedForRoleBaseagent(role, baseagent, model, resolveModelId, selfAid));
}

export function validateModelSelectionForRole(opts: {
  role?: string;
  baseagent?: string;
  requestedModel: string;
  models?: string[];
  resolveModelId?: Resolver;
  selfAid?: string;
}): ModelPermissionDecision {
  const permission = getRoleModelPermission(opts.role, opts.baseagent, opts.selfAid);
  const resolvedModel = resolveCandidateModel(opts.requestedModel, opts.resolveModelId);
  const catalogModel = opts.models?.includes(resolvedModel)
    ? resolvedModel
    : opts.models?.includes(opts.requestedModel)
      ? opts.requestedModel
      : undefined;

  if (opts.models && opts.models.length > 0 && !catalogModel) {
    return {
      ok: false,
      code: 'INVALID_VALUE',
      message: `无效模型: ${opts.requestedModel}`,
    };
  }

  const targetModel = catalogModel || resolvedModel;
  if (!permission.constrained) return { ok: true, model: targetModel };

  if (!permission.allowOverride) {
    return {
      ok: false,
      code: 'MODEL_OVERRIDE_DISABLED',
      message: `当前角色不允许切换模型，固定使用: ${permission.defaultModel || '角色默认模型'}`,
    };
  }

  if (!isModelAllowedForRoleBaseagent(opts.role, opts.baseagent, targetModel, opts.resolveModelId, opts.selfAid)) {
    return {
      ok: false,
      code: 'MODEL_NOT_ALLOWED',
      message: `当前角色不允许使用模型: ${opts.requestedModel}`,
    };
  }

  return { ok: true, model: targetModel };
}

export function constrainResolvedModelForRole(opts: {
  role?: string;
  baseagent?: string;
  model?: string;
  resolveModelId?: Resolver;
  selfAid?: string;
}): { model?: string; constrained: boolean } {
  const permission = getRoleModelPermission(opts.role, opts.baseagent, opts.selfAid);
  if (!permission.constrained) return { model: opts.model, constrained: false };
  if (!permission.allowOverride) return { model: permission.defaultModel || opts.model, constrained: true };
  if (!opts.model) return { model: permission.defaultModel, constrained: true };
  if (isModelAllowedForRoleBaseagent(opts.role, opts.baseagent, opts.model, opts.resolveModelId, opts.selfAid)) {
    return { model: opts.model, constrained: false };
  }
  return { model: permission.defaultModel || opts.model, constrained: true };
}

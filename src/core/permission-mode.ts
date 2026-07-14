import type { PermissionMode } from '../types.js';

export const PUBLIC_PERMISSION_MODES = ['readonly', 'auto', 'request', 'bypass'] as const;

export type PublicPermissionMode = (typeof PUBLIC_PERMISSION_MODES)[number];

export interface NormalizedPermissionMode {
  mode: PublicPermissionMode;
  /** Legacy plan remains a workflow hint while permission enforcement is readonly. */
  workflow?: 'plan';
  migratedFrom?: PermissionMode;
}

export function isPublicPermissionMode(value: unknown): value is PublicPermissionMode {
  return typeof value === 'string'
    && (PUBLIC_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Normalize persisted legacy values at the runtime boundary.
 *
 * - edit had request-like approval semantics, so it migrates to request.
 * - noask historically disabled prompts and is therefore safely reduced to readonly.
 * - plan is a workflow state, not an authority level; permission enforcement is readonly.
 * - unknown values fail safe to readonly.
 */
export function normalizePermissionMode(value: unknown): NormalizedPermissionMode {
  if (isPublicPermissionMode(value)) return { mode: value };
  if (value === 'edit') return { mode: 'request', migratedFrom: 'edit' };
  if (value === 'noask') return { mode: 'readonly', migratedFrom: 'noask' };
  if (value === 'plan') return { mode: 'readonly', workflow: 'plan', migratedFrom: 'plan' };
  return { mode: 'readonly' };
}

export function normalizeInternalPermissionMode(value: unknown, disableTools = false): NormalizedPermissionMode {
  if (disableTools) return { mode: 'readonly', migratedFrom: 'noask' };
  return normalizePermissionMode(value);
}

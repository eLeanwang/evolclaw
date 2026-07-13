import { normalizePeer, ModelScopeError } from '../core/model/config-scope.js';

export type ConfigSelectorScope = 'process' | 'defaults' | 'agent' | 'relation';

export type ConfigSelectorParseResult =
  | { ok: true; scope: ConfigSelectorScope; self?: string; peerKey?: string }
  | { ok: false; code: string; reason: string };

export function parseConfigSelector(
  args: string[],
  options: { requireSelector: boolean },
): ConfigSelectorParseResult {
  let self: string | undefined;
  let peerRaw: string | undefined;
  let isDefault = false;
  let isProcess = false;
  const seen = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--self' || arg === '--peer') {
      if (seen.has(arg)) return { ok: false, code: 'SELECTOR_CONFLICT', reason: `Duplicate selector: ${arg}` };
      seen.add(arg);
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        return { ok: false, code: 'MISSING_FLAG_VALUE', reason: `${arg} requires a value` };
      }
      if (arg === '--self') self = value;
      else peerRaw = value;
      i += 1;
      continue;
    }
    if (arg === '--default') {
      if (seen.has('--default')) return { ok: false, code: 'SELECTOR_CONFLICT', reason: 'Duplicate selector: --default' };
      seen.add('--default');
      isDefault = true;
      continue;
    }
    if (arg === '--process' || arg === '--evolclaw') {
      if (seen.has('--process')) return { ok: false, code: 'SELECTOR_CONFLICT', reason: 'Duplicate process selector' };
      seen.add('--process');
      isProcess = true;
    }
  }

  if (isProcess && (self || peerRaw !== undefined || isDefault)) {
    return { ok: false, code: 'SELECTOR_CONFLICT', reason: '--process cannot be combined with --self/--peer/--default' };
  }
  if (isDefault && (self || peerRaw !== undefined)) {
    return { ok: false, code: 'SELECTOR_CONFLICT', reason: '--default cannot be combined with --self/--peer' };
  }
  if (peerRaw !== undefined && !self) {
    return { ok: false, code: 'PEER_WITHOUT_SELF', reason: '--peer requires --self' };
  }

  if (isProcess) return { ok: true, scope: 'process' };
  if (isDefault) return { ok: true, scope: 'defaults' };
  if (self) {
    if (peerRaw !== undefined) {
      try {
        return { ok: true, scope: 'relation', self, peerKey: normalizePeer(peerRaw) };
      } catch (error) {
        if (error instanceof ModelScopeError) return { ok: false, code: error.code, reason: error.message };
        throw error;
      }
    }
    return { ok: true, scope: 'agent', self };
  }
  if (options.requireSelector) {
    return { ok: false, code: 'SELECTOR_REQUIRED', reason: 'A config selector is required' };
  }
  return { ok: true, scope: 'agent' };
}

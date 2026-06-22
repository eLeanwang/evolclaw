import type { Session } from '../../types.js';
import { resolveEffectiveModel, type ResolvedModel, type ScopeSelector } from '../model/config-scope.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import { logger } from '../../utils/logger.js';

export interface CommandModelResolution {
  baseagent: string;
  model?: string;
  effort?: string;
  runnerModel?: string;
  runnerEffort?: string;
  scope: ScopeSelector;
  resolved?: ResolvedModel;
}

export function resolveCommandModelResolution(opts: {
  agent: any;
  session?: Session | null;
  selfAid?: string;
  channelType?: string;
  channelId: string;
  userId?: string;
  role?: string;
}): CommandModelResolution {
  const effectiveBaseagent = opts.session?.baseagent || opts.agent?.name;
  if (!effectiveBaseagent) {
    throw new Error(`[model-resolve] baseagent could not be resolved (session.baseagent=${opts.session?.baseagent}, agent.name=${opts.agent?.name})`);
  }
  const runnerModel = typeof opts.agent?.getModel === 'function'
    ? opts.agent.getModel()
    : (opts.agent?.name || undefined);
  const runnerEffort = typeof opts.agent?.getEffort === 'function'
    ? opts.agent.getEffort()
    : undefined;

  const peerKeyId = opts.session?.chatType === 'group'
    ? (opts.session?.metadata?.groupId || opts.channelId)
    : (opts.userId || opts.session?.metadata?.peerId);
  const peerKey = (opts.channelType && peerKeyId)
    ? formatPeerKey(opts.channelType, peerKeyId)
    : undefined;
  const scope: ScopeSelector = {
    self: opts.selfAid || undefined,
    peerKey,
    role: opts.session?.identity?.role || opts.role || 'anonymous',
  };

  let resolved: ResolvedModel | undefined;
  if (scope.self) {
    try {
      resolved = resolveEffectiveModel(scope, effectiveBaseagent);
    } catch {
      resolved = undefined;
    }
  }

  return {
    baseagent: effectiveBaseagent,
    model: resolved?.model || runnerModel,
    effort: resolved?.effort ?? runnerEffort,
    runnerModel,
    runnerEffort,
    scope,
    resolved,
  };
}

export function modelMatches(agent: any, candidate: string, current: string | undefined): boolean {
  if (!current) return false;
  if (candidate === current) return true;
  const resolve = typeof agent?.resolveModelId === 'function'
    ? (value: string) => agent.resolveModelId(value) ?? value
    : (value: string) => value;
  const resolvedCandidate = resolve(candidate);
  const resolvedCurrent = resolve(current);
  return candidate === resolvedCurrent || resolvedCandidate === current || resolvedCandidate === resolvedCurrent;
}

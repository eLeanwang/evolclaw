import crypto from 'crypto';
import {
  CAUSATION_VERSION,
  MAX_TRIGGER_CAUSATION_DEPTH,
  type CausationContext,
  type TriggerCausationNode,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function newId(prefix: 'trace' | 'span'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function cloneCausation(context: CausationContext): CausationContext {
  return {
    version: CAUSATION_VERSION,
    traceId: context.traceId,
    spanId: context.spanId,
    ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
    ...(context.trigger ? { trigger: { path: context.trigger.path.map(node => ({ ...node })) } } : {}),
  };
}

export function normalizeCausation(value: unknown): CausationContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== CAUSATION_VERSION || !validId(raw.traceId) || !validId(raw.spanId)) return undefined;
  if (raw.parentSpanId !== undefined && !validId(raw.parentSpanId)) return undefined;

  let trigger: CausationContext['trigger'];
  if (raw.trigger !== undefined) {
    if (!raw.trigger || typeof raw.trigger !== 'object' || Array.isArray(raw.trigger)) return undefined;
    const path = (raw.trigger as Record<string, unknown>).path;
    if (!Array.isArray(path) || path.length === 0 || path.length > MAX_TRIGGER_CAUSATION_DEPTH) return undefined;
    const normalizedPath: TriggerCausationNode[] = [];
    for (const node of path) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
      const record = node as Record<string, unknown>;
      if (!validId(record.triggerId) || !validId(record.runId)) return undefined;
      normalizedPath.push({ triggerId: record.triggerId, runId: record.runId });
    }
    trigger = { path: normalizedPath };
  }

  return {
    version: CAUSATION_VERSION,
    traceId: raw.traceId,
    spanId: raw.spanId,
    ...(raw.parentSpanId ? { parentSpanId: raw.parentSpanId as string } : {}),
    ...(trigger ? { trigger } : {}),
  };
}

export function createRootCausation(): CausationContext {
  return {
    version: CAUSATION_VERSION,
    traceId: newId('trace'),
    spanId: newId('span'),
  };
}

export function deriveCausation(parent: CausationContext): CausationContext {
  const normalized = normalizeCausation(parent);
  if (!normalized) return createRootCausation();
  return {
    version: CAUSATION_VERSION,
    traceId: normalized.traceId,
    spanId: newId('span'),
    parentSpanId: normalized.spanId,
    ...(normalized.trigger ? { trigger: { path: normalized.trigger.path.map(node => ({ ...node })) } } : {}),
  };
}

export type EnterTriggerResult =
  | { ok: true; causation: CausationContext }
  | { ok: false; reason: 'causation_cycle'; matched: TriggerCausationNode }
  | { ok: false; reason: 'causation_depth_exceeded' };

export function enterTrigger(
  parent: CausationContext | undefined,
  triggerId: string,
  runId: string,
): EnterTriggerResult {
  const normalized = normalizeCausation(parent);
  const existingPath = normalized?.trigger?.path ?? [];
  const matched = existingPath.find(node => node.triggerId === triggerId);
  if (matched) return { ok: false, reason: 'causation_cycle', matched };
  if (existingPath.length >= MAX_TRIGGER_CAUSATION_DEPTH) {
    return { ok: false, reason: 'causation_depth_exceeded' };
  }

  const causation = normalized ? deriveCausation(normalized) : createRootCausation();
  causation.trigger = {
    path: [...existingPath.map(node => ({ ...node })), { triggerId, runId }],
  };
  return { ok: true, causation };
}

export function formatTriggerPath(context: CausationContext | undefined, nextTriggerId?: string): string {
  const path = normalizeCausation(context)?.trigger?.path ?? [];
  const formatted = path.map(node => `${node.triggerId}/${node.runId}`);
  if (nextTriggerId) formatted.push(nextTriggerId);
  return formatted.join(' -> ');
}

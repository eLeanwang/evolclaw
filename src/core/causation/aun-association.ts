import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';
import { atomicReadJson, atomicWriteJson } from '../../utils/atomic-write.js';
import { cloneCausation, normalizeCausation } from './context.js';
import type { CausationContext } from './types.js';

interface AunCausationAssociation {
  fromAid: string;
  toAid: string;
  causation: CausationContext;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const associations = new Map<string, AunCausationAssociation>();
let loaded = false;

function associationFile(): string {
  return path.join(resolvePaths().dataDir, 'causation-aun.json');
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: unknown;
  try {
    raw = atomicReadJson<unknown>(associationFile());
  } catch {
    return;
  }
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const causation = normalizeCausation(record.causation);
    if (
      typeof record.messageId !== 'string'
      || typeof record.fromAid !== 'string'
      || typeof record.toAid !== 'string'
      || typeof record.expiresAt !== 'number'
      || record.expiresAt <= Date.now()
      || !causation
    ) continue;
    associations.set(record.messageId, {
      fromAid: record.fromAid,
      toAid: record.toAid,
      causation,
      expiresAt: record.expiresAt,
    });
  }
}

function persist(): void {
  try {
    if (associations.size === 0) {
      removeAssociationFiles();
      return;
    }
    atomicWriteJson(associationFile(), [...associations].map(([messageId, association]) => ({
      messageId,
      ...association,
    })));
  } catch {
  }
}

export function registerAunCausation(
  associationId: string,
  fromAid: string,
  toAid: string,
  causation: CausationContext,
  ttlMs = DEFAULT_TTL_MS,
): boolean {
  ensureLoaded();
  cleanupExpiredAunCausation();
  const normalized = normalizeCausation(causation);
  if (!associationId || !fromAid || !toAid || !normalized) return false;
  associations.set(associationId, {
    fromAid,
    toAid,
    causation: cloneCausation(normalized),
    expiresAt: Date.now() + Math.max(1, ttlMs),
  });
  persist();
  return true;
}

export function consumeAunCausation(
  associationId: string,
  fromAid: string,
  toAid: string,
): CausationContext | undefined {
  ensureLoaded();
  cleanupExpiredAunCausation();
  const association = associations.get(associationId);
  if (!association) return undefined;
  if (association.fromAid !== fromAid || association.toAid !== toAid) return undefined;
  associations.delete(associationId);
  persist();
  return cloneCausation(association.causation);
}

export function cleanupExpiredAunCausation(now = Date.now()): void {
  ensureLoaded();
  let changed = false;
  for (const [messageId, association] of associations) {
    if (association.expiresAt <= now) {
      associations.delete(messageId);
      changed = true;
    }
  }
  if (changed) persist();
}

export function clearAunCausationForTests(): void {
  associations.clear();
  loaded = true;
  try { removeAssociationFiles(); } catch {}
}

function removeAssociationFiles(): void {
  const file = associationFile();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}_`, { force: true });
  fs.rmSync(`${file}__`, { force: true });
}

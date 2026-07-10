import { agentContactConfig } from '../paths.js';
import { isValidAid } from '../aun/aid/validation.js';
import { ConfigTarget, read, write } from './config-manager.js';

export interface ContactBookConfig {
  $schema_version?: number;
  contacts?: Record<string, ContactEntry>;
}

export interface ContactEntry {
  displayName?: string;
  aliases?: string[];
  [key: string]: unknown;
}

export class ContactBookError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ContactBookError';
  }
}

interface BuiltAliasMap {
  aliasToPrimary: Map<string, string>;
}

let aliasMapCache = new WeakMap<ContactBookConfig, BuiltAliasMap>();
const emptyAliasMap = new Map<string, string>();

export function agentContactConfigPath(aid: string): string {
  return agentContactConfig(aid);
}

export function readContactBook(selfAid: string, opts: { cache?: boolean } = {}): ContactBookConfig | null {
  if (!selfAid) return null;
  return read<ContactBookConfig>(
    ConfigTarget.Contact,
    { self: selfAid },
    { cache: opts.cache ?? true },
  );
}

export function resolvePrimaryId(selfAid: string, channelType: string, actorId: string): string {
  const normalizedActor = String(actorId || '').trim();
  if (!selfAid || !channelType || !normalizedActor) return normalizedActor;
  if (isAuthenticatedAid(normalizedActor)) return normalizedActor;
  const alias = normalizeAlias(channelType, normalizedActor);
  if (!alias) return normalizedActor;
  try {
    const aliases = loadAliasMap(selfAid);
    return aliases.get(alias) ?? normalizedActor;
  } catch {
    return normalizedActor;
  }
}

export function bindContactAlias(
  selfAid: string,
  primaryId: string,
  channelType: string,
  actorId: string,
): boolean {
  const primary = normalizePrimaryId(primaryId);
  const alias = requireAlias(channelType, actorId);
  ensureNativeAidIsNotRemapped(primary, actorId);

  const next = cloneContactBook(readContactBook(selfAid, { cache: true }));
  ensureAliasAvailable(next, primary, alias);

  const contacts = next.contacts ?? {};
  const current = normalizeContactEntry(contacts[primary]);
  if (current.aliases.some(value => normalizeAliasString(value) === alias)) {
    return false;
  }

  contacts[primary] = {
    ...current,
    aliases: [...current.aliases, alias],
  };
  next.contacts = contacts;
  write(ConfigTarget.Contact, next, { self: selfAid });
  return true;
}

export function unbindContactAlias(
  selfAid: string,
  primaryId: string,
  channelType: string,
  actorId: string,
): boolean {
  const primary = normalizePrimaryId(primaryId);
  const alias = requireAlias(channelType, actorId);
  const next = cloneContactBook(readContactBook(selfAid, { cache: true }));
  const entry = normalizeContactEntry(next.contacts?.[primary]);
  const filtered = entry.aliases.filter(value => normalizeAliasString(value) !== alias);
  if (filtered.length === entry.aliases.length) {
    return false;
  }

  next.contacts = next.contacts ?? {};
  next.contacts[primary] = { ...entry, aliases: filtered };
  write(ConfigTarget.Contact, next, { self: selfAid });
  return true;
}

export function clearContactBookCache(): void {
  aliasMapCache = new WeakMap<ContactBookConfig, BuiltAliasMap>();
}

function loadAliasMap(selfAid: string): Map<string, string> {
  const book = readContactBook(selfAid, { cache: true });
  if (!book) return emptyAliasMap;
  const cached = aliasMapCache.get(book);
  if (cached) return cached.aliasToPrimary;

  const built = { aliasToPrimary: buildAliasMap(book) };
  aliasMapCache.set(book, built);
  return built.aliasToPrimary;
}

function buildAliasMap(config: ContactBookConfig | null): Map<string, string> {
  const out = new Map<string, string>();
  const conflicts = new Set<string>();
  const contacts = config?.contacts;
  if (!contacts || typeof contacts !== 'object' || Array.isArray(contacts)) return out;

  for (const [rawPrimaryId, entry] of Object.entries(contacts)) {
    const primaryId = rawPrimaryId.trim();
    if (!isValidAid(primaryId) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const rawAlias of aliases) {
      const alias = normalizeAliasString(rawAlias);
      if (!alias || conflicts.has(alias)) continue;
      const existing = out.get(alias);
      if (existing && existing !== primaryId) {
        out.delete(alias);
        conflicts.add(alias);
        continue;
      }
      out.set(alias, primaryId);
    }
  }

  return out;
}

function cloneContactBook(config: ContactBookConfig | null): ContactBookConfig {
  const next: ContactBookConfig = config ? { ...config } : {};
  const contacts: Record<string, ContactEntry> = {};
  const rawContacts = config?.contacts;
  if (rawContacts && typeof rawContacts === 'object' && !Array.isArray(rawContacts)) {
    for (const [primaryId, entry] of Object.entries(rawContacts)) {
      contacts[primaryId] = normalizeContactEntry(entry);
    }
  }
  next.contacts = contacts;
  return next;
}

function normalizeContactEntry(value: unknown): ContactEntry & { aliases: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { aliases: [] };
  }
  const entry = value as ContactEntry;
  return {
    ...entry,
    aliases: Array.isArray(entry.aliases)
      ? entry.aliases.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function ensureAliasAvailable(config: ContactBookConfig, primaryId: string, alias: string): void {
  const owners = findAliasOwners(config, alias);
  if (owners.size === 0) return;
  if (owners.size === 1 && owners.has(primaryId)) return;
  throw new ContactBookError(
    'ALIAS_CONFLICT',
    `Alias "${alias}" is already bound to ${[...owners].join(', ')}`,
  );
}

function findAliasOwners(config: ContactBookConfig, alias: string): Set<string> {
  const owners = new Set<string>();
  const contacts = config.contacts;
  if (!contacts || typeof contacts !== 'object' || Array.isArray(contacts)) return owners;
  for (const [rawPrimaryId, entry] of Object.entries(contacts)) {
    const primaryId = rawPrimaryId.trim();
    if (!primaryId || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    if (aliases.some(value => normalizeAliasString(value) === alias)) {
      owners.add(primaryId);
    }
  }
  return owners;
}

function normalizePrimaryId(value: string): string {
  const primaryId = String(value || '').trim();
  if (!isValidAid(primaryId)) {
    throw new ContactBookError('INVALID_PRIMARY_ID', `Invalid contact primary AID: ${String(value)}`);
  }
  return primaryId;
}

function requireAlias(channelType: string, actorId: string): string {
  const alias = normalizeAlias(channelType, actorId);
  if (!alias) {
    throw new ContactBookError('INVALID_ALIAS', `Invalid contact alias: ${String(channelType)}:${String(actorId)}`);
  }
  return alias;
}

function normalizeAlias(channelType: string, actorId: string): string | null {
  const channel = String(channelType || '').trim().toLowerCase();
  const id = String(actorId || '').trim();
  if (!/^[a-z0-9_-]+$/.test(channel) || !id) return null;
  return `${channel}:${id}`;
}

function normalizeAliasString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return normalizeAlias(trimmed.slice(0, idx), trimmed.slice(idx + 1));
}

function ensureNativeAidIsNotRemapped(primaryId: string, actorId: string): void {
  const actor = String(actorId || '').trim();
  if (isAuthenticatedAid(actor) && actor !== primaryId) {
    throw new ContactBookError(
      'NATIVE_AID_REMAP_FORBIDDEN',
      `Native AID "${actor}" cannot be remapped to "${primaryId}"`,
    );
  }
}

function isAuthenticatedAid(value: string): boolean {
  return /^([a-z0-9_-]+\.)+(aid|agentid)\.pub$/i.test(value);
}

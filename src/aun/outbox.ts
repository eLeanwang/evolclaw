import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolvePaths } from '../paths.js';
import type { ReplyContext } from '../types.js';

export interface OutboxEntry {
  id: string;
  ts: number;
  aid: string;
  channelId: string;
  type: 'text' | 'file';
  text?: string;
  filePath?: string;
  context?: ReplyContext;
  ttl: number;
}

const MAX_ENTRIES_PER_AID = 20;
const DEFAULT_TTL = 300_000; // 5 minutes

function outboxDir(): string {
  return resolvePaths().outboxDir;
}

function outboxFile(aid: string): string {
  return path.join(outboxDir(), `${aid}.jsonl`);
}

function generateId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(2).toString('hex');
  return `out-${ts}-${rand}`;
}

function isExpired(entry: OutboxEntry): boolean {
  return Date.now() - entry.ts > entry.ttl;
}

function readEntries(aid: string): OutboxEntry[] {
  const file = outboxFile(aid);
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((e): e is OutboxEntry => e !== null);
  } catch {
    return [];
  }
}

function writeEntries(aid: string, entries: OutboxEntry[]): void {
  const file = outboxFile(aid);
  if (entries.length === 0) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  const dir = outboxDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

export function enqueue(aid: string, opts: {
  channelId: string;
  type: 'text' | 'file';
  text?: string;
  filePath?: string;
  context?: ReplyContext;
  ttl?: number;
}): OutboxEntry {
  const entry: OutboxEntry = {
    id: generateId(),
    ts: Date.now(),
    aid,
    channelId: opts.channelId,
    type: opts.type,
    text: opts.text,
    filePath: opts.filePath,
    context: opts.context,
    ttl: opts.ttl ?? DEFAULT_TTL,
  };

  const dir = outboxDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = outboxFile(aid);

  // Enforce cap: read existing, drop oldest if over limit
  let entries = readEntries(aid);
  if (entries.length >= MAX_ENTRIES_PER_AID) {
    entries = entries.slice(entries.length - MAX_ENTRIES_PER_AID + 1);
    writeEntries(aid, [...entries, entry]);
  } else {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  }

  return entry;
}

export function remove(aid: string, id: string): void {
  const entries = readEntries(aid).filter(e => e.id !== id);
  writeEntries(aid, entries);
}

export function load(aid: string): OutboxEntry[] {
  return readEntries(aid).filter(e => !isExpired(e));
}

export function cleanup(aid: string): number {
  const all = readEntries(aid);
  const valid = all.filter(e => !isExpired(e));
  const removed = all.length - valid.length;
  if (removed > 0) writeEntries(aid, valid);
  return removed;
}

export type SendFn = (entry: OutboxEntry) => Promise<boolean>;

export async function drain(aid: string, sender: SendFn): Promise<{ sent: number; expired: number; failed: number }> {
  const entries = readEntries(aid);
  if (entries.length === 0) return { sent: 0, expired: 0, failed: 0 };

  let sent = 0;
  let expired = 0;
  let failed = 0;
  const remaining: OutboxEntry[] = [];

  for (const entry of entries) {
    if (isExpired(entry)) {
      expired++;
      continue;
    }
    try {
      const ok = await sender(entry);
      if (ok) {
        sent++;
      } else {
        failed++;
        remaining.push(entry);
      }
    } catch {
      failed++;
      remaining.push(entry);
    }
  }

  writeEntries(aid, remaining);
  return { sent, expired, failed };
}

export function hasPending(aid: string): boolean {
  const file = outboxFile(aid);
  if (!fs.existsSync(file)) return false;
  try {
    const stat = fs.statSync(file);
    return stat.size > 0;
  } catch {
    return false;
  }
}

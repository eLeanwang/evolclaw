import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';

export interface AidLifecycleEvent {
  ts: number;
  iso: string;
  event: 'connected' | 'disconnected' | 'kicked' | 'reconnecting';
  aid: string;
  [key: string]: unknown;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function logPath(aid: string): string {
  const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
  return path.join(resolvePaths().aidLogsDir, `${aidName}.jsonl`);
}

export function appendAidLifecycle(event: AidLifecycleEvent): void {
  const filePath = logPath(event.aid);
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
}

export function readAidLifecycle(aid: string, lastN = 50): AidLifecycleEvent[] {
  const filePath = logPath(aid);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const events: AidLifecycleEvent[] = [];
    for (const line of lines.slice(-lastN)) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

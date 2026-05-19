import fs from 'fs';
import path from 'path';
import { atomicWriteJson, appendJsonl } from '../session/session-fs-store.js';
import { logger } from '../../utils/logger.js';
import type { Trigger } from '../../types.js';

interface TriggersFile {
  version: number;
  triggers: Record<string, Trigger>;
}

interface HistoryEntry extends Trigger {
  doneAt: number;
  doneReason: 'fired' | 'cancelled' | 'expired';
}

export class TriggerManager {
  private triggersPath: string;
  private historyPath: string;
  private triggers: Map<string, Trigger> = new Map();

  constructor(private aid: string, triggersDir: string) {
    fs.mkdirSync(triggersDir, { recursive: true });
    this.triggersPath = path.join(triggersDir, 'triggers.json');
    this.historyPath = path.join(triggersDir, 'history.jsonl');
  }

  load(): Trigger[] {
    if (!fs.existsSync(this.triggersPath)) {
      this.triggers = new Map();
      return [];
    }
    try {
      const raw = fs.readFileSync(this.triggersPath, 'utf8');
      const data: TriggersFile = JSON.parse(raw);
      this.triggers = new Map(Object.entries(data.triggers ?? {}));
      return [...this.triggers.values()];
    } catch (e) {
      logger.warn(`[TriggerManager] Failed to parse ${this.triggersPath}, starting empty: ${e}`);
      this.triggers = new Map();
      return [];
    }
  }

  private save(): void {
    const data: TriggersFile = {
      version: 1,
      triggers: Object.fromEntries(this.triggers),
    };
    atomicWriteJson(this.triggersPath, data);
  }

  register(trigger: Trigger): void {
    if (this.triggers.has(trigger.id)) {
      throw new Error(`触发器 ID 已存在：${trigger.id}`);
    }
    // Check name uniqueness within this agent
    for (const t of this.triggers.values()) {
      if (t.name === trigger.name) {
        throw new Error(`触发器名称已存在：${trigger.name}`);
      }
    }
    this.triggers.set(trigger.id, trigger);
    this.save();
  }

  getById(id: string): Trigger | undefined {
    return this.triggers.get(id);
  }

  getByName(name: string): Trigger | undefined {
    for (const t of this.triggers.values()) {
      if (t.name === name) return t;
    }
    return undefined;
  }

  // Scoped lookup: only returns triggers owned by (peerId, channel) — prevents info disclosure
  getByNameScoped(name: string, peerId: string, channel: string): Trigger | undefined {
    for (const t of this.triggers.values()) {
      if (t.name === name && t.createdByPeerId === peerId && t.createdByChannel === channel) return t;
    }
    return undefined;
  }

  // Scoped ID lookup: allows creator to cancel by UUID without revealing others' triggers
  getByIdScoped(id: string, peerId: string, channel: string): Trigger | undefined {
    const t = this.triggers.get(id);
    if (t && t.createdByPeerId === peerId && t.createdByChannel === channel) return t;
    return undefined;
  }

  listActive(): Trigger[] {
    return [...this.triggers.values()].sort((a, b) => a.nextFireAt - b.nextFireAt);
  }

  listAll(): { active: Trigger[]; history: HistoryEntry[] } {
    const active = this.listActive();
    const history: HistoryEntry[] = [];
    if (fs.existsSync(this.historyPath)) {
      const lines = fs.readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { history.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }
    return { active, history };
  }

  updateFireStats(id: string, firedAt: number): void {
    const t = this.triggers.get(id);
    if (!t) return;
    t.lastFiredAt = firedAt;
    t.fireCount += 1;
    t.updatedAt = Date.now();
    this.save();
  }

  updateNextFireAt(id: string, nextFireAt: number): void {
    const t = this.triggers.get(id);
    if (!t) return;
    t.nextFireAt = nextFireAt;
    t.updatedAt = Date.now();
    this.save();
  }

  moveToDone(id: string, reason: HistoryEntry['doneReason']): Trigger | undefined {
    const t = this.triggers.get(id);
    if (!t) return undefined;
    this.triggers.delete(id);
    this.save();
    const entry: HistoryEntry = { ...t, doneAt: Date.now(), doneReason: reason };
    appendJsonl(this.historyPath, entry);
    return t;
  }
}

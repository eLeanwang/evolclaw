import fs from 'fs';
import path from 'path';
import { atomicWriteJson, appendJsonl } from '../session/session-fs-store.js';
import { formatChannelKey } from '../channel-loader.js';
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
      // Migrate old channel key format: "selfAID#type#name" → "type#selfAID#name"
      let migrated = false;
      for (const trigger of this.triggers.values()) {
        const fixed = this.migrateChannelKey(trigger.targetChannel);
        if (fixed !== trigger.targetChannel) { trigger.targetChannel = fixed; migrated = true; }
        if (trigger.createdByChannel) {
          const fixedBy = this.migrateChannelKey(trigger.createdByChannel);
          if (fixedBy !== trigger.createdByChannel) { trigger.createdByChannel = fixedBy; migrated = true; }
        }
      }
      if (migrated) { logger.info(`[TriggerManager] Migrated old channel key format`); this.save(); }
      return [...this.triggers.values()];
    } catch (e) {
      logger.warn(`[TriggerManager] Failed to parse ${this.triggersPath}, starting empty: ${e}`);
      this.triggers = new Map();
      return [];
    }
  }

  /**
   * Detect and fix old format "selfAID#type#name" → current "type#selfAID#name".
   * Old format: first segment contains '.' (AID like "evolai.agentid.pub").
   */
  private migrateChannelKey(key: string): string {
    if (!key || !key.includes('#')) return key;
    const parts = key.split('#');
    if (parts.length !== 3) return key;
    const [first, second, third] = parts;
    if (first.includes('.') && !second.includes('.')) {
      return formatChannelKey({ type: second, selfAID: first, name: third });
    }
    return key;
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

  /**
   * 按 id 从磁盘重读单条 trigger（不走内存缓存）。
   * 用于触发时刻取最新数据，消除内存/磁盘漂移。
   * 读盘失败或不存在时返回 undefined（调用方回退到内存副本）。
   */
  getByIdFresh(id: string): Trigger | undefined {
    if (!fs.existsSync(this.triggersPath)) return undefined;
    try {
      const raw = fs.readFileSync(this.triggersPath, 'utf8');
      const data: TriggersFile = JSON.parse(raw);
      return data.triggers?.[id];
    } catch {
      return undefined;
    }
  }

  /**
   * 从磁盘重新加载到内存 Map（外部编辑 triggers.json 后调用）。
   * 等价于 load()，语义上强调"丢弃内存副本、以磁盘为准"。
   */
  reloadFromDisk(): Trigger[] {
    return this.load();
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

  update(id: string, patch: Partial<Pick<Trigger, 'name' | 'scheduleType' | 'scheduleValue' | 'nextFireAt' | 'targetChannel' | 'targetChannelId' | 'targetThreadId' | 'targetSessionStrategy' | 'agentId' | 'prompt' | 'pendingThread'>>): Trigger {
    const t = this.triggers.get(id);
    if (!t) throw new Error(`触发器不存在：${id}`);
    // Check name uniqueness if name is being changed
    if (patch.name && patch.name !== t.name) {
      for (const other of this.triggers.values()) {
        if (other.id !== id && other.name === patch.name) {
          throw new Error(`触发器名称已存在：${patch.name}`);
        }
      }
    }
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.save();
    return t;
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

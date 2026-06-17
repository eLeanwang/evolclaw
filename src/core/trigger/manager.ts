import fs from 'fs';
import path from 'path';
import { agentTriggersDir } from '../../paths.js';
import { tryParseChannelKey } from '../channel-loader.js';
import { logger } from '../../utils/logger.js';
import {
  normalizeTriggerDefinition,
  resolveScriptPath,
  safeRelativePath,
} from './validation.js';
import type {
  TriggerCreateFile,
  TriggerDefinition,
} from './types.js';
import { atomicWriteJson } from '../session/session-fs-store.js';

export interface TriggerListOptions {
  all?: boolean;
}

export class TriggerDefinitionManager {
  constructor(
    readonly agentAid: string,
    readonly rootDir = agentTriggersDir(agentAid),
  ) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.migrateLegacyTriggers();
  }

  list(opts: TriggerListOptions = {}): TriggerDefinition[] {
    const definitions: TriggerDefinition[] = [];
    for (const triggerId of this.listTriggerIds()) {
      const definition = this.get(triggerId);
      if (!definition) continue;
      if (!opts.all && !definition.enabled) continue;
      definitions.push(definition);
    }
    return definitions.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(triggerId: string): TriggerDefinition | undefined {
    const file = this.definitionPath(triggerId);
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return normalizeTriggerDefinition(raw);
  }

  require(triggerId: string): TriggerDefinition {
    const def = this.get(triggerId);
    if (!def) throw new Error(`trigger not found: ${triggerId}`);
    return def;
  }

  create(input: unknown, files: TriggerCreateFile[] = [], opts: { enable?: boolean } = {}): TriggerDefinition {
    const now = Date.now();
    const definition = normalizeTriggerDefinition(input, { now });
    this.assertAgent(definition);
    if (opts.enable !== undefined) definition.enabled = opts.enable;
    definition.createdAt = definition.createdAt || now;
    definition.updatedAt = now;
    this.assertUnique(definition);

    const dir = this.triggerDir(definition.id);
    if (fs.existsSync(dir)) throw new Error(`trigger directory already exists: ${definition.id}`);
    fs.mkdirSync(dir, { recursive: true });
    this.writeFiles(dir, files);
    this.validateScriptFile(definition, dir);
    this.writeDefinition(definition);
    this.clearActive(definition.id);
    return definition;
  }

  update(triggerId: string, input: unknown, files: TriggerCreateFile[] = []): TriggerDefinition {
    const existing = this.require(triggerId);
    const updated = normalizeTriggerDefinition({ ...(input as Record<string, unknown>), id: triggerId }, { now: Date.now() });
    this.assertAgent(updated);
    updated.createdAt = existing.createdAt;
    updated.updatedAt = Date.now();
    this.assertUnique(updated, triggerId);

    const dir = this.triggerDir(triggerId);
    fs.mkdirSync(dir, { recursive: true });
    this.writeFiles(dir, files);
    this.validateScriptFile(updated, dir);
    this.writeDefinition(updated);
    return updated;
  }

  setEnabled(triggerId: string, enabled: boolean): TriggerDefinition {
    const definition = this.require(triggerId);
    definition.enabled = enabled;
    definition.updatedAt = Date.now();
    this.writeDefinition(definition);
    return definition;
  }

  cancel(triggerId: string): TriggerDefinition {
    return this.setEnabled(triggerId, false);
  }

  triggerDir(triggerId: string): string {
    return path.join(this.rootDir, safeRelativePath(triggerId));
  }

  definitionPath(triggerId: string): string {
    return path.join(this.triggerDir(triggerId), 'trigger.json');
  }

  activePath(triggerId: string): string {
    return path.join(this.triggerDir(triggerId), 'active.json');
  }

  clearActive(triggerId: string): void {
    const file = this.activePath(triggerId);
    try { fs.unlinkSync(file); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }

  readRawDefinition(triggerId: string): unknown {
    return JSON.parse(fs.readFileSync(this.definitionPath(triggerId), 'utf-8'));
  }

  importFromPath(inputPath: string, opts: { enable?: boolean } = {}): TriggerDefinition {
    const stat = fs.statSync(inputPath);
    const sourceDir = stat.isDirectory() ? inputPath : path.dirname(inputPath);
    const triggerJson = stat.isDirectory() ? path.join(inputPath, 'trigger.json') : inputPath;
    const definitionRaw = JSON.parse(fs.readFileSync(triggerJson, 'utf-8'));
    const definition = normalizeTriggerDefinition(definitionRaw);
    const files: TriggerCreateFile[] = [];

    if (definition.script?.path) {
      const scriptAbs = resolveScriptPath(sourceDir, definition.script.path);
      const rel = path.relative(sourceDir, scriptAbs).replace(/\\/g, '/');
      files.push({
        relativePath: rel,
        contentBase64: fs.readFileSync(scriptAbs).toString('base64'),
      });
    }
    return this.create(definition, files, opts);
  }

  private writeDefinition(definition: TriggerDefinition): void {
    const dir = this.triggerDir(definition.id);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteJson(this.definitionPath(definition.id), definition);
  }

  private listTriggerIds(): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.rootDir, { withFileTypes: true }); } catch { return []; }
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  private writeFiles(dir: string, files: TriggerCreateFile[]): void {
    for (const file of files) {
      const rel = safeRelativePath(file.relativePath);
      const target = path.resolve(dir, rel);
      const relFromRoot = path.relative(path.resolve(dir), target);
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        throw new Error(`file escapes trigger directory: ${file.relativePath}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'));
    }
  }

  private validateScriptFile(definition: TriggerDefinition, dir: string): void {
    if (!definition.script) return;
    const scriptAbs = resolveScriptPath(dir, definition.script.path);
    if (!fs.existsSync(scriptAbs)) {
      throw new Error(`script file not found: ${definition.script.path}`);
    }
    const stat = fs.statSync(scriptAbs);
    if (!stat.isFile()) throw new Error(`script.path is not a file: ${definition.script.path}`);
  }

  private assertAgent(definition: TriggerDefinition): void {
    if (definition.agentAid !== this.agentAid) {
      throw new Error(`definition.agentAid (${definition.agentAid}) does not match request agent (${this.agentAid})`);
    }
  }

  private assertUnique(definition: TriggerDefinition, existingId?: string): void {
    for (const other of this.list({ all: true })) {
      if (existingId && other.id === existingId) continue;
      if (other.id === definition.id) throw new Error(`trigger ID already exists: ${definition.id}`);
      if (other.name === definition.name) throw new Error(`trigger name already exists: ${definition.name}`);
    }
  }

  private migrateLegacyTriggers(): void {
    const legacyPath = path.join(this.rootDir, 'triggers.json');
    if (!fs.existsSync(legacyPath)) return;
    let migrated = 0;
    let skipped = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as { triggers?: Record<string, any> };
      for (const legacy of Object.values(raw.triggers ?? {})) {
        try {
          const definition = this.legacyToDefinition(legacy);
          if (!definition) { skipped += 1; continue; }
          if (fs.existsSync(this.definitionPath(definition.id))) { skipped += 1; continue; }
          if (this.list({ all: true }).some(other => other.name === definition.name)) { skipped += 1; continue; }
          this.writeDefinition(definition);
          migrated += 1;
        } catch {
          skipped += 1;
        }
      }
      const backup = path.join(this.rootDir, `triggers.legacy.migrated.${Date.now()}.json`);
      fs.renameSync(legacyPath, backup);
      if (migrated > 0 || skipped > 0) {
        logger.info(`[Trigger] migrated legacy triggers for ${this.agentAid}: migrated=${migrated}, skipped=${skipped}, backup=${backup}`);
      }
    } catch (err) {
      logger.warn(`[Trigger] failed to migrate legacy triggers for ${this.agentAid}: ${err}`);
    }
  }

  private legacyToDefinition(legacy: any): TriggerDefinition | undefined {
    if (!legacy || typeof legacy !== 'object') return undefined;
    const id = typeof legacy.id === 'string' && legacy.id ? legacy.id : undefined;
    const name = typeof legacy.name === 'string' && legacy.name ? legacy.name : undefined;
    if (!id || !name) return undefined;
    if (legacy.schedulerAid && legacy.schedulerAid !== this.agentAid) return undefined;

    let source: any;
    if (legacy.scheduleType === 'delay') {
      const afterMs = Number(legacy.scheduleValue);
      if (!Number.isFinite(afterMs) || afterMs <= 0) return undefined;
      source = { type: 'delay', afterMs };
    } else if (legacy.scheduleType === 'at') {
      source = { type: 'at', at: String(legacy.scheduleValue) };
    } else if (legacy.scheduleType === 'cron') {
      source = { type: 'cron', expression: String(legacy.scheduleValue) };
    } else {
      return undefined;
    }

    const channelType = legacy.targetChannelType || tryParseChannelKey(String(legacy.targetChannel || ''))?.type || legacy.targetChannel;
    const channelId = legacy.targetChannelId;
    if (!channelType || !channelId) return undefined;

    const sessionStrategy = legacy.targetSessionStrategy || 'latest';
    const target: any = {
      channelType: String(channelType),
      channelName: typeof legacy.targetChannel === 'string' && legacy.targetChannel ? legacy.targetChannel : undefined,
      channelId: String(channelId),
      sessionStrategy,
    };
    if (sessionStrategy === 'current') {
      if (!legacy.boundSessionId) return undefined;
      target.sessionId = legacy.boundSessionId;
    }
    if (sessionStrategy === 'thread') target.threadId = legacy.targetThreadId || `trigger-${id}`;

    return normalizeTriggerDefinition({
      $schema_version: 1,
      id,
      agentAid: this.agentAid,
      enabled: true,
      name,
      description: legacy.description,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      origin: {
        channel: legacy.createdByChannel,
        peerId: legacy.createdByPeerId,
      },
      source,
      feedback: {
        onSuccess: {
          mode: 'agent-runner',
          target,
          template: String(legacy.prompt ?? ''),
        },
        onNoop: { mode: 'none' },
        onFailure: { mode: 'none' },
      },
      reliability: {
        concurrency: 'forbid',
        missedPolicy: 'run_once',
        scriptRetry: { maxAttempts: 0, backoffMs: 30_000 },
      },
    });
  }
}

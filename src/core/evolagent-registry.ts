import fs from 'fs';
import path from 'path';
import { EvolAgent } from './evolagent.js';
import { logger } from '../utils/logger.js';
import { agentMdPath, agentPersonalDir } from '../paths.js';
import {
  loadAllAgents,
  ensureAgentDirSkeleton,
  loadAgent,
  validateAgentConfig,
} from '../config-store.js';
import { resolveEffective } from '../config/config-manager.js';
import type {
  AgentInfo,
  AgentConfig,
  EffectiveAgentConfig,
  ChannelInstance,
  ShowActivitiesMode,
} from '../types.js';

// 鈹€鈹€ Channel Fingerprint 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 鐢ㄤ簬妫€娴嬪 agent 涔嬮棿澶嶇敤鍚屼竴澶栭儴鍑瘉鐨勫啿绐侊紙appId銆乤id銆乼oken 绛夛級銆?
// 鏍煎紡锛歿type}:{primaryKey}

const PRIMARY_KEY_MAP: Record<string, string> = {
  feishu: 'appId',
  aun: '__aid__', // AUN 瀹炰緥鐨?鍑瘉"灏辨槸 agent 鑷韩 aid
  wechat: 'token',
  wecom: 'botId',
  dingtalk: 'clientId',
  qqbot: 'appId',
};

export function extractFingerprint(
  channelType: string,
  instance: ChannelInstance,
  agentAid: string
): string | null {
  const keyField = PRIMARY_KEY_MAP[channelType];
  if (!keyField) return null;
  if (keyField === '__aid__') return `${channelType}:${agentAid}`;
  const value = (instance as any)[keyField];
  if (!value || typeof value !== 'string') return null;
  return `${channelType}:${value}`;
}

export interface DuplicateReport {
  fingerprint: string;
  channelType: string;
  agents: Array<{ aid: string; channelName: string }>;
}

/**
 * 璺?agent 妫€鏌ュ悓涓€澶栭儴鍑瘉鏄惁琚娆″０鏄庯紙椋炰功 appId銆丄UN aid 绛夛級銆?
 */
export function detectDuplicates(agents: EvolAgent[]): DuplicateReport[] {
  const seen = new Map<string, DuplicateReport['agents']>();

  for (const agent of agents) {
    for (const inst of agent.config.channels) {
      const fp = extractFingerprint(inst.type, inst, agent.aid);
      if (!fp) continue;
      const arr = seen.get(fp) ?? [];
      arr.push({ aid: agent.aid, channelName: agent.effectiveChannelName(inst.type, inst.name) });
      seen.set(fp, arr);
    }
  }

  const out: DuplicateReport[] = [];
  for (const [fp, arr] of seen) {
    if (arr.length > 1) {
      const [type] = fp.split(':');
      out.push({ fingerprint: fp, channelType: type, agents: arr });
    }
  }
  return out;
}

// 鈹€鈹€ Reload hooks锛坲nchanged 鎺ュ彛锛宧ooks 璋冪敤鏂硅繕娌″垏鍒版柊缁撴瀯锛夆攢鈹€

export interface ReloadHooks {
  drainChannel(channelName: string): Promise<void>;
  disconnectChannel(channelName: string): Promise<void>;
  startChannel(agent: EvolAgent, channelName: string): Promise<void>;
  prepareHandoffReload?(aid: string): Promise<void>;
  completeHandoffReload?(aid: string): Promise<void>;
}

/**
 * 鍘嗗彶鎺ュ彛鈥斺€旀柊缁撴瀯涓嬫墍鏈夊啓鍏ラ兘鐩存帴钀藉埌 agents/<aid>/config.json锛屼笉鍐嶉渶瑕?
 * globalWriter銆傛湰鎺ュ彛淇濈暀鑷抽樁娈?2c 鍒犻櫎锛涘綋鍓嶅疄鐜帮細no-op + warning銆?
 */
export interface GlobalConfigWriter {
  setOwner(channelName: string, userId: string): void;
  setShowActivities?(channelName: string, mode: ShowActivitiesMode): void;
}

// 鈹€鈹€ Registry 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export class EvolAgentRegistry {
  private agents: Map<string, EvolAgent> = new Map();
  /** channel key (`<type>#<selfAID>#<name>`) 鈫?agent aid */
  private channelIndex: Map<string, string> = new Map();
  /** 鍚姩鏈熻 ConfigStore 璺宠繃鐨勭洰褰曪紙鍛藉悕闈炴硶 / 缂?config.json / 鏍￠獙澶辫触绛夛級 */
  private skipped: Array<{ dirName: string; reason: string }> = [];

  /**
   * agentsDir 鍙傛暟淇濈暀浣?ctor 鍏煎锛屼絾瀹為檯鍔犺浇璧?ConfigStore锛堝熀浜?paths.ts锛夈€?
   * globalWriter 宸插簾寮冣€斺€旀瀯閫犳湡鎺ュ彈浣嗗拷鐣ワ紝闃舵 2c 鍒犻櫎銆?
   */
  constructor(private _agentsDir: string, _globalWriter?: GlobalConfigWriter) {
    void _globalWriter;
  }

  setGlobalWriter(_writer: GlobalConfigWriter): void {
    void _writer; // no-op锛屽簾寮?API
  }

  /**
   * 鎵弿 agents/ 鐩綍鍔犺浇鎵€鏈?self-agent 閰嶇疆锛堝悎骞?defaults锛夛紝鏋勯€?EvolAgent
   * 瀹炰緥骞跺缓绔?channel 璺敱绱㈠紩銆?
   *
   * `globalConfig` 鍙傛暟淇濈暀浣滅鍚嶅吋瀹癸紝浣嗚蹇界暐鈥斺€攄efaults 鐢?ConfigStore 鑷繁鍔犺浇銆?
   */
  loadAll(_globalConfig?: unknown): void {
    void _globalConfig;
    this.agents.clear();
    this.channelIndex.clear();
    this.skipped = [];

    const { agents: rawAgents, skipped, invalidAgents = [] } = loadAllAgents({ includeInvalid: true });
    this.skipped = skipped;

    for (const raw of rawAgents) {
      try {
        const merged = resolveEffective({ self: raw.aid });
        const agent = new EvolAgent(raw, merged);
        ensureAgentDirSkeleton(raw.aid);
        this.agents.set(agent.aid, agent);
      } catch (e) {
        logger.warn(`[EvolAgentRegistry] failed to construct agent ${raw.aid}: ${e}`);
      }
    }

    for (const { agent: raw, reason } of invalidAgents) {
      this.registerErrorAgent(raw, reason);
    }

    this.detectAndFlagConflicts();
    this.buildChannelIndex();
  }

  private registerErrorAgent(raw: AgentConfig, reason: string): EvolAgent | null {
    try {
      const merged = this.resolveMergedForErrorAgent(raw, reason);
      const agent = new EvolAgent(raw, merged);
      agent.status = 'error';
      agent.error = reason;
      ensureAgentDirSkeleton(raw.aid);
      this.agents.set(agent.aid, agent);
      logger.warn(`[EvolAgentRegistry] loaded invalid agent ${raw.aid} as error: ${reason}`);
      return agent;
    } catch (e) {
      logger.warn(`[EvolAgentRegistry] failed to register invalid agent ${raw.aid}: ${e}`);
      return null;
    }
  }

  private resolveMergedForErrorAgent(raw: AgentConfig, reason: string): EffectiveAgentConfig {
    try {
      return resolveEffective({ self: raw.aid });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(`[EvolAgentRegistry] fallback effective config for invalid agent ${raw.aid}: ${message}; original error: ${reason}`);
      return {
        ...raw,
        $schema_version: raw.$schema_version ?? 1,
        aid: raw.aid,
        enabled: raw.enabled,
        owners: raw.owners,
        admins: raw.admins,
        channels: Array.isArray(raw.channels) ? raw.channels : [],
        active_baseagent: raw.active_baseagent,
        baseagents: raw.baseagents,
        projects: raw.projects,
        chatmode: raw.chatmode,
      };
    }
  }

  private detectAndFlagConflicts(): void {
    const dups = detectDuplicates([...this.agents.values()].filter(a => a.status !== 'error' && a.status !== 'disabled'));
    for (const d of dups) {
      const owners = d.agents.map(o => `${o.aid}(${o.channelName})`).join(', ');
      const msg = `Channel conflict: ${d.fingerprint} claimed by ${owners}`;
      logger.error(`[EvolAgentRegistry] ${msg}`);
      for (const o of d.agents) {
        const a = this.agents.get(o.aid);
        if (a && a.status !== 'error') {
          a.status = 'error';
          a.error = msg;
        }
      }
    }
  }

  private buildChannelIndex(): void {
    for (const agent of this.agents.values()) {
      if (agent.status === 'error' || agent.status === 'disabled') continue;
      for (const key of agent.channelInstanceNames()) {
        const prev = this.channelIndex.get(key);
        if (prev && prev !== agent.aid) {
          logger.warn(`[EvolAgentRegistry] channel key "${key}" claimed by both ${prev} and ${agent.aid}`);
        }
        this.channelIndex.set(key, agent.aid);
      }
    }
  }

  resolveByChannel(channelKey: string): EvolAgent | null {
    const aid = this.channelIndex.get(channelKey);
    if (!aid) return null;
    return this.agents.get(aid) ?? null;
  }

  isOwner(channelKey: string, userId: string, _globalFallback?: (ch: string, uid: string) => boolean): boolean {
    void _globalFallback;
    const agent = this.resolveByChannel(channelKey);
    return agent?.isOwner(channelKey, userId) ?? false;
  }

  isAdmin(channelKey: string, userId: string, _globalFallback?: (ch: string, uid: string) => boolean): boolean {
    void _globalFallback;
    const agent = this.resolveByChannel(channelKey);
    return agent?.isAdmin(channelKey, userId) ?? false;
  }

  getOwner(channelKey: string): string | undefined {
    return this.resolveByChannel(channelKey)?.getOwner(channelKey);
  }

  setChannelOwner(channelKey: string, userId: string): void {
    const agent = this.resolveByChannel(channelKey);
    if (!agent) {
      logger.warn(`[EvolAgentRegistry] setChannelOwner: channel "${channelKey}" not found`);
      return;
    }
    agent.setOwner(channelKey, userId);
  }

  getShowActivities(channelKey: string): ShowActivitiesMode {
    return this.resolveByChannel(channelKey)?.getShowActivities(channelKey) ?? 'all';
  }

  setShowActivities(channelKey: string, mode: ShowActivitiesMode): void {
    const agent = this.resolveByChannel(channelKey);
    if (!agent) {
      logger.warn(`[EvolAgentRegistry] setShowActivities: channel "${channelKey}" not found`);
      return;
    }
    agent.setShowActivities(channelKey, mode);
  }

  get(aidOrName: string): EvolAgent | null {
    return this.agents.get(aidOrName) ?? null;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map(a => this.toInfo(a));
  }

  invalidateAgentDisplayCache(aid: string): void {
    this.displayNameCache.delete(aid);
    this.personalNameCache.delete(aid);
    this.displayNamePending.delete(aid);
  }

  runnableAgents(): EvolAgent[] {
    return [...this.agents.values()].filter(a => a.status === 'stopped');
  }

  getSkipped(): Array<{ dirName: string; reason: string }> {
    return [...this.skipped];
  }

  loadNewAgent(aid: string): EvolAgent | null {
    if (this.agents.has(aid)) {
      logger.info(`[EvolAgentRegistry] agent ${aid} already loaded, skipping`);
      return this.agents.get(aid)!;
    }

    let raw: AgentConfig | null = null;
    try {
      raw = loadAgent(aid);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logger.warn(`[EvolAgentRegistry] loadNewAgent ${aid}: ${reason}`);
      return this.registerErrorAgent({
        $schema_version: 1,
        aid,
        enabled: true,
        channels: [],
      }, reason);
    }
    if (!raw) {
      logger.warn(`[EvolAgentRegistry] loadNewAgent: ${aid}/config.json not found`);
      return null;
    }
    const errs = validateAgentConfig(raw);
    if (errs.length > 0) {
      const reason = errs.join('; ');
      logger.warn(`[EvolAgentRegistry] loadNewAgent ${aid}: ${reason}`);
      return this.registerErrorAgent(raw, reason);
    }

    const conflict = this.checkConflictForReload(raw, aid);
    if (conflict) {
      logger.warn(`[EvolAgentRegistry] loadNewAgent ${aid}: ${conflict}`);
      return this.registerErrorAgent(raw, `Channel conflict: ${conflict}`);
    }

    const merged = resolveEffective({ self: aid });
    const agent = new EvolAgent(raw, merged);
    ensureAgentDirSkeleton(aid);
    this.agents.set(aid, agent);

    for (const key of agent.channelInstanceNames()) {
      this.channelIndex.set(key, aid);
    }

    logger.info(`[EvolAgentRegistry] Hot-loaded agent: ${aid}`);
    return agent;
  }

  async reload(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const oldAgent = this.agents.get(aidOrName);
    if (!oldAgent) throw new Error(`Agent "${aidOrName}" not found`);

    const raw = loadAgent(oldAgent.aid);
    if (!raw) throw new Error(`Agent ${oldAgent.aid}/config.json missing on reload`);
    const errs = validateAgentConfig(raw);
    if (errs.length > 0) throw new Error(`Invalid config after edit: ${errs.join('; ')}`);

    const merged = resolveEffective({ self: raw.aid });

    if (oldAgent.status === 'disabled' && raw.enabled !== false) {
      oldAgent.swapConfig(raw, merged);
      const hotLoad = (globalThis as any).__evolclaw_hotLoadAgent;
      if (!hotLoad) throw new Error(`Cannot enable agent "${aidOrName}": hot-load handler not initialized`);
      this.agents.delete(oldAgent.aid);
      this.channelIndex.clear();
      this.buildChannelIndex();
      await hotLoad(oldAgent.aid);
      logger.info(`[Reload] Agent "${aidOrName}" transitioned from disabled to enabled`);
      return;
    }

    if (oldAgent.status !== 'disabled' && raw.enabled === false) {
      await hooks.prepareHandoffReload?.(oldAgent.aid);
      for (const ch of oldAgent.channelInstanceNames()) {
        try { await hooks.drainChannel(ch); } catch {}
        try { await hooks.disconnectChannel(ch); } catch {}
      }
      oldAgent.swapConfig(raw, merged);
      oldAgent.status = 'disabled';
      this.channelIndex.clear();
      this.buildChannelIndex();
      logger.info(`[Reload] Agent "${aidOrName}" disabled`);
      return;
    }

    const conflict = this.checkConflictForReload(raw, oldAgent.aid);
    if (conflict) throw new Error(`Channel conflict: ${conflict}`);

    await hooks.prepareHandoffReload?.(oldAgent.aid);

    const oldChannels = new Set(oldAgent.channelInstanceNames());
    const aunKey = oldAgent.effectiveChannelName('aun', 'main');
    const otherKeys = raw.channels.filter(c => c.type !== 'aun').map(c => oldAgent.effectiveChannelName(c.type, c.name));
    const newChannels = new Set([aunKey, ...otherKeys]);
    const toRemove = [...oldChannels].filter(c => !newChannels.has(c));
    const toAdd = [...newChannels].filter(c => !oldChannels.has(c));
    const kept = [...oldChannels].filter(c => newChannels.has(c));

    const credentialsChanged: string[] = [];
    const trulyKept: string[] = [];
    for (const ch of kept) {
      const oldInst = oldAgent.findChannelInstance(ch);
      const newInst = findInstanceByKey(raw, oldAgent, ch);
      if (oldInst && newInst && JSON.stringify(oldInst) !== JSON.stringify(newInst)) {
        credentialsChanged.push(ch);
      } else {
        trulyKept.push(ch);
      }
    }
    toRemove.push(...credentialsChanged);
    toAdd.push(...credentialsChanged);

    const removedSuccessfully: string[] = [];
    const addedSuccessfully: string[] = [];

    try {
      for (const ch of toRemove) await hooks.drainChannel(ch);
      for (const ch of toRemove) {
        await hooks.disconnectChannel(ch);
        removedSuccessfully.push(ch);
      }

      oldAgent.swapConfig(raw, merged);
      oldAgent.invalidatePersonaCache();

      for (const ch of toAdd) {
        await hooks.startChannel(oldAgent, ch);
        addedSuccessfully.push(ch);
      }

      void trulyKept;
      oldAgent.status = 'running';
      this.channelIndex.clear();
      this.buildChannelIndex();
      await hooks.completeHandoffReload?.(oldAgent.aid);
    } catch (err) {
      logger.error(`[Reload] Failed: ${err}. Attempting rollback for "${aidOrName}".`);
      for (const ch of addedSuccessfully) {
        try { await hooks.disconnectChannel(ch); } catch {}
      }
      void removedSuccessfully;
      oldAgent.status = 'error';
      oldAgent.error = `Reload failed (rollback partial): ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  }

  async stopAgent(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const agent = this.agents.get(aidOrName);
    if (!agent) throw new Error(`Agent "${aidOrName}" not found`);
    if (agent.status === 'disabled') throw new Error('Agent is disabled; use enable/disable instead');
    if (agent.status === 'stopped') return;
    for (const ch of agent.channelInstanceNames()) {
      try { await hooks.disconnectChannel(ch); } catch {}
    }
    agent.status = 'stopped';
    this.channelIndex.clear();
    this.buildChannelIndex();
    logger.info(`[Registry] Stopped agent ${aidOrName}`);
  }

  async startAgent(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const agent = this.agents.get(aidOrName);
    if (!agent) throw new Error(`Agent "${aidOrName}" not found`);
    if (agent.status === 'disabled') throw new Error('Agent is disabled; use enable instead');
    if (agent.status === 'error') throw new Error(`Agent is in error state: ${agent.error ?? 'unknown error'}`);
    if (agent.status === 'running') return;
    for (const ch of agent.channelInstanceNames()) {
      await hooks.startChannel(agent, ch);
    }
    agent.status = 'running';
    this.channelIndex.clear();
    this.buildChannelIndex();
    logger.info(`[Registry] Started agent ${aidOrName}`);
  }

  private checkConflictForReload(newRaw: AgentConfig, excludeAid: string): string | null {
    const newFps = new Set<string>();
    for (const inst of newRaw.channels) {
      const fp = extractFingerprint(inst.type, inst, newRaw.aid);
      if (fp) newFps.add(fp);
    }
    for (const [aid, agent] of this.agents) {
      if (aid === excludeAid) continue;
      if (agent.status === 'error' || agent.status === 'disabled') continue;
      for (const inst of agent.config.channels) {
        const fp = extractFingerprint(inst.type, inst, agent.aid);
        if (fp && newFps.has(fp)) return `${fp} conflicts with agent "${aid}"`;
      }
    }
    return null;
  }

  private displayNameCache = new Map<string, string>();
  private displayNamePending = new Set<string>();

  private resolveDisplayName(aid: string): string | undefined {
    const cached = this.displayNameCache.get(aid);
    if (cached) return cached;
    try {
      const mdPath = agentMdPath(aid);
      if (fs.existsSync(mdPath)) {
        const content = fs.readFileSync(mdPath, 'utf-8');
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const nm = fm[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
          if (nm?.[1]) {
            this.displayNameCache.set(aid, nm[1]);
            return nm[1];
          }
        }
      }
    } catch {}
    if (!this.displayNamePending.has(aid)) {
      this.displayNamePending.add(aid);
      import('../aun/aid/index.js').then(({ agentmdGet }) => {
        agentmdGet(aid).then(content => {
          if (typeof content === 'string') {
            const fm = content.match(/^---\n([\s\S]*?)\n---/);
            if (fm) {
              const nm = fm[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
              if (nm?.[1]) this.displayNameCache.set(aid, nm[1]);
            }
          }
        }).catch(() => {}).finally(() => this.displayNamePending.delete(aid));
      }).catch(() => { this.displayNamePending.delete(aid); });
    }
    return undefined;
  }

  private personalNameCache = new Map<string, string | undefined>();

  private resolvePersonalName(aid: string): string | undefined {
    const cached = this.personalNameCache.get(aid);
    if (cached !== undefined) return cached;
    try {
      const personaPath = path.join(agentPersonalDir(aid), 'persona.md');
      if (fs.existsSync(personaPath)) {
        const content = fs.readFileSync(personaPath, 'utf-8');
        const bold = content.match(/我[叫是]\s*\*{1,2}(.+?)\*{1,2}/);
        if (bold?.[1]) {
          this.personalNameCache.set(aid, bold[1]);
          return bold[1];
        }
        const plain = content.match(/(?:我是|我叫)\s*([^\s（(，,。.)]+)/);
        if (plain?.[1]) {
          this.personalNameCache.set(aid, plain[1]);
          return plain[1];
        }
      }
    } catch {}
    this.personalNameCache.set(aid, undefined);
    return undefined;
  }

  private toInfo(agent: EvolAgent): AgentInfo {
    const displayName = this.resolveDisplayName(agent.aid);
    const personalName = this.resolvePersonalName(agent.aid);

    const rmConfig = agent.config.response_modes;
    const responseModePrivate = rmConfig?.default_private || 'interactive';
    const responseModeGroup = rmConfig?.default_group || 'proactive';
    const owners = Array.from(new Set(agent.config.owners ?? []));
    const channels = safeInfoValue(() => agent.channelInstanceNames(), []);
    const projectPath = safeInfoValue(() => agent.projectPath, '');
    const baseagent = safeInfoValue(() => agent.baseagent, agent.config.active_baseagent ?? '');
    const model = baseagent ? safeInfoValue(() => agent.model, undefined) : undefined;
    const effort = baseagent ? safeInfoValue(() => agent.effort, undefined) : undefined;

    return {
      name: displayName || agent.name || agent.aid,
      displayName,
      personalName,
      aid: agent.aid,
      status: agent.status,
      channels,
      projectPath,
      baseagent,
      model,
      effort,
      owners,
      lastActivity: agent.lastActivity,
      activeSessions: agent.activeSessions,
      error: agent.error,
      responseModePrivate,
      responseModeGroup,
    };
  }
}

function safeInfoValue<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function findInstanceByKey(raw: AgentConfig, agent: EvolAgent, channelKey: string): ChannelInstance | null {
  return raw.channels.find(c => agent.effectiveChannelName(c.type, c.name) === channelKey) ?? null;
}

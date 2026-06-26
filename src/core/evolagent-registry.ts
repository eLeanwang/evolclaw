import fs from 'fs';
import path from 'path';
import { EvolAgent } from './evolagent.js';
import { logger } from '../utils/logger.js';
import { agentMdPath, agentPersonalDir } from '../paths.js';
import {
  loadDefaults,
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
  DefaultsConfig,
  ChannelInstance,
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
}

/**
 * 鍘嗗彶鎺ュ彛鈥斺€旀柊缁撴瀯涓嬫墍鏈夊啓鍏ラ兘鐩存帴钀藉埌 agents/<aid>/config.json锛屼笉鍐嶉渶瑕?
 */
// 鈹€鈹€ Registry 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export class EvolAgentRegistry {
  private agents: Map<string, EvolAgent> = new Map();
  /** channel key (`<type>#<selfAID>#<name>`) 鈫?agent aid */
  private channelIndex: Map<string, string> = new Map();
  /** 鍚姩鏈熻 ConfigStore 璺宠繃鐨勭洰褰曪紙鍛藉悕闈炴硶 / 缂?config.json / 鏍￠獙澶辫触绛夛級 */
  private skipped: Array<{ dirName: string; reason: string }> = [];

  /**
   * agentsDir 鍙傛暟淇濈暀浣?ctor 鍏煎锛屼絾瀹為檯鍔犺浇璧?ConfigStore锛堝熀浜?paths.ts锛夈€?
   */
  constructor(private _agentsDir: string) {}

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

    const defaults = loadDefaults();
    const { agents: rawAgents, skipped } = loadAllAgents();
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

    this.detectAndFlagConflicts();
    this.buildChannelIndex();
  }

  private detectAndFlagConflicts(): void {
    const dups = detectDuplicates([...this.agents.values()]);
    for (const d of dups) {
      const owners = d.agents.map(o => `${o.aid}(${o.channelName})`).join(', ');
      const msg = `Channel conflict: ${d.fingerprint} claimed by ${owners}`;
      logger.error(`[EvolAgentRegistry] ${msg}`);
      // 鎶婃墍鏈夋秹鍙婄殑 agent 鏍?error锛涢涓繚鐣欎负 active 涔熶笉瀹夊叏鈥斺€旂洿鎺ュ叏閮?error
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

  // 鈹€鈹€ Lookup / Routing 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  resolveByChannel(channelKey: string): EvolAgent | null {
    const aid = this.channelIndex.get(channelKey);
    if (!aid) return null;
    return this.agents.get(aid) ?? null;
  }

  /**
   * `globalFallback` 鍙傛暟淇濈暀浣滅鍚嶅吋瀹癸紙EvolAgentRegistryHandle锛夛紝鏂扮粨鏋勪笅涓嶅啀浣跨敤銆?
   */
  getShowActivities(channelKey: string): 'all' | 'none' {
    return this.resolveByChannel(channelKey)?.getShowActivities(channelKey) ?? 'all';
  }

  setShowActivities(channelKey: string, mode: 'all' | 'none'): void {
    const agent = this.resolveByChannel(channelKey);
    if (!agent) {
      logger.warn(`[EvolAgentRegistry] setShowActivities: channel "${channelKey}" not found`);
      return;
    }
    agent.setShowActivities(channelKey, mode);
  }

  // 鈹€鈹€ Agent enumeration 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  get(aidOrName: string): EvolAgent | null {
    return this.agents.get(aidOrName) ?? null;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map(a => this.toInfo(a));
  }

  /** 鍚姩鍚庤繕鑳借窇锛坰tatus === 'stopped'锛夌殑 agents鈥斺€旂粰 AgentLoader 璧?runner 鐢ㄣ€?*/
  runnableAgents(): EvolAgent[] {
    return [...this.agents.values()].filter(a => a.status === 'stopped');
  }

  getSkipped(): Array<{ dirName: string; reason: string }> {
    return [...this.skipped];
  }

  // 鈹€鈹€ 鐑姞杞芥柊 agent 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  /**
   * 鍔ㄦ€佸姞杞戒竴涓柊 agent锛堢鐩樹笂宸叉湁 config.json 浣嗚繍琛屾椂杩樻病鍔犺浇锛夈€?
   * 杩斿洖鏂板垱寤虹殑 EvolAgent锛屾垨 null锛堝凡瀛樺湪 / 鏍￠獙澶辫触锛夈€?
   */
  loadNewAgent(aid: string): EvolAgent | null {
    if (this.agents.has(aid)) {
      logger.info(`[EvolAgentRegistry] agent ${aid} already loaded, skipping`);
      return this.agents.get(aid)!;
    }

    const raw = loadAgent(aid);
    if (!raw) {
      logger.warn(`[EvolAgentRegistry] loadNewAgent: ${aid}/config.json not found`);
      return null;
    }
    const errs = validateAgentConfig(raw);
    if (errs.length > 0) {
      logger.warn(`[EvolAgentRegistry] loadNewAgent ${aid}: ${errs.join('; ')}`);
      return null;
    }

    // Channel fingerprint 鍐茬獊妫€娴嬶紙闃叉鏂?agent 澶嶇敤宸叉湁 agent 鐨勫嚟璇侊級
    const conflict = this.checkConflictForReload(raw, aid);
    if (conflict) {
      logger.warn(`[EvolAgentRegistry] loadNewAgent ${aid}: ${conflict}`);
      return null;
    }

    const merged = resolveEffective({ self: aid });
    const agent = new EvolAgent(raw, merged);
    ensureAgentDirSkeleton(aid);
    this.agents.set(aid, agent);

    // 閲嶅缓 channel index
    for (const key of agent.channelInstanceNames()) {
      this.channelIndex.set(key, aid);
    }

    logger.info(`[EvolAgentRegistry] 鉁?Hot-loaded agent: ${aid}`);
    return agent;
  }

  // 鈹€鈹€ Reload 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  async reload(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const oldAgent = this.agents.get(aidOrName);
    if (!oldAgent) throw new Error(`Agent "${aidOrName}" not found`);

    const raw = loadAgent(oldAgent.aid);
    if (!raw) throw new Error(`Agent ${oldAgent.aid}/config.json missing on reload`);
    const errs = validateAgentConfig(raw);
    if (errs.length > 0) throw new Error(`Invalid config after edit: ${errs.join('; ')}`);

    const merged = resolveEffective({ self: raw.aid });

    // 鈹€鈹€ disabled 鈫?enabled 杞崲锛氶渶瑕佸畬鏁村惎鍔ㄦ祦绋?鈹€鈹€
    if (oldAgent.status === 'disabled' && raw.enabled !== false) {
      oldAgent.swapConfig(raw, merged);
      const hotLoad = (globalThis as any).__evolclaw_hotLoadAgent;
      if (!hotLoad) throw new Error(`Cannot enable agent "${aidOrName}": hot-load handler not initialized`);
      // 浠?registry 涓Щ闄ゆ棫鐨?disabled 瀹炰緥锛宧otLoad 浼氶噸鏂板垱寤?
      this.agents.delete(oldAgent.aid);
      this.channelIndex.clear();
      this.buildChannelIndex();
      await hotLoad(oldAgent.aid);
      logger.info(`[Reload] Agent "${aidOrName}" transitioned from disabled 鈫?enabled (full startup)`);
      return;
    }

    // 鈹€鈹€ enabled 鈫?disabled 杞崲锛氭柇寮€鎵€鏈?channel 鈹€鈹€
    if (oldAgent.status !== 'disabled' && raw.enabled === false) {
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

    const oldChannels = new Set(oldAgent.channelInstanceNames());
    // 璁＄畻鏂?channel keys锛氶殣寮?AUN + 鏄惧紡闈?AUN channels锛堜笌 channelInstanceNames 閫昏緫涓€鑷达級
    const aunKey = oldAgent.effectiveChannelName('aun', 'main');
    const otherKeys = raw.channels.filter(c => c.type !== 'aun').map(c => oldAgent.effectiveChannelName(c.type, c.name));
    const newChannels = new Set([aunKey, ...otherKeys]);
    const toRemove = [...oldChannels].filter(c => !newChannels.has(c));
    const toAdd = [...newChannels].filter(c => !oldChannels.has(c));
    const kept = [...oldChannels].filter(c => newChannels.has(c));

    // 鍑瘉鍙樺寲鐨?kept channel 褰?remove+add 澶勭悊锛堝己鍒堕噸寤轰互浣跨敤鏂板嚟璇侊級
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

      // swap config 鍚庡啀璧锋柊 channel 鈥斺€?startChannel hook 闇€瑕佺湅鍒版柊 config
      oldAgent.swapConfig(raw, merged);

      // 鐑噸杞戒篃鍒锋柊韬唤灞傜紦瀛橈紙persona / working 绛?fileCache 'agent-files:<aid>' 缁勶級锛?
      // 浣?personal 鏂囦欢鏀瑰姩缁?reload 鍗虫椂鐢熸晥锛屼笉蹇呴噸鍚€?
      oldAgent.invalidatePersonaCache();

      for (const ch of toAdd) {
        await hooks.startChannel(oldAgent, ch);
        addedSuccessfully.push(ch);
      }

      // truly kept 鐨?adapter 瀹炰緥宸茬粡鍦?oldAgent.channels 閲岋紝鏃犻渶杩佺Щ

      oldAgent.status = 'running';

      this.channelIndex.clear();
      this.buildChannelIndex();
    } catch (err) {
      logger.error(`[Reload] Failed: ${err}. Attempting rollback for "${aidOrName}".`);
      for (const ch of addedSuccessfully) {
        try { await hooks.disconnectChannel(ch); } catch { /* best effort */ }
      }
      // 杩欓噷娌℃硶 rollback 鍒版棫 raw锛堝凡缁忚 swapConfig 瑕嗙洊锛夆€斺€旇褰曢敊璇紝璁?oldAgent 杩?error 鎬?
      oldAgent.status = 'error';
      oldAgent.error = `Reload failed (rollback partial): ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  }

  // 鈹€鈹€ Stop / Start锛堣繍琛屾椂鏂繛/閲嶈繛锛屼笉鏀?config.enabled锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  async stopAgent(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const agent = this.agents.get(aidOrName);
    if (!agent) throw new Error(`Agent "${aidOrName}" not found`);
    if (agent.status === 'disabled') throw new Error(`Agent is disabled; use enable/disable instead`);
    if (agent.status === 'stopped') return;
    // 鍏堟柇寮€ AID 杩炴帴锛堜笅绾匡級锛岃鏈€佽揪鐨勬秷鎭繚鐣欏湪浜戠锛?
    // 鐒跺悗涓柇姝ｅ湪鎵ц鐨勫ぇ妯″瀷璋冪敤锛堜笉绛夊畠璺戝畬锛夈€?
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
    if (agent.status === 'disabled') throw new Error(`Agent is disabled; use enable instead`);
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

  // 鈹€鈹€ 鍙嬪ソ鍚嶇紦瀛橈紙浠庢湰鍦?agent.md 瑙ｆ瀽锛岀己澶辨椂寮傛浠庣綉缁滄媺鍙栵級鈹€鈹€
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
          if (nm?.[1]) { this.displayNameCache.set(aid, nm[1]); return nm[1]; }
        }
      }
    } catch { /* ignore */ }
    // 寮傛浠庣綉缁滄媺鍙栵紙浠呬竴娆★紝涓嶉樆濉烇級
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

  // 鈹€鈹€ personal 鍚嶇紦瀛橈紙浠?personal/persona.md 瑙ｆ瀽 "鎴戝彨**鍚嶅瓧**"锛夆攢鈹€
  private personalNameCache = new Map<string, string | undefined>();

  private resolvePersonalName(aid: string): string | undefined {
    const cached = this.personalNameCache.get(aid);
    if (cached !== undefined) return cached;
    try {
      const personaPath = path.join(agentPersonalDir(aid), 'persona.md');
      if (fs.existsSync(personaPath)) {
        const content = fs.readFileSync(personaPath, 'utf-8');
        // 1) 鍔犵矖鏍煎紡: "鎴戝彨**鍚嶅瓧**" 鎴?"鎴戞槸**鍚嶅瓧**"
        const bold = content.match(/鎴慬鍙槸]\s*\*{1,2}(.+?)\*{1,2}/);
        if (bold?.[1]) { this.personalNameCache.set(aid, bold[1]); return bold[1]; }
        // 2) 鏃犲姞绮楁牸寮? "鎴戞槸鏍栨ⅶ锛? 鈫?鍙栧埌绗竴涓垎闅旂锛堥€楀彿/鍙ュ彿/鎷彿/绌烘牸锛夊墠
        const plain = content.match(/(?:鎴戞槸|鎴戝彨)\s*([^\s锛?锛?銆?)]+)/);
        if (plain?.[1]) { this.personalNameCache.set(aid, plain[1]); return plain[1]; }
      }
    } catch { /* ignore */ }
    this.personalNameCache.set(aid, undefined);
    return undefined;
  }

  private toInfo(agent: EvolAgent): AgentInfo {
    const displayName = this.resolveDisplayName(agent.aid);
    const personalName = this.resolvePersonalName(agent.aid);

    // 瑙ｆ瀽鍝嶅簲妯″紡锛堜粠 response_modes 閰嶇疆涓鍙栵紝鏃犻厤缃椂浣跨敤绯荤粺榛樿锛?
    const rmConfig = agent.config.response_modes;
    const responseModePrivate = rmConfig?.default_private || 'interactive';
    const responseModeGroup = rmConfig?.default_group || 'proactive';

    return {
      name: displayName || agent.name || agent.aid,
      displayName,
      personalName,
      aid: agent.aid,
      status: agent.status,
      channels: agent.channelInstanceNames(),
      projectPath: agent.projectPath,
      baseagent: agent.baseagent,
      model: agent.model,
      effort: agent.effort,
      lastActivity: agent.lastActivity,
      activeSessions: agent.activeSessions,
      error: agent.error,
      responseModePrivate,
      responseModeGroup,
    };
  }
}

function findInstanceByKey(raw: AgentConfig, agent: EvolAgent, channelKey: string): ChannelInstance | null {
  return raw.channels.find(c => agent.effectiveChannelName(c.type, c.name) === channelKey) ?? null;
}

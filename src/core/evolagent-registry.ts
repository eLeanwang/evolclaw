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

// ── Channel Fingerprint ────────────────────────────────────────────────────
// 用于检测多 agent 之间复用同一外部凭证的冲突（appId、aid、token 等）。
// 格式：{type}:{primaryKey}

const PRIMARY_KEY_MAP: Record<string, string> = {
  feishu: 'appId',
  aun: '__aid__', // AUN 实例的"凭证"就是 agent 自身 aid
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
 * 跨 agent 检查同一外部凭证是否被多次声明（飞书 appId、AUN aid 等）。
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

// ── Reload hooks（unchanged 接口，hooks 调用方还没切到新结构）──

export interface ReloadHooks {
  drainChannel(channelName: string): Promise<void>;
  disconnectChannel(channelName: string): Promise<void>;
  startChannel(agent: EvolAgent, channelName: string): Promise<void>;
}

/**
 * 历史接口——新结构下所有写入都直接落到 agents/<aid>/config.json，不再需要
 * globalWriter。本接口保留至阶段 2c 删除；当前实现：no-op + warning。
 */
export interface GlobalConfigWriter {
  setOwner(channelName: string, userId: string): void;
  setShowActivities?(channelName: string, mode: 'all' | 'none'): void;
}

// ── Registry ───────────────────────────────────────────────────────────────

export class EvolAgentRegistry {
  private agents: Map<string, EvolAgent> = new Map();
  /** channel key (`<type>#<selfAID>#<name>`) → agent aid */
  private channelIndex: Map<string, string> = new Map();
  /** 启动期被 ConfigStore 跳过的目录（命名非法 / 缺 config.json / 校验失败等） */
  private skipped: Array<{ dirName: string; reason: string }> = [];

  /**
   * agentsDir 参数保留作 ctor 兼容，但实际加载走 ConfigStore（基于 paths.ts）。
   * globalWriter 已废弃——构造期接受但忽略，阶段 2c 删除。
   */
  constructor(private _agentsDir: string, _globalWriter?: GlobalConfigWriter) {
    void _globalWriter;
  }

  setGlobalWriter(_writer: GlobalConfigWriter): void {
    void _writer; // no-op，废弃 API
  }

  /**
   * 扫描 agents/ 目录加载所有 self-agent 配置（合并 defaults），构造 EvolAgent
   * 实例并建立 channel 路由索引。
   *
   * `globalConfig` 参数保留作签名兼容，但被忽略——defaults 由 ConfigStore 自己加载。
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
      // 把所有涉及的 agent 标 error；首个保留为 active 也不安全——直接全部 error
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

  // ── Lookup / Routing ─────────────────────────────────────────────────

  resolveByChannel(channelKey: string): EvolAgent | null {
    const aid = this.channelIndex.get(channelKey);
    if (!aid) return null;
    return this.agents.get(aid) ?? null;
  }

  /**
   * `globalFallback` 参数保留作签名兼容（EvolAgentRegistryHandle），新结构下不再使用。
   */
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

  // ── Agent enumeration ────────────────────────────────────────────────

  get(aidOrName: string): EvolAgent | null {
    return this.agents.get(aidOrName) ?? null;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map(a => this.toInfo(a));
  }

  /** 启动后还能跑（status === 'stopped'）的 agents——给 AgentLoader 起 runner 用。 */
  runnableAgents(): EvolAgent[] {
    return [...this.agents.values()].filter(a => a.status === 'stopped');
  }

  getSkipped(): Array<{ dirName: string; reason: string }> {
    return [...this.skipped];
  }

  // ── 热加载新 agent ──────────────────────────────────────────────────

  /**
   * 动态加载一个新 agent（磁盘上已有 config.json 但运行时还没加载）。
   * 返回新创建的 EvolAgent，或 null（已存在 / 校验失败）。
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

    // Channel fingerprint 冲突检测（防止新 agent 复用已有 agent 的凭证）
    const conflict = this.checkConflictForReload(raw, aid);
    if (conflict) {
      logger.warn(`[EvolAgentRegistry] loadNewAgent ${aid}: ${conflict}`);
      return null;
    }

    const merged = resolveEffective({ self: aid });
    const agent = new EvolAgent(raw, merged);
    ensureAgentDirSkeleton(aid);
    this.agents.set(aid, agent);

    // 重建 channel index
    for (const key of agent.channelInstanceNames()) {
      this.channelIndex.set(key, aid);
    }

    logger.info(`[EvolAgentRegistry] ✓ Hot-loaded agent: ${aid}`);
    return agent;
  }

  // ── Reload ───────────────────────────────────────────────────────────

  async reload(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const oldAgent = this.agents.get(aidOrName);
    if (!oldAgent) throw new Error(`Agent "${aidOrName}" not found`);

    const raw = loadAgent(oldAgent.aid);
    if (!raw) throw new Error(`Agent ${oldAgent.aid}/config.json missing on reload`);
    const errs = validateAgentConfig(raw);
    if (errs.length > 0) throw new Error(`Invalid config after edit: ${errs.join('; ')}`);

    const merged = resolveEffective({ self: raw.aid });

    // ── disabled → enabled 转换：需要完整启动流程 ──
    if (oldAgent.status === 'disabled' && raw.enabled !== false) {
      oldAgent.swapConfig(raw, merged);
      const hotLoad = (globalThis as any).__evolclaw_hotLoadAgent;
      if (!hotLoad) throw new Error(`Cannot enable agent "${aidOrName}": hot-load handler not initialized`);
      // 从 registry 中移除旧的 disabled 实例，hotLoad 会重新创建
      this.agents.delete(oldAgent.aid);
      this.channelIndex.clear();
      this.buildChannelIndex();
      await hotLoad(oldAgent.aid);
      logger.info(`[Reload] Agent "${aidOrName}" transitioned from disabled → enabled (full startup)`);
      return;
    }

    // ── enabled → disabled 转换：断开所有 channel ──
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
    // 计算新 channel keys：隐式 AUN + 显式非 AUN channels（与 channelInstanceNames 逻辑一致）
    const aunKey = oldAgent.effectiveChannelName('aun', 'main');
    const otherKeys = raw.channels.filter(c => c.type !== 'aun').map(c => oldAgent.effectiveChannelName(c.type, c.name));
    const newChannels = new Set([aunKey, ...otherKeys]);
    const toRemove = [...oldChannels].filter(c => !newChannels.has(c));
    const toAdd = [...newChannels].filter(c => !oldChannels.has(c));
    const kept = [...oldChannels].filter(c => newChannels.has(c));

    // 凭证变化的 kept channel 当 remove+add 处理（强制重建以使用新凭证）
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

      // swap config 后再起新 channel —— startChannel hook 需要看到新 config
      oldAgent.swapConfig(raw, merged);

      // 热重载也刷新身份层缓存（persona / working 等 fileCache 'agent-files:<aid>' 组），
      // 使 personal 文件改动经 reload 即时生效，不必重启。
      oldAgent.invalidatePersonaCache();

      for (const ch of toAdd) {
        await hooks.startChannel(oldAgent, ch);
        addedSuccessfully.push(ch);
      }

      // truly kept 的 adapter 实例已经在 oldAgent.channels 里，无需迁移

      oldAgent.status = 'running';

      this.channelIndex.clear();
      this.buildChannelIndex();
    } catch (err) {
      logger.error(`[Reload] Failed: ${err}. Attempting rollback for "${aidOrName}".`);
      for (const ch of addedSuccessfully) {
        try { await hooks.disconnectChannel(ch); } catch { /* best effort */ }
      }
      // 这里没法 rollback 到旧 raw（已经被 swapConfig 覆盖）——记录错误，让 oldAgent 进 error 态
      oldAgent.status = 'error';
      oldAgent.error = `Reload failed (rollback partial): ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  }

  // ── Stop / Start（运行时断连/重连，不改 config.enabled）──────────────────

  async stopAgent(aidOrName: string, hooks: ReloadHooks): Promise<void> {
    const agent = this.agents.get(aidOrName);
    if (!agent) throw new Error(`Agent "${aidOrName}" not found`);
    if (agent.status === 'disabled') throw new Error(`Agent is disabled; use enable/disable instead`);
    if (agent.status === 'stopped') return;
    // 先断开 AID 连接（下线），让未送达的消息保留在云端；
    // 然后中断正在执行的大模型调用（不等它跑完）。
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

  // ── 友好名缓存（从本地 agent.md 解析，缺失时异步从网络拉取）──
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
    // 异步从网络拉取（仅一次，不阻塞）
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

  // ── personal 名缓存（从 personal/persona.md 解析 "我叫**名字**"）──
  private personalNameCache = new Map<string, string | undefined>();

  private resolvePersonalName(aid: string): string | undefined {
    const cached = this.personalNameCache.get(aid);
    if (cached !== undefined) return cached;
    try {
      const personaPath = path.join(agentPersonalDir(aid), 'persona.md');
      if (fs.existsSync(personaPath)) {
        const content = fs.readFileSync(personaPath, 'utf-8');
        // 1) 加粗格式: "我叫**名字**" 或 "我是**名字**"
        const bold = content.match(/我[叫是]\s*\*{1,2}(.+?)\*{1,2}/);
        if (bold?.[1]) { this.personalNameCache.set(aid, bold[1]); return bold[1]; }
        // 2) 无加粗格式: "我是栖梧，" → 取到第一个分隔符（逗号/句号/括号/空格）前
        const plain = content.match(/(?:我是|我叫)\s*([^\s（(，,。.)]+)/);
        if (plain?.[1]) { this.personalNameCache.set(aid, plain[1]); return plain[1]; }
      }
    } catch { /* ignore */ }
    this.personalNameCache.set(aid, undefined);
    return undefined;
  }

  private toInfo(agent: EvolAgent): AgentInfo {
    const displayName = this.resolveDisplayName(agent.aid);
    const personalName = this.resolvePersonalName(agent.aid);

    // 解析响应模式（从 response_modes 配置中读取，无配置时使用系统默认）
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
      owners: agent.config.owners ?? [],
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

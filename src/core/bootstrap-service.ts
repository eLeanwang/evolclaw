import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { kitsTemplatesDir, agentMdPath } from '../paths.js';
import { logger } from '../utils/logger.js';
import { loadAgent, saveAgent } from '../config-store.js';
import { normalizeAgentLifecycle, withLifecycleForWrite } from '../config/lifecycle.js';
import { getFirstRoleAssignment } from '../config/role-assignments.js';
import { renderTemplate } from '../eck/manifest-engine.js';
import { activeBaseagent } from './model/config-scope.js';
import { buildEnvelope } from './message/message-utils.js';
import type { EventBus } from './event-bus.js';
import type { AgentConfig, ChannelAdapter, EvolAgentHandle, EvolAgentRegistryHandle } from '../types.js';

export interface BootstrapStartContext {
  adapter: ChannelAdapter;
  channelKey: string;
  channelType?: string;
  agentAid?: string;
  channelId?: string;
  recipientId?: string;
  recipientName?: string;
  source: 'connected' | 'inbound' | 'owner-bound';
}

export class BootstrapService {
  private inFlight = new Set<string>();

  constructor(
    private agentRegistry: EvolAgentRegistryHandle,
    private eventBus: EventBus,
  ) {}

  async tryStartBootstrap(ctx: BootstrapStartContext): Promise<boolean> {
    const agent = ctx.agentAid
      ? this.agentRegistry.get(ctx.agentAid)
      : this.agentRegistry.resolveByChannel(ctx.channelKey);
    const aid = agent?.aid || ctx.agentAid;
    if (!aid) return false;

    const key = aid;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);

    let lifecycleStarted = false;
    const loadedConfig = agent?.config || loadAgent(aid);
    if (!loadedConfig) {
      this.inFlight.delete(key);
      return false;
    }
    const config = normalizeAgentLifecycle(loadedConfig as AgentConfig);
    if (config.lifecycle !== 'created') {
      this.inFlight.delete(key);
      return false;
    }

    const channelType = ctx.channelType || this.channelTypeFromKey(ctx.channelKey);
    const recipientId = ctx.recipientId || this.resolveConfiguredRecipient(config, ctx.channelKey, channelType);
    if (!recipientId) {
      this.inFlight.delete(key);
      return false;
    }
    if (ctx.recipientId && recipientId !== ctx.recipientId) {
      this.inFlight.delete(key);
      return false;
    }

    const channelId = ctx.channelId || this.defaultChannelIdForConnection(channelType, recipientId);
    if (!channelId) {
      this.inFlight.delete(key);
      return false;
    }

    try {
      const agentName = this.resolveAgentDisplayName(aid);
      const baseagent = this.resolveBaseagent(agent, aid);
      await this.publishAgentMdIfSupported(ctx.adapter, aid, agentName);
      this.setLifecycle(agent, aid, 'bootstrapping');
      lifecycleStarted = true;

      const text = this.renderWelcome({
        agentAid: aid,
        agentName,
        ownerName: ctx.recipientName || recipientId,
        channel: channelType || ctx.channelKey,
        baseagent,
      });

      await ctx.adapter.send(
        buildEnvelope({
          taskId: `bootstrap-${randomBytes(5).toString('hex')}`,
          channel: ctx.adapter.channelKey || ctx.adapter.channelName,
          channelId,
          agentName: aid,
        }),
        { kind: 'result.text', text, isFinal: true },
      );

      this.eventBus.publish({ type: 'agent:bootstrap-started', aid, channel: channelType || ctx.channelKey, timestamp: Date.now() });

      await this.sendAunBindingCredentialIfSupported(ctx.adapter, recipientId, agentName, baseagent);
      logger.info(`[Bootstrap] Started for ${aid} via ${ctx.channelKey} (${ctx.source})`);
      return true;
    } catch (e) {
      if (lifecycleStarted) {
        try {
          this.setLifecycle(agent, aid, 'created');
        } catch (rollbackErr) {
          logger.warn(`[Bootstrap] Failed to roll back lifecycle for ${aid}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        }
      }
      logger.warn(`[Bootstrap] Failed to start for ${aid} via ${ctx.channelKey}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private setLifecycle(agent: EvolAgentHandle | null, aid: string, lifecycle: 'created' | 'bootstrapping'): void {
    if (agent?.setLifecycle) {
      agent.setLifecycle(lifecycle);
      return;
    }
    const cfg = loadAgent(aid);
    if (!cfg) return;
    saveAgent(withLifecycleForWrite(cfg, lifecycle) as AgentConfig);
  }

  private resolveConfiguredRecipient(config: AgentConfig, _channelKey: string, _channelType?: string): string | undefined {
    return getFirstRoleAssignment(config.aid, { scope: 'private', role: 'owner' })?.peerId
      || config.owners?.[0];
  }

  private defaultChannelIdForConnection(channelType: string | undefined, recipientId: string): string | undefined {
    if (channelType === 'aun') return recipientId;
    if (channelType === 'feishu') return recipientId;
    return undefined;
  }

  private channelTypeFromKey(channelKey: string): string | undefined {
    return this.parseChannelKey(channelKey)?.type;
  }

  private parseChannelKey(channelKey: string): { type: string; name: string } | null {
    const parts = channelKey.split('#');
    if (parts.length < 3) return null;
    return { type: parts[0], name: parts.slice(2).join('#') };
  }

  private renderWelcome(vars: Record<string, string>): string {
    const templatePath = path.join(kitsTemplatesDir(), 'bootstrap-welcome.md');
    const template = fs.existsSync(templatePath)
      ? fs.readFileSync(templatePath, 'utf-8')
      : '你好，我是 {{agentName}}。请帮我确认显示名、简介和标签。';
    return renderTemplate(template, vars).trim();
  }

  private resolveAgentDisplayName(aid: string): string {
    try {
      const content = fs.readFileSync(agentMdPath(aid), 'utf-8');
      const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      const name = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
      if (name) return name;
    } catch {}
    return aid.split('.')[0];
  }

  private resolveBaseagent(agent: EvolAgentHandle | null, aid: string): string {
    try {
      return agent?.baseagent || activeBaseagent(aid);
    } catch {
      return 'unknown';
    }
  }

  private async publishAgentMdIfSupported(adapter: ChannelAdapter, aid: string, fallbackName: string): Promise<void> {
    if (typeof adapter.uploadAgentMd !== 'function') return;
    const existing = fs.existsSync(agentMdPath(aid)) ? fs.readFileSync(agentMdPath(aid), 'utf-8') : '';
    const content = existing.trim() || `---\naid: "${aid}"\nname: "${fallbackName}"\ntype: "codeagent"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\n  - ai-agent\n---\n`;
    try {
      await adapter.uploadAgentMd(content);
      logger.info(`[Bootstrap] Published agent.md for ${aid}`);
    } catch (e) {
      logger.warn(`[Bootstrap] Failed to publish agent.md for ${aid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async sendAunBindingCredentialIfSupported(adapter: ChannelAdapter, owner: string, name: string, baseagent: string): Promise<void> {
    const sendBinding = (adapter as any)._sendBindingCredential;
    if (typeof sendBinding !== 'function') return;
    try {
      await sendBinding(owner, name, baseagent);
    } catch (e) {
      logger.warn(`[Bootstrap] Binding credential failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

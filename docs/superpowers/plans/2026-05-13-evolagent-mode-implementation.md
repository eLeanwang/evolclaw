# EvolAgent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce EvolAgent as a first-class entity — one JSON file (`~/.evolclaw/agents/*.json`) self-contains a complete agent (channels + baseagent + project + chatmode). Multiple agents run concurrently, each owning their channels. DefaultAgent falls back to `evolclaw.json` channels. Provides `evolclaw agent` CLI for lifecycle, hot reload, and owner-binding persistence to agent.json.

**Architecture:** Add `EvolAgent` class + `AgentRegistry` singleton. `MessageProcessor` queries registry by channelName to get `AgentContext`. `CommandHandler` reads `isOwned` to block locked commands. `ChannelLoader.createAll()` is called once per config source (default + each agent). Owner writes route via `setOwner()` internal dispatch based on which agent owns the channel. Hot reload implemented via IPC with full drain→disconnect→reconnect→route-update cycle.

**Tech Stack:** TypeScript (ES modules), vitest, node:sqlite. Reuses existing `ChannelLoader`, `init-channel.ts`, `IPC` modules.

**Prerequisites:** Tasks 1-4 of `2026-05-13-evolagent-prerequisite-refactor.md` (Channel Fingerprint, ChannelLoader idempotency tests, orphan session count, baseagent key rename + migration) already landed.

---

## Task Overview

| # | Task | Deliverable |
|---|---|---|
| T1 | Types + schema | EvolAgentConfig / AgentContext / AgentInfo types; JSON schema validation |
| T2 | EvolAgent class | Load/validate/getContext per channel |
| T3 | AgentRegistry | Scan dir, conflict detect, resolve, list |
| T4 | init-channel refactor | Decouple "write evolclaw.json" from "produce credential object" |
| T5 | Startup wiring | Multi-source createAll() + registry binding |
| T6 | MessageProcessor integration | Inject registry, resolve AgentContext |
| T7 | CommandHandler integration | isOwned-based command blocking |
| T8 | setOwner routing | Write to agent.json or evolclaw.json based on ownership |
| T9 | CLI `evolclaw agent` | list/show/new/reload via IPC |
| T10 | IPC server handlers | evolagent query + reload endpoints |
| T11 | Full hot reload | drain + disconnect + reconnect + route-update |
| T12 | E2E integration test | tmp agent.json + mock channel → verify routing |
| T13 | Docs update | CLAUDE.md evolagent section |

**Total estimated scope:** ~1400 new lines + ~300 refactor + ~500 tests.

**Phased execution (non-disruptive, progressive delivery):**

```
Phase 1（纯新增，零风险，不影响现有服务）：
  T1 → T2 → T3 → T4 → T9(cold mode + agent new)
  交付物：用户可 `evolclaw agent new` 创建 + `evolclaw agent` 查看列表

Phase 2（激活点，agents 目录有文件时生效）：
  T5 → T6 → T7 → T8 → T10 → T11
  交付物：agent 真正运行，消息路由、命令拦截、热重载全部就位

Phase 3（收尾）：
  T12 → T13
  交付物：E2E 测试 + 文档
```

Each task produces compiling, testable code. Phase 1 can be deployed to production immediately — evolagent features are inert until Phase 2 activates them.

---

### Task 1: Types and Schema

**Files:**
- Modify: `src/types.ts` — add `EvolAgentConfig`, `AgentContext`, `AgentInfo`, `AgentStatus` types
- Create: `src/core/evolagent-schema.ts` — runtime validation of agent.json
- Create: `tests/unit/evolagent-schema.test.ts`

- [ ] **Step 1: Write failing test for schema validation**

Create `tests/unit/evolagent-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateEvolAgentConfig } from '../../src/core/evolagent-schema.js';

describe('validateEvolAgentConfig', () => {
  it('accepts a minimal valid config', () => {
    const config = {
      name: 'review-bot',
      agents: { claude: { model: 'sonnet' } },
      channels: { feishu: [{ name: 'feishu-review', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/home/user/review' },
    };
    const result = validateEvolAgentConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing name', () => {
    const result = validateEvolAgentConfig({
      agents: { claude: {} },
      channels: {},
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/name/);
  });

  it('rejects multiple baseagent blocks', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {}, codex: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/single baseagent|exactly one/i);
  });

  it('rejects empty channels', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {} },
      channels: {},
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/channel/);
  });

  it('rejects non-absolute projects.defaultPath', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: 'relative/path' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/absolute/);
  });

  it('accepts optional chatmode block', () => {
    const result = validateEvolAgentConfig({
      name: 'ok',
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
      chatmode: { private: 'interactive', group: 'proactive' },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid chatmode values', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
      chatmode: { private: 'weird' },
    });
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/unit/evolagent-schema.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Add types to src/types.ts**

Add to `src/types.ts` (find a natural place after existing Config types):

```typescript
// ── EvolAgent ──

export interface EvolAgentConfig {
  name: string;
  enabled?: boolean;
  agents: Record<string, any>;
  channels: Record<string, any>;
  projects: { defaultPath: string };
  chatmode?: { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };
}

export interface AgentContext {
  name: string;
  isOwned: boolean;
  baseagent: string;
  model?: string;
  effort?: string;
  chatMode: 'interactive' | 'proactive';
  projectPath: string;
}

export type AgentStatus = 'running' | 'stopped' | 'disabled' | 'error';

export interface AgentInfo {
  name: string;
  status: AgentStatus;
  channels: string[];
  projectPath: string;
  baseagent: string;
  lastActivity?: number;
  activeSessions?: number;
  error?: string;
  isDefault?: boolean;
}
```

- [ ] **Step 4: Create src/core/evolagent-schema.ts**

```typescript
import path from 'path';
import type { EvolAgentConfig } from '../types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_BASEAGENTS = new Set(['claude', 'codex', 'gemini']);
const VALID_CHANNEL_TYPES = new Set(['feishu', 'aun', 'wechat', 'wecom', 'dingtalk', 'qqbot']);
const VALID_CHATMODES = new Set(['interactive', 'proactive']);

export function validateEvolAgentConfig(raw: any): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }

  // name
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }

  // enabled
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled must be a boolean if present');
  }

  // agents — exactly one baseagent key from the valid set
  if (!raw.agents || typeof raw.agents !== 'object') {
    errors.push('agents must be an object with exactly one baseagent block');
  } else {
    const keys = Object.keys(raw.agents).filter(k => VALID_BASEAGENTS.has(k));
    const unknownKeys = Object.keys(raw.agents).filter(k => !VALID_BASEAGENTS.has(k));
    if (unknownKeys.length > 0) {
      errors.push(`agents contains unknown baseagent keys: ${unknownKeys.join(', ')}`);
    }
    if (keys.length === 0) {
      errors.push('agents must contain exactly one of: claude | codex | gemini');
    } else if (keys.length > 1) {
      errors.push(`agents must contain exactly one baseagent (single baseagent only), got: ${keys.join(', ')}`);
    }
  }

  // channels — at least one channel type present
  if (!raw.channels || typeof raw.channels !== 'object') {
    errors.push('channels is required');
  } else {
    const channelKeys = Object.keys(raw.channels);
    if (channelKeys.length === 0) {
      errors.push('channels must contain at least one channel type');
    }
    for (const key of channelKeys) {
      if (!VALID_CHANNEL_TYPES.has(key)) {
        errors.push(`unknown channel type: ${key}`);
      }
    }
  }

  // projects
  if (!raw.projects || typeof raw.projects !== 'object') {
    errors.push('projects is required');
  } else {
    const p = raw.projects.defaultPath;
    if (typeof p !== 'string' || p === '') {
      errors.push('projects.defaultPath is required');
    } else if (!path.isAbsolute(p)) {
      errors.push(`projects.defaultPath must be absolute, got: ${p}`);
    }
  }

  // chatmode (optional)
  if (raw.chatmode !== undefined) {
    if (typeof raw.chatmode !== 'object' || raw.chatmode === null) {
      errors.push('chatmode must be an object if present');
    } else {
      for (const key of ['private', 'group']) {
        const val = raw.chatmode[key];
        if (val !== undefined && !VALID_CHATMODES.has(val)) {
          errors.push(`chatmode.${key} must be 'interactive' or 'proactive'`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -- tests/unit/evolagent-schema.test.ts`
Expected: 7 PASS

- [ ] **Step 6: Build verification**

Run: `npm run build`
Expected: no TS errors

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/core/evolagent-schema.ts tests/unit/evolagent-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(types): add EvolAgent types and JSON schema validation

T1 of evolagent mode implementation:
- EvolAgentConfig / AgentContext / AgentInfo types in src/types.ts
- validateEvolAgentConfig() in src/core/evolagent-schema.ts (7 validation rules)
- Unit tests covering minimal valid config and each rejection case

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: EvolAgent class

**Files:**
- Create: `src/core/evolagent.ts`
- Create: `tests/unit/evolagent.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/evolagent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EvolAgent } from '../../src/core/evolagent.js';

describe('EvolAgent', () => {
  const baseConfig = {
    name: 'review-bot',
    enabled: true,
    agents: { claude: { model: 'opus' } },
    channels: { feishu: [{ name: 'feishu-review', appId: 'a', appSecret: 'b' }] },
    projects: { defaultPath: '/home/user/review' },
  };

  it('constructs from valid config', () => {
    const agent = new EvolAgent('/path/to/review-bot.json', baseConfig);
    expect(agent.name).toBe('review-bot');
    expect(agent.status).toBe('stopped');
    expect(agent.isDefault).toBe(false);
    expect(agent.baseagent).toBe('claude');
  });

  it('getContext returns correct defaults for agent-owned channel', () => {
    const agent = new EvolAgent('/path/review-bot.json', baseConfig);
    const ctx = agent.getContext('feishu-review', 'private');
    expect(ctx.name).toBe('review-bot');
    expect(ctx.isOwned).toBe(true);
    expect(ctx.baseagent).toBe('claude');
    expect(ctx.model).toBe('opus');
    expect(ctx.projectPath).toBe('/home/user/review');
    expect(ctx.chatMode).toBe('interactive'); // default when chatmode block absent
  });

  it('resolves chatmode by chatType from agent config', () => {
    const config = { ...baseConfig, chatmode: { private: 'proactive' as const, group: 'interactive' as const } };
    const agent = new EvolAgent('/path/review.json', config);
    expect(agent.getContext('feishu-review', 'private').chatMode).toBe('proactive');
    expect(agent.getContext('feishu-review', 'group').chatMode).toBe('interactive');
  });

  it('falls back to global chatmode when agent chatmode absent', () => {
    const agent = new EvolAgent('/path/review.json', baseConfig);
    const globalChatmode = { private: 'interactive' as const, group: 'proactive' as const };
    expect(agent.getContext('feishu-review', 'group', globalChatmode).chatMode).toBe('proactive');
  });

  it('DefaultAgent flag exposed via isDefault', () => {
    const agent = new EvolAgent(null, baseConfig, { isDefault: true });
    expect(agent.isDefault).toBe(true);
    expect(agent.getContext('any', 'private').isOwned).toBe(false);
  });

  it('enabled: false reflected in status', () => {
    const agent = new EvolAgent('/path', { ...baseConfig, enabled: false });
    expect(agent.status).toBe('disabled');
  });

  it('lists channel instance names', () => {
    const agent = new EvolAgent('/path', baseConfig);
    expect(agent.channelInstanceNames()).toEqual(['feishu-review']);
  });

  it('handles object-form channel with default name', () => {
    const config = {
      ...baseConfig,
      channels: { aun: { aid: 'review.agentid.pub', owner: 'owner.agentid.pub' } },
    };
    const agent = new EvolAgent('/path', config);
    expect(agent.channelInstanceNames()).toEqual(['aun']);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/unit/evolagent.test.ts`

- [ ] **Step 3: Implement EvolAgent**

Create `src/core/evolagent.ts`:

```typescript
import type { EvolAgentConfig, AgentContext, AgentStatus, ChannelAdapter } from '../types.js';

type GlobalChatmode = { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };

export interface EvolAgentOptions {
  isDefault?: boolean;
}

export class EvolAgent {
  readonly name: string;
  readonly configPath: string | null; // null for DefaultAgent
  readonly config: EvolAgentConfig;
  readonly isDefault: boolean;

  // Runtime state (populated after binding)
  readonly channels: Map<string, ChannelAdapter> = new Map();
  activeSessions: number = 0;
  lastActivity?: number;
  status: AgentStatus;
  error?: string;

  constructor(configPath: string | null, config: EvolAgentConfig, opts: EvolAgentOptions = {}) {
    this.configPath = configPath;
    this.config = config;
    this.name = config.name;
    this.isDefault = opts.isDefault === true;
    this.status = config.enabled === false ? 'disabled' : 'stopped';
  }

  /** Runner name derived from sole key in agents block */
  get baseagent(): string {
    const keys = Object.keys(this.config.agents);
    return keys[0] || 'claude';
  }

  get model(): string | undefined {
    return this.config.agents[this.baseagent]?.model;
  }

  get effort(): string | undefined {
    return this.config.agents[this.baseagent]?.effort;
  }

  get projectPath(): string {
    return this.config.projects.defaultPath;
  }

  /** Channel instance names owned by this agent */
  channelInstanceNames(): string[] {
    const names: string[] = [];
    for (const [type, raw] of Object.entries(this.config.channels || {})) {
      const instances = Array.isArray(raw) ? raw : [raw];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        names.push((inst as any).name ?? type);
      }
    }
    return names;
  }

  /**
   * Build AgentContext for a given channel + chatType.
   * globalChatmode is evolclaw.json's chatmode, used as fallback when agent.chatmode absent.
   */
  getContext(channelName: string, chatType: string, globalChatmode?: GlobalChatmode): AgentContext {
    const chatMode = this.resolveChatMode(chatType, globalChatmode);
    return {
      name: this.name,
      isOwned: !this.isDefault,
      baseagent: this.baseagent,
      model: this.model,
      effort: this.effort,
      chatMode,
      projectPath: this.projectPath,
    };
  }

  private resolveChatMode(
    chatType: string,
    globalChatmode?: GlobalChatmode
  ): 'interactive' | 'proactive' {
    const agentCm = this.config.chatmode;
    const key = chatType === 'group' ? 'group' : 'private';
    // Whole-object inheritance: if agent has chatmode block, use it (filling gaps with 'interactive')
    if (agentCm) {
      return (agentCm[key] || 'interactive');
    }
    if (globalChatmode) {
      return (globalChatmode[key] || 'interactive');
    }
    return 'interactive';
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- tests/unit/evolagent.test.ts`
Expected: 8 PASS

- [ ] **Step 5: Build**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/core/evolagent.ts tests/unit/evolagent.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add EvolAgent class

T2 of evolagent mode implementation:
- EvolAgent constructs from config + configPath, holds runtime state
- getContext(channel, chatType, globalChatmode?) returns AgentContext
- Whole-object chatmode inheritance: agent.chatmode present → use it, absent → fallback to global
- isDefault flag exposes DefaultAgent, drives isOwned in context
- channelInstanceNames() enumerates owned channels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: AgentRegistry

**Files:**
- Create: `src/core/agent-registry.ts`
- Create: `tests/unit/agent-registry.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/agent-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import type { Config } from '../../src/types.js';

describe('AgentRegistry', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-registry-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, config: any): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.json`), JSON.stringify(config, null, 2));
  }

  function baseConfig(name: string, appId: string) {
    return {
      name,
      agents: { claude: {} },
      channels: { feishu: [{ name: `${name}-fs`, appId, appSecret: 's' }] },
      projects: { defaultPath: '/home/user/p' },
    };
  }

  function globalConfig(): Config {
    return {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: { feishu: [{ name: 'default-fs', appId: 'default-id', appSecret: 's' }] },
      projects: { defaultPath: '/home/user/default' },
    } as any;
  }

  it('loads valid agents from directory', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    writeAgent('scrum', baseConfig('scrum', 'app-scrum'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const names = list.map(i => i.name).sort();
    expect(names).toContain('review');
    expect(names).toContain('scrum');
    expect(names).toContain('[default]');
  });

  it('resolves by channel instance name', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const agent = reg.resolveByChannel('review-fs');
    expect(agent?.name).toBe('review');
    expect(agent?.isDefault).toBe(false);
  });

  it('resolves default channel to DefaultAgent', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const agent = reg.resolveByChannel('default-fs');
    expect(agent?.isDefault).toBe(true);
  });

  it('flags agents with fingerprint conflicts', () => {
    writeAgent('a', baseConfig('a', 'shared-app'));
    writeAgent('b', baseConfig('b', 'shared-app'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const a = list.find(i => i.name === 'a')!;
    const b = list.find(i => i.name === 'b')!;
    expect(a.status).toBe('error');
    expect(b.status).toBe('error');
    expect(a.error).toMatch(/conflict/i);
  });

  it('skips agents with invalid schema', () => {
    writeAgent('bad', { name: 'bad' }); // missing required fields
    writeAgent('good', baseConfig('good', 'app-good'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const bad = list.find(i => i.name === 'bad');
    const good = list.find(i => i.name === 'good');
    expect(bad?.status).toBe('error');
    expect(good?.status).toBe('stopped');
  });

  it('disabled agents have status=disabled', () => {
    writeAgent('quiet', { ...baseConfig('quiet', 'app-quiet'), enabled: false });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const info = reg.list().find(i => i.name === 'quiet');
    expect(info?.status).toBe('disabled');
  });

  it('handles empty agents directory (only DefaultAgent)', () => {
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });

  it('handles missing agents directory gracefully', () => {
    const missingDir = path.join(tmpDir, 'nonexistent');
    const reg = new AgentRegistry(missingDir);
    expect(() => reg.loadAll(globalConfig())).not.toThrow();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });

  it('detects conflict between agent and default channel', () => {
    writeAgent('a', baseConfig('a', 'default-id')); // collides with default's appId

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const a = reg.list().find(i => i.name === 'a');
    expect(a?.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npm test -- tests/unit/agent-registry.test.ts`

- [ ] **Step 3: Implement AgentRegistry**

Create `src/core/agent-registry.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { EvolAgent } from './evolagent.js';
import { validateEvolAgentConfig } from './evolagent-schema.js';
import { extractFingerprint } from '../utils/channel-fingerprint.js';
import { logger } from '../utils/logger.js';
import type { Config, AgentInfo, EvolAgentConfig } from '../types.js';

export class AgentRegistry {
  private agents: Map<string, EvolAgent> = new Map();
  private defaultAgent: EvolAgent | null = null;
  private channelIndex: Map<string, string> = new Map(); // channelName → agentName

  constructor(private agentsDir: string) {}

  loadAll(globalConfig: Config): void {
    this.agents.clear();
    this.channelIndex.clear();

    // 1. Load all agent.json files
    const files = fs.existsSync(this.agentsDir)
      ? fs.readdirSync(this.agentsDir).filter(f => f.endsWith('.json'))
      : [];

    for (const file of files) {
      const fullPath = path.join(this.agentsDir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const validation = validateEvolAgentConfig(raw);
        if (!validation.valid) {
          const errorAgent = new EvolAgent(fullPath, raw as EvolAgentConfig);
          errorAgent.status = 'error';
          errorAgent.error = validation.errors.join('; ');
          this.agents.set(raw.name || file, errorAgent);
          logger.warn(`[AgentRegistry] ${file}: ${validation.errors.join('; ')}`);
          continue;
        }
        const agent = new EvolAgent(fullPath, raw as EvolAgentConfig);
        this.agents.set(agent.name, agent);
      } catch (e) {
        logger.warn(`[AgentRegistry] Failed to load ${file}: ${e}`);
      }
    }

    // 2. Build DefaultAgent from globalConfig
    this.defaultAgent = this.buildDefaultAgent(globalConfig);

    // 3. Fingerprint conflict detection across all agents + default
    this.detectAndFlagConflicts(globalConfig);

    // 4. Build channel index (excluding errored agents)
    this.buildChannelIndex();
  }

  private buildDefaultAgent(globalConfig: Config): EvolAgent {
    const cfg: EvolAgentConfig = {
      name: '[default]',
      enabled: true,
      agents: this.deriveDefaultAgentBlock(globalConfig),
      channels: (globalConfig.channels as any) || {},
      projects: { defaultPath: globalConfig.projects?.defaultPath || process.cwd() },
      chatmode: (globalConfig as any).chatmode,
    };
    return new EvolAgent(null, cfg, { isDefault: true });
  }

  private deriveDefaultAgentBlock(globalConfig: Config): Record<string, any> {
    const agents: any = globalConfig.agents || {};
    const defaultName = agents.defaultAgent || 'claude';
    return { [defaultName]: agents[defaultName] || {} };
  }

  private detectAndFlagConflicts(globalConfig: Config): void {
    // Build fingerprint map: fingerprint → [agentName, instanceName]
    const seen = new Map<string, Array<{ agent: string; instance: string }>>();

    const record = (agentName: string, channelsBlock: any): void => {
      for (const [type, raw] of Object.entries(channelsBlock || {})) {
        if (type === 'defaultChannel') continue;
        const instances = Array.isArray(raw) ? raw : [raw];
        for (const inst of instances) {
          if (!inst || typeof inst !== 'object') continue;
          const fp = extractFingerprint(type, inst as any);
          if (!fp) continue;
          const instName = (inst as any).name ?? type;
          const entry = seen.get(fp) || [];
          entry.push({ agent: agentName, instance: instName });
          seen.set(fp, entry);
        }
      }
    };

    for (const agent of this.agents.values()) {
      if (agent.status === 'error') continue;
      record(agent.name, agent.config.channels);
    }
    if (this.defaultAgent) {
      record(this.defaultAgent.name, this.defaultAgent.config.channels);
    }

    // Flag conflicts
    for (const [fp, occurrences] of seen) {
      if (occurrences.length <= 1) continue;
      const involvedAgentNames = [...new Set(occurrences.map(o => o.agent))];
      const msg = `Channel conflict: ${fp} claimed by ${occurrences.map(o => `${o.agent}(${o.instance})`).join(', ')}`;
      for (const name of involvedAgentNames) {
        if (name === '[default]') continue; // don't mark default as error; agents lose instead
        const a = this.agents.get(name);
        if (a) {
          a.status = 'error';
          a.error = msg;
        }
      }
      logger.error(`[AgentRegistry] ${msg}`);
    }
  }

  private buildChannelIndex(): void {
    for (const agent of this.agents.values()) {
      if (agent.status === 'error' || agent.status === 'disabled') continue;
      for (const name of agent.channelInstanceNames()) {
        this.channelIndex.set(name, agent.name);
      }
    }
    if (this.defaultAgent) {
      for (const name of this.defaultAgent.channelInstanceNames()) {
        if (this.channelIndex.has(name)) continue; // agent won already
        this.channelIndex.set(name, '[default]');
      }
    }
  }

  resolveByChannel(channelName: string): EvolAgent | null {
    const agentName = this.channelIndex.get(channelName);
    if (!agentName) return null;
    if (agentName === '[default]') return this.defaultAgent;
    return this.agents.get(agentName) || null;
  }

  get(name: string): EvolAgent | null {
    if (name === '[default]') return this.defaultAgent;
    return this.agents.get(name) || null;
  }

  list(): AgentInfo[] {
    const result: AgentInfo[] = [];
    for (const agent of this.agents.values()) {
      result.push(this.toInfo(agent));
    }
    if (this.defaultAgent) {
      result.push(this.toInfo(this.defaultAgent));
    }
    return result;
  }

  private toInfo(agent: EvolAgent): AgentInfo {
    return {
      name: agent.name,
      status: agent.status,
      channels: agent.channelInstanceNames(),
      projectPath: agent.projectPath,
      baseagent: agent.baseagent,
      lastActivity: agent.lastActivity,
      activeSessions: agent.activeSessions,
      error: agent.error,
      isDefault: agent.isDefault,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/unit/agent-registry.test.ts`
Expected: 9 PASS

- [ ] **Step 5: Build**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-registry.ts tests/unit/agent-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add AgentRegistry

T3 of evolagent mode implementation:
- AgentRegistry scans ~/.evolclaw/agents/*.json, validates each
- Fingerprint conflict detection marks involved agents as error
- DefaultAgent built from evolclaw.json
- resolveByChannel() routes by channel instance name
- list() returns AgentInfo snapshot for CLI display

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: init-channel refactor

**Files:**
- Modify: `src/utils/init-channel.ts`
- Create: `tests/unit/init-channel-refactor.test.ts`

**Purpose:** Extract credential-producing logic from evolclaw.json-writing logic. `agent new` needs to capture credentials and write to agent.json instead. Existing `evolclaw init` flow must keep working.

- [ ] **Step 1: Read existing init-channel.ts to understand shape**

Read: `src/utils/init-channel.ts` (full file)

Identify each `initFeishu()`, `initWechat()`, `initAun()`, etc. Determine:
- Which functions do interactive prompts + return credentials
- Which functions write to evolclaw.json directly

- [ ] **Step 2: Write failing test for new signatures**

Create `tests/unit/init-channel-refactor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { collectFeishuCredentials, collectWechatCredentials } from '../../src/utils/init-channel.js';

describe('init-channel credential collectors', () => {
  it('collectFeishuCredentials returns credential object without writing config', async () => {
    // Mock prompt: provide appId + appSecret
    const answers = { appId: 'cli_test', appSecret: 'secret_test' };
    const creds = await collectFeishuCredentials({
      name: 'my-feishu',
      prompt: async (q: string) => answers[q as keyof typeof answers] ?? '',
      skipQR: true,
    });
    expect(creds).toEqual({
      name: 'my-feishu',
      enabled: true,
      appId: 'cli_test',
      appSecret: 'secret_test',
    });
  });
});
```

Note: Actual signatures depend on existing code shape. Adjust the test based on what's there. Key assertion: collectors return objects, do not write evolclaw.json.

- [ ] **Step 3: Refactor init-channel.ts**

For each channel type, extract a `collectXCredentials(opts)` function that:
- Runs interactive prompts (or accepts injected `prompt` for testing)
- Returns the credential object (shape matching evolclaw.json channel instance)
- Does NOT write to evolclaw.json

Keep existing `initFeishu()` / `initWechat()` etc. functions as thin wrappers that call `collectX…` + write to evolclaw.json.

Existing behavior of `evolclaw init feishu` must be byte-compatible (regression test via `npm test`).

- [ ] **Step 4: Run tests**

Run: `npm test` (full suite; existing init tests + new refactor test)
Expected: no regression, new tests pass

- [ ] **Step 5: Build**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/utils/init-channel.ts tests/unit/init-channel-refactor.test.ts
git commit -m "$(cat <<'EOF'
refactor(init-channel): decouple credential collection from config write

T4 of evolagent mode implementation:
- Extract collectXCredentials() per channel type (returns credential object)
- Existing initX() functions become thin wrappers (collect + write)
- Enables agent new to capture credentials and write to agent.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Startup wiring

**Files:**
- Modify: `src/index.ts`
- Modify: `src/paths.ts` (add `agentsDir` path)

- [ ] **Step 1: Add agentsDir to paths.ts**

Modify `resolvePaths()` to include `agentsDir: path.join(root, 'agents')`. Ensure `ensureDataDirs()` creates it.

- [ ] **Step 2: Wire AgentRegistry into startup**

In `src/index.ts` (the `main()` function):

After `loadConfig()` returns, before `channelLoader.createAll()`:

```typescript
const paths = resolvePaths();
const agentRegistry = new AgentRegistry(paths.agentsDir);
agentRegistry.loadAll(config);

// Log agent summary
const agentInfos = agentRegistry.list();
logger.info(`✓ Loaded ${agentInfos.length - 1} evolagent(s) + DefaultAgent`);
for (const info of agentInfos) {
  if (info.status === 'error') {
    logger.error(`  ✗ [${info.name}] ${info.error}`);
  } else if (info.status === 'disabled') {
    logger.info(`  ○ [${info.name}] disabled`);
  } else {
    logger.info(`  ● [${info.name}] ${info.baseagent} @ ${info.projectPath}`);
  }
}
```

Replace the single `channelLoader.createAll(config)` call with multiple:

```typescript
// 1. Default channels
const defaultInstances = await channelLoader.createAll(config);

// 2. Each agent's channels
const agentInstancesByAgent = new Map<string, ChannelInstance[]>();
for (const agent of agentRegistry.runnableAgents()) {
  // Build a partial Config from agent.json
  const agentConfig: Config = {
    agents: agent.config.agents,
    channels: agent.config.channels,
    projects: agent.config.projects,
  } as any;
  const instances = await channelLoader.createAll(agentConfig);
  agentInstancesByAgent.set(agent.name, instances);
}

// 3. Connect all
const allInstances = [...defaultInstances, ...[...agentInstancesByAgent.values()].flat()];
await channelLoader.connectAll(allInstances);

// 4. Bind adapters back to agents (by channel instance name)
agentRegistry.bindAdapters(allInstances);
```

Add `runnableAgents()` helper to AgentRegistry:

```typescript
runnableAgents(): EvolAgent[] {
  return [...this.agents.values()].filter(a => a.status === 'stopped');
}

bindAdapters(instances: ChannelInstance[]): void {
  for (const inst of instances) {
    const agent = this.resolveByChannel(inst.adapter.channelName);
    if (agent) {
      agent.channels.set(inst.adapter.channelName, inst.adapter);
      if (agent.status === 'stopped') agent.status = 'running';
    }
  }
}
```

- [ ] **Step 3: Pass AgentRegistry to MessageProcessor and CommandHandler**

Add setters or constructor parameter for agentRegistry.

- [ ] **Step 4: Build verification**

Run: `npm run build`

- [ ] **Step 5: Manual smoke test**

With no agent.json files yet: start evolclaw, verify behavior unchanged (DefaultAgent handles everything, all channels work).

```bash
node dist/cli.js start
# check logs for "✓ Loaded 0 evolagent(s) + DefaultAgent"
# send a test message on feishu, verify response
node dist/cli.js stop
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/paths.ts src/core/agent-registry.ts
git commit -m "$(cat <<'EOF'
feat(startup): wire AgentRegistry into main startup flow

T5 of evolagent mode implementation:
- paths.ts adds agentsDir (~/.evolclaw/agents/)
- main() constructs AgentRegistry, loads all agents, reports summary
- Multiple channelLoader.createAll() calls: default + each agent
- bindAdapters() maps adapters back to agents via channel instance name
- runnableAgents() helper filters stopped status for iteration

When no agent.json present, behavior identical to before (DefaultAgent handles all).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: MessageProcessor integration

**Files:**
- Modify: `src/core/message/message-processor.ts`
- Modify: `tests/unit/message-queue-project.test.ts` or new test

- [ ] **Step 1: Write failing test for AgentContext resolution**

Add to existing or new test file:

```typescript
it('resolves AgentContext from channel name via AgentRegistry', async () => {
  const mockAgent = new EvolAgent('/tmp/x.json', {
    name: 'test-agent',
    agents: { claude: { model: 'opus' } },
    channels: { feishu: [{ name: 'test-fs', appId: 'x', appSecret: 'y' }] },
    projects: { defaultPath: '/tmp' },
  });
  const registry = { resolveByChannel: (ch: string) => ch === 'test-fs' ? mockAgent : null };
  
  // Construct MessageProcessor with registry
  // ... verify AgentContext is populated correctly when processing message
});
```

- [ ] **Step 2: Add AgentRegistry dependency**

In `MessageProcessor`:

```typescript
private agentRegistry?: AgentRegistry;

setAgentRegistry(registry: AgentRegistry): void {
  this.agentRegistry = registry;
}

private getAgentContext(channelName: string, chatType: string): AgentContext | null {
  if (!this.agentRegistry) return null;
  const agent = this.agentRegistry.resolveByChannel(channelName);
  if (!agent) return null;
  const globalCm = (this.config as any).chatmode;
  return agent.getContext(channelName, chatType, globalCm);
}
```

- [ ] **Step 3: Call getAgentContext in processMessage**

Where chatType is known (in `_processMessageInternal`), call `getAgentContext`. Store on a local variable. Use it to:
1. Influence session creation defaults (projectPath override via agent.projectPath when creating new session and path not yet bound)
2. Pass down to CommandHandler for isOwned check

Avoid breaking existing behavior when registry is null/agent not found.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: no regressions

- [ ] **Step 5: Build**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/core/message/message-processor.ts tests/unit/
git commit -m "$(cat <<'EOF'
feat(processor): integrate AgentRegistry for per-message AgentContext

T6 of evolagent mode implementation:
- MessageProcessor.setAgentRegistry() injects registry
- getAgentContext(channelName, chatType) resolves context, fallbacks to null
- AgentContext feeds session creation defaults and command isOwned

No behavior change when registry absent or channel has no owning agent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CommandHandler integration

**Files:**
- Modify: `src/core/command-handler.ts`
- Create/modify: `tests/unit/command-handler-isowned.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { CommandHandler } from '../../src/core/command-handler.js';

describe('CommandHandler isOwned blocking', () => {
  it('blocks /project in agent-owned channel', async () => {
    const handler = /* construct with mocked deps */;
    handler.setAgentRegistry({ resolveByChannel: () => ({ isDefault: false, name: 'review-bot', projectPath: '/x' }) } as any);
    const result = await handler.handle('/project my-proj', 'feishu', 'test-fs', ...);
    expect(result).toMatch(/review-bot/);
    expect(result).toMatch(/锁定/);
  });

  it('allows /project in default channel', async () => {
    const handler = /* construct */;
    handler.setAgentRegistry({ resolveByChannel: () => ({ isDefault: true, name: '[default]' }) } as any);
    // /project should proceed to normal handling
  });

  it('blocks /agent <name> in agent-owned', async () => {
    const handler = /* construct */;
    handler.setAgentRegistry({ resolveByChannel: () => ({ isDefault: false, name: 'review-bot' }) } as any);
    const result = await handler.handle('/agent codex', 'feishu', 'test-fs', ...);
    expect(result).toMatch(/绑定|锁定/);
  });

  it('allows /agent with no arg (view only) in agent-owned', async () => {
    const handler = /* construct */;
    handler.setAgentRegistry({ resolveByChannel: () => ({ isDefault: false, name: 'review-bot', baseagent: 'claude' }) } as any);
    const result = await handler.handle('/agent', 'feishu', 'test-fs', ...);
    expect(result).not.toMatch(/锁定/);
  });
});
```

- [ ] **Step 2: Add AgentRegistry to CommandHandler**

```typescript
private agentRegistry?: AgentRegistry;

setAgentRegistry(reg: AgentRegistry): void {
  this.agentRegistry = reg;
}

private getAgentForChannel(channelName: string): EvolAgent | null {
  return this.agentRegistry?.resolveByChannel(channelName) || null;
}
```

- [ ] **Step 3: Intercept locked commands**

In `handle()`, after parsing command but before dispatching:

```typescript
const agent = this.getAgentForChannel(channel);
if (agent && !agent.isDefault) {
  // Block locked commands
  if (['/project', '/bind', '/plist', '/p'].includes(normalizedCmd.split(' ')[0])) {
    return `❌ 当前通道由 agent [${agent.name}] 管理，项目已锁定为 ${agent.projectPath}`;
  }
  // Block /agent with argument (switch)
  if (normalizedCmd.startsWith('/agent ')) {
    return `❌ 当前通道由 agent [${agent.name}] 管理，baseagent 已锁定为 ${agent.baseagent}`;
  }
  // /agent without arg still allowed (view-only)
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`

- [ ] **Step 5: Wire into index.ts**

In `main()`, after constructing CommandHandler:

```typescript
cmdHandler.setAgentRegistry(agentRegistry);
processor.setAgentRegistry(agentRegistry);
```

- [ ] **Step 6: Build + commit**

```bash
git add src/core/command-handler.ts src/index.ts tests/unit/command-handler-isowned.test.ts
git commit -m "$(cat <<'EOF'
feat(cmd): agent-owned channel blocks /project /bind /plist and /agent switch

T7 of evolagent mode implementation:
- CommandHandler.setAgentRegistry() accepts registry
- Before dispatch, check if channel owned by non-default agent
- Block project commands with friendly message including agent name + locked path
- Block /agent <name> switch; /agent (view-only) still allowed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: setOwner routing

**Files:**
- Modify: `src/config.ts` (setOwner function)
- Create: `tests/unit/owner-routing.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setOwner, loadConfig } from '../../src/config.js';

describe('setOwner routing between evolclaw.json and agent.json', () => {
  let tmpDir: string;
  let configPath: string;
  let agentsDir: string;
  let agentPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-owner-'));
    configPath = path.join(tmpDir, 'evolclaw.json');
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    agentPath = path.join(agentsDir, 'review.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes to agent.json when channel belongs to an agent', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { defaultAgent: 'claude', claude: {} },
      channels: { feishu: [{ name: 'default-fs', appId: 'd' }] },
      projects: { defaultPath: tmpDir },
    }));
    fs.writeFileSync(agentPath, JSON.stringify({
      name: 'review',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'review-fs', appId: 'r' }] },
      projects: { defaultPath: tmpDir },
    }));

    setOwner('review-fs', 'user-123', { configPath, agentsDir });

    const agent = JSON.parse(fs.readFileSync(agentPath, 'utf-8'));
    expect(agent.channels.feishu[0].owner).toBe('user-123');

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.channels.feishu[0].owner).toBeUndefined();
  });

  it('writes to evolclaw.json for default channels', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { defaultAgent: 'claude', claude: {} },
      channels: { feishu: [{ name: 'default-fs', appId: 'd' }] },
      projects: { defaultPath: tmpDir },
    }));

    setOwner('default-fs', 'user-456', { configPath, agentsDir });

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg.channels.feishu[0].owner).toBe('user-456');
  });
});
```

- [ ] **Step 2: Implement routing in setOwner**

Modify existing `setOwner()` in `src/config.ts`:

```typescript
export function setOwner(
  instanceName: string,
  userId: string,
  opts?: { configPath?: string; agentsDir?: string }
): void {
  const configPath = opts?.configPath ?? resolvePaths().config;
  const agentsDir = opts?.agentsDir ?? resolvePaths().agentsDir;

  // 1. Try to find a matching agent.json first
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.json')) continue;
      const agentFile = path.join(agentsDir, file);
      const raw = readJsonSafe(agentFile);
      if (!raw) continue;
      if (writeOwnerToChannelInstance(raw, instanceName, userId)) {
        fs.writeFileSync(agentFile, JSON.stringify(raw, null, 2), 'utf-8');
        return;
      }
    }
  }

  // 2. Fallback: write to evolclaw.json
  const config = loadConfigRaw(configPath);
  if (writeOwnerToChannelInstance(config, instanceName, userId)) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

function writeOwnerToChannelInstance(root: any, name: string, userId: string): boolean {
  for (const type of channelTypes) {
    const raw = root.channels?.[type];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      const inst = raw.find((i: any) => i.name === name);
      if (inst) {
        inst.owner = userId;
        return true;
      }
    } else {
      const effectiveName = raw.name ?? type;
      if (effectiveName === name) {
        raw.owner = userId;
        return true;
      }
    }
  }
  return false;
}

function readJsonSafe(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function loadConfigRaw(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
```

Note: Preserve existing callers of setOwner — they should continue working. Check callers via grep.

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/unit/owner-routing.test.ts`

- [ ] **Step 4: Build + commit**

```bash
git add src/config.ts tests/unit/owner-routing.test.ts
git commit -m "$(cat <<'EOF'
feat(config): setOwner routes writes to agent.json or evolclaw.json

T8 of evolagent mode implementation:
- Internal routing: scan agents/ first, match by channel instance name
- Match → write to that agent.json
- No match → fallback to evolclaw.json
- Callers unchanged

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: CLI `evolclaw agent` subcommand

**Files:**
- Modify: `src/cli.ts` — add `agent` subcommand handlers
- Create: `tests/unit/cli-agent-command.test.ts`

- [ ] **Step 1: Add CLI parsing**

In `src/cli.ts`, add to the main argv switch:

```typescript
case 'agent':
  await cmdAgent(args.slice(1));
  break;
```

Implement `cmdAgent(args)`:

```typescript
async function cmdAgent(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub) {
    await cmdAgentList();
    return;
  }
  if (sub === 'new') {
    await cmdAgentNew(args[1]);
    return;
  }
  if (sub === 'reload') {
    await cmdAgentReload(args[1]);
    return;
  }
  // `evolclaw agent <name>` → show detail
  await cmdAgentShow(sub);
}
```

- [ ] **Step 2: Implement cmdAgentList — IPC call**

Use existing IPC client helper. Fallback to "stopped" status reading disk when process not running:

```typescript
async function cmdAgentList(): Promise<void> {
  const running = await tryIpcListAgents();
  if (running) {
    printAgentTable(running);
    return;
  }
  // Cold mode: read agents/ dir directly
  const paths = resolvePaths();
  const diskAgents = await readAgentsFromDisk(paths.agentsDir);
  printAgentTable(diskAgents.map(info => ({ ...info, status: 'stopped' as const })));
}
```

Design: `tryIpcListAgents()` attempts IPC connect with short timeout; returns null on failure.

- [ ] **Step 3: Implement cmdAgentShow**

Detail view for one agent. IPC call with fallback to disk.

- [ ] **Step 4: Implement cmdAgentNew — interactive**

Uses `collectXCredentials()` from T4's refactor:

```typescript
async function cmdAgentNew(name: string): Promise<void> {
  if (!name) { console.error('Usage: evolclaw agent new <name>'); process.exit(1); }
  const paths = resolvePaths();
  const agentPath = path.join(paths.agentsDir, `${name}.json`);
  if (fs.existsSync(agentPath)) { console.error(`Agent ${name} already exists`); process.exit(1); }

  console.log(`\nCreating agent: ${name}\n`);

  const projectPath = await prompt('Project path: ');
  const baseagent = await promptChoice('Baseagent', ['claude', 'codex', 'gemini'], 'claude');
  const model = await prompt(`Model (leave empty for default): `);
  const effort = await prompt(`Effort (low/medium/high/max, default high): `);
  const chatmodePrivate = await promptChoice('ChatMode private', ['interactive', 'proactive'], 'interactive');

  const channelsConfig: any = {};
  while (true) {
    const add = await prompt('Add channel? (y/n): ');
    if (add.toLowerCase() !== 'y') break;
    const type = await prompt('Channel type (feishu/aun/wechat/wecom/dingtalk/qqbot): ');
    const creds = await collectCredsForType(type);
    if (!channelsConfig[type]) channelsConfig[type] = [];
    channelsConfig[type].push(creds);
  }

  const agentConfig = {
    name,
    enabled: true,
    agents: { [baseagent]: { ...(model && { model }), ...(effort && { effort }) } },
    channels: channelsConfig,
    projects: { defaultPath: projectPath },
    chatmode: { private: chatmodePrivate, group: 'proactive' },
  };

  fs.mkdirSync(paths.agentsDir, { recursive: true });
  fs.writeFileSync(agentPath, JSON.stringify(agentConfig, null, 2));
  console.log(`\nCreated: ${agentPath}\nRun \`evolclaw restart\` to activate.`);
}
```

- [ ] **Step 5: Implement cmdAgentReload — IPC call**

Sends reload request to running IPC server.

- [ ] **Step 6: Run tests + build**

```bash
npm test
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/unit/cli-agent-command.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add evolclaw agent subcommand

T9 of evolagent mode implementation:
- `evolclaw agent` — list agents (IPC → fallback disk-only read)
- `evolclaw agent <name>` — detail view
- `evolclaw agent new <name>` — interactive create using collectXCredentials
- `evolclaw agent reload <name>` — IPC reload trigger

Cold-mode fallback: when process not running, show disk-only info with stopped status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: IPC server handlers

**Files:**
- Modify: `src/ipc.ts` — add evolagent list + reload handlers
- Create: `tests/unit/ipc-evolagent.test.ts`

- [ ] **Step 1: Add handlers**

In `src/ipc.ts`, extend the request handler with:

```typescript
case 'evolagent.list':
  return { ok: true, agents: agentRegistry.list() };

case 'evolagent.show':
  const agent = agentRegistry.get(request.name);
  if (!agent) return { ok: false, error: 'not found' };
  return { ok: true, agent: agentRegistry.list().find(i => i.name === request.name) };

case 'evolagent.reload':
  try {
    await agentRegistry.reload(request.name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
```

`AgentRegistry.reload(name)` is stubbed for now (returns immediately) — T11 fills in the real logic.

- [ ] **Step 2: Also add `evolagent` ctl command**

Per spec section 8.3, `evolclaw ctl evolagent` and `evolclaw ctl evolagent reload [name]` — wire up in the ctl dispatch as well.

- [ ] **Step 3: Test the IPC endpoints**

Mock minimal AgentRegistry, verify each handler shape.

- [ ] **Step 4: Build + commit**

```bash
git add src/ipc.ts src/core/command-handler.ts tests/unit/ipc-evolagent.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): add evolagent list/show/reload handlers + ctl evolagent

T10 of evolagent mode implementation:
- ipc.ts handles evolagent.list / .show / .reload
- ctl evolagent [reload <name>] wired in CommandHandler.handleCtl

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Full hot reload

**Files:**
- Modify: `src/core/agent-registry.ts` — implement reload
- Modify: `src/index.ts` — hot-load helper hook for registry

- [ ] **Step 1: Implement AgentRegistry.reload**

```typescript
async reload(name: string, hooks: ReloadHooks): Promise<void> {
  const oldAgent = this.agents.get(name);
  if (!oldAgent) throw new Error(`Agent ${name} not found`);

  const agentFile = oldAgent.configPath!;
  const raw = JSON.parse(fs.readFileSync(agentFile, 'utf-8'));
  const validation = validateEvolAgentConfig(raw);
  if (!validation.valid) {
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }

  const newAgent = new EvolAgent(agentFile, raw);

  // Fingerprint conflict check against all others (except self)
  const conflict = this.checkConflictForAgent(newAgent, name);
  if (conflict) throw new Error(`Channel conflict: ${conflict}`);

  const oldChannels = new Set(oldAgent.channelInstanceNames());
  const newChannels = new Set(newAgent.channelInstanceNames());

  const toRemove = [...oldChannels].filter(c => !newChannels.has(c));
  const toAdd = [...newChannels].filter(c => !oldChannels.has(c));

  // 1. Drain messages for channels being removed
  for (const ch of toRemove) {
    await hooks.drainChannel(ch);
  }

  // 2. Disconnect old channels
  for (const ch of toRemove) {
    await hooks.disconnectChannel(ch);
  }

  // 3. Start new channels
  for (const ch of toAdd) {
    await hooks.startChannel(newAgent, ch);
  }

  // 4. Swap agent in registry + update channel index
  this.agents.set(name, newAgent);
  this.channelIndex.clear();
  this.buildChannelIndex();

  // Copy runtime state (active sessions, etc) if channel persisted
  // ...
}

interface ReloadHooks {
  drainChannel(name: string): Promise<void>;
  disconnectChannel(name: string): Promise<void>;
  startChannel(agent: EvolAgent, channelName: string): Promise<void>;
}
```

- [ ] **Step 2: Wire ReloadHooks in index.ts**

In `main()`, construct hooks using existing MessageQueue and ChannelLoader state.

- [ ] **Step 3: Write integration test for reload**

```typescript
it('reload swaps channel ownership', async () => {
  // Start with agent A owning channel X
  // Modify A's config: remove channel X
  // Call reload(A)
  // Verify X is disconnected, no longer in A's channels
});
```

- [ ] **Step 4: Build + commit**

```bash
git add src/core/agent-registry.ts src/index.ts tests/
git commit -m "$(cat <<'EOF'
feat(reload): full hot reload for evolagents

T11 of evolagent mode implementation:
- AgentRegistry.reload(name, hooks) drains, disconnects, starts, swaps
- ReloadHooks abstraction decouples registry from MessageQueue/ChannelLoader
- Fingerprint conflict check rejects reload before any side effect
- channel instance name diff drives which channels to drain/add

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: E2E integration test

**Files:**
- Create: `tests/integration/evolagent-e2e.test.ts`

- [ ] **Step 1: Write E2E test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../src/core/agent-registry.js';
// ... import MessageProcessor, mock channel adapter, etc.

describe('EvolAgent E2E', () => {
  let tmpDir: string;
  // Setup: construct minimal agent.json in a tmp dir + mock channel

  it('routes message from agent-owned channel to AgentContext', async () => {
    // Build a tmp agent.json
    // Start AgentRegistry.loadAll
    // Inject mock channel adapter
    // Send mock message
    // Verify: MessageProcessor receives AgentContext with isOwned=true, agent.name matches
  });

  it('blocks /project in agent-owned channel end-to-end', async () => {
    // Similar setup
    // Send "/project foo" via mock channel
    // Verify response contains the lock message
  });

  it('default channel continues to work when agents exist', async () => {
    // Setup: 1 agent + 1 default channel
    // Send message to default channel
    // Verify: AgentContext.isDefault=true
  });
});
```

- [ ] **Step 2: Run, iterate until passing**

- [ ] **Step 3: Commit**

```bash
git add tests/integration/evolagent-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): end-to-end evolagent routing tests

T12 of evolagent mode implementation:
- Verify channel → AgentContext routing across full stack
- Verify /project blocking in agent-owned channel
- Verify default channel still works alongside agents

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Docs update

**Files:**
- Modify: `CLAUDE.md` — add EvolAgent section

- [ ] **Step 1: Add EvolAgent section to CLAUDE.md**

Add a new section after existing architecture description:

```markdown
## EvolAgent Mode

EvolAgents are first-class agent entities defined by `~/.evolclaw/agents/<name>.json`.
Each agent self-contains channels + single baseagent + project + optional chatmode.

- **Creation:** `evolclaw agent new <name>` (interactive)
- **List:** `evolclaw agent`
- **Detail:** `evolclaw agent <name>`
- **Hot reload:** `evolclaw agent reload <name>`
- **Delete:** remove the JSON file + `evolclaw restart`

Channels declared in `evolclaw.json` fall under DefaultAgent.
Channel fingerprint `{type}:{primaryKey}` must be globally unique — conflicts mark agents as `error`.

See `docs/superpowers/specs/2026-05-12-evolagent-mode-design.md` for full spec.
```

- [ ] **Step 2: Update CHANGELOG**

Add v2.8.0 entry noting the evolagent mode release.

- [ ] **Step 3: Final full test suite + build**

```bash
npm test
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: document EvolAgent mode in CLAUDE.md + CHANGELOG

T13 of evolagent mode implementation:
- CLAUDE.md adds EvolAgent Mode section pointing to spec
- CHANGELOG v2.8.0 entry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

After all tasks:

- [ ] **Full test suite:** `npm test` — all passing
- [ ] **Build:** `npm run build` — no TS errors
- [ ] **Manual smoke:**
  - `evolclaw start` with no agents: default behavior unchanged
  - `evolclaw agent new test-bot` → `evolclaw restart` → message to test-bot's channel reaches agent
  - `evolclaw agent` shows test-bot as running
  - Remove `test-bot.json` + `evolclaw restart` → back to default only
- [ ] **Commit count:** 13 commits (one per Task)

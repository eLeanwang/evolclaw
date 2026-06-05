# EvolAgent 前置改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 evolagent 模式铺路，同时交付 4 项独立有价值的基础改造：Channel Fingerprint、ChannelLoader 幂等性保障、baseagent key 统一命名、孤儿 session 检测。

**Architecture:** 四项改造互相独立，可并行或顺序实施。不依赖 evolagent 主体设计，完成后即刻可合入生产。

**Tech Stack:** TypeScript (ES modules), vitest, SQLite (node:sqlite)

---

## 任务概览

| 任务 | 内容 | 文件影响 |
|---|---|---|
| Task 1 | Channel Fingerprint 工具 + evolclaw.json 重复凭证检测 | 新增 1 文件，修改 index.ts |
| Task 2 | ChannelLoader 幂等性测试 | 新增 1 测试文件 |
| Task 3 | baseagent key 统一（anthropic→claude, openai→codex, google→gemini） | evolclaw.json 格式 + 多处 config 读取 |
| Task 4 | `evolclaw status` 显示孤儿 session 总数 | 修改 src/cli.ts cmdStatus |

任务间无依赖，但推荐实施顺序：**1 → 2 → 4 → 3**（3 是 breaking change，最后做以免影响前三项测试）。

---

### Task 1: Channel Fingerprint 工具 + 启动时重复凭证检测

**Files:**
- Create: `src/utils/channel-fingerprint.ts`
- Create: `tests/unit/channel-fingerprint.test.ts`
- Modify: `src/index.ts:75` 附近（启动检查）

- [ ] **Step 1: 写 fingerprint 工具的失败测试**

Create `tests/unit/channel-fingerprint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractFingerprint, detectDuplicates } from '../../src/utils/channel-fingerprint.js';

describe('extractFingerprint', () => {
  it('extracts feishu fingerprint by appId', () => {
    expect(extractFingerprint('feishu', { appId: 'cli_abc', appSecret: 's' }))
      .toBe('feishu:cli_abc');
  });

  it('extracts aun fingerprint by aid', () => {
    expect(extractFingerprint('aun', { aid: 'review.agentid.pub' }))
      .toBe('aun:review.agentid.pub');
  });

  it('extracts wechat fingerprint by token', () => {
    expect(extractFingerprint('wechat', { token: 'xyz' }))
      .toBe('wechat:xyz');
  });

  it('extracts wecom fingerprint by botId', () => {
    expect(extractFingerprint('wecom', { botId: 'b1', secret: 's' }))
      .toBe('wecom:b1');
  });

  it('extracts dingtalk fingerprint by clientId', () => {
    expect(extractFingerprint('dingtalk', { clientId: 'c1' }))
      .toBe('dingtalk:c1');
  });

  it('extracts qqbot fingerprint by appId', () => {
    expect(extractFingerprint('qqbot', { appId: '1234' }))
      .toBe('qqbot:1234');
  });

  it('returns null for missing primary key', () => {
    expect(extractFingerprint('feishu', { appSecret: 's' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(extractFingerprint('unknown' as any, { key: 'v' })).toBeNull();
  });
});

describe('detectDuplicates', () => {
  it('returns empty when all fingerprints are unique', () => {
    const config = {
      channels: {
        feishu: [
          { name: 'f1', appId: 'a', appSecret: 's' },
          { name: 'f2', appId: 'b', appSecret: 's' },
        ],
      },
    };
    expect(detectDuplicates(config as any)).toEqual([]);
  });

  it('detects duplicate appId across instances', () => {
    const config = {
      channels: {
        feishu: [
          { name: 'f1', appId: 'dup', appSecret: 's1' },
          { name: 'f2', appId: 'dup', appSecret: 's2' },
        ],
      },
    };
    const result = detectDuplicates(config as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fingerprint: 'feishu:dup',
      instances: ['f1', 'f2'],
    });
  });

  it('handles single-object channel config', () => {
    const config = {
      channels: {
        wechat: { token: 'dup' },
        wecom: [{ name: 'w1', botId: 'b1', secret: 's' }],
      },
    };
    expect(detectDuplicates(config as any)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm test -- tests/unit/channel-fingerprint.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 fingerprint 工具**

Create `src/utils/channel-fingerprint.ts`:

```typescript
/**
 * Channel Fingerprint
 *
 * 为每个 channel 实例提取一个全局唯一标识，用于冲突检测和路由索引。
 * 格式：{type}:{primaryKey}
 */

import type { Config } from '../types.js';

/** Channel 类型 → 主键字段映射 */
const PRIMARY_KEY_MAP: Record<string, string> = {
  feishu: 'appId',
  aun: 'aid',
  wechat: 'token',
  wecom: 'botId',
  dingtalk: 'clientId',
  qqbot: 'appId',
};

export function extractFingerprint(
  channelType: string,
  instance: Record<string, any>
): string | null {
  const keyField = PRIMARY_KEY_MAP[channelType];
  if (!keyField) return null;
  const value = instance[keyField];
  if (!value || typeof value !== 'string') return null;
  return `${channelType}:${value}`;
}

export interface DuplicateReport {
  fingerprint: string;
  channelType: string;
  instances: string[]; // instance names
}

export function detectDuplicates(config: Config): DuplicateReport[] {
  const seen = new Map<string, { channelType: string; instances: string[] }>();

  const channels = (config.channels as any) || {};
  for (const [type, raw] of Object.entries(channels)) {
    if (type === 'defaultChannel') continue;
    const instances = Array.isArray(raw) ? raw : [raw];
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue;
      const fingerprint = extractFingerprint(type, inst as any);
      if (!fingerprint) continue;
      const instName = (inst as any).name ?? type;
      const entry = seen.get(fingerprint);
      if (entry) {
        entry.instances.push(instName);
      } else {
        seen.set(fingerprint, { channelType: type, instances: [instName] });
      }
    }
  }

  const duplicates: DuplicateReport[] = [];
  for (const [fingerprint, entry] of seen) {
    if (entry.instances.length > 1) {
      duplicates.push({
        fingerprint,
        channelType: entry.channelType,
        instances: entry.instances,
      });
    }
  }
  return duplicates;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npm test -- tests/unit/channel-fingerprint.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: 在 index.ts 启动时调用冲突检测**

Modify `src/index.ts` 在配置加载之后（约第 75 行 `logger.error(msg)` 之前的位置）：

找到 `const config = loadConfig();` 这一行附近，在其后添加：

```typescript
// Detect duplicate channel credentials in evolclaw.json
import { detectDuplicates } from './utils/channel-fingerprint.js';
const duplicates = detectDuplicates(config);
if (duplicates.length > 0) {
  for (const d of duplicates) {
    logger.warn(
      `⚠ Duplicate channel credential: ${d.fingerprint} is used by instances [${d.instances.join(', ')}]. ` +
      `Only the first instance will be active.`
    );
  }
}
```

注：具体插入位置需打开文件确认 loadConfig 调用点。import 放在文件顶部其他 import 之后。

- [ ] **Step 6: 手工验证启动时警告**

构造测试配置（临时修改 `~/.evolclaw/data/evolclaw.json`，把两个 feishu 实例的 appId 改成一样），运行 `evolclaw start`，观察日志有 warn。恢复配置。

- [ ] **Step 7: Commit**

```bash
git add src/utils/channel-fingerprint.ts tests/unit/channel-fingerprint.test.ts src/index.ts
git commit -m "feat(utils): add channel fingerprint for duplicate detection

- New utility extracts {type}:{primaryKey} fingerprint per channel instance
- Startup check warns when multiple instances share the same credential
- Covers all 6 channel types (feishu/aun/wechat/wecom/dingtalk/qqbot)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ChannelLoader 幂等性测试

**Files:**
- Create: `tests/unit/channel-loader-idempotent.test.ts`

- [ ] **Step 1: 写幂等性测试**

Create `tests/unit/channel-loader-idempotent.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ChannelLoader, type ChannelPlugin, type ChannelInstance } from '../../src/core/channel-loader.js';
import type { Config } from '../../src/types.js';

function mockPlugin(name: string, callCounter: { count: number }): ChannelPlugin {
  return {
    name,
    isEnabled: () => true,
    async createChannel(): Promise<ChannelInstance> {
      callCounter.count++;
      return {
        channelType: name,
        adapter: { channelName: name, sendText: vi.fn() } as any,
        channel: {},
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    },
  };
}

describe('ChannelLoader idempotency', () => {
  it('createAll can be called multiple times without side effects', async () => {
    const loader = new ChannelLoader();
    const counter = { count: 0 };
    loader.register(mockPlugin('feishu', counter));

    const config: Config = { channels: { feishu: {} } } as any;

    const result1 = await loader.createAll(config);
    const result2 = await loader.createAll(config);

    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(counter.count).toBe(2);
    // Each call produces independent instances
    expect(result1[0]).not.toBe(result2[0]);
  });

  it('createAll with different configs produces independent results', async () => {
    const loader = new ChannelLoader();
    loader.register(mockPlugin('feishu', { count: 0 }));
    loader.register(mockPlugin('aun', { count: 0 }));

    const configFeishu: Config = { channels: { feishu: {} } } as any;
    const configAun: Config = { channels: { aun: {} } } as any;

    const result1 = await loader.createAll(configFeishu);
    const result2 = await loader.createAll(configAun);

    expect(result1.map(i => i.adapter.channelName)).toContain('feishu');
    expect(result2.map(i => i.adapter.channelName)).toContain('aun');
  });

  it('registered plugins persist across createAll calls', async () => {
    const loader = new ChannelLoader();
    loader.register(mockPlugin('feishu', { count: 0 }));

    const config: Config = { channels: { feishu: {} } } as any;
    await loader.createAll(config);

    // Plugin is still registered — second call finds it
    const result = await loader.createAll(config);
    expect(result).toHaveLength(1);
  });

  it('isEnabled=false skips plugin in all calls consistently', async () => {
    const loader = new ChannelLoader();
    const plugin: ChannelPlugin = {
      name: 'feishu',
      isEnabled: () => false,
      createChannel: vi.fn() as any,
    };
    loader.register(plugin);

    const config: Config = { channels: { feishu: {} } } as any;
    const r1 = await loader.createAll(config);
    const r2 = await loader.createAll(config);

    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npm test -- tests/unit/channel-loader-idempotent.test.ts`
Expected: PASS (all 4 tests)

如果失败：阅读 ChannelLoader 代码定位问题并修复（当前分析显示它无状态副作用，应该直接通过）。

- [ ] **Step 3: Commit**

```bash
git add tests/unit/channel-loader-idempotent.test.ts
git commit -m "test(channel-loader): add idempotency tests for createAll

Verifies that ChannelLoader.createAll can be called multiple times
without side effects. Required for evolagent's multi-config loading pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `evolclaw status` 显示孤儿 session 总数

**Files:**
- Modify: `src/cli.ts` (cmdStatus 函数)

注：先做 Task 4 再做 Task 3，因为 Task 3 是 breaking 改动涉及测试环境配置，放最后。

- [ ] **Step 1: 阅读现有 cmdStatus 了解结构**

Read: `src/cli.ts` 行 463 附近的 `cmdStatus()` 函数

- [ ] **Step 2: 加孤儿 session 查询逻辑**

在 `cmdStatus()` 已打开 db 的代码块内（查询 recentSessions 之后、`db.close()` 之前），添加：

```typescript
// Detect orphan sessions: channel name in DB but not in current config
const configChannelNames = new Set<string>();
const channels = (config.channels as any) || {};
for (const [type, raw] of Object.entries(channels)) {
  if (type === 'defaultChannel') continue;
  const instances = Array.isArray(raw) ? raw : [raw];
  for (const inst of instances) {
    if (!inst || typeof inst !== 'object') continue;
    const name = (inst as any).name ?? type;
    configChannelNames.add(name);
  }
}

const allChannels = db.prepare(`
  SELECT DISTINCT channel FROM sessions WHERE deleted_at IS NULL
`).all() as Array<{ channel: string }>;

let orphanCount = 0;
for (const row of allChannels) {
  if (!configChannelNames.has(row.channel)) {
    const count = db.prepare(`
      SELECT COUNT(*) as c FROM sessions
      WHERE channel = ? AND deleted_at IS NULL
    `).get(row.channel) as { c: number };
    orphanCount += count.c;
  }
}
```

注意：cmdStatus 目前没有 `loadConfig()` 的调用，需要补上。在 `cmdStatus()` 函数开头附近加：

```typescript
const config = loadConfig();
```

import 也要加 `loadConfig`（如果还没 import）。

- [ ] **Step 3: 在输出中展示**

在 recentSessions 输出之后、db.close() 之前添加：

```typescript
if (orphanCount > 0) {
  console.log('');
  console.log(`⚠ Orphan sessions: ${orphanCount}`);
}
```

- [ ] **Step 4: 手工验证**

1. 启动 evolclaw，记录当前 channel 列表
2. 运行 `evolclaw status`，查看 Orphan sessions 行（应该为 0 或无显示）
3. 临时在 evolclaw.json 中删除一个 channel 实例（比如 feilun），restart
4. 运行 `evolclaw status`，应显示 `⚠ Orphan sessions: N`（N 为该 channel 下未删除的 session 数）
5. 恢复配置

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): show orphan session count in evolclaw status

Detects sessions whose channel no longer exists in current config
and displays total count in status output. Helps identify stale data
after channel configuration changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: baseagent key 统一（anthropic→claude, openai→codex, google→gemini）

**Files:**
- Modify: `data/evolclaw.json`（测试配置需要手动同步）
- Modify: `src/config.ts`（所有 `config.agents.anthropic` 引用改为 `config.agents.claude` 等）
- Modify: `src/agents/claude-runner.ts`（读取配置处）
- Modify: `src/agents/codex-runner.ts`
- Modify: `src/agents/gemini-runner.ts`
- Modify: 其他引用 `agents.anthropic|openai|google` 的文件

⚠ 这是 **breaking change**，现有 evolclaw.json 用户需要手动迁移配置。

- [ ] **Step 1: 扫描所有引用旧 key 的代码**

Run: `grep -rn "config\.agents\.\(anthropic\|openai\|google\)" src/`
记录所有引用位置。

- [ ] **Step 2: 写测试保护配置解析**

Create `tests/unit/config-baseagent-keys.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
// 假设 config.ts 有 resolveAnthropicConfig / resolveOpenAIConfig / resolveGoogleConfig
import { resolveAnthropicConfig, resolveOpenAIConfig, resolveGoogleConfig } from '../../src/config.js';

describe('baseagent key naming', () => {
  it('reads claude config from agents.claude', () => {
    const config = { agents: { claude: { model: 'opus', apiKey: 'sk-test' } } } as any;
    const resolved = resolveAnthropicConfig(config);
    expect(resolved.model).toBe('opus');
  });

  it('reads codex config from agents.codex', () => {
    const config = { agents: { codex: { model: 'gpt-5', apiKey: 'sk-test' } } } as any;
    const resolved = resolveOpenAIConfig(config);
    expect(resolved.model).toBe('gpt-5');
  });

  it('reads gemini config from agents.gemini', () => {
    const config = { agents: { gemini: { model: 'gemini-2.5-flash' } } } as any;
    const resolved = resolveGoogleConfig(config);
    expect(resolved.model).toBe('gemini-2.5-flash');
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npm test -- tests/unit/config-baseagent-keys.test.ts`
Expected: FAIL（因为代码目前读的是 anthropic/openai/google）

- [ ] **Step 4: 修改 src/config.ts 的所有 key 引用**

替换规则：
- `config.agents.anthropic` → `config.agents.claude`
- `config.agents.openai` → `config.agents.codex`
- `config.agents.google` → `config.agents.gemini`
- `config.agents?.anthropic?...` 同理

函数名保留不变（`resolveAnthropicConfig` 仍然叫这个名字，只是内部读新 key）。

运行 grep 列表内每个文件逐一改。

- [ ] **Step 5: 修改 runner 文件**

- `src/agents/claude-runner.ts`: 如果直接读了 `config.agents.anthropic`，改为 `config.agents.claude`
- `src/agents/codex-runner.ts`: 同理 openai → codex
- `src/agents/gemini-runner.ts`: 同理 google → gemini

- [ ] **Step 6: 运行单元测试验证新 key 工作**

Run: `npm test -- tests/unit/config-baseagent-keys.test.ts`
Expected: PASS

- [ ] **Step 7: 运行全套测试避免回归**

Run: `npm test`
Expected: 所有测试通过（若有失败，说明还有遗漏的 key 引用）

- [ ] **Step 8: 构建验证**

Run: `npm run build`
Expected: 无 TypeScript 报错

- [ ] **Step 9: 迁移本地 evolclaw.json 配置**

打开 `~/.evolclaw/data/evolclaw.json`（或开发目录下的 `data/evolclaw.json`），手动把：
```json
"agents": {
  "anthropic": { ... },
  "openai": { ... },
  "google": { ... }
}
```
改为：
```json
"agents": {
  "claude": { ... },
  "codex": { ... },
  "gemini": { ... }
}
```

`defaultAgent` 字段的值（'claude' / 'codex' / 'gemini'）已经正确，不用改。

- [ ] **Step 10: 手工启动验证**

```bash
evolclaw restart
evolclaw status
```

确认所有 agent runner 正常加载。

- [ ] **Step 11: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部新增一条：

```markdown
## v2.8.0 (2026-05-13)

### Breaking Changes

- **Config key rename** — `evolclaw.json` 的 `agents.anthropic` / `agents.openai` / `agents.google` 重命名为 `agents.claude` / `agents.codex` / `agents.gemini`，与 runner name 对齐。用户需手动迁移配置。
```

- [ ] **Step 12: Commit**

```bash
git add src/config.ts src/agents/*.ts tests/unit/config-baseagent-keys.test.ts CHANGELOG.md
git commit -m "refactor(config)!: rename agents keys to match runner names

BREAKING: config.agents.anthropic|openai|google renamed to claude|codex|gemini.
Aligns config block keys with runner name (session.agentId), removing a
long-standing naming split.

Migration: edit evolclaw.json and rename the three top-level keys.
The defaultAgent value was already 'claude'/'codex'/'gemini', so no change there.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## 最终验证

所有任务完成后：

- [ ] **运行全部测试**：`npm test` 应全部通过
- [ ] **构建**：`npm run build` 无报错
- [ ] **启动 evolclaw**：`evolclaw restart` 成功拉起所有 channel
- [ ] **检查 status**：`evolclaw status` 能看到 `Orphan sessions: 0`
- [ ] **构造重复 channel 测试警告**：在 evolclaw.json 临时加重复 appId 的 feishu 实例，启动时应看到 warn 日志；测试完恢复配置

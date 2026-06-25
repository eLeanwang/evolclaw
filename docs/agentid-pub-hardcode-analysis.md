# `.agentid.pub` 硬编码全面分析报告

## 执行摘要

共发现 **92 处**硬编码 `.agentid.pub`，分布在 19 个文件中。根据影响程度和修改必要性，分为以下四类：

| 类别 | 数量 | 修改优先级 | 说明 |
|------|------|-----------|------|
| **关键业务逻辑** | 2 | 🔴 **高** | 直接影响功能，必须配置化 |
| **功能性生成** | 2 | 🟡 **中** | 影响自动化功能，建议配置化 |
| **用户提示/校验** | 18 | 🟢 **低** | 用户可见，建议改为动态示例 |
| **文档/注释** | 70 | ⚪️ **无** | 仅作示例，无需修改 |

---

## 一、关键业务逻辑（必须修改）

### 1.1 存储域名白名单硬编码 🔴 **致命**

**文件**: `src/channels/aun.ts:1268`

```typescript
private isTrustedStorageHost(host: string, normalizedOwner: string): boolean {
  if (host === 'storage.agentid.pub') return true;  // ⚠️ 硬编码
  const issuer = normalizedOwner.includes('.') ? normalizedOwner.split('.').slice(1).join('.') : '';
  return !!issuer && host === `storage.${issuer}`;
}
```

**调用链**:
```
收到 AUN 消息（带附件）
→ downloadAttachment(att, channelId)
  → ownerAid = att.owner_aid || channelId || this._aid
  → trustedAttachmentUrl(att, ownerAid, objectKey)
    → isTrustedStorageHost(host, normalizedOwner)   // normalizedOwner = 文件所有者 AID（对端）
```

**问题分析**:
- 这是 AUN 消息中附件 URL fallback 的安全校验（`storage.create_download_ticket` 失败时校验 `att.url`）
- 硬编码 `storage.agentid.pub` 只信任 agentid.pub 一个中心存储域名
- 如果本端或对端使用其他 issuer（如 `.example.com`），其 `storage.example.com` 链接会被拒绝

**修改决策**（已确认）: **白名单同时信任本端和对端的 issuer**
- 对端 issuer：从 `normalizedOwner`（附件 `owner_aid`）提取
- 本端 issuer：从 `this.getAid()`（即 `this._aid ?? this.config.aid`）提取

**修改策略**:
```typescript
private isTrustedStorageHost(host: string, normalizedOwner: string): boolean {
  // 收集可信 issuer：本端 + 对端
  const trustedIssuers = new Set<string>();

  // 对端 issuer（文件所有者）
  const peerIssuer = this.extractIssuer(normalizedOwner);
  if (peerIssuer) trustedIssuers.add(peerIssuer);

  // 本端 issuer（自己的 AID）
  const selfIssuer = this.extractIssuer((this.getAid() || '').toLowerCase());
  if (selfIssuer) trustedIssuers.add(selfIssuer);

  // 校验 host 是否为任一可信 issuer 的存储域名
  for (const issuer of trustedIssuers) {
    if (host === `storage.${issuer}`) return true;
  }
  return false;
}

/** 从 AID 提取 issuer（去掉首段 label）。`mybot.agentid.pub` → `agentid.pub` */
private extractIssuer(aid: string): string {
  if (!aid || !aid.includes('.')) return '';
  return aid.split('.').slice(1).join('.');
}
```

**要点**:
- 移除硬编码 `storage.agentid.pub`，改为从本端/对端 AID 动态推断
- 若本端 AID 本就是 `agentid.pub` issuer，`storage.agentid.pub` 自然进入白名单——向后兼容
- 无需新增配置字段，issuer 信息已存在于运行时身份中

**修改优先级**: 🔴 **P0 - 必须修改**

---

### 1.2 控制 AID 生成格式硬编码 🔴 **高**

**文件**: `src/aun/aid/control-aid.ts:11`

```typescript
export function candidateAid(): string {
  const n = crypto.randomInt(10000, 100000);
  return `ec${n}.agentid.pub`;  // ⚠️ 硬编码
}
```

**调用时机**（关键约束）:
```
evolclaw init / evolclaw start
→ evolclaw.json 中 aid 字段为空
→ generateControlAid()
  → candidateAid()
```
控制 AID 是**整个系统第一个被创建的 AID**：
- ❌ 此时 `~/.evolclaw/data/agents/` 为空（无 agent 可参考）
- ❌ `evolclaw.json` 中无 `aid` 字段
- ✅ 因此**无法从现有 agent 推断 issuer**

**修改决策**（已确认）:
- **issuer 来源**: 环境变量 `EVOLCLAW_ISSUER` → 兜底 `agentid.pub`
- **issuer 切换**: 检测到不一致时**仅提示警告**，不自动重新生成（用户需手动删除 `evolclaw.json` 中的 `aid` 字段）

**修改策略**:

```typescript
// src/aun/aid/control-aid.ts

/** 解析控制 AID 的 issuer：环境变量 EVOLCLAW_ISSUER → 兜底 agentid.pub */
export function resolveControlIssuer(): string {
  const env = process.env.EVOLCLAW_ISSUER?.trim();
  return env || 'agentid.pub';
}

/** 生成候选控制 AID：ec + 5位随机数字 + .{issuer} */
export function candidateAid(issuer?: string): string {
  const n = crypto.randomInt(10000, 100000); // 5 位：10000-99999
  const finalIssuer = issuer || resolveControlIssuer();
  return `ec${n}.${finalIssuer}`;
}

export async function generateControlAid(): Promise<ControlAidResult> {
  const issuer = resolveControlIssuer();
  const store = await getAidStore({ slotId: SLOT.cli });
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const candidate = candidateAid(issuer);
      // ... 查重 + aidCreate 逻辑不变
    }
    throw new Error(`无法生成控制 AID：连续 ${MAX_ATTEMPTS} 次候选均冲突`);
  } finally {
    store.close();
  }
}
```

**issuer 切换 → 提示警告**（`src/cli/init.ts:276` 附近）:

```typescript
// 当前逻辑：有 aid 就跳过
if (evc.aid) {
  console.log(`✓ 控制 AID 已存在: ${evc.aid}`);
} else { /* 生成 */ }

// 改为：检测 issuer 不一致并提示
if (evc.aid) {
  const targetIssuer = resolveControlIssuer();
  const currentIssuer = evc.aid.split('.').slice(1).join('.');
  if (currentIssuer !== targetIssuer) {
    console.log(`⚠️  控制 AID issuer (${currentIssuer}) 与目标 issuer (${targetIssuer}) 不一致`);
    console.log(`    如需切换，请删除 evolclaw.json 中的 aid 字段后重新运行 init`);
  }
  console.log(`✓ 控制 AID 已存在: ${evc.aid}`);
} else {
  try {
    const { aid } = await generateControlAid();
    saveEvolclawConfig({ ...evc, aid });
    console.log(`✓ 已生成控制 AID: ${aid}`);
  } catch (e: any) {
    console.error(`⚠️ 控制 AID 生成失败: ${e?.message || e}`);
  }
}
```

**要点**:
- `candidateAid()` 增加可选 `issuer` 参数，默认走 `resolveControlIssuer()`，签名向后兼容
- 同时影响 `src/cli/init.ts:280` 和 `:589` 两处生成点 + `src/cli/daemon-commands.ts:363`
- issuer 不一致时**仅提示警告**，不自动重新生成（避免遗弃已注册的 PKI 身份）

**修改优先级**: 🔴 **P0 - 必须修改**

---

## 二、功能性生成（建议配置化）

### 2.1 性能测试 AID 生成 🟡

**文件**: `src/cli/bench.ts:577`

```typescript
const hex = crypto.randomBytes(4).toString('hex');
const newAid = `bench-${hex}.agentid.pub`;
```

**问题分析**:
- 性能测试工具自动创建临时 AID
- 硬编码限制了测试场景（无法测试自定义 issuer）

**修改策略**:
```typescript
// 复用控制 AID 的 issuer 解析逻辑（环境变量 → 兜底 agentid.pub）
import { resolveControlIssuer } from '../aun/aid/control-aid.js';

const issuer = opts.issuer || resolveControlIssuer();
const hex = crypto.randomBytes(4).toString('hex');
const newAid = `bench-${hex}.${issuer}`;
```
（可选：增加 `--issuer` 参数允许显式指定测试 issuer）

**修改优先级**: 🟡 **P2 - 建议修改**（影响测试覆盖度）

---

### 2.2 群组格式识别注释 🟡

**文件**: `src/channels/aun.ts:251-252`

```typescript
/** 判断 channelId 是否为群组 ID
 *  - 新格式：group.{issuer}/{group_no|group_name}
 *  - 数字群号：{group_no}.{issuer}（如 11117.agentid.pub）
 *  - 兼容旧格式：grp_xxx、g-xxx.agentid.pub
 */
```

**问题分析**:
- 注释中的示例使用 `.agentid.pub`
- 代码逻辑本身是通用的（通过 `.` 判断），不依赖特定域名

**修改策略**:
```typescript
/** 判断 channelId 是否为群组 ID
 *  - 新格式：group.{issuer}/{group_no|group_name}
 *  - 数字群号：{group_no}.{issuer}（如 11117.example.com）
 *  - 兼容旧格式：grp_xxx、g-xxx.{issuer}
 */
```

**修改优先级**: 🟢 **P3 - 可选修改**（仅影响文档准确性）

---

## 三、用户提示/校验（建议改进）

这类硬编码出现在用户交互场景，包括：
- 错误提示信息
- CLI 帮助文档
- 交互式提示
- 格式校验错误

### 3.1 错误提示信息（3处）

**文件**: `src/config-store.ts:270,275,282`

```typescript
throw new Error(`invalid aid "${value.aid}" (must be a valid multi-level domain like mybot.agentid.pub)`);
throw new Error(`invalid owner AID "${o}" (must be a valid multi-level domain like alice.agentid.pub)`);
throw new Error(`invalid admin AID "${a}" (must be a valid multi-level domain like alice.agentid.pub)`);
```

**修改策略**:
```typescript
// 方案A: 动态生成示例
const exampleIssuer = process.env.EVOLCLAW_ISSUER?.trim() || 'agentid.pub';
throw new Error(`invalid aid "${value.aid}" (must be a valid multi-level domain like mybot.${exampleIssuer})`);

// 方案B: 通用化描述（推荐，config-store 无 issuer 上下文）
throw new Error(`invalid aid "${value.aid}" (must be a valid multi-level domain like mybot.example.com)`);
```

**修改优先级**: 🟢 **P3 - 建议修改**（提升用户体验）

---

### 3.2 CLI 帮助文档/示例（67处）

**分布**:
- `src/cli/aun-commands.ts`: 34处
- `src/cli/agent-command.ts`: 12处
- `src/cli/queue-command.ts`: 6处
- `src/cli/response.ts`: 6处
- `src/cli/model.ts`: 5处
- `src/cli/agent.ts`: 4处

**典型示例**:
```typescript
// src/cli/aun-commands.ts
evolclaw msg send alice.agentid.pub bob.agentid.pub "hello"
evolclaw storage upload myaid.agentid.pub ./doc.txt notes/doc.txt
evolclaw group create alice.agentid.pub "Dev Team" --visibility private
```

**问题分析**:
- CLI 帮助文档中大量使用 `.agentid.pub` 作为示例
- 用户可能误以为只能使用 `.agentid.pub`

**修改策略**:
```typescript
// 方案A: 使用通用示例域名
evolclaw msg send alice.example.com bob.example.com "hello"

// 方案B: 显式说明支持任意域名（推荐）
演示:
  evolclaw msg send alice.agentid.pub bob.agentid.pub "hello"
  evolclaw msg send mybot.example.com peer.another.org "message"
  
注: AID 可使用任意有效的多级域名

// 方案C: 动态获取当前环境的示例
const exampleAid = getFirstAgentAid() || 'mybot.agentid.pub';
console.log(`示例: evolclaw msg send ${exampleAid} ...`);
```

**修改优先级**: 🟢 **P3 - 建议修改**（文档准确性）

---

### 3.3 交互式提示（5处）

**文件**: `src/cli/agent.ts:402,412,523,661,710`

```typescript
const prompt = lang === 'en' 
  ? 'AID (e.g. mybot.agentid.pub): '
  : 'AID（如 mybot.agentid.pub）：';

console.log(`Invalid AID "${candidate}": must be a valid multi-level domain (e.g. mybot.agentid.pub)`);
```

**修改策略**:
```typescript
// 用通用示例域名，或复用 resolveControlIssuer() 的 issuer
const exampleIssuer = process.env.EVOLCLAW_ISSUER?.trim() || 'agentid.pub';
const prompt = `AID (e.g. mybot.${exampleIssuer}): `;
```

**修改优先级**: 🟢 **P3 - 建议修改**

---

### 3.4 命令处理错误提示（2处）

**文件**: `src/core/command/command-handler.ts:337,1718`

```typescript
return { error: `AUN 渠道的 --channelid 必须是 AID 格式（如 user.agentid.pub），收到："${parsed.targetChannelId}"` };

return { ok: true, result: `用法: /rpc --as <aid> --params <json>\n示例: /rpc --as myaid.agentid.pub ...` };
```

**修改策略**: 同上，使用动态示例

**修改优先级**: 🟢 **P3 - 建议修改**

---

### 3.5 Web 前端（1处）

**文件**: `ecweb/src/static/app.js:1829`

```javascript
const aid = prompt('Agent AID（如 mybot.agentid.pub）：');
```

**修改策略**: 同样改为通用示例或动态获取

**修改优先级**: 🟢 **P3 - 建议修改**

---

## 四、文档和注释（无需修改）

### 4.1 代码注释（4处）

**文件**:
- `src/types.ts:40,647` - 类型定义注释
- `src/core/baseagent-loader.ts:21` - 参数说明注释
- `src/core/session/session-manager.ts:1454` - 兼容性注释

```typescript
// src/types.ts
aid: string;  // 完整 AID，如 evolclaw-ai.agentid.pub
agentName: string;  // EvolAgent AID（如 'review-bot.agentid.pub'）
```

**判定**: ⚪️ **无需修改**（仅作示例说明）

---

### 4.2 用户文档（9处）

**文件**:
- `README.md`: 2处
- `SKILLS.md`: 4处
- `evolclaw-install-aun.md`: 3处

```markdown
# README.md
"owners": ["eleans-2022.agentid.pub"]
v3.2 新增进程级身份标识。启动时自动生成 `ec+5位数字.agentid.pub` 格式的控制 AID

# SKILLS.md
--aun-aid mybot.agentid.pub --aun-owner me.agentid.pub
```

**判定**: ⚪️ **无需修改**（文档示例，保持一致性）

但建议在文档开头增加说明：
```markdown
## AID 域名说明

本文档示例使用 `.agentid.pub` 作为 AID 域名，实际使用时可以是任意有效的多级域名（如 `.example.com`、`.aun.network` 等）。
```

---

## 五、修改优先级总结

### 🔴 P0 - 必须修改（阻塞多域名支持）

| 文件 | 行号 | 描述 | 修改复杂度 |
|------|------|------|-----------|
| `src/channels/aun.ts` | 1268 | 存储域名白名单 | 低（20行） |
| `src/aun/aid/control-aid.ts` | 11 | 控制 AID 生成 | 中（50行） |

**预计工作量**: 2-3 小时

---

### 🟡 P1-P2 - 建议修改（提升灵活性）

| 文件 | 行号 | 描述 | 修改复杂度 |
|------|------|------|-----------|
| `src/cli/bench.ts` | 577 | 性能测试 AID | 低（5行） |
| `src/channels/aun.ts` | 251 | 注释示例 | 极低（1行） |

**预计工作量**: 30 分钟

---

### 🟢 P3 - 可选修改（改进用户体验）

| 类别 | 数量 | 修改方式 |
|------|------|---------|
| 错误提示 | 3 | 动态生成示例 |
| CLI 帮助 | 67 | 批量替换 + 增加说明 |
| 交互提示 | 5 | 动态生成示例 |
| Web 前端 | 1 | 改为通用示例 |

**预计工作量**: 2-3 小时（可分批进行）

---

## 六、实施方案

### 阶段 1: 核心功能修复（必须）

1. **issuer 解析机制**（环境变量驱动，无需现有 agent）
   - `src/aun/aid/control-aid.ts` 新增 `resolveControlIssuer()`：`EVOLCLAW_ISSUER` → 兜底 `agentid.pub`
   - `candidateAid()` 增加可选 `issuer` 参数
   - `generateControlAid()` 使用 `resolveControlIssuer()`

2. **控制 AID issuer 切换重新生成**
   - `src/cli/init.ts:276` 处：校验现有 `aid` 的 issuer 与目标 issuer 是否一致，不一致则重新生成

3. **存储域名白名单（本端 + 对端 issuer）**
   - `src/channels/aun.ts` 改写 `isTrustedStorageHost()`：从 `this.getAid()`（本端）和 `normalizedOwner`（对端）提取 issuer，校验 `storage.{issuer}`

4. **向后兼容**
   - `EVOLCLAW_ISSUER` 未设置时默认 `agentid.pub`
   - 本端为 agentid.pub issuer 时，`storage.agentid.pub` 自然进入白名单

---

### 阶段 2: 用户体验优化（建议）

1. **动态/通用示例**
   - 有 issuer 上下文处（CLI agent 交互）：用 `EVOLCLAW_ISSUER` 兜底 `agentid.pub`
   - 无上下文处（config-store 校验）：用通用域名 `mybot.example.com`

2. **文档增强**
   - 在主要文档开头增加域名说明
   - CLI 帮助中增加"支持任意域名"提示

---

### 阶段 3: 全面优化（可选）

1. **批量替换 CLI 示例**
   - 使用通用示例域名（如 `.example.com`）
   - 或增加多种示例展示灵活性

2. **Web 前端改进**
   - ecweb 使用通用提示
   - 考虑从后端获取当前环境示例

---

## 七、风险评估

### 兼容性风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 现有 `.agentid.pub` AID 失效 | 🔴 高 | `EVOLCLAW_ISSUER` 未设置时兜底 `agentid.pub`；存储白名单含本端 issuer |
| issuer 不一致未及时发现 | 🟡 中 | init 时检测并警告，提示用户手动切换 |
| 第三方集成破坏 | 🟢 低 | 仅内部逻辑变化，API 不变 |

### 测试覆盖

需要测试的场景：
- ✅ `EVOLCLAW_ISSUER` 未设置 → 控制 AID 仍为 `ec*.agentid.pub`
- ✅ `EVOLCLAW_ISSUER=example.com` → 控制 AID 为 `ec*.example.com`
- ✅ issuer 不一致 → init 输出警告信息，不自动重新生成
- ✅ 存储白名单：本端 issuer 的 `storage.{self_issuer}` 通过
- ✅ 存储白名单：对端 issuer 的 `storage.{peer_issuer}` 通过
- ✅ 存储白名单：无关第三方 host 被拒绝

---

## 八、代码示例

### 8.1 issuer 解析（control-aid.ts，环境变量驱动）

```typescript
// src/aun/aid/control-aid.ts

/** 解析控制 AID 的 issuer：环境变量 EVOLCLAW_ISSUER → 兜底 agentid.pub */
export function resolveControlIssuer(): string {
  const env = process.env.EVOLCLAW_ISSUER?.trim();
  return env || 'agentid.pub';
}
```

> 不从"现有 agent"推断——控制 AID 是系统第一个 AID，创建时无 agent 可参考。

### 8.2 修改后的控制 AID 生成

```typescript
// src/aun/aid/control-aid.ts
import crypto from 'crypto';
import { aidCreate } from './index.js';
import { getAidStore, SLOT } from './store.js';
import { logger } from '../../utils/logger.js';

const MAX_ATTEMPTS = 5;

/** 生成候选控制 AID：ec + 5位随机数字 + .{issuer} */
export function candidateAid(issuer?: string): string {
  const n = crypto.randomInt(10000, 100000);
  const finalIssuer = issuer || resolveControlIssuer();
  return `ec${n}.${finalIssuer}`;
}

export interface ControlAidResult {
  aid: string;
  gateway: string;
}

export async function generateControlAid(): Promise<ControlAidResult> {
  const issuer = resolveControlIssuer();
  const store = await getAidStore({ slotId: SLOT.cli });
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const candidate = candidateAid(issuer);
      // ... 查重 + aidCreate 逻辑不变
    }
    throw new Error(`无法生成控制 AID：连续 ${MAX_ATTEMPTS} 次候选均冲突`);
  } finally {
    store.close();
  }
}
```

### 8.3 控制 AID issuer 不一致检测（init.ts）

```typescript
// src/cli/init.ts （约 276 行）
import { generateControlAid, resolveControlIssuer } from '../aun/aid/control-aid.js';

const evc = loadEvolclawConfig();
if (evc.aid) {
  const targetIssuer = resolveControlIssuer();
  const currentIssuer = evc.aid.split('.').slice(1).join('.');
  if (currentIssuer !== targetIssuer) {
    console.log(`⚠️  控制 AID issuer (${currentIssuer}) 与目标 issuer (${targetIssuer}) 不一致`);
    console.log(`    如需切换，请删除 evolclaw.json 中的 aid 字段后重新运行 init`);
  }
  console.log(`✓ 控制 AID 已存在: ${evc.aid}`);
} else {
  try {
    const { aid } = await generateControlAid();
    saveEvolclawConfig({ ...evc, $schema_version: evc.$schema_version ?? 1, aid });
    console.log(`✓ 已生成控制 AID: ${aid}`);
  } catch (e: any) {
    console.error(`⚠️ 控制 AID 生成失败: ${e?.message || e}`);
  }
}
```

### 8.4 修改后的存储域名校验（本端 + 对端 issuer）

```typescript
// src/channels/aun.ts

private isTrustedStorageHost(host: string, normalizedOwner: string): boolean {
  const trustedIssuers = new Set<string>();

  // 对端 issuer（文件所有者 owner_aid）
  const peerIssuer = this.extractIssuer(normalizedOwner);
  if (peerIssuer) trustedIssuers.add(peerIssuer);

  // 本端 issuer（自己的 AID）
  const selfIssuer = this.extractIssuer((this.getAid() || '').toLowerCase());
  if (selfIssuer) trustedIssuers.add(selfIssuer);

  for (const issuer of trustedIssuers) {
    if (host === `storage.${issuer}`) return true;
  }
  return false;
}

/** 从 AID 提取 issuer（去掉首段 label）。`mybot.agentid.pub` → `agentid.pub` */
private extractIssuer(aid: string): string {
  if (!aid || !aid.includes('.')) return '';
  return aid.split('.').slice(1).join('.');
}
```

---

## 九、结论

1. **必须修改的硬编码仅有 2 处**，影响核心功能，修改复杂度低
2. **建议修改的 18 处**主要是用户提示，可改善用户体验
3. **文档/注释 70 处**无需修改，保持示例一致性即可
4. **实施成本低**，阶段 1 仅需 2-3 小时完成核心修复
5. **向后兼容性好**，默认 fallback 机制保护现有部署

**推荐执行路径**: 阶段 1 (必须) → 阶段 2 (建议) → 阶段 3 (按需)

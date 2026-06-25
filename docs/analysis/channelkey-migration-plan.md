# channelKey 格式迁移计划

## 目标

将 channelKey 格式从：
```
当前：<aid>#<type>#<name>
目标：<type>#<urlEncode(selfPeerId)>#<name>
```

示例：
```
当前：dddd.agentid.pub#aun#main
目标：aun#dddd.agentid.pub#main
```

---

## 需要改动的文件清单

### 1. 核心定义和工具函数

#### `src/core/channel-loader.ts`

**改动内容**：

```typescript
// 当前
export interface ChannelKey {
  aid: string;
  type: string;
  name: string;
}

export function formatChannelKey(k: ChannelKey): string {
  return `${k.aid}${SEP}${k.type}${SEP}${k.name}`;
}

export function parseChannelKey(key: string): ChannelKey {
  const parts = key.split(SEP);
  if (parts.length !== 3) {
    throw new Error(`Invalid channel key (expected 3 segments separated by '#'): ${key}`);
  }
  const [aid, type, name] = parts;
  if (!aid || !type || !name) {
    throw new Error(`Invalid channel key (empty segment): ${key}`);
  }
  return { aid, type, name };
}
```

**改为**：

```typescript
export interface ChannelKey {
  type: string;        // channelType
  selfPeerId: string;  // 本端 peerId（需要 urlEncode）
  name: string;        // channel 实例名
}

export function formatChannelKey(k: ChannelKey): string {
  return `${k.type}${SEP}${encodeURIComponent(k.selfPeerId)}${SEP}${k.name}`;
}

export function parseChannelKey(key: string): ChannelKey {
  const parts = key.split(SEP);
  if (parts.length !== 3) {
    throw new Error(`Invalid channel key (expected 3 segments separated by '#'): ${key}`);
  }
  const [type, encodedSelfPeerId, name] = parts;
  if (!type || !encodedSelfPeerId || !name) {
    throw new Error(`Invalid channel key (empty segment): ${key}`);
  }
  return { 
    type, 
    selfPeerId: decodeURIComponent(encodedSelfPeerId), 
    name 
  };
}
```

**新增函数**：

```typescript
/**
 * 从 channel 实例提取本端 peerId
 */
export function extractSelfPeerId(
  channelType: string, 
  instance: ChannelInstance, 
  agentAid: string
): string {
  switch (channelType) {
    case 'aun':
      return agentAid;  // AUN 使用 agent.aid
    case 'feishu':
      return (instance as any).appId || agentAid;
    case 'wechat':
      return (instance as any).appId || agentAid;
    case 'dingtalk':
      return (instance as any).appKey || agentAid;
    case 'qqbot':
      return (instance as any).appId || agentAid;
    case 'wecom':
      return (instance as any).corpId || agentAid;
    default:
      return agentAid;  // 默认使用 agent.aid
  }
}
```

---

#### `src/core/evolagent.ts`

**改动内容**：

```typescript
// 当前
effectiveChannelName(type: string, rawName: string): string {
  return formatChannelKey({ aid: this.aid, type, name: rawName });
}
```

**改为**：

```typescript
import { formatChannelKey, extractSelfPeerId } from './channel-loader.js';

effectiveChannelName(type: string, rawName: string): string {
  // 找到对应的 channel 实例
  const instance = this.merged.channels.find(c => c.type === type && c.name === rawName);
  
  // 提取本端 peerId
  const selfPeerId = instance 
    ? extractSelfPeerId(type, instance, this.aid)
    : this.aid;  // AUN 隐式 channel 或找不到时用 aid
  
  return formatChannelKey({ type, selfPeerId, name: rawName });
}
```

**注释更新**：

```typescript
// 当前注释
/**
 * effective channel key：`<aid>#<type>#<name>`。AUN 实例一个 agent 只有一条；
 * 其它类型靠 name 区分。
 */

// 改为
/**
 * effective channel key：`<type>#<urlEncode(selfPeerId)>#<name>`。
 * AUN channel 的 selfPeerId 是 agent.aid，name 固定为 'main'。
 * 其它类型的 selfPeerId 从 channel 实例提取（如 feishu 的 appId）。
 */
```

---

#### `src/core/evolagent-registry.ts`

**改动内容**：

```typescript
// 当前注释
/** channel key (`<aid>#<type>#<name>`) → agent aid */
private channelIndex: Map<string, string> = new Map();

// 改为
/** channel key (`<type>#<selfPeerId>#<name>`) → agent aid */
private channelIndex: Map<string, string> = new Map();
```

**功能不变**，只是注释更新。索引逻辑保持不变。

---

### 2. 使用 channelKey 的地方

#### `src/index.ts`

**位置**：L336-337

```typescript
// 当前
sessionManager.setSessionModeResolver((channelKey, chatType, peerType) => {
  const agent = agentRegistry.resolveByChannel(channelKey);
  // ...
});
```

**改动**：无需改动，channelKey 作为参数传入，内部逻辑不变。

---

#### `src/core/message/message-processor.ts`

**位置**：多处使用 `channelKey`

**改动**：无需改动，channelKey 作为标识符使用，格式变化不影响逻辑。

---

#### `src/cli/agent.ts`

**位置**：L925

```typescript
// 当前
return {
  ok: true,
  aid: opts.aid,
  channelKey: `${opts.aid}#${opts.channel.type}#${opts.channel.name}`,
  reloaded,
};
```

**改为**：

```typescript
import { formatChannelKey, extractSelfPeerId } from '../core/channel-loader.js';

// 需要先加载 agent 配置获取完整的 channel 实例
const agent = loadAgent(opts.aid);
if (!agent) throw new Error(`Agent ${opts.aid} not found`);

const instance = agent.channels.find(c => 
  c.type === opts.channel.type && c.name === opts.channel.name
);
if (!instance) throw new Error(`Channel instance not found`);

const selfPeerId = extractSelfPeerId(opts.channel.type, instance, opts.aid);

return {
  ok: true,
  aid: opts.aid,
  channelKey: formatChannelKey({ 
    type: opts.channel.type, 
    selfPeerId, 
    name: opts.channel.name 
  }),
  reloaded,
};
```

---

#### `src/cli/index.ts`

**位置**：L888-889, L1018, L2476

**L888-889**：

```typescript
// 当前
// effective key: <aid>#<type>#<name>
configChannelNames.add(`${cfg.aid}#${inst.type}#${inst.name}`);
```

**改为**：

```typescript
import { formatChannelKey, extractSelfPeerId } from '../core/channel-loader.js';

// effective key: <type>#<selfPeerId>#<name>
const selfPeerId = extractSelfPeerId(inst.type, inst, cfg.aid);
configChannelNames.add(formatChannelKey({ 
  type: inst.type, 
  selfPeerId, 
  name: inst.name 
}));
```

**L1018**：注释更新

```typescript
// 当前
/**
 * 把 channel fingerprint 列表（`<aid>#<type>#<name>`）折叠成展示用摘要。
 */

// 改为
/**
 * 把 channel fingerprint 列表（`<type>#<selfPeerId>#<name>`）折叠成展示用摘要。
 */
```

**L2476**：

```typescript
// 当前
// 新结构：channel key 是 <aid>#<type>#<name>，解析后从对应 agent 的 channels[] 找
const parts = instanceName.split('#');
if (parts.length === 3) {
  const [aid, type, name] = parts;
  // ...
}

// 改为
import { parseChannelKey } from '../core/channel-loader.js';

// 新结构：channel key 是 <type>#<selfPeerId>#<name>
try {
  const parsed = parseChannelKey(instanceName);
  const { type, selfPeerId, name } = parsed;
  
  // 需要通过 selfPeerId 找到对应的 agent
  const { agents } = loadAllAgents();
  const agent = agents.find(a => {
    const inst = a.channels.find(c => c.type === type && c.name === name);
    if (!inst) return false;
    const extractedSelfPeerId = extractSelfPeerId(type, inst, a.aid);
    return extractedSelfPeerId === selfPeerId;
  });
  
  if (agent) {
    const inst = agent.channels.find(c => c.type === type && c.name === name);
    if (inst) return { type, config: inst };
  }
} catch {
  // 解析失败，继续尝试旧格式
}
```

---

### 3. 数据迁移

#### Session 数据迁移

**需要迁移的文件**：所有 `active.json` 和 `_threads/*.jsonl` 中的 `channel` 字段

**迁移脚本位置**：`src/migrations/migrate-channelkey-format.ts`

```typescript
import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { loadAllAgents } from '../config-store.js';
import { extractSelfPeerId, formatChannelKey, parseChannelKey } from '../core/channel-loader.js';

interface OldChannelKey {
  aid: string;
  type: string;
  name: string;
}

function parseOldChannelKey(key: string): OldChannelKey | null {
  const parts = key.split('#');
  if (parts.length !== 3) return null;
  const [aid, type, name] = parts;
  if (!aid || !type || !name) return null;
  return { aid, type, name };
}

export async function migrateChannelKeyFormat(): Promise<void> {
  const paths = resolvePaths();
  const { agents } = loadAllAgents();
  
  // 构建 aid → agent 映射
  const agentMap = new Map(agents.map(a => [a.aid, a]));
  
  // 扫描所有 session 文件
  const sessionsDir = paths.sessionsDir;
  
  let migratedCount = 0;
  let errorCount = 0;
  
  function migrateFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      // 检查是否需要迁移
      if (!data.channel || typeof data.channel !== 'string') return;
      
      const oldKey = parseOldChannelKey(data.channel);
      if (!oldKey) {
        // 可能已经是新格式，尝试解析
        try {
          parseChannelKey(data.channel);
          return; // 已经是新格式，跳过
        } catch {
          console.error(`Invalid channel key format: ${data.channel} in ${filePath}`);
          errorCount++;
          return;
        }
      }
      
      // 查找对应的 agent 和 channel 实例
      const agent = agentMap.get(oldKey.aid);
      if (!agent) {
        console.error(`Agent not found: ${oldKey.aid} for ${filePath}`);
        errorCount++;
        return;
      }
      
      const instance = agent.channels.find(c => 
        c.type === oldKey.type && c.name === oldKey.name
      );
      
      // AUN channel 是隐式的，可能不在 channels[] 中
      const selfPeerId = instance 
        ? extractSelfPeerId(oldKey.type, instance, oldKey.aid)
        : oldKey.aid;
      
      // 生成新的 channelKey
      const newKey = formatChannelKey({
        type: oldKey.type,
        selfPeerId,
        name: oldKey.name
      });
      
      // 更新数据
      data.channel = newKey;
      
      // 写回文件
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      
      migratedCount++;
      console.log(`Migrated: ${oldKey.aid}#${oldKey.type}#${oldKey.name} → ${newKey}`);
      
    } catch (e) {
      console.error(`Error migrating ${filePath}:`, e);
      errorCount++;
    }
  }
  
  function scanDirectory(dir: string): void {
    if (!fs.existsSync(dir)) return;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.name === 'active.json') {
        migrateFile(fullPath);
      } else if (entry.name.endsWith('.jsonl') && fullPath.includes('_threads')) {
        // 迁移 thread session 文件（JSONL 格式）
        try {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(l => l.trim());
          let modified = false;
          
          const newLines = lines.map(line => {
            try {
              const data = JSON.parse(line);
              if (data.channel && typeof data.channel === 'string') {
                const oldKey = parseOldChannelKey(data.channel);
                if (oldKey) {
                  const agent = agentMap.get(oldKey.aid);
                  if (agent) {
                    const instance = agent.channels.find(c => 
                      c.type === oldKey.type && c.name === oldKey.name
                    );
                    const selfPeerId = instance 
                      ? extractSelfPeerId(oldKey.type, instance, oldKey.aid)
                      : oldKey.aid;
                    
                    data.channel = formatChannelKey({
                      type: oldKey.type,
                      selfPeerId,
                      name: oldKey.name
                    });
                    modified = true;
                  }
                }
              }
              return JSON.stringify(data);
            } catch {
              return line;
            }
          });
          
          if (modified) {
            fs.writeFileSync(fullPath, newLines.join('\n') + '\n', 'utf-8');
            migratedCount++;
            console.log(`Migrated JSONL: ${fullPath}`);
          }
        } catch (e) {
          console.error(`Error migrating JSONL ${fullPath}:`, e);
          errorCount++;
        }
      }
    }
  }
  
  console.log('Starting channelKey format migration...');
  scanDirectory(sessionsDir);
  console.log(`Migration complete: ${migratedCount} files migrated, ${errorCount} errors`);
}
```

**调用位置**：在 `src/index.ts` 的启动流程中添加

```typescript
// 在 main() 函数中，加载配置后、启动服务前
import { migrateChannelKeyFormat } from './migrations/migrate-channelkey-format.js';

// ... 加载配置 ...

// 执行迁移（仅在首次启动或版本升级时）
const migrationFlag = path.join(paths.dataDir, '.channelkey-migrated');
if (!fs.existsSync(migrationFlag)) {
  logger.info('Running channelKey format migration...');
  await migrateChannelKeyFormat();
  fs.writeFileSync(migrationFlag, new Date().toISOString(), 'utf-8');
  logger.info('✓ channelKey format migration completed');
}

// ... 继续启动 ...
```

---

### 4. 测试文件

需要更新所有涉及 channelKey 的测试用例（如果有）。

---

## 迁移步骤

### 阶段 1：准备（不影响运行）

1. ✅ 创建 `extractSelfPeerId()` 函数
2. ✅ 创建迁移脚本 `migrate-channelkey-format.ts`
3. ✅ 添加单元测试验证新格式

### 阶段 2：代码修改（向后兼容）

1. ✅ 修改 `formatChannelKey()` 和 `parseChannelKey()`
2. ✅ 修改 `effectiveChannelName()`
3. ✅ 添加兼容逻辑：同时支持新旧格式解析
4. ✅ 更新所有使用 channelKey 的地方

### 阶段 3：数据迁移

1. ✅ 在启动时自动执行迁移脚本
2. ✅ 迁移所有 active.json
3. ✅ 迁移所有 thread session JSONL
4. ✅ 创建迁移标记文件

### 阶段 4：清理（可选）

1. ✅ 移除旧格式兼容代码
2. ✅ 更新文档和注释

---

## 风险评估

### 高风险

1. **Session 数据损坏**
   - 缓解：迁移前备份 `~/.evolclaw/data/sessions/`
   - 回滚：恢复备份

2. **channelKey 解析失败**
   - 缓解：保留旧格式兼容逻辑
   - 回滚：代码回退

### 中风险

1. **部分 session 迁移失败**
   - 缓解：迁移脚本记录错误日志
   - 处理：手动修复失败的文件

2. **多实例并发启动**
   - 缓解：使用文件锁保证迁移只执行一次
   - 处理：第二个实例检测到迁移标记后跳过

### 低风险

1. **性能影响**
   - 影响：迁移过程可能需要几秒钟
   - 缓解：只在首次启动时执行

---

## 回滚方案

### 代码回滚

```bash
git revert <migration-commit>
npm run build
evolclaw restart
```

### 数据回滚

```bash
# 恢复备份
rm -rf ~/.evolclaw/data/sessions/
cp -r ~/.evolclaw/data/sessions.backup/ ~/.evolclaw/data/sessions/

# 删除迁移标记
rm ~/.evolclaw/data/.channelkey-migrated

# 重启
evolclaw restart
```

---

## 验证清单

- [ ] 所有 active.json 的 channel 字段格式正确
- [ ] 所有 thread session JSONL 的 channel 字段格式正确
- [ ] channelKey 解析和格式化功能正常
- [ ] Agent Registry 索引功能正常
- [ ] Session 创建和查找功能正常
- [ ] CLI 命令返回正确的 channelKey
- [ ] 消息收发功能正常
- [ ] 无错误日志

---

## 总结

### 需要修改的文件

| 文件 | 改动类型 | 复杂度 |
|------|---------|--------|
| `src/core/channel-loader.ts` | 核心逻辑 | 高 |
| `src/core/evolagent.ts` | 核心逻辑 | 高 |
| `src/core/evolagent-registry.ts` | 注释更新 | 低 |
| `src/cli/agent.ts` | 逻辑调整 | 中 |
| `src/cli/index.ts` | 逻辑调整 | 中 |
| `src/migrations/migrate-channelkey-format.ts` | 新增 | 高 |
| `src/index.ts` | 添加迁移调用 | 低 |
| 所有 `active.json` | 数据迁移 | 自动 |
| 所有 `_threads/*.jsonl` | 数据迁移 | 自动 |

### 预计工作量

- **代码修改**：4-6 小时
- **测试验证**：2-3 小时
- **数据迁移脚本**：2-3 小时
- **总计**：8-12 小时

### 建议

1. **先在测试环境验证**
2. **备份生产数据**
3. **分阶段部署**
4. **保留回滚能力**

## 日期

2026-05-24

# 配置模块现状说明：`config-store.ts` vs `src/core/config/`

> 生成日期：2026-06-17
> 范围：分析 `src/config-store.ts` 与 `src/core/config/` 五个文件的职责重叠与实际使用情况
> 结论：**双轨并行 + 逐步收敛**，新功能已统一走 `core/config`，老代码因数据迁移未完成而保留过渡 wrapper

---

## 1. 两个模块是什么

### `src/core/config/`（配置体系 v2 核心，5 个文件）

实现 `docs/config-system-design-v2.md` 的完整配置框架，是**唯一的配置读写/合并实现点**。

| 文件 | 行数 | 职责 |
|------|-----|------|
| `config-manager.ts` | 406 | 配置读写统一归口；H 链/HA 链解析；字段路由 |
| `merge.ts` | 174 | 类型驱动合并（scalar/list/dict）；`${VAR}` 三级 .env 展开 |
| `schema-registry.ts` | 170 | Schema 加载（SSOT）；AJV 校验；字段名不相交硬约束 |
| `snapshot.ts` | 553 | 配置快照/恢复/回滚；版本差异比对；保留策略 |
| `boot-log.ts` | 268 | 启动日志（按月归档）；自检回落（逐版本真实启动探测） |

**核心能力**：
- 四层覆盖链：defaults → agent/config → relation/config（H 链）
- 角色层 behavior：agent/behavior → role → relation/behavior（HA 链）
- Schema 驱动的合并语义（字段无特判）
- 版本控制与配置损坏自动回落

### `src/config-store.ts`（高层业务门面，609 行）

新结构（`evolclaw-home-directory.md`）的配置加载/合并/写入入口，承担**运行时加载 + 业务逻辑**。

**核心能力**：
- 进程级配置 `EvolclawConfig`（Tunnel / ServiceProxy / ecweb / owners）
- 配置文件读写（`loadDefaults` / `loadAgent` / `saveAgent` 等）
- 批量加载（`loadAllAgents` 扫描 `agents/` 目录）
- 业务校验（`validateAgentConfig`，channel 重复名检测）
- 迁移工具（项目径迁移、identities→relations、旧 config.json→evolclaw.json）
- 目录骨架（`ensureAgentDirSkeleton`）

---

## 2. 职责重叠分析

| 功能 | config-store.ts | src/core/config/ | 重叠度 |
|------|----------------|------------------|:------:|
| 配置文件读写 | `loadDefaults` / `loadAgent` / `loadEvolclawConfig` | `read()` / `write()` | 🔴 高 |
| 环境变量展开 | `expandEnvRefs` / `expandEnvRefsForAgent`（薄封装） | `expandVars` / `buildEnvResolver`（底层） | 🟡 中（已收敛） |
| 配置合并 | `mergeForAgent`（**@deprecated**） | `resolveAgentConfig` / `resolveBehavior` | 🟡 中（已委托） |
| Schema 校验 | `validateAgentConfig`（**@deprecated** 业务规则） | AJV schema 校验 | 🟡 中（过渡期） |
| 关系级配置 | ❌ 不支持 | ✅ `ConfigTarget.Relation` | 不重叠 |
| 角色级覆盖 | ❌ 不支持 | ✅ `resolveBehavior({ role })` | 不重叠 |
| 快照/回滚 | ❌ | ✅ `snapshot` / `restore` | 不重叠 |
| 自检回落 | ❌ | ✅ `selfDiagnose` | 不重叠 |
| 批量加载 | ✅ `loadAllAgents` | ❌ | 不重叠 |
| 迁移工具 | ✅ `migrateProject` 等 | ❌ | 不重叠 |
| 目录骨架 | ✅ `ensureAgentDirSkeleton` | ❌ | 不重叠 |

**重叠集中在三处**：配置读写、环境变量展开、配置合并。其中后两者已经实质收敛（config-store 内部委托 core/config），唯有**基础读写仍双轨并行**。

---

## 3. 实际使用情况

### 两边都在使用 —— 调用分布

```
config-store.ts          被 ~15 处导入（启动流程 + 多个 CLI 命令 + channels）
src/core/config/         被 ~8 处导入（新 CLI + 消息处理 + config-store 内部委托）
```

### 关键路径使用拆解

**① 主启动流程（`src/index.ts`）—— 混用**
```typescript
// 传统路径：加载配置
import { loadDefaults, loadAllAgents, mergeForAgent, ... } from './config-store.js';
// 新功能：初始化 + 快照 + 自检
import { initConfigManager } from './core/config/config-manager.js';
import { snapshot, retentionCleanup, ... } from './core/config/snapshot.js';
import { appendBootLog, selfDiagnose } from './core/config/boot-log.js';
```
启动时用 config-store 加载配置，但快照/回滚/自检走 core/config。

**② 消息处理运行时（`src/core/message/message-processor.ts`）—— 只用 core/config**
```typescript
import { resolveBehavior } from '../config/config-manager.js';
// 逐消息解析（支持 peer/role 级覆盖，config-store 无此能力）
const behavior = resolveBehavior({ self, peerKey, role }, { cache: true });
```

**③ CLI 命令 —— 双轨**
- 传统命令（`agent.ts` / `init.ts` / `daemon-commands.ts`）：读用 config-store，写用 ConfigManager
- 新命令 `ec config`（`src/cli/config.ts`，16 子命令）：完全使用 core/config

**④ config-store 内部 —— 已委托**
```typescript
import { resolveAgentConfig, resolveBehavior } from './core/config/config-manager.js';
import { expandVars, buildEnvResolver } from './core/config/merge.js';

export function mergeForAgent(...) {  // @deprecated
  const h = resolveAgentConfig(sel);       // 委托
  const behavior = resolveBehavior(sel);   // 委托
  return { ...behavior, ...h };
}
```

---

## 4. 为什么还没完全收敛

代码注释中标明两个阻塞因素：

### 阻塞 ① 数据迁移未完成
`validateAgentConfig()` 注释指出：
- 现有 `agent config.json` 仍混有 behavior(HA) 字段（`active_baseagent` / `baseagents` 等）
- 仍可能有少量历史/实验字段残留
- `agent-config` schema 是 `additionalProperties:false`
- **此刻切到 schema 校验会让所有现存 agent 加载失败**

因此 `validateAgentConfig` 暂保留纯业务规则校验，待数据迁移（behavior 字段拆出 + schema 补齐 projects 子字段）完成后再切换。

### 阻塞 ② 向后兼容需求
- 主启动流程 `src/index.ts` 仍依赖 config-store 的 `loadDefaults` / `mergeForAgent`
- 改动主流程风险高，需要全面回归测试

---

## 5. 设计意图（从注释推断）

```
config-store.ts  → 过渡期高层门面
                   • 保留向后兼容签名（loadDefaults/loadAgent/mergeForAgent）
                   • 持有业务逻辑（迁移/骨架/批量加载）
                   • 底层已委托 core/config
                        ↓ 委托
src/core/config/ → 配置体系 v2 核心（唯一实现点）
                   • 读写/合并/校验/版本控制
```

`mergeForAgent` 和 `validateAgentConfig` 均已标注 `@deprecated`，计划在 **v2.2** 完成数据迁移后移除。

---

## 6. 收敛建议

### 短期（保持现状）
两边并存。新功能一律走 core/config，老代码不急着动。可在 config-store.ts 顶部补一段定位说明，明确"过渡期门面"角色。

### 中期（v2.2，数据迁移完成后）
1. 完成 H/HA 物理分离（behavior 字段从 config.json 拆出）
2. schema 补齐 `projects` 子字段
3. 移除 `validateAgentConfig()`，切到 `ConfigManager.validateConfig`
4. 移除 `mergeForAgent()` wrapper
5. 让 `loadDefaults` / `loadAgent` 内部调用 `ConfigManager.read()`，消除双轨读写

### 长期（v2.3+）
主启动流程 `src/index.ts` 直接导入 ConfigManager；config-store 只保留无法下沉的业务工具（迁移、目录骨架、批量加载、进程级 EvolclawConfig）。

---

## 7. 一句话总结

**两边都在用，不是冗余而是过渡。** `core/config` 是新核心（关系/角色配置、快照、自检、新 CLI 都只走它），`config-store` 是高层门面（保留启动加载、批量扫描、迁移、目录骨架等业务逻辑），重叠的合并/展开逻辑已由 config-store 委托给 core/config。完全收敛被「现存 config.json 数据格式未迁移」这一前提卡住，计划随 v2.2 数据迁移落地。

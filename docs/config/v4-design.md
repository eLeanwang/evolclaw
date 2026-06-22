# 配置体系 v4 设计文档

> 基于 v3 的重大重构。核心变更：废除四层覆盖链，以角色字典替代关系级配置，引入标记文件绑定对端身份。
> 状态：设计草案，待实现。

---

## 一、与 v3 的核心差异

| 维度 | v3 | v4 |
|------|----|----|
| 配置层数 | 四层（进程/全局/agent/关系） | 两层（进程/agent）+ 角色内两级回退 |
| 全局级 | `defaults.json` | **删除** |
| 关系级配置 | `relations/{peerKey}/config.json` | **删除** |
| 对端个性化 | per-peer config 文件 | 角色字典（共享） |
| 关系级目录 | config + 数据 | 仅数据 + 角色标记文件 |
| 覆盖链合并 | 三文件 deepMerge | 角色字典内两级回退（相同算法） |
| 身份/权限来源 | owners[]/admins[] 列表 + permissionMode | owners[]/admins[] 列表 + 角色字典 permissions 字段 |
| 运行时身份 | resolveIdentity → owner/admin/guest/anonymous | 同左，改为读标记文件 → 角色 |

---

## 二、文件结构

```
{evolclaw_home}/
├── evolclaw.json                          ← 进程级（不变）
├── .env                                    ← 全局凭证（不变）
└── agents/
    └── {aid}/
        ├── config.json                    ← agent 级（含角色字典，重大变更）
        ├── .env                            ← agent 级凭证（不变）
        └── relations/
            └── {peerKey}/
                ├── .role                  ← 角色标记文件（新增，纯文本，单行角色名）
                ├── profile.md             ← 关系数据（不变）
                └── history.jsonl          ← 关系数据（不变）
```

**删除**：`agents/defaults.json`、`relations/{peerKey}/config.json`、`relations/{peerKey}/.env`

---

## 三、身份解析模型（新）

每条消息到达时，按以下优先级确定 peerKey 对应的身份：

```
1. peerKey ∈ config.json 的 owners[]  → 身份 = owner
2. peerKey ∈ config.json 的 admins[]  → 身份 = admin
3. relations/{peerKey}/.role 文件存在  → 身份 = 文件内容（如 "vip"）
4. 以上皆否                            → 身份 = config.json 的 default_role 字段值
```

说明：
- **owners[]/admins[]** 是人专属字段（hook 锁定），不通过标记文件管理。这解决了第一个 owner 的引导问题——直接写 config.json，无鸡生蛋。
- **标记文件**只服务运营角色（vip/staff 等自定义角色），不承载 owner/admin。
- **default_role**：新增字段，值必须是 roles 字典中已定义的角色名（**不能是 `_default`**）。建议默认 `"anonymous"`（零信任）。无标记、非 owner/admin 的陌生对端一律落这里。
- **进程级 owners**（`evolclaw.json` 的 owners）保留，作为 daemon 控制面引导层，与 per-agent 的 owners[] 独立，不参与上述解析。

---

## 四、角色字典（新）

### 4.1 结构位置

inline 进 `agents/{aid}/config.json`：

```jsonc
{
  "aid": "bot1.aid.pub",
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub"],
  "default_role": "anonymous",      // 新增：陌生对端默认角色
  "channels": [...],

  "roles": {                        // 新增：角色字典
    "_default": {                   // 兜底角色（保留字，不可作为真实角色名）
      "baseagents": { "claude": { "model": "sonnet", "effort": "medium" } },
      "chatmode": { "private": "interactive", "group": "interactive" },
      "flush_delay": 3,
      "permissions": {
        "config": {
          "read": ["chatmode", "baseagents"],
          "write": {}
        }
      }
    },
    "guest": {
      "permissions": {
        "config": { "read": ["chatmode"], "write": {} }
      }
    },
    "anonymous": {
      "permissions": {
        "config": { "read": [], "write": {} }
      }
    },
    "vip": {
      "baseagents": { "claude": { "model": "opus", "effort": "max" } },
      "chatmode": { "private": "proactive" },
      "permissions": {
        "config": {
          "read": ["chatmode", "baseagents", "flush_delay"],
          "write": {
            "chatmode.private": null,               // null = 任意值
            "baseagents.claude.effort": ["low", "medium", "high"]  // 候选值白名单
          }
        }
      }
    },
    "owner": {
      "permissions": { "config": { "read": "*", "write": "*" } }
    },
    "admin": {
      "permissions": { "config": { "read": "*", "write": "*" } }
    }
  }
}
```

### 4.2 标准角色（schema 预定义）

schema 预定义以下角色名及其 permissions 约束结构：

| 角色名 | 说明 | permissions 默认 |
|--------|------|-----------------|
| `_default` | 保留字，参数继承基线，**不可作为标记文件的值，也不可作为 default_role 的值** | 由 agent 配置 |
| `owner` | 最高权限，read/write `"*"` | `"*"` |
| `admin` | 管理权限，read/write `"*"` | `"*"` |
| `guest` | 授权用户，基础权限 | read 部分字段，write 极少 |
| `anonymous` | 未授权/陌生人，零或最低权限 | read 极少或无，write 无 |

agent 可在此基础上自定义任意角色名（`vip`/`staff` 等）。自定义角色若未配某参数，从 `_default` 回退。

### 4.3 回退机制

```
effective[参数] = roles[命中角色][参数]  ??  roles["_default"][参数]
```

合并算法与 v3 完全相同（deepMerge 唯一实现）：
- **标量**：命中角色整体覆盖
- **列表**：并集去重
- **字典**：第一层键并集，同键命中角色值覆盖，**不递归**

⚠️ **已知陷阱**：字典类参数（如 `baseagents.claude`）若命中角色只写了部分子字段，会整体遮蔽 `_default` 的同键对象，导致未写的子字段丢失。**规范：角色配置字典类参数必须写完整，不能只写差异。**

---

## 五、角色标记文件

- **路径**：`relations/{peerKey}/.role`
- **格式**：纯文本，单行，内容为角色名（如 `vip`）。
- **约束**：
  - 内容必须是 roles 字典中已定义的角色名。
  - **不能是 `_default`**（保留字，只做参数继承，不可分配给对端）。
  - 不能是 `owner`/`admin`（这两个身份通过 owners[]/admins[] 列表管理，不走标记文件）。
  - hook **禁止 agent 读/写/改**此文件。
  - 只能通过 `ec config bind` 命令写入(人专属)。
- **缺省**：文件不存在 → 对端落 `default_role`。

---

## 六、权限控制

### 6.1 permissions 字段结构

```jsonc
"permissions": {
  "config": {
    "read": ["field1", "field2"] | "*",
    "write": {
      "field.path": null | ["candidate1", "candidate2"]
    } | "*"
  }
}
```

- `read`：可通过 `ec config get/show/effective` 读取的顶层参数名列表；`"*"` 表示全部可读。
- `write`：可写的参数路径字典；值为 `null` 表示任意值；值为数组表示候选值白名单，写入值不在列表内则拒绝；`"*"` 表示全部可写。
- 未出现在 `write` 中的参数 = 不可写。

### 6.2 权限修改规则

- **只有 owner 和 admin** 可以修改 roles 字典（包括其中的 permissions 字段）。
- config 命令集在任何"写角色/写权限字段"操作前，先判调用者是否 owner/admin，否则拒绝。
- 当前阶段：owner/admin 可改所有配置参数，后续再细化。

### 6.3 判权铁律（不可违反）

**调用者身份只来自 evolclaw 注入的、agent 改不了的会话上下文（CTL token 绑定的 peerKey）；命令行 selector（`--self`/`--peer`）只决定操作目标，绝不参与判权。**

违反此条 = agent 可一行命令冒充 owner 提权。

---

## 七、CLI 变更

### 7.1 Selector 规则（v4）

config.json 的字段分两类，决定 `--role` 是否适用：

| 字段类型 | 例子 | `--role` |
|---------|------|---------|
| **角色相关**（在 roles 字典内） | `chatmode`、`baseagents`、`flush_delay`、`permissions` | **必须带**（值随角色而变） |
| **agent 顶层**（不在 roles 内） | `aid`、`channels`、`owners`、`admins`、`default_role` | **不适用**（全局唯一，带了报错） |

所有 `ec config` 操作的 selector：

| 参数 | 含义 | 规则 |
|------|------|------|
| `--self <aid>` | 本端 agent | 所有操作必须携带 |
| `--role <roleName>` | 要操作的角色 | 操作角色相关字段时**读写都必须显式**；操作顶层字段时不接受 |
| `--process` | 进程级 | 仅用于 evolclaw.json，不需要 `--role` |

`--default`（原指 defaults.json）和 `--peer`（原指 relation/config.json）**已移除**。

**为什么读也强制 `--role`**：v4 之后配置值本质上是角色相关的——同一个 `chatmode.private`，`vip` 与 `guest` 看到的可能不同，不存在"role-free 的值"。强制每次指明角色，避免"省略默认 `_default`"制造"这就是那个值"的假象。

```bash
# 读角色相关字段（--role 必须）
ec config get chatmode.private --self bot1 --role vip
ec config get chatmode.private --self bot1 --role _default

# 读 agent 顶层字段（不带 --role）
ec config get channels --self bot1
ec config get owners --self bot1

# 写角色相关字段（--role 必须）
ec config set chatmode.private proactive --self bot1 --role vip

# 查看某角色的完整有效配置（_default 兜底后的合并结果）
ec config effective --self bot1 --role vip
```

### 7.2 对端角色绑定命令（新增，全在 `ec config`）

```bash
# 绑定对端到角色（写 .role 文件，人专属，不需要 --role）
ec config bind <peerKey> <roleName> --self <aid>

# 解绑（删 .role 文件，对端回落 default_role）
ec config unbind <peerKey> --self <aid>

# 查看对端当前解析到的角色及有效配置
ec config whoami <peerKey> --self <aid>
```

### 7.3 `--caller-msg` 参数（群聊必须）

**规则**：在群聊上下文下，`ec config` 的**读和写操作均必须携带** `--caller-msg <text>`。

```bash
# 群聊中 agent 执行 config 读/写操作
ec config get chatmode.private --self bot1 --role vip --caller-msg "当前是什么对话模式"
ec config set chatmode.private proactive --self bot1 --role vip --caller-msg "帮我改成 proactive 模式"
```

**系统处理逻辑**：

```
1. 取 --caller-msg 值
2. 在当前 session 消息缓冲区（evolclaw 侧维护，agent 不可写）中精确匹配原文
3. 找到唯一条目 → 取该条目的 senderPeerKey（来自 AUN 消息元数据，可信）
4. 按第三节身份解析顺序得到身份 → 按 permissions 判权
5. 有权 → 执行；无权 → 拒绝并说明
```

**边界处理**：

| 情形 | 处理 |
|------|------|
| 群聊 + 缺少 `--caller-msg` | 拒绝，返回 `群聊场景需要 --caller-msg 参数` |
| 消息未在缓冲区找到 | 拒绝，返回 `caller message not found in session buffer` |
| 多条相同原文 | 取最近一条的发送者 |
| 私聊（单对端） | `--caller-msg` 可省略，直接用 session 绑定的 peerKey 判权 |

**安全保证**：归因来自 evolclaw 消息缓冲（可信源），agent 提供的文本是"查找键"而非"身份声明"，无法伪造。

### 7.4 移除/变更的命令行为

| 变更项 | v3 行为 | v4 行为 |
|--------|---------|---------|
| `--default` selector | 指向 defaults.json | **移除**（defaults.json 已删） |
| `--peer` selector | 写入 relation/config.json | **移除**，关系级配置已删 |
| `ec config set ... --peer` | 写关系级配置 | **不再支持**，改用 `--role` |
| `ec relation` 命令集 | 管理关系级配置 | **移除**，绑定操作并入 `ec config bind/unbind/whoami` |

保留不变：`ec model`/`ec ctl` 等快捷命令内部改走新路径，外部接口不变。

---

## 八、ConfigManager 变更

### 8.1 ConfigTarget 变更

```typescript
enum ConfigTarget {
  Process   = 'process',    // evolclaw.json（不变）
  Agent     = 'agent',      // agents/{aid}/config.json（不变）
  // 删除: Defaults = 'defaults'
  // 删除: Relation = 'relation'
}
```

### 8.2 resolveEffectiveConfig（重写）

```typescript
resolveEffectiveConfig(selector: { self: string; peerKey?: string }): EffectiveAgentConfig {
  const agentConfig = this.read<AgentConfig>(ConfigTarget.Agent, selector);
  
  // 确定角色
  const role = this.resolveRole(selector.self, selector.peerKey);  // 按第三节顺序
  
  // 两级回退合并
  const baseRole = agentConfig.roles?.['_default'] ?? {};
  const roleConfig = agentConfig.roles?.[role] ?? {};
  const roleEffective = deepMerge(baseRole, roleConfig);          // 同一 deepMerge
  
  return { ...agentConfig, ...roleEffective, _resolvedRole: role };
}
```

旧的 `resolveAgentConfig`（三文件链合并）废弃，`resolveEffectiveAgentConfig` 重写为上述逻辑。

### 8.3 resolveRole（新增）

```typescript
resolveRole(selfAid: string, peerKey?: string): string {
  if (!peerKey) return '_default';        // coding 模式

  const config = this.read<AgentConfig>(ConfigTarget.Agent, { self: selfAid });

  if (config.owners?.includes(peerKey)) return 'owner';
  if (config.admins?.includes(peerKey)) return 'admin';

  const markerPath = path.join(agentDir, 'relations', encodePeerKey(peerKey), '.role');
  if (fs.existsSync(markerPath)) {
    return fs.readFileSync(markerPath, 'utf8').trim();
  }

  return config.default_role ?? 'anonymous';
}
```

---

## 九、Schema 变更

### 9.1 删除的 schema 文件

- `kits/schemas/defaults.schema.1.json`
- `kits/schemas/relation-config.schema.1.json`

### 9.2 agent-config schema 新增字段

```jsonc
{
  "properties": {
    "default_role": {
      "type": "string",
      "description": "无标记文件且非 owner/admin 的对端的默认角色名，必须是 roles 字典中已定义的键且不能是 _default",
      "default": "anonymous"
    },
    "roles": {
      "type": "object",
      "description": "角色字典。_base 为保留字兜底角色",
      "properties": {
        "_base": { "$ref": "#/definitions/RoleConfig" }
      },
      "additionalProperties": { "$ref": "#/definitions/RoleConfig" }
    }
  },
  "definitions": {
    "RoleConfig": {
      "type": "object",
      "properties": {
        // 行为参数（与原 AgentConfig 行为字段一致）
        "baseagents":      { "type": "object" },
        "active_baseagent":{ "type": "string" },
        "chatmode":        { "type": "object" },
        "flush_delay":     { "type": "number" },
        "debounce":        { "type": "number" },
        "dispatch":        { "type": "object" },
        "show_activities": { "type": "string" },
        "proactive":       { "type": "object" },
        "render":          { "type": "object" },
        "enable_rich_content": { "type": "boolean" },
        "permissionMode":  { "type": "string" },
        // 权限授予字段（新增）
        "permissions": { "$ref": "#/definitions/PermissionsConfig" }
      }
    },
    "PermissionsConfig": {
      "type": "object",
      "properties": {
        "config": {
          "type": "object",
          "properties": {
            "read":  { "oneOf": [{ "type": "array", "items": { "type": "string" } }, { "const": "*" }] },
            "write": { "oneOf": [{ "type": "object" }, { "const": "*" }] }
          }
        }
      }
    }
  }
}
```

### 9.3 _meta.json 变更

```jsonc
{
  "schemas": {
    "evolclaw":       { "currentVersion": 1 },
    "agent-config":   { "currentVersion": 3 },   // v2→v3 迁移：增 roles/default_role，移除独立合并逻辑
    // 删除: "defaults"
    // 删除: "relation-config"
  }
}
```

---

## 十、快照树变更

### 10.1 纳入快照 ✅

```
evolclaw.json
agents/{aid}/config.json          （含角色字典，一并快照）
agents/{aid}/relations/{peerKey}/.role  （角色绑定可回滚）
```

### 10.2 不进快照 ❌

```
agents/defaults.json              （已删除）
agents/{aid}/relations/{peerKey}/config.json  （已删除）
任何 .env 文件
关系数据 profile.md / history.jsonl
```

**实现**：快照按**文件名白名单**扫描关系目录（只取 `.role`），不按目录整体包含。

### 10.3 .env 层级（简化）

v4 的 `.env` 解析优先级从三级简化为两级：`agent 级 .env > 全局 .env > process.env`。
关系级 `.env` 随关系级配置层一并删除。

**机制铁律**：**要进快照 → 不准放 `.env`；放了 `.env` → 注定不进快照。** 同一规则两面，无例外。

---

## 十一、受影响模块清单

| 模块 | 变更内容 | 优先级 |
|------|---------|--------|
| `src/types.ts` | 删 `DefaultsConfig`/`RelationConfig`/`MergedAgentConfig`；AgentConfig 增 `roles`/`default_role` | P0 |
| `src/config/config-manager.ts` | 删 Defaults/Relation target；重写 `resolveEffectiveConfig`；新增 `resolveRole` | P0 |
| `src/config/schema-registry.ts` | 删 defaults/relation-config schema；agent-config 升版至 v3 | P0 |
| `src/core/evolagent.ts` | 配置读取改走新 `resolveEffectiveConfig` | P0 |
| `src/core/evolagent-registry.ts` | 热路径 `resolveByChannel().config` 对接新解析 | P0 |
| `src/core/dispatch.ts`（或 aun.ts adapter） | `resolveIdentity` 重写为读标记文件路径 | P0 |
| `src/cli/config.ts` | 删 `--default` selector；群聊下强制 `--caller-msg`；新增 caller归因逻辑 | P1 |
| `src/cli/config.ts` | 新增 `bind/unbind/whoami` 子命令;删 `--default` selector;群聊下强制 `--caller-msg`;新增 caller归因逻辑 | P1 |
| `src/cli/model.ts` | 写模型配置改走 agent roles._base 或指定角色 | P1 |
| `src/core/model/config-scope.ts` | 删 relation scope；改走角色字典 | P1 |
| `src/config-store.ts` | 删 `loadDefaults`/`saveDefaults`/`loadRelationConfig` 等接口 | P1 |
| `kits/schemas/` | 删 2 个 schema 文件；新增 agent-config v3 迁移函数 | P1 |
| `kits/docs/evolclaw/config.md` | 全部重写 | P2 |
| `kits/rules/04-relation.md` | 删关系级 config.json 相关描述；加标记文件说明 | P2 |
| `docs/config/` | 01~09 各文件按本文更新；config-roles-layer-design.md 重写 | P2 |

---

## 十二、已知限制（设计决策，非遗漏）

1. **不支持 per-peer 微调**：同角色的对端配置完全一致，不再有单对端配置覆盖。bespoke 需求请建独立角色。
2. **角色定义 per-agent**：roles 字典在每个 agent 的 config.json，跨 agent 的角色一致性由运维保证，无全局角色库。
3. **字典类参数非递归覆盖**：角色配置字典类字段（如 `baseagents.claude`）必须写完整，不能只写差异（见四节警告）。
4. **消息缓冲时间窗口**：群聊下 `--caller-msg` 依赖 session 消息缓冲，过期消息找不到则拒绝执行。

---

> 下一步：基于本文档逐模块实现，建议按优先级 P0 → P1 → P2 顺序推进。
> 实现前先执行 `ec config snapshot --full` 创建 v3 全量快照作为基线。

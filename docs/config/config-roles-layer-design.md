# 角色层设计（草案）

> 状态：草案，**未定稿**。本文是 `config-system-design.md` 的扩展层，待基础配置体系定稿后再推进实现。
> 主文档当前不引用本文，避免基础设计未收敛时被牵连。

## 目标

为 agent 引入一套自定义角色（RBAC）：人为 agent 定义若干角色，把对端指派到角色，角色持有该类对端共享的配置。全程人专属（H 类），agent 不可写。

## 三段式落位

| 位置 | 文件/字段 | 作用 | 权限 |
|------|----------|------|------|
| Agent 级 | `config.json` 的 `roles` 字段 | **注册表**：本 agent 有哪些角色 + 优先级顺序（声明顺序，靠后压靠前） | H |
| 关系级 | `relations/{peerKey}/config.json` 的 `roles` 字段 | **成员关系**：该对端属于哪些角色（无序集合） | H |
| 角色配置 | `roles/{name}.json` | 该角色独有的具体配置，一角色一文件 | H |

```jsonc
// agents/{aid}/config.json —— 注册表，顺序即优先级
{ "roles": ["staff", "vip"] }

// agents/{aid}/relations/{peerKey}/config.json —— 该对端的成员关系
{ "roles": ["vip"] }

// agents/{aid}/roles/vip.json —— vip 角色的配置
{ "$schema_version": 1, /* vip 专属字段 */ }
```

## 覆盖链位置：agent < role < relation

```
defaults  →  agent/config  →  role 文件(按 agent 声明顺序)  →  relation/config
(最低)                                                          (最高)
```

- 角色是"一类对端的默认"，关系级是"单个对端的覆盖"——**具体压一般**。
- 条件性层：对端没绑角色时角色层不参与，链退化回 `defaults → agent → relation`。
- 合并算法不变：仍是 `config-system-design.md` 第六节的类型驱动深合并（标量覆盖 / 列表并集 / 字典键合并同键覆盖）。角色层只是在层列表里多插了几项。

## 解析流程（比现有多一个间接寻址）

```
1. 读 relation/config.json → 该对端的 roles，如 ["vip"]
2. 每个角色名 → 读 agents/{aid}/roles/{name}.json
3. 按 agent/config 的 roles 声明顺序排序这些角色文件（不按 relation 列表顺序）
4. 层列表：[defaults, agent/config, ...role文件们(已排序), relation/config]
5. reduce(deepMerge) —— 原样跑第六节合并
```

## 两个已定的设计点

1. **多角色优先级由 agent 声明顺序决定，不由 relation 列表顺序决定。** 角色优先级是 agent 角色系统的全局属性，不会因为不同对端把角色名写成不同顺序而漂移。这让 agent 级 `roles` 声明承担实质作用：注册表 + 排序 + 白名单。
2. **agent 声明是白名单。** relation 只能指派 agent 已声明的角色；指派未声明角色 → 拒绝或忽略告警。

## 未决点（推进前必须拍板）

- **D1：角色文件可以装哪些字段？**
  建议先只走基础权限/访问控制字段（可用命令、配额、特性开关）。"vip 默认 proactive"这类行为默认确认真需要再加。角色系统的具体设计待权限体系明确后再完善。

- **D2：术语撞车——必须先解决。**
  现有 `resolveIdentity` 返回的 `owner/admin/guest/anonymous` 已经叫 role。新增的 `vip/staff` 也叫角色。两个 "role" 同系统会混淆。需二选一：内置那套改称"权限层级/trust tier"；或自定义这套换词（group/tag/成员组）。字段名和代码依赖此决定。

- **D3：角色文件缺失的处理。** relation 指派了 `vip` 但 `roles/vip.json` 不存在 → 建议跳过 + 告警，不阻断对话。

## 待主文档定稿后的连带改动（实现时）

- 新增 schema：`kits/schemas/role-config.schema.json`
- `ConfigTarget` 新增 `Role`
- 快照目录树纳入 `roles/`
- agent-config.schema 增 `roles`（注册表）字段；relation-config.schema 增 `roles`（成员）字段
- ConfigManager 的 resolve 加"展开角色文件"前置步骤
- 文件路径速查表补角色相关行

## 关联

- `docs/config/01-overview.md` — 配置体系总体架构
- `docs/config/02-merge-rules.md` — 覆盖链与合并规则
- `docs/config/04-config-manager.md` — ConfigManager API

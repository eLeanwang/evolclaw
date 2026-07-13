# Skill 跨 Agent 注入 — 设计方案

> 状态：Design（brainstorm 产出，待评审）
> 日期：2026-07-11
> 范围：EvolClaw menu protocol、capability 子系统、EvolAgent 生命周期
> 关联：本方案与《Menu Protocol Agent 克隆》(`2026-07-10-menu-protocol-agent-clone-design.md`) 共享打包/传输/隐私机制，仅 deploy 侧不同。共享部分只引用不复述。
> 背景：把某 agent 的 skill 搬进一个**已存在的** agent（不新建 agent）。克隆 spec 把这列为非目标「注入到已有 agent」并挂在其 §12 扩展——本方案即该扩展的独立设计。

## 1. 目标与语义

**注入 = 把源 agent A 的一个 skill 搬进接收主机 C 上一个已存在的 agent T**，T 就地获得该能力，不新建 agent、不铸新 AID。

与 agent 克隆的根本区别：克隆产出**新 agent**（`aidCreate` + 全套 layers 落地），注入是**增量合并进已有 agent**（追加一个 skill + 一条 capability 启用）。

MVP 只做 **skill**（`transfer: files`）。MCP（骨架 + 凭证对齐）、plugin（引用 + 安装）留二期——它们的合并语义与冲突面更复杂（见 §9）。

## 2. 与 agent 克隆的关系

| 环节 | 与克隆 spec 的关系 |
|---|---|
| pack 侧（A 打包上传） | **整套复用**：clone 门、transfer 分类、隐私自检、定向包、三方编排、进度/幂等——见克隆 spec §2/§5/§7/§9。pack 新增一个可选的**能力筛选**参数（只打某个 skill，不打全部）。 |
| 传输 | **整套复用**：AID 白名单分享（`create_share_link`）+ TTL + 限次 + retrieval 分片——见克隆 spec §9.1。 |
| deploy 侧 | **全新**（本方案主体）：不 `aidCreate`、不建新 agent，而是**合并进已有 agent T**——skill 文件落到 T 的 `.claude/skills/`、`updateCapabilityPolicy` 启用、更新 T 的 capability.md。 |
| 冲突处理 | **全新**：T 可能已有同名 skill → 报错中止，B 选 skip/overwrite/rename 后重发（见 §5）。 |
| 生效 | 同克隆：落地 + warning，**不自动 reload**，人工 reload/restart 生效。 |

一句话：**A 侧原样复用克隆的打包与传输，新增的全在"合并进已有 agent"这一侧**。

## 3. 前置：capability.md 地基（与克隆共享）

> ⚠️ 现状核实：`src/` 中 **0 处**引用 `capability.md` / `aun.capabilities.v1`——它是 `aun-group-capabilities-design.md` 设计但**尚未落地**的产物。当前实现的能力系统是 `config.json` 的 `capabilities` 块（JSON，`listCapabilityOptions` 发现 + `updateCapabilityPolicy` 写 override），skill 物理落在 `.claude/skills/`（project + user scope 全局扫描），**无 per-agent skill 目录**——启用/禁用靠 per-agent 的 config override。

capability.md 是克隆与注入**共同的前置件**（transfer 分类标记要挂在它上）。它需**先落地**再做本方案与克隆的能力层，落地要点：

- capability.md = **公开声明卡**（agent 有哪些能力 + 各能力的 `transfer` 策略），schema `aun.capabilities.v1`。
- config.json `capabilities` 块 = **私有启用态**（哪些启用/禁用，per-baseagent），已实现，不动。
- 两者关系：capability.md 声明"我有什么、可不可搬"，config 决定"当前启没启用"。

本方案的 deploy 侧**写** T 的 capability.md（追加被注入的 skill 声明）+ **写** T 的 config override（启用）。

## 4. menu 协议（pack 复用 + inject 新增）

```
① B→A   menu.action name=clone action=pack
         args={ cloneId, recipientAid:C, layers:["capabilities"],
                capabilityIds?:["wechat-reader"] }   // 新增：只打指定 skill，省略=capabilities 层全部
         → 立即返回 { cloneId, status:"packing" }
         // pack 流程、回执、进度、幂等全同克隆 spec §5/§7

② B→A   menu.query name=clone args={ cloneId }        // 同克隆 spec

③ B→C   menu.action name=clone action=inject
         args={ cloneId, package:{ shareId, sha256, sizeBytes, retrieval },
                targetAid,                              // 注入目标：C 上已存在的 agent
                resolution?:{ "<skillId>": "skip"|"overwrite"|"rename" } }  // 冲突消解（见 §5）
         → 首发无 resolution 且有冲突 → { cloneId, status:"conflict", conflicts:[...] }
           无冲突或已带 resolution → { cloneId, status:"injecting" }

④ B→C   menu.query name=clone args={ cloneId }
         → { cloneId, status, phase, detail?,
             result?:{ targetAid, injected:[...], warnings[] } }
```

- 复用 `name=clone`，新增动词 `action=inject`（对端是**已有 agent T**，非新建）。
- `targetAid` 由 B 指定（要注入进哪个已有 agent）。
- 沿用 `cloneId` 串起 pack↔inject 两端与进度查询。

## 5. 冲突处理（报错中止，B 选）

skill 以 id 为准（对应 `.claude/skills/<id>/`）。C 在落地前检测 T 的 skill 目录：

```
C inject 检测:
  for each skill in package:
    T 已有同名 <skillId>? ──否──▶ 直接落地
                         └是──▶ 记入 conflicts[]
  conflicts 非空 且 args 无对应 resolution
      ──▶ 中止，回 { status:"conflict", conflicts:[{ skillId, srcSha, dstSha }] }
```

B 拿到 conflicts 后，按每项决定并重发 inject（带 `resolution`）：

| resolution | 行为 |
|---|---|
| `skip` | 跳过该 skill，不覆盖 T 现有 |
| `overwrite` | 用包内版本替换 T 现有 `<skillId>/` |
| `rename` | 落为 `<skillId>-2`（自动避让），两版共存 |

未在 resolution 里给出的冲突项 → 仍视为未决，继续中止（不擅自处理）。

## 6. inject 落地（C 收到 inject）

```
C: get_by_share(shareId) 按 retrieval 取包 → 校验 sha256 → 解压 → 读 manifest
   → 隐私自检结果核对（A 已在 pack 时做，见克隆 spec §7.1）
   → baseagent 匹配检查：包内 skill 属 claude → 落 T 的 .claude/skills/；
        T 的 baseagent 与源不符（如 codex）→ 拒绝该 skill（跨 baseagent skill 格式不通，见 §9）
   → 冲突检测（§5）：有未决冲突 → 中止回 conflict
   → 逐 skill 落地：
        skip    → 跳过
        新增/overwrite → 拷到 T project 的 .claude/skills/<id>/
        rename  → 拷为 .claude/skills/<id>-2/
   → updateCapabilityPolicy(targetAid, baseagent, 'skill', 'enabled', <落地后的 id>)
   → 更新 T 的 capability.md：追加被注入 skill 的声明（含 transfer:files）
   → 不自动 reload（同克隆 §8.2）→ 回 warnings（需 reload/restart T 生效）
   → 回执 { targetAid, injected:[...], warnings[] }
```

要点：

- **物理落 project scope**：skill 落到 T 的 project `.claude/skills/`（非 user scope），避免泄漏到同主机其它 agent；启用靠 T 的 per-agent config override，本就隔离。
- **不碰 T 的 config 结构**：只追加一条 skill 的 `capabilities` override，不整体覆盖 config——故**无需克隆 spec §8.4 的 schema 版本闸**（没导入 config 结构）。
- **不自动生效**：注入只落文件 + 改 config，warning 提示人工 reload/restart。（reload 能刷新 config override，但新 skill 文件可能需 runner 重启才被 pick up——探索发现 runner 初始化时持有 skill 列表；稳妥起见提示 restart，同克隆的保守姿态。）

## 7. 权限

- `pack`：读 A 的 agent.md clone 门须为 `allow`，A 须运行态——**完全同克隆 spec §5.1**。
- `inject`：B 须是接收主机 C 的进程 owner（`isProcessLevelOwner` / 控制 channel 鉴权）。目标 agent T 在 C 上，B 作为 C 的进程 owner 天然可管 T。
- **鉴权注册**：`inject` 在 `resolveMenuIntent` + `isProcessLevelAction` 注册为 control/进程级 scope。

## 8. 涉及的现有代码

| 子系统 | 文件 | 复用点 |
|---|---|---|
| menu 引擎 | `src/core/command/menu-handler.ts` | `name=clone` 新增 `action=inject` 分支；pack 分支加 `capabilityIds` 筛选 |
| menu 鉴权 | `resolveMenuIntent` / `isProcessLevelAction` | 注册 `inject`=进程级 scope |
| capability 发现 | `src/core/capability/capability-manager.ts` | `listCapabilityOptions` 查 T 现有 skill（冲突检测）；pack 侧筛选源 skill |
| capability 启用 | `updateCapabilityPolicy(targetAid, baseagent, 'skill', 'enabled', id)` | 注入后启用 skill（已实现，直接用） |
| skill 物理路径 | claude/codex capability provider（`.claude/skills`、`.codex/skills`） | 落地目标目录解析、SKILL.md 校验 |
| capability.md | 前置件（§3） | deploy 侧追加被注入 skill 的声明 |
| agent 查找 | `src/core/evolagent-registry.ts` | `get(targetAid)` 定位 T；落地后可选触发 reload |
| pack/传输/进度 | 见克隆 spec §5/§7/§9 | 整套复用 |

## 9. 非目标（MVP 不做）

- **仅 skill**：MCP（骨架 + 凭证对齐）、plugin（引用 + 安装）留二期——合并语义更复杂（MCP 要并 config server 定义 + needs_credentials 对齐；plugin 要查本机安装态）。
- **不跨 baseagent 注入**：claude skill 只注入 claude agent，codex→codex；跨底座 skill 格式不通，直接拒绝该 skill。
- **不自动 reload/restart 目标 agent**：落地 + warning，人工生效。
- **不做 user-scope 注入**：只落 target project scope，不碰全局 `~/.claude/skills`。
- **不新建 agent**：注入只增量合并；新建走克隆 spec。

## 10. 后续扩展

- MCP 注入：骨架并入 T 的 config，凭证 warning 对齐。
- plugin 注入：引用名 + 本机安装态检查。
- 注入后自动 reload/restart 目标 agent（确认 runner 能安全热挂 skill 后）。
- 跨 baseagent skill 转换（若可行）。
- 批量注入：一次把多个 skill 注入多个目标 agent。

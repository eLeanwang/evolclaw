# Menu Protocol Agent 克隆 — 设计方案

> 状态：Design（设计锁定，待终审）
> 日期：2026-07-10（末次修订 2026-07-11）
> 范围：EvolClaw menu protocol、AUN storage.*、EvolAgent 生命周期、能力（capability）子系统
> 背景：在 menu protocol 上增加「agent 能力（skill/MCP/plugin）克隆」与「agent 克隆」，让一个调好的 agent 作为起点被快速复制成新 agent。

## 1. 目标与语义

两个功能本质相同：**以现有 agent 为起点，快速产出一个新 agent**。

- **Agent 克隆**：复制整个 agent（配置 + 人格 + 能力策略）作为新 agent 起点。
- **能力克隆**：把某 agent 用的 skill/MCP/plugin 搬给新 agent——是 agent 克隆的一个层，非独立功能。

本方案聚焦**跨网络克隆**：通过 AUN 网络，从别人主机上的 agent 克隆到自己主机。同主机的**本地克隆**只是文件系统复制，不需要打包/传输/协议，作为独立 daemon 小工具留作后续扩展（见 §12）。

## 2. 参与三方

跨网络克隆涉及三方，**发起方 B 居中编排**，被克隆 Agent A 与接收 Daemon C 之间零直接通信（A 与 C 互不相识，克隆包是唯一媒介）：

| 方 | 身份 | 职责 |
|---|---|---|
| **发起方 B** | 人类（客户端/控制台） | 生成 `cloneId`，编排全程：先定 C，再调 A 定向打包、调 C 部署，分别轮询两端进度 |
| **被克隆 Agent A** | AUN agent | 收 `pack`，依全局 runbook 自打包（隐私自检 → 关再克隆门 → 状态初始化 → 打包上传 → 生成 AID 白名单分享链接） |
| **接收 Daemon C** | EvolClaw 主机 daemon | 收 `deploy`，凭自身 AID 下载 → 校验 → 解压 → 铸新 AID → 落地 → 停 created 态 |

**定向包**：B 发起时**先确定接收主机 C**，`pack` 携带 `recipientAid=C`。A 用 `storage.create_share_link({ allowed_aids:[C], ... })` 把下载权绑定到 C 的 AID——即便 `shareId` 在转交途中（经 B 客户端/飞书）泄露，非 C 的 AID 也拿不到内容。克隆包与 C 一一绑定，换接收方需重打包。

```
   发起方 B（人类）
        │
        │ ① menu.action name=clone action=pack ──▶ 被克隆 Agent A
        │      args={ cloneId, recipientAid:C, layers? }   依 how-to-clone-self.md 自打包：
        │                                           ├ 隐私自检（剔密钥/凭证/敏感记忆）
        │                                           ├ 关再克隆门（包内 clone=deny）
        │                                           ├ 状态置初始化（lifecycle: created）
        │                                           ├ 按允许 layers 打 tar.gz
        │                                           └ 上传 + create_share_link(allowed_aids=[C]) → shareId
        │ ② ◀── 回执 { shareId, sha256, sizeBytes, retrieval, manifest } ── A
        │
        │   （B menu.query name=clone {cloneId} 轮询 A 打包进度）
        │
        │ ③ menu.action name=clone action=deploy ──▶ 接收 Daemon C
        │      args={ cloneId, package:{ shareId, sha256, sizeBytes, retrieval }, newAid, newName }
        │                                           C 部署：
        │                                           ├ get_by_share(shareId) 按 retrieval 取包
        │                                           ├ 校验 sha256 + 解压 + 读 manifest
        │                                           ├ baseagent 兼容检查
        │                                           ├ aidCreate(newAid) 铸新身份
        │                                           ├ 落 config/persona/capability 文件
        │                                           └ 停 created 态（不自动启动）
        │ ④ ◀── 部署回执 { newAid, tookLayers, warnings[] } ── C
        │
        │   （B 轮询 C 部署进度；成功后 B 令 A revoke_share_link + delete_object）
        ▼
   克隆完成：新 Agent 落在主机 C，独立 AID，默认不可再被克隆，停 created 态待人工 review
```

## 3. 声明三处落

克隆策略与能力清单分三处声明，公开部分像名片一样可查（契合 AUN「身份即入口」）：

| 落点 | 可见性 | 内容 |
|---|---|---|
| `agent.md` 的 `clone` frontmatter | **公开** | 二值门 `allow`/`deny`，无白名单、无分层 |
| `config.json` 的 `clonePolicy` | 私有 | 分层策略（每层 `auto`/`deny`）+ project include 清单 |
| `capability.md` 的 `capabilities[]` | **公开** | `aun.capabilities.v1` card 列表，给可克隆项加 `transfer` 字段（capability.md 为前置件，见 §3.3 注） |

### 3.1 agent.md 的 clone 门（公开粗门）

```yaml
---
name: "夙夜无偕1号"
description: "..."
clone: allow        # allow | deny
---
```

`deny` → 克隆方读到即止；`allow` → 进入 config.json 分层细则。不泄露任何层的实际内容。

### 3.2 config.json 的 clonePolicy（私有细则）

```json
{
  "clonePolicy": {
    "layers": {
      "behavior":     "auto",
      "capabilities": "auto",
      "persona":      "auto",
      "memory":       "deny",
      "project":      "auto"
    },
    "project": {
      "include": ["CLAUDE.md", ".claude/rules"]
    }
  }
}
```

- 每层两态：`auto`（可克隆）/ `deny`（不克隆）。
- `project.include`：project 层允许打包的文件/目录清单，默认 `["CLAUDE.md", ".claude/rules"]`。
- **`layers.capabilities` 是能力层总开关**：`auto` 才克隆能力、且此时才读 `capability.md` 取各能力的 `transfer`；`deny` 则整层不克隆、连 capability.md 都不读。per-能力的 `transfer` 权威源在 capability.md，不进 clonePolicy。

### 3.3 capability.md 的 transfer 字段

> ⚠️ **capability.md 为前置件**：`src/` 当前 **0 处**引用 `capability.md` / `aun.capabilities.v1`——它是 `aun-group-capabilities-design.md` 设计但**尚未落地**的产物。当前实现的能力系统是 `config.json` 的 `capabilities` 块（`listCapabilityOptions` 发现 + `updateCapabilityPolicy` 写 override）。capability.md 需**先落地**再做本方案能力层，`transfer` 字段挂在其 `capabilities[]` 上。

capability.md 落地后，在其 `aun.capabilities.v1` card 的 `capabilities[]` 上给可克隆项加 `transfer`：

```yaml
---
schema: aun.capabilities.v1
kind: card
provider_aid: toleiliang2.agentid.pub
updated_at: 2026-07-10T22:00:00+08:00
capabilities:
  - id: wechat-reader
    type: skill
    title: 微信公众号阅读器
    transfer: files                    # 搬完整文件
  - id: tavily
    type: mcp
    title: Tavily 搜索
    transfer: skeleton                 # 搬骨架，清空凭证
    needs_credentials: ["apiKey"]
  - id: superpowers
    type: plugin
    title: Superpowers 插件集
    transfer: reference                # 仅搬引用名，克隆方自行安装
---
```

`transfer` 三值对应三种能力的物理本质：

| transfer | 适用 | 落地行为 |
|---|---|---|
| `files` | skill | 打包完整目录（SKILL.md + 脚本 + references），落到克隆方 project `.claude/skills/` |
| `skeleton` | mcp | 打包配置结构但清空所有凭证字段，保留 `needs_credentials` 名单，克隆方自填 |
| `reference` | plugin | 仅搬引用名，克隆方本机自行安装（plugin 常是全局依赖，搬文件无意义） |

未标 `transfer` 的条目即原有「软能力发现」语义（"我能帮你做 X"，见 `aun-group-capabilities-design.md`），不参与克隆。两种语义共存同一列表，靠 `transfer` 区分。

**打包时的 transfer 读取顺序**：
1. `clonePolicy.layers.capabilities = deny` → 整层跳过，不读 capability.md。
2. `= auto` → 先用 `listCapabilityOptions` 扫本地**实际存在**的 skill/mcp/plugin，再读 `capability.md` 取每条 `transfer` 与展示信息，两者**求交**——本地有、且标了 transfer 的才打包。
3. capability.md 缺失或某能力未标 transfer → 该能力不克隆（保守）。

## 4. 五层克隆面

克隆范围为 **config + personal + capabilities 策略**；`channels`（外部凭证不可共享）、`relations`、`venues`、`owners` **不克隆**。

| layer | 内容（磁盘） | 默认 | 说明 |
|---|---|---|---|
| **behavior** | config.json 运行时字段（除身份/channels/relations/owners）：`active_baseagent` + `baseagents.<key>`（内含 model/effort）、chatmode、dispatch、show_activities、proactive、render、response_modes、flush_delay、debounce、enable_rich_content、**permissionMode** | `auto` | 权限模式一并克隆，落地后 warnings 显性告知、不拦截。字段以 `AgentConfig`（types.ts）实际结构为准，不写死清单 |
| **capabilities** | skills / mcp / plugins（明细见 capability.md 的 `transfer`） | `auto` | 公开可见清单 |
| **persona** | personal/persona.md + avatar + agent.md 正文 | `auto` | agent.md frontmatter 必然重新生成，不搬 |
| **memory** | personal/memory/working.md | `deny` | 私密工作记忆，默认不克隆 |
| **project** | `clonePolicy.project.include` 清单内的文件 | `auto` | 清单由源 agent 主人本地配 |

要点：

- **model/effort 不是顶层字段**——嵌在 `baseagents.<key>` 块内，由 `active_baseagent` 指向。换 baseagent = 换 `active_baseagent` 指向及其块（见 §8.1）。
- **permission 不单拎**，随 behavior 克隆，靠 warnings 显性告知，用户自行修改。
- `name`/`description` 不单列为层——克隆产出新 AID，agent.md 必重新生成，name/description 由 B 在 deploy 时指定。

## 5. menu name=clone 协议

复用 menu protocol，`name=clone` 下挂动词（对齐现有 `menu.action`/`menu.query`）：

```
① B→A   menu.action name=clone action=pack
         args={ cloneId, recipientAid, layers?:[...] }  // recipientAid = C 的 AID；layers 省略=A 允许的全部
         → 立即返回 { cloneId, status:"packing" }        // 异步

② B→A   menu.query  name=clone args={ cloneId }
         → { cloneId, status, phase, detail?,
             package?:{ shareId, sha256, sizeBytes, retrieval, manifest } }

③ B→C   menu.action name=clone action=deploy
         args={ cloneId, package:{ shareId, sha256, sizeBytes, retrieval }, newAid, newName }
         → 立即返回 { cloneId, status:"deploying" }       // 异步

④ B→C   menu.query  name=clone args={ cloneId }
         → { cloneId, status, phase, detail?,
             result?:{ newAid, tookLayers, warnings[] } }
```

对称结构：**A 侧管产包（pack + 查），C 侧管部署（deploy + 查），B 用同一 `cloneId` 串起两端**。

- `cloneId`、`recipientAid`（C 的 AID）由 **B 在 pack 指定**；`newAid`/`newName` 由 **B 在 deploy 指定**。
- `pack`/`deploy` 均**异步**，立即返回，B 用 `menu.query` 轮询。
- 新 agent **owner 自动设为 B**——B 的 AID 由 deploy 鉴权上下文（B 须是 C 的进程 owner）天然得到，无需传参；源 owners/admins 不继承。
- `retrieval`（`inline`/`blob`）由 A 上传分支决定，随回执上报，C 据此单路取包（详见 §9.1）。

### 5.1 权限

- `pack`：读 A 的 agent.md clone 门须为 `allow`。**A 须运行态**（自打包 runbook 靠 A 的 LLM 做隐私自检，停机的 A 无法打包）。
- `deploy`：B 须是接收主机 C 的 owner——进程级操作，走现有 `isProcessLevelOwner` / 控制 channel 鉴权（`fromControlChannel`）。
- **鉴权注册**：pack/deploy 须在 `resolveMenuIntent` + `isProcessLevelAction`（menu-handler.ts）注册 scope——`deploy`=control/进程级，`pack`=agent 级——否则鉴权不生效。

### 5.2 进度可查

两侧均用阶段式进度（复用现有 `create-status.json` 落盘模式），`menu.query name=clone {cloneId}` 通查：

```
A 侧 pack:   privacy_scan → packing → uploading → issuing_share → ready | failed
C 侧 deploy: downloading → verifying → extracting → minting_aid → placing_files → created | failed
```

每阶段回执带 `{ status, phase, detail?, error? }`。字节级进度仅 `retrieval:"blob"` 分支有（如 `downloading 3.2MB / 8MB`）；`inline` 小包一次到手，无中途进度。

### 5.3 幂等与重试

进度落盘文件 `clone-status-<cloneId>.json` 作幂等键：

- **pack 幂等**：同 `cloneId` 重发 → A 若已有 ready 结果，直接返回旧回执，不重复打包上传。
- **deploy 可安全重跑**：各步骤本就幂等——`aidCreate(newAid)` 已存在且验签通过时直接复用返回 `alreadyExisted`（不撞不报错，identity.ts），落文件为覆盖写。整体重跑即可，无需断点续做；进度文件仅供 B 观察卡点。

## 6. 克隆包结构（tar.gz）

```
clone-<cloneId>.tar.gz
├── manifest.json          # 源AID、cloneId、layers清单、baseagent、schema版本、各文件sha256
├── config/
│   └── behavior.json      # behavior 层（已剔凭证）
├── persona/
│   ├── persona.md
│   ├── agent.md.body      # agent.md 正文（frontmatter 已剥离）
│   └── avatar.png
├── capabilities/
│   ├── capability.json    # 能力策略 + transfer 分类清单
│   ├── skills/            # transfer:files 的 skill 完整目录
│   └── mcp-skeleton.json  # transfer:skeleton 的 MCP 配置（凭证已清空，保留 needs_credentials）
└── project/               # project 层：include 清单内的文件
```

- memory 层默认不进包（deny）。
- plugin 走 reference，只在 `capability.json` 留名单，无文件。

## 7. how-to-clone-self.md（全局 runbook）

随 EvolClaw 分发的**全局 runbook**（像内置 skill），所有 agent 用同一套自打包流程，保证隐私筛查一致。agent 可在自己目录放同名文件覆盖。A 收到 `pack` 后按此 runbook 执行（是给 A 的指令，非死代码）：

```markdown
# 如何克隆我自己（自打包 runbook）

收到 clone pack 请求时，按序执行：

## 1. 隐私自检（最高优先级）
- 扫描 behavior 配置，剔除所有凭证字段：apiKey/token/appSecret/baseUrl/私钥等
- 扫描 project include 清单，剔除含密钥/私人路径/.env 的文件
- memory 层：默认不打包
- 对 MCP：只保留结构，清空所有 credential，保留 needs_credentials 名单

## 2. 关闭克隆体的再克隆能力
- 包内 config 的 clone 门强制置 deny，使克隆体落地后默认不可再被克隆（防克隆链失控）

## 3. 状态初始化
- lifecycle 置 'created'；清空运行时状态（active session、outbox、health 等不打包）

## 4. 打包 + 上传
- 按允许 layers 组装目录 → tar.gz
- 高层 writeBytes/uploadFile 上传（自动按服务端内联阈值切内联/分片，见 §9.1）
- 观察自身上传分支得 retrieval（inline/blob），记入回执
- storage.create_share_link({ objectKey, allowed_aids:[recipientAid], expire_in_seconds, max_uses }) → shareId
- 回执 { shareId, sha256, sizeBytes, retrieval, manifest }
```

### 7.1 隐私自检：代码兜底 + LLM 补充

- **确定性代码**做硬性剔除：已知凭证字段名（apiKey/token/appSecret/...）、`.env`、私钥文件。
- **LLM 按 runbook** 做语义级补充：如 persona 里的真实姓名、project 文件里的隐私路径。

代码兜底保证已知敏感数据必被剔除，LLM 覆盖代码规则外的语义隐私。

## 8. 部署落地（C 收到 deploy）

```
C: get_by_share(shareId) 按 retrieval 取包 → 校验 sha256 → 解压 → 读 manifest
   → schema 版本闸（见 §8.4）
   → baseagent 兼容检查（见 §8.1）
   → aidCreate(newAid) 铸新身份（已存在且有效则幂等复用）
   → 落地各层文件到 agents/<newAid>/
   → 写 config.json: clone门=deny, lifecycle=created, active_baseagent=最终值,
                     owners=[B 的 AID], admins=[]（源 owners/admins 不继承）
   → ensureAgentDirSkeleton + 生成新 agent.md（新AID + 关闭的 clone 门）
   → 停 created 态（不自动启动）→ 汇总 warnings 回执
```

### 8.1 baseagent 兼容

- 本机有源 baseagent → 直接用。
- 本机无 → 用 B 在 deploy 指定的替代 baseagent，改写 `active_baseagent` 指向，并**清空**对应 `baseagents.<key>` 内的 `model`/`effort`（不做跨 baseagent 映射转换），克隆方落地后自行重设。

### 8.2 克隆后不自动启动

落地为 `created` 态但不启动，等 B/主人 review warnings（尤其 MCP 缺凭证）后手动 `enable`。MCP/plugin 往往缺凭证，停在 created 态、补齐再启更稳。

### 8.3 warnings 回执

部署回执 `warnings[]` 汇总需人工处理的事项：

- **MCP**：骨架已落地但缺凭证，列出所有 `needs_credentials`。
- **plugin**：仅有引用名，检查本机是否已安装；未装则提示需先安装。
- **baseagent**：已从 X 替换为 Y。
- **model/effort**：已清空，需重设。
- **clone 策略**：已继承并关闭克隆门，如需开放请自行调整。
- **owner**：已设为 B，源 owners/admins 未继承。

### 8.4 schema 版本闸

deploy 读 manifest 里源 `$schema_version`，对本机 `CONFIG_SCHEMA_VERSION`（types.ts，当前 = 2）比较：

| 关系 | 处理 |
|---|---|
| 源 > 本机 | **拒绝**——本机读不懂新结构，硬落会坏，提示 B 升级 C 的 EvolClaw |
| 源 = 本机 | 正常落地 |
| 源 < 本机 | 落地，复用现有全局 config seam（`migrateIfNeeded`，config-manager.ts）等待逐版本迁移 |

**克隆功能不自造 schema 迁移**——那是全局 config 体系的职责（当前只有 seam、无实际迁移函数）。克隆只做"新拒旧纳"版本闸。

## 9. 安全边界

| 维度 | 措施 |
|---|---|
| **隐私** | 代码硬剔（凭证/.env/私钥）+ LLM 语义补充 + memory 默认不打包 |
| **再克隆** | 包内 clone 门强制关闭，克隆体落地后默认不可再被克隆 |
| **传输** | AID 白名单分享 + 短 TTL + 限次 + 成功后主动撤销（见 §9.1） |
| **权限** | `pack` 需 A 的 clone 门 = allow；`deploy` 需 B 是 C 的 owner（进程级鉴权） |
| **归属** | 新 agent owner = B，源 owners/admins 不继承 |
| **孤儿回收** | 成功后 B 驱动 A `revoke_share_link` + `delete_object`；从未成功的靠 TTL 兜底（见 §9.2） |
| **落地** | 不自动启动，停 created 态待人工 review |

### 9.1 storage 传输机制

克隆凭证需经人类 B 在客户端间转交（可能过飞书等通道），链路长易泄露，故用 **AID 白名单分享**（`storage.create_share_link`）而非无身份 bearer token——下载方须以自身 AID 证书证明身份，shareId 泄露也无用。

参数取值：

- **`allowed_aids: [C]`**：仅 C 可下载。**必须显式设**——省略默认 `["*"]`（任意 AID 可访问），对含 persona/能力文件的克隆包是禁忌。
- **`expire_in_seconds: 1800`（30min）**：覆盖 B 观察 A 打包完、再转交 C 部署的人工间隔。
- **`max_uses: 5`**：允许 C 断点重试，仍防泄露后无限拉取（死限 1 次会导致中途失败无法重试）。
- **成功后撤销**：C 部署成功后 B 令 A `revoke_share_link({ shareId })` 提前作废。

**上传/下载分片（retrieval）**：`create_share_link` 只建授权记录、与文件大小无关。文件大小由 `put_object` 的内联阈值决定：小于阈值走内联 base64，大于走分片（create_upload_session + HTTP PUT）。克隆包通常超阈值 → 上传走分片、`get_by_share` 返 `download_url`。**阈值判断内含于高层 `writeBytes` 上传，A 只观察结果上报 `retrieval`（`inline`/`blob`），C 与代码都不写死数值**（如需读阈值用 `storage.get_limits.max_inline_bytes`）。C 按 `retrieval` 单路取包：`inline` 解 content(base64)，`blob` httpGet download_url（流式，有字节级进度）。

### 9.2 孤儿对象回收

A 与 C 零直接通信，A 无从得知 deploy 成功/失败，故删包不能由 A 自主触发：

- **成功路径（一期，B 驱动）**：B 轮询到 C `created` 后，令 A `revoke_share_link({shareId})` + `delete_object`。
- **失败/中断路径**：B 放弃或从未成功时，靠 share link TTL 自然失效 + 对象兜底 TTL（若服务端 `complete_upload` 支持 object TTL）。
- **兜底扫描（二期）**："从未 deploy 的孤儿对象"周期扫描——与 EvolClaw 现有 storage（avatar 等上传即长存、无 GC）是同类欠债，留二期统一处理。

## 10. 涉及的现有代码

| 子系统 | 文件 | 复用点 |
|---|---|---|
| menu 引擎 | `src/core/command/menu-handler.ts` | 新增 `name=clone` 的 action/query 分支 |
| menu 入口 | `execMenuForControl` / `execMenuForEcweb` | `nameMap` 增加 `clone: '/clone'` |
| menu 鉴权 | `resolveMenuIntent` / `isProcessLevelAction` | 注册 clone scope：`deploy`=进程级，`pack`=agent 级 |
| capability | `src/core/capability/capability-manager.ts` | 复用 `listCapabilityOptions` 发现 skill/mcp/plugin |
| agent 生命周期 | `src/core/message/command-handler-agent-control.ts` | 复用 `execAgentAction('create')` 落地新 agent |
| agent.md 生成 | agent.md 解析/生成路径 | 新增 `clone` frontmatter（读取粗门 + 落地重新生成，强制关闭） |
| AID 铸造 | `src/aun/aid/identity.ts` | `aidCreate(newAid, opts?)` 铸新独立身份 |
| storage | `src/aun/storage/*`（走 `rpcCall(aid,'storage.*')`，无高层 client 实例） | 上传经 create_upload_session→PUT→complete_upload；新增 create_share_link/get_by_share/revoke_share_link RPC 调用 |
| 资源冲突 | `src/core/evolagent-registry.ts` | 克隆不带 channels，天然无 fingerprint 冲突 |
| 状态落盘 | 参照 `create-status.json`（`CreateStatusWriter`/`CreatePhase`） | pack/deploy 进度落盘供 query |

## 11. 非目标（MVP 不做）

- 不支持「注入到已有 agent」——只做新建全新 agent；注入另见 `2026-07-11-skill-cross-agent-injection-design.md`。
- 不做实时审批——clone 门为二值 allow/deny，隐私由 A 打包时自检把关。
- 不做跨 baseagent 的 model/effort 映射转换——清空 + 提醒。
- 不克隆 channels/relations/venues/owners（新 agent owner 另设为 B）、不克隆 memory。
- 不自造 schema 迁移——只做版本闸，迁移交回全局 config seam。
- 不做孤儿对象周期扫描——一期只做成功后 B 驱动删包 + TTL 兜底。
- 不新建 AUN `clone.*` 命名空间——复用 `message.*`（menu 承载）+ `storage.*`（搬运）。
- 落地后不自动启动。

## 12. 依赖与后续扩展

**前置依赖**：

- **capability.md 落地**（§3.3 注）：`transfer` 字段的载体，当前未实现，需先建。克隆的能力层与注入方案共享此前置件。

**后续扩展**：

- **本地克隆**：同主机复制自己的 agent。独立 daemon 小工具——直接文件系统拷贝（`agents/<srcAid>/` → `agents/<newAid>/`）+ `aidCreate` + 改 config（关 clone 门、停 created 态），不套 pack/deploy 协议、不经 storage、不走 LLM 隐私自检（同机同 owner 无外泄面）。复用本方案的 layers 定义与落地规范。
- **skill 跨 agent 注入**：把源 skill 搬进已有 agent（不新建）——独立方案 `2026-07-11-skill-cross-agent-injection-design.md`，复用本方案 pack/传输。
- `clone.*` AUN 一等公民命名空间：语义稳定后沉淀，manifest/share 结构可平移。
- 跨 baseagent 参数映射表。
- memory 选择性克隆（脱敏后）。
- 克隆链审计：源 A 记录"被谁克隆了哪些层"。
- 孤儿对象周期扫描回收（与全局 storage GC 一起做）。

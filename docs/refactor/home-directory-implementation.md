# ~/.evolclaw 目录结构重构：实施记录

> 基于设计文档：`docs/evolclaw-home-directory.md`
> 实施时间：2026-05-17
> 状态：核心架构已落地，运行时逻辑待实现

## 一、已完成的工作

### 1. 配置加载链路（完整切换）

| 设计要求 | 实现文件 | 状态 |
|---|---|---|
| `agents/defaults.json` 两层合并加载 | `src/config-store.ts` | ✅ |
| `agents/<aid>/config.json` per-agent 配置 | `src/config-store.ts` | ✅ |
| 深合并/数组合并去重/标量覆盖/per-agent only 规则 | `mergeForAgent()` | ✅ |
| `$ENV:VAR_NAME` 环境变量展开 + warning | `expandEnvRefs()` | ✅ |
| 双 rename 原子写（foo.json → foo.json_ → foo.json__ → foo.json） | `src/utils/atomic-write.ts` | ✅ |
| AID 作目录名 + 合法性校验 | `src/utils/aid-validation.ts` | ✅ |
| 配置校验（channels 重复 name / AUN 只允许一条 / name 不含 #） | `validateAgentConfig()` | ✅ |
| per-agent 目录骨架自动创建 | `ensureAgentDirSkeleton()` | ✅ |

### 2. channel key 编码

- 格式：`<aid>#<type>#<name>`
- 实现：`src/core/channel-key.ts`（formatChannelKey / parseChannelKey / isValidChannelName）
- AUN 实例也统一三段（`aid#aun#main`），不做特殊处理
- `EvolAgent.effectiveChannelName(type, name)` 直接调用 formatChannelKey

### 3. EvolAgent + EvolAgentRegistry 重写

- `src/core/evolagent.ts`：基于 `AgentConfig + MergedAgentConfig`，无 `isDefault` / `configPath`
- `src/core/evolagent-registry.ts`：扫 `agents/<aid>/` 加载，`detectDuplicates(EvolAgent[])`
- DefaultAgent 概念彻底删除（`buildDefaultAgent` / `globalWriter` / `globalFallback` / `[default]` 字符串）
- 所有 owner/admin/showActivities 写入走 `EvolAgent` → `saveAgent()` → 双 rename

### 4. 主流程切换（index.ts）

- 启动期：`autoMigrateIfNeeded()` → `loadDefaults()` → `EvolAgentRegistry.loadAll()` → 硬约束 ≥1 agent
- channel 创建：`ChannelLoader.createForAgent(agent)` 替代旧的 `createAll(config)`
- session owner/admin 解析：直接走 `agentRegistry.isOwner/isAdmin`，无 fallback
- sessionMode 解析：从 channel 路由到 agent，按 `agent.config.chatmode` 取
- 中断回调 / resume 逻辑：用 `primaryAgent.aid::baseagent` 作 runner key

### 5. 旧 config.ts 删除 + 消费方切换

- `src/config.ts` 整个文件删除
- baseagent resolver 抽到 `src/baseagents/resolve.ts`
- `normalizeChannelInstances` / `getChannelShowActivities` / `channelTypes` 搬到 `src/utils/channel-helpers.ts`
- `ensureDir` 搬到 `src/utils/ensure-dir.ts`
- `CommandHandler` / `MessageProcessor` / `MessageBridge` 不再持有 `config: Config` 参数
- `AgentPlugin` 接口改为 `isEnabled(agent)` / `createAgent(agent, callbacks)`，无 globalConfig

### 6. 旧路径切换

- `readySignal`：`logs/ready.signal` → `data/instance/ready.signal`
- `socket`：`logs/evolclaw.sock` → `data/instance/evolclaw.sock`
- 根目录检测：`data/evolclaw.json` 存在 → `agents/defaults.json` 存在
- 旧 `resolveSocketPath` 死函数删除
- `ensureDataDirs()` 新增 `kits/` 创建

### 7. CLI 重写

- `evolclaw init`：环境检查（baseagent CLI 可用）→ 创建 defaults.json → 引导通过 Evol App 创建 agent
- `evolclaw agent new`（交互式 + 非交互式）：输入 AID → 注册 AID → 写 `agents/<aid>/config.json` + 目录骨架
- `evolclaw agent list` / `show`：cold mode 走 `EvolAgentRegistry.loadAll()` 无需旧 config
- `evolclaw diagnose`：改用 `loadAllAgents()` 校验
- `evolclaw mv`（migrate-project）：改写各 self-agent 的 `projects.list`

### 8. 旧配置自动迁移

- `autoMigrateIfNeeded()`：启动时检测 `defaults.json` 不存在 + `data/evolclaw.json` 存在 → 自动转换
- 从旧 `evolclaw.json` 构 `defaults.json`（baseagents/models/projects/chatmode 等）
- 旧 `agents/<name>.json` → 读 `channels.aun.aid` → 创建 `agents/<aid>/config.json`
- 旧 `evolclaw.json.channels` 全局 AUN 实例 → 也建 per-agent config
- 完成后旧文件改名 `evolclaw.json_` / `<name>.json_`
- 幂等：defaults.json 存在就跳过

### 9. 测试覆盖

| 测试文件 | 用例数 | 覆盖内容 |
|---|---|---|
| `tests/unit/atomic-write.test.ts` | 6 | 读写/热备/stale tmp/rename 崩溃恢复 |
| `tests/unit/aid-validation.test.ts` | 3 | 合法/非法 AID + checkAgentDir |
| `tests/unit/channel-key.test.ts` | 5 | round-trip/错误段数/空段/#拒绝/多级 AID |
| `tests/unit/config-store.test.ts` | 14 | validate/merge/env 展开/round-trip/扫描跳过 |
| `tests/unit/auto-migrate.test.ts` | 5 | 跳过/全局迁移/named agent 迁移/幂等 |
| `tests/integration/startup.test.ts` | 3 | 空 home fail-fast/脏目录跳过/合法 agent 通过 |
| 原有测试（5 文件） | 78 | session-fs-store/session-manager/instance-registry 等 |

总计：11 文件 / 114 用例全过。

---

## 二、尚未做的事情

### 优先级 A：影响可用性

| 事项 | 说明 | 工作量 |
|---|---|---|
| **kits/ 内容填充** | `kits/aun/`（AUN 知识）、`kits/channels/`（各渠道约定）、`kits/evolclaw/`（命令/工具清单）、`kits/templates/`（prompt 模板）。来源：现有 `src/templates/` + `.claude/rules/` 裁剪 | 中（内容工作） |
| **kits/ 安装时复制** | 首次启动或 npm postinstall 时从 `getPackageRoot()/kits/` 复制到 `EVOLCLAW_HOME/kits/` | 小 |
| **`evolclaw init` 的 channel 向导** | 当前 init 只建 defaults.json；飞书/钉钉等 channel 配置在 `agent new` 时做，但旧的 `init feishu` / `init aun` 子命令还指向旧逻辑（init-channel.ts），需要适配新格式 | 中 |

### 优先级 B：设计文档描述但属后续阶段

| 事项 | 说明 |
|---|---|
| **身份层运行时**（identities/） | resolve speaker → 查 `_index/` → 加载 profile.md；首次交互建 `_observed/` 档案；promote 到 `contacts/`；interaction 事件写 `history.jsonl` |
| **环境层运行时**（venues/） | 按 venue_id 查 `_index/` → 加载 venue profile.md 的 policy；首次进群建 venue 档案 |
| **个人数据层运行时**（personal/） | 启动时加载 `persona.md` 注入 system prompt；`memory/working.md` 每会话加载；self-summary 触发机制 |
| **上下文组装** | 按 venue.kind 选 `kits/templates/{private,group,broadcast}.md`，填 system-fragments |
| **`data/sessions/` → `agents/<aid>/sessions/` 迁移** | 等 venue_uid 设计落地 |
| **`schema-1.json`** | 从 TypeScript 类型自动导出 JSON Schema |

### 优先级 C：代码清理（不影响功能）

| 事项 | 说明 |
|---|---|
| `legacyConfig` 局部变量 | index.ts 里仍有一个从 primaryAgent.config 构造的 legacyConfig，喂给 `resolveAnthropicConfig` 启动期校验。需要改 resolver 签名才能消除 |
| `defaultAgentId` 变量名 | command-handler.ts / message-processor.ts 里的私有字段名，语义已变但名字还叫 "default"——纯重命名 |
| `Config` 类型里的 `defaultAgent` 字段 | 仅 AgentLoader plugins 内部 syntheticConfig 使用，可以在 resolver 签名改造后删除 |
| init.ts 旧函数 | `checkEnvironment` / `initFeishuManual` / `offerRichContentRenderer` / `setupEnvVar` 等——当前无入口调用但保留未删（环境检查逻辑可能后续复用） |
| `DEFAULT_AGENT_NAME = '<unknown>'` 常量 | message-queue.ts 里的占位字符串 |

---

## 三、后续需要注意的事情

### 1. channel key 的兼容性

旧 sessions 的 `messages.jsonl` 里 `channel` 字段值是旧格式（如 `"aun"` / `"llbot-feishu-main"`），新格式是 `"aid#type#name"`。启动期扫到旧 session 时 `resolveByChannel` 会返回 null——这些 session 变成 orphan。

**建议**：不做自动迁移，让旧 sessions 自然过期（TTL 机制）。`evolclaw status` 的 orphan 检测已经能报告这些。

### 2. `autoMigrateIfNeeded` 是临时代码

设计文档附录明确"迁移旧配置只是临时代码，过一两个版本就去掉"。建议在 v3.0 发布时删除整个 `autoMigrateIfNeeded` 函数 + 相关测试。

### 3. ChannelLoader 仍在用 dict 形态

`ChannelLoader.createForAgent(agent)` 内部把 `channels[]` 列表翻成 `{ type: [instances...] }` dict 喂给各 channel plugin 的 `createChannels(config)`。这是因为 6 个 channel plugin（feishu/aun/wechat/dingtalk/qqbot/wecom）的 `isEnabled` / `createChannels` 还在按旧 dict 形态读 `config.channels.<type>`。

**后续**：逐个改 channel plugin 让它们直接接受 `ChannelInstance[]`，然后删掉 `createForAgent` 里的翻译逻辑和 `src/utils/channel-helpers.ts`。

### 4. `EvolAgentHandle.config` 暴露了完整 MergedAgentConfig

为了让 `MessageProcessor` / `CommandHandler` 能直接取 `agent.config.chatmode` / `agent.config.flush_delay` 等字段，`EvolAgentHandle` 接口暴露了 `readonly config: MergedAgentConfig`。这意味着任何持有 handle 的模块都能读到 apiKey 等敏感字段。

**建议**：后续如果需要收窄，可以把 `config` 改成只暴露非敏感子集（`chatmode` / `flush_delay` / `debounce` / `show_activities` / `projects`）。当前阶段不是问题——这些模块本来就在同一进程内。

### 5. owners 为空时的 auto-bind

设计文档规定 `owners: []` 表示"待指定，第一个通信者自动成为 owner"。`MessageBridge.autoBindOwner` 实现了这个逻辑——但它写入的是 channel 实例的 `owners[]`，不是顶层 `owners`。

**注意**：顶层 `owners`（AUN 渠道的 owner）和 channel 实例 `owners`（飞书/钉钉等的 owner）是两套。auto-bind 只处理 channel 实例级别。顶层 owners 的 auto-bind 需要在 AUN channel adapter 里单独实现（当前未做）。

### 6. 多 agent 场景下的 primaryAgent 选择

index.ts 用 `agentRegistry.runnableAgents()[0]` 作为 primaryAgent——这决定了启动期 anthropic 凭证校验用哪个 agent 的 key、`legacyConfig` 的 projects/chatmode 取谁的值。

**注意**：多 agent 部署时，第一个 agent 的选择是按文件系统 readdir 顺序（不确定性）。如果需要确定性，后续可以在 defaults.json 加一个 `primary_agent: "<aid>"` 字段。

### 7. init-channel.ts 的旧向导

`init-channel.ts`（1500+ 行）里的飞书扫码、微信二维码、AUN 初始化等交互式向导仍然存在且能编译通过，但它们写入的是旧 dict 形态。`evolclaw init feishu` / `init aun` 等子命令仍然调用这些函数。

**建议**：短期内这些子命令可以暂时禁用（或加 deprecation warning）；长期应该让它们写入到对应 agent 的 `config.json.channels[]` 里。

---

## 四、文件清单

### 新增文件

```
src/config-store.ts              配置加载/合并/写入/校验/env 展开/自动迁移
src/baseagents/resolve.ts        三家 baseagent 凭证解析
src/core/channel-key.ts          <aid>#<type>#<name> 编解码
src/utils/atomic-write.ts        双 rename 原子读写
src/utils/aid-validation.ts      AID 目录合法性校验
src/utils/ensure-dir.ts          ensureDir 工具
src/utils/channel-helpers.ts     旧 channel adapter 兼容工具（normalizeChannelInstances 等）
tests/unit/atomic-write.test.ts
tests/unit/aid-validation.test.ts
tests/unit/channel-key.test.ts
tests/unit/config-store.test.ts
tests/unit/auto-migrate.test.ts
tests/integration/startup.test.ts
```

### 删除文件

```
src/config.ts                    旧配置加载/校验/写入（整个文件）
```

### 重写文件（核心改动）

```
src/core/evolagent.ts            EvolAgent 类完全重写
src/core/evolagent-registry.ts   EvolAgentRegistry 完全重写
src/core/agent-loader.ts         AgentPlugin 接口去 globalConfig
src/core/channel-loader.ts       新增 createForAgent(agent)
src/index.ts                     主流程完全重写
src/paths.ts                     新增条目 + 旧路径切换
src/types.ts                     新增 DefaultsConfig/AgentConfig/MergedAgentConfig/GlobalSettings
```

### 修改文件（import 切换 + 局部适配）

```
src/agents/claude-runner.ts
src/agents/codex-runner.ts
src/agents/gemini-runner.ts
src/channels/aun.ts
src/channels/feishu.ts
src/channels/wechat.ts
src/channels/dingtalk.ts
src/channels/qqbot.ts
src/channels/wecom.ts
src/cli.ts
src/core/command-handler.ts
src/core/message/message-bridge.ts
src/core/message/message-processor.ts
src/core/session/session-manager.ts
src/utils/init.ts
src/utils/init-channel.ts
src/utils/migrate-project.ts
src/utils/stats-collector.ts
```

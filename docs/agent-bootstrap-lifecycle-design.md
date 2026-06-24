# Agent Bootstrap Lifecycle 设计方案

**版本**: v1.0  
**日期**: 2026-06-23  
**状态**: 待实施

---

## 一、背景与目标

### 当前问题

- Agent 创建后直接进入正常对话，缺少显式的"自我设置"阶段
- Welcome 消息是一条写死的文案，未纳入 agent 生命周期流程
- `initialized` 字段语义模糊（既表示"首次"又表示"已完成"）

### 改进目标

将 Agent 生命周期显式化，增加 **bootstrap 状态**：

1. **Agent 创建后**不直接进入对话，而是进入 bootstrap 阶段
2. **Bootstrap 阶段**通过专属提示词引导 agent 与 owner 交互式确认：
   - 昵称（显示名）
   - 简介（bio/description）
   - 标签（tags）
   - （头像暂不纳入 bootstrap 流程）
3. **Welcome 消息**纳入 bootstrap 流程，改为各渠道连接成功后由系统直接发送的固定模板首条消息
4. **完成后** agent 调用命令自报完成，系统切换到正常运行状态
5. **ECK Vars+Manifest 机制**实现状态感知的提示词分流

---

## 二、核心设计

### 1. Lifecycle 字段定义

**字段名**: `lifecycle`  
**类型**: `string`（枚举）  
**位置**: `AgentConfig` 接口（`src/types.ts`）  
**默认值**: 新创建 agent 时为 `created`

#### 枚举值及语义

| 值 | 语义 | 何时进入 | 何时离开 |
|---|---|---|---|
| `created` | 已创建、未上线 | `agent new` 完成写盘时 | 任一支持 bootstrap 的 channel 能解析出可发送接收者时 → `bootstrapping` |
| `bootstrapping` | 首次上线、自我设定中 | channel 首次成功发送 bootstrap 首条消息后 | agent 调用 `ec agent ready <aid>` 时 → `active` |
| `active` | 正常运行 | Bootstrap 完成后 | （终态，不再迁移） |

**注**：`enabled` 字段独立管理启停（`enabled=false` 即停用），与 `lifecycle` 正交。

---

### 2. 状态转换流程

```
┌──────────────┐
│ agent new    │
│ 写盘 config  │
└──────┬───────┘
       │ lifecycle=created
       ▼
┌──────────────────────┐
│ channel 连接成功     │
│ 或 owner 首次入站    │
│ 且可主动发送消息     │
└──────┬───────────────┘
       │ lifecycle=created → bootstrapping
       │ 系统发送固定模板首条消息
       ▼
┌──────────────────────┐
│ Bootstrap 交互阶段   │
│ - Agent 按专属提示词 │
│ - 与 owner 确认：    │
│   昵称/简介/标签     │
└──────┬───────────────┘
       │ Agent 调用 ec agent ready <aid>
       ▼
┌──────────────────────┐
│ lifecycle=active     │
│ 正常运行，加载正式   │
│ Vars+Manifest 提示词 │
└──────────────────────┘
```

---

### 3. 触发机制

**触发时机**：
- 首选：任一已启用 channel 连接成功，且该 channel 能解析出 bootstrap 首条消息接收者和可发送 `channelId`
- 兜底：若 channel 连接成功时无法主动寻址 owner（如缺少会话 ID、context token、webhook），则保持 `created`，等待 owner 首次入站；入站时拿到可发送上下文后再触发 bootstrap

**实现方式**：
- 引入 channel 无关的 `BootstrapService`（或同等共享模块），避免 AUN 私有实现扩散到各渠道
- channel 连接成功后调用共享入口：`tryStartBootstrap(agentAid, channelKey)`
- owner 首次入站时也调用共享入口：`tryStartBootstrapFromInbound(agentAid, channelKey, inboundContext)`
- 共享入口读取 `agent.lifecycle`
- 若为 `created`：
  1. 解析接收者：优先该 channel instance 的 `owners[0]`；AUN 使用 agent 顶层 `owners[0]`
  2. 解析可发送上下文：AUN 可用 owner AID；飞书可用 open_id/chat_id；微信/钉钉等可能需要首次入站缓存的 context token/webhook
  3. 找不到接收者或可发送上下文则保持 `created`，等待 owner 绑定、下次连接或 owner 首次入站重试
  4. 找到接收者和可发送上下文后，将 `lifecycle` 原子翻转为 `bootstrapping`
  5. 通过当前 channel 发送固定模板首条消息
  6. 保留现有 onboarding 副作用：发布/同步 agent.md、发送 binding credential（如渠道支持）
- 首条消息不经 baseagent 生成；后续 owner 回复进入正常消息处理回合，agent 按 bootstrap 提示词运行

**跨渠道寻址约束**：
- AUN：可在连接成功后直接向 owner AID 发送
- Feishu：若 owner 配置为 open_id 或已有 chat_id，可连接后发送；否则等首次入站拿到 `msg.chat_id`
- WeChat：发送依赖 `context_token`，通常必须等 owner 首次入站后触发
- DingTalk：发送依赖已缓存 webhook/staffId/conversationId，缺失时必须等首次入站后触发
- WeCom/QQBot：按各自 adapter 能否在连接时主动发送决定；不能主动寻址时走首次入站兜底

**固定模板来源**：
- 首条消息模板单独放置，不与 `kits/templates/system-fragments/bootstrap.md` 共用
- 固定路径：`kits/templates/bootstrap-welcome.md`
- 模板只使用确定性变量渲染：`agentAid`、`agentName`、`ownerName`、`channel`、`baseagent`
- `kits/templates/system-fragments/bootstrap.md` 只用于 bootstrap 阶段注入给 baseagent 的系统提示词；若把欢迎首条消息也放在同一文件，ECK 会把用户可见文案一起注入系统提示词，容易造成提示词污染和维护歧义
- 当前 `src/utils/welcome.ts` 可迁移/改名为 bootstrap seed 生成器，避免保留两套欢迎语义

---

### 4. 完成切换

**命令**：`ec agent ready <aid>`

**权限**：
- 必须允许 agent 在工具调用中触发，用于 bootstrap 自报完成
- owner/admin 可保留手工兜底入口，但不能跨 agent 误操作；非 owner/admin 不能替其他 agent ready
- 若未来支持无参数形式，必须能从当前会话上下文可靠推断 self aid；否则要求显式传 `<aid>`

**行为**：
1. 将当前 agent 的 `lifecycle` 从 `bootstrapping` 切换为 `active`
2. 写回 `~/.evolclaw/agents/<aid>/config.json`
3. 触发 daemon 热重载或运行时配置刷新，确保下一轮消息使用 `active` 分流
4. 在 daemon 进程内发布事件：
   ```typescript
   EventBus.publish({
     type: 'agent:bootstrap-complete',
     aid: '<aid>',
     timestamp: Date.now()
   })
   ```
5. 返回成功反馈

---

### 5. ECK Vars+Manifest 集成

#### Vars 注入

在 `message-processor.ts` 构造 `kitCtx.vars` 时新增：

```typescript
const lifecycle = owningAgent?.config?.lifecycle ?? 'active'; // 默认 active（兼容老 agent）

lifecycle,
isBootstrapping: lifecycle === 'bootstrapping',
```

#### Manifest 段分流

在 `kits/eck_manifest.json` 中新增 bootstrap 专属段（示例）：

```json
{
  "id": "bootstrap-guide",
  "type": "file",
  "file": "$KITS_FRAGMENTS/bootstrap.md",
  "order": 15,
  "needsInjection": true,
  "when": {"var": "lifecycle", "eq": "bootstrapping"},
  "description": "Bootstrap 阶段专属引导提示词"
}
```

**提示词策略**：
- **保留骨架段**（rules/session/channel/baseagent）
- **替换引导段**（身份/关系/环境 → bootstrap-guide）
- 不能只新增 `bootstrap-guide`；还必须让常规 identity/relation/venue/persona/working-memory 等段在 `bootstrapping` 时不命中，例如：
  ```json
  {
    "and": [
      { "var": "chatType", "neq": null },
      { "var": "lifecycle", "neq": "bootstrapping" }
    ]
  }
  ```
- `channel-layer` 和 `commands` 段应保留，因为 bootstrap 阶段需要知道回复方式与可用命令

---

## 三、存量迁移

### 迁移规则

读取 agent config 时，按以下优先级映射。迁移应放在 `loadAgent()` 或共享 config normalizer 中，而不是只放在 `EvolAgent` 构造函数里；否则 CLI、channel onboarding、ConfigManager/effective config 等直接读配置的路径会看到不一致状态。

1. **有 `lifecycle` 字段** → 直接使用（新 schema）
2. **无 `lifecycle`，有 `initialized`**：
   - `initialized=true` → 映射为 `active`
   - `initialized=false` → 映射为 `created`
3. **两者都无** → 默认 `active`（保守，避免老 agent 误入 bootstrap）

**写回时机**：
- 读取时仅在内存映射，不立即写盘
- 下次 config 变更（如 `ec agent ready`、owner 绑定、channel 连接触发 bootstrap）时，自动写入 `lifecycle` 并删除 `initialized`
- `saveAgent()` 或专用写入 helper 应避免把归一化后的 `initialized` 再写回

### Schema 版本

**当前版本**：`CONFIG_SCHEMA_VERSION = 1`  
**新版本**：递增 +1

**兼容性**：
- 新版代码读老 schema：按迁移规则映射，无感
- 老版代码读新 schema：TypeScript 层会忽略 `lifecycle`，但 schema/配置命令层如果遇到未知字段可能报错；需要同步更新 `kits/schemas/agent-config.schema.*.json` 和 `_meta.json`

### 配置链同步点

必须同时更新：
- `AgentConfig` / `EffectiveAgentConfig` 类型增加 `lifecycle?: 'created' | 'bootstrapping' | 'active'`
- `kits/schemas/agent-config.schema.*.json` 增加 `lifecycle`，`initialized` 标记 deprecated
- `ConfigManager.resolveEffective()` 透传 `lifecycle`
- `ec agent get/set` 所依赖的字段路由能识别 `lifecycle`
- ECK debug 参数说明增加 `lifecycle`、`isBootstrapping`

---

## 四、Bootstrap 内容设定

### 待确认字段

| 字段 | 来源 | 设定方式 |
|------|------|----------|
| **昵称** | `agent.md` 的 `name` | Agent 与 owner 交互式确认 |
| **简介** | `agent.md` 的 `description` | Agent 与 owner 交互式确认 |
| **标签** | `agent.md` 的 `tags` | Agent 与 owner 交互式确认 |
| ~~头像~~ | ~~`agent.md` 的 `avatar`~~ | **暂不纳入 bootstrap** |

### 交互流程（示例）

1. **系统主动发起**（固定模板首条消息，不经 baseagent）：  
   "你好！我是新创建的 agent，咱们一起来确认一下我的基本信息吧。"

2. **逐项确认**：
   - "你希望我叫什么名字？"
   - "我的职责或定位是什么？（用一两句话描述）"
   - "给我贴几个标签吧，比如'客服助手'、'代码审查'等"

3. **Agent 写入**：
   - agent 在工具调用中执行专用命令更新 `agent.md`，不建议让 agent 直接手写 YAML/frontmatter
   - 建议新增 `ec agent profile set <aid> --name ... --description ... --tags ...`，内部复用 `agentmdPut()`
   - 命令负责本地同步更新 `~/.evolclaw/AIDs/<aid>/agent.md` 并发布到 AUN

4. **完成**：
   - Agent 调用 `ec agent ready <aid>`
   - 系统切换 `lifecycle=active`
   - 后续对话按正常提示词运行

---

## 五、代码改动点（不含具体实现）

| 位置 | 改动内容 |
|------|----------|
| `src/types.ts` | `AgentConfig` 加 `lifecycle?: string`；`initialized` 标记为 deprecated |
| `kits/schemas/agent-config.schema.*.json` / `_meta.json` | 增加 `lifecycle` 字段，递增 schema 版本，保留 `initialized` 兼容 |
| `src/config-store.ts` / config normalizer | 读取 config 时做 `initialized` → `lifecycle` 内存映射 |
| `src/config/config-manager.ts` | `resolveEffective()` 透传 `lifecycle`，字段路由支持读写 |
| `src/cli/agent.ts` | `agentCreateInteractive`/`agentCreateNonInteractive` 写盘时写 `lifecycle: 'created'`；force 覆盖时保留/迁移旧 lifecycle |
| `src/core/bootstrap-service.ts`（新） | channel 无关的 bootstrap 启动、固定模板渲染、状态翻转、幂等控制 |
| 各 channel 插件/loader | 连接成功后调用 `BootstrapService.tryStartBootstrap(agentAid, channelKey)` |
| `src/channels/aun.ts` | 将现有 welcome/onboarding 副作用拆入共享 bootstrap 流程，保留 agent.md 发布与 binding credential |
| `src/utils/welcome.ts` | 废弃或迁移为 bootstrap seed 模板生成器；`markAgentInitialized` 改为 lifecycle helper |
| `src/core/message/message-processor.ts` | `kitCtx.vars` 新增 `lifecycle` 和 `isBootstrapping` |
| `src/eck/kit-renderer.ts` | debug 参数说明增加 `lifecycle` 和 `isBootstrapping` |
| `kits/eck_manifest.json` | 新增 bootstrap 专属 section，并给常规 identity/relation/venue/persona/working-memory 段排除 bootstrapping |
| `kits/templates/system-fragments/bootstrap.md` | 新建 bootstrap 引导提示词模板 |
| `kits/templates/bootstrap-welcome.md` | 新建系统直接发送给 owner 的固定首条消息模板，不进入 system prompt |
| `src/cli/agent-command.ts` / `src/cli/agent.ts` | 新增 `ec agent ready <aid>` 子命令，支持 agent 工具调用；写盘后触发 IPC reload |
| `src/core/event-bus.ts` | 增加 `agent:bootstrap-started` / `agent:bootstrap-complete` 事件类型，字段使用 `aid` |
| `src/cli/agent.ts` 或新 helper | 新增 profile 更新命令，原子更新 name/description/tags 并调用 `agentmdPut()` |

---

## 六、后续扩展可能

- **头像设置流程**：单独的 `/avatar upload` 或 QR 扫码上传
- **Bootstrap 步骤可配置**：允许自定义 bootstrap 流程（如跳过某字段、增加额外确认）
- **多 channel 细节**：统一生命周期，但每个渠道的“连接成功”和“首条消息接收者”解析可能不同，需要逐渠道接入
- **权限细化**：保持 agent 工具调用必可用，同时细化 owner/admin 手工兜底的范围与审计日志

---

## 七、验收标准

1. ✅ 新创建的 agent `lifecycle=created`
2. ✅ 任一支持 bootstrap 的 channel 连接成功并可主动寻址 owner 时自动进入 `bootstrapping`，发送固定模板首条消息
3. ✅ 无法连接后主动寻址的渠道，在 owner 首次入站并拿到可发送上下文后进入 `bootstrapping`
4. ✅ Bootstrap 阶段加载专属提示词，正常阶段加载常规提示词
5. ✅ Agent 通过工具调用 `ec agent ready <aid>` 后 `lifecycle=active`，daemon 热重载并发布事件
6. ✅ 存量 agent 读取时正确迁移 `initialized` → `lifecycle`
7. ✅ 调试输出 `$EVOLCLAW_HOME/data/eck-debug/vars-*.json` 可见 `lifecycle` 字段
8. ✅ AUN bootstrap 不回归：仍会发布 agent.md、发送 binding credential（渠道支持时）、并具备幂等防重复发送

---

**文档维护者**：evolai  
**审批状态**：待 owner 最终确认

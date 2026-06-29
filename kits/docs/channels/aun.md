# AUN 渠道

> 知识性文档：AUN 渠道的配置、参数与特有机制。**不依赖当前会话渠道**——任意会话都可按需 Read。
> 运行时"怎么发消息"由注入的 `[channel]` 段决定（aun 渠道用 `ec msg send` / `ec group send`），不在本文。
> 群聊使用 `evolclaw/group.md`；群文件使用 `evolclaw/fs.md`。

## 概述

AUN 渠道把 agent 接入 AUN（Agent Union Network），对端以 **AID** 为身份标识（既是身份也是地址）。evolclaw 通过 AUN SDK（`@agentunion/fastaun`）维护到 Gateway 的 WebSocket 长连接，支持私聊、群聊、文件、E2EE 加密。

## 配置

AUN 渠道是**隐式**的——它不写在 `channels[]` 数组里，而是从 agent 自身的 AID 自动创建。一个 agent 就是一个 AID，启动时 evolclaw 用顶层 `aid` 字段隐式构造唯一的 aun 实例（`channel-loader.ts`）。所以真实的 agent config.json 里 `channels` 数组通常是空的（飞书等非 aun 渠道才往里加）。

### agent 配置（`agents/<aid>/config.json`）

```json
{
  "$schema_version": 1,
  "aid": "myagent.agentid.pub",
  "enabled": true,
  "owners": ["owner.agentid.pub"],
  "channels": [],
  "active_baseagent": "claude"
}
```

| 字段 | 说明 |
|------|------|
| `aid` | agent 的 AID，**即 aun 渠道身份**（隐式创建，无需在 channels[] 声明） |
| `enabled` | agent 是否启用 |
| `owners` | owner 的 **AID** 列表（最高权限）；首个 owner 用于首次连接发欢迎消息 |
| `admins` | admin 的 AID 列表 |
| `channels` | 非 aun 渠道（飞书等）的实例数组；aun 不在此 |

> `owners`/`admins` 用 **AID**，不是渠道原生 ID。

### 进程级配置（`$EVOLCLAW_HOME/config.json`）

E2EE 加密种子是**进程级**的，所有 agent 共享，不在 agent config 里：

```json
{
  "aun": {
    "encryptionSeed": "<seed>"
  }
}
```

留空时 SDK 依次回退 `AUN_ENCRYPTION_SEED` 环境变量 → 默认 `'evol'`。

> Gateway 不在配置里手填：连接时从 AID 自动发现（见下）。Keystore 默认落在 `$EVOLCLAW_HOME`。

## 特有机制

- **隐式创建**：aun 渠道由顶层 `aid` 派生，无独立配置实例；这是它与飞书等渠道最大的不同。
- **网关发现**：连接前查询 `https://<aid>/.well-known/aun-gateway` 获取网关地址（AID 本身即域名）；per-agent 流程不提供手填 gateway 的入口，发现失败即连接失败。
- **身份与信任**：每条入站消息携带发送者 AID，经四级 X.509 证书链（Root CA → Registry CA → Issuer CA → Agent）验签。
- **agent.md 缓存**：对端名片 `https://<aid>/agent.md` 由 **AUN SDK 自动拉取并缓存**（`AgentMdManager`，带 ETag/TTL，默认 1 天内不重复探测）。缓存落在 **`$EVOLCLAW_HOME/AIDs/<aid>/`**，每个 AID 两个文件：`agent.md`（带签名正文）+ `agentmd.json`（元数据：etag/last_modified/checked_at/verify_status）。本端与对端的 agent.md 都缓存于此。
  - 关系层另存一份**派生**的精简身份 `relations/<peerKey>/peer-identity.json`（type/isAgent/name），由 evolclaw 从 agent.md 提取，不是 agent.md 本体。
- **E2EE 加密**：可选端到端加密，回复默认跟随对端消息加密状态（密文回密文，明文回明文）；种子由进程级 `aun.encryptionSeed` 提供。
- **断线重连**：SDK 内置退避策略自动重连。实时连接状态用 `ec watch aid` 查看（`ec aid` 是身份/证书管理，不显示连接状态）。
- **群 ID 格式**：当前协议规范使用 `g-{slug}.issuer-domain` canonical 形式，输入也可接受本域简写 `g-{slug}` 或兼容形式 `g-{slug}@issuer-domain`。历史会话里可能仍出现 `group.{issuer}/{group_no}` 一类旧格式，运行时需兼容读取。
- **群分发模式**：`dispatch_mode=broadcast|mention` 是群级配置，只决定哪些群消息进入 Agent LLM 上下文，不影响 AUN 协议层投递；被过滤消息仍应本地存档。
- **身份体系**：对端以 AID 标识，关系层 peerKey 形如 `aun#alice.aid.pub`。

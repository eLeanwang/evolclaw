# 托管服务（Delegate Service）设计方案

**日期**: 2026-07-10
**状态**: 设计草案（待评审）
**作者**: eleanai
**关联模块**: `src/aun/service-proxy.ts`（架构参照）、`src/channels/aun.ts`（身份/连接参照）

---

## 1. 背景与目标

### 1.1 需求

evolclaw 新增一种**身份托管服务**：以独立进程形态，代表一个或多个「托管 AID」接入 AUN 网络，接收发给这些 AID 的消息，按可配置策略把消息**双向代理**给指定处理者（本地 evolagent 实例 / 远程 AID），并把处理者回复以托管 AID 身份原样发回。

> 一句话定位：托管服务 = **身份代理 + 策略路由 + 双向透明代理**。对外它就是某个 AID；对内按信封/payload 字段把消息路由给真正的处理者，回复以托管 AID 身份发出。

### 1.2 主体模型

| 角色 | 定义 | 一期约束 |
|------|------|----------|
| **被托管方（托管 AID）** | owner **本人拥有的某个 agent** 的 AID，托管期间其消息交由秘书代管 | **仅 owner=本人的 agent**；human AID 先忽略 |
| **秘书 / 接管方（handler）** | 处理被托管 AID 消息的一个/几个 AID（agent 或 human） | owner 授权即生效，无需握手 |
| **发起端** | **Evol APP**（owner 手机），在 App 上对自己的 agent 开启托管、指定秘书 | App 经控制面下发配置 |
| **执行端** | evolclaw 的 delegate-service（独立进程，持 keystore，真正执行代理） | 与 keystore 必须同机 |

**授权模型**：一期只托管「owner=本人的 agent」，故**发起者持有该 agent 所有权 = 授权本身**——既不需被托管 AID 确认（本就是自己的），也不需 handler 握手（owner 说了算）。跨主体托管（托管他人 AID / handler 需同意）留待后续。

### 1.3 已确认的设计决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 处理者类型 | 本地 evolagent 实例 **或** 远程 AID |
| 2 | 消息流向 | **双向代理**（处理者回复经托管 AID 身份发出，对外透明） |
| 3 | 配置体系 | **独立** `delegates.json`（不混入 `agent.json`/EvolAgent） |
| 4 | 处理者定位 | 完整 **evolagent 实例**或**远程 AID**，不是裸 baseagent |
| 5 | 进程形态 | **独立进程**（可脱 daemon 独活），走 AUN 协议 |
| 6 | 策略转发 | 按**消息信封字段 + payload 字段**路由 |
| 7 | 托管时间段 | 路由规则支持**时间段**条件 |
| 8 | 兜底机制 | **第一版不做**（缓存/重试/降级/自动回复留待后续） |

### 1.4 非目标（本版明确不做）

- ❌ 处理者不可用时的兜底（缓存/重试/备用处理者/自动回复）
- ❌ 托管**非本人** agent / human AID（跨主体托管留待后续）
- ❌ 秘书 handler 的邀请-应答握手
- ❌ 基于内容语义的智能路由（仅字段/关键词/正则等确定性匹配）
- ❌ 多模态消息转码/预处理（仅透传）

---

## 2. 关键前提

### 2.1 身份加载：keystore

AUN 身份走 **AIDStore keystore**（参照 `src/channels/aun.ts`）：

```
AIDStore(aunPath = keystorePath) → store.load(aid) → AID 对象 → AUNClient(aid)
```

- `keystorePath` 默认 = `EVOLCLAW_HOME`（`aunPath() === resolveRoot()`），与 daemon 共享同一份 keystore
- 托管 AID 身份必须**先落进 delegate 主机 keystore**，才能 `load` 并连接
- 被托管的是 owner **已有的 agent**（AID + 私钥已存在于 Evol APP），**不是** `evolclaw init aun` 新建（那会生成新密钥、变成另一个身份）。已有身份只能经 **§4.1 加密身份搬运**落进 keystore
- 配置中**不出现 `certPath`/`keyPath`**，只用 AID 名称引用；私钥永不入配置文件

### 2.2 处理者是 evolagent 实例，不是 baseagent

托管配置**不指定 baseagent/project**——处理者（evolagent）自带这些。托管服务只负责「把消息投给哪个 evolagent」。

### 2.3 装载模型：瘦模块 + 双装载

delegate 的核心职责（keystore 加载身份、连 AUN、策略路由、双向代理）**不依赖任何 agent backend 或 daemon 的会话/权限栈**。

**① 瘦模块，不是「半个 daemon」。** daemon `index.ts` 拉起的 `SessionManager`/`AgentLoader`/`ChannelLoader`/`MessageQueue`/`PermissionGateway`/`InteractionRouter`/`TriggerManager`/`EvolAgentRegistry` 等组件，delegate standalone **都不需要**。它只要四样：keystore 加载身份（`AIDStore`）、多 AID 连 AUN（对齐 `aun.ts` 重连）、router + proxy-engine（自有逻辑）、一个只认 `name=delegate` 的 **mini menu 控制端点**（§4.8）。

**② 可无 agent / 无 daemon 运行。**
- **全 remote 路由** → 完全无需 agent、无需 daemon，纯「身份托管 + 双向代理中继」。
- **含 local 路由** → 仅那条 route 需对应 evolagent 在跑（daemon 在线）；remote route 不受影响（§8.3）。

**③ 双装载：standalone 为主，in-process 为特例。**

| 装载形态 | 触发条件 | 连接来源 |
|---|---|---|
| **standalone**（默认） | 纯托管 / daemon 未跑 / 该 AID 非在线 evolagent | delegate 自己 `AIDStore.load` + 连 AUN |
| **in-process**（特例） | 托管 AID 恰是 daemon 在线的 evolagent | 复用 daemon 已建连接（仿 service-proxy `controlChannel.getClient()` 动态解引用） |

> **消费者唯一性红线**：AUN 不限制同一 AID 只有一条连接——连接按 `(aid, device_id, slotIsolationKey)` 隔离，不同 device/slot 实例**可并存不互踢**（kick code 4012/4015 只在同一隔离键内触发）。红线在**投递语义**：evolclaw 默认 `delivery_mode=fanout`（广播到所有在线实例）。故同一托管 AID 若有多个在线消费者（另一 delegate 实例 / daemon 内该 evolagent / 手机 App 那份连接），**同一条消息会 fanout 给每个，各自回复 → 重复回复、语义错乱**。
>
> 约束是「**同一托管 AID 任一时刻只有一个活跃消费者**」：
> - 该 AID 是 daemon 在线 evolagent → 走 in-process 复用（不另起消费者）。
> - 手机 App 侧托管期间**停止自动回复**（下线或改只发不收）；owner 仍可事后 `message.pull` 读到消息，可达性不受影响（§8.8）。
> - 跨进程/跨主机唯一性靠装载模型 + 运维纪律保证（§8.8）。

两种装载**共用同一套** connection-manager / router / proxy-engine，只是「连接从哪来」不同。

---

## 3. 总体架构

### 3.1 进程拓扑

```
┌──────────────────────────── AUN 网络 ────────────────────────────┐
│  外部发送者 ──► 托管AID_1 (alice-delegate.agentid.pub)            │
│  外部发送者 ──► 托管AID_2 (bob-delegate.agentid.pub)              │
│  远程处理者 ◄─► emergency-bot.agentid.pub   (remote handler)      │
└───────────────────────┬───────────────────────────────────────────┘
                        │ WebSocket + JSON-RPC（每个托管 AID 一条连接）
                        ▼
┌───────────────────────────────────────────────────────────────────┐
│              delegate-service（独立进程）                          │
│  ① 多 AID 连接管理器  keystore 加载身份 + auto_reconnect          │
│  ② 策略路由引擎      入站 → 准入过滤 → routes 顺序匹配            │
│  ③ 处理者调度器      local → IPC daemon / remote → message.send   │
│  ④ 双向代理引擎      会话映射反查 → 以托管 AID 身份回投 origin    │
└──────────┬──────────────────────────────────────┬─────────────────┘
           │ IPC socket（本地 evolagent）          │ AUN message.send（远程）
           ▼                                       ▼
   ┌──────────────────┐                  ┌──────────────────────┐
   │ evolclaw daemon  │                  │  远程 AID            │
   │  ├ evolagent A   │                  │  （其他 agent/human）│
   │  └ evolagent B   │                  └──────────────────────┘
   └──────────────────┘
```

### 3.2 与现有模块的类比

| 维度 | service-proxy | ecweb | **delegate-service** |
|------|---------------|-------|----------------------|
| 进程形态 | daemon 进程内模块 | 独立进程 | **standalone 为主 / in-process 特例** |
| AUN 身份 | 复用控制 AID | 不碰 AUN | **独立托管 AID（可多个）** |
| 与 daemon 通信 | 同进程直取 client | IPC + 文件系统 | IPC（调 evolagent，可缺席） |
| 数据面 | HTTP/WS 隧道反代 | 只读盘 + IPC live | **AUN message 双向代理** |
| 配置 | `evolclaw.json.serviceProxy` | 无 | **独立 `delegates.json`** |

### 3.3 五个核心组件

1. **多 AID 连接管理器**：为每个托管 AID 从 keystore 加载身份、建 AUNClient、订阅 `message.received`、维护 auto_reconnect（对齐 `aun.ts`）。
2. **策略路由引擎**：入站消息先过准入过滤（§8.7a），业务消息按 `routes` 顺序匹配首个命中规则。
3. **处理者调度器**：`local` 走 IPC 调 daemon 内 evolagent；`remote` 走 `message.send`。
4. **双向代理引擎**：维护会话映射，负责入站包装与出站回投。
5. **配置/生命周期管理**：加载 `delegates.json`、热重载、CLI 状态上报。

### 3.4 纯托管场景的可观测性

无 daemon 的纯中继场景，ecweb 面板**零改动即可用**：文件系统数据源直接 `readdirSync` 读盘（与 daemon 死活无关），IPC live 通道在 daemon 缺席时已降级为 `daemon unreachable` 不崩。delegate standalone 按 ecweb/service-proxy 范式往 `instance/` 写 `delegate-<pid>.json`（§9 T1.2），ecweb 即可读盘展示 delegate 的实例登记 + 路由决策 JSONL（§8.2），为纯托管场景提供观测面。

---

## 4. 详细设计

### 4.1 身份搬运：加密私钥从 Evol APP 到 delegate 主机

delegate 要以被托管 agent 身份收发消息，必须持有该 AID 私钥。但身份此刻在 **Evol APP**（owner 手机），delegate 主机 keystore 没有。托管生效前须先安全搬运。**这是 §4.8 menu 发起流程的前置步骤**：先搬身份，再下发配置。

> **双平面分离**：身份搬运**不走 menu 协议**。
> - **控制平面**（menu protocol，§4.8）：下发/改/撤路由**配置**。
> - **身份平面**（`storage.*` + `claim`，本节）：搬运**私钥密文**。
>
> 分离理由：私钥密文若走控制面 menu RPC，密钥材料会流经消息通道、可能被日志捕获。两平面各自都有 owner/admin 鉴权（控制面见 §4.8，身份面见 §4.2）。

**通道**：AUN `storage` 白名单分享（share-link）+ 客户端加密。三条安全原则：

1. **客户端加密**：私钥由 App 端用一次性 OTP 本地加密（argon2id 派生密钥 + AES-256-GCM），**明文私钥永不出手机**。
2. **白名单分享，非公开**：App `create_share_link` 时**必须显式 `allowed_aids: [<delegate 主机控制 AID>]`**——只有目标主机能读。**绝不省略**（省略默认 `["*"]` 任意 AID 可读，私钥密文属顶级敏感，公开即事故）。
3. **OTP 带外**：解密 OTP 与 share_id 分离传递；即便密文泄露，无 OTP 也离线爆不开。

share-link 把授权前移到文件所有者侧：App 分享时白名单锁定目标主机 AID，delegate **用自己已有的控制 AID 身份**正常 `get_by_share`，不存在「还没拿到被托管 AID、凭什么读」的鸡生蛋。`allowed_aids` + `max_uses` + `expire_in_seconds` 三重收口。

**搬运流程**：

```
① 发起（Evol APP，持被托管 AID 的 keystore 身份）
   owner 选定「把 agent <aid> 托管到 <host-aid>」
   App 生成高熵 OTP（≥128bit）→ argon2id 派生密钥 → AES-256-GCM 加密私钥
   App: storage.put_object 上传（证书明文 + 私钥密文 + 加密信封 metadata，is_private=true）
   App: storage.create_share_link(object_key, allowed_aids=[host-aid],
        expire_in_seconds=<60–300>, max_uses=<1–2>) → share_id
   App 向 owner 展示 share_id + OTP（OTP 带外，与 share_id 分离）

② 领取（delegate 主机，用其控制 AID 身份；触发见 §4.2「触发」）
   delegate（控制 AID ∈ allowed_aids）: storage.get_by_share(share_id) 取密文（白名单校验通过才返回）
   本地用带外 OTP + metadata（salt/nonce/kdf_params）解密私钥
   校验四项（私钥↔证书公钥匹配、证书链到 Root CA、返回 aid 一致、AID 归属本人）
   → 导入本机 keystore（AIDStore）

③ 清理
   成功或过期后：App storage.revoke_share_link + delete_object 销毁密文；OTP 一次性
```

**加密信封**（照搬 custody metadata 结构）：
```json
{
  "envelope_version": 1,
  "purpose": "delegate-transfer",
  "encryption": "aes-256-gcm",
  "kdf": "argon2id",
  "kdf_params": { "m": 65536, "t": 3, "p": 4 },
  "salt": "...", "nonce": "...",
  "otp_hint": "OTP ≥128bit，仅显示给 owner，永不上传"
}
```

**职责分工**：

| 端 | 职责 |
|----|------|
| **Evol APP** | 生成 OTP、本地加密私钥、`put_object`（is_private）、`create_share_link`（白名单=host-aid）、展示 share_id + 带外 OTP、成功后 `revoke_share_link` + `delete_object` |
| **delegate 主机** | 以控制 AID `get_by_share`、本地 OTP 解密、校验四项、导入 keystore |
| **storage 服务** | 校验 requester AID ∈ `allowed_aids` 才放行；只存密文，不知 OTP、不解密 |

> **日志红线**：OTP、明文私钥、解密后私钥、完整密文一律不入 `delegate.log`（§8.6）。

### 4.2 主机侧鉴权：非 owner/admin 不接受托管

§4.1 的 OTP + share_id 只证明「持有搬运秘密」，**不证明「发起者是本机 owner/admin」**。身份平面须自带一道 owner/admin 鉴权，与控制平面对等。`claim` 执行前三层校验，全过才导入：

| 层 | 校验内容 | 来源 |
|----|----------|------|
| **主机准入** | 发起 `claim` 者须为本机 owner/admin | 复用 `config.owners` / `isProcessLevelOwner` |
| **身份归属** | 待导入 AID 的 owner = 本机 owner | `/delegate` 分支**显式校验** agent 归属（§4.8） |
| **搬运秘密** | share_id 有效 + 白名单命中 + OTP 正确（解密成功即证明） | §4.1 |

任一不满足 → 拒绝并 warn，不留残留密文。

**触发方式（App 远程为主，CLI 兜底）**：delegate 主机常为无人值守服务器，owner 手持 App 不在主机跟前——
- **主线：App 远程**（`menu.action name=delegate action=claim`，§4.8）。owner 在 App 点领取，App 把 `{aid, share_id, host_aid}` 经控制面下发到 delegate mini-menu 端点，delegate 自己以控制 AID 去 `get_by_share`、解密、导入。**OTP 保持带外**（不随 action 同通道）。
- **兜底：本地 CLI**（`evolclaw delegate claim`，§5）。App 不可达/首次 bootstrap 时，owner 登主机手敲，录入 share_id + OTP。

> 搬运秘密（OTP）防「密文被第三方解密」，主机门禁（本节）防「非授权者在本机导入身份」。二者正交，缺一不可。

### 4.3 配置结构 `delegates.json`

位置：`EVOLCLAW_HOME/data/delegates.json`

```json
{
  "enabled": true,
  "delegates": [
    {
      "aid": "alice-delegate.agentid.pub",
      "enabled": true,
      "routes": [
        {
          "name": "工作时间的工作群转给 work-agent",
          "condition": {
            "chatType": "group",
            "groupId": "work-team.group.agentid.pub",
            "timeRange": { "days": [1,2,3,4,5], "start": "09:00", "end": "18:00", "tz": "Asia/Shanghai" }
          },
          "handler": { "type": "local", "evolagent": "work-agent" }
        },
        {
          "name": "紧急关键词转给远程助手",
          "condition": {
            "payloadMatch": { "keywords": ["紧急", "urgent"], "messageTypes": ["text"] }
          },
          "handler": { "type": "remote", "aid": "emergency-bot.agentid.pub" }
        },
        {
          "name": "兜底：转给主 agent",
          "condition": {},
          "handler": { "type": "local", "evolagent": "main-agent" }
        }
      ]
    }
  ]
}
```

**匹配规则**：进路由前先过准入过滤（§8.7a：回声/thought/控制信令静默丢弃、不计失败）。业务消息按 `routes` 顺序匹配，**首命中即生效**；末条空 `condition` 作默认路由。无命中且无默认路由 → 计入失败丢弃并记日志（本版无兜底，§8.7b）。

### 4.4 路由条件字段

| 字段 | 来源 | 匹配语义 |
|------|------|----------|
| `chatType` | 信封 | `private` / `group` 精确匹配 |
| `groupId` | 信封 | 群组 AID 精确匹配（仅 group 有意义） |
| `senderId` | 信封 | 发送者 AID 精确匹配 |
| `senderIn` | 信封 | 发送者 AID 白名单（数组 OR） |
| `payloadMatch.keywords` | payload | 关键词 OR 命中（子串） |
| `payloadMatch.regex` | payload | 正则命中 |
| `payloadMatch.messageTypes` | payload | 消息类型集合（text/image/file/…） |
| `timeRange` | 服务器时钟 | 星期集合 + 时段 + 时区（托管时间段） |

同一 `condition` 内多字段为 **AND**；数组类字段内部为 **OR**。所有字段可选，全空 = 无条件匹配。

### 4.5 处理者调度

| type | 投递方式 | 回复来源 |
|------|----------|----------|
| `local` | IPC → daemon，指定 `evolagent` 名，附 origin 信封 | daemon 回传 evolagent 产出 |
| `remote` | `message.send` 到 `handler.aid`，payload 内嵌 origin 元信息 + `correlationId` | 监听该远程 AID 的 `message.received` |

### 4.6 双向代理与会话映射

对外透明的关键是「回复要发回原始发送者」。会话映射：

```
mappingKey = (托管AID, originSenderId, [groupId])
mappingValue = { handler, createdAt, lastActiveAt, ttl, correlationId }
```

- **入站**：origin → 匹配路由 → 建/复用映射 → 携带 origin 信息投递处理者
- **出站**：处理者回复 → 反查映射 → 以托管 AID 身份 `message.send` 回 origin
- **生命周期**：`lastActiveAt` 空闲超 `ttl`（默认可配，如 30 分钟）即回收；托管时间段到期后停止新建映射（在途已建映射完成本轮）
- **持久化**：反查表落 JSONL，重启后加载续投（§8.2）

### 4.7 与 daemon 的 IPC 接口（local handler）

daemon（`src/ipc.ts`）新增方法供 delegate 调用：

```
方法: delegate.dispatch
入参: { delegateAid, evolagent, origin: {senderId, chatType, groupId, senderName}, payload }
出参: { status: 'ok'|'error', reply?: <agent 产出>, error? }
```

daemon 把请求路由到指定 evolagent 的消息处理管线（复用 MessageProcessor），产出作 reply 返回。evolagent 视角下这是一条「来自 origin 的消息」，session 归属该 evolagent（决策 #4）。

### 4.8 托管发起：复用 menu protocol（`name=delegate`）

发起端 = Evol APP，经 EvolClaw 已有的**控制面 menu protocol**下发配置，不新建传输通道。

**协议机制**（核实自 `message-bridge.ts` + `menu-handler.ts`）：
- 三动词 `menu.query`/`menu.update`/`menu.action` + `menu.list`/`menu.options`
- `name=` 经 `MENU_NAME_MAP`（`message-bridge.ts:372`）映射到内部 cmd → 新增 `delegate: '/delegate'`
- 载体：AUN channel custom payload（JSON）；App 发 `{type:'menu.update', name:'delegate', value:'<JSON>'}` → `cmdHandler.execMenuUpdate`
- 响应：`{type:'menu.response', id, name:'delegate', data|error}`

**动词映射**：

| 动词 | 用途 | value/action |
|------|------|--------------|
| `menu.query` | 查某 agent 托管状态 | args: `{aid}` |
| `menu.list/options` | 列可托管的本人 agent / 候选 handler | — |
| `menu.update` | 开启/修改托管 | value=JSON：`{aid, handlers[], routes[], timeRange}`（参照 `/gateway`/`/trigger`） |
| `menu.action` | 生命周期动作 | `claim` / `enable` / `disable` / `revoke` |

**生命周期动作语义**：

| action | 效果 | keystore 私钥 | 恢复成本 |
|--------|------|:---:|----------|
| `claim` | 远程触发身份领取（§4.1/§4.2） | 导入 | — |
| `enable` | 启用已配置托管 | 保留 | 即时 |
| `disable` | **临时暂停**：断连该 AID + 回收映射，配置与身份保留 | **保留** | 即时（再 enable） |
| `revoke` | **彻底解除**：断连 + 回收映射 + 删配置 + **清 keystore 私钥** | **清除** | 需重走搬运 |

分级理由见 §8.10：`disable` 保留身份换即时恢复，`revoke` 清私钥把主机长期暴露面降到零。

> **`action=claim` 特殊性**：触发的是**身份平面**动作（delegate 以控制 AID 去 `get_by_share` 取密文、解密、导入 keystore），非改配置。载荷带 `{aid, share_id, host_aid}`，**OTP 不随此 action 同通道**（保持带外）。

**鉴权（复用双轨 + 一处显式校验）**：
- `/delegate` 加入 `isProcessLevelAction` 白名单 → 强制 `fromControlChannel` + `isProcessLevelOwner(userId, owners)`
- **「仅本人 agent」须 `/delegate` 分支显式校验**：`gateControlScope` 在 `fromControlChannel=true` 时直接放行（`return null`），其「跨 agent 寻址 FORBIDDEN」闸只对非控制 channel 生效——控制面下「目标 agent 归属本人」这道校验它不代劳（`/agent` 的 `execAgentAction` 亦是拿 `peerId` 作主体、由 action 自行把关）。故 `/delegate` 分支须**显式校验 `args.aid` 的 agent owner == 发起者**（与 §4.2「身份归属」共用一个 owner 判定）
- 落地：menu 分支写 `delegates.json` + 触发 `delegate reload`

---

## 5. CLI 命令

```bash
evolclaw delegate start          # 启动托管服务（独立进程，detached）
evolclaw delegate stop           # 停止
evolclaw delegate status         # 各托管 AID 连接状态 + 路由摘要 + 计数
evolclaw delegate reload         # 热重载 delegates.json
evolclaw delegate logs [<aid>]   # 查看（某个）托管 AID 的转发日志
evolclaw delegate claim --aid <aid>   # 领取身份搬运：录入 share_id+OTP，解密导入 keystore（§4.1）
```

---

## 6. 目录与文件规划

```
src/delegate/
├── index.ts              # 独立进程入口（参照 ecweb/src/index.ts）
├── delegate-service.ts   # 主服务：连接管理 + 生命周期
├── connection-manager.ts # 多 AID 连接（keystore 加载 + 重连）
├── admission.ts          # 准入过滤（回声/thought/控制信令，§8.7a）
├── router.ts             # 策略路由引擎（信封/payload/时间段匹配）
├── dispatcher.ts         # 处理者调度（local IPC / remote message.send）
├── proxy-engine.ts       # 双向代理 + 会话映射表
├── identity-transfer.ts  # 身份搬运领取端：get_by_share + 解密 + 校验 + 导入（§4.1）
└── config.ts             # delegates.json 加载/校验/热重载 diff

src/cli/index.ts                     # 新增 delegate 子命令
src/ipc.ts                           # 新增 delegate.dispatch 方法（local handler）
src/core/message/message-bridge.ts   # MENU_NAME_MAP 加 delegate:'/delegate'（§4.8）
src/core/command/menu-handler.ts     # /delegate 分支 + isProcessLevelAction 加入 /delegate

EVOLCLAW_HOME/data/
├── delegates.json                   # 配置
└── instance/delegate-<pid>.json     # 单实例登记（参照 ecweb）

EVOLCLAW_HOME/logs/delegate.log      # 转发日志
```

---

## 7. 数据流

### 7.1 托管交互全生命周期

```
═══ 阶段 A：身份搬运（一次性前置，§4.1）═══
 A1  owner 在 App 选定「把 agent <aid> 托管到 <host-aid>」
 A2  App 生成高熵 OTP（≥128bit）→ argon2id 派生密钥 → AES-256-GCM 加密私钥
 A3  App: put_object 上传（证书明文 + 私钥密文 + 信封，is_private）
     App: create_share_link(allowed_aids=[host-aid], expire短, max_uses小) → share_id
 A4  App 向 owner 展示 share_id + OTP（OTP 带外）
 A5  触发 claim（App 远程为主 / CLI 兜底，§4.2）：
       主线: App 点领取 ──menu.action action=claim {aid,share_id}──► delegate mini-menu（OTP 带外）
       兜底: owner 登主机敲 evolclaw delegate claim --aid <aid>，录入 share_id + OTP
 A5' 主机门禁（§4.2）：发起者 = 本机 owner/admin + 待导入 AID 归属本人（否则拒绝，OTP 正确也不放行）
 A6  delegate（控制 AID ∈ allowed_aids）: get_by_share → OTP 解密 → 校验四项 → 导入 keystore
 A7  App: revoke_share_link + delete_object 销毁密文；OTP 一次性失效
       ↓ 托管 AID 身份已在 delegate 主机 keystore（连接前提就绪）

═══ 阶段 B：托管配置下发（menu protocol，§4.8）═══
 B1  owner 在 App 配置路由（handlers/routes/timeRange）
 B2  App ──menu.update name=delegate value=<JSON>──► 控制 AID channel
 B3  message-bridge → cmdHandler → 鉴权：fromControlChannel + isProcessLevelOwner + 分支归属校验
 B4  /delegate 分支：写 delegates.json → 触发 delegate reload
 B5  reload: diff 配置 → 该 AID 未连 → AIDStore.load + 连 AUN + 订阅 message.received
 B6  App 收 menu.response{data} 确认生效
       ↓ delegate-service 已以托管 AID 身份在线，路由表就绪

═══ 阶段 C：消息双向代理（稳态循环，§4.6）═══
 C1  外部发送者 ──message.send──► 托管 AID（delegate AUNClient 收 message.received）
 C2  准入过滤 → router 匹配 routes → 命中 handler
 C3  proxy-engine 建/复用会话映射（含 correlationId）
 C4  dispatcher 投递：local → IPC delegate.dispatch → daemon evolagent
                       remote → message.send（payload 嵌 correlationId）
 C5  处理者产出回复（remote 原样回带 correlationId）
 C6  proxy-engine 反查映射 → 以托管 AID 身份 message.send(reply) ──► 原发送者
       ↓ 外部视角全程在与托管 AID 对话（双向透明）

═══ 阶段 D：撤销 / 变更（menu protocol，§4.8）═══
 D1  owner 在 App: menu.action action=disable|revoke（或 update 改路由）
 D2  disable → 断连 + 回收映射，配置与私钥保留（即时可 enable）
     revoke  → 断连 + 回收映射 + 删配置 + 清 keystore 私钥 + 清会话 JSONL
 D3  revoke 后暴露面归零；下次托管需重走阶段 A
```

**关键时序约束**：
- **A 必须先于 B**——身份不进 keystore，B5 连接起不来。
- **A 是一次性的**，之后 B/C/D 可反复；仅当 owner `revoke` 清 keystore 才需重新搬运。
- **in-process 特例**：该 AID 恰是 daemon 在线 evolagent 时，B5 不新建连接，复用 daemon 已有连接（§2.3）。

### 7.2 消息代理数据流（阶段 C 展开）

外部用户 `user123` 私聊托管 AID `alice-delegate`，工作时间内路由到本地 `work-agent`：

```
1. user123 ──message.send──► alice-delegate（AUN 网络）
2. delegate AUNClient(alice-delegate) 收 message.received
3. router: chatType=private, 命中「工作时间」规则 → handler=local:work-agent
4. proxy-engine: 建映射 (alice-delegate, user123) → work-agent
5. dispatcher: IPC delegate.dispatch → daemon → work-agent → reply
6. proxy-engine: 反查映射，以 alice-delegate 身份 message.send(reply) ──► user123
7. user123 视角：全程在与 alice-delegate 对话（透明）
```

---

## 8. 设计裁决细则

### 8.1 remote 回复关联：correlationId 主，弱关联降级

dispatcher 转发给 remote handler 时 payload 内嵌 `correlationId`（唯一标识本次映射），处理者原样回带 → proxy-engine 精确反查 → 回投 origin。处理者未回带时降级为「handler AID + 最近活跃映射」弱匹配（同一 handler 并发多路会话可能串话，本版已知限制）。这是关联正确性，与「不做可用性兜底」不冲突。

### 8.2 会话映射持久化

反查表 `(origin, 托管AID) → handler + correlationId` 落 JSONL 持久化，重启后加载、在途会话回复仍正确投回。生命周期受 `ttl` 与托管时间段约束，过期条目回收 + 压缩。（路由规则在 `delegates.json`、路由决策在 `delegate.log`，本就持久化。）

### 8.3 daemon 未运行时：仅影响 local 路由

remote 路由由 delegate 自己走 `message.send`，不经 daemon，daemon 宕机照常。local 路由命中但 daemon/目标 evolagent 不可达 → warn + 失败丢弃（§8.7b），不缓存不重试。故障域隔离：远程代理不应被本地 daemon 状态拖累。

### 8.4 多模态透传

image/file/video 等 payload **原样透传**给 handler（含 remote），不落地、不转码。托管服务是代理不是处理者。

### 8.5 remote 回复 vs 新请求的甄别

一条 incoming 判为「handler 回复」当且仅当（AND）：① `senderAid` 是某活跃映射的 handler，**且** ② payload 回带匹配的 `correlationId`。两条都满足 → 出站回投；否则一律当**新入站请求**走路由（即使 senderAid 恰是某 handler，此刻它以「发起者」身份说话）。correlationId 缺失时落 §8.1 弱匹配；该 handler 无任何活跃映射则判为新请求。**模糊时偏向当新请求**（宁可多走一次路由，不可把新消息误当回复吞掉）。

### 8.6 日志隐私

delegate 转发的是外部用户与被托管 agent 的私密对话。`delegate.log` **默认只记元数据**（时间、托管 AID、origin senderId、route 名、handler 目标、消息类型、字节数、correlationId、结果状态），**不记正文**。搬运秘密（OTP/明文私钥/解密私钥/完整密文）绝不入任何日志。正文调试用显式 verbose 开关（默认关，开启脱敏截断）。

### 8.7 消息类型准入 + 失败丢弃可观测

**(a) 准入过滤**（协议层，静默正常，不计失败）——按 `payload.type` + 信封类型：

| 类别 | 示例 | 处理 |
|------|------|------|
| **转发** | `text`/`quote`/`image`/`video`/`file`/`voice`/`location`/`merge`/`action_card`/`action_card_reply`/`personal_card` | 进路由引擎 |
| **丢弃-协议** | 自身 fanout 回声（`fromAid==self` 且 chat_id 不匹配，仿 `aun.ts:1398`）、`thought`（走 `thought.put` 非广播）、`INJECT_REQUEST_TYPE` 等内部信封、typing/ack 回执 | 静默丢弃，**不计失败** |
| **丢弃-未知** | 未知 `payload.type` | 默认丢弃并计数（保守）；可配置降级按 `text`/`fallback_text` 转 |

> 回声与 thought 的过滤是「正常」非「失败」，绝不计进失败丢弃计数，否则正常噪声淹没真失败。

**(b) 失败丢弃**（业务消息处理不了，危险的静默失败，必须可见）——无路由命中 / local daemon 不可达 / handler send 失败时丢弃。不做主动通知（那属兜底），但**必须可见**：每次失败丢弃记 `delegate.log`（含原因三分类）；`delegate status` 暴露各托管 AID 失败丢弃计数（按原因），与准入过滤计数**分开统计**；ecweb 面板读取展示。这是「无兜底」与「无声失败」的界线。

### 8.8 消费者唯一性（fanout 语义）

AUN 默认 `delivery_mode=fanout` 广播给该 AID 每个在线实例，各自回复 → 重复回复。触发场景：① 同一 AID claim 到两台主机；② delegate + daemon 内同名 evolagent 同时在线（§2.3 in-process 复用解决）；③ 托管期间手机 App 连接未停止自动回复。

**一期裁决**：不做自动仲裁，靠装载模型 + 运维纪律保证「一个托管 AID 任一时刻一个活跃消费者」：一 AID 只在一台主机运行；claim 时 `list_share_links` / 检查本机是否已持有该 AID（防同机重复）；提示 owner 让该 AID 手机 App 停止自动回复。

> **停止 App 回复 ≠ owner 收不到消息**：fanout 消息服务端 DB 持久化（默认 TTL 24h），App 离线后仍可 `message.pull` 补齐托管期间全部消息。要避免的只是 App 自动回复造成的重复，不是消息可达性。

跨主机/跨设备全局互斥需中心协调（分布式锁 / 单消费者仲裁 / `queue` delivery_mode），超出一期范围（依赖的 SDK 增强见 §10）。

### 8.9 群聊代理语义：回复发回群

托管 AID 在群里收消息 → 转 handler → handler 回复**以托管 AID 身份发回该群**（不是私聊发言人）。
- **mappingKey 带 `groupId`**：`(托管AID, originSenderId, groupId)`，回投目标 = 群。
- **入站过滤**：群里默认**被 @ 才代理**（沿用 `aun-role.md` 群聊惯例）；未被 @ 的按 route 决定是否转（默认不转，避免整群刷屏灌给 handler）。
- **@ 透传**：原始 @提及 原样透传给 handler，delegate 不解析 @ 目标。
- **一期最简**：群级映射 + @透传；发言人粒度映射、handler 回复带「回应谁」提示留 M5 群聊子阶段。

群聊透明代理的本质是「托管 AID 作为群成员被代管」，回复回群才维持透明。

### 8.10 双持与撤销：disable 保留、revoke 清私钥

身份搬运是**复制不是转移**：私钥搬到主机后手机 App 那份依然有效，此刻双持（手机 + 主机）。
- `disable`：临时暂停，**保留** keystore 私钥，换即时恢复；双持状态持续，owner 需知悉。
- `revoke`：彻底解除，**从 keystore 清除**该 AID 私钥 + 删配置 + 清会话映射 JSONL + 在途消息。须真正抹除私钥文件（非仅逻辑标记）。
- **不做密钥轮换**：托管的是 owner 自己的 agent，手机与主机同属 owner，双持在信任域内；仅靠 revoke 清主机侧副本控制暴露面。跨主体托管（需强隔离）留待后续。

---

## 9. 实现任务清单

按依赖顺序分组，每组内可并行。M = 里程碑。

### M1 — 骨架与配置
- [ ] **T1.1** `src/delegate/config.ts`：`delegates.json` schema + 加载 + 校验（AID 格式、routes 非空、handler 类型、timeRange 格式）
- [ ] **T1.2** `src/delegate/index.ts`：独立进程入口（`--home`/`--config`、单实例保护、`instance/delegate-<pid>.json` 登记，参照 `ecweb/src/index.ts`）
- [ ] **T1.3** `delegates.json` 样例 + 配置说明
- **验收**：`delegate start` 能起进程、读配置、登记实例文件、优雅退出

### M2 — 多 AID 连接
- [ ] **T2.1** `connection-manager.ts`：从 keystore 逐个加载托管 AID（`AIDStore.load` → `AUNClient`），对齐 `aun.ts`
- [ ] **T2.2** 订阅 `message.received`，auto_reconnect + flap/kick 检测；自身 fanout 回声过滤（仿 `aun.ts:1398`）
- [ ] **T2.3** keystore 缺失的托管 AID → 该 AID 启动 warn，不影响其他
- [ ] **T2.4** 消费者唯一性守卫（§8.8）：启动/claim 检查本机是否已消费该 AID；是 daemon 在线 evolagent → in-process 复用；提示 owner 让 App 停止自动回复
- **验收**：托管 AID 连上、收消息打日志、断线重连；同机重复消费被拒

### M3 — 策略路由引擎
- [ ] **T3.0** `admission.ts`：准入过滤（§8.7a）——回声/`thought`/内部信封/回执 静默丢弃不计失败；未知 type 丢弃并计数
- [ ] **T3.1** `router.ts`：信封字段匹配（chatType/groupId/senderId/senderIn）
- [ ] **T3.2** payload 匹配（keywords/regex/messageTypes）
- [ ] **T3.3** `timeRange` 匹配（days + start/end + tz）
- [ ] **T3.4** 顺序匹配 + 首命中 + 空 condition 默认路由 + 无命中→失败丢弃计数记日志（§8.7b）
- **验收**：单测覆盖准入过滤 + 路由条件组合（AND/OR、时间边界、无命中）；两类计数分开

### M4 — 处理者调度
- [ ] **T4.1** `src/ipc.ts`：daemon 新增 `delegate.dispatch`（路由到 evolagent 的 MessageProcessor，回传产出）
- [ ] **T4.2** `dispatcher.ts` — local：IPC 调 daemon；不可达 → warn + 失败丢弃计数（§8.3/§8.7b）
- [ ] **T4.3** `dispatcher.ts` — remote：`message.send` 到 handler.aid，payload 嵌 `correlationId`
- **验收**：local 唤起 evolagent 产出；remote 投给远程 AID

### M5 — 双向代理引擎
- [ ] **T5.1** `proxy-engine.ts`：会话映射表 `(origin, 托管AID[, groupId]) → handler + correlationId`，`ttl` + 托管时间段回收
- [ ] **T5.2** 入站：建/复用映射 + 携带 origin 信息投递
- [ ] **T5.3** 出站：§8.5 双条件甄别 → 反查映射（缺失弱匹配降级，§8.1）→ 以托管 AID 身份回投 origin
- [ ] **T5.4** 映射表 JSONL 持久化 + 重启续投 + 过期压缩（§8.2）
- [ ] **T5.5** 多模态 payload 原样透传（§8.4）
- [ ] **T5.6** 群聊代理（§8.9）：mappingKey 带 groupId、被 @ 才代理、@透传、回复发回群
- [ ] **T5.7** 日志隐私（§8.6）：默认只记元数据；verbose 开关（默认关、脱敏）
- **验收**：端到端私聊 + 群聊，local & remote 回复透明投回（群回群、私回私）；重启续投

### M6 — CLI 与生命周期
- [ ] **T6.1** `delegate start/stop/status/reload/logs` 子命令
- [ ] **T6.2** 热重载：diff 新增/删除/变更的托管 AID 与路由 → 按需 connect/disconnect/更新路由表
- [ ] **T6.3** `status`：连接状态 + 路由摘要 + 转发计数 + 失败丢弃计数（按原因）+ 准入过滤计数（分开列）
- [ ] **T6.4** 退出统计（连接数/处理消息数/转发计数/失败丢弃/准入过滤）
- **验收**：五命令可用；热重载不断开未变更 AID；两类计数分开可见

### M5.5 — 身份搬运（运行时前置，§4.1）
- [ ] **T5.5.1** `identity-transfer.ts`：领取端——`get_by_share` 取密文 → argon2id 派生 → AES-256-GCM 解密 → 校验四项 → 导入 keystore
- [ ] **T5.5.2** 加密信封 codec（`envelope_version`/kdf_params/salt/nonce），与 App 端逐字节对齐
- [ ] **T5.5.3** `evolclaw delegate claim --aid <aid>`（交互录入 share_id + OTP）；成功后 `revoke_share_link` + `delete_object`
- [ ] **T5.5.4** 【Evol APP 侧，跨仓】发起：生成 OTP + 本地加密 + `put_object` + `create_share_link(allowed_aids=[host-aid])` + 展示 share_id/OTP + 用后销毁。本仓只定义信封格式契约与 share-link 参数约定
- **验收**：App 上传密文 → `claim` 输入 OTP → 私钥落 keystore → 该 AID 可被加载连接；OTP 错误则拒绝；密文用后销毁

### M6.5 — 托管发起接口（menu protocol `name=delegate`，§4.8）
- [ ] **T6.5.1** `MENU_NAME_MAP` 新增 `delegate: '/delegate'`（`message-bridge.ts`）
- [ ] **T6.5.2** `/delegate` menu 分支：`query`（查托管状态）/ `list·options`（列本人 agent、候选 handler）/ `update`（开启/改托管，value=JSON）/ `action`（`claim`/`enable`/`disable`/`revoke`）
- [ ] **T6.5.3** 鉴权：`/delegate` 加 `isProcessLevelAction` → 强制 `fromControlChannel` + `isProcessLevelOwner`；**分支内显式校验 `args.aid` 的 agent owner == 发起者**（`gateControlScope` 控制 channel 不代劳归属校验，§4.8）
- [ ] **T6.5.4** menu 分支落地：写 `delegates.json` + 触发 `delegate reload`
- [ ] **T6.5.5** `revoke` 清理链（§8.10）：删配置 + 断连 + 回收映射 + **keystore 抹除私钥** + 清会话 JSONL；`disable` 仅断连+回收，保留身份
- **验收**：`menu.update` → 鉴权通过 → 落盘 → 热加载生效；非本人 agent 被分支归属校验拒（FORBIDDEN）；非控制 channel 被 `isProcessLevelAction` 拒；`revoke` 后 keystore 无私钥、`disable` 后仍在

### M7 — 测试与文档
- [ ] **T7.1** 单测：config 校验、router 匹配矩阵、proxy 映射反查（含 correlationId 缺失降级）
- [ ] **T7.2** 集成测试：端到端 local + remote 双向代理、重启续投
- [ ] **T7.3** 更新 `CLAUDE.md`（新增 delegate 模块段）+ 本文档定稿

### 关键路径与并行度
- **关键路径**：M1 → M2 → M5（连接与双向代理是主干）
- **前置依赖**：M5.5 领取端 → M2 连接（keystore 必须先有身份）；实际排期上 M5.5 领取端应与 M2 并行或更早
- **可并行**：M3（纯函数）、M4.1（daemon IPC）、M5.5（身份搬运）、T5.5.4（App 侧跨仓）
- **风险点**：T4.1（daemon 改动，复用 MessageProcessor 不引入回环）、T5.3（correlationId 关联正确性）、T5.5.2（加密信封与 App 逐字节对齐）

---

## 10. 附：设计依据

- **协议层无委托凭证**：`_packed_docs/protocol/01-身份与凭证协议-auth.md`——`auth.*` 无「A 授权 B 代言」机制，托管只能靠 keystore 持有身份。
- **独立进程 + 旁路通信范式**：`src/aun/service-proxy.ts`（aunFacade 动态解引用、serveForever persistent、失败只 warn）；`ecweb/src/index.ts`（--home 定位、单实例保护、instance 登记）。
- **多 AID 连接与重连**：`src/channels/aun.ts`（AIDStore keystore 加载、auto_reconnect、flap/kick 检测）。
- **身份搬运安全基线**：`_packed_docs/sdk/09-custody-api-manual.md`——客户端加密、中转只存密文、OTP 带外一次性、加密信封 metadata（argon2id + aes-256-gcm）、claim 前校验四项、日志红线。搬运通道用 storage share-link，不依赖外部 custody 服务。
- **搬运通道**：`_packed_docs/sdk/09-storage-rpc-manual.md`——`create_share_link` / `get_by_share` / `revoke_share_link` / `list_share_links`（fastaun ≥0.5.4，本机安装已满足）。`get_by_share` 对私有分享强制校验 requester AID ∈ `allowed_aids`；`allowed_aids` + `max_uses` + `expire_in_seconds` 三重收口。storage 无端到端加密，密文加密责任在 App 端（与白名单正交叠加）。
- **投递语义与消费者唯一性**：`_packed_docs/sdk/09-message-rpc-manual.md`（`delivery_mode=fanout` 广播、DB 持久化默认 24h、`message.pull` 离线补齐）+ `src/channels/aun.ts`（连接按 `(aid, device_id, slotIsolationKey)` 隔离、kick 4012/4015 仅同隔离键、回声过滤）。
- **控制面鉴权范式（含边界）**：`src/core/command/menu-handler.ts`（`isProcessLevelAction` → 强制 `fromControlChannel`；`gateControlScope` 双闸）+ `src/core/message/command-handler-agent-control.ts`（`/agent` 以 `peerId` 为鉴权主体）。**边界**：`gateControlScope` 在 `fromControlChannel=true` 时直接放行，「跨 agent 寻址 FORBIDDEN」只对非控制 channel 生效——控制面下「目标 agent 归属本人」须命令分支自校验（§4.8）。
- **待 AUN SDK 增强**：
  - **selfAID 在线实例查询**：让 delegate claim 前探测「本 AID 是否已被别处托管 / 活跃 device·slot」，把消费者唯一性从运维纪律升级为可编程校验（§8.8）。
  - **`delivery_mode=queue` 单消费者模式**：从协议层根治 fanout 重复（§8.8），优先级低于前者。

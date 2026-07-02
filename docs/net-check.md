# evolclaw net check — 网络链路诊断

## 概述

`evolclaw net check` 是一个 10 步逐层网络链路诊断命令，用于检测 AUN (Agent Union Network) 从 DNS 解析到消息收发的完整连通性。每一步依赖前一步的结果，任何一步失败即终止后续检测并报告故障点。

## 用法

```bash
evolclaw net check [<aid>...] [--format json]
```

**参数：**

| 参数 | 说明 |
|------|------|
| `<aid>` | 要检查的 AID（可指定多个），省略时自动选取本地 AID |
| `--format json` | 以 JSON 格式输出结果 |

**退出码：**

- `0` — 所有检查通过
- `1` — 存在失败项

---

## 10 步检测流程

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1   DNS (AID)       AID 域名 A 记录解析                    │
│  Step 2   Discovery       .well-known/aun-gateway 获取网关地址    │
│  Step 3   DNS (Gateway)   网关域名 A 记录解析                    │
│  Step 4   TCP             网关端口 TCP 连接                      │
│  Step 5   TLS             TLS 握手 + 协议/密码套件/证书验证       │
│  Step 6   WSS             WebSocket 升级握手                     │
│  Step 7   Auth            AID 认证 (login1 → login2 → token)    │
│  Step 8   Session         会话建立 + agent.md 签名验证            │
│  Step 9   Ping            meta.ping RPC 调用                     │
│  Step 10  Echo            多目标消息发送 + 链路追踪               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 各步骤详解

### Step 1: DNS (AID)

对 AID 域名执行 DNS A 记录解析。

```
输入: aid 字符串（如 alice.example.com）
操作: dns.resolve4(aid)
输出: IP 地址列表 + 耗时
```

**成功示例：**
```
  ✓ [1/10] DNS (AID)  解析 alice.example.com → 1.2.3.4  12ms
```

**失败示例：**
```
  ✗ [1/10] DNS (AID)  解析 alice.example.com 失败: ENOTFOUND
```

---

### Step 2: Discovery

通过 HTTPS GET 请求 `/.well-known/aun-gateway` 获取网关 URL。

```
输入: https://{aid}/.well-known/aun-gateway
操作: HTTPS GET，解析 JSON 响应中的 gateways[0].url
输出: 网关 WebSocket URL
超时: 8000ms
```

**响应格式：**
```json
{
  "gateways": [
    { "url": "wss://gw.example.com/ws" }
  ]
}
```

**成功示例：**
```
  ✓ [2/10] Discovery  GET https://alice.example.com/.well-known/aun-gateway → wss://gw.example.com/ws  45ms
```

---

### Step 3: DNS (Gateway)

解析网关域名的 A 记录。

```
输入: 从 Step 2 获取的网关 hostname
操作: dns.resolve4(gwHost)
输出: IP 地址列表 + 耗时
```

---

### Step 4: TCP

建立到网关端口的 TCP 连接。

```
输入: gwHost, gwPort（默认 443）
操作: net.connect()
超时: 5000ms
输出: 连接耗时
```

**成功示例：**
```
  ✓ [4/10] TCP  连接 gw.example.com:443  23ms
```

---

### Step 5: TLS

执行 TLS 握手，验证证书并获取协议信息。

```
输入: gwHost, gwPort
操作: tls.connect() with servername (SNI)
超时: 5000ms
输出: TLS 协议版本、密码套件、证书 CN
```

**成功示例：**
```
  ✓ [5/10] TLS  gw.example.com:443 TLSv1.3 TLS_AES_256_GCM_SHA384 CN=*.example.com  31ms
```

---

### Step 6: WSS

WebSocket 升级握手测试。

```
输入: 完整网关 URL (wss://...)
操作: new WebSocket(url) → 等待 open 事件
超时: 8000ms
输出: 握手耗时
```

**成功示例：**
```
  ✓ [6/10] WSS  WebSocket 连接成功 (wss://gw.example.com/ws)  56ms
```

---

### Step 7: Auth

使用 AUN SDK 执行完整认证流程。

```
操作流程:
  1. createAunClient({ aunPath })
  2. client.auth.createAid({ aid })
  3. client.auth.authenticate({ aid })  → login1 + login2 → access_token
输出: 认证成功/失败 + 耗时
```

**成功示例：**
```
  ✓ [7/10] Auth  alice.example.com 认证成功 (login1→login2→token)  320ms
```

---

### Step 8: Session + AgentMd

会话建立，并读取当前 AID 的 `agent.md` 进行签名验证。

```
操作:
  1. 标记会话就绪
  2. agentmdGet(aid, { withVerification: true })
  3. 解析 frontmatter 中的 name 字段
  4. 验证签名状态
输出: agent 名称 + 签名状态
```

**成功示例：**
```
  ✓ [8/10] Session  会话就绪
  ✓ [8/10] AgentMd  Alice (sig: valid)  89ms
```

---

### Step 9: Ping

通过已建立的连接执行 `meta.ping` RPC 调用。

```
操作:
  1. 重新认证并连接（connection_kind: 'short'）
  2. client.call('meta.ping', {})
输出: 响应状态 + 耗时
```

**成功示例：**
```
  ✓ [9/10] Ping  meta.ping 响应正常  156ms
```

---

### Step 10: Echo（链路追踪）

向多个目标发送 `echo[nc]` 消息，等待回复并解析链路追踪信息。这是最复杂的一步。

#### 目标选择算法

从本地已知 AID 中选取最多 6 个测试目标：

```
分桶策略:
  ┌──────────────────┬──────────────────┐
  │ 本地密钥+同域     │ 本地密钥+异域     │
  ├──────────────────┼──────────────────┤
  │ 远程(无密钥)+同域 │ 远程(无密钥)+异域 │
  └──────────────────┴──────────────────┘

排序: 按消息活跃度（sessions/aun/ 下的 messages.jsonl 行数）
选取: Round-robin 从各桶轮流取，直到 6 个
```

#### Agent 元数据读取

对每个目标并行读取 `agent.md`：

```
  ✓ agentmd alice: Alice (human) sig=valid  89ms
  ○ agentmd bot1: no content  45ms
  ✗ agentmd remote1: timeout  8001ms
```

#### 消息发送与回复检测

```
操作流程:
  1. 连接并认证
  2. message.pull 获取基线 seq
  3. message.ack 确认基线
  4. message.send → to: target, payload: { type: 'text', text: 'echo[nc]' }
  5. 等待 1500ms
  6. message.pull(after_seq: baseline, limit: 10)
  7. 查找 from=target 且包含 [EvolClaw. 的回复
```

#### 目标标签格式

```
🔑👤 Alice     — 本地密钥 + 人类
🔑🤖 MyBot     — 本地密钥 + 机器人
🌐👤 Remote    — 远程(无本地密钥) + 人类
🌐🤖 ExtBot    — 远程(无本地密钥) + 机器人
```

#### 链路追踪解析

回复消息中包含时间戳格式的追踪信息：

```
格式: HH:MM:SS.mmm [node] key=value ...
```

解析后展示各节点间的时间差：

```
      ── trace ──
      [client]  alice→bob  
      [gateway] from=alice to=bob  +3ms
      [server]  aid=bob  +12ms
      [gateway] from=bob to=alice  +2ms
      [client]  self=alice  +4ms
      ── local-side total: 21ms (~ = cross-tz hop) ──
```

**时间差计算规则：**
- `+Nms` — 正常本地侧延迟（|delta| ≤ 60s）
- `~` — 跨时区跳跃（|delta| > 60s，不计入本地总延迟）

---

## 终端输出效果

### 正常通过

```
── alice.example.com ──

  ✓ [1/10] DNS (AID)  解析 alice.example.com → 1.2.3.4  8ms
  ✓ [2/10] Discovery  GET https://alice.example.com/.well-known/aun-gateway → wss://gw.example.com/ws  42ms
  ✓ [3/10] DNS (GW)   解析 gw.example.com → 5.6.7.8  5ms
  ✓ [4/10] TCP        连接 gw.example.com:443  18ms
  ✓ [5/10] TLS        gw.example.com:443 TLSv1.3 TLS_AES_256_GCM_SHA384 CN=*.example.com  25ms
  ✓ [6/10] WSS        WebSocket 连接成功 (wss://gw.example.com/ws)  51ms
  ✓ [7/10] Auth       alice.example.com 认证成功 (login1→login2→token)  312ms
  ✓ [8/10] Session    会话就绪
  ✓ [8/10] AgentMd    Alice (sig: valid)  89ms
  ✓ [9/10] Ping       meta.ping 响应正常  156ms
  [10/10] Echo  6 target(s)
  [10/10] Echo  reading agent.md for 6 target(s)...
    ✓ agentmd alice2: Alice2 (human) sig=valid  78ms
    ✓ agentmd bot1: MyBot (bot) sig=valid  92ms
    ○ agentmd remote1: no content  45ms

    ✓ 🔑👤 Alice2  alice2.example.com  234ms
      ── trace ──
      [client]  alice→alice2
      [gateway] from=alice to=alice2  +3ms
      [server]  aid=alice2  +8ms
      [gateway] from=alice2 to=alice  +2ms
      [client]  self=alice  +4ms
      ── local-side total: 17ms (~ = cross-tz hop) ──
    ✓ 🔑🤖 MyBot  bot1.example.com  189ms
    ✗ 🌐👤 Remote  remote1.other.com  no reply  1523ms

全部通过 (10)
```

### 中途失败

```
── alice.example.com ──

  ✓ [1/10] DNS (AID)  解析 alice.example.com → 1.2.3.4  8ms
  ✓ [2/10] Discovery  GET https://alice.example.com/.well-known/aun-gateway → wss://gw.example.com/ws  42ms
  ✓ [3/10] DNS (GW)   解析 gw.example.com → 5.6.7.8  5ms
  ✗ [4/10] TCP        连接 gw.example.com:443 失败: timeout (5000ms)

1 项检查失败, 3 项通过
```

---

## JSON 输出格式

使用 `--format json` 时输出：

```json
{
  "ok": true,
  "results": [
    {
      "aid": "alice.example.com",
      "checks": [
        {
          "step": "DNS (AID)",
          "index": 1,
          "ok": true,
          "detail": "解析 alice.example.com → 1.2.3.4",
          "ms": 8
        },
        {
          "step": "Discovery",
          "index": 2,
          "ok": true,
          "detail": "GET https://alice.example.com/.well-known/aun-gateway → wss://gw.example.com/ws",
          "ms": 42
        }
      ]
    }
  ]
}
```

---

## 默认 AID 选择逻辑

未指定 `<aid>` 参数时，自动选取本地 AID：

```
优先级:
  1. 有私钥 + 有 agent.md（活跃使用中）→ 取最多 2 个
  2. 有私钥 + 无 agent.md → 补充
  3. 无私钥（远程 AID）→ 取 1 个

同优先级内随机打乱，避免每次检测同一个。
```

---

## 国际化 (i18n)

自动检测系统语言环境，支持中文和英文：

```
检测顺序: LANG → LC_ALL → LANGUAGE → Intl.DateTimeFormat().resolvedOptions().locale
判断: 以 "zh" 开头则使用中文，否则英文
```

---

## 超时配置

| 操作 | 默认超时 |
|------|----------|
| HTTP GET (Discovery) | 8000ms |
| DNS 解析 | 系统默认 |
| TCP 连接 | 5000ms |
| TLS 握手 | 5000ms |
| WebSocket 升级 | 8000ms |
| Echo 等待回复 | 1500ms |

---

## 依赖关系

```
Node.js 内置:
  fs, path, os          文件/路径操作
  net, tls, dns/promises 网络底层操作
  https                  HTTP 请求

外部包:
  ws                     WebSocket 客户端
  @agentunion/fastaun    AUN SDK

内部模块:
  ../paths.js            路径解析 (aunPath, resolvePaths)
  ../aun/aid/client.js   AUN 客户端工厂 (createAunClient)
  ../aun/aid/index.js    AID 工具 (aidList, agentmdGet)
  ./help.js              帮助标志检测 (isHelpFlag)
```

---

## 实现细节

### SDK 输出抑制

检测过程中 AUN SDK 会输出 `[aun_core` 前缀的日志，通过拦截 `process.stdout.write` / `process.stderr.write` 过滤这些输出，保持终端输出整洁。

### AID 文件名编码

会话目录中的 AID 使用 URL 风格编码：

```
特殊字符 → %HH（十六进制）
编码字符: / % \ : * ? " < > |
```

### 错误处理策略

- Step 1-7: 任何一步失败立即终止，返回已收集的结果
- Step 8 (AgentMd): 失败不终止，继续后续步骤
- Step 9 (Ping): 失败不终止
- Step 10 (Echo): 部分目标失败不影响整体，只要有一个目标回复即视为通过

### 源码位置

`src/cli/net-check.ts` — 671 行，单文件实现全部逻辑。

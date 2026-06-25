# Menu 协议实现 agent.md 签名机制 — 可行性分析

**撰写时间**: 2026-06-25  
**分析范围**: 在 AUN Menu Protocol 上实现类似 agent.md 的签名/验签机制

---

## 一、背景

### 1.1 现有 agent.md 签名机制

**架构**：基于 AUN 四级 X.509 证书链 + ECDSA 数字签名

```
Root CA → Registry CA → Issuer CA → Agent Cert (私钥) → 签名 agent.md
```

**签名流程**：
1. 本地编辑 agent.md（纯文本）
2. `agentmdPut()` → `store.uploadAgentMd(aid, content)`
3. SDK 自动：
   - 加载私钥和证书
   - ECDSA 签名 payload
   - 追加签名块（cert_fingerprint + timestamp + signature）
   - 向 Gateway 上传

**验签流程**：
1. `store.downloadAgentMd(aid)` 从 Gateway 拉取
2. SDK 自动：
   - 从 PKI 获取对端证书
   - 验证证书链（Agent → Issuer → Registry → Root）
   - 用公钥验证 ECDSA 签名
   - 返回 `{ status: 'verified' | 'invalid' | 'unsigned', reason? }`

**关键特性**：
- **透明性**：应用层只调用 `uploadAgentMd` / `downloadAgentMd`，签名/验签由 SDK 全自动
- **信任链**：基于 PKI 根证书的分布式信任模型
- **持久化**：agent.md 存储在 Gateway（`auth.uploadAgentMd` RPC），全网可访问

---

### 1.2 Menu 协议现状

**定位**：客户端与 Agent 之间的**轻量配置协议**，走 AUN `message.send` 通道

**6 种消息类型**：

| Type | 方向 | 用途 |
|---|---|---|
| `menu.list` | Client → Agent | 拉取菜单树（按角色裁剪） |
| `menu.query` | Client → Agent | 查询配置当前值 |
| `menu.options` | Client → Agent | 列举配置可选值 |
| `menu.update` | Client → Agent | 修改配置 |
| `menu.action` | Client → Agent | 触发动词操作（restart / new / delete...） |
| `menu.response` | Agent → Client | 统一响应（data 或 error） |

**处理流程**：
```typescript
// src/core/message/message-bridge.ts
handleCustomPayload() {
  JSON.parse(content) → 识别 type
  ↓
  switch (parsed.type) {
    case 'menu.list':   handleMenuList()
    case 'menu.query':  handleMenuQuery()
    case 'menu.update': handleMenuUpdate()
    case 'menu.action': handleMenuAction()
    ...
  }
  ↓
  sendMenuResponse({ type: 'menu.response', id, data/error })
}
```

**核心特征**：
- **会话内协议**：消息与文本消息共享同一 AUN 通道（`message.send`）
- **无持久化**：Agent 侧实时计算响应，不涉及文件存储
- **无身份验证**：依赖 AUN 传输层的身份认证（对端 AID 已验证）
- **无签名机制**：响应内容未签名，接收方无法离线验证完整性

---

## 二、实现方案设计

### 2.1 目标明确

**需求**：在 Menu 协议上实现签名机制，使得：
1. Agent 发出的 `menu.response` 携带数字签名
2. Client 收到响应后可验证签名（防篡改 + 确认来源）
3. 支持离线验签（Client 缓存 Agent 证书后无需联网）

**非目标**：
- ❌ 不实现双向签名（Client → Agent 请求不签名，已由 AUN 传输层保证）
- ❌ 不持久化 menu 数据到 Gateway（仍是会话内协议）
- ❌ 不改变现有 menu 协议的 6 种消息类型

---

### 2.2 方案 A：在 `menu.response` 中追加签名字段（推荐）

#### 设计

扩展 `MenuResponse` 接口：

```typescript
interface MenuResponse {
  type: 'menu.response';
  id: string;
  name?: string;
  data?: any;
  error?: { code: string; message: string };
  
  // 新增签名字段
  signature?: {
    cert_fingerprint: string;  // Agent 证书指纹（SHA-256）
    timestamp: number;         // 签名时间戳（Unix ms）
    signature: string;         // Base64 编码的 ECDSA 签名
  };
}
```

**签名 payload 构造**：
```typescript
// 签名内容 = 去掉 signature 字段后的 Canonical JSON
const payload = {
  type: req.type,
  id: req.id,
  name: req.name,
  data: responseData,
  // error: ... (如果有)
};
const canonicalJson = stableStringify(payload);  // SDK 提供的 Canonical JSON 序列化
const signResult = aidObj.sign(Buffer.from(canonicalJson, 'utf-8'));
```

#### 实现步骤

**Agent 侧（签名发送）**：

```typescript
// src/core/message/message-bridge.ts
private async sendMenuResponse(
  adapter: ChannelAdapter | undefined,
  channel: string,
  channelId: string,
  response: MenuResponse,
  sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
): Promise<void> {
  // 1. 获取当前 Agent 的 AID（从 channel 反查 owning agent）
  const owningAgent = this.agentRegistry?.resolveByChannel(channel);
  if (!owningAgent?.aid) {
    // 无 AID（非 AUN 通道 / 测试场景）→ 不签名
    return this.sendMenuResponseRaw(adapter, channelId, response, sendReply);
  }

  // 2. 加载 AID 值对象
  const { getAidStore, loadAid, SLOT } = await import('../../aun/aid/store.js');
  const store = await getAidStore({ slotId: SLOT.cli });
  let aidObj;
  try {
    aidObj = loadAid(store, owningAgent.aid);
  } catch (e) {
    logger.warn(`[MenuResponse] Failed to load AID for signing: ${e}`);
    return this.sendMenuResponseRaw(adapter, channelId, response, sendReply);
  }

  // 3. 构造待签名 payload（去掉 signature 字段）
  const { signature, ...payload } = response;
  const canonicalJson = stableStringify(payload);
  
  // 4. 签名
  const signResult = aidObj.sign(Buffer.from(canonicalJson, 'utf-8'));
  if (!signResult.ok) {
    logger.warn(`[MenuResponse] Sign failed: ${signResult.error.message}`);
    return this.sendMenuResponseRaw(adapter, channelId, response, sendReply);
  }

  // 5. 追加签名字段
  const signedResponse: MenuResponse = {
    ...response,
    signature: {
      cert_fingerprint: aidObj.certFingerprint,
      timestamp: Date.now(),
      signature: signResult.data.signature,
    },
  };

  // 6. 发送
  return this.sendMenuResponseRaw(adapter, channelId, signedResponse, sendReply);
}

private async sendMenuResponseRaw(
  adapter: ChannelAdapter | undefined,
  channelId: string,
  response: MenuResponse,
  sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
): Promise<void> {
  const payload = JSON.stringify(response);
  if (adapter?.sendCustomPayload) {
    adapter.sendCustomPayload(channelId, payload);
  } else {
    await sendReply(channelId, payload);
  }
}
```

**Client 侧（验签）**：

```typescript
// 客户端伪代码（Evol App / CLI / Web）
async function verifyMenuResponse(response: MenuResponse, agentAid: string): Promise<VerifyResult> {
  if (!response.signature) {
    return { status: 'unsigned' };
  }

  // 1. 获取 Agent 证书（本地缓存 or 从 PKI 拉取）
  const certPem = await fetchAgentCert(agentAid);  // 调用 SDK 或 HTTP GET https://{aid}/cert.pem
  
  // 2. 构造待验签 payload
  const { signature, ...payload } = response;
  const canonicalJson = stableStringify(payload);
  
  // 3. 验签（使用 SDK 或 Web Crypto API）
  const valid = await verifySig(
    Buffer.from(canonicalJson, 'utf-8'),
    signature.signature,
    certPem
  );
  
  if (!valid) {
    return { status: 'invalid', reason: 'signature mismatch' };
  }
  
  // 4. 验证证书链（可选，依赖 SDK 或手动实现）
  const certValid = await verifyCertChain(certPem, rootCaPem);
  if (!certValid) {
    return { status: 'invalid', reason: 'certificate chain invalid' };
  }
  
  return { status: 'verified' };
}
```

---

### 2.3 方案 B：引入新消息类型 `menu.signed_response`（不推荐）

**设计**：
```typescript
interface MenuSignedResponse {
  type: 'menu.signed_response';
  id: string;
  payload: string;  // 原 menu.response 的 JSON 字符串
  signature: {
    cert_fingerprint: string;
    timestamp: number;
    signature: string;
  };
}
```

**缺点**：
- 破坏协议兼容性（旧客户端无法识别）
- 需要嵌套序列化（payload 是 JSON 字符串）
- 复杂度高，无实质优势

---

## 三、可行性评估

### 3.1 技术可行性：✅ **高**

| 维度 | 评估 | 说明 |
|---|---|---|
| **签名能力** | ✅ 完全具备 | `AID.sign()` 已实现，直接调用 |
| **证书基础设施** | ✅ 完备 | 复用现有 PKI（agent.md 同套系统） |
| **SDK 支持** | ✅ 充分 | `@agentunion/fastaun` 提供 `loadAid()` / `sign()` / `verify()` |
| **传输能力** | ✅ 无障碍 | JSON payload 增加签名字段，兼容现有 AUN 消息通道 |
| **客户端实现** | ✅ 可实现 | Web Crypto API / Node crypto 均可验签 ECDSA |

---

### 3.2 实现难度：⭐⭐⭐ **中等**

#### Agent 侧（Channel 层）

**改动点**：
1. `message-bridge.ts` 的 `sendMenuResponse()` 增加签名逻辑（~50 行）
2. 引入 `stableStringify()` 从 SDK（或自行实现 Canonical JSON）
3. 错误处理：签名失败时降级为不签名（保证可用性）

**预估工作量**：2-3 小时（含测试）

#### Client 侧（Evol App / CLI / Web）

**改动点**：
1. 接收 `menu.response` 后检查 `signature` 字段
2. 实现 `verifyMenuResponse()` 函数：
   - 获取 Agent 证书（本地缓存 + PKI fallback）
   - Canonical JSON 序列化
   - ECDSA 验签
   - 可选：证书链验证
3. UI 显示验签状态（✓ 已验证 / ⚠ 未签名 / ✗ 签名无效）

**预估工作量**：
- Evol App（React Native）：4-6 小时（需集成 crypto 库，如 `expo-crypto`）
- CLI（Node.js）：2-3 小时（直接用 `@agentunion/fastaun`）
- Web（Browser）：3-4 小时（用 Web Crypto API）

---

### 3.3 性能影响：⚠️ **微小但需关注**

| 操作 | 开销 | 影响 |
|---|---|---|
| **Agent 签名** | ~1-3ms（ECDSA P-256） | 每个 menu.response 增加 1-3ms 延迟 |
| **Client 验签** | ~2-5ms | 可异步执行，不阻塞 UI |
| **证书拉取** | ~50-200ms（首次，网络） | 可本地缓存 30 天，后续无开销 |
| **Payload 增大** | +150-200 字节 | 签名字段（Base64 编码的 ECDSA 签名 ~88 字节 + 元数据） |

**结**：对用户体验几乎无感知（menu 交互本身非高频操作）。

---

## 四、潜在隐患与风险

### 4.1 证书链信任问题

**风险**：Client 如何获取并信任 Root CA 证书？

**缓解方案**：
1. **内置 Root CA**：在 App / CLI 发布包中硬编码 AUN Root CA（与 TLS 证书固定类似）
2. **首次信任**：首次连接时从 Agent 下载 Root CA，用户手动确认（类似 SSH `known_hosts`）
3. **托管信任**：使用操作系统的证书存储（如 macOS Keychain）

**推荐**：方案 1（内置 Root CA），简单且安全。

---

### 4.2 证书过期与吊销

**风险**：Agent 证书过期或被吊销后，签名仍然有效吗？

**影响**：
- **过期证书**：验签时检查 `certNotAfter`，过期则拒绝
- **证书吊销**：AUN 协议目前无 CRL/OCSP，无法检测吊销状态

**缓解方案**：
1. **短期 TTL**：Agent 证书有效期设为 90 天，强制定期续期
2. **在线检查**：验签时可选联网查询证书状态（`auth.checkAid`）
3. **降级处理**：吊销检测失败时，显示警告但不阻止使用

**现状**：agent.md 签名机制也面临同样问题，暂无完美解决方案。

---

### 4.3 重放攻击

**风险**：攻击者截获已签名的 `menu.response`，在其他会话中重放。

**缓解方案**：
1. **请求 ID 绑定**：签名 payload 包含 `req.id`，Client 验证 `response.id === request.id`
2. **时间戳检查**：Client 验证 `signature.timestamp` 在合理范围内（如 ±5 分钟）
3. **会话绑定**（可选）：签名 payload 包含 `channelId` 或 `sessionId`

**推荐**：实现方案 1 + 2（已在设计中包含 `id` 和 `timestamp`）。

---

### 4.4 向后兼容性

**风险**：旧版 Client 无法识别 `signature` 字段。

**影响**：无破坏性影响，旧 Client 会忽略 `signature` 字段，功能正常。

**新旧混用场景**：
- 新 Agent + 旧 Client：正常工作（旧 Client 忽略签名）
- 旧 Agent + 新 Client：新 Client 看到 `unsigned` 状态，显示警告但不阻止使用

---

### 4.5 性能退化风险

**风险**：高频 menu 操作时签名开销累积。

**缓解方案**：
1. **批量签名**：如果未来支持批量 menu 操作，可签名一个数组而非逐个签名
2. **签名缓存**：对相同 payload 缓存签名结果（需注意 `timestamp` 变化）
3. **可配置**：提供配置项关闭签名（性能敏感场景）

**现状**：menu 操作频率低（秒级），无需优化。

---

### 4.6 密钥泄露风险

**风险**：Agent 私钥泄露后，攻击者可伪造签名。

**影响**：与 agent.md 签名机制风险相同，私钥泄露 = 完全控制该 AID。

**缓解方案**：
1. **密钥轮换**：定期调用 `auth.rekey` 更新私钥（SDK 已支持）
2. **硬件安全模块**（HSM）：生产环境将私钥存储在 HSM 中（需 SDK 扩展）
3. **异常检测**：监控签名行为异常（如短时间大量签名操作）

---

## 五、对比：Menu 签名 vs agent.md 签名

| 维度 | agent.md 签名 | Menu 签名 |
|---|---|---|
| **签名对象** | 静态文档（agent.md 文件） | 动态响应（menu.response JSON） |
| **持久化** | Gateway 存储 + 本地缓存 | 无持久化（会话内传输） |
| **验签时机** | 下载时（或离线验签本地缓存） | 收到响应时（实时） |
| **信任模型** | PKI 证书链 | 相同（复用 PKI） |
| **签名格式** | HTML 注释块（尾部追加） | JSON 字段（`signature` 字段） |
| **SDK 支持** | 完全自动化（`uploadAgentMd` / `downloadAgentMd`） | 需手动实现签名/验签逻辑 |
| **应用场景** | 全网公开身份声明 | 点对点配置协商 |

---

## 六、推荐方案与路线图

### 6.1 推荐方案

**方案 A**（在 `menu.response` 中追加 `signature` 字段）+ 以下增强：

1. **Agent 侧**：
   - 在 `sendMenuResponse()` 中自动签名（可配置关闭）
   - 签名失败时降级为不签名 + 日志警告
   - 仅对 AUN 通道签名（Feishu / WeChat 等无 AID，跳过）

2. **Client 侧**：
   - 实现 `verifyMenuResponse()` 函数
   - UI 显示验签状态（可选，不阻塞功能）
   - 证书缓存 30 天（与 agent.md 一致）

3. **协议兼容**：
   - `signature` 字段为可选（向后兼容）
   - 旧客户端忽略签名，新客户端优先验签

---

### 6.2 实现路线图

#### Phase 1：Agent 侧签名（1 周）

- [ ] `message-bridge.ts` 实现 `sendMenuResponse()` 签名逻辑
- [ ] 单元测试：签名正确性、失败降级
- [ ] 集成测试：AUN 通道发送已签名响应

#### Phase 2：CLI 验签（1 周）

- [ ] `evolclaw` CLI 实现 `verifyMenuResponse()`
- [ ] 命令行显示验签状态
- [ ] 证书缓存与 TTL 管理

#### Phase 3：Evol App 验签（2 周）

- [ ] React Native 集成 crypto 库
- [ ] UI 组件：验签状态指示器
- [ ] 用户教育：什么是签名验证？

#### Phase 4：Web 验签（1 周）

- [ ] Web Crypto API 封装
- [ ] 浏览器证书缓存（localStorage）

---

## 七、总结

### 可行性：✅ **完全可行**

- 技术栈完备（PKI + ECDSA + SDK 支持）
- 实现路径清晰（扩展 JSON 字段 + 复用现有签名基础设施）
- 向后兼容（签名字段可选）

### 难度：⭐⭐⭐ **中等**

- Agent 侧：简单（~50 行代码）
- Client 侧：中等（需集成 crypto 库 + UI）

### 隐患与缓解：

| 隐患 | 风险等级 | 缓解方案 |
|---|:---:|---|
| 证书信任问题 | 🟡 中 | 内置 Root CA |
| 证书过期/吊销 | 🟡 中 | 短期 TTL + 在线检查 |
| 重放攻击 | 🟢 低 | 请求 ID 绑定 + 时间戳检查 |
| 向后兼容 | 🟢 低 | 签名字段可选 |
| 性能退化 | 🟢 低 | menu 操作频率低，无影响 |
| 密钥泄露 | 🔴 高 | 定期密钥轮换（与 agent.md 风险相同） |

### 推荐行动：

1. **立即开始**：实现 Agent 侧签名（高优先级，低风险）
2. **逐步推广**：先 CLI，再 App，最后 Web（分阶段验证）
3. **用户教育**：文档说明签名验证的意义（防篡改 + 确认来源）

---

**最终结论**：在 Menu 协议上实现签名机制是**完全可行且值得做的**。它提升了协议的安全性（防篡改 + 来源验证），实现难度中等，无重大技术障碍，建议优先实现 Agent 侧签名，然后逐步覆盖各客户端。

# Menu 协议签名机制 — 基于 AUN 传输层分析

**撰写时间**: 2026-06-25  
**更新**: 基于 AUN `message.send` 现有签名机制的分析

---

## 重要发现：AUN 传输层已内置签名机制

经过代码审查，发现 **AUN 协议在传输层已经提供了完整的消息签名验证机制**，menu 协议无需在应用层重复实现。

---

## 一、AUN 传输层签名机制

### 1.1 E2EE V2 架构

AUN SDK (`@agentunion/fastaun`) 的 E2EE V2 提供：

**加密消息结构**（`Message` 接口）：
```typescript
interface Message extends JsonObject {
  message_id?: string;
  seq?: number;
  from?: string;           // 发送方 AID
  to?: string;             // 接收方 AID
  type?: string;
  payload?: JsonValue;     // 解密后的明文 payload
  encrypted?: boolean;     // 是否加密
  timestamp?: number;
  e2ee?: JsonObject;       // E2EE 元数据（envelope 信息）
  group_id?: string;
  sender_aid?: string;
  direction?: string;
}
```

**V2 加密流程**（`v2/e2ee/encrypt-p2p.ts`）：
```
1. 构造 AAD 并加密 payload
2. 生成 sender_session keypair
3. 计算 wrap_salt
4. 为每个 target wrap master_key
5. 排序 recipients + 计算 digest
6. **计算 sender_signature**        ← 关键：自动签名
7. 计算 sender_cert_fingerprint
8. 组装 envelope
```

**V2 解密流程**（`v2/e2ee/decrypt.ts`）：
```
1. **验 sender_signature**          ← 关键：自动验签
2. 找自己的 row（recipients 数组）
3. 计算 wrap_salt
4. 派生 wrap_key（3DH 或 1DH）
5. 解 master_key
6. 解 body
7. 解析 JSON payload
```

### 1.2 签名透明化

**关键特性**：
- **自动签名**：调用 `client.message.send()` 时，SDK 自动对 envelope 签名（使用发送方私钥）
- **自动验签**：`message.received` 事件触发时，SDK 已完成验签（失败则不触发事件）
- **传输层保证**：应用层收到的消息已经过签名验证，无需手动检查

**protected_headers 机制**：
```typescript
// 发送时可附加自定义 protected_headers（会包含在签名 payload 中）
await client.message.send({
  to: 'peer.agentid.pub',
  payload: { type: 'menu.response', id: '123', data: {...} },
  protected_headers: {
    'x-request-id': '123',
    'x-timestamp': Date.now().toString(),
  }
});
```

### 1.3 client_signature 字段

**群组操作的额外签名**：
```typescript
// 对于关键群组操作（建群、加人、踢人等），SDK 附加 client_signature 字段
// 签名覆盖所有非 _ 前缀且非 client_signature 的业务字段
private _signClientOperation(params: RpcParams): void {
  const payload = { ...params };
  delete payload.client_signature;
  const canonicalJson = stableStringify(payload);
  const signature = this._currentAid.sign(Buffer.from(canonicalJson, 'utf-8'));
  params.client_signature = {
    cert_fingerprint: this._currentAid.certFingerprint,
    timestamp: Date.now(),
    signature: signature.data.signature,
  };
}
```

**应用层验证**：
```typescript
// SDK 提供 _verifyEventSignatureAsync() 方法验证群事件签名
// 验证失败时触发 'signature_pending' 事件
private async _verifyEventSignatureAsync(event: JsonObject): Promise<boolean> {
  // 1. 提取 client_signature
  // 2. 获取发送方证书（缓存 + PKI fallback）
  // 3. 验证签名
  // 4. 返回 true/false
}
```

---

## 二、Menu 协议当前实现分析

### 2.1 消息传输路径

**发送 menu.response**：
```typescript
// src/core/message/message-bridge.ts
private async sendMenuResponse(...) {
  const payload = JSON.stringify(response);
  if (adapter?.sendCustomPayload) {
    adapter.sendCustomPayload(channelId, payload);  // ← 调用 AUN adapter
  } else {
    await sendReply(channelId, payload);
  }
}

// src/channels/aun.ts (AUNChannel)
sendCustomPayload(channelId: string, payload: string): void {
  const payloadObj = JSON.parse(payload);
  await this.client.message.send({           // ← SDK 自动签名
    to: channelId,
    payload: payloadObj,
  });
}
```

**接收 menu.request**：
```typescript
// src/channels/aun.ts
client.on('message.received', (data: unknown) => {  // ← SDK 已验签
  this.handleIncomingPrivateMessage(data);
});

private async handleIncomingPrivateMessage(data: unknown): Promise<void> {
  const msg = data as Record<string, any>;
  const payload = msg.payload ?? '';  // ← 已解密、已验签的 payload
  
  // 传递给 message-bridge
  this.messageHandler?.({
    channel: this.channelName,
    channelId: fromAid,
    content: text,
    // ...
  });
}
```

### 2.2 当前状态

**✅ Menu 协议已享受传输层签名保护**：
- 所有通过 AUN 发送的消息（包括 menu 协议）都被 SDK 自动签名
- 接收方 SDK 自动验签，验证失败的消息不会触发 `message.received` 事件
- 应用层无需额外实现签名/验签逻辑

---

## 三、对比：传输层签名 vs 应用层签名

| 维度 | AUN 传输层签名（现状） | 应用层签名（原方案 A） |
|---|---|---|
| **签名范围** | 整个 envelope（含 payload） | 仅 menu.response 内容 |
| **签名位置** | E2EE envelope（SDK 内部） | JSON 字段（应用层可见） |
| **实现方式** | SDK 自动化（透明） | 手动实现（显式） |
| **验签时机** | 消息到达时（SDK 层） | 应用逻辑处理时 |
| **信任模型** | PKI 证书链（与 agent.md 相同） | 同左 |
| **兼容性** | 所有 AUN 消息统一 | 需扩展 menu.response 结构 |
| **性能开销** | 已存在（所有消息） | 额外开销（双重签名） |
| **可见性** | 应用层不可见（黑盒） | 应用层可见（白盒） |
| **离线验签** | 不支持（需 SDK） | 支持（Client 持有证书） |

---

## 四、重新评估：是否需要应用层签名？

### 4.1 传输层签名已提供的保障

✅ **来源验证**：`msg.from` 保证是持有该 AID 私钥的实体发送  
✅ **完整性保证**：payload 未被篡改（签名覆盖整个 envelope）  
✅ **重放保护**：seq 序列号 + timestamp 防重放  
✅ **证书验证**：SDK 自动验证证书链（Root CA → Issuer CA → Agent）

### 4.2 传输层签名的局限

❌ **不可见性**：应用层无法访问签名元数据（cert_fingerprint / timestamp / signature）  
❌ **无法离线验签**：Client 必须依赖 SDK，无法独立验证已缓存的消息  
❌ **不可审计**：无法将签名信息持久化到本地日志供事后审计  
❌ **无法透传**：无法将签名信息传递给前端 UI 显示验证状态

### 4.3 应用层签名的额外价值

**场景 1：前端 UI 显示验证状态**
- 用户希望在 Evol App 中看到"✓ 已验证来自 agent.agentid.pub"
- 需要应用层暴露签名元数据（cert_fingerprint、timestamp）

**场景 2：审计日志**
- 企业合规要求保留所有配置变更的签名记录
- 需要将签名信息持久化到本地 JSON/SQLite

**场景 3：离线验签**
- Client 缓存了 menu.response，稍后离线验证
- 需要签名信息与消息内容一起存储

**场景 4：跨协议互操作**
- 将 menu.response 通过非 AUN 通道传输（如 HTTP API、WebSocket）
- 需要应用层签名独立于传输层

---

## 五、推荐方案修订

### 方案 B（推荐）：**暴露传输层签名元数据**

**设计思路**：不重复签名，而是将 SDK 已完成的签名信息暴露到应用层。

#### 实现方案

**1. SDK 层暴露签名元数据**（需 SDK 支持，或在 EvolClaw 侧提取）

```typescript
// 理想情况：SDK 在 message.received 事件中暴露签名信息
client.on('message.received', (data: unknown) => {
  const msg = data as Record<string, any>;
  const signatureInfo = msg._signature || msg.e2ee?.signature;  // SDK 暴露的签名元数据
  
  // signatureInfo 可能包含：
  // {
  //   cert_fingerprint: "sha256:abc...",
  //   timestamp: 1719234567890,
  //   verified: true,
  //   sender_aid: "peer.agentid.pub"
  // }
});
```

**2. EvolClaw 侧传递签名元数据**

```typescript
// src/channels/aun.ts
private async handleIncomingPrivateMessage(data: unknown): Promise<void> {
  const msg = data as Record<string, any>;
  const payload = msg.payload ?? '';
  
  // 提取签名元数据（如果 SDK 提供）
  const signatureMetadata = this.extractSignatureMetadata(msg);
  
  // 传递给 message-bridge
  this.messageHandler?.({
    channel: this.channelName,
    channelId: fromAid,
    content: text,
    metadata: {
      signature: signatureMetadata,  // ← 传递签名信息
    },
  });
}

private extractSignatureMetadata(msg: Record<string, any>): SignatureMetadata | undefined {
  // 从 SDK 消息中提取签名元数据
  const env = msg.envelope || {};
  const e2ee = msg.e2ee || {};
  
  // SDK 可能在不同位置存储签名信息，需要根据实际 SDK 版本调整
  return {
    cert_fingerprint: env.sender_cert_fingerprint || e2ee.sender_cert_fingerprint,
    timestamp: msg.timestamp,
    verified: true,  // 能到达这里说明已验签通过
    sender_aid: env.from,
  };
}
```

**3. Menu 协议响应时附加签名元数据**

```typescript
// src/core/message/message-bridge.ts
private async sendMenuResponse(..., signatureMetadata?: SignatureMetadata) {
  const response: MenuResponse = {
    type: 'menu.response',
    id,
    data,
    // 附加签名元数据（可选，不影响兼容性）
    _signature: signatureMetadata ? {
      cert_fingerprint: signatureMetadata.cert_fingerprint,
      timestamp: signatureMetadata.timestamp,
      verified: true,
    } : undefined,
  };
  
  const payload = JSON.stringify(response);
  // ... 发送
}
```

**4. Client 侧显示验证状态**

```typescript
// Evol App / CLI 客户端
function renderMenuResponse(response: MenuResponse) {
  const signatureStatus = response._signature 
    ? `✓ 已验证 (${response._signature.cert_fingerprint.slice(0, 12)}...)`
    : '⚠ 未验证';
  
  return (
    <div>
      <div>{response.data}</div>
      <div className="signature-badge">{signatureStatus}</div>
    </div>
  );
}
```

---

### 方案 C（次选）：**应用层双重签名**（仅在特殊场景）

**适用场景**：
- 需要跨协议传输（非 AUN 通道，如 HTTP API）
- 需要独立于传输层的审计日志
- 需要前端独立验签（不依赖 AUN SDK）

**实现**：参考原可行性分析文档的方案 A，在 `menu.response` 中添加 `signature` 字段。

**权衡**：
- ✅ 完全独立于传输层
- ✅ 支持离线验签
- ❌ 双重签名开销（每个消息 +3-5ms）
- ❌ 需要维护应用层签名逻辑

---

## 六、实施建议

### 阶段 1：验证 SDK 签名元数据可用性（1 天）

**目标**：确认 AUN SDK 是否暴露签名元数据

**行动**：
1. 阅读 `@agentunion/fastaun` 源码或文档
2. 在 `message.received` 事件中打印完整 `data` 对象
3. 查找 `_signature` / `e2ee.signature` / `envelope.sender_cert_fingerprint` 等字段
4. 咨询 AUN SDK 维护者（如果文档不清晰）

**决策点**：
- ✅ **SDK 已暴露签名元数据** → 采用方案 B（暴露传输层签名）
- ❌ **SDK 未暴露签名元数据** → 选择：
  - 向 SDK 提 PR 暴露签名元数据（推荐）
  - 或采用方案 C（应用层双重签名）

---

### 阶段 2：实现方案 B — 暴露签名元数据（1 周）

**Agent 侧**：
- [ ] `aun.ts` 实现 `extractSignatureMetadata()`
- [ ] `message-bridge.ts` 传递签名元数据到 `sendMenuResponse()`
- [ ] 单元测试：验证签名元数据正确提取

**Client 侧**：
- [ ] CLI：解析 `_signature` 字段并显示
- [ ] Evol App：UI 组件显示验证状态
- [ ] Web：签名状态徽章

---

### 阶段 3（可选）：实现方案 C — 应用层签名（2 周）

**仅在以下情况实施**：
- SDK 拒绝暴露签名元数据
- 需要跨协议传输 menu.response
- 需要独立于 SDK 的审计日志

**实施细节**：参考原可行性分析文档。

---

## 七、结论

### 核心发现

**AUN 传输层已提供完整的消息签名机制**，menu 协议已享受这一保护。应用层签名的主要价值在于：
1. **可见性**：向用户/审计日志暴露签名信息
2. **可移植性**：支持跨协议传输
3. **独立验证**：Client 可离线验签

### 推荐行动

1. **优先方案 B**（暴露传输层签名元数据）
   - 最小化重复工作
   - 复用 SDK 已有的签名能力
   - 提供应用层可见性

2. **备选方案 C**（应用层双重签名）
   - 仅在方案 B 技术上不可行时使用
   - 适用于特殊场景（跨协议、独立审计）

3. **不推荐方案 A**（原可行性分析的纯应用层签名）
   - 忽视了传输层已有的签名机制
   - 造成双重签名的冗余开销

---

## 八、与 agent.md 签名的对比

| 维度 | agent.md 签名 | AUN message.send 签名 | Menu 协议签名（方案 B） |
|---|---|---|---|
| **签名对象** | 静态文档（agent.md） | 动态消息（envelope） | 动态响应（menu.response） |
| **签名位置** | HTML 注释块（文件末尾） | E2EE envelope（传输层） | JSON 字段（应用层） |
| **签名触发** | 显式调用 `uploadAgentMd()` | 隐式（每次 `message.send()`） | 透传传输层签名 |
| **验签时机** | 下载时 | 消息到达时 | 应用处理时 |
| **应用层可见** | ✅ 可直接读取签名块 | ❌ SDK 内部黑盒 | ✅ 暴露签名元数据 |
| **持久化** | Gateway 存储 | 不持久化（会话内） | 可选（审计日志） |

**关键差异**：
- agent.md 是**静态资源**，签名是文件内容的一部分（可离线验签）
- menu.response 是**动态消息**，签名由传输层提供（应用层可透传元数据）

---

**最终建议**：优先实施方案 B，验证 SDK 签名元数据可用性后，将其暴露到应用层供 UI/审计使用。如果 SDK 不支持，再考虑方案 C（应用层双重签名）。

# 实现计划：AUN 绑定凭证消息

关联 spec：`2026-06-02-aun-binding-credential-design.md`

## 关键技术澄清（写代码前必读）

**触发点只有一处**：设计文档说"两处调用点"，但 `channel:owner-bound` 事件 handler（aun.ts:1709）调用的就是 `sendWelcomeMessage()`，两条路径最终都进同一个函数。因此 `sendBindingCredential(owner)` 只需在 `sendWelcomeMessage()` 里调用一次，即可覆盖所有三个场景（首次连接已配 owner / 首条消息 auto-bind / owner 变更）。

**`initialized` 不挡绑定变更**：owner 变更时 `initialized` 已为 true，会走 sendWelcomeMessage 的早退分支。需要在早退之前先读新 owner，只要 owner 变了就发凭证。详见 Step 1 的实现要点。

---

## Step 1：aun.ts — 添加 `sendBindingCredential` 并在 `sendWelcomeMessage` 中调用

**文件**：`src/channels/aun.ts`

### 1a. 新增方法（放在 `sendWelcomeMessage` 之后）

```typescript
private async sendBindingCredential(owner: string, agentDisplayName: string, baseagent: string): Promise<void> {
  if (!this.client) return;
  await this.callAndTrace('message.send', {
    to: owner,
    payload: {
      type: 'binding',
      aid: this.config.aid,
      name: agentDisplayName,
      owner,
      baseagent,
    },
    encrypt: true,
    persist_required: true,
  });
  logger.info(`${this.logPrefix()} Binding credential sent to owner: ${owner}`);
}
```

错误处理：调用方用 `.catch` 吞掉（与欢迎消息的 `try/catch` 风格一致），不阻塞连接流程。

### 1b. 修改 `sendWelcomeMessage`（aun.ts:765）

当前逻辑：先检查 `initialized`，true 则直接 return。

需要在这个早退之前处理"owner 变更时重发凭证"，同时在首次初始化时也发凭证。改动点：

1. **`initialized === true` 的早退处**（aun.ts:778）：在 return 前读 owner，与上次已知 owner 对比，若变化则调 `sendBindingCredential`。因为当前没有"上次 owner"字段，最简单的方案是不做对比——已初始化时直接发一次凭证，凭证是幂等的，App 端 upsert 无副作用。修改为：

   ```typescript
   if (agentConfig.initialized === true) {
     // owner 变更场景：initialized 已设，仍需重发凭证（幂等）
     const owner = agentConfig.owners?.[0] ?? this.config.owner;
     if (owner && this.client) {
       const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
       const baseagent = agentConfig.active_baseagent || 'claude';
       const aidLabel = aidName.split('.')[0];
       // 复用简化的 name 推导（不需要 fetchPeerInfo，凭证不要求 owner 名字）
       const agentMdLocalPath = agentMdPathFn(aidName);
       const existingAgentMd = fs.existsSync(agentMdLocalPath) ? fs.readFileSync(agentMdLocalPath, 'utf-8') : '';
       const nameMatch = existingAgentMd.match(/^name:\s*"?([^"\n]+)/m);
       const agentDisplayName = nameMatch?.[1]?.trim().replace(/"$/, '') || aidLabel;
       this.sendBindingCredential(owner, agentDisplayName, baseagent).catch(e =>
         logger.warn(`${this.logPrefix()} Binding credential (initialized path) failed: ${e}`)
       );
     }
     logger.info(`${this.logPrefix()} Agent already initialized, skipping welcome message`);
     return;
   }
   ```

2. **首次初始化末尾**（aun.ts:886 发完欢迎语之后，`initialized = true` 之前）：

   ```typescript
   // Send binding credential
   await this.sendBindingCredential(owner, agentDisplayName, agentConfig.active_baseagent || 'claude').catch(e =>
     logger.warn(`${this.logPrefix()} Binding credential failed: ${e}`)
   );
   ```

   `agentDisplayName` 此处已经算好（aun.ts:809-813），直接复用。

---

## Step 2：测试

**文件**：`tests/unit/aun-binding-credential.test.ts`

参照 `aun-thought-put.test.ts` 的 `makeChannel` 模式（`new AUNChannel(…)` + `ch.client = { call: vi.fn() }`），用 `vi.mock` 拦截 `../../src/config-store.js` 的 `loadAgent`。

测试用例（4 个，覆盖 spec 里列的三项）：

1. **payload 字段正确**：构造 channel，直接调 `ch.sendBindingCredential('owner.aid', 'TestBot', 'claude')`，断言 `client.call` 以 `('message.send', { to: 'owner.aid', payload: { type: 'binding', aid: ..., name: 'TestBot', owner: 'owner.aid', baseagent: 'claude' }, encrypt: true, persist_required: true })` 被调用。

2. **client 未连接时跳过**：`ch.client = null`，调用后断言 `client.call` 未被调用（不抛错）。

3. **首次初始化路径触发凭证**：mock `loadAgent` 返回 `{ initialized: false, owners: ['owner.pub'], active_baseagent: 'codex' }`，mock `fetchPeerInfo` 返回 `{ type: 'human', name: 'Alice' }`，mock `agentmdPut`，调 `ch.sendWelcomeMessage()`，断言 `client.call` 含有 `type: 'binding'` 且 `baseagent: 'codex'` 的调用。

4. **已初始化路径（owner 变更）也触发凭证**：mock `loadAgent` 返回 `{ initialized: true, owners: ['owner.pub'], active_baseagent: 'claude' }`，调 `ch.sendWelcomeMessage()`，断言 `client.call` 含有 `type: 'binding'` 的调用，且函数提前 return（不发欢迎语文本）。

---

## 执行顺序

```
Step 1a → Step 1b（initialized 早退段） → Step 1b（首次初始化末尾） → Step 2 → npm test
```

Step 1 和 Step 2 可并行，但必须在 `npm test` 前全部完成。

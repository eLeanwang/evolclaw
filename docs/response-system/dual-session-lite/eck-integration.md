# 双会话响应模式 - ECK 集成

## 文档说明

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**关联**: [README.md](./README.md) | [架构设计](./architecture.md)

---

## 一、ECK Vars 扩展

### 1.1 新增参数

```typescript
interface ECKVars {
  // 响应模式标识
  responseMode: 'dual-session-lite';
  
  // 会话类型（核心参数）
  sessionType: 'auxiliary' | 'main';
  
  // 现有参数保持不变
  chatMode: 'proactive';
  channel: string;
  selfAid: string;
  peerId: string;
  peerKey: string;
  venueId: string;
  // ...
}
```

### 1.2 参数来源

```typescript
// 代码层注入
function buildECKVars(session: Session): ECKVars {
  return {
    // 响应模式（从配置读取）
    responseMode: config.responseMode || 'dual-session-lite',
    
    // 会话类型（根据当前会话实例判断）
    sessionType: session instanceof AuxiliarySession ? 'auxiliary' : 'main',
    
    // 其他参数（现有逻辑）
    chatMode: resolveChatMode(session),
    channel: session.channel,
    selfAid: session.selfAid,
    peerId: session.peerId,
    // ...
  };
}
```

---

## 二、Context Assembly 集成

### 2.1 Manifest 扩展

在现有 `kits/templates/manifest.yaml`（或对应文件）中增加：

```yaml
sections:
  # ... 现有 sections
  
  # ========================================
  # 双会话响应模式 - 辅助会话
  # ========================================
  - id: dual-session-lite-auxiliary
    when: "responseMode === 'dual-session-lite' && sessionType === 'auxiliary'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session-lite/prompts/auxiliary-base.md"
    priority: 100
    order: 50
  
  # ========================================
  # 双会话响应模式 - 主会话
  # ========================================
  - id: dual-session-lite-main
    when: "responseMode === 'dual-session-lite' && sessionType === 'main'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session-lite/prompts/main-base.md"
    priority: 100
    order: 50
```

### 2.2 渲染流程

```typescript
// Context Assembly 渲染流程
async function renderSystemPrompt(session: Session): Promise<string> {
  // 1. 构建 ECK vars
  const vars = buildECKVars(session);
  
  // 2. 加载 manifest
  const manifest = await loadManifest();
  
  // 3. 筛选匹配的 sections
  const sections = manifest.sections.filter(section => {
    return evaluateCondition(section.when, vars);
  });
  
  // 4. 按 priority + order 排序
  sections.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.order - b.order;
  });
  
  // 5. 渲染每个 section
  const parts: string[] = [];
  for (const section of sections) {
    const content = await renderSection(section, vars);
    parts.push(content);
  }
  
  // 6. 拼接成完整系统提示词
  return parts.join('\n\n---\n\n');
}
```

**when 条件求值示例**：
```typescript
// "responseMode === 'dual-session-lite' && sessionType === 'auxiliary'"

const vars = {
  responseMode: 'dual-session-lite',
  sessionType: 'auxiliary',
};

// evaluateCondition 返回 true
// → 该 section 会被加载
```

---

## 三、与现有 ECK 的兼容性

### 3.1 现有 sections 保持不变

双会话模式的 sections 只在 `responseMode === 'dual-session-lite'` 时加载。现有 sections（如 `rules/`, `identity/`, `relation/` 等）的 `when` 条件不受影响。

```yaml
# 现有 section 示例
- id: identity-persona
  when: "selfAid != null"
  source:
    type: file
    path: "$SELF_DIR/persona.md"
  priority: 90
```

这些 section 会根据各自的 `when` 条件独立判断是否加载。

### 3.2 组合加载示例

**场景 1：辅助会话（群聊）**
```typescript
vars = {
  responseMode: 'dual-session-lite',
  sessionType: 'auxiliary',
  selfAid: 'agent.aid.pub',
  channel: 'aun',
  chatType: 'group',
};

加载的 sections：
  ✓ rules/* (always)
  ✓ identity/* (selfAid != null)
  ✓ relation/* (peerId != null)
  ✓ venue/* (venueId != null)
  ✓ channel/* (channel != null)
  ✓ dual-session-lite-auxiliary (responseMode + sessionType)
  ✓ session (chatMode != null)
```

**场景 2：主会话（群聊）**
```typescript
vars = {
  responseMode: 'dual-session-lite',
  sessionType: 'main',
  selfAid: 'agent.aid.pub',
  channel: 'aun',
  chatType: 'group',
};

加载的 sections：
  ✓ rules/* (always)
  ✓ identity/* (selfAid != null)
  ✓ relation/* (peerId != null)
  ✓ venue/* (venueId != null)
  ✓ channel/* (channel != null)
  ✓ dual-session-lite-main (responseMode + sessionType)
  ✓ session (chatMode != null)
```

**场景 3：传统单会话（群聊）**
```typescript
vars = {
  responseMode: null,  // 或其他值
  selfAid: 'agent.aid.pub',
  channel: 'aun',
  chatType: 'group',
};

加载的 sections：
  ✓ rules/* (always)
  ✓ identity/* (selfAid != null)
  ✓ relation/* (peerId != null)
  ✓ venue/* (venueId != null)
  ✓ channel/* (channel != null)
  ✗ dual-session-lite-* (responseMode 不匹配)
  ✓ session (chatMode != null)
```

---

## 四、配置方式

### 4.1 启用双会话模式

在 agent 配置文件（`$AGENT_DIR/config.json`）中增加：

```json
{
  "responseMode": "dual-session-lite",
  "dualSessionConfig": {
    "auxiliaryModel": "deepseek-v4-flash",
    "mainModel": "claude-opus",
    "debounceMs": 3000,
    "maxWaitMs": 15000,
    "maxQueueSize": 50
  }
}
```

### 4.2 按关系/环境配置

也可以在关系级（`$RELATIONS_DIR/<peerKey>/config.json`）或环境级（`$VENUES_DIR/<venueKey>/config.json`）覆盖：

```json
{
  "responseMode": "dual-session-lite",
  "dualSessionConfig": {
    "debounceMs": 5000  // 该关系下延长防抖时间
  }
}
```

---

## 五、代码层实现要点

### 5.1 会话工厂

```typescript
class SessionFactory {
  static createSession(
    type: 'auxiliary' | 'main',
    config: SessionConfig
  ): Session {
    if (type === 'auxiliary') {
      return new AuxiliarySession(config);
    } else {
      return new MainSession(config);
    }
  }
}

// 使用
const auxiliarySession = SessionFactory.createSession('auxiliary', {
  model: config.dualSessionConfig.auxiliaryModel,
  selfAid: agent.aid,
  peerId: peer.id,
  // ...
});

const mainSession = SessionFactory.createSession('main', {
  model: config.dualSessionConfig.mainModel,
  selfAid: agent.aid,
  peerId: peer.id,
  // ...
});
```

### 5.2 系统提示词注入

```typescript
class Session {
  async loadSystemPrompt(): Promise<string> {
    // 构建 ECK vars
    const vars = buildECKVars(this);
    
    // 渲染系统提示词
    const systemPrompt = await contextAssembly.render(vars);
    
    return systemPrompt;
  }
}

// 辅助会话调用
const auxiliaryPrompt = await auxiliarySession.loadSystemPrompt();
// → 加载 auxiliary-base.md

// 主会话调用
const mainPrompt = await mainSession.loadSystemPrompt();
// → 加载 main-base.md
```

### 5.3 条件求值器

```typescript
function evaluateCondition(condition: string, vars: ECKVars): boolean {
  // 简单实现（生产环境需要更安全的求值）
  try {
    const func = new Function(...Object.keys(vars), `return ${condition}`);
    return func(...Object.values(vars));
  } catch (error) {
    logger.error('[ContextAssembly] Condition evaluation failed', { 
      condition, 
      error 
    });
    return false;
  }
}

// 示例
evaluateCondition(
  "responseMode === 'dual-session-lite' && sessionType === 'auxiliary'",
  { 
    responseMode: 'dual-session-lite', 
    sessionType: 'auxiliary' 
  }
); // → true
```

---

## 六、调试支持

### 6.1 调试输出

在 `$EVOLCLAW_HOME/data/eck-debug/` 下输出调试信息（与现有机制对齐）：

```
$EVOLCLAW_HOME/data/eck-debug/
├── vars.json              # ECK vars 快照
├── context.txt            # 完整系统提示词
├── fragments/             # 每个 section 的渲染结果
│   ├── rules.md
│   ├── identity.md
│   ├── dual-session-lite-auxiliary.md  ← 新增
│   └── ...
└── manifest.yaml          # 最终匹配的 sections
```

### 6.2 日志

```typescript
logger.info('[ContextAssembly] Rendering system prompt', {
  responseMode: vars.responseMode,
  sessionType: vars.sessionType,
  matchedSections: sections.map(s => s.id),
});

logger.debug('[ContextAssembly] Section rendered', {
  sectionId: section.id,
  when: section.when,
  matched: true,
  contentLength: content.length,
});
```

---

## 七、测试用例

### 7.1 单元测试

```typescript
describe('ECK Integration - Dual Session Lite', () => {
  it('should load auxiliary prompt when sessionType=auxiliary', async () => {
    const vars: ECKVars = {
      responseMode: 'dual-session-lite',
      sessionType: 'auxiliary',
      selfAid: 'test.aid.pub',
      // ...
    };
    
    const prompt = await contextAssembly.render(vars);
    
    expect(prompt).toContain('你是**辅助会话**');
    expect(prompt).not.toContain('你是**主会话**');
  });
  
  it('should load main prompt when sessionType=main', async () => {
    const vars: ECKVars = {
      responseMode: 'dual-session-lite',
      sessionType: 'main',
      selfAid: 'test.aid.pub',
      // ...
    };
    
    const prompt = await contextAssembly.render(vars);
    
    expect(prompt).toContain('你是**主会话**');
    expect(prompt).not.toContain('你是**辅助会话**');
  });
  
  it('should not load dual-session sections when responseMode is not set', async () => {
    const vars: ECKVars = {
      responseMode: null,
      selfAid: 'test.aid.pub',
      // ...
    };
    
    const prompt = await contextAssembly.render(vars);
    
    expect(prompt).not.toContain('辅助会话');
    expect(prompt).not.toContain('主会话');
  });
});
```

### 7.2 集成测试

```typescript
describe('Dual Session Lite - End to End', () => {
  it('should process message through auxiliary and main sessions', async () => {
    // 1. 消息到达
    const message = createTestMessage('测试消息');
    await auxiliaryQueue.enqueue(message);
    
    // 2. 等待辅助会话处理
    await waitFor(() => auxiliarySession.hasProcessed(message.id));
    
    // 3. 验证投递到主队列
    expect(mainQueue.contains(message.id)).toBe(true);
    
    // 4. 等待主会话处理
    await waitFor(() => mainSession.hasProcessed(message.id));
    
    // 5. 验证反馈
    const feedback = await feedbackStore.getLatest();
    expect(feedback.processedMessageIds).toContain(message.id);
    
    // 6. 验证辅助会话收到反馈
    expect(auxiliarySession.hasFeedback(feedback.batchId)).toBe(true);
  });
});
```

---

## 八、迁移指南

### 8.1 从单会话迁移到双会话

**步骤 1：启用双会话模式**
```json
// $AGENT_DIR/config.json
{
  "responseMode": "dual-session-lite"
}
```

**步骤 2：验证配置**
```bash
ec config get responseMode
# 输出: dual-session-lite
```

**步骤 3：重启 agent**
```bash
evolclaw restart
```

**步骤 4：观察日志**
```bash
tail -f $EVOLCLAW_HOME/logs/agent.log
# 应该看到：
# [AuxiliaryQueue] Message enqueued
# [AuxiliarySession] Processing batch
# [MainQueue] Append
# [MainSession] Processing batch
```

### 8.2 回滚到单会话

**步骤 1：禁用双会话模式**
```json
// $AGENT_DIR/config.json
{
  "responseMode": null
}
```

**步骤 2：重启 agent**
```bash
evolclaw restart
```

---

## 九、性能影响

### 9.1 上下文大小对比

**单会话模式**：
```
系统提示词：
  ✓ rules (5k tokens)
  ✓ identity (3k tokens)
  ✓ relation (2k tokens)
  ✓ venue (1k tokens)
  ✓ channel (2k tokens)
  ✓ session (1k tokens)
  ─────────────────────
  总计: 14k tokens
```

**双会话模式 - 辅助会话**：
```
系统提示词：
  ✓ rules (5k tokens)
  ✓ identity (3k tokens)
  ✓ relation (2k tokens)
  ✓ venue (1k tokens)
  ✓ channel (2k tokens)
  ✓ dual-session-lite-auxiliary (3k tokens)  ← 新增
  ✓ session (1k tokens)
  ─────────────────────
  总计: 17k tokens (+3k)
```

**双会话模式 - 主会话**：
```
系统提示词：
  ✓ rules (5k tokens)
  ✓ identity (3k tokens)
  ✓ relation (2k tokens)
  ✓ venue (1k tokens)
  ✓ channel (2k tokens)
  ✓ dual-session-lite-main (2k tokens)  ← 新增
  ✓ session (1k tokens)
  ─────────────────────
  总计: 16k tokens (+2k)
```

**结论**：
- 辅助会话增加 ~3k tokens
- 主会话增加 ~2k tokens
- 增幅在可接受范围内（< 20%）

### 9.2 Cache 命中率

双会话模式的系统提示词同样受益于 Prompt Cache：
- 辅助会话提示词固定 → Cache 稳定
- 主会话提示词固定 → Cache 稳定

预期 Cache 命中率：95%+

---

## 十、常见问题

### Q1: 双会话模式能与其他响应模式共存吗？

**A**: 可以。通过 `responseMode` 参数切换。不同关系/环境可以使用不同的响应模式。

### Q2: 能否只启用辅助会话，不启用主会话？

**A**: 不能。双会话模式必须两个会话同时工作。如果只需要过滤功能，可以考虑实现一个更轻量的"快速过滤器"（非会话）。

### Q3: 辅助/主会话的提示词能自定义吗？

**A**: 可以。在关系级或环境级覆盖：
```
$RELATIONS_DIR/<peerKey>/prompts/
├── auxiliary-override.md
└── main-override.md
```
然后在 manifest 中增加优先级更高的 section 指向这些文件。

### Q4: 双会话模式的成本增加多少？

**A**: 
- 辅助会话：便宜模型，成本很低
- 主会话：与单会话相同
- 总成本：略有增加（辅助会话成本），但通过减少主会话调用次数可以抵消

---

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队

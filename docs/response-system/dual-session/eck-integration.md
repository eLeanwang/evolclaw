# 双会话响应模式 - ECK 集成

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 设计定稿

---

## 一、概述

ECK（EvolClaw Context Kit）通过声明式 manifest 控制系统提示词的组装。双会话响应模式通过 ECK Vars 和 Context Assembly Manifest 实现动态提示词加载。

---

## 二、ECK Vars 定义

### 2.1 数据结构

```typescript
interface ECKVars {
  // === 响应模式相关 ===
  responseMode: 'single-session' | 'dual-session' | 'workflow';
  
  // === 通用参数（从 config 中提取）===
  chatMode: 'interactive' | 'proactive';
  mentionMode: 'disabled' | 'mention-only';
  model: string;
  
  // === dual-session 特有 ===
  sessionType?: 'auxiliary' | 'main';  // 当前是辅助会话还是主会话
  
  // === 其他参数 ===
  chatType: 'private' | 'group' | null;
  channel: string;
  selfAid: string;
  peerId: string;
  peerKey: string;
  venueUid?: string;
  // ...
}
```

### 2.2 参数来源

| 参数 | 来源 | 说明 |
|------|------|------|
| `responseMode` | agent config | 当前使用的响应模式 |
| `chatMode` | response mode config | 通用参数：交互方式 |
| `mentionMode` | response mode config | 通用参数：mention 策略 |
| `model` | response mode config | 通用参数：主会话模型 |
| `sessionType` | 运行时注入 | dual-session 特有：当前会话类型 |
| `chatType` | 运行时判断 | 私聊/群聊/null |
| `channel` | 运行时 | 当前渠道 |

### 2.3 值的确定

**代码示例**：

```typescript
// 先按优先级合并配置
function resolveResponseConfig(session: Session): ResponseModeConfig {
  const layers = [
    session.relationConfig?.config,        // 关系级
    session.venueConfig?.config,          // 环境级
    session.agentConfig.config,           // Agent 级
    DEFAULT_RESPONSE_CONFIG,              // 默认值
  ];
  
  // 合并（高优先级覆盖低优先级）
  const merged = {};
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i]) {
      Object.assign(merged, layers[i]);
    }
  }
  
  return merged;
}

// 上下文组装时确定 ECK Vars
function buildECKVars(session: Session): ECKVars {
  const agentConfig = loadAgentConfig(session.agentId);
  
  // 1. 合并配置
  const resolvedConfig = resolveResponseConfig(session);
  
  return {
    // 响应模式
    responseMode: agentConfig.responseMode,
    
    // 通用参数（从合并后的配置提取）
    chatMode: resolvedConfig.chatMode || 'proactive',
    mentionMode: resolvedConfig.mentionMode || 'disabled',
    model: resolvedConfig.model || 'claude-opus',
    
    // dual-session 特有
    sessionType: session.sessionType,  // 'auxiliary' | 'main'
    
    // 其他参数
    chatType: session.chatType,
    channel: session.channel,
    selfAid: session.selfAid,
    peerId: session.peerId,
    peerKey: session.peerKey,
    // ...
  };
}
```

---

## 三、Context Assembly Manifest

> ⚠️ **改动 manifest 前必读**：本节示例必须与 ECK 真实机制（`kits/docs/context-assembly.md`）
> 保持一致。真实机制的要点：manifest 是 **JSON**；`when` 用**对象语法**（不是字符串表达式）；
> 字段是平级的 `type`/`file`（不是 `source` 嵌套）；改行为用**覆盖文件**
> （`$ECK/eck_manifest.json`，patch 合并进基础 manifest），**不直接改基础 manifest**。
> **审查系统 manifest 的真实机制后再修改；若发现冲突或不一致，先找用户澄清，不要自行臆改。**

### 3.1 辅助会话：独立 manifest

辅助会话是一个**独立会话原型**（`sessionType: 'auxiliary'`），加载专属的精简 manifest
`eck_manifest.auxiliary.json`（不塞进主 manifest）。映射由 agent config 的 `sessionManifests` 定义：

```jsonc
// $AGENT_DIR/config.json
{
  "sessionManifests": {
    "auxiliary": "eck_manifest.auxiliary.json"
    // "main" 缺省，兜底 eck_manifest.json
  }
}
```

`kits/eck_manifest.auxiliary.json`（基础，随包发布；`$ECK/eck_manifest.auxiliary.json` 可两级覆盖）：

```jsonc
{
  "$schema_version": 1,
  "totalMaxFiles": 20,
  "totalMaxBytes": 51200,
  "sections": [
    { "id": "rules", "type": "directory", "path": "$KITS_RULES", "order": 10,
      "needsInjection": false, "when": "always", "description": "ECK 核心规则" },
    { "id": "auxiliary-role", "type": "file",
      "file": "$KITS_DOCS/response-system/dual-session/prompts/auxiliary-base.md",
      "order": 20, "needsInjection": true, "when": "always",
      "description": "辅助会话职责：hold/delay/transfer + 背压调节" },
    { "id": "session", "type": "file", "file": "$KITS_FRAGMENTS/session.md",
      "order": 60, "needsInjection": true, "when": "always" },
    { "id": "baseagent", "type": "file", "file": "$KITS_FRAGMENTS/baseagent.md",
      "order": 70, "needsInjection": true, "when": { "var": "baseAgent", "neq": null } }
  ]
}
```

**辅助会话 manifest 刻意精简**：只含 rules + 辅助职责 + session + baseagent，
**不含**身份层/关系层/对端 profile/venue/命令——辅助会话只做投递判断，不需要这些重段，省 token 提速。

### 3.2 主会话与 mention：主 manifest 的覆盖文件

主会话（`sessionType: 'main'`）走默认 `eck_manifest.json`。dual-session 只需给它追加
mention 说明段，通过**覆盖文件** `$ECK/eck_manifest.json`（patch 合并，不贴整份基础 manifest）：

```json
// $ECK/eck_manifest.json（覆盖文件，patch 合并进基础 manifest）
{
  "sections": [
    {
      "id": "dual-session-main-prompt",
      "type": "file",
      "file": "$KITS_DOCS/response-system/dual-session/prompts/main-base.md",
      "when": { "var": "responseMode", "eq": "dual-session" },
      "order": 10,
      "description": "主会话提示词（dual-session）"
    },
    {
      "id": "mention-mode-guide-mention-only",
      "type": "file",
      "file": "$KITS_DOCS/response-system/dual-session/prompts/mention-only-guide.md",
      "when": { "var": "mentionMode", "eq": "mention-only" },
      "order": 30,
      "description": "mention-only 策略说明"
    }
  ]
}
```

> **主会话不需要 sessionType 判断**：它就是默认 manifest，`dual-session-main-prompt` 只靠
> `responseMode === 'dual-session'` 命中即可（辅助会话走独立 manifest，不会误命中）。

> **回复方式（chatMode）不在此定义**：「当前渠道怎么回复、怎么发消息」由 ECK 的 `[channel]` 段
> 唯一负责（见 `kits/rules/06-channel.md` 与 `kits/templates/system-fragments/channel.md`）。
> `[channel]` 段读取 ECK Vars 里的 `chatMode` 并按 interactive/proactive 分流解释，
> response-system 不重复定义发送命令，避免与 `[channel]` 段冲突。

### 3.3 加载规则

**条件求值**（以 `context-assembly.md` 的 `evaluateWhen` 为准）：

- `when` 是 `"always"` 或**对象**，不是字符串表达式
- 单条件：`{ "var": "X", "eq": V }` / `{ "var": "X", "neq": V }` / `{ "var": "X", "in": [...] }` / `{ "var": "X", "nin": [...] }`
- 组合：`{ "all": [...] }`（全为真）/ `{ "any": [...] }`（任一为真）
- `eq: null` 匹配"未注入"，`neq: null` 匹配"已注入"
- 命中的 section 按 `order` 升序排序后拼接

**各会话原型加载的 manifest**：

| 场景 | sessionType | 加载的 manifest | 关键 section |
|------|------|------|------|
| coding / 单聊（single-session） | main | `eck_manifest.json` | 无 dual-session 专属段 |
| 群聊（dual-session，主会话） | main | `eck_manifest.json` + 覆盖 | `dual-session-main-prompt`（+ mention 段） |
| 群聊（dual-session，辅助会话） | auxiliary | `eck_manifest.auxiliary.json` | `auxiliary-role` |

> chatMode 不对应 response-system 的 section——它是 ECK Vars，由 [channel] 段读取解释。

---

## 四、提示词加载流程

### 4.1 流程图

```
收到消息
  ↓
确定会话类型（sessionType）
  ↓
加载 agent config
  ↓
提取 responseMode 和 config
  ↓
构建 ECK Vars
  ↓
加载基础 manifest + 覆盖文件（$ECK/eck_manifest.json，patch 合并）
  ↓
逐段求值 when 条件（对象语法，evaluateWhen）
  ↓
收集命中的 sections
  ↓
按 order 升序排序
  ↓
拼接成完整系统提示词
  ↓
调用 base agent
```

### 4.2 组装逻辑

上下文组装由 ECK 的 `renderKitSections` 统一完成，**dual-session 不自行实现**。流程（见 `context-assembly.md`）：

1. 构建 ECK Vars
2. 加载基础 manifest，若存在 `$ECK/eck_manifest.json` 则 patch 合并（同 id 浅合并、新 id 追加）
3. 逐段用 `evaluateWhen(section.when, vars)` 求值，命中的收集
4. 按 `order` 升序排序
5. 渲染（`needsInjection:true` 的文件跑模板渲染），拼接进 `<system-reminder>` 块

dual-session 只需**提供覆盖文件里的 3 个 section 定义**（见 §3.1）和对应的提示词模板文件，
组装本身复用 ECK 现有机制，不重写。

---

## 五、双会话的特殊处理

### 5.1 辅助会话和主会话

**关键**：同一个 agent，两个不同的会话实例

| 会话 | sessionType | 加载的提示词 |
|------|------------|------------|
| **辅助会话** | `'auxiliary'` | `auxiliary-base.md` |
| **主会话** | `'main'` | `main-base.md` + chatMode 说明 |

**实现**：

```typescript
// 辅助会话
const auxiliarySession = await createSession({
  agentId: agent.id,
  sessionType: 'auxiliary',  // 关键：标识为辅助会话
  model: config.auxiliaryModel || 'deepseek-v4-flash',
});

// 主会话
const mainSession = await createSession({
  agentId: agent.id,
  sessionType: 'main',  // 关键：标识为主会话
  model: config.model || 'claude-opus',
});
```

### 5.2 sessionType 的传递

**创建会话时注入**：

```typescript
class DualSessionEngine {
  private auxiliarySession: Session;
  private mainSession: Session;
  
  async init() {
    // 创建辅助会话（注入 sessionType: 'auxiliary'）
    this.auxiliarySession = await sessionManager.create({
      agentId: this.agentId,
      sessionType: 'auxiliary',  // ← 注入
      model: this.config.auxiliaryModel,
    });
    
    // 创建主会话（注入 sessionType: 'main'）
    this.mainSession = await sessionManager.create({
      agentId: this.agentId,
      sessionType: 'main',  // ← 注入
      model: this.config.model,
    });
  }
}
```

---

## 六、调试和验证

### 6.1 调试输出

EvolClaw 在 `$EVOLCLAW_HOME/data/eck-debug/` 下输出调试文件：

```
eck-debug/
├── vars.json           # 当前 ECK Vars
├── context.txt         # 完整系统提示词
├── fragments/          # 每个 fragment 的内容
│   ├── dual-session-main-prompt.md
│   ├── channel.md       # [channel] 段：回复方式（含 chatMode 分流）
│   └── ...
└── manifest.json      # 实际生效的 manifest（基础 + 覆盖文件合并后）
```

**查看命令**：

```bash
# 查看当前 ECK Vars
cat $EVOLCLAW_HOME/data/eck-debug/vars.json

# 查看完整系统提示词
cat $EVOLCLAW_HOME/data/eck-debug/context.txt

# 查看某个 fragment
cat $EVOLCLAW_HOME/data/eck-debug/fragments/dual-session-main-prompt.md
```

### 6.2 验证清单

创建会话后，验证以下内容：

- [ ] `vars.json` 中 `responseMode` 正确
- [ ] `vars.json` 中 `chatMode` / `mentionMode` 正确
- [ ] `vars.json` 中 `sessionType` 正确（辅助会话/主会话）
- [ ] `context.txt` 中包含对应的提示词 fragment
- [ ] `context.txt` 中包含 [channel] 段（回复方式，由渠道层提供）
- [ ] `context.txt` 中包含 mentionMode 说明（如果不是 disabled）

---

## 七、配置示例

### 7.1 Agent 配置

```json
// $AGENT_DIR/config.json
{
  "responseMode": "dual-session",
  "chatmode": { "group": "proactive" },
  "mentionMode": "disabled",
  "responseModeParams": {
    "dual-session": { "debounceMs": 3000, "auxiliaryModel": "deepseek-v4-flash" }
  }
}
```

### 7.2 生成的 ECK Vars

```json
// $EVOLCLAW_HOME/data/eck-debug/vars.json
{
  "responseMode": "dual-session",
  "chatMode": "proactive",
  "mentionMode": "disabled",
  "model": "claude-opus",
  "sessionType": "main",
  "chatType": "group",
  "channel": "aun",
  "selfAid": "myagent.aid.pub",
  "peerId": "alice.aid.pub",
  "peerKey": "aun#alice.aid.pub"
}
```

### 7.3 命中的 Sections

```jsonc
// 主会话场景（命中的段，when 为对象语法）
[
  {
    "id": "dual-session-main-prompt",
    "order": 10,
    "when": { "all": [
      { "var": "responseMode", "eq": "dual-session" },
      { "var": "sessionType", "eq": "main" }
    ] }
  },
  {
    "id": "channel",               // [channel] 段：回复方式，读 chatMode 分流
    "when": { "var": "channel", "neq": null }   // 由渠道层提供，非 response-system 定义
  }
]
```

---

## 八、与其他模式的对比

### single-session 模式

```typescript
// ECK Vars
{
  responseMode: 'single-session',
  chatMode: 'proactive',
  sessionType: undefined,  // 无 sessionType
  // ...
}

// 命中的 sections
- channel  // 回复方式由 [channel] 段提供（读 chatMode 分流）
```

### dual-session 模式

```typescript
// ECK Vars（辅助会话）
{
  responseMode: 'dual-session',
  chatMode: 'proactive',
  sessionType: 'auxiliary',  // 辅助会话
  // ...
}

// 命中的 sections
- dual-session-auxiliary-prompt  // 辅助会话提示词

// ECK Vars（主会话）
{
  responseMode: 'dual-session',
  chatMode: 'proactive',
  sessionType: 'main',  // 主会话
  // ...
}

// 命中的 sections
- dual-session-main-prompt       // 主会话提示词
- channel                        // 回复方式由 [channel] 段提供
```

---

## 九、扩展点

### 9.1 新增响应模式

1. 新建提示词模板文件，再在覆盖文件 `$ECK/eck_manifest.json` 中追加 section：

```json
{
  "sections": [
    {
      "id": "workflow-main-prompt",
      "type": "file",
      "file": "$KITS_DOCS/response-system/workflow/prompts/main.md",
      "when": { "var": "responseMode", "eq": "workflow" },
      "order": 10
    }
  ]
}
```

2. 新模式自动继承通用参数的 section（mentionMode；回复方式由 [channel] 段处理）

### 9.2 新增通用参数

1. 定义参数（如 `batchMode`）
2. 新建提示词模板文件（manifest 只支持 `type: file`，不支持 inline）：
   `$KITS_DOCS/response-system/prompts/batch-mode-guide.md`
3. 在覆盖文件 `$ECK/eck_manifest.json` 中追加 section：

```json
{
  "sections": [
    {
      "id": "batch-mode-guide",
      "type": "file",
      "file": "$KITS_DOCS/response-system/prompts/batch-mode-guide.md",
      "when": { "var": "batchMode", "eq": "enabled" },
      "order": 25
    }
  ]
}
```

4. 所有响应模式自动支持

---

## 十、总结

### ECK 集成的关键点

✅ **ECK Vars**：从 agent config 提取参数，注入运行时信息  
✅ **Manifest**：声明式控制提示词加载，条件求值  
✅ **sessionType**：dual-session 通过 sessionType 区分辅助会话和主会话  
✅ **通用参数**：mentionMode 的 section 所有模式共享（chatMode 的回复方式由 [channel] 段处理）  
✅ **调试输出**：`eck-debug/` 目录提供完整的调试信息  

### 设计优势

✅ **声明式**：manifest 清晰表达加载规则  
✅ **灵活性**：新模式/新参数只需添加 sections  
✅ **可调试**：完整的调试输出，问题可追溯  
✅ **一致性**：通用参数的 sections 自动应用到所有模式  

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 设计定稿

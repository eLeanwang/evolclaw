# EvolClaw 会话与话题机制详解

## 文档目的

本文档详细说明 EvolClaw 的会话管理机制，包括：
- evolclaw session 与 baseagent session 的关系
- threadId 话题路由机制
- 会话持久化与恢复
- `/new` 等命令的实际效果

适用于需要理解 EvolClaw 内部会话管理逻辑的开发者。

---

## 一、核心概念

### 1.1 两层会话模型

EvolClaw 采用**两层会话模型**：

| 层级 | 名称 | 作用 | 生命周期 |
|------|------|------|----------|
| **上层** | evolclaw session | 管理通信关系、路由、元数据 | 长期持久化 |
| **下层** | baseagent session | 大模型的对话上下文 | 由 SDK 管理，每次 query 可能产生新 ID |

```
┌─────────────────────────────────────────┐
│         evolclaw session                │
│  - id: meta_20260520_xxx                │
│  - channel: aun                         │
│  - channelId: peer.aid.pub              │
│  - threadId: "work" / ""                │
│  - agentSessionId: "claude-session-123" │ ← 关联到 baseagent
│  - projectPath: /path/to/project        │
│  - metadata: {...}                      │
└─────────────────────────────────────────┘
                    ↓ 映射
┌─────────────────────────────────────────┐
│       baseagent session (Claude SDK)    │
│  - session_id: "claude-session-123"     │
│  - 对话历史、上下文、工具调用记录        │
│  - 存储在 ~/.claude/projects/...        │
└─────────────────────────────────────────┘
```

### 1.2 关键术语

| 术语 | 含义 |
|------|------|
| **evolclaw session** | EvolClaw 管理的会话对象，包含路由信息和元数据 |
| **baseagent session** | 底层大模型（如 Claude）的对话会话，由 SDK 管理 |
| **agentSessionId** | evolclaw session 中存储的 baseagent session ID |
| **threadId** | 话题标识符，用于将对话分成多个独立话题 |
| **主会话** | threadId 为空字符串的会话，每个对端一个 |
| **话题会话** | threadId 非空的会话，每个话题一个 |
| **session_id** | Claude SDK 返回的会话 ID，每次 query 可能变化 |

---

## 二、会话路由机制

### 2.1 主会话 vs 话题会话

每个通信对端（channel + channelId）有：
- **1 个主会话**（threadId = ""）：默认对话入口
- **N 个话题会话**（threadId = "work" / "project-A" / ...）：独立话题

```
对端 A 与 B 的会话结构（B 端视角）：

~/.evolclaw/data/sessions/aun/A.aid.pub/B.aid.pub/
├── active.json                    # 当前激活的会话（通常是主会话）
├── meta_xxx.jsonl                 # 主会话元数据（threadId=""）
├── messages.jsonl                 # 消息日志
└── _threads/                      # 话题会话目录
    ├── thread-index.json          # 话题索引
    ├── meta_yyy.jsonl             # 话题1元数据（threadId="work"）
    └── meta_zzz.jsonl             # 话题2元数据（threadId="project-A"）
```

### 2.2 路由决策

```
收到消息 → 提取 payload.thread_id
  ├─ thread_id 为空 → 路由到主会话
  └─ thread_id 非空 → 路由到对应话题会话
```

**代码位置**：`src/core/session/session-manager.ts:446-452`

```typescript
async getOrCreateSession(..., threadId?: string) {
  if (threadId) {
    return this.getOrCreateThreadSession(...);  // 话题会话
  } else {
    // 主会话逻辑
  }
}
```

### 2.3 thread-index.json 索引

**作用**：将 threadId（字符串）映射到 evolclaw session ID

**示例**：
```json
{
  "work": "meta_20260520_1779269573570",
  "project-A": "meta_20260521_1779369573571",
  "debug-issue-42": "meta_20260522_1779469573572"
}
```

**查找流程**：
1. 读取 `thread-index.json`
2. 通过 `threadId` 查找对应的 `sessionId`
3. 读取 `_threads/<sessionId>.jsonl` 的最后一行（最新状态）
4. 获取 `agentSessionId`，用于调用 baseagent

**代码位置**：`src/core/session/session-manager.ts:580-646`

---

## 三、baseagent session 管理

### 3.1 baseagent session 的生命周期

**关键洞察**：baseagent session ID **不是固定的**，而是每次对话都可能变化。

#### Claude SDK 的行为

```typescript
// 首次对话（不传 resume）
query({ prompt: "你好" })
  → SDK 创建新对话
  → 返回 session_id = "claude-session-A"

// 第二次对话（传 resume）
query({ prompt: "继续", resume: "claude-session-A" })
  → SDK 基于 A 的上下文继续
  → 返回 session_id = "claude-session-B"  ← 注意：ID 变了

// 第三次对话
query({ prompt: "再继续", resume: "claude-session-B" })
  → 返回 session_id = "claude-session-C"
```

**原因**：Claude SDK 采用**快照式会话管理**，每次 query 都生成新的 session_id 作为新快照。

### 3.2 evolclaw 的自动追踪

evolclaw 自动捕获 SDK 返回的 session_id 并更新映射。

**代码位置**：`src/agents/claude-runner.ts:766-771`

```typescript
for await (const event of sdkStream) {
  // SDK 的任意事件都可能携带 session_id
  if (event.session_id && event.session_id !== lastSessionId) {
    lastSessionId = event.session_id;
    this.updateSessionId(sessionId, event.session_id);  // 更新映射
    yield { type: 'session_id', sessionId: event.session_id };
  }
}
```

**更新流程**：
1. SDK 返回新的 `session_id`
2. `updateSessionId()` 更新内存映射 `activeSessions`
3. 调用 `onSessionIdUpdate()` 回调
4. SessionManager 将新 `agentSessionId` 追加到 `meta_xxx.jsonl`

### 3.3 持久化格式

**meta_xxx.jsonl**（追加式日志）：

```jsonl
{"id":"meta_xxx","threadId":"work","agentSessionId":"claude-session-A","updatedAt":1716500000000,...}
{"id":"meta_xxx","threadId":"work","agentSessionId":"claude-session-B","updatedAt":1716500060000,...}
{"id":"meta_xxx","threadId":"work","agentSessionId":"claude-session-C","updatedAt":1716500120000,...}
```

**读取逻辑**：`readMetaLatest()` 读取最后一行，获取最新的 `agentSessionId`。

### 3.4 会话恢复

**场景**：evolclaw 重启后，如何恢复对话？

```
1. 读取 active.json 或 thread-index.json
   → 获取 evolclaw session ID

2. 读取 meta_xxx.jsonl 最后一行
   → 获取最新的 agentSessionId = "claude-session-C"

3. 验证 baseagent session 文件是否存在
   → 检查 ~/.claude/projects/.../claude-session-C.jsonl

4. 调用 SDK 时传入 resume="claude-session-C"
   → SDK 基于 C 的上下文继续对话
```

**代码位置**：`src/agents/claude-runner.ts:878-917`

---

## 四、threadId 话题机制

### 4.1 threadId 的产生

**当前实现**：完全由用户/agent 指定，**不会自动生成**。

#### 来源1：CLI 参数（主动指定）

```bash
# 用户/agent 发起新话题
ec msg send A B "讨论项目X" --thread "project-X"
```

**流程**：
```
1. CLI 解析 --thread "project-X"
2. 构建 payload.thread_id = "project-X"
3. 通过 AUN 网络发送给 B
4. B 端提取 thread_id = "project-X"
5. SessionManager.getOrCreateThreadSession("project-X", ...)
   → 在 thread-index.json 中创建/查找 "project-X"
6. 关联到该话题的 evolclaw session
7. 调用 baseagent 处理消息
```

#### 来源2：对端发起（自动继承）

```
A 端发送（指定 --thread "work"）
  ↓ payload.thread_id = "work"
B 端接收
  ↓ 提取 threadId = "work"
  ↓ 路由到 "work" 话题会话
B 端回复
  ↓ context.threadId = "work"（从接收上下文继承）
  ↓ payload.thread_id = "work"（自动写入）
A 端接收回复
  ↓ 提取 threadId = "work"
  ↓ 路由到 "work" 话题会话
```

**关键**：B 端**自动继承** A 端发起的 threadId，不需要手动指定。

**代码位置**：
- 发送端：`src/aun/msg/p2p.ts:137-139`
- 接收端：`src/channels/aun.ts:985`

### 4.2 threadId 的命名空间

**重要**：threadId 是 **per-peer** 的，不会跨对端冲突。

```
B 端的目录结构：

sessions/aun/A.aid.pub/B.aid.pub/_threads/
  └── thread-index.json  → { "work": "meta_xxx" }

sessions/aun/C.aid.pub/B.aid.pub/_threads/
  └── thread-index.json  → { "work": "meta_yyy" }
```

B 与 A 的 "work" 话题 ≠ B 与 C 的 "work" 话题。

### 4.3 threadId 的对齐

**双方独立维护**：
- A 端有自己的 `thread-index.json`（A 视角的 sessions）
- B 端有自己的 `thread-index.json`（B 视角的 sessions）
- 两边通过**同一个 threadId 字符串**（如 "work"）来对齐
- 各自的 evolclaw session ID 不同（但都关联到自己的 baseagent session）

```
═══════ A 端 ═══════                         ═══════ B 端 ═══════

thread-index.json:                           thread-index.json:
{                                            {
  "work": "meta_aaa"                           "work": "meta_bbb"
}                                            }

meta_aaa.jsonl:                              meta_bbb.jsonl:
- threadId: "work"                           - threadId: "work"
- agentSessionId: "claude-A-1"               - agentSessionId: "claude-B-1"

通过 threadId="work" 对齐 ←─────────────────→ 通过 threadId="work" 对齐
```

---

## 五、命令行为详解

### 5.1 `/new` 命令

**作用**：创建新的 evolclaw 主会话，并清空旧会话的 baseagent 状态。

**代码位置**：`src/core/command-handler.ts:2252-2300`

#### 执行流程

```
1. 创建新的 evolclaw session
   - id = generateSessionId()  → "meta_new"
   - threadId = ""  ← 主会话
   - agentSessionId = undefined  ← 没有关联 baseagent

2. 清空旧 evolclaw session 的 baseagent 状态
   - 调用 agent.clearSession(oldSessionId, oldAgentSessionId, ...)
   - 向 Claude SDK 发送 /clear 命令
   - 清空旧会话的对话历史

3. 将新 session 写入 active.json

4. 下一条消息到来时
   - 因为 agentSessionId = undefined
   - SDK 不传 resume，创建全新对话
   - 返回新的 session_id
   - evolclaw 自动更新 agentSessionId
```

#### 状态变化

```
执行 /new 之前:
  evolclaw_session_X (active.json)
    ├─ threadId: ""
    └─ agentSessionId: "claude-session-old"

执行 /new 之后:
  evolclaw_session_Y (新的 active.json)
    ├─ threadId: ""
    └─ agentSessionId: undefined
  
  evolclaw_session_X (旧的，不再激活)
    ├─ threadId: ""
    └─ agentSessionId: ""  ← 被 clearSession 清空

下一条消息到来:
  evolclaw_session_Y 接收消息
    ↓ agentSessionId 为 undefined
    ↓ SDK 不传 resume，创建全新对话
    ↓ session_id = "claude-session-new"
    ↓ evolclaw 自动更新
  evolclaw_session_Y
    ├─ threadId: ""
    └─ agentSessionId: "claude-session-new"
```

**关键**：`/new` 是 **evolclaw 层面的重置**，不是 baseagent 层面的。

### 5.2 `/clear` 命令

**作用**：清空当前 baseagent session 的对话历史，但**不创建新的 evolclaw session**。

**代码位置**：`src/agents/claude-runner.ts:1283-1300`

```typescript
async clearSession(sessionId: string, agentSessionId: string, projectPath: string) {
  // 向 Claude SDK 发送 /clear 命令
  const stream = this.runSessionCommand('/clear', agentSessionId, projectPath);
  for await (const event of stream) {
    // 等待清空完成
  }
}
```

**对比**：

| 命令 | evolclaw session | baseagent session | 使用场景 |
|------|------------------|-------------------|----------|
| `/new` | 创建新的 | 清空旧的，下次创建新的 | 完全重新开始 |
| `/clear` | 保持不变 | 清空历史 | 清空对话但保留元数据 |

### 5.3 `/session` 命令

**作用**：切换到已有的 evolclaw session。

**不会创建新的 baseagent session**，而是恢复已有的 `agentSessionId`。

---

## 六、完整端到端示例

### 场景：A 和 B 第一次开启 "work" 话题

```
═══════ A 端 ═══════                         ═══════ B 端 ═══════

1. 用户/agent 执行
   ec msg send A B "讨论项目A" --thread "work"
   
2. msgSend() 构建 payload
   payload = {
     type: "text",
     text: "讨论项目A",
     chatmode: "proactive",
     thread_id: "work"     ← 关键
   }

3. 通过 AUN 网络发送 ─────────────────────→ 
                                              4. AUN Channel 接收
                                                 const threadId = payload.thread_id
                                                 // = "work"
                                              
                                              5. dispatchMessage() → MessageBridge
                                                 msg.threadId = "work"
                                              
                                              6. SessionManager.getOrCreateSession()
                                                 → 看到 threadId 非空
                                                 → getOrCreateThreadSession("work", ...)
                                              
                                              7. 读 thread-index.json
                                                 → 没有 "work" 这个 key
                                              
                                              8. 创建新 evolclaw session
                                                 - id = "meta_yyy"
                                                 - threadId = "work"
                                                 - agentSessionId = undefined
                                              
                                              9. 写入：
                                                 - _threads/meta_yyy.jsonl（追加）
                                                 - thread-index.json["work"] = "meta_yyy"
                                              
                                              10. 调用 Claude SDK
                                                  → Claude 创建新 session
                                                  → claude_session_id = "claude-1"
                                              
                                              11. updateAgentSessionIdBySessionId()
                                                  - session.agentSessionId = "claude-1"
                                                  - 追加到 meta_yyy.jsonl
                                              
                                              12. Claude 输出回复
                                                  → 通过 AUN 发回 A
                                              
                                              13. payload.thread_id = "work"（自动继承）

14. A 端 AUN Channel 接收 ←─────────────── 
    threadId = payload.thread_id = "work"

15. SessionManager.getOrCreateSession()
    → getOrCreateThreadSession("work", ...)
    → 创建 A 端的 "work" session
    → meta_xxx.jsonl, thread-index.json["work"] = "meta_xxx"

16. A 端处理回复...
```

### 场景：A 和 B 继续 "work" 话题

```
═══════ A 端 ═══════                         ═══════ B 端 ═══════

1. ec msg send A B "继续之前的讨论" --thread "work"

2. payload.thread_id = "work"

3. 通过 AUN 发送 ─────────────────────────→
                                              4. AUN Channel 接收
                                                 threadId = "work"
                                              
                                              5. SessionManager.getOrCreateThreadSession()
                                                 → 读 thread-index.json["work"] = "meta_yyy"
                                                 → 读 _threads/meta_yyy.jsonl 最后一行
                                                 → existing.agentSessionId = "claude-1"
                                              
                                              6. 调用 Claude SDK，传入 resume="claude-1"
                                                 → Claude 接续之前的对话
                                                 → 新轮次后 session_id 更新为 "claude-2"
                                              
                                              7. updateAgentSessionIdBySessionId()
                                                  - session.agentSessionId = "claude-2"
                                                  - 追加到 meta_yyy.jsonl
                                              
                                              8. 处理消息并回复...
```

---

## 七、关键代码位置索引

| 功能 | 文件 | 行号 |
|------|------|------|
| 会话路由（主会话 vs 话题） | `src/core/session/session-manager.ts` | 446-452 |
| 创建/查找话题会话 | `src/core/session/session-manager.ts` | 580-646 |
| thread-index.json 读写 | `src/core/session/session-fs-store.ts` | 243-249 |
| meta jsonl 追加 | `src/core/session/session-manager.ts` | 210-217 |
| baseagent session 恢复 | `src/agents/claude-runner.ts` | 878-917 |
| session_id 自动追踪 | `src/agents/claude-runner.ts` | 766-771 |
| agentSessionId 更新 | `src/core/session/session-manager.ts` | 706-715 |
| `/new` 命令 | `src/core/command-handler.ts` | 2252-2300 |
| `/clear` 命令 | `src/agents/claude-runner.ts` | 1283-1300 |
| CLI --thread 参数 | `src/cli/index.ts` | 3778 |
| payload.thread_id 写入 | `src/aun/msg/p2p.ts` | 137-139 |
| AUN 接收提取 threadId | `src/channels/aun.ts` | 985 |

---

## 八、常见问题

### Q1: 为什么 baseagent session_id 每次都变？

**A**: Claude SDK 采用快照式会话管理。每次 query 都基于上次的快照生成新快照，并返回新的 session_id。这是 SDK 的设计，evolclaw 自动追踪最新的 session_id。

### Q2: threadId 会跨对端冲突吗？

**A**: 不会。threadId 是 per-peer 的，存储在 `sessions/<channel>/<peerId>/<selfId>/_threads/` 下。不同对端的同名 threadId 是独立的。

### Q3: 如何查看所有话题？

**A**: 当前没有专门的命令。可以手动查看 `_threads/thread-index.json`，或者增加 `ec session list --threads` 命令。

### Q4: threadId 大小写敏感吗？

**A**: 是的。"work" 和 "Work" 会被视为两个不同的话题。

### Q5: 对端不传 threadId 会怎样？

**A**: 消息会路由到主会话（threadId=""），不会影响已有的话题会话。

### Q6: `/new` 会影响话题会话吗？

**A**: 不会。`/new` 只创建新的主会话（threadId=""），不影响 `_threads/` 下的话题会话。

### Q7: 如何删除一个话题？

**A**: 当前没有专门的命令。可以手动删除 `_threads/meta_xxx.jsonl` 和 `thread-index.json` 中的对应条目。

---

## 九、总结

### 核心机制

1. **两层会话模型**：evolclaw session（路由层）+ baseagent session（对话层）
2. **自动追踪**：baseagent session_id 变化时，evolclaw 自动更新映射
3. **话题路由**：通过 threadId 将对话分成独立话题，双方通过同名 threadId 对齐
4. **持久化**：thread-index.json（索引）+ meta_xxx.jsonl（追加式日志）

### 设计原则

- **用户视角**：一个对话就是一个对话（continuity）
- **实现视角**：evolclaw session 固定，baseagent session_id 变化
- **自动化**：session_id 追踪、threadId 继承都是自动的
- **隔离性**：不同对端、不同话题完全隔离

### 待改进

- [ ] 增加 `ec session list --threads` 命令查看所有话题
- [ ] 增加 `ec thread delete <threadId>` 命令删除话题
- [ ] 增加 threadId 自动生成机制（可选）
- [ ] 在文档中明确说明 threadId 大小写敏感

---

**文档版本**: v1.0  
**最后更新**: 2026-05-25  
**维护者**: EvolClaw Team

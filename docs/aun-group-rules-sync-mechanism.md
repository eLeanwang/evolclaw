# AUN 群规则同步机制设计方案

## 核心原理

通过群 agent.md 的 etag 变化作为触发信号，实现事件驱动的 rules.md 同步。

### 信源与触发链

```
群 rules.md 变化
  ↓
写入者修改群 agent.md（触发 etag 变化）
  ↓
群 agent.md 的 etag 变化（SDK 自动生成）
  ↓
后续消息的 envelope 携带新 etag
  ↓
接收者通过 checkAgentMd 检测到 etag 变化
  ↓
同时下载群 agent.md 和 rules.md
  ↓
写入本地文件
  ↓
fileCache mtime 机制自动重载
```

---

## 详细流程

### 一、写入端机制

**触发点**：`ec fs cp <local> <group-aid>:/rules.md --overwrite` 成功

**执行流程**：

1. 通过 fs 命令集写入 `<group-aid>:/rules.md`
2. 写入成功后，读取群当前的 agent.md
3. 修改群 agent.md（例如更新 `updated_at` 字段）触发 etag 变化
4. 通过 `agentmdPut()` 上传修改后的群 agent.md
5. SDK 重新签名群 agent.md 并生成新 etag
6. SDK 将新 etag 记录到 `~/.aun/AIDs/<group-aid>/agentmd.json` 的 `local_etag` 和 `remote_etag`

**关键点**：
- 群 agent.md 的作用是提供 etag 触发信号
- agent.md 不需要记录 rules.md 的版本信息
- etag 由 SDK 管理，EvolClaw 只调用 `agentmdPut()`
- 更新顺序：先 rules.md，再 agent.md

---

### 二、读取端机制

#### 2.1 消息到达与触发

**私聊消息**：
- envelope 携带发送者的 `agent_md.sender.etag`
- 通过 `PeerIdentityCache.resolve('aun', fromAid, ...)` 同步发送者 agent.md
- 获取发送者身份信息（type/name）

**群聊消息**：
- envelope 携带发送者的 `agent_md.sender.etag`（当前已有）
- envelope 需携带群的 `agent_md.group.etag`（待 SDK 扩展）
- 处理流程：
  1. 先调用 `PeerIdentityCache.resolve('aun', groupId, ...)` 同步群 agent.md
  2. 如果群 agent.md 有变化（`agentmdSync` 返回 `changed=true`），同步 rules.md
  3. 再调用 `PeerIdentityCache.resolve('aun', senderAid, ...)` 同步发送者 agent.md

#### 2.2 agent.md 同步机制

**调用链**：

```
PeerIdentityCache.resolve(channel, aid, agentDir, store, forceRefresh)
  ↓
检查本地缓存 peer-identity.json
  ↓
lastCheckedAt 距今 < 30天？
  ├─ 是 → 直接返回缓存（无网络请求）
  └─ 否 ↓
    调用 agentmdSync(aid, {store})
      ↓
    store.checkAgentMd(aid, 30)  ← SDK 方法
      ↓
    SDK 内部检查逻辑：
      - 读取本地 ~/.aun/AIDs/<aid>/agentmd.json
      - 提取 local_etag（本地内容版本）和 remote_etag（观察到的远端版本）
      - remote_etag 来源：上次消息 envelope.agent_md 或 RPC response _meta
      - 比较 local_etag == remote_etag？
        ├─ 是 → 版本一致，返回 needs_update=false
        └─ 否 → 版本不一致，返回 needs_update=true
      - 30天参数含义：即使 etag 相同，超过 30 天也强制重新下载验证
      ↓
    needs_update == true？
      ├─ 否 → 返回 {changed: false, content: 本地内容}
      └─ 是 ↓
        store.downloadAgentMd(aid)  ← SDK 方法
          ↓
        SDK 执行：
          - 下载 https://<aid>/agent.md
          - 验证签名
          - 写入 ~/.aun/AIDs/<aid>/agent.md
          - 更新 ~/.aun/AIDs/<aid>/agentmd.json:
            local_etag = 新下载的 etag
            remote_etag = 新下载的 etag
            fetched_at = 当前时间
          ↓
        返回 {changed: true, content: 新内容, verification: {...}}
      ↓
    根据 changed 和 content 计算 hash
      ↓
    hash 与 peer-identity.json 记录的一致？
      ├─ 是 → 仅更新 lastCheckedAt
      └─ 否 → 完整更新 peer-identity.json（解析 type/name/hash）
```

**关键理解**：

- **30 天不是缓存有效期**：是强制重检周期
- **etag 是主要判断**：`local_etag != remote_etag` 时立即触发下载
- **双层缓存**：
  - PeerIdentityCache（30天）：EvolClaw 层面，减少 agentmdSync 调用
  - SDK agentmd.json（etag驱动）：SDK 层面，减少网络下载
- **零网络请求场景**：30天内 + etag 未变化

#### 2.3 rules.md 同步机制

**触发条件**：
- 收到群消息
- `agentmdSync(groupId)` 返回 `changed=true`

**执行流程**：

1. 检测到群 agent.md 的 etag 变化
2. 同时并行下载：
   - 群 agent.md（由 `store.downloadAgentMd(groupId)` 完成）
   - 群 rules.md（通过 fs 命令集下载 `<group-aid>:/rules.md`）
3. 写入本地：`$VENUES_DIR/<venueKey>/rules.md`
4. fileCache 的 mtime 策略检测到文件变化，下次 ECK 读取时自动重载

**关键点**：
- **etag 变化即更新**：不检查内容，检测到 etag 变化立即同时下载 agent.md 和 rules.md
- **并行操作**：agent.md 和 rules.md 同时下载（无依赖关系）
- **幂等性**：即使多个 agent 同时下载，最终状态一致
- **SDK 自动记录**：`~/.aun/AIDs/<group-aid>/agentmd.json` 由 SDK 维护，包含完整同步历史

---

### 三、fileCache 自动重载机制

**工作原理**：

1. rules.md 纳入 fileCache，策略为 `policy: 'mtime'`
2. ECK 读取 rules.md 时：
   - fileCache 执行 `statSync(rulesPath)` 获取当前 mtimeMs
   - 与缓存中记录的 mtimeMs 比较
   - 不一致时重新 `readFileSync()` 并更新缓存
3. 同步流程写入新 rules.md 后，文件 mtime 自动改变
4. 下次 ECK 读取时自动触发重载

**集成点**：
- ECK manifest 的 `venue-group-rules` 段通过 fileCache 读取
- 不需要手动调用 `invalidateKitCache()`
- mtime 是文件系统级别的确定性标识

---

## 跨 agent 协调机制

**问题消除**：

1. **信源唯一**：所有 agent 从同一个群 agent.md 读取 etag
2. **自然协调**：
   - etag 未变 → 所有 agent 的 checkAgentMd 都返回 `needs_update=false`，零网络请求
   - etag 变化 → 检测到的 agent 下载，其他 agent 稍后检测到同样的 etag 变化后下载
3. **幂等操作**：多个 agent 同时下载相同版本的 agent.md 和 rules.md，结果一致
4. **无竞态**：只读操作，无写冲突

**效率对比**：

| 场景 | 旧机制（60秒轮询） | 新机制（etag驱动） |
|------|-------------------|-------------------|
| 规则未变化 | 每60秒发起 stat RPC | 零网络请求 |
| 规则变化 | 最多60秒延迟感知 | 下条消息立即感知 |
| 多 agent 环境 | 每个独立轮询，重复请求 | 共享 etag，自然协调 |

---

## envelope 扩展需求

**当前状态**（SDK 已实现）：
```json
{
  "envelope": {
    "from": "alice.aid.pub",
    "group_id": "team.group.aid.pub",
    "agent_md": {
      "sender": {
        "aid": "alice.aid.pub",
        "etag": "\"sha256:sender_etag...\""
      }
    }
  }
}
```

**需要扩展**（待 SDK 实现）：
```json
{
  "envelope": {
    "from": "alice.aid.pub",
    "group_id": "team.group.aid.pub",
    "agent_md": {
      "sender": {
        "aid": "alice.aid.pub",
        "etag": "\"sha256:sender_etag...\""
      },
      "group": {
        "aid": "team.group.aid.pub",
        "etag": "\"sha256:group_etag...\""
      }
    }
  }
}
```

**alternative 方案**：
如果 SDK 短期无法扩展 envelope，EvolClaw 可以在处理群消息时主动调用 `checkAgentMd(groupId)`，SDK 会通过其他机制（如 RPC response `_meta`）获取群 etag。

---

## 与旧机制对比

| 维度 | 旧机制（时间窗口轮询） | 新机制（etag 驱动） |
|------|---------------------|-------------------|
| **触发方式** | 每条消息前检查，60秒缓存 | etag 变化事件驱动 |
| **网络请求** | 规则未变时每60秒一次 | 规则未变时零请求 |
| **感知延迟** | 最多60秒 | 下条消息立即 |
| **信源** | 独立的 _sync/files.json | 群 agent.md（单一事实源） |
| **跨 agent** | 各自独立，无协调 | 共享 etag，自然协调 |
| **缓存管理** | 独立同步逻辑 | fileCache mtime 统一 |
| **写入通知** | 可选的群消息通知 | agent.md etag 自动变化 |

---

## 模块职责分工

### AUN SDK 职责

#### 已实现功能

1. **etag 管理**
   - 每次上传 agent.md 时自动生成新 etag
   - 在 `~/.aun/AIDs/<aid>/agentmd.json` 中维护 `local_etag` 和 `remote_etag`
   - 提供 `checkAgentMd(aid, maxAgeDays)` 方法比较 etag 并返回是否需要更新
   - 提供 `downloadAgentMd(aid)` 方法下载、验签、写入本地

2. **消息 envelope 机制**
   - 私聊消息：在 `envelope.agent_md.sender` 中注入发送者的 etag
   - 通过 RPC response `_meta.agent_md_etag` 提供自身的 etag

3. **同步历史记录**
   - 在 `agentmd.json` 中记录完整的同步状态：
     - `fetched_at`：最后下载时间
     - `checked_at`：最后检查时间
     - `observed_at`：最后观察到 remote etag 的时间
     - `verify_status`：验签状态
     - `remote_status`：远端状态（found/missing/error）

#### 需要扩展功能

1. **群消息 envelope 扩展**
   - 在群消息的 `envelope.agent_md` 中新增 `group` 字段
   - 结构：
     ```json
     {
       "envelope": {
         "agent_md": {
           "sender": {
             "aid": "alice.aid.pub",
             "etag": "\"sha256:...\""
           },
           "group": {
             "aid": "team.group.aid.pub",
             "etag": "\"sha256:...\""
           }
         }
       }
     }
     ```
   - Message Service 在投递群消息前，查询群 aid 的 agent.md etag 并注入 envelope

2. **observeRemoteAgentMdEtag 机制（可选优化）**
   - 提供公开方法供 EvolClaw 显式通知 SDK 观察到的 etag
   - 更新 `agentmd.json` 的 `remote_etag` 和 `observed_at`
   - 使 `checkAgentMd` 能更准确判断是否需要更新

---

### EvolClaw 职责

#### 写入端

1. **rules.md 写入后更新群 agent.md**
   - 检测：`ec fs cp` 的目标路径是否为 `<group-aid>:/rules.md`
   - 读取：群当前的 agent.md（通过 `agentmdGet(groupId)`）
   - 修改：任意字段（例如 `updated_at`）触发 etag 变化
   - 上传：通过 `agentmdPut(groupId, modifiedAgentMd)` 上传新版本
   - 位置：`src/cli/fs-command.ts` 或新建辅助模块

2. **通知机制（可选）**
   - 更新成功后发送群消息通知（`group.rules.updated`）
   - 提供操作者、hash、时间等信息
   - best-effort：失败不影响主流程

#### 读取端

1. **群消息处理入口扩展**
   - 位置：`src/channels/aun.ts` 的 `handleIncomingGroupMessage`
   - 在处理消息内容之前，先同步群 agent.md：
     ```
     PeerIdentityCache.resolve('aun', groupId, selfAgentDir, store)
     ```
   - 检查返回的 `agentmdSync` 结果是否 `changed=true`

2. **rules.md 同步触发**
   - 当群 agent.md 的 etag 变化时，同时下载群 agent.md 和 rules.md
   - agent.md 由 `store.downloadAgentMd(groupId)` 自动下载（agentmdSync 内部调用）
   - rules.md 通过 fs 命令集下载：`<group-aid>:/rules.md`
   - 写入：`$VENUES_DIR/<venueKey>/rules.md`
   - 位置：`src/channels/aun.ts` 或新建 `src/eck/group-rules-sync.ts`

3. **fileCache 集成**
   - 将 rules.md 纳入 fileCache
   - 策略：`policy: 'mtime'`, `group: 'venue-rules'`
   - ECK manifest 通过 fileCache 读取，自动重载
   - 位置：`src/eck/manifest-engine.ts` 或 `src/eck/kit-renderer.ts`

4. **30天缓存管理**
   - 维护：`peer-identity.json` 中的 `lastCheckedAt`
   - 30天内：直接返回缓存，不调用 `agentmdSync`
   - 超过30天：调用 `agentmdSync` 重新检查
   - 位置：`src/core/relation/peer-identity.ts`（已实现）

#### 辅助功能

1. **fs 命令集集成**
   - 确保 `ec fs cp` 支持群资源空间路径：`<group-aid>:/rules.md`
   - 提供下载 API 供读取端调用
   - 位置：`src/cli/fs-command.ts`（已实现）

2. **日志与调试**
   - 记录群 agent.md 同步事件（检查、下载、跳过）
   - 记录 rules.md 同步事件（下载、hash 验证、写入）
   - 提供 `ec debug` 命令查看同步状态

---

### 职责边界

| 职责 | SDK | EvolClaw |
|------|-----|----------|
| **etag 生成与维护** | ✓ | |
| **etag 比较判断** | ✓ | |
| **agent.md 下载** | ✓ | |
| **agent.md 验签** | ✓ | |
| **同步历史记录** | ✓ | |
| **envelope 注入 etag** | ✓ | |
| **检测群 agent.md 变化** | | ✓ |
| **触发 rules.md 同步** | | ✓ |
| **rules.md 下载** | | ✓ |
| **rules.md 写入本地** | | ✓ |
| **fileCache 管理** | | ✓ |
| **30天缓存策略** | | ✓ |
| **写入端更新 agent.md** | | ✓ |

---

### 协作流程

#### 读取端协作

```
EvolClaw: 收到群消息
  ↓
EvolClaw: 调用 PeerIdentityCache.resolve(groupId)
  ↓
EvolClaw: 检查 lastCheckedAt < 30天？→ 否
  ↓
EvolClaw: 调用 agentmdSync(groupId, {store})
  ↓
SDK: store.checkAgentMd(groupId, 30)
SDK: 比较 local_etag vs remote_etag
SDK: 返回 needs_update=true/false
  ↓
needs_update=true？
  ├─ 否 → SDK: 返回 {changed: false} → EvolClaw: 跳过
  └─ 是 ↓
    SDK: store.downloadAgentMd(groupId)
    SDK: 下载、验签、写入本地
    SDK: 更新 agentmd.json (local_etag = remote_etag)
    SDK: 返回 {changed: true, content: 新内容}
      ↓
    EvolClaw: 检测到 changed=true
    EvolClaw: 同时下载群 agent.md 和 rules.md
    EvolClaw: agent.md 已由 SDK 自动下载完成
    EvolClaw: 下载 <group-aid>:/rules.md
    EvolClaw: 写入本地 $VENUES_DIR/<venueKey>/rules.md
    EvolClaw: fileCache 下次读取时自动重载
```

#### 写入端协作

```
EvolClaw: ec fs cp /tmp/rules.md <group-aid>:/rules.md
EvolClaw: 写入成功
  ↓
EvolClaw: 调用 agentmdGet(groupId)
  ↓
SDK: 读取本地或下载群 agent.md
SDK: 返回当前内容
  ↓
EvolClaw: 修改任意字段（例如 updated_at）
EvolClaw: 调用 agentmdPut(groupId, modifiedContent)
  ↓
SDK: 上传 agent.md 到 https://<groupId>/agent.md
SDK: 重新签名
SDK: 生成新 etag
SDK: 更新本地 agentmd.json (local_etag = 新etag)
SDK: 返回成功
```

---

### 实施优先级

#### P0 - 核心功能（必须）

1. **EvolClaw 写入端**：rules.md 写入后更新群 agent.md
2. **EvolClaw 读取端**：群消息处理时同步群 agent.md 和 rules.md
3. **fileCache 集成**：rules.md 纳入 mtime 策略

#### P1 - 性能优化（推荐）

1. **SDK envelope 扩展**：群消息携带群 etag（减少一次 RPC）
2. **EvolClaw 日志增强**：详细记录同步事件便于调试

#### P2 - 增强功能（可选）

1. **SDK observeRemoteAgentMdEtag**：显式通知机制
2. **EvolClaw 写入通知**：rules.md 更新后发送群消息
3. **ec debug 命令**：查看同步状态和历史

---

## 总结

### 核心优势

1. **单一触发信号**：群 agent.md 的 etag 变化作为 rules.md 同步的触发信号
2. **事件驱动**：etag 变化触发，无无效轮询
3. **自动重载**：fileCache mtime 机制，无需手动失效
4. **去中心化**：每个 agent 独立同步，通过 etag 自然协调
5. **SDK 托管**：同步历史由 SDK 自动维护在 agentmd.json

### etag 机制的本质

- etag 是 SDK 内部用于判断版本的标识
- EvolClaw 不直接操作 etag，只调用 `checkAgentMd()` 和 `downloadAgentMd()`
- SDK 通过比较 `local_etag` 和 `remote_etag` 决定是否需要下载
- 30天强制重检是兜底机制，防止 etag 机制失效
- 群 agent.md 不需要记录 rules.md 的版本信息，etag 变化即触发同步

### 依赖关系

- **SDK 已提供**：checkAgentMd、downloadAgentMd、agentmdPut、etag 机制
- **EvolClaw 需实现**：写入端更新 agent.md、读取端检测变化并同步 rules.md
- **待 SDK 扩展**（可选）：envelope 携带群 etag

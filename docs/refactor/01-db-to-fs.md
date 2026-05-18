# 改造方案 1：sessions 数据库迁移到文件系统

## 目标与动机

把 `~/.evolclaw/data/sessions.db`（SQLite）整体替换为 `~/.evolclaw/data/sessions/` 下的 JSON / JSONL 文件树。

为什么做：

-   让 agent 用 `Read / Glob / Grep` 直接观测和检索运行时状态，不需要专属查询命令（`/slist`、`/status` 等大量 read 命令可以原子化掉）。
-   让运维用 `cat / jq / git diff` 直接看到底发生了什么，不再"看不见的 sqlite 黑盒"。
-   配合下一步命令体系收敛——状态既然在文件里，DB 相关的工具就不再是工具集的一部分。

不做：sessions 的修改路径**不**改成 agent 直接 Edit JSON——session 删除/改名涉及 jsonl 文件 + 索引 + 流中断的多方协同，让 agent 写文件就一定写坏。**修改仍走 daemon**，daemon 内部从 SQL 改成读写 JSON。

## 现状盘点

### 仅 `sessions` 表在用

数据库里有三张表，**只有** `sessions` **表是活的**：

-   `sessions` — 会话元数据（核心）
-   `session_health` — 健康/safe-mode（**废弃**，相关代码需清理）
-   `processed_messages` — 消息去重（**废弃死表**，代码里只有 CREATE，没有任何 INSERT/SELECT；各 channel 的去重都在内存 Map 做）

### sessions 表字段

| 字段 | 类型 | 作用 | 何时被修改 |
| --- | --- | --- | --- |
| id | TEXT PK | 会话唯一标识 | 创建时写入，不再变 |
| channel | TEXT | channel 实例名（如 aun_main、feishu_main） | 创建时写入；启动迁移可能回填 |
| channel_id | TEXT | chat 标识（飞书 chat_id、AUN aid/group_id 等） | 创建时写入，不再变 |
| agent_id | TEXT | agent 后端类型（claude/codex/hermes/gemini） | 创建时写入，不再变 |
| thread_id | TEXT | 话题 ID;空串=主会话 | 创建时写入,不再变 |
| chat_type | TEXT | private / group | 创建时写入;入站消息发现不一致时自动修正 |
| session_mode | TEXT | interactive / proactive | 创建时写入;/chatmode 修改 |
| project_path | TEXT | 项目目录绝对路径 | 创建时写入,不再变 |
| agent_session_id | TEXT NULL | agent 后端的 session uuid | 首次 agent 响应时写入;session 文件丢失时清 NULL |
| name | TEXT NULL | 用户可见名称 | 创建时写入;/rename 修改 |
| processing_state | TEXT NULL | 处理中标记 "timestamp:taskId" | 任务开始/结束 |
| metadata | TEXT (JSON) | 杂项 JSON（见下） | 多种场景 |
| created_at | INTEGER | 创建时间戳 | 创建时写入 |
| updated_at | INTEGER | 最近修改时间戳 | 每次 UPDATE 都刷新 |
| deleted_at | INTEGER NULL | 软删时间戳 | softDeleteSession 时写入 |

**metadata 子字段**：`isActive`（活跃标记）/ `peerId` / `peerName` / `channelName` / `permissionMode` / `replyContext`。

### sessions 表的核心功能

**入站消息路由**：消息进来带 `(channel, channelId, threadId?)`，需要找到对应的 `agent_session_id`，让 agent 后端 resume 对话。

其它都是辅助：`/slist` 列出历史、`/s` 切换、`/rename` 改名、`/new` 新建。**热路径只有一条**：消息来了 → 找 active session → 拿 agentSessionId。

### 调用面

`session-manager.ts` 内 79 处 `this.db.*` 调用，集中在约 40 个 public/private 方法。其它仅 `cli.ts`、`migrate-project.ts`、`paths.ts`、`init.ts` 间接读到路径或迁移逻辑。**爆炸半径几乎全在 session-manager.ts**。

## 核心概念澄清

### "chat" 是什么

`(channel, channelId)` 唯一确定一个 chat。例如：

-   `("feishu_main", "oc_abc123")` — 飞书某个群或私聊
-   `("aun_main", "alice.agentid.pub")` — AUN 跟 Alice 的私聊

**一个 chat 可以有多个 session**（不同项目、不同 agent、历史会话），但**同一时刻只有一个 active**。

### 三种"消息历史"概念分清

文件方案里要存的不是消息内容。容易混淆，先把概念拆清：

| 存储 | 内容 | 谁管 |
| --- | --- | --- |
| agent SDK 的 jsonl | 用户/agent 完整对话历史。Claude SDK 写在 ~/.claude/projects/{encodedPath}/{agentSessionId}.jsonl；Codex/Gemini/Hermes 各自有自己的位置 | agent SDK 自管，evolclaw 不写不删 |
| logs/messages.log | evolclaw 自己的入站消息日志 | 全局一个文件，调试用 |
| 本方案的 meta_*.jsonl | 一个 session 的元数据演化档案。不是消息历史 | 本次改造引入 |

文件名前缀用 `meta_`（不是 `s_`）就是为了和 agent SDK 的"消息 jsonl"做明确区分——读到这名字就知道里面是元数据，不是对话内容。

## 目标布局

```
~/.evolclaw/data/sessions/
├── aun/                                              ← AUN 三层：channelType/selfId/channelId
│   └── <urlEncode(selfId)>/
│       └── <urlEncode(channelId)>/                   ← AUN 私聊 channelId=peerAID；群聊=groupId
│           ├── active.json
│           ├── task.lock
│           ├── health.jsonl
│           ├── meta_*.jsonl
│           ├── _threads/
│           ├── _index/
│           └── _trash/
│
├── feishu/                                           ← 其它 channel 两层
│   └── <urlEncode(channelId)>/
│       └── ...（同 active.json/meta_*.jsonl 等）
│
├── wechat/
│   └── <urlEncode(channelId)>/
│       └── ...
│
└── ... (dingtalk/qqbot/wecom)
```

### 目录命名规则

- 顶层目录是 `channelType`（`aun`/`feishu`/`wechat`/`dingtalk`/`qqbot`/`wecom`）
- AUN 因协议特性（多对端身份），加一层 `selfId`：`aun/{selfId}/{channelId}/`
- 其它 channel 直接：`{channelType}/{channelId}/`
- channelId 和 selfId 使用 URL 百分号编码处理跨平台非法字符（`<>:"/\|?*` + 控制字符 + `%`）
- AUN 私聊 `channelId=peerAID`（不再用 SDK 三段式 `aid:device:slot` ——多 device 跨端共享同一会话）
- AUN 群聊 `channelId=groupId`（如 `group.issuer/grp_001`，含 `/` 编码为 `%2F`）

### 设计要点

-   **chat 目录**：一个 (channel, channelId) 一个目录，目录名 `{channel}__{channelId}`（双下划线分隔）
-   **active.json = 指针 + 元数据**：当前活跃 session 的完整快照，热路径只读这个。**不含运行时瞬态**
-   **task.lock = 运行时任务状态**：JSONL 格式，任务开始时清空并写入，每次工具调用完成追加一行，任务结束时删除
-   **health.jsonl = 健康状态记录**：append-only，每条消息处理完追加一行（success/error/reset）。用于诊断和错误计数
-   **meta_*.jsonl = 历史档案**：每个 session 一个文件，append-only。每行一份完整快照（不是消息历史）
-   `_threads/`：话题独立路由。话题 session 的 jsonl 与主会话同名规则（meta_*.jsonl），`thread-index.json` 维护 threadId → 文件名的映射
-   `_index/`：反查索引（by-name / by-project / by-agent），daemon 写文件时同步维护
-   `_trash/`：软删暂存，启动时自动清理超过 30 天的文件

### 为什么用 jsonl

active.json 万一损坏，能从该 session 的 jsonl 倒推恢复。jsonl 一行 = 该 session 某一时刻的完整状态快照。最后一行 = 当前状态。

## 字段定义（active.json 与 meta_*.jsonl 完全对齐）

**关键约束**：active.json 与 meta_*.jsonl 每一行的字段完全一致。jsonl 任意一行单独读出来，应该等同于一个完整的 active.json。

### 字段表

| 字段 | 类型 | 取值 | 说明 |
| --- | --- | --- | --- |
| id | string | meta_{YYYYMMDD}_{epochMs}（等于文件名 stem） | 会话标识 = 文件名（不含 .jsonl 后缀）。文件名为真相，id 是冗余自描述 |
| channel | string | 如 aun_main、feishu_main | channel 实例名 |
| channelId | string | 如 oc_abc123、alice.agentid.pub | chat 标识（与目录名第二段一致） |
| selfId | string \| null | 如 alice.agentid.pub、bot_open_id | 本地身份（AUN 本地 AID / 飞书 bot_open_id 等）；老 session 迁移时为 null，下次消息进来自动补上 |
| agentType | string | claude \| codex \| hermes \| gemini | agent 后端类型（原 agentId，改名以反映"类型"语义） |
| threadId | string | 话题 ID 或 "" | 空串表示主会话（保留空串语义而非 null，与 channel 上游一致） |
| chatType | string | private \| group |  |
| chatMode | string | interactive \| proactive | 原 sessionMode，改名对齐 /chatmode 命令 |
| projectPath | string | 绝对路径 | 项目工作目录 |
| agentSessionId | string \| null | agent 后端 session uuid | resume 对话用 |
| name | string \| null | 用户可见名 |  |
| permissionMode | string | auto \| bypass | 权限模式 |
| metadata | object | 见下方 | channel 特有字段容器（不同 channel 可以有不同内容） |
| createdAt | number | epoch ms |  |
| createdAtStr | string | YYYY-MM-DD HH:mm:ss（本地时区） | 人类可读时间戳，与文件名时区一致 |
| updatedAt | number | epoch ms |  |
| updatedAtStr | string | YYYY-MM-DD HH:mm:ss（本地时区） | 人类可读时间戳 |

### metadata 子字段

`metadata` 保留为嵌套层，作为 channel 特有字段的容器。不同 channel 有不同的东西都往里面写。

**通用字段**（所有 channel 都可能有）：

| 子字段 | 类型 | 说明 |
| --- | --- | --- |
| peerId | string \| null | 对端 userId（飞书 ou_xxx、AUN aid、微信 from_user_id） |
| peerName | string \| null | 对端显示名 |
| replyContext | object \| null | 回复上下文 { replyToMessageId, replyInThread } |

**channel 特有字段**（按需写入，其它 channel 不关心）：

各 channel 可以自由往 metadata 里加字段，不需要改 schema。例如未来某 channel 需要存 `groupTopic`、`botRole` 等，直接写进 metadata 即可。

### 字段命名变更对照（与原 SQL 对齐）

| 原 SQL 字段 | 新字段 | 备注 |
| --- | --- | --- |
| agent_id | agentType | 它表示后端类型，不是 id |
| session_mode | chatMode | 对齐 /chatmode 命令 |
| processing_state | （移除，改为独立 task.lock 文件） | 不再是 session 元数据的一部分 |
| metadata.peerId | metadata.peerId | 保留在 metadata 层，字段名不变 |
| metadata.peerName | metadata.peerName | 保留在 metadata 层 |
| metadata.channelName | （删除） | 与顶层 channel 重复 |
| metadata.permissionMode | permissionMode | 提到顶层（所有 channel 通用） |
| metadata.replyContext | metadata.replyContext | 保留在 metadata 层 |
| metadata.isActive | （删除） | 由 active.json 指针决定，不再是字段 |
| deleted_at | （删除） | 删除即删文件，无需字段标记 |

### 值规范

-   **时间戳**：毫秒数（INTEGER）+ `*Str` 字段（`YYYY-MM-DD HH:mm:ss` 本地时区）
-   **空值**：`null`（不用 `undefined`、不用空串；例外是 `threadId` 主会话用 `""`，与 channel 上游语义一致）
-   **枚举**：固定字符串值
    -   `chatType`: `"private"` | `"group"`
    -   `chatMode`: `"interactive"` | `"proactive"`
    -   `permissionMode`: `"auto"` | `"bypass"`
    -   `agentType`: `"claude"` | `"codex"` | `"hermes"` | `"gemini"`

### active.json 完整示例

```json
{
  "id": "meta_20240521_1715740800000",
  "channel": "aun_main",
  "channelId": "alice.agentid.pub",
  "selfId": "self.agentid.pub",
  "agentType": "claude",
  "threadId": "",
  "chatType": "private",
  "chatMode": "interactive",
  "projectPath": "C:/Users/agentcp/.../evolclaw",
  "agentSessionId": "8a3f-...-uuid",
  "name": "默认会话",
  "permissionMode": "auto",
  "metadata": {
    "peerId": "alice.agentid.pub",
    "peerName": "Alice",
    "replyContext": null
  },
  "createdAt": 1715740800000,
  "createdAtStr": "2024-05-21 10:00:00",
  "updatedAt": 1715783280000,
  "updatedAtStr": "2024-05-21 20:28:00"
}

```

### meta_*.jsonl 示例（每行结构与 active.json 完全一致）

```jsonl
{"id":"meta_20240521_1715740800000","name":"默认会话","agentSessionId":null,"createdAt":1715740800000,"createdAtStr":"2024-05-21 10:00:00","updatedAt":1715740800000,"updatedAtStr":"2024-05-21 10:00:00",...}
{"id":"meta_20240521_1715740800000","name":"默认会话","agentSessionId":"uuid-1","createdAt":1715740800000,"createdAtStr":"2024-05-21 10:00:00","updatedAt":1715740900000,"updatedAtStr":"2024-05-21 10:01:40",...}
{"id":"meta_20240521_1715740800000","name":"CLI开发","agentSessionId":"uuid-1","createdAt":1715740800000,"createdAtStr":"2024-05-21 10:00:00","updatedAt":1715783280000,"updatedAtStr":"2024-05-21 20:28:00",...}

```

第 1 行：创建时；第 2 行：agent 首次响应（agentSessionId 写入）；第 3 行：`/rename`。

### `_threads/thread-index.json`

```json
{
  "om_thread123": "meta_20240522_1715741000000",
  "om_thread456": "meta_20240523_1715742000000"
}

```

threadId → meta 文件名 stem。话题消息进来时先查这个 index 找对应文件。

## 创建 / 修改 / 删除时机

### 创建（新建 session 时）

下面这些场景，会在 chat 目录下新建一个 `meta_*.jsonl` 文件，append 第一行（初始 metadata 快照），同时覆写 `active.json` 指向它：

| 触发 | 来源方法 |
| --- | --- |
| 首次收到某 chat 消息（无任何 session） | getOrCreateSession |
| 话题首次出现 | getOrCreateThreadSession（同时写 thread-index.json） |
| /new [名称] | createNewSession |
| /p <path> 切到的项目无 session | switchProject |
| /agent <name> 切到的 agent 无 session | switchAgent |
| /fork | createForkedSession |
| CLI 会话导入 | importCliSession |

### 修改

每次修改都 **先 append 新行到 jsonl，再覆写 active.json**。

| 场景 | 改动字段 | 写入动作 |
| --- | --- | --- |
| 切换活跃会话（/s、/p、/agent） | active 指向变化 | 目标 jsonl append 一行 → 覆写 active.json（旧 session 文件不动） |
| agent 首次响应返回 session uuid | agentSessionId | append jsonl + 覆写 active.json |
| /rename | name | append jsonl + 覆写 active.json |
| /chatmode | chatMode | append jsonl + 覆写 active.json |
| /perm | permissionMode | append jsonl + 覆写 active.json |
| 入站修正 chatType | chatType | append jsonl + 覆写 active.json |
| 旧会话补 metadata.peerId/peerName | metadata 字段 | append jsonl + 覆写 active.json |
| session jsonl 文件丢失 | agentSessionId = null | append jsonl + 覆写 active.json |

### 切换 active 的写入序列（澄清）

`/s`、`/p`、`/agent`、`/new` 等切换操作**不需要"标记旧 session 不再 active"**——active.json 本身就是"哪个 session 是 active"的唯一指针，覆写它就完成了切换。

写入序列：

```
1. 目标 session jsonl append 一行（如有 metadata 变化；切换本身不算变化时可跳过）
2. 覆写 active.json 为目标 session 的快照

```

**不动旧 session 的文件**。这是 active.json 作为"指针"语义的体现。

## task.lock — 任务执行状态文件

### 定位

`task.lock` 是独立于 session 元数据的**运行时瞬态文件**。它不属于 active.json，也不进 meta_*.jsonl。

作用：

1.  标记当前 chat 是否有任务在跑
2.  记录每次工具调用完成的时间（用于中断策略判断）
3.  崩溃恢复时判断是否有未完成的任务

### 文件格式（JSONL）

```jsonl
{"type":"start","sessionId":"meta_20240521_xxx","taskId":"msg-abc123","startedAt":1715783280000,"startedAtStr":"2024-05-21 20:28:00"}
{"type":"call","tool":"Read","description":"src/index.ts","completedAt":1715783285000,"completedAtStr":"2024-05-21 20:28:05"}
{"type":"call","tool":"Edit","description":"src/config.ts","completedAt":1715783290000,"completedAtStr":"2024-05-21 20:28:10"}
{"type":"call","tool":"Bash","description":"npm run build","completedAt":1715783320000,"completedAtStr":"2024-05-21 20:28:40"}

```

-   第一行固定是 `type: "start"`，标记任务开始
-   后续每行是 `type: "call"`，每次工具调用完成时 append
-   任务正常结束 → **删除整个文件**（unlink）

### 生命周期

| 时机 | 操作 |
| --- | --- |
| 任务开始 | 清空文件（truncate）并写入 start 行 |
| 每次工具调用完成 | append 一行 call 记录 |
| 任务正常结束 | 删除 task.lock（unlink） |
| 任务被中断（新消息触发 interrupt） | 删除 task.lock → 新任务开始 → 创建新 task.lock |

### 中断策略（基于 task.lock）

新消息进来时，检查 `task.lock` 是否存在：

| chatType | task.lock 存在？ | 策略 |
| --- | --- | --- |
| private | 是 | 立即中断——私聊用户发新消息意味着要打断当前任务 |
| private | 否 | 正常处理 |
| group | 是 | 读最后一行的时间戳，判断距今是否超过 10 分钟 |
| group（未超时） | — | FIFO 排队等待——当前任务还在正常跑 |
| group（已超时） | — | 中断——最后一次调用超过 10 分钟，认为任务卡死/失败 |
| group | 否 | 正常处理 |

为什么群聊不立即中断：群里多人发消息是常态，不应该每条消息都打断正在跑的任务。只有任务明显卡死（10 分钟无新调用完成）才中断。

### 异常场景与清理

| 异常 | 后果 | 处理 |
| --- | --- | --- |
| daemon 崩溃，task.lock 残留 | 下次启动时发现 | 启动时检查最后一行时间戳，超过 15 分钟 → 删除（认为任务超时失败） |
| task.lock 没写成功（磁盘满等） | 新消息不知道有任务在跑 | 无害——退化为串行处理（当前任务跑完才处理新消息），不会数据损坏 |
| task.lock 被人手动删了 | daemon 以为没任务在跑 | 无害——不影响正在跑的任务本身，只是 interrupt 判断失效 |
| task.lock 最后一行损坏 | 无法读取时间戳 | 用倒数第二行；全部损坏 → 删除文件，按"无任务"处理 |

**核心原则**：task.lock 丢了或残留都**不会导致数据损坏**，最多影响中断时机。它是"尽力而为"的状态标记。

## health.jsonl — 健康状态记录

### 定位

`health.jsonl` 记录每条消息处理的最终结果（成功/失败/重置），用于：

1. `/status` 展示连续错误计数和最后成功时间
2. `/repair` 后写入 reset 标记归零计数
3. 未来可能的 safe mode 触发（当前已禁用）

### 文件格式（JSONL，append-only）

```jsonl
{"type":"success","sessionId":"meta_20240521_xxx","agentType":"claude","agentName":"secretary","durationMs":12340,"at":1715783280000,"atStr":"2024-05-21 20:28:00"}
{"type":"error","sessionId":"meta_20240521_xxx","agentType":"claude","agentName":"secretary","errorType":"infra:timeout","error":"Request timed out after 120s","durationMs":120000,"at":1715783400000,"atStr":"2024-05-21 20:30:00"}
{"type":"error","sessionId":"meta_20240521_xxx","agentType":"claude","agentName":"secretary","errorType":"agent:max_turns","error":"任务执行失败","durationMs":45000,"at":1715783450000,"atStr":"2024-05-21 20:30:50"}
{"type":"success","sessionId":"meta_20240521_xxx","agentType":"claude","agentName":"secretary","durationMs":8200,"at":1715783500000,"atStr":"2024-05-21 20:31:40"}
{"type":"reset","sessionId":"meta_20240521_xxx","reason":"repair","at":1715783600000,"atStr":"2024-05-21 20:33:20"}
```

行类型：

| type | 含义 | 字段 |
| --- | --- | --- |
| `success` | 消息处理成功 | sessionId, agentType, agentName, durationMs, at, atStr |
| `error` | 消息处理失败 | sessionId, agentType, agentName, errorType, error, durationMs, at, atStr |
| `reset` | `/repair` 手动重置 | sessionId, reason, at, atStr |

### 生命周期

| 时机 | 操作 |
| --- | --- |
| 每条消息处理成功 | append `type:"success"` |
| 每条消息处理失败（基础设施/agent 系统错误） | append `type:"error"` |
| `/repair` 命令 | append `type:"reset"` |

注意：不是所有错误都记录——上下文过长、认证错误、API 暂时性错误等不累计（与现有逻辑一致）。

### 读取方式

从文件尾部往前扫：

- **consecutiveErrors**：从最后一行往前数连续 `type:"error"` 的行数（遇到 `success` 或 `reset` 停止）
- **lastSuccessAt**：最后一条 `type:"success"` 的 `at`
- **lastError / lastErrorType**：最后一条 `type:"error"` 的内容

### 清理策略

**长期保留，不清理**。理由：

- 一条消息一行，一天几十行顶天，一年也就万行级别（< 1MB）
- 有时间戳，未来可按任意时间窗口聚合统计（日/周/月成功率、平均耗时、错误分布等）
- 是 per-chat 维度的运营数据，删了就没了

### 与原 session_health 表的对照

| 原 DB 操作 | 文件方案 |
| --- | --- |
| `recordSuccess(sessionId)` | append `{"type":"success",...}` |
| `recordError(sessionId, type, msg)` | append `{"type":"error",...}` |
| `getHealthStatus(sessionId)` | tail 文件，从后往前扫计算 |
| `resetHealthStatus(sessionId)` | append `{"type":"reset",...}` |
| `setSafeMode(sessionId, enabled)` | **删除**（safe mode 从未启用） |
| `getSafeModeSessionCount()` | **删除**（从未被调用） |

## 删除

| 场景 | 操作 |
| --- | --- |
| /del（unbindSession，硬删） | mv meta_xxxx.jsonl 到 _trash/；若删的是 active，根据剩余 session 选最新或清空 active.json；同步清理 _index/ 和 _threads/thread-index.json |
| softDeleteSession（群解散等，目前未实际调用） | 整个 chat 目录 mv 到 _trash/ |

`_trash/` 启动时自动清理超过 30 天的文件。

## 老 session 文件什么时候有用

新建会话后，热路径不再读旧文件——active.json 直接指向新 session。但旧 jsonl 仍有这些用途：

| 场景 | 怎么用 |
| --- | --- |
| /slist 列历史 | readdir chat 目录列出 meta_*.jsonl，每个文件 tail 最后一行展示 name/updatedAt |
| /s <名称> 切回旧会话 | 通过 _index/by-name.json 找到目标文件 → tail 最后一行 → 写入 active.json |
| /p <项目> 切项目 | 通过 _index/by-project.json 找候选 |
| /agent <name> 切 agent | 通过 _index/by-agent.json 找候选 |
| /fork 分支 | 读源 session 最后一行作为分支起点 |
| active.json 损坏恢复 | 取该 chat 目录下 updatedAt 最大的 jsonl，tail 最后一行重建 |

**关键认知**：evolclaw 的 `meta_*.jsonl` 是"指针 + 元数据"，它的价值是**让用户能切回去继续聊**——指引到 agent SDK 的 jsonl（真正的对话历史）。如果用户从来不切回，旧文件就是冷档案。

## 一致性策略

SQLite 给的是**单写者 + 事务 + 索引**。文件方案等价物：

| SQLite 提供 | 文件方案对应 |
| --- | --- |
| 事务原子性 | 写时改名：write tmp + fsync + rename |
| 单写者 | daemon 进程独占写，agent 只读 |
| 索引 | _index/ 文件 + 每次访问从文件读取 |

### active.json 写入的原子性

为保证跨平台原子性（特别是 Windows 上 `fs.rename` 对存在目标的覆盖行为不可靠），active.json 的写入序列：

```
1. 写新内容到 active.json.tmp（fsync）
2. 删除旧 active.json（如果存在）
3. rename active.json.tmp → active.json

```

任何一步崩溃，恢复策略：

-   只有 `.tmp` 没有正式文件 → 从 jsonl 倒推
-   只有正式文件没有 `.tmp` → 正常状态
-   两个都有 → 取 `.tmp` 内容（最后写入），删旧版

### 写入顺序：先 jsonl 后 active.json

每次永久状态变化的写入序列：

```
1. meta_*.jsonl append（带 fsync，历史不能丢）
2. active.json 覆写（按上面 .tmp + rename 流程）

```

为什么先 jsonl 后 active：jsonl 是历史真相源，先落盘保证灾难时能从历史倒推。

### 崩溃恢复

启动时全扫 `sessions/*/active.json`，对每条做完整性校验：

1.  文件能正常 parse？
2.  id 字段对应的 `meta_*.jsonl` 存在？
3.  active.json 的 `updatedAt` 与 jsonl 最后一行一致或更早？

任何一条不满足 → 取该 chat 目录下 `updatedAt` 最大的 jsonl，tail 最后一行重建 active.json。无 jsonl 的 chat 视为无活跃会话，下次消息按"无会话"流程新建。

### jsonl 行损坏的容错

JSONL 逐行解析时遇到不可 parse 的行：

-   skip 该行 + warn log（包含 chat 目录、文件名、行号）
-   最后一行损坏 → 用倒数第二行
-   文件全部损坏 → 该 session 视为不可恢复，但文件保留供人工分析（不自动删除）

### 冲突避免

-   daemon 是唯一写者，agent / CLI 通过 IPC 请求修改，不绕过 daemon 写文件
-   daemon 未运行时 CLI 直接写文件 OK（无并发）；daemon 启动时全扫一次重建索引
-   agent 直接 Read 没有冲突问题（最坏读到刚被覆盖前的旧版本，原子 rename 保证不会读到半个文件）
-   多 daemon 实例不允许（已有 PID 文件保证）

### 内存索引规则

**不维护内存索引**——每次读都是文件 IO（active.json + 必要时 _index/*.json）。

理由：

-   14 个 chat × 1 次 active.json 读 = 14 次 fs.readFile，毫秒级
-   内存与文件双源容易状态分裂，调试困难
-   文件读已经够快，没必要优化
-   规模上去（1000+ chat）再考虑加内存层

唯一需要内存的：daemon 启动时一次性扫描 `_trash/` 清理 30 天前文件。

## id 与文件名的关系

-   **文件名是真相**：`meta_{YYYYMMDD}_{epochMs}.jsonl`，文件名 stem 就是 `id`
-   jsonl 内部冗余 `id` 字段做自描述
-   启动时校验 `path.basename(file, '.jsonl') === content.id`
-   不一致时 → 以文件名为准，warn log 提示用户被改动过

## 改造步骤

按"先双写、后切读、再删 SQL"三阶段，每阶段独立可回退。

### 阶段 A：双写并行（功能不变，多写一份到文件）

| 步骤 | 内容 | 风险 |
| --- | --- | --- |
| A1 | 新建 src/core/session/session-fs-store.ts，封装 read/write/append/delete/scan 等基础操作 | 低 |
| A2 | session-manager.ts 每个写操作（insertSession、updateSession、renameSession、unbindSession、createForkedSession 等）在 SQL 写完后追加调用 fs-store 写 | 低（不影响读路径） |
| A3 | 启动时如果 data/sessions/ 不存在，从现有 sessions.db 一次性 dump 出来 | 中（迁移正确性） |
| A4 | 清理 session_health 和 processed_messages 相关代码 + Schema | 低（已废弃） |

阶段 A 一次性迁移：先按计划把代码写完跑起来，迁移成功就成功，出错回到 db 兜底（db 不删）。

### 阶段 B：读路径切换

| 步骤 | 内容 |
| --- | --- |
| B1 | 把 getActiveSession / listSessions / getSessionById / getThreadSession / getSessionByName / getSessionByProjectPath 切到 fs-store |
| B2 | 同步维护 _index/ 反查索引文件 |
| B3 | 写操作仍双写，读操作只走文件 |
| B4 | 加 EVOLCLAW_STATE_BACKEND=sqlite 环境变量做紧急回退开关 |

跑 1 个 release + 至少 3 天无 diff，进 C。

### 阶段 C：拆掉 SQLite

| 步骤 | 内容 |
| --- | --- |
| C1 | 移除 SQL 写代码，session-manager 内只剩 fs-store |
| C2 | 启动时若发现旧 sessions.db 就备份到 data/sessions.db.bak.<ts>（不删，留作兜底） |
| C3 | 移除 node:sqlite 引用 |
| C4 | 文档同步：CLAUDE.md / README / docs/architecture |

## 性能与边界

-   **session 数量级**：当前 14 sessions。即便涨到 10K，单 chat 目录文件数仍在 ext4/NTFS 舒适区
-   **写频率**：active.json 只在永久状态变化时覆写（rename/agentSessionId/chatMode 等），频率很低；task.lock 每次工具调用 append 一行（高频但轻量，且任务结束即删）
-   **fsync 策略**：meta_*.jsonl append 走 fsync（历史不能丢）；active.json 通过 .tmp + rename 保证原子；task.lock 不需要 fsync（丢了不致命）
-   **热路径 IO**：消息进来 → 1 次 read（active.json）→ 拿到全部信息；中断判断 → 1 次 read（task.lock 最后一行）

## 验收标准

-   所有现有 vitest 通过（特别是 session-manager 相关 test）
-   `evolclaw status` 在阶段 B 之后能从纯 fs 读出全部信息
-   关 daemon → 改 `data/sessions/{chat}/active.json` 的 `name` 字段 → 启动 daemon → `/status` 显示新名（验证人工编辑可用）
-   删除 `active.json` → 启动 daemon → 从 jsonl 自动恢复（验证灾难恢复）
-   把 jsonl 中间一行改坏 → 启动 daemon → warn log + 跳过损坏行（验证容错）
-   agent 从聊天里发 `Glob ~/.evolclaw/data/sessions/*/active.json` 能列出所有活跃 session（验证自描述）
-   阶段 C 后 `node_modules` 里没有 sqlite 相关二进制依赖（验证彻底拆除）

## 已确认的设计决策

| # | 问题 | 决策 |
| --- | --- | --- |
| 1 | health/processing_state 拆出来还是合并 | processing_state 独立为 task.lock 文件；health 废弃删除 |
| 2 | processed_messages 是否保留 | 删掉，是死表 |
| 3 | session_health 是否保留 | 删掉，相关代码同步清理 |
| 4 | active.json 是否冗余 agentSessionId 等完整信息 | 冗余——一次读拿全 |
| 5 | session 文件用 json 还是 jsonl | jsonl——append-only，灾难时可倒推 |
| 6 | session 文件名 | meta_{YYYYMMDD}_{epochMs}.jsonl（年份避免跨年混淆，前缀 meta_ 避免与 SDK jsonl 混淆） |
| 7 | chat 目录命名 | {channel}__{channelId} 双下划线分隔 |
| 8 | 任务状态如何存储 | 独立 task.lock JSONL 文件：任务开始清空写入，每次调用完成 append，任务结束删除 |
| 9 | 字段名优化 | agentId→agentType / sessionMode→chatMode / metadata 保留为 channel 特有字段容器（peerId/peerName/replyContext 留在 metadata 内）/ channelName 删除 / permissionMode 提到顶层 |
| 10 | 时间戳 | 毫秒数 + *Str 字符串字段（YYYY-MM-DD HH:mm:ss 本地时区） |
| 11 | id 与文件名关系 | 文件名为真相，id 字段冗余且 = 文件名 stem |
| 12 | 切换 active 的写入序列 | 不动旧 session 文件，只覆写 active.json（必要时新 session jsonl append 一行） |
| 13 | active.json 写入原子性 | 跨平台用 .tmp 文件 + 删旧 + rename |
| 14 | 内存索引 | 不要，每次读文件，简单且无状态分裂 |
| 15 | _trash 清理 | 启动时自动清理 30 天前文件 |
| 16 | _threads 命名 | thread session 用与主会话一致的 meta_*.jsonl 命名，thread-index.json 维护 threadId 反查 |
| 17 | _index 反查 | 维护 by-name / by-project / by-agent 三个索引文件 |
| 18 | jsonl 行损坏容错 | 逐行 parse，损坏行 skip + warn |
| 19 | dump 验证 | 一次性迁移到位，db 保留作兜底；无 diff 校验 |
| 20 | sessions.db 拆除时机 | 阶段 C 备份不删 |
| 21 | 中断策略 | 私聊：立即中断；群聊：task.lock 最后一行超过 10 分钟才中断，否则 FIFO 等待 |
| 22 | task.lock 启动清理 | 最后一行时间戳超过 15 分钟 → 删除（认为任务超时失败） |
| 23 | session_health 文件化 | 独立 health.jsonl（append-only），每条消息处理完追加一行；附带 agentType/agentName/durationMs；safe_mode 功能删除 |
| 24 | health.jsonl 清理 | 长期保留不清理（per-chat 运营数据，一年 < 1MB） |

## 后续可优化（不在本次范围）

-   长期清理：超过 N 个月未访问的 jsonl mv 到 `_trash/`
-   chat 目录数量过大时按 channel 分片
-   引入内存缓存层（仅当文件读成为瓶颈时）

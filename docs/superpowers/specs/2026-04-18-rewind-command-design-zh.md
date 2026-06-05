# `/rewind` 命令设计文档

日期：2026-04-19

## 概述

一个多功能快捷指令：
1. 查看当前 Claude 会话的对话历史（仅用户输入）
2. 回退到指定轮次，支持三种回退模式：仅对话、仅文件、全部

仅限 Claude 后端。其他后端执行时返回不支持提示。

## 命令语法

```
/rewind              → 显示对话轮次列表（仅用户消息）
/rw                  → /rewind 的简写

/rewind <N> chat     → 仅对话回退（下次发言从第 N 轮继续，后续对话丢弃）
/rewind <N> file     → 仅文件回退（立即恢复磁盘文件到第 N 轮时的状态）
/rewind <N> all      → 对话 + 文件全部回退

/rewind <N>          → ❌ 缺少回退模式，提示用法
```

**无默认模式**——`/rewind 3` 不带模式参数时不执行回退，而是提示：
```
❌ 请指定回退模式：/rewind 3 chat | file | all
```
这样可以避免误操作。

## 输出格式

### 历史列表（`/rewind`）

```
📋 会话历史 (共 6 轮)

#1 帮我写一个排序算法
#2 改成归并排序
#3 加上单元测试
#4 测试跑不过，帮我修一下
#5 加一个 benchmark
#6 把结果写到 README

💡 /rewind <N> chat|file|all
```

每行显示：序号 + 用户消息截断至 50 字。

### 对话回退（`/rewind 3 chat`）

```
✅ 已标记对话回退到第 3 轮："加上单元测试"
下次发言将从此处继续（后续 3 轮对话将被丢弃）
```

### 文件回退（`/rewind 3 file`）

```
✅ 已恢复文件到第 3 轮的状态
恢复了 4 个文件
```

若无快照可回退（checkpointing 未生效的旧会话）：
```
❌ 当前会话无文件快照，无法回退文件
```

### 全部回退（`/rewind 3 all`）

```
✅ 已恢复文件到第 3 轮的状态（恢复了 4 个文件）
✅ 已标记对话回退到第 3 轮："加上单元测试"
下次发言将从此处继续（后续 3 轮对话将被丢弃）
```

## 实现方案

### 使用的 SDK API

| API | 用途 | UUID 来源 |
|-----|------|----------|
| `getSessionMessages(sessionId, { dir })` | 读取会话记录 | — |
| `resumeSessionAt` (query 选项) | 对话回退 | assistant message uuid |
| `query.rewindFiles(userMessageId)` | 文件回退 | user message uuid |
| `enableFileCheckpointing` (query 选项) | 开启文件快照 | — |

**注意两个 API 使用不同的 UUID**：
- `resumeSessionAt` → 第 N 轮 **assistant** 回复的 uuid
- `rewindFiles()` → 第 N 轮 **user** 消息的 uuid

因此每轮需要同时记录 user uuid 和 assistant uuid。

### CLI 实现原理（参考）

Claude Code CLI 的 `resumeSessionAt` 实现非常简单——在加载消息时做 `slice`：

```javascript
// loadInitialMessages 中：
if (resumeSessionAt) {
  let idx = messages.findIndex(m => m.uuid === resumeSessionAt);
  messages = messages.slice(0, idx + 1);  // 截断
}
```

JSONL 文件本身不被修改（append-only），后续新消息通过 `parentUuid` 形成分支。

CLI 的三种模式对应：
- `--resume <id> --resume-session-at <uuid>` → 仅对话
- `--resume <id> --rewind-files <uuid>` → 仅文件
- 两者组合 → 全部

### enableFileCheckpointing

**本次实现默认开启 `enableFileCheckpointing: true`**。

在 `claude-runner.ts` 的 `createQuery` 调用中加入此选项。开启后：
- 每次文件被修改前，SDK 自动创建备份
- 备份存储在 `.claude/` 目录下，由 SDK 管理
- 磁盘开销可控（仅在文件实际被修改时才创建快照）
- 从此版本开始的所有会话都有文件快照，`file` 和 `all` 模式随时可用

### 数据流

```
/rewind（无参数）：
  1. ensureSession() → 获取当前会话及 agentSessionId
  2. SDK getSessionMessages(agentSessionId, { dir: projectPath })
  3. 过滤 type === 'user'
  4. 格式化编号列表，内容截断至 50 字
  5. 返回格式化文本

/rewind N（无模式）：
  → 返回提示："❌ 请指定回退模式：/rewind N chat | file | all"

/rewind N chat：
  1. ensureSession() → 获取当前会话及 agentSessionId
  2. SDK getSessionMessages(agentSessionId, { dir: projectPath })
  3. 按 user/assistant 配对构建轮次列表，校验 N 在 [1, 总轮数] 范围内
  4. 获取第 N 轮 assistant 回复的 uuid
  5. 将 uuid 存入 session.metadata.resumeAt
  6. 返回确认消息

  用户下次发消息时（runQuery 中）：
  1. 检查 session.metadata.resumeAt 是否存在
  2. 若存在，传入 query({ resume: agentSessionId, resumeSessionAt: uuid })
  3. SDK 从该轮之后继续对话
  4. 清除 session.metadata.resumeAt

/rewind N file：
  1. ensureSession() → 获取当前会话及 agentSessionId
  2. SDK getSessionMessages → 获取第 N 轮 user message uuid
  3. 创建临时 query（空 prompt + resume + enableFileCheckpointing）
  4. 调用 query.rewindFiles(userUuid)
  5. 检查返回的 canRewind，若 false 则报错
  6. 返回确认消息（含恢复文件数）

/rewind N all：
  1. 先执行 file 流程（立即恢复文件）
  2. 再执行 chat 流程（标记对话回退点）
  3. 返回组合确认消息
```

### 需要修改的文件

**`src/agents/claude-runner.ts`**：
- 新增 `getSessionMessages()` 方法
- 新增 `rewindFiles(userMessageId)` 方法（创建临时 query 执行文件回退）
- `createQuery` 调用处添加 `enableFileCheckpointing: true`
- `runQuery` 中检查 `metadata.resumeAt`，若存在则传入 `resumeSessionAt`

**`src/types.ts`**：
- `AgentRunnerFull` 接口新增：
  ```typescript
  getSessionMessages?(agentSessionId: string, projectPath: string): Promise<SessionMessage[]>;
  rewindFiles?(agentSessionId: string, projectPath: string, userMessageId: string): Promise<RewindFilesResult>;
  ```

**`src/core/command-handler.ts`**：
- 注册 `/rewind` 和 `/rw` 命令
- 解析子命令：无参数 → 列表，`N` → 提示，`N chat|file|all` → 执行
- 权限：仅管理员可用

**`src/core/session/session-manager.ts`**：
- `resumeAt` 字段存入 session metadata
- `runQuery` 前检查并消费该字段

### 边界情况

| 场景 | 行为 |
|------|------|
| 无活跃会话 | `"❌ 当前没有活跃会话"` |
| 无 agentSessionId | `"❌ 当前会话无历史记录"` |
| 非 Claude 后端 | `"❌ /rewind 仅支持 Claude 后端"` |
| 空历史 | `"📋 当前会话暂无对话记录"` |
| N 超出范围 | `"❌ 轮次超出范围，当前共 X 轮"` |
| N = 最后一轮 | `"❌ 已在最新一轮，无需回退"` |
| /rewind N（无模式） | `"❌ 请指定回退模式：/rewind N chat \| file \| all"` |
| 无效模式 | `"❌ 无效模式，可选：chat \| file \| all"` |
| 会话处理中 | 被空闲检查拦截（复用已有机制） |
| 文件回退无快照 | `"❌ 当前会话无文件快照，无法回退文件"` |
| resumeSessionAt 失败 | `"❌ 回退失败: {error.message}"`，清除 metadata.resumeAt |
| 已有未消费的 resumeAt | 覆盖为新值（以最后一次 /rewind 为准） |

### 权限

管理员级别命令（仅 owner），与 `/fork`、`/clear`、`/compact` 一致。

### 内容提取

`SessionMessage.message` 类型为 `unknown`。根据 JSONL 结构解析用户消息内容：
```typescript
function extractUserContent(msg: SessionMessage): string {
  const m = msg.message as any;
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}
```

列表显示时截断至 50 字，超出部分以 `…` 结尾。

## 不在本次范围内

- 不支持 Codex/Gemini（未来可通过 `SessionFileAdapter.readMessages()` 扩展）
- 历史列表不分页 — 大多数会话不超过 50 轮
- 不支持 `rewindFiles` 的 `dryRun` 模式（预览变更但不执行）— 后续可加

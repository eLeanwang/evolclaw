# 会话管理最终设计方案

## ⚠️ SDK 限制说明 (2026-03-14 更新)

**以下功能因技术限制或需求变更不再实现**:

### 1. 群聊物理隔离 (SDK限制)

**原因**: Claude Agent SDK 的会话文件管理机制限制

1. **SDK 自主决定文件路径**
   - SDK 根据传入的 `projectPath` 参数自动生成存储路径
   - 路径格式: `~/.claude/projects/{encoded-path}/{uuid}.jsonl`
   - 我们无法控制 SDK 在子目录(如 `group/`)中创建文件

2. **文件命名由 SDK 控制**
   - SDK 生成的会话文件名是 UUID 格式(如 `c9ecd142-ba10-4efc-b43f-b74aa379dfc6.jsonl`)
   - 我们无法自定义文件名(如 `agent-*.jsonl` 或 `feishu-*.jsonl`)
   - 数据库中的 `session.id` 和 SDK 的 `claude_session_id` 是两个独立的标识

3. **实际实现方案**
   - **逻辑隔离**而非物理隔离
   - 所有会话文件存储在同一目录: `~/.claude/projects/{encoded-path}/`
   - 通过数据库字段区分: `channel` (feishu/acp) 和 `channel_id` (ou_xxx/oc_xxx)

### 2. CLI 会话自动恢复 (需求变更)

**原因**: 不需要实现此功能

- 原设计: 私聊首次切换项目时,自动扫描并使用最新的CLI会话
- **决定**: 不实现自动恢复,保持当前简单的会话管理方式
- 用户可以通过 `/new` 命令手动创建新会话

### 影响

- ❌ 无法实现 `group/` 子目录物理隔离
- ❌ 无法通过文件名区分群聊和私聊
- ❌ 不支持CLI会话自动恢复
- ✅ 数据库层面的隔离依然有效
- ✅ 不影响会话管理的核心功能

---

## 一、核心架构

### 1.1 会话存储策略 (已修订)

**实际存储方式**：
- 路径：`~/.claude/projects/{encoded-path}/{uuid}.jsonl`
- 命名：SDK 生成的 UUID 格式
- 所有会话(私聊/群聊/CLI)存储在同一目录

**隔离方式**：
- 数据库逻辑隔离：通过 `channel` 和 `channel_id` 字段区分
- 群聊 channelId: `oc_` 开头
- 私聊 channelId: `ou_` 开头

### 1.2 数据库结构

保持现有结构，无需修改：
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, channel_id, project_path)
)
```

## 二、命令设计

### 2.1 命令列表

| 命令 | 功能 | 参数 | 适用 |
|------|------|------|------|
| `/plist` | 列出所有项目 | 无 | 私聊 |
| `/swp` | 切换项目 | `<序号\|名称\|路径>` | 私聊 |
| `/bind` | 绑定项目 | `<路径>` | 群聊 |
| `/slist` | 列出会话 | 无 | 私聊+群聊 |
| `/sws` | 切换会话 | `<序号\|会话ID>` | 私聊+群聊 |
| `/status` | 显示当前会话详情 | 无 | 私聊+群聊 |
| `/new` | 创建新会话 | 无 | 私聊+群聊 |

### 3.2 `/plist` - 项目列表

**输出格式**（保留路径）：
```
可用项目:
  ✓ evolclaw (/home/evolclaw) - 活跃 [处理中]
  1. openclaw-root (/data/openclaw-root) - 2小时前 [空闲]
  2. molbox (/home/molbox) - 1天前 [空闲]

使用 /swp <序号|名称|路径> 切换项目
```

**显示规则**：
- 当前项目：用 `✓` 标记，不显示序号
- 其他项目：显示序号（从 1 开始）
- 显示：项目名 (路径) - 状态信息
- 状态包括：
  - 活跃/空闲时间
  - 处理状态（处理中/队列数）
  - 新消息数量

### 3.3 `/swp` - 切换项目（私聊）

**支持方式**：
```bash
/swp 1                    # 按序号切换
/swp evolclaw             # 按配置的项目名
/swp /home/evolclaw       # 按绝对路径
```

**解析逻辑**：
1. 检查是否为纯数字 → 按序号切换
2. 检查是否为绝对路径（以 `/` 开头）→ 按路径切换
3. 否则 → 按项目名切换

**限制**：
- 任务处理中不可切换
- 提示：`⚠️ 当前正在处理消息，无法切换项目`

### 3.4 `/bind` - 绑定项目（群聊）

**功能**：
- 群聊首次使用时必须绑定项目
- 一个群聊只能绑定一个项目（固定）
- 绑定后自动创建第一个会话

**使用**：
```bash
/bind /home/evolclaw
```

**响应**：
```
✓ 已绑定项目: /home/evolclaw
  创建新会话: feishu-oc_xxx-abc1234
```

### 3.5 `/slist` - 会话列表

**私聊输出格式**：
```
当前项目 evolclaw 的会话列表:
  ✓ feishu-ou_xxx-abc1234 - 2小时前 [空闲]
  1. feishu-ou_xxx-def5678 - 30分钟前 [空闲]
  2. feishu-ou_xxx-ghi9012 - 1天前 [空闲]

使用 /sws <序号|会话ID> 切换会话
```

**群聊输出格式**：
```
当前群聊的会话列表:
  ✓ feishu-oc_xxx-abc1234 - 1小时前 [空闲]
  1. feishu-oc_xxx-def5678 - 3小时前 [空闲]
  2. feishu-oc_xxx-ghi9012 - 1天前 [空闲]

使用 /sws <序号|会话ID> 切换会话
```

**显示规则**：
- 当前会话：用 `✓` 标记，不显示序号
- 其他会话：显示序号（从 1 开始）
- 显示：会话ID - 最后活动时间 [状态]

### 3.6 `/sws` - 切换会话

**支持方式**：
```bash
/sws 2                              # 按序号切换
/sws feishu-ou_xxx-1234567890      # 按会话 ID 切换（私聊）
/sws feishu-oc_xxx-1234567890      # 按会话 ID 切换（群聊）
```

**会话 ID 格式**：
- 私聊：`feishu-ou_{channelId}-{timestamp}`
- 群聊：`feishu-oc_{channelId}-{timestamp}`
- 格式：`{channel}-{channelId}-{timestamp}`

**解析逻辑**：
1. 检查是否为纯数字 → 按序号切换
2. 检查是否以 `feishu-` 或 `acp-` 开头 → 按会话 ID 切换
3. 否则 → 报错

**限制**：
- 任务处理中不可切换
- 提示：`⚠️ 当前正在处理消息，无法切换会话`

### 3.7 `/status` - 显示当前会话详情

**输出格式**：
```
📌 当前会话信息：

会话ID: feishu-ou_xxx-1234567890
项目路径: /home/evolclaw
渠道: 飞书私聊
状态: 活跃
创建时间: 2026-03-11 18:36
最后更新: 2026-03-12 13:45
会话文件: 存在
```

### 3.8 `/new` - 创建新会话

**功能**：
- 生成新的会话 ID
- 清空数据库中的 `claude_session_id`
- 下次消息创建新会话文件
- 新会话成为"最新"会话

**响应**：
```
✓ 已创建新会话
  之前的对话历史已保留，可通过 /slist 查看
```

**限制**：
- 任务处理中不可创建新会话

## 四、安全保证

### 4.1 隐私隔离

**保证**：
- ✅ 群聊 A 不会看到群聊 B 的会话
- ✅ 群聊不会看到私聊会话
- ✅ 私聊不会看到群聊会话

**机制**：
- 数据库逻辑隔离：通过 `channel` 和 `channel_id` 字段区分
- 会话查询限制：只返回当前聊天的会话

### 4.2 任务处理保护

**规则**：
- 任务处理中不可切换会话
- 任务处理中不可切换项目
- 任务处理中不可创建新会话

**检查机制**：
- 检查消息队列是否有正在处理的消息
- 如果有，拒绝切换命令并提示用户

**适用命令**：
- `/swp` - 切换项目
- `/sws` - 切换会话
- `/new` - 创建新会话
- `/bind` - 绑定项目

**不受限制的命令**：
- `/plist` - 查看项目列表
- `/slist` - 查看会话列表
- `/status` - 查看状态

### 4.3 会话文件验证

**已实现**：
- 切换会话前验证文件是否存在
- 文件不存在时自动创建新会话
- 更新数据库状态

## 五、使用场景

### 5.1 私聊：查看和切换会话

```
用户: /slist

系统: 当前项目 evolclaw 的会话列表:
      ✓ feishu-ou_xxx-abc1234 - 2小时前 [空闲]
      1. feishu-ou_xxx-def5678 - 30分钟前 [空闲]
      2. feishu-ou_xxx-ghi9012 - 1天前 [空闲]

用户: /sws 1

系统: ✓ 已切换到会话: feishu-ou_xxx-def5678
      将继续之前的对话历史
```

### 5.2 私聊：快速切换项目

```
用户: /plist

系统: 可用项目:
      ✓ evolclaw (/home/evolclaw) - 活跃 [空闲]
      1. openclaw-root (/data/openclaw-root) - 2小时前 [空闲]
      2. molbox (/home/molbox) - 1天前 [空闲]

用户: /swp 2

系统: ✓ 已切换到项目: /home/molbox
```

### 5.3 群聊：绑定和使用

```
用户: 你好

系统: ⚠️ 请先绑定项目：/bind <项目路径>

用户: /bind /home/evolclaw

系统: ✓ 已绑定项目: /home/evolclaw
      创建新会话: feishu-oc_xxx-abc1234

用户: 帮我写代码

系统: [正常响应]
```

### 5.5 群聊：创建和切换会话

```
用户: /new

系统: ✓ 已创建新会话
      之前的会话已保留

用户: /slist

系统: 当前群聊的会话列表:
      ✓ feishu-oc_xxx-def5678 - 刚刚 [空闲]
      1. feishu-oc_xxx-abc1234 - 2小时前 [空闲]

用户: /sws 1

系统: ✓ 已切换到会话: feishu-oc_xxx-abc1234
      将继续之前的对话
```

### 5.6 任务处理中的保护

```
[系统正在处理消息]

用户: /swp 2

系统: ⚠️ 当前正在处理消息，无法切换项目
      请等待当前任务完成后再试
```

## 六、实现要点

### 6.1 序号管理

**项目序号**：
- 从 `/plist` 的显示顺序生成
- 当前项目不计入序号
- 其他项目序号从 1 开始

**会话序号**：
- 从 `/slist` 的显示顺序生成
- 当前会话不显示序号（只显示 ✓）
- 其他会话序号从 1 开始

### 6.2 参数解析

**数字检测**：
```typescript
/^\d+$/.test(arg)  // 纯数字
```

**路径检测**：
```typescript
arg.startsWith('/')  // 绝对路径
```

**会话 ID 检测**：
```typescript
arg.startsWith('feishu-') ||
arg.startsWith('acp-')
```

### 6.3 状态检查

**任务处理检查**：
```typescript
const queueLength = messageQueue.getQueueLength(sessionKey);
if (queueLength > 0) {
  return '⚠️ 当前正在处理消息，无法切换';
}
```

### 6.4 会话文件验证

**已实现**：
- 切换会话前验证文件是否存在
- 文件不存在时自动创建新会话
- 更新数据库状态

## 七、实现优先级

### 高优先级（核心功能）
1. `/slist` 命令（列出会话）
2. `/sws` 命令（切换会话，支持序号和会话ID）
3. `/swp` 命令（支持序号切换）
4. 任务处理中的保护机制

### 中优先级（增强功能）
1. `/plist` 显示序号
2. `/bind` 命令（群聊绑定项目）
3. 群聊多会话支持

### 低优先级（优化功能）
1. 会话搜索和过滤
2. 会话导出和备份
3. 会话统计和分析

## 八、数据库查询方法

需要在 `SessionManager` 中添加以下方法：

### 8.1 `listSessionsByChat()`
查询当前聊天的所有会话（按项目分组）

### 8.2 `listSessionsByProject()`
查询当前聊天在指定项目的所有会话

### 8.3 `getSessionById()`
根据会话 ID 获取会话信息

### 8.4 `switchToSession()`
切换到指定会话（更新 is_active 标记）

### 8.5 `getSessionByProjectPath()`
根据项目路径获取会话（用于 `/plist` 显示状态）

## 九、错误处理

### 9.1 序号越界
```
❌ 无效的序号，请使用 /plist 查看可用项目
❌ 无效的序号，请使用 /slist 查看可用会话
```

### 9.2 会话不存在
```
❌ 会话不存在: feishu-ou_xxx-1234567890
```

### 9.3 任务处理中
```
⚠️ 当前正在处理消息，无法切换项目/会话
请等待当前任务完成后再试
```

### 9.4 群聊未绑定项目
```
⚠️ 请先绑定项目：/bind <项目路径>
```

### 9.5 群聊重复绑定
```
❌ 该群聊已绑定项目: /home/evolclaw
无法重复绑定
```

---

**方案版本**: v1.0
**最后更新**: 2026-03-12

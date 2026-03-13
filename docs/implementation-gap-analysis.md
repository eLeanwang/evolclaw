# 实现差距分析报告

**分析时间**: 2026-03-13
**更新时间**: 2026-03-14
**对比文档**: `docs/session-management-final-design.md`
**当前代码**: `src/core/session-manager.ts`, `src/index.ts`

## ⚠️ 重要更新 (2026-03-14)

**以下P0功能因技术限制或需求变更不再实现**:

1. **P0-1: 群聊会话物理隔离** - SDK限制无法实现
   - SDK 自主决定会话文件的存储路径和命名(UUID格式)
   - 无法实现设计文档中的 `group/` 子目录物理隔离
   - 已接受SDK限制,采用数据库逻辑隔离方案

2. **P0-2: CLI 会话自动恢复** - 需求变更,不实现
   - 原设计: 私聊首次切换项目时自动扫描并使用最新CLI会话
   - 决定: 保持当前简单的会话管理方式
   - 用户可通过 `/new` 命令手动创建新会话

详见设计文档中的"SDK限制说明"章节。

---

## 一、核心功能对比

### ✅ 已实现的功能

1. **数据库结构** - 完全匹配设计
   - `sessions` 表结构正确
   - `is_active` 字段支持
   - 自动迁移逻辑

2. **基础会话管理**
   - `getOrCreateSession()` - 获取或创建会话
   - `switchProject()` - 切换项目
   - `updateClaudeSessionId()` - 更新会话ID
   - `clearActiveSession()` - 清除会话

3. **基础命令**
   - `/pwd` - 显示当前项目
   - `/plist` - 列出项目（但缺少序号支持）
   - `/switch` - 切换项目（但命令名不匹配设计）
   - `/new` - 创建新会话
   - `/status` - 显示状态
   - `/help` - 帮助信息

### ❌ 未实现的核心功能

#### 1. 群聊会话物理隔离（高优先级）⚠️ SDK限制无法实现

**设计要求**:
```
私聊: ~/.claude/projects/{encoded-path}/agent-*.jsonl
群聊: ~/.claude/projects/{encoded-path}/group/feishu-{group-id}-{hash}.jsonl
```

**SDK限制**:
- SDK 自主决定会话文件路径和命名(UUID格式)
- 无法控制 SDK 在 `group/` 子目录中创建文件
- 无法自定义文件名为 `agent-*.jsonl` 或 `feishu-*.jsonl`

**实际方案**:
- 采用数据库逻辑隔离
- 通过 `channel` 和 `channel_id` 字段区分
- 所有会话文件存储在同一目录

**状态**: ✅ 已接受SDK限制,不再实现物理隔离

---

#### 2. CLI 会话自动恢复（高优先级）⚠️ 需求变更,不实现

**设计要求**:
- 首次切换项目时，扫描 `agent-*.jsonl` 文件
- 自动使用最新的 CLI 会话
- 提示: "📌 自动使用最新 CLI 会话: agent-abc1234"

**决定**: 不实现此功能
- 保持当前简单的会话管理方式
- 用户可通过 `/new` 命令手动创建新会话

**状态**: ✅ 已确认不实现

---
// 只检查数据库，不扫描文件系统
const target = this.db.prepare(`
  SELECT * FROM sessions
  WHERE channel = ? AND channel_id = ? AND project_path = ?
`).get(channel, channelId, newProjectPath);
```

**问题**:
- 没有 `getLatestCliSession()` 方法
- 不会扫描文件系统查找 CLI 会话
- 私聊和 CLI 无法无缝切换

---

#### 3. 会话列表和切换命令（高优先级）

**设计要求**:
- `/slist` - 列出当前项目的所有会话
- `/sws <序号|会话ID>` - 切换会话
- 支持序号和会话ID两种方式

**当前实现**:
```typescript
// index.ts:95
const commands = ['/new', '/pwd', '/plist', '/switch', '/bind', '/help', '/status', '/restart', '/model'];
```

**问题**:
- `/slist` 命令不存在
- `/sws` 命令不存在
- `listSessions()` 方法存在但未暴露给用户
- 没有 `switchToSession()` 方法

---

#### 4. 序号支持（高优先级）

**设计要求**:
- `/plist` 显示序号（当前项目用 ✓，其他用 1, 2, 3...）
- `/swp 1` - 按序号切换项目
- `/sws 2` - 按序号切换会话

**当前实现**:
- `/plist` 不显示序号
- `/switch` 不支持序号参数
- 没有序号解析逻辑

---

#### 5. 任务处理保护（高优先级）

**设计要求**:
```typescript
const queueLength = messageQueue.getQueueLength(sessionKey);
if (queueLength > 0) {
  return '⚠️ 当前正在处理消息，无法切换';
}
```

**当前实现**:
- 命令处理函数中没有队列检查
- 可以在处理消息时切换项目/会话

---

#### 6. 群聊绑定机制（中优先级）

**设计要求**:
- 群聊首次使用必须 `/bind` 绑定项目
- 一个群聊只能绑定一个项目
- 绑定后自动创建第一个会话

**当前实现**:
- `/bind` 命令存在但功能不完整
- 没有"群聊必须先绑定"的检查
- 没有"一个群聊一个项目"的限制

---

#### 7. 会话来源标识（中优先级）

**设计要求**:
- `/slist` 输出中显示 `[CLI]` 标记
- 区分 CLI 创建的会话和飞书创建的会话

**当前实现**:
- 数据库没有 `source` 字段
- 无法区分会话来源

---

## 二、SessionManager 缺失的方法

设计文档要求的方法（Section 8）:

| 方法 | 状态 | 说明 |
|------|------|------|
| `listSessionsByChat()` | ❌ 未实现 | 查询当前聊天的所有会话（按项目分组） |
| `listSessionsByProject()` | ❌ 未实现 | 查询当前聊天在指定项目的所有会话 |
| `getSessionById()` | ❌ 未实现 | 根据会话 ID 获取会话信息 |
| `switchToSession()` | ❌ 未实现 | 切换到指定会话（更新 is_active） |
| `getSessionByProjectPath()` | ✅ 已实现 | 根据项目路径获取会话 |
| `getLatestCliSession()` | ❌ 未实现 | 扫描文件系统获取最新 CLI 会话 |

---

## 三、命令对比

| 设计命令 | 当前命令 | 状态 | 说明 |
|---------|---------|------|------|
| `/plist` | `/plist` | ⚠️ 部分实现 | 缺少序号显示 |
| `/swp` | `/switch` | ⚠️ 命名不匹配 | 功能类似但缺少序号支持 |
| `/bind` | `/bind` | ⚠️ 部分实现 | 缺少群聊绑定检查 |
| `/slist` | - | ❌ 未实现 | 列出会话 |
| `/sws` | - | ❌ 未实现 | 切换会话 |
| `/status` | `/status` | ✅ 已实现 | 显示状态 |
| `/new` | `/new` | ✅ 已实现 | 创建新会话 |
| - | `/model` | ➕ 额外功能 | 模型切换（设计中没有） |
| - | `/restart` | ➕ 额外功能 | 重启服务（设计中没有） |

---

## 四、实现优先级建议

### P0 - 必须实现（核心功能）

1. **群聊会话物理隔离**
   - 修改 `getSessionFilePath()` 支持 `group/` 子目录
   - 根据 channel 和 channelId 判断是否为群聊

2. **CLI 会话自动恢复**
   - 实现 `getLatestCliSession()` 方法
   - 在 `switchProject()` 中调用

3. **会话列表和切换**
   - 实现 `/slist` 命令
   - 实现 `/sws` 命令
   - 添加 `switchToSession()` 方法

### P1 - 应该实现（增强功能）

4. **序号支持**
   - `/plist` 显示序号
   - `/swp` 支持序号切换
   - `/sws` 支持序号切换

5. **任务处理保护**
   - 在命令处理前检查队列状态
   - 拒绝处理中的切换操作

6. **群聊绑定机制**
   - 检查群聊是否已绑定项目
   - 限制一个群聊一个项目

### P2 - 可以实现（优化功能）

7. **会话来源标识**
   - 数据库添加 `source` 字段
   - `/slist` 显示来源标记

8. **命令统一**
   - 将 `/switch` 改为 `/swp`（或同时支持两者）

---

## 五、结论

**当前实现与设计文档的匹配度: ~40%**

- ✅ 数据库结构完全匹配
- ✅ 基础会话管理功能完整
- ❌ 群聊隔离机制缺失
- ❌ CLI 会话自动恢复缺失
- ❌ 会话列表/切换功能缺失
- ❌ 任务处理保护缺失

**建议**: 需要按照设计文档补充实现缺失的核心功能，特别是 P0 级别的功能。

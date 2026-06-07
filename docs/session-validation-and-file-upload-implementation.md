# 会话文件验证和文件上传支持功能实现文档

## 功能概述

本文档描述了两个核心功能的技术实现细节：
1. **会话文件验证** - 验证 Claude Agent SDK 会话文件是否存在，避免恢复无效会话
2. **文件上传支持** - 支持飞书用户上传文件并传递给 Agent 处理

---

## 1. 会话文件验证功能

### 功能说明
在尝试恢复 Claude Agent SDK 会话前，验证会话文件是否真实存在于文件系统中。如果文件不存在（可能因为项目切换、文件删除等原因），则自动创建新会话而不是尝试恢复。

### 问题背景
- SDK 会话 ID 存储在数据库中
- 但实际的 `.jsonl` 会话文件可能不存在
- 尝试恢复不存在的会话会导致 SDK 报错

### 实现位置
`src/agent-runner.ts` - `AgentRunner.runQuery()` 方法

### 核心实现

#### 步骤1: 导入依赖
```typescript
import fs from 'fs';
import os from 'os';
```

#### 步骤2: 会话文件路径计算
```typescript
// SDK 会话文件存储规则
// 路径: ~/.claude/projects/{encoded-path}/{sessionId}.jsonl
// 编码规则: 将路径中的 / 替换为 -，去掉开头的 -

const homeDir = os.homedir();
const encodedPath = projectPath.replace(/\//g, '-').replace(/^-/, '');
const sessionFile = path.join(
  homeDir,
  '.claude',
  'projects',
  encodedPath,
  `${claudeSessionId}.jsonl`
);
```

#### 步骤3: 文件存在性检查
```typescript
if (claudeSessionId) {
  const homeDir = os.homedir();
  const encodedPath = projectPath.replace(/\//g, '-').replace(/^-/, '');
  const sessionFile = path.join(
    homeDir,
    '.claude',
    'projects',
    encodedPath,
    `${claudeSessionId}.jsonl`
  );

  logger.debug(`[AgentRunner] Checking session file: ${sessionFile}`);

  if (!fs.existsSync(sessionFile)) {
    logger.warn(
      `[AgentRunner] Session file not found: ${sessionFile}, starting new session`
    );
    claudeSessionId = undefined;  // 清除无效的会话ID
  } else {
    logger.debug(`[AgentRunner] Session file exists, will resume`);
  }
}
```

### 路径编码示例

| 项目路径 | 编码后路径 | 会话文件路径 |
|---------|-----------|-------------|
| `/home/evolclaw` | `home-evolclaw` | `~/.claude/projects/home-evolclaw/{sessionId}.jsonl` |
| `/home/molbox` | `home-molbox` | `~/.claude/projects/home-molbox/{sessionId}.jsonl` |
| `/data/project` | `data-project` | `~/.claude/projects/data-project/{sessionId}.jsonl` |

### 调用时机
在 `runQuery()` 方法中，获取 `claudeSessionId` 后立即验证：

```typescript
async runQuery(
  sessionId: string,
  prompt: string,
  projectPath: string,
  initialClaudeSessionId?: string,
  images?: ImageData[],
  systemPromptAppend?: string
): Promise<AsyncIterable<any>> {
  // 1. 获取会话ID
  let claudeSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

  // 2. 验证会话文件（本功能）
  if (claudeSessionId) {
    // ... 验证逻辑
  }

  // 3. 调用 SDK
  const queryStream = query({
    // ...
    ...(claudeSessionId ? { resume: claudeSessionId } : {})
  });
}
```

### 日志输出
- **Debug**: 检查会话文件路径
- **Warn**: 会话文件不存在，创建新会话
- **Debug**: 会话文件存在，将恢复会话

### 注意事项
1. **路径编码规则** - 必须与 SDK 的编码规则一致
2. **性能影响** - `fs.existsSync()` 是同步操作，但影响可忽略
3. **错误容错** - 文件不存在时自动降级为新会话
4. **跨平台** - 使用 `os.homedir()` 确保跨平台兼容

---

## 2. 文件上传支持功能

### 功能说明
支持用户通过飞书上传文件，文件信息（路径、名称、MIME类型）会传递给 Agent 处理器。

### 实现位置
- `src/types.ts` - 数据类型定义
- `src/channels/feishu.ts` - 飞书消息处理
- `src/index.ts` - 消息队列集成

### 核心实现

#### 步骤1: 类型定义 (src/types.ts)

```typescript
export interface Message {
  channel: string;
  channelId: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  files?: Array<{
    path: string;      // 文件保存路径
    name: string;      // 文件名
    mimeType: string;  // MIME类型
  }>;
  timestamp?: number;
}
```

#### 步骤2: MessageHandler 接口更新 (src/channels/feishu.ts)

**原接口：**
```typescript
export interface MessageHandler {
  (
    channelId: string,
    content: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void>;
}
```

**更新后：**
```typescript
export interface MessageHandler {
  (
    channelId: string,
    content: string,
    images?: Array<{ data: string; mimeType: string }>,
    files?: Array<{ path: string; name: string; mimeType: string }>
  ): Promise<void>;
}
```

#### 步骤3: 飞书消息处理 (src/channels/feishu.ts)

```typescript
feishu.onMessage(async (chatId, content, images, files) => {
  // files 参数现在可用
  // 包含用户上传的文件信息
});
```

#### 步骤4: 消息队列集成 (src/index.ts)

```typescript
// 原代码
await messageQueue.enqueue(
  `feishu-${chatId}`,
  {
    channel: 'feishu',
    channelId: chatId,
    content,
    images,
    timestamp: Date.now()
  },
  session.projectPath
);

// 更新后
await messageQueue.enqueue(
  `feishu-${chatId}`,
  {
    channel: 'feishu',
    channelId: chatId,
    content,
    images,
    files,  // 添加文件参数
    timestamp: Date.now()
  },
  session.projectPath
);
```

### 数据流

```
用户上传文件
    ↓
飞书 SDK 接收
    ↓
FeishuChannel.onMessage(chatId, content, images, files)
    ↓
MessageQueue.enqueue({ ..., files })
    ↓
MessageProcessor.processMessage(message)
    ↓
Agent 处理器接收文件信息
```

### 文件信息结构

```typescript
{
  path: "/home/evolclaw/.claude/uploads/file-123.pdf",
  name: "document.pdf",
  mimeType: "application/pdf"
}
```

### 使用示例

**在消息处理器中访问文件：**
```typescript
async function handleMessage(
  channelId: string,
  content: string,
  images?: Array<...>,
  files?: Array<...>
) {
  if (files && files.length > 0) {
    for (const file of files) {
      console.log(`收到文件: ${file.name}`);
      console.log(`路径: ${file.path}`);
      console.log(`类型: ${file.mimeType}`);

      // 可以读取文件内容
      const fileContent = fs.readFileSync(file.path);
    }
  }
}
```

### 注意事项

1. **可选参数** - files 是可选的，需要检查是否存在
2. **文件路径** - path 是绝对路径，可以直接读取
3. **文件清理** - 需要考虑文件的生命周期管理
4. **安全性** - 应验证文件类型和大小
5. **向后兼容** - files 参数可选，不影响现有代码

### 扩展建议

**文件类型验证：**
```typescript
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'image/jpeg',
  'image/png'
];

if (files) {
  for (const file of files) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) {
      throw new Error(`不支持的文件类型: ${file.mimeType}`);
    }
  }
}
```

**文件大小限制：**
```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

if (files) {
  for (const file of files) {
    const stats = fs.statSync(file.path);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`文件过大: ${file.name}`);
    }
  }
}
```

---

## 集成说明

### 会话文件验证集成

**修改文件：** `src/agent-runner.ts`

**依赖项：**
- `fs` - 文件系统操作
- `os` - 获取用户主目录
- `path` - 路径操作

**影响范围：**
- 仅影响会话恢复逻辑
- 不影响新会话创建
- 向后兼容

### 文件上传支持集成

**修改文件：**
- `src/types.ts` - 类型定义
- `src/channels/feishu.ts` - 接口更新
- `src/index.ts` - 消息队列

**依赖项：**
- 无新增依赖

**影响范围：**
- MessageHandler 接口签名变更
- Message 类型定义扩展
- 向后兼容（files 为可选参数）

---

## 测试要点

### 会话文件验证测试

1. **正常恢复** - 会话文件存在，验证能正常恢复
2. **文件不存在** - 会话文件不存在，验证创建新会话
3. **路径编码** - 验证不同项目路径的编码正确性
4. **日志输出** - 验证 debug 和 warn 日志正确输出
5. **性能影响** - 验证文件检查不影响响应速度

### 文件上传支持测试

1. **单文件上传** - 上传单个文件，验证信息正确传递
2. **多文件上传** - 上传多个文件，验证数组处理
3. **无文件消息** - 普通消息不应有 files 参数
4. **文件类型** - 测试不同 MIME 类型的文件
5. **文件读取** - 验证可以通过 path 读取文件内容

---

## 回滚后重新实现步骤

### 会话文件验证

1. 在 `agent-runner.ts` 顶部添加 `fs` 和 `os` 导入
2. 在 `runQuery()` 方法中，获取 `claudeSessionId` 后添加验证逻辑
3. 实现路径编码：`projectPath.replace(/\//g, '-').replace(/^-/, '')`
4. 使用 `fs.existsSync()` 检查文件
5. 添加相应的日志输出
6. 测试验证

### 文件上传支持

1. 更新 `src/types.ts` 中的 `Message` 接口，添加 `files` 字段
2. 更新 `src/channels/feishu.ts` 中的 `MessageHandler` 接口
3. 在 `src/index.ts` 的消息队列调用中添加 `files` 参数
4. 更新所有 `messageHandler` 调用，传递 `files` 参数
5. 测试验证

---

## 相关文件

### 会话文件验证
- `src/agent-runner.ts` - 主要实现

### 文件上传支持
- `src/types.ts` - 类型定义
- `src/channels/feishu.ts` - 接口定义
- `src/index.ts` - 消息队列集成

## 版本信息

- 实现日期: 2026-03
- 相关 commit: (待提交)

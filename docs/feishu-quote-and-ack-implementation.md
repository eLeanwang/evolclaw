# 飞书消息引用和确认反应功能实现文档

## 功能概述

本文档描述了两个飞书消息处理功能的技术实现细节：
1. **消息引用功能** - 支持获取和处理被引用的消息内容
2. **消息确认反应** - 自动为收到的消息添加 CheckMark 反应

## 1. 消息确认反应功能

### 功能说明
当收到飞书消息时，自动添加 ✓ (CheckMark) 反应，向用户确认消息已被接收。

### 实现位置
`src/channels/feishu.ts` - `FeishuChannel` 类

### 核心代码

```typescript
private addAckReaction(messageId: string): void {
  if (!this.client) return;

  this.client.im.messageReaction.create({
    path: { message_id: messageId },
    data: {
      reaction_type: { emoji_type: 'CheckMark' }
    }
  }).catch(() => {});
}
```

### 调用时机
在消息处理开始时立即调用：

```typescript
// 在 onMessage 回调中
this.markSeen(msg.message_id);
this.addAckReaction(msg.message_id);  // 添加确认反应
```

### API 说明
- **API**: `im.messageReaction.create`
- **参数**:
  - `path.message_id`: 消息ID
  - `data.reaction_type.emoji_type`: 反应类型（CheckMark）
- **错误处理**: 使用 `.catch(() => {})` 静默失败，不影响主流程

### 注意事项
- 必须在消息处理开始时调用，确保用户快速看到反馈
- 错误不应阻塞消息处理流程
- 需要飞书应用有添加消息反应的权限

---

## 2. 消息引用功能

### 功能说明
当用户回复/引用一条消息时，自动获取被引用消息的内容，并将其添加到当前消息的上下文中。

### 支持的引用类型
- **文本消息** - 提取文本内容，格式化为引用格式
- **图片消息** - 下载图片并添加到消息附件
- **文件消息** - 显示占位符
- **其他类型** - 显示类型占位符

### 实现位置
`src/channels/feishu.ts` - `FeishuChannel` 类的消息处理逻辑

### 核心实现流程

#### 步骤1: 检测引用消息
```typescript
if (msg.parent_id && this.client) {
  // 存在 parent_id 表示这是一条回复消息
}
```

#### 步骤2: 获取被引用消息
```typescript
const res = await this.client.im.message.get({
  path: { message_id: msg.parent_id }
});

const quotedMsgType = res.data.items[0].msg_type;
const quotedContent = res.data.items[0].body.content;
```

#### 步骤3: 解析不同类型的引用消息

**文本消息处理：**
```typescript
if (quotedMsgType === 'text') {
  const parsed = JSON.parse(quotedContent);
  quotedText = `> ${parsed.text}\n\n`;
}
```

**图片消息处理：**
```typescript
else if (quotedMsgType === 'image') {
  const parsed = JSON.parse(quotedContent);
  const imageKey = parsed.image_key;

  const projectPath = this.projectPathProvider
    ? await this.projectPathProvider(msg.chat_id)
    : process.cwd();

  const imageData = await this.downloadAndSaveImage(
    imageKey,
    msg.chat_id,
    msg.parent_id,
    projectPath
  );

  if (imageData) {
    quotedImages.push(imageData);
    quotedText = `> [引用的图片]\n\n`;
  } else {
    quotedText = `> [图片消息]\n\n`;
  }
}
```

**其他类型处理：**
```typescript
else if (quotedMsgType === 'file') {
  quotedText = `> [文件消息]\n\n`;
} else {
  quotedText = `> [${quotedMsgType}消息]\n\n`;
}
```

#### 步骤4: 合并引用内容到当前消息
```typescript
// 处理文本消息
if (msg.message_type === 'text') {
  const content = JSON.parse(msg.content).text;
  const finalContent = quotedText + content;
  await this.messageHandler(
    msg.chat_id,
    finalContent,
    quotedImages.length > 0 ? quotedImages : undefined
  );
}
```

### 数据结构

**引用文本变量：**
```typescript
let quotedText = '';  // 引用消息的文本表示
```

**引用图片数组：**
```typescript
let quotedImages: Array<{
  data: string;      // base64 图片数据
  mimeType: string;  // 图片MIME类型
}> = [];
```

### API 说明

**获取消息API：**
- **API**: `im.message.get`
- **参数**: `path.message_id` - 要获取的消息ID
- **返回**: 消息详情，包含 `msg_type` 和 `body.content`

**消息类型字段：**
- `msg.parent_id` - 被引用消息的ID（存在则表示是回复消息）
- `msg_type` - 消息类型（text, image, file等）
- `body.content` - 消息内容（JSON字符串）

### 错误处理
```typescript
try {
  // 获取和处理引用消息
} catch (err) {
  logger.warn({ err }, '[Feishu] Failed to fetch quoted message');
  // 继续处理当前消息，不因引用失败而中断
}
```

### 格式化规范

**引用文本格式：**
- 使用 `> ` 前缀表示引用
- 引用内容后添加两个换行符 `\n\n`
- 示例：`> 这是被引用的文本\n\n当前消息内容`

**引用占位符：**
- 图片：`> [引用的图片]\n\n`
- 文件：`> [文件消息]\n\n`
- 其他：`> [消息类型]\n\n`

### 注意事项

1. **异步处理** - 获取引用消息是异步操作，需要 await
2. **错误容错** - 引用消息获取失败不应影响当前消息处理
3. **图片下载** - 引用的图片需要下载并保存到项目目录
4. **项目路径** - 需要通过 `projectPathProvider` 获取正确的项目路径
5. **日志记录** - 关键步骤添加 debug 日志便于调试

### 依赖项

- `this.client` - 飞书 SDK 客户端实例
- `this.projectPathProvider` - 项目路径提供函数
- `this.downloadAndSaveImage()` - 图片下载方法
- `logger` - 日志工具

---

## 集成说明

### MessageHandler 接口更新

原接口：
```typescript
(channelId: string, content: string, images?: Array<...>) => Promise<void>
```

更新后（支持引用图片）：
```typescript
(channelId: string, content: string, images?: Array<...>) => Promise<void>
```

引用的图片会合并到 `images` 参数中传递给处理器。

### 完整调用示例

```typescript
// 在 onMessage 事件处理中
this.markSeen(msg.message_id);
this.addAckReaction(msg.message_id);  // 1. 添加确认反应

// 2. 获取引用消息（如果存在）
let quotedText = '';
let quotedImages = [];
if (msg.parent_id) {
  // ... 获取和解析引用消息
}

// 3. 合并内容并调用处理器
const finalContent = quotedText + content;
await this.messageHandler(chatId, finalContent, quotedImages);
```

---

## 测试要点

### 消息确认反应测试
1. 发送普通消息，验证是否出现 ✓ 反应
2. 验证反应添加失败不影响消息处理
3. 验证反应添加速度（应在1秒内）

### 消息引用功能测试
1. **文本引用** - 回复文本消息，验证引用格式
2. **图片引用** - 回复图片消息，验证图片下载和显示
3. **文件引用** - 回复文件消息，验证占位符显示
4. **引用失败** - 引用已删除消息，验证容错处理
5. **无引用** - 普通消息不应有引用内容

---

## 回滚后重新实现步骤

1. **添加 addAckReaction 方法** - 复制上述方法到 FeishuChannel 类
2. **在消息处理开始时调用** - 在 markSeen 后立即调用
3. **添加引用消息处理逻辑** - 在消息处理前检查 parent_id
4. **实现不同类型的引用解析** - 按照上述代码实现各类型处理
5. **合并引用内容** - 将引用文本和图片合并到当前消息
6. **测试验证** - 按照测试要点进行完整测试

---

## 相关文件

- `src/channels/feishu.ts` - 主要实现文件
- `src/types.ts` - MessageHandler 接口定义

## 版本信息

- 实现日期: 2026-03
- 飞书 SDK: @larksuiteoapi/node-sdk ^1.30.0
- 相关 commit: (待提交)

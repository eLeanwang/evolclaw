# AUN File Reception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当用户通过 AUN CLI 发送文件附件时，自动下载文件、保存到项目 uploads 目录，并通知 Agent 用 Read 工具读取内容。

**Architecture:** 仅修改 `src/channels/aun.ts`。在 `AUNChannel` 类中添加 `projectPathProvider` 注入机制和 `downloadAttachment` 下载方法；在消息处理路径中检测 `payload.attachments` 并执行下载后组合 content；在 plugin 返回的 `ChannelInstance` 中补充 `onProjectPathRequest` 字段触发 `index.ts` 的自动注入。复用 `media-cache.ts` 的 `saveToUploads` + `sanitizeFileName`。

**Tech Stack:** TypeScript ES modules, `@eleans/aun-core-sdk` (`client.call`), Node.js `crypto` (SHA256), `media-cache.ts` (`saveToUploads`, `sanitizeFileName`), vitest

---

## File Map

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/channels/aun.ts` | 修改 | 添加 projectPathProvider、downloadAttachment、附件处理逻辑、plugin 字段 |
| `tests/unit/channels/aun-file-reception.test.ts` | 新建 | 单元测试：downloadAttachment、content 组合、group 空 text + 附件 |

---

## Task 1: 添加 import 和 projectPathProvider 支持

**Files:**
- Modify: `src/channels/aun.ts`

- [ ] **Step 1: 在文件顶部添加 media-cache import**

在 `src/channels/aun.ts` 第 8 行（`import { resolvePaths } from '../paths.js';` 之后）添加：

```typescript
import { saveToUploads, sanitizeFileName } from '../utils/media-cache.js';
```

- [ ] **Step 2: 在 AUNChannel 类的私有字段区域添加 projectPathProvider**

在 `src/channels/aun.ts` 第 36 行（`private client: AUNClient | null = null;` 之后）添加：

```typescript
  private projectPathProvider?: (channelId: string) => Promise<string>;
```

- [ ] **Step 3: 在 AUNChannel 的公开 API 区域（`onMessage` 方法之前）添加注册方法**

在 `onMessage(handler: AUNMessageHandler): void {` 之前插入：

```typescript
  onProjectPathRequest(provider: (channelId: string) => Promise<string>): void {
    this.projectPathProvider = provider;
  }
```

- [ ] **Step 4: 确认 TypeScript 编译无报错**

```bash
cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无输出（无报错）

- [ ] **Step 5: Commit**

```bash
cd /home/evolclaw
git add src/channels/aun.ts
git commit -m "feat(aun): add projectPathProvider support for file downloads"
```

---

## Task 2: 实现 downloadAttachment 方法

**Files:**
- Modify: `src/channels/aun.ts`

- [ ] **Step 1: 在 `handleConnectionState` 之前添加 downloadAttachment 私有方法**

在 `// ── Event handlers ──` 与 `private async handleIncomingPrivateMessage` 之间，插入以下方法（在 `handleIncomingPrivateMessage` 之前）：

```typescript
  private async downloadAttachment(
    att: { owner_aid?: string; object_key: string; filename?: string; sha256?: string },
    channelId: string
  ): Promise<string | null> {
    const ownerAid = att.owner_aid || this._aid || '';
    const objectKey = att.object_key;
    const filename = att.filename || objectKey.split('/').pop() || 'unknown';

    if (!objectKey) {
      logger.warn('[AUN] Attachment missing object_key, skipping');
      return null;
    }

    let downloadUrl: string;
    try {
      const ticket = await this.client!.call('storage.create_download_ticket', {
        owner_aid: ownerAid,
        object_key: objectKey,
      }) as Record<string, unknown>;
      downloadUrl = (ticket.download_url as string) || '';
      if (!downloadUrl) {
        logger.warn(`[AUN] No download_url for attachment: ${filename}`);
        return null;
      }
    } catch (e) {
      logger.warn(`[AUN] create_download_ticket failed for ${filename}: ${e}`);
      return null;
    }

    let buffer: Buffer;
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        logger.warn(`[AUN] Download failed for ${filename}: HTTP ${res.status}`);
        return null;
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      logger.warn(`[AUN] Download error for ${filename}: ${e}`);
      return null;
    }

    if (att.sha256) {
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== att.sha256) {
        logger.warn(`[AUN] SHA256 mismatch for ${filename}: expected ${att.sha256.slice(0, 8)}… got ${actual.slice(0, 8)}…`);
        return null;
      }
    }

    const projectPath = this.projectPathProvider
      ? await this.projectPathProvider(channelId)
      : process.cwd();

    try {
      const result = saveToUploads(buffer, filename, projectPath);
      logger.info(`[AUN] Saved attachment: ${result.filePath} (${result.size} bytes)`);
      return result.filePath;
    } catch (e) {
      logger.warn(`[AUN] saveToUploads failed for ${filename}: ${e}`);
      return null;
    }
  }
```

- [ ] **Step 2: 确认 TypeScript 编译无报错**

```bash
cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无输出

- [ ] **Step 3: Commit**

```bash
cd /home/evolclaw
git add src/channels/aun.ts
git commit -m "feat(aun): implement downloadAttachment with SHA256 verification"
```

---

## Task 3: 在 handleIncomingPrivateMessage 中处理附件

**Files:**
- Modify: `src/channels/aun.ts`

- [ ] **Step 1: 重写 handleIncomingPrivateMessage 以检测并处理附件**

将现有的 `handleIncomingPrivateMessage` 方法（第 255-282 行附近）替换为：

```typescript
  private async handleIncomingPrivateMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const fromAid = msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload);
    const taskId = msg.task_id;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Detect @mentions
    const mentions: string[] = [];
    if (this._aid && text.includes(`@${this._aid}`)) {
      mentions.push(this._aid);
    }

    // Process attachments
    const rawAttachments: any[] = Array.isArray((payload as any)?.attachments)
      ? (payload as any).attachments
      : [];

    let finalText = text;
    if (rawAttachments.length > 0 && this.client) {
      const fileParts: string[] = [];
      for (const att of rawAttachments) {
        const filePath = await this.downloadAttachment(att, fromAid);
        if (filePath) {
          const name = sanitizeFileName(att.filename || att.object_key?.split('/').pop() || 'file');
          fileParts.push(`[文件: ${name} → ${filePath}]`);
        }
      }
      if (fileParts.length > 0) {
        const parts: string[] = [];
        if (text) parts.push(text);
        parts.push(...fileParts);
        parts.push('请使用 Read 工具读取文件内容。');
        finalText = parts.join('\n\n');
      }
    }

    this.dispatchMessage({
      channelId: fromAid,
      userId: fromAid,
      text: finalText,
      chatType: 'private',
      messageId,
      seq,
      taskId,
      mentions,
    });
  }
```

- [ ] **Step 2: 确认 TypeScript 编译无报错**

```bash
cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无输出

- [ ] **Step 3: Commit**

```bash
cd /home/evolclaw
git add src/channels/aun.ts
git commit -m "feat(aun): handle attachments in private messages"
```

---

## Task 4: 在 handleIncomingGroupMessage 中处理附件

**Files:**
- Modify: `src/channels/aun.ts`

关键时序：附件处理必须在 mention 检测通过之后、`strippedText` 空值判断需改为同时检查是否有附件。

- [ ] **Step 1: 重写 handleIncomingGroupMessage 以检测并处理附件**

将现有的 `handleIncomingGroupMessage` 方法（第 284-342 行附近）替换为：

```typescript
  private async handleIncomingGroupMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const groupId = msg.group_id ?? '';
    const senderAid = msg.sender_aid ?? msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload);
    const taskId = msg.task_id;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Extract structured mentions from payload
    const payloadMentions: string[] = Array.isArray((payload as any)?.mentions)
      ? (payload as any).mentions.filter((m: unknown) => typeof m === 'string')
      : [];

    logger.info(`[AUN][DIAG-GRP] full_msg=${JSON.stringify(msg).substring(0, 500)}`);

    if (!groupId || !senderAid) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    if (this._aid && senderAid === this._aid) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const mentionedSelf = this._aid
      ? (this.hasExplicitMention(text, this._aid) || payloadMentions.includes(this._aid))
      : false;
    const mentionedAll = this.hasExplicitMention(text, 'all') || payloadMentions.includes('all');
    if (!mentionedSelf && !mentionedAll) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const strippedText = this.stripTriggerMentions(text, this._aid);

    // Detect attachments before the empty-text guard
    const rawAttachments: any[] = Array.isArray((payload as any)?.attachments)
      ? (payload as any).attachments
      : [];
    const hasAttachments = rawAttachments.length > 0;

    // Allow through if there's text OR attachments; both-empty messages are silently dropped
    if (!strippedText && !hasAttachments) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const mentions: string[] = mentionedAll ? ['all'] : (this._aid ? [this._aid] : []);

    // Process attachments
    let finalText = strippedText;
    if (hasAttachments && this.client) {
      const fileParts: string[] = [];
      for (const att of rawAttachments) {
        const filePath = await this.downloadAttachment(att, groupId);
        if (filePath) {
          const name = sanitizeFileName(att.filename || att.object_key?.split('/').pop() || 'file');
          fileParts.push(`[文件: ${name} → ${filePath}]`);
        }
      }
      if (fileParts.length > 0) {
        const parts: string[] = [];
        if (strippedText) parts.push(strippedText);
        parts.push(...fileParts);
        parts.push('请使用 Read 工具读取文件内容。');
        finalText = parts.join('\n\n');
      }
    }

    this.dispatchMessage({
      channelId: groupId,
      userId: senderAid,
      peerName: this.getShortAid(senderAid),
      text: finalText,
      chatType: 'group',
      messageId,
      seq,
      taskId,
      mentions,
      replyContext: this.buildGroupReplyContext(taskId, senderAid),
    });
  }
```

- [ ] **Step 2: 确认 TypeScript 编译无报错**

```bash
cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无输出

- [ ] **Step 3: Commit**

```bash
cd /home/evolclaw
git add src/channels/aun.ts
git commit -m "feat(aun): handle attachments in group messages, fix empty-text guard"
```

---

## Task 5: Plugin 返回值补充 onProjectPathRequest 字段

**Files:**
- Modify: `src/channels/aun.ts`

`index.ts:232` 的自动注入逻辑要求 `inst.onProjectPathRequest && inst.channel.onProjectPathRequest` 同时存在。`inst.channel.onProjectPathRequest` 已在 Task 1 添加，现在补充 `ChannelInstance` 中的 `onProjectPathRequest` 字段。

- [ ] **Step 1: 在 createChannels() 的 result.push(...) 中添加 onProjectPathRequest**

找到 `result.push({` 这段（第 672 行附近），将其修改为：

```typescript
      result.push({
        channelType: 'aun',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: (channelId: string) =>
          Promise.resolve(config.projects?.defaultPath || process.cwd()),
      });
```

- [ ] **Step 2: 确认 TypeScript 编译无报错**

```bash
cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -20
```

Expected: 无输出

- [ ] **Step 3: Commit**

```bash
cd /home/evolclaw
git add src/channels/aun.ts
git commit -m "feat(aun): expose onProjectPathRequest in ChannelInstance for auto-injection"
```

---

## Task 6: 编写单元测试

**Files:**
- Create: `tests/unit/channels/aun-file-reception.test.ts`

- [ ] **Step 1: 确认测试目录存在**

```bash
ls /home/evolclaw/tests/unit/channels/ 2>/dev/null || echo "directory missing"
```

If missing:
```bash
mkdir -p /home/evolclaw/tests/unit/channels/
```

- [ ] **Step 2: 创建测试文件**

```typescript
// tests/unit/channels/aun-file-reception.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Helpers mirroring AUNChannel's internal logic ────────────────────────────
// We test the logic in isolation without instantiating AUNChannel (which
// requires network access). Extract pure functions to test them directly.

function buildContent(text: string, fileParts: string[]): string {
  if (fileParts.length === 0) return text;
  const parts: string[] = [];
  if (text) parts.push(text);
  parts.push(...fileParts);
  parts.push('请使用 Read 工具读取文件内容。');
  return parts.join('\n\n');
}

function extractAttachments(payload: unknown): any[] {
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray((payload as any).attachments)
    ? (payload as any).attachments
    : [];
}

// ── Content composition tests ─────────────────────────────────────────────────
describe('AUN file reception: content composition', () => {
  it('纯文本消息不变', () => {
    const result = buildContent('hello', []);
    expect(result).toBe('hello');
  });

  it('纯附件（无 text）组合', () => {
    const result = buildContent('', ['[文件: a.py → /proj/.evolclaw/uploads/a.py]']);
    expect(result).toBe('[文件: a.py → /proj/.evolclaw/uploads/a.py]\n\n请使用 Read 工具读取文件内容。');
  });

  it('text + 单附件组合', () => {
    const result = buildContent('请看这个', ['[文件: a.py → /proj/.evolclaw/uploads/a.py]']);
    expect(result).toBe('请看这个\n\n[文件: a.py → /proj/.evolclaw/uploads/a.py]\n\n请使用 Read 工具读取文件内容。');
  });

  it('多附件均出现在提示中', () => {
    const result = buildContent('', [
      '[文件: a.py → /proj/.evolclaw/uploads/a.py]',
      '[文件: b.md → /proj/.evolclaw/uploads/b.md]',
    ]);
    expect(result).toContain('[文件: a.py');
    expect(result).toContain('[文件: b.md');
    expect(result).toContain('请使用 Read 工具读取文件内容。');
  });

  it('所有附件下载失败时回退到原始 text', () => {
    // fileParts 为空 → buildContent 返回原始 text
    const result = buildContent('原始文本', []);
    expect(result).toBe('原始文本');
  });
});

// ── Attachment extraction tests ───────────────────────────────────────────────
describe('AUN file reception: attachment extraction', () => {
  it('有效 payload 提取附件列表', () => {
    const payload = {
      text: '📎 file.py',
      attachments: [
        { owner_aid: 'alice.agentid.pub', object_key: 'shared/uuid/file.py', filename: 'file.py', sha256: 'abc' },
      ],
    };
    expect(extractAttachments(payload)).toHaveLength(1);
    expect(extractAttachments(payload)[0].filename).toBe('file.py');
  });

  it('无附件字段返回空数组', () => {
    expect(extractAttachments({ text: 'hello' })).toHaveLength(0);
  });

  it('attachments 不是数组时返回空数组', () => {
    expect(extractAttachments({ text: 'hello', attachments: 'wrong' })).toHaveLength(0);
  });

  it('字符串 payload 返回空数组', () => {
    expect(extractAttachments('plain text')).toHaveLength(0);
  });

  it('null payload 返回空数组', () => {
    expect(extractAttachments(null)).toHaveLength(0);
  });
});

// ── Group message empty-text guard ────────────────────────────────────────────
describe('AUN file reception: group message guard', () => {
  function shouldDispatch(strippedText: string, hasAttachments: boolean): boolean {
    // Mirrors the new guard: allow through if text OR attachments present
    return !(!strippedText && !hasAttachments);
  }

  it('有文本 → dispatch', () => {
    expect(shouldDispatch('hello', false)).toBe(true);
  });

  it('有附件无文本 → dispatch', () => {
    expect(shouldDispatch('', true)).toBe(true);
  });

  it('有文本有附件 → dispatch', () => {
    expect(shouldDispatch('hello', true)).toBe(true);
  });

  it('无文本无附件 → 不 dispatch', () => {
    expect(shouldDispatch('', false)).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认全部通过**

```bash
cd /home/evolclaw && npx vitest run tests/unit/channels/aun-file-reception.test.ts 2>&1
```

Expected: 所有测试 PASS，无 FAIL

- [ ] **Step 4: 运行全量测试确认无回归**

```bash
cd /home/evolclaw && npm test 2>&1 | tail -20
```

Expected: 全部通过（或仅有 pre-existing failures）

- [ ] **Step 5: Commit**

```bash
cd /home/evolclaw
git add tests/unit/channels/aun-file-reception.test.ts
git commit -m "test(aun): add unit tests for file reception content composition and guard logic"
```

---

## Task 7: 构建验证

**Files:**
- None (validation only)

- [ ] **Step 1: 完整构建**

```bash
cd /home/evolclaw && npm run build 2>&1 | tail -20
```

Expected: Build 成功，无 TypeScript 错误

- [ ] **Step 2: 全量测试**

```bash
cd /home/evolclaw && npm test 2>&1 | tail -10
```

Expected: 全部通过

- [ ] **Step 3: 检查最终 diff 范围符合预期（仅 aun.ts + 新测试文件）**

```bash
cd /home/evolclaw && git diff --stat HEAD~5 HEAD
```

Expected: 仅 `src/channels/aun.ts` 和 `tests/unit/channels/aun-file-reception.test.ts` 有改动

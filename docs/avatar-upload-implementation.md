# Agent 头像上传功能实现方案

## 1. 需求概述

### 1.1 目标

允许 Evol app 通过 menu 协议为 agent 上传头像图片。图片上传到该 agent 自己的 AUN storage，公开可访问的头像 URL 写入 `agent.md` YAML frontmatter 的 `avatar` 字段，并通过 `agentmdPut()` 重新签名发布。

### 1.2 用户场景

1. **创建 agent 时设置头像**：Evol app 创建 agent 后，等待 `createProgress.status === "ready"`，再调用 `agent/update` 上传头像。
2. **修改已有 agent 头像**：用户在 Agents 页面点击"更换头像"、选择图片、前端压缩后上传。

### 1.3 技术约束

- 头像必须上传到 agent 自己的 AUN storage，使用 agent AID 鉴权。
- 头像对象必须公开可访问：`is_private: false`。
- `agent.md` 必须通过 `agentmdPut()` 上传，由 SDK 重新签名，不能手工保留旧签名。
- 后端硬限制：解码后的图片大小 `<= 500 * 1024` bytes。
- MIME 白名单：`image/png`、`image/jpeg`、`image/webp`。
- `patch.avatar` 不能和其他 patch 字段混合提交；混合提交直接报错。

---

## 2. 关键决策

### 2.1 头像 URL 格式

按 GitHub 最新 `aun-sdk-core` storage 文档，`url` 是默认推荐的 AID 风格 URL：

```text
https://{owner_aid}/{object_key}
```

因此 `agent.md` 中写入的 `avatar` 应优先来自 storage RPC 返回的 `url` 字段。例如：

```yaml
avatar: "https://evolai.agentid.pub/shared/avatars/abc123.png"
```

不要写旧式 `https://{aid}/storage/{object_key}`。兼容兜底顺序：

1. `complete_upload` 返回的 `url`
2. `create_download_ticket` 返回的 `url`
3. `create_download_ticket` 返回的 `download_url`
4. 本地兜底拼接：`https://${aid}/${objectKey}`

### 2.2 patch 混合策略

`avatar` 是 `agent.md` 字段，不属于 `agents/<aid>/config.json`。为避免一次请求里产生两个不同持久化目标的部分成功，`patch.avatar` 不能和 `chatmode`、`owners`、`channels` 等字段同传。

错误示例：

```json
{
  "patch": {
    "avatar": "data:image/png;base64,...",
    "chatmode": { "private": "interactive" }
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "req-1",
  "name": "agent",
  "error": {
    "code": "INVALID_ARGS",
    "message": "avatar 不能与其他 patch 字段同时提交，请拆分为两次 update"
  }
}
```

### 2.3 500KB 硬限制

前端压缩到 500KB 只是用户体验优化；后端必须按解码后的 `Buffer.length` 强制校验。实现时应先根据 base64 字符串长度做粗略预检，避免明显超限的数据 URL 被完整 decode 后才拒绝。

---

## 3. 技术架构

### 3.1 调用链路

```text
Evol app
  -> menu.action name=agent action=update args.patch.avatar=<data URL>
MessageBridge.handleMenuAction()
  -> CommandHandler.execMenuAction('/agent', 'update', args, ...)
  -> execAgentAction('update', args, ...)
  -> execAgentUpdate(args)
  -> uploadAvatar()
       -> validate data URL + decoded image
       -> agentmdGet()
       -> storageUpload(..., { isPublic: true, contentType })
       -> updateAgentMdFrontmatter()
       -> agentmdPut()
```

### 3.2 文件布局

```text
src/
├── core/message/
│   └── command-handler-agent-control.ts  # 扩展 execAgentUpdate / execAgentAction
├── utils/
│   ├── avatar-upload.ts                  # 新增：头像上传核心逻辑
│   └── yaml-frontmatter.ts               # 新增：agent.md frontmatter 更新工具
└── aun/
    └── storage/
        └── upload.ts                     # 扩展 storageUpload(contentType + url)
```

---

## 4. menu 协议

### 4.1 请求格式

```json
{
  "type": "menu.action",
  "id": "avatar-001",
  "name": "agent",
  "action": "update",
  "args": {
    "aid": "evolai.agentid.pub",
    "patch": {
      "avatar": "data:image/png;base64,iVBORw0KGgoAAAANS..."
    }
  }
}
```

### 4.2 成功响应

```json
{
  "type": "menu.response",
  "id": "avatar-001",
  "name": "agent",
  "data": {
    "aid": "evolai.agentid.pub",
    "avatar": "https://evolai.agentid.pub/shared/avatars/uuid.png",
    "saved": true
  }
}
```

### 4.3 失败响应

```json
{
  "type": "menu.response",
  "id": "avatar-001",
  "name": "agent",
  "error": {
    "code": "INVALID_ARGS",
    "message": "头像大小超过 500KB 限制（当前: 768KB）"
  }
}
```

---

## 5. agent.md 更新规则

### 5.1 变更前

```yaml
---
aid: "evolai.agentid.pub"
name: "evolai"
type: "ai"
version: "1.0.0"
description: ""
tags:
  - evolclaw
---
```

### 5.2 变更后

```yaml
---
aid: "evolai.agentid.pub"
name: "evolai"
type: "ai"
version: "1.0.0"
avatar: "https://evolai.agentid.pub/shared/avatars/abc123.png"
description: ""
tags:
  - evolclaw
---
```

### 5.3 签名处理

`agent.md` 的签名块签的是 `<!-- AUN-SIGNATURE` 之前的 payload。修改 frontmatter 后，旧签名必然失效。

正确流程：

1. `agentmdGet(aid)` 读取当前内容。
2. 剥离尾部 `<!-- AUN-SIGNATURE ... -->` 签名块，只保留 payload。
3. 更新 payload 中的 YAML frontmatter。
4. 调用 `agentmdPut(newPayload, { aid })`。
5. SDK 内部重新签名并上传，成功后本地 `agent.md` 会包含新的签名块。

不要把旧签名块当正文保留后再改 frontmatter。

---

## 6. 实现细节

### 6.1 `utils/yaml-frontmatter.ts`

不建议为这个需求新增 `gray-matter` 依赖。当前只需要对 `agent.md` frontmatter 的 `avatar` 字段做保序更新，可以用轻量定制工具实现。

核心函数：

```typescript
export interface FrontmatterUpdateResult {
  content: string;
  changed: boolean;
}

export function stripAgentMdSignature(content: string): string;
export function updateAgentMdFrontmatter(
  content: string,
  updates: Record<string, string>
): FrontmatterUpdateResult;
```

实现要点：

- `stripAgentMdSignature()` 只剥离文件尾部合法签名块。
- `updateAgentMdFrontmatter()` 要求文件以 `---` frontmatter 开头，否则抛错。
- 已存在 `avatar:` 时原地替换该行。
- 新增 `avatar:` 时优先插入到 `version` 后；没有 `version` 时插入到 frontmatter 结束前。
- 保留已有字段顺序、缩进、Markdown body。
- 输出 payload 末尾保留换行，交给 `agentmdPut()` 重签。

### 6.2 `aun/storage/upload.ts`

扩展现有 `storageUpload()`：

```typescript
export async function storageUpload(
  aid: string,
  localFile: string,
  remotePath: string,
  opts?: {
    isPublic?: boolean;
    aunPath?: string;
    contentType?: string;
  }
): Promise<UploadResult>
```

实现要点：

- `content_type` 使用 `opts.contentType ?? "application/octet-stream"`。
- `create_upload_session` 和 `complete_upload` 都传 `content_type`。
- `complete_upload` 后优先读取 `completeResult.result.url`。
- 如果没有 `url`，公开对象再调用 `storage.create_download_ticket` 取 `url` / `download_url`。
- `publicUrl` 不再拼成 `/storage/` 路径。

URL 解析顺序示例：

```typescript
const publicUrl =
  completeResult.result?.url ||
  ticketResult.result?.url ||
  ticketResult.result?.download_url ||
  `https://${aid}/${remotePath}`;
```

### 6.3 `utils/avatar-upload.ts`

核心函数：

```typescript
export interface UploadAvatarResult {
  ok: boolean;
  publicUrl?: string;
  objectKey?: string;
  error?: string;
  code?: 'INVALID_ARGS' | 'NOT_FOUND' | 'UPLOAD_FAILED';
}

export async function uploadAvatar(
  aid: string,
  dataUrl: string,
  opts?: { aunPath?: string }
): Promise<UploadAvatarResult>
```

实现流程：

1. **验证 data URL**
   - 格式：`data:image/(png|jpeg|webp);base64,`
   - base64 粗略预检：估算解码后大小，超过 500KB 直接拒绝。
   - 解码为 `Buffer` 后用 `buffer.length` 做硬限制。

2. **验证图片类型**
   - 复用 `src/utils/media-cache.ts` 的 `validateImage()`，传入：
     - `maxSize: 500 * 1024`
     - `allowedMimes: new Set(["image/png", "image/jpeg", "image/webp"])`
   - 验证检测出的 MIME 与 data URL 声明 MIME 一致。
   - 根据检测出的 MIME 决定扩展名：png / jpg / webp。

3. **先读取 agent.md**
   - 调用 `agentmdGet(aid)`。
   - 读取失败直接返回 `NOT_FOUND` 或 `UPLOAD_FAILED`，不要先上传 storage。

4. **写临时文件**
   - 用 `fs.mkdtempSync(path.join(os.tmpdir(), "evolclaw-avatar-"))` 创建临时目录。
   - 文件名使用 `avatar.${ext}`。
   - finally 中删除临时文件和临时目录。

5. **上传到 storage**
   - `remotePath = shared/avatars/${crypto.randomUUID()}.${ext}`
   - 调用：

```typescript
storageUpload(aid, tmpPath, remotePath, {
  isPublic: true,
  contentType: detectedMime,
  aunPath: opts?.aunPath,
})
```

6. **更新 agent.md 并重签**
   - 剥离旧签名块。
   - 更新 frontmatter：`{ avatar: publicUrl }`。
   - 调用 `agentmdPut(newPayload, { aid, aunPath })`。

7. **失败清理**
   - storage 上传失败：删除临时文件即可。
   - `agentmdPut()` 失败：对刚上传的 `remotePath` 做 best-effort `storageRm(aid, remotePath)`；删除失败只记录日志，不掩盖原错误。

### 6.4 `command-handler-agent-control.ts`

`execAgentUpdate()` 负责识别 `patch.avatar` 和混合 patch 报错；`execAgentAction()` 负责发布 EventBus 事件。

建议逻辑：

```typescript
export async function execAgentUpdate(args: Record<string, any> | undefined): Promise<ExecResult> {
  const a = args ?? {};
  if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };

  const p = a.patch ?? {};
  if (p.aid !== undefined) {
    return { error: 'aid 不可修改（AUN 身份绑定，如需换 AID 请删除后重建）', code: 'INVALID_ARGS' };
  }
  if (Array.isArray(p.channels) && p.channels.some((c: any) => c?.type === 'aun')) {
    return { error: 'AUN 渠道不可通过 patch 编辑（由 agent aid 隐式管理）', code: 'INVALID_ARGS' };
  }

  const config = loadAgent(a.aid);
  if (!config) return { error: `Agent "${a.aid}" not found`, code: 'NOT_FOUND' };

  if (p.avatar !== undefined) {
    const otherKeys = Object.keys(p).filter(k => k !== 'avatar');
    if (otherKeys.length > 0) {
      return { error: 'avatar 不能与其他 patch 字段同时提交，请拆分为两次 update', code: 'INVALID_ARGS' };
    }
    const result = await uploadAvatar(a.aid, p.avatar, { aunPath: resolveRoot() });
    if (!result.ok) {
      return { error: `头像上传失败: ${result.error}`, code: result.code ?? 'UPLOAD_FAILED' };
    }
    return { data: { aid: a.aid, avatar: result.publicUrl, saved: true } };
  }

  // 原有 config.json patch 逻辑继续保持。
}
```

`execAgentAction()` 中：

```typescript
if (action === 'update') {
  const result = await execAgentUpdate(a);
  if (!('error' in result)) {
    if ((result.data as any)?.avatar) {
      eventBus?.publish({
        type: 'agent:avatar_updated',
        aid: a.aid,
        avatar: (result.data as any).avatar,
        timestamp: Date.now(),
      });
    }
    eventBus?.publish({ type: 'agent:updated', aid: a.aid, timestamp: Date.now() });
  }
  return result;
}
```

同时在 `src/core/event-bus.ts` 的 `AgentLifecycleEvent` union 中新增：

```typescript
| { type: 'agent:avatar_updated'; aid: string; avatar: string; timestamp?: number }
```

---

## 7. 错误处理矩阵

| 错误场景 | 错误码 | 错误消息示例 | 回滚策略 |
|---------|--------|-------------|---------|
| data URL 格式错误 | `INVALID_ARGS` | `avatar 格式错误：必须是 data:image/(png\|jpeg\|webp);base64,` | 无需回滚 |
| base64 明显超限 | `INVALID_ARGS` | `头像大小超过 500KB 限制` | 无需回滚 |
| 解码后大小超限 | `INVALID_ARGS` | `头像大小超过 500KB 限制（当前: 768KB）` | 无需回滚 |
| 图片类型不在白名单 | `INVALID_ARGS` | `不支持的头像格式: image/gif` | 无需回滚 |
| 声明 MIME 与魔数不一致 | `INVALID_ARGS` | `头像格式验证失败：声明 image/png，实际 image/webp` | 无需回滚 |
| patch 混合提交 | `INVALID_ARGS` | `avatar 不能与其他 patch 字段同时提交，请拆分为两次 update` | 无需回滚 |
| AID 不存在 | `NOT_FOUND` | `Agent "xxx" not found` | 无需回滚 |
| agent.md 读取失败 | `NOT_FOUND` / `UPLOAD_FAILED` | `agent.md 不存在或无法读取` | 不上传 storage |
| storage 上传失败 | `UPLOAD_FAILED` | `上传到 AUN storage 失败: ...` | 删除临时文件 |
| agent.md 上传失败 | `UPLOAD_FAILED` | `更新 agent.md 失败: ...` | best-effort 删除刚上传对象 |

---

## 8. 安全考虑

### 8.1 图片类型验证

不要手写 WebP 魔数判断。只检查 `RIFF` 会误收其他 RIFF 容器。复用 `image-type` 识别逻辑，并限制 MIME 白名单。

### 8.2 路径注入防护

- `remotePath` 固定为 `shared/avatars/${uuid}.${ext}`。
- 用户不能指定 remote path。
- UUID 由服务端生成。
- 扩展名来自检测后的 MIME，不来自用户输入。

### 8.3 权限隔离

- 普通 agent channel 下，现有 `menu-handler.ts` 会把 `aid` 强制为当前 channel 绑定 agent，并阻止跨 agent update。
- 控制 channel / ECWeb 下，仍由 `evolclaw.json.owners` 控制进程级权限。
- storage 和 agent.md 更新都使用目标 agent AID 执行。

### 8.4 传输大小

`@agentunion/fastaun` WebSocket transport 当前有约 1MB payload 限制。500KB 图片转 data URL 后约 683KB，加 JSON 包装仍应有余量；但后端仍必须在业务层按 500KB 硬拒绝。

---

## 9. 实现步骤

### Phase 1：基础设施

1. 扩展 `storageUpload()`：支持 `contentType`，返回 AID 风格 `url`。
2. 实现 `utils/yaml-frontmatter.ts`：剥离签名、保序更新 `avatar`。
3. 实现 `utils/avatar-upload.ts`：校验、上传、更新 agent.md。

### Phase 2：menu 集成

4. 扩展 `execAgentUpdate()` 识别 `patch.avatar`。
5. 增加混合 patch 报错。
6. 在 `execAgentAction()` 发布 `agent:avatar_updated`。
7. 更新 `AgentLifecycleEvent` 类型。

### Phase 3：测试

8. 单元测试：frontmatter 更新与签名剥离。
9. 单元测试：avatar data URL 校验、MIME 检测、大小限制。
10. 单元测试：storage / agentmd mock 成功与失败分支。
11. menu action 测试：权限、混合 patch 报错、成功响应。
12. 手动 E2E：Evol app 调用 menu 协议，验证 agent.md 和公开 URL。

### Phase 4：前端适配

13. Agents 页面增加上传头像 UI。
14. 前端压缩到不超过 500KB。
15. 根据错误码显示友好提示。

---

## 10. 测试计划

### 10.1 `yaml-frontmatter.test.ts`

- 解析标准 YAML frontmatter。
- 解析带 Markdown body 的 agent.md。
- 剥离尾部 `AUN-SIGNATURE` 块。
- 更新已有 `avatar` 字段。
- 新增 `avatar` 字段并插入 `version` 后。
- 保留 `tags` 列表、body 和字段顺序。
- frontmatter 缺失时抛出错误。

### 10.2 `avatar-upload.test.ts`

- 有效 PNG data URL 上传成功。
- 有效 JPEG data URL 上传成功。
- 有效 WebP data URL 上传成功。
- 无效 data URL 格式返回 `INVALID_ARGS`。
- base64 粗略预检超限返回 `INVALID_ARGS`。
- 解码后文件大小超限返回 `INVALID_ARGS`。
- 声明 MIME 与检测 MIME 不一致返回 `INVALID_ARGS`。
- `agent.md` 不存在时不调用 storage 上传。
- storage 上传失败后清理临时文件。
- `agentmdPut` 失败后 best-effort 调用 `storageRm`。

### 10.3 `agent-control.test.ts`

- `patch.avatar` 单独提交成功。
- `patch.avatar + chatmode` 返回 `INVALID_ARGS`。
- `patch.avatar + owners` 返回 `INVALID_ARGS`。
- agent 不存在返回 `NOT_FOUND` 且不上传。
- 成功后响应包含 `{ aid, avatar, saved: true }`。

### 10.4 手动 E2E

创建测试 agent：

```bash
ec agent new test-avatar.agentid.pub --non-interactive \
  --project /home/evolclaw \
  --baseagent claude \
  --name "Test Avatar"
```

通过 Evol app 或控制面发送：

```json
{
  "type": "menu.action",
  "id": "avatar-e2e-1",
  "name": "agent",
  "action": "update",
  "args": {
    "aid": "test-avatar.agentid.pub",
    "patch": {
      "avatar": "data:image/png;base64,..."
    }
  }
}
```

验证：

```bash
grep '^avatar:' "$EVOLCLAW_HOME/AIDs/test-avatar.agentid.pub/agent.md"
grep 'AUN-SIGNATURE' "$EVOLCLAW_HOME/AIDs/test-avatar.agentid.pub/agent.md"
curl -I "$(grep '^avatar:' "$EVOLCLAW_HOME/AIDs/test-avatar.agentid.pub/agent.md" | sed -E 's/^avatar:[[:space:]]*\"?([^\"\047]+).*/\1/')"
```

预期：

- `avatar` URL 为 `https://test-avatar.agentid.pub/shared/avatars/...`。
- `agent.md` 有新的 `AUN-SIGNATURE`。
- `curl -I` 返回 2xx 或可跟随跳转后返回 2xx。

---

## 11. 前端接口设计

### 11.1 创建 agent 时带头像

```typescript
const createResp = await menuCall({
  type: 'menu.action',
  id: crypto.randomUUID(),
  name: 'agent',
  action: 'create',
  args: {
    aid: 'newagent.agentid.pub',
    name: 'New Agent',
    baseagent: 'claude',
    project: '/path/to/project',
  },
});

await waitUntilReady(createResp.data.aid);

const avatarResp = await menuCall({
  type: 'menu.action',
  id: crypto.randomUUID(),
  name: 'agent',
  action: 'update',
  args: {
    aid: 'newagent.agentid.pub',
    patch: {
      avatar: await imageToDataUrl(compressedAvatarFile),
    },
  },
});

// avatarResp.data.avatar = "https://newagent.agentid.pub/shared/avatars/..."
```

### 11.2 修改已有 agent 头像

```typescript
const file = await selectImageFile();
const compressed = await compressImage(file, { maxSize: 500 * 1024 });
const dataUrl = await imageToDataUrl(compressed);

const resp = await menuCall({
  type: 'menu.action',
  id: crypto.randomUUID(),
  name: 'agent',
  action: 'update',
  args: {
    aid: currentAgent.aid,
    patch: { avatar: dataUrl },
  },
});

if (resp.error) {
  showError(getUserFriendlyError(resp.error.code, resp.error.message));
} else {
  updateAgentAvatar(resp.data.avatar);
}
```

### 11.3 错误提示

```typescript
const errorMessages: Record<string, string> = {
  INVALID_ARGS: '图片格式或大小不符合要求，请使用小于 500KB 的 PNG、JPEG 或 WebP',
  UPLOAD_FAILED: '上传失败，请检查网络连接后重试',
  NOT_FOUND: 'Agent 不存在或名片尚未准备好，请刷新后重试',
  default: '未知错误，请稍后重试',
};
```

---

## 12. 兼容性与迁移

### 12.1 向后兼容

- 已有 agent 没有 `avatar` 字段时，前端继续显示默认头像。
- 已有 agent 手动写过 `avatar` 字段时，新上传会覆盖该字段。
- 已写入的旧式 `/storage/` URL 不主动迁移；下次上传头像时自然改写为 AID 风格 URL。

### 12.2 Rollback

如果功能需要回滚：

1. 移除或禁用 `execAgentUpdate()` 中的 `patch.avatar` 分支。
2. 前端隐藏上传入口。
3. 已发布的 `avatar` 字段仍保留；前端可选择继续展示或忽略。

---

## 13. 监控与日志

### 13.1 关键日志

```typescript
logger.info(`[avatar-upload] starting upload for ${aid}, size=${sizeKB}KB`);
logger.info(`[avatar-upload] uploaded ${objectKey} -> ${publicUrl}, took ${elapsed}ms`);
logger.info(`[avatar-upload] agent.md updated for ${aid}`);
logger.warn(`[avatar-upload] failed for ${aid}: ${error}`);
```

日志不要输出 base64 原文。

### 13.2 EventBus

```typescript
eventBus.publish({
  type: 'agent:avatar_updated',
  aid: 'evolai.agentid.pub',
  avatar: 'https://evolai.agentid.pub/shared/avatars/...',
  timestamp: Date.now(),
});
```

### 13.3 指标

可后续增加：

- `avatar_upload_success_count`
- `avatar_upload_failed_count`
- `avatar_upload_duration_ms`
- `avatar_upload_size_bytes`

---

## 14. 文档更新清单

| 文件 | 更新内容 |
|-----|---------|
| `docs/aun-menu-protocol-dev-guide-v2.3.md` | 说明 `agent/update` 支持 `patch.avatar` |
| `kits/docs/evolclaw/agent.md` | 增加头像上传能力备注（如暴露 CLI 或菜单说明） |
| `src/core/event-bus.ts` | 新增 `agent:avatar_updated` 事件类型 |
| `README.md` | 无需更新，属于管理面内部能力 |

---

## 15. 交付物检查清单

### 代码

- [ ] `src/aun/storage/upload.ts` 支持 `contentType` 和 AID 风格 `url`
- [ ] `src/utils/yaml-frontmatter.ts`
- [ ] `src/utils/avatar-upload.ts`
- [ ] `src/core/message/command-handler-agent-control.ts` 扩展完成
- [ ] `src/core/event-bus.ts` 事件类型更新

### 测试

- [ ] 单元测试通过
- [ ] menu action 权限与错误分支测试通过
- [ ] `npm run build` 通过
- [ ] 手动 E2E 验证公开 URL 和 agent.md 新签名

### 前端

- [ ] 图片选择与压缩
- [ ] `menu.action agent/update` 调用
- [ ] 错误提示映射
- [ ] 成功后刷新头像缓存

---

## 16. 风险与缓解

| 风险 | 影响 | 缓解 |
|-----|------|------|
| storage 返回字段随网关版本差异变化 | URL 为空或不可访问 | 按 `url -> download_url -> 本地拼接` 兜底，并做 E2E |
| `agentmdPut` 失败 | storage 已上传但名片未更新 | best-effort 删除刚上传对象；失败记录日志 |
| 前端传超大 data URL | 内存压力或传输失败 | 前端压缩 + 后端 base64 长度预检 + 500KB 硬限制 |
| MIME 伪造 | 非图片进入公开 storage | `image-type` 魔数检测并比对声明 MIME |
| 旧签名处理错误 | agent.md 验签失败 | 明确剥离旧签名，只让 SDK 重签；测试覆盖 |

---

## 附录 A：参考资料

- 最新 AUN SDK storage 文档：https://github.com/ModelUnion/aun-sdk-core/blob/main/docs/sdk/09-storage-rpc-manual.md
- AUN Storage 协议文档：https://github.com/ModelUnion/aun-sdk-core/blob/main/docs/protocol/11-Storage-%E5%AD%90%E5%8D%8F%E8%AE%AE.md
- agent.md 签名规范：https://github.com/ModelUnion/aun-sdk-core/tree/main/docs/agent.md

---

**文档版本**：v1.1  
**创建时间**：2026-06-23  
**更新时间**：2026-06-23  
**状态**：已按评审结论修订，待实现

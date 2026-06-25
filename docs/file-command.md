# `/file` 命令设计与实现文档

## 概述

`/file` 是一个管理员级快捷命令，允许直接从项目目录发送文件给用户，无需经过 Agent 对话。

## 命令规格

| 项 | 说明 |
|---|---|
| 命令 | `/file <相对路径>`；owner 可用 `/file <channel> <相对路径>` 跨渠道发送 |
| 权限 | 同渠道项目内文件：owner/admin；跨渠道发送：仅 owner |
| 队列 | 快捷命令，**不进消息队列**，处理中也可使用 |
| 渠道支持 | 需 `adapter.sendFile` 能力（Feishu ✅、WeChat ✅） |

## 使用示例

```
/file src/index.ts
/file .claude/uploads/report.pdf
/file dist/output.json
/file feishu dist/output.json
```

前三个示例发送到当前会话所在渠道，owner/admin 均可使用。最后一个示例显式指定目标渠道，属于跨渠道发送，仅 owner 可使用。

## 安全策略

| 策略 | 规则 |
|---|---|
| 路径格式 | 仅相对路径，`./` 前缀允许（等价于无前缀） |
| 路径穿越 | 拒绝含 `..` 的路径段 |
| 绝对路径 | 拒绝 `/` 开头的路径 |
| 符号链接 | `realpathSync` 解析后验证仍在项目目录内 |
| 跨渠道发送 | 仍执行同一套项目内路径校验，并额外要求 owner |
| 文件大小 | 单文件最大 **10 MB** |
| 目录 | 一期拒绝，提示后续版本支持 |

## 响应示例

```
✅ 已发送: src/index.ts (12.3 KB)
❌ 文件不存在: xxx.txt
❌ 不支持绝对路径
❌ 不支持 .. 路径穿越
❌ 路径不允许: 文件不在项目目录内
❌ 文件过大: 12.5 MB (限制 10 MB)
❌ 暂不支持发送目录（二期支持）
❌ 当前渠道不支持文件发送
❌ 跨渠道发送需要 owner 权限
```

## 图片自动识别

Feishu 渠道的 `sendFile` 内部使用 `image-type` 库检测文件头：
- 图片格式（png/jpg/gif/webp 等）→ `im.image.create` → **内联图片预览**
- 其他格式 → `im.file.create` → 文件卡片

用户无需区分，统一使用 `/file` 即可。

## 话题会话支持

`/file` 通过 `getReplyContext(session)` 获取话题回复上下文，在飞书话题中发送的文件会正确回复到话题内，不会跑到主会话窗口。

## 实现位置

- `src/core/command/slash-handler.ts` — `/file` 文本命令解析、鉴权、项目内路径校验
- `src/core/command/menu-handler.ts` — menu `file` 查询/拉取入口（支持项目内绝对路径；项目外仅 owner）
- `src/channels/feishu.ts` — `sendFile` 图片自动识别（`image-type`）

## 二期规划：目录打包发送

| 项 | 说明 |
|---|---|
| 触发 | `/file src/` 或 `/file logs/` |
| 打包工具 | 系统 `zip` 命令（`/usr/bin/zip`） |
| 排除目录 | `node_modules/`、`.git/`、`dist/`、`.claude/` |
| 大小限制 | zip 后 **10 MB** |
| 临时文件 | `/tmp/{dirname}-{timestamp}.zip`，发送后自动清理 |
| 命名 | `{dirname}.zip` |

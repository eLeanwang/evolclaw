# ec agent — EvolAgent 生命周期管理

管理本机托管的 EvolAgent（创建、启停、配置、热重载）。触发词：创建/新建/列出/查看/启用/禁用/删除/热重载/改配置。

## 子命令

```bash
# 列出所有 agent
ec agent list

# 查看 agent 详情（身份 + 配置 + 连接 + 会话 + 路径）
ec agent show <aid>

# 创建 agent（交互式）
ec agent new [aid]

# 创建 agent（非交互式，自动化场景）
ec agent new <aid> --non-interactive --project <绝对路径> \
  [--baseagent claude|codex|gemini] [--owner <aid>] \
  [--name "<显示名>"] [--description "<text>"] [--force]

# 启用 / 停用
ec agent enable <aid>
ec agent disable <aid>

# 读 / 改单个配置字段（支持点路径，如 active_baseagent）
ec agent get <aid> <key>
ec agent set <aid> <key> <val>

# 热重载配置（无参数 = 全量 resync：扫磁盘，新增上线/删除下线/修改热更新）
ec agent reload [aid]

# 删除 agent（--purge 连数据一并清除）
ec agent delete <aid> [--purge]
```

## 非交互创建必填项

`ec agent new <aid> --non-interactive` 时：
- 必填：`--project <absolute path>`
- 可选：`--baseagent`（默认 PATH 中第一个可用项）、`--owner`、`--name`、`--description`、`--force`（覆盖已有 config.json）

## 头像更新

头像上传通过 menu 协议暴露，不是 `ec agent` CLI 子命令：

```json
{
  "type": "menu.action",
  "name": "agent",
  "action": "update",
  "args": {
    "aid": "mybot.agentid.pub",
    "patch": {
      "avatar": "data:image/png;base64,..."
    }
  }
}
```

约束：
- `patch.avatar` 必须单独提交，不能和 `chatmode`、`owners`、`channels` 等 config patch 混合。
- 支持 PNG/JPEG/WebP；后端按解码后图片大小硬限制 500KB。
- 成功后头像上传到该 agent 自己的 AUN storage，`agent.md` frontmatter 写入 AID 风格 URL，并重新签名发布。

## 通用约定

- `--format json` — 输出 JSON
- `--help` / `-h` — 各子命令均支持，查看详细用法

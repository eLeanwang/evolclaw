# AUN CLI 功能路线图

> AUN 网络接入开发者的日常工具 — 轻量、实用、可调试

## 定位

AUN CLI 是接入开发者体验和调试 AUN 协议的工具，不是 IM 客户端。
类比：Postman 之于 HTTP，Redis CLI 之于 Redis。

设计原则：
- 多实例并行（不同终端窗口各跑一个 AID），启动后身份不可切换
- 功能按协议能力域组织，每个域提供最小可用的命令入口
- 不做产品化功能（联系人体系、消息历史数据库、插件系统等）
- SDK 未实现或未完备的能力不纳入规划

## 已实现

- Gateway 连接、自动重连
- E2EE / 明文消息收发，模式切换
- 远端命令菜单（`//` 前缀透传）
- Processing 状态跟踪、中断（Ctrl+C → /stop）
- AID 自动创建与复用（config.json 持久化）
- 调试模式（ACK 时序、E2EE 事件、原始消息）
- Target 记忆（持久化到 config.json）

---

## 待做

### 1. 身份管理

多实例测试的基础设施。开发者经常需要多个 AID 模拟不同角色。

当前问题：AID 自动生成，散落在 `DATA_DIR` 下，无法管理。

目标：
- [ ] `aun --aid <name>` 按名称启动（如 `aun --aid alice`、`aun --aid bob`）
- [ ] `aun aid list` — 列出本地所有 AID（子命令，不需要连接网关）
- [ ] `aun aid create <name>` — 创建并命名新 AID
- [ ] `aun aid delete <name>` — 删除本地 AID
- [ ] `aun aid export/import` — 备份恢复（私钥 + 证书）
- [ ] 无参启动时使用 config.json 中的默认 AID

技术要点：
- AID 索引：`~/.aun/aun-cli/aids.json`（name → aid 映射）
- 每个 AID 的 keystore 已经按 AID 隔离在 `DATA_DIR/` 下
- FileKeyStore 有 `load_identity` / `save_identity` / `delete_identity`
- 备份格式待定（JSON + 密码加密，或直接 tar 目录）

### 2. 群组

接入开发者调试群聊功能时需要一个现成客户端参与。

目标：
- [ ] `/group create <name>` — 建群
- [ ] `/group list` — 列出已加入的群
- [ ] `/group join <id>` — 加入群组（ID 或邀请码）
- [ ] `/group <id>` — 切换当前聊天目标到群组（之后直接输入文字即发群消息）
- [ ] `/group info` — 当前群详情（成员、epoch、E2EE 状态）
- [ ] `/group leave` — 退出当前群
- [ ] 群消息接收（显示发送者 AID 前缀）
- [ ] 群变更事件显示（成员加入/离开/被踢）

技术要点：
- `client.call("group.*")` 裸调，SDK 自动处理 E2EE epoch
- 需要维护 `current_target` 类型（P2P AID vs group_id）
- 群消息事件：`group.message_created`
- 群变更事件：`group.changed`（SDK 已自动订阅并透传）

### 3. 文件传输

开发者调试文件收发功能。不需要单独入口，就是一个命令。

目标：
- [ ] `/send <path>` — 发送本地文件给当前 target
- [ ] 自动选择传输方式：≤64KB 内联 base64，>64KB 走 Storage upload
- [ ] 接收方自动识别文件消息，下载到 `~/.aun/aun-cli/downloads/`
- [ ] 显示文件名、大小、传输方式

技术要点：
- 小文件：payload `{type: "file", name, content, size, mime}`
- 大文件：`storage.create_upload_session` → HTTP PUT → `storage.complete_upload` → 发消息带 `storage_key`
- 接收端检测 payload.type == "file"，有 storage_key 则 `storage.create_download_ticket` 下载

### 4. Agent 搜索

在 AUN 网络中发现可用的 Agent / 服务。

目标：
- [ ] `/search <keyword>` — 搜索 Agent
- [ ] 结果显示 AID、名称、描述
- [ ] 选中后可直接 `/target` 切换

技术要点：
- `client.call("search.agents", {query, limit})`
- 结果中的 AID 可直接用于 `/target`

### 5. Storage 操作

直接操作 AUN Storage 服务，调试对象存储功能。

目标：
- [ ] `/storage ls [prefix]` — 列出对象
- [ ] `/storage put <key> <local_path>` — 上传
- [ ] `/storage get <key> [local_path]` — 下载
- [ ] `/storage rm <key>` — 删除
- [ ] `/storage info <key>` — 查看对象元数据
- [ ] `/storage quota` — 查看配额

技术要点：
- 全部通过 `client.call("storage.*")` 裸调
- 大文件走 upload session / download ticket + HTTP

---

## 增强（按需）

这些不急，看实际使用中是否有需求再做。

- `/pull` — 拉取离线消息（`message.pull`）
- `/recall` — 撤回消息（`message.recall`，SDK 已有事件支持）
- 消息 ACK 可视化 — 发送确认 ✓、送达 ✓✓（SDK 已有 `message.ack` 事件）
- Target 别名 — `/alias <name> <aid>` 给常用 AID 起短名，补全时可用
- 调试增强 — 原始 RPC 调用模式（`/rpc <method> <json_params>`），直接调任意协议方法

---

## 不做

- 联系人体系（协议无此模块，纯客户端产品功能，太重）
- 本地消息持久化 / SQLite（开发者看当前会话就够，历史看日志）
- Peer 直连（SDK 层面没有高层封装，需要自己实现 WebSocket 服务器，复杂度高收益低）
- 任务协作（`task.*` 太应用层，开发者用 `/rpc` 裸调即可）
- 插件系统、主题、声音通知等产品化功能
- 运行时切换 AID（多实例并行解决）

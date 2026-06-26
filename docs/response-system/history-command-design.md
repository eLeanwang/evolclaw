# History 命令集设计方案

## 文档说明

**版本**: 1.0  
**创建时间**: 2026-06-26  
**状态**: 设计方案

### 目标

设计一个独立的 `history` 命令集，用于查询和管理本地消息历史，支持消息折叠/展开、交互查询、高级过滤等功能。

### 与 `msg` 命令集的区别

```
msg 命令集:
  - 用于发送消息
  - 实时通信操作
  - 与渠道适配器交互
  
history 命令集:
  - 用于查询历史消息
  - 只读操作（除了折叠管理）
  - 与本地 SQLite 数据库交互
```

---

## 一、数据模型

### 1.1 SQLite 表结构

#### 表 1: messages

```sql
CREATE TABLE messages (
  -- 主键
  message_id TEXT PRIMARY KEY,
  
  -- 基础信息
  session_key TEXT NOT NULL,
  content TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  peer_name TEXT,
  timestamp INTEGER NOT NULL,
  
  -- 附件和引用
  attachments TEXT,  -- JSON array
  referenced_messages TEXT,  -- JSON array of message IDs
  
  -- 辅助会话标注
  interaction_ids TEXT,  -- JSON array
  pattern_tags TEXT,  -- JSON array
  action_strategy TEXT,
  participation_intent TEXT,
  importance INTEGER DEFAULT 5,
  folded INTEGER DEFAULT 0,  -- 0=false, 1=true
  summary TEXT,
  
  -- 元数据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 索引
CREATE INDEX idx_messages_session_key ON messages(session_key);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_importance ON messages(importance);
CREATE INDEX idx_messages_folded ON messages(folded);
CREATE INDEX idx_messages_session_timestamp ON messages(session_key, timestamp);
CREATE INDEX idx_messages_peer ON messages(peer_id);
```

#### 表 2: interactions

```sql
CREATE TABLE interactions (
  -- 主键
  interaction_id TEXT PRIMARY KEY,
  
  -- 基础信息
  session_key TEXT NOT NULL,
  pattern TEXT NOT NULL,
  
  -- 生命周期
  start_message_id TEXT NOT NULL,
  end_message_id TEXT,
  status TEXT NOT NULL,  -- active, completed, abandoned
  
  -- 参与者
  participants TEXT NOT NULL,  -- JSON array
  messages TEXT NOT NULL,  -- JSON array of message IDs
  
  -- 时间信息
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  
  -- 元数据
  topic TEXT,
  goal TEXT,
  outcome TEXT,
  ai_participated INTEGER DEFAULT 0,  -- 0=false, 1=true
  
  FOREIGN KEY (start_message_id) REFERENCES messages(message_id),
  FOREIGN KEY (end_message_id) REFERENCES messages(message_id)
);

-- 索引
CREATE INDEX idx_interactions_session_key ON interactions(session_key);
CREATE INDEX idx_interactions_status ON interactions(status);
CREATE INDEX idx_interactions_pattern ON interactions(pattern);
CREATE INDEX idx_interactions_created_at ON interactions(created_at);
```

#### 表 3: message_interaction_map (多对多关系表)

```sql
CREATE TABLE message_interaction_map (
  message_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  PRIMARY KEY (message_id, interaction_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  FOREIGN KEY (interaction_id) REFERENCES interactions(interaction_id)
);

CREATE INDEX idx_map_message ON message_interaction_map(message_id);
CREATE INDEX idx_map_interaction ON message_interaction_map(interaction_id);
```

---

## 二、命令集设计

### 2.1 命令分组

```
基础查询:
  - get           查询单条或多条消息
  - list          列出消息
  - search        全文搜索

交互查询:
  - interaction   查询交互的所有消息
  - interactions  列出交互

折叠管理:
  - fold          折叠消息
  - unfold        展开消息

统计分析:
  - stats         统计信息

导出:
  - export        导出消息

清理:
  - clean         清理旧消息
```

---

### 2.2 详细命令设计

#### 命令: `get`

**用途**: 查询单条或多条消息

**语法**:
```bash
ec history get <message-id>
ec history get --ids <id1,id2,id3>
ec hist get msg-123
ec hist get --ids msg-1,msg-2,msg-3
```

**参数**:
- `<message-id>` - 单个消息 ID
- `--ids <ids>` - 逗号分隔的消息 ID 列表
- `--format <format>` - 输出格式：`text` | `json` | `markdown`（默认 `text`）

**输出** (text 格式):
```
[Msg-123] 2026-06-26 10:06:00
发送者: 张三 (ou_xxx)
内容: @AI 帮我看看这段代码

标注:
  交互: int-456
  形态: A1 (直接求助)
  策略: S2 (直接回答)
  重要性: 8/10
  折叠: 否
```

**输出** (json 格式):
```json
{
  "messageId": "msg-123",
  "content": "@AI 帮我看看这段代码",
  "peerId": "ou_xxx",
  "peerName": "张三",
  "timestamp": 1719374760000,
  "interactionIds": ["int-456"],
  "patternTags": ["A1"],
  "actionStrategy": "S2",
  "importance": 8,
  "folded": false
}
```

---

#### 命令: `list`

**用途**: 列出消息，支持过滤和排序

**语法**:
```bash
ec history list [options]
ec hist list --limit 50
ec hist list --from "1h ago" --to "now"
ec hist list --important
ec hist list --pattern A1,A5 --unfolded
```

**参数**:
- `--session <key>` - 会话过滤
- `--from <time>` - 开始时间（支持相对时间：`1h ago`, `2d ago`）
- `--to <time>` - 结束时间
- `--limit <n>` - 限制数量（默认 50）
- `--offset <n>` - 跳过前 N 条
- `--peer <peer-id>` - 发送者过滤
- `--pattern <patterns>` - 形态过滤（逗号分隔）
- `--importance-min <n>` - 最低重要性
- `--importance-max <n>` - 最高重要性
- `--important` - 快捷方式，等同于 `--importance-min 7`
- `--intent <intent>` - 参与意愿过滤
- `--folded` - 仅折叠的消息
- `--unfolded` - 仅未折叠的消息
- `--format <format>` - 输出格式
- `--sort <field>` - 排序字段：`timestamp` | `importance`（默认 `timestamp`）
- `--desc` - 降序（默认升序）

**输出**:
```
找到 3 条消息:

[1] Msg-123  2026-06-26 10:06:00  张三  重要性: 8
    @AI 帮我看看这段代码

[2] Msg-124  2026-06-26 10:07:00  张三  重要性: 8
    [代码内容...]

[3] Msg-125  2026-06-26 10:16:00  李四  重要性: 7
    @AI 能总结一下刚才的讨论吗？
```

---

#### 命令: `search`

**用途**: 全文搜索消息内容

**语法**:
```bash
ec history search <query> [options]
ec hist search "数据库连接"
ec hist search "timeout" --from "1d ago" --importance-min 5
```

**参数**:
- `<query>` - 搜索关键词
- `--session <key>` - 会话过滤
- `--from <time>` - 开始时间
- `--to <time>` - 结束时间
- `--limit <n>` - 限制数量
- `--pattern <patterns>` - 形态过滤
- `--importance-min <n>` - 最低重要性
- `--format <format>` - 输出格式

**输出**:
```
搜索 "数据库连接" 找到 2 条结果:

[1] Msg-89  2026-06-26 09:30:00  王五  重要性: 7
    数据库连接一直超时，怎么办？

[2] Msg-92  2026-06-26 09:35:00  AI  重要性: 8
    关于数据库连接超时，可以检查以下几点...
```

---

#### 命令: `interaction`

**用途**: 查询交互的所有消息

**语法**:
```bash
ec history interaction <interaction-id> [options]
ec hist int int-456
ec hist int int-456 --format json
```

**参数**:
- `<interaction-id>` - 交互 ID
- `--format <format>` - 输出格式
- `--include-folded` - 包含折叠的消息（默认包含）
- `--summary` - 仅显示摘要，不显示消息详情

**输出**:
```
交互 #int-456

形态: A1 (直接求助)
状态: completed
参与者: 张三, AI
时间: 2026-06-26 10:06:00 - 10:10:00
AI 参与: 是

消息 (3 条):

[1] Msg-123  10:06:00  张三
    @AI 帮我看看这段代码

[2] Msg-124  10:07:00  张三
    [代码内容...]

[3] Msg-125  10:10:00  AI
    这段代码的问题在于...
```

---

#### 命令: `interactions`

**用途**: 列出交互

**语法**:
```bash
ec history interactions [options]
ec hist ints --session feishu#chat_xyz
ec hist ints --active
ec hist ints --pattern A1,B1
```

**参数**:
- `--session <key>` - 会话过滤
- `--status <status>` - 状态过滤：`active` | `completed` | `abandoned`
- `--active` - 快捷方式，等同于 `--status active`
- `--pattern <patterns>` - 形态过滤
- `--ai-participated` - 仅 AI 参与的交互
- `--from <time>` - 开始时间
- `--to <time>` - 结束时间
- `--limit <n>` - 限制数量
- `--format <format>` - 输出格式

**输出**:
```
找到 5 个交互:

[1] int-450  B1 (技术讨论)  completed  2026-06-26 09:00-09:30
    参与者: 张三, 李四, 王五 (3 人)
    消息数: 12
    AI 参与: 否

[2] int-456  A1 (直接求助)  completed  2026-06-26 10:06-10:10
    参与者: 张三, AI (2 人)
    消息数: 3
    AI 参与: 是

[3] int-460  B2 (技术争论)  active  2026-06-26 10:30-
    参与者: 李四, 王五 (2 人)
    消息数: 8
    AI 参与: 否 (观察中)
```

---

#### 命令: `fold`

**用途**: 手动折叠消息

**语法**:
```bash
ec history fold <message-ids>
ec history fold --interaction <interaction-id>
ec hist fold msg-10,msg-11,msg-12
ec hist fold --int int-450
```

**参数**:
- `<message-ids>` - 逗号分隔的消息 ID
- `--interaction <id>` - 折叠整个交互的所有消息
- `--summary <text>` - 折叠时的摘要（可选）

**输出**:
```
✓ 已折叠 3 条消息
```

---

#### 命令: `unfold`

**用途**: 展开折叠的消息

**语法**:
```bash
ec history unfold <message-ids>
ec history unfold --interaction <interaction-id>
ec hist unfold msg-10,msg-11,msg-12
ec hist unfold --int int-450
```

**参数**:
- `<message-ids>` - 逗号分隔的消息 ID
- `--interaction <id>` - 展开整个交互的所有消息
- `--all` - 展开当前会话的所有折叠消息

**输出**:
```
✓ 已展开 3 条消息
```

---

#### 命令: `stats`

**用途**: 统计信息

**语法**:
```bash
ec history stats [options]
ec hist stats
ec hist stats --interactions
ec hist stats --patterns
ec hist stats --session feishu#chat_xyz
```

**参数**:
- `--session <key>` - 会话过滤
- `--from <time>` - 开始时间
- `--to <time>` - 结束时间
- `--interactions` - 显示交互统计
- `--patterns` - 显示形态分布
- `--format <format>` - 输出格式

**输出** (默认):
```
消息统计 (会话: feishu#chat_xyz)

总消息数: 1,234
  折叠: 800 (64.8%)
  未折叠: 434 (35.2%)

平均重要性: 4.2

重要性分布:
  0-2 分: 300 (24.3%)
  3-5 分: 600 (48.6%)
  6-8 分: 280 (22.7%)
  9-10 分: 54 (4.4%)

时间范围: 2026-06-01 - 2026-06-26 (26 天)
平均每天: 47.5 条
```

**输出** (--interactions):
```
交互统计

总交互数: 45
  活跃: 3 (6.7%)
  已完成: 40 (88.9%)
  已放弃: 2 (4.4%)

AI 参与: 15 (33.3%)

平均每个交互:
  消息数: 8.5
  参与者数: 2.3
  持续时间: 12 分钟
```

**输出** (--patterns):
```
形态分布

A 类 (单人求助型): 18 (40.0%)
  A1 (直接求助): 12
  A2 (分段求助): 3
  A4 (模糊需求): 2
  A5 (紧急求助): 1

B 类 (多人讨论型): 15 (33.3%)
  B1 (技术讨论): 8
  B2 (技术争论): 3
  B3 (头脑风暴): 2
  B7 (求证确认): 2

C 类 (协作工作型): 5 (11.1%)
  C2 (进度汇报): 3
  C5 (会议主持): 2

E 类 (社交互动型): 7 (15.6%)
  E1 (日常闲聊): 7
```

---

#### 命令: `export`

**用途**: 导出消息

**语法**:
```bash
ec history export [options] -o <output-file>
ec hist export --from "2026-06-26" --to "2026-06-27" -o messages.json
ec hist export --int int-456 -o interaction.json
ec hist export --important --format markdown -o report.md
```

**参数**:
- `-o, --output <file>` - 输出文件（必需）
- `--session <key>` - 会话过滤
- `--from <time>` - 开始时间
- `--to <time>` - 结束时间
- `--interaction <id>` - 导出特定交互
- `--pattern <patterns>` - 形态过滤
- `--important` - 仅导出重要消息
- `--format <format>` - 格式：`json` | `markdown` | `csv`（默认 `json`）
- `--include-folded` - 包含折叠的消息

**输出**:
```
✓ 已导出 234 条消息到 messages.json
```

---

#### 命令: `clean`

**用途**: 清理旧消息

**语法**:
```bash
ec history clean [options]
ec hist clean --keep-days 30
ec hist clean --folded --importance-max 2
ec hist clean --interactions --completed --before "30d ago"
```

**参数**:
- `--keep-days <n>` - 保留最近 N 天的消息
- `--before <time>` - 删除该时间之前的消息
- `--folded` - 仅清理折叠的消息
- `--importance-max <n>` - 仅清理重要性 ≤ N 的消息
- `--interactions` - 清理交互（而不是消息）
- `--completed` - 仅清理已完成的交互
- `--dry-run` - 预览将要删除的内容，不实际删除

**输出** (dry-run):
```
[预览模式] 将删除:

消息: 500 条
  - 30 天前的低重要性消息: 450
  - 折叠且不重要的消息: 50

交互: 20 个
  - 已完成的交互: 20

使用 --confirm 确认删除
```

**输出** (确认):
```
✓ 已删除 500 条消息
✓ 已删除 20 个交互

释放空间: 约 2.3 MB
```

---

## 三、实现考虑

### 3.1 性能优化

```
1. 分页查询
   - 大量数据时使用 LIMIT + OFFSET
   - 或使用游标分页

2. 索引优化
   - 针对常用查询创建联合索引
   - 使用 EXPLAIN QUERY PLAN 检查

3. 批量操作
   - fold/unfold 多条消息时使用批量更新
   - 使用事务保证原子性

4. 缓存
   - 热点数据缓存在内存
   - LRU 策略，限制缓存大小
```

### 3.2 数据一致性

```
1. 外键约束
   - 保证引用完整性
   - ON DELETE CASCADE 自动清理

2. 事务
   - 所有写操作使用事务
   - ACID 保证

3. 触发器（可选）
   - 自动更新 updated_at
   - 自动维护统计信息
```

### 3.3 错误处理

```
1. 消息不存在
   → 返回错误：Message not found: msg-123

2. 交互不存在
   → 返回错误：Interaction not found: int-456

3. 权限检查
   → 确保只能访问当前 agent 的消息

4. 数据库错误
   → 捕获并友好提示
```

---

## 四、与现有系统集成

### 4.1 数据流

```
消息到达
  ↓
Channel 适配器
  ↓
辅助会话判断（标注）
  ↓
写入 SQLite (messages 表)
  ↓
主会话处理
  ↓
更新标注（如 ai_participated）
```

### 4.2 存储位置

```
$EVOLCLAW_HOME/data/messages.db

或

$AGENT_DIR/messages.db
```

### 4.3 迁移策略

```
1. 初次运行时创建表
2. 版本升级时执行迁移脚本
3. 保留旧数据，增量迁移
```

---

## 五、后续迭代方向

1. **全文搜索优化** - 使用 FTS5 扩展
2. **消息备份/恢复** - 导出/导入整个数据库
3. **消息同步** - 跨设备同步（可选）
4. **可视化界面** - Web UI 查看消息历史
5. **智能摘要** - 自动生成折叠消息的摘要
6. **关联分析** - 发现消息间的隐含关系

---

**文档版本**: 1.0  
**创建时间**: 2026-06-26  
**维护者**: EvolClaw 团队  
**状态**: 设计方案，待评审
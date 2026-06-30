# ECWeb Codex 支持实施报告

## 实施日期
2026-06-27

## 实施内容

### 1. 环境检测模块 (`src/sources/baseagent-detector.ts`)

检测 Claude 和 Codex 的可用性：

**检测条件**：
- **Claude**: `~/.claude/projects/` 目录存在
- **Codex**: `~/.codex/sessions/` 和 `~/.codex/state_*.sqlite` 存在，且 Node 版本 >= 22.5

**API 端点**: `GET /api/available-baseagents`
- 返回: `{ "claude": boolean, "codex": boolean }`

### 2. Codex 数据源模块 (`src/sources/session-codex.ts`)

完整实现 Codex 会话数据的读取和解析：

**数据来源**：
- 元数据索引：`~/.codex/state_*.sqlite`
- 会话文件：`~/.codex/sessions/YYYY/MM/DD/*.jsonl`

**主要功能**：
- 项目列表：从 state_*.sqlite 的 threads 表按 cwd 分组
- 会话列表：查询指定项目下的所有会话
- 会话详情：解析 rollout JSONL 文件，提取 turns、tokens、cost

**事件解析**：
- `session_meta` → 提取 cli_version
- `event_msg` + `user_message` → 用户输入
- `event_msg` + `agent_message` → 模型输出
- `event_msg` + `reasoning` → thinking（插入到 assistant blocks 开头）
- `event_msg` + `function_call` → tool_use
- `event_msg` + `function_call_output` → tool_result
- `event_msg` + `token_count` → usage 和费用计算
- `payload.model` → 模型名称

**定价表**（2026-06 OpenAI 价格）：
- GPT-5.5: $5 / $30 (input/output per 1M tokens)
- GPT-5.4: $2.5 / $15
- GPT-4o: $2.5 / $10
- GPT-4o-mini: $0.15 / $0.60
- o3: $2 / $8
- 等（完整列表见代码）

**缓存策略**：
- 双层缓存（内存 + 磁盘），与 Claude 对齐
- 缓存目录：`{EVOLCLAW_HOME}/data/ecweb-cache/codex/`

### 3. 统一会话数据源接口 (`src/sources/session.ts`)

修改现有的 session source，支持 `baseagent` 参数：

```typescript
snapshot({ baseagent: 'claude' | 'codex', ... })
subscribe({ baseagent: 'claude' | 'codex', ... }, push)
```

**路由逻辑**：
- `baseagent: 'codex'` → `snapshotCodex()` / `subscribeCodex()`
- `baseagent: 'claude'` → 原有的 `buildSnapshot()` 逻辑

**返回结构**（两者统一）：
```typescript
{
  baseagent: 'claude' | 'codex',
  projects: [...],
  project: encodedPath,
  transcripts: [...],
  turns: [...],
  sessionId: string | null,
  header?: {...}
}
```

### 4. WebSocket 订阅

**Codex**：
- 监听 `state_*.sqlite` 文件变化（mtime）
- 监听 evolclaw `sessionsDir` 的 `active.json` 变化
- 防抖 150ms

**Claude**（保持不变）：
- 监听 `~/.claude/projects/<encoded>/` 的 .jsonl 文件变化
- 监听 evolclaw `sessionsDir` 的 `active.json` 变化

## 测试结果

### 环境检测
```bash
$ curl http://localhost:42705/api/available-baseagents
{"claude":true,"codex":true}
```

### Codex 数据读取
- ✅ 项目列表：5 个项目
- ✅ 会话列表：103 个会话
- ✅ 会话详情：846 轮对话
- ✅ Model 识别：gpt-5.5
- ✅ 费用计算：$636.13
- ✅ 绑定状态：正确标注 bound/online

## 前端集成要点

### 1. 获取可用的 baseagent

```javascript
const response = await fetch('/api/available-baseagents');
const { claude, codex } = await response.json();

// 构建下拉选项
const options = [];
if (claude) options.push({ value: 'claude', label: 'Claude' });
if (codex) options.push({ value: 'codex', label: 'Codex' });
```

### 2. 请求会话数据

```javascript
// WebSocket subscribe 消息
ws.send(JSON.stringify({
  type: 'subscribe',
  view: 'session',
  baseagent: 'codex', // 或 'claude'
  project: 'home-evolclaw', // 可选
  sessionId: '019efeed-1252-72f1-a2fc-06cfa1df1cfa' // 可选
}));
```

### 3. UI 建议

**左侧顶部增加下拉选择器**：
- 默认选中第一个可用的 baseagent
- 切换时重新订阅对应的数据源
- 如果某个 baseagent 不可用，不在下拉列表中显示

## 已知限制

1. **Node 版本要求**：Codex 需要 Node 22.5+（`node:sqlite` 模块）
2. **Codex rollout 格式差异**：部分字段映射不完美（如 reasoning 作为独立事件，需要手动合并到 assistant blocks）
3. **费用计算精度**：依赖定价表准确性，需要定期更新

## 未实现功能

1. ~~前端 UI 改造~~（需要前端配合）
2. ~~多 baseagent 项目匹配优化~~（当前按 cwd 分组，已足够）
3. ~~Codex 会话导出/导入~~（不在本次范围）

## 文件变更清单

### 新增文件
- `src/sources/baseagent-detector.ts` - 环境检测模块
- `src/sources/session-codex.ts` - Codex 数据源
- `test-codex-session.mjs` - 测试脚本

### 修改文件
- `src/server.ts` - 新增 `/api/available-baseagents` 端点
- `src/sources/session.ts` - 支持 baseagent 参数路由

### 构建产物
- `ecweb/dist/` - 已重新构建并部署

## 后续建议

1. **前端实施**：按设计方案 B 改造前端 UI（左侧顶部下拉选择）
2. **定价表维护**：定期更新 OpenAI 定价（建议每季度）
3. **监控日志**：观察 Codex 数据源的性能和错误率
4. **文档补充**：更新 ecweb 用户文档，说明多 baseagent 支持

## 部署状态

✅ 已完成后端实施
✅ 已构建并重启 ecweb 服务
⏳ 等待前端 UI 改造

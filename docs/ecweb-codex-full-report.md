# ECWeb Codex 支持完整实施报告

## 实施日期
2026-06-27

## 实施状态
✅ **已完成**：后端 + 前端全部实施并部署

---

## 一、后端实施

### 1.1 环境检测模块
**文件**: `src/sources/baseagent-detector.ts`

**功能**：
- 检测 Claude 是否可用：`~/.claude/projects/` 存在
- 检测 Codex 是否可用：`~/.codex/sessions/` + `state_*.sqlite` 存在 + Node 22.5+

**API 端点**：
```
GET /api/available-baseagents
返回: {"claude": boolean, "codex": boolean}
```

### 1.2 Codex 数据源模块
**文件**: `src/sources/session-codex.ts` (620 行)

**数据来源**：
- 元数据索引：`~/.codex/state_*.sqlite`
- 会话文件：`~/.codex/sessions/YYYY/MM/DD/*.jsonl`

**核心功能**：
- `listProjects()` - 从 SQLite 按 cwd 分组查询项目
- `listTranscripts()` - 查询指定项目的所有会话
- `readTranscriptFile()` - 解析 rollout JSONL，提取 turns/tokens/cost
- `buildSnapshot()` - 构造统一的快照数据
- `subscribeCodex()` - WebSocket 实时更新

**事件解析**（Codex 特有格式）：
```
session_meta → cli_version
event_msg + user_message → 用户输入
event_msg + agent_message → 模型输出
event_msg + reasoning → thinking（插入到 assistant blocks 开头）
event_msg + function_call → tool_use
event_msg + function_call_output → tool_result
event_msg + token_count → usage 和费用计算
payload.model → 模型名称 (gpt-5.5, gpt-5.4, etc.)
```

**定价表**（OpenAI 2026-06）：
- GPT-5.5: $5/$30 (input/output per 1M tokens, cache: $0.5)
- GPT-5.4: $2.5/$15 (cache: $0.25)
- GPT-4.1: $2.5/$10 (cache: $0.625/$0.125)
- GPT-4o: $2.5/$10 (cache: $1.25/$0.25)
- GPT-4o-mini: $0.15/$0.60 (cache: $0.075)
- o3: $2/$8
- o3-pro: $20/$80
- o4-mini: $1.1/$4.4
- 完整列表见代码

**缓存策略**：
- 双层缓存（内存 + 磁盘），与 Claude 对齐
- 缓存目录：`{EVOLCLAW_HOME}/data/ecweb-cache/codex/`
- 版本控制：CACHE_VERSION = 1

### 1.3 统一会话接口
**文件**: `src/sources/session.ts` (修改)

**路由逻辑**：
```typescript
snapshot({ baseagent: 'claude' | 'codex', project, sessionId })
  → baseagent === 'codex' ? snapshotCodex() : buildSnapshot()

subscribe({ baseagent, ... }, push)
  → baseagent === 'codex' ? subscribeCodex() : 原有逻辑
```

**返回结构**（统一）：
```typescript
{
  baseagent: 'claude' | 'codex',
  projects: [{ encoded, label, cwd, count }],
  project: string,
  transcripts: [{ id, title, userMsgs, totalMsgs, ... }],
  turns: [{ role, ts, category, blocks }],
  sessionId: string | null,
  header?: { title, model, totalTurns, costUsd, ... }
}
```

### 1.4 WebSocket 订阅
**Codex**：
- 监 `state_*.sqlite` 文件 mtime 变化
- 监听 evolclaw `sessionsDir` 的 `active.json` 变化
- 防抖 150ms

**Claude**（保持不变）：
- 监听 `~/.claude/projects/<encoded>/` 的 .jsonl 文件变化
- 监听 evolclaw `sessionsDir` 的 `active.json` 变化

---

## 二、前端实施

### 2.1 状态管理
**文件**: `src/static/app.js`

**新增状态变量**：
```javascript
let sessSel = { sessionId: null, project: null, baseagent: null };
let availableBaseagents = { claude: false, codex: false };
```

### 2.2 环境检测
**连接时自动获取**：
```javascript
ws.onopen = () => {
  fetch(`${BASE}api/available-baseagents`)
    .then(r => r.json())
    .then(data => {
      availableBaseagents = data;
      // 默认选第一个可用的
      if (!sessSel.baseagent) {
        sessSel.baseagent = data.claude ? 'claude' : (data.codex ? 'codex' : null);
      }
      subscribe(currentView, pendingSub || {});
    });
}
```

### 2.3 UI 改造
**位置**: 会话视图左侧过滤区域（`.sess-filter`）

**布局**（从上到下）：
```
[Base Agent 下拉] ← 新增
[Project 下拉]
[搜索框]
[有效会话按钮] [会话计数]
```

**下拉选择器**：
```html
<select id="sess-baseagent">
  <option value="claude">Claude</option>
  <option value="codex">Codex</option>
</select>
```

**动态显示规则**：
- 只显示可用的 baseagent（`availableBaseagents` 检测结果）
- 如果 Codex 不可用（Node < 22.5 或目录不存在），下拉中不显示 Codex 选项

### 2.4 交互逻辑
**切换 baseagent**：
```javascript
baseagentSel.onchange = () => {
  sessSel = { sessionId: null, project: null, baseagent: baseagentSel.value };
  sessSearch = '';
  subscribe('session', { baseagent: sessSel.baseagent });
};
```

**行为**：
- 切换 baseagent → 清空项目和会话选择 → 重新订阅
- 切换项目 → 保持 baseagent → 清空会话选择 → 重新订阅
- 点击会话 → 保持 baseagent 和项目 → 订阅会话详情

### 2.5 订阅参数传递
**修改 `subscribe()` 函数**：
```javascript
function subscribe(view, params) {
  if (view === 'session' && sessSel.baseagent) {
    params = { ...params, baseagent: sessSel.baseagent };
  }
  ws.send(JSON.stringify({ type: 'subscribe', view, ...params }));
}
```

**修改 `switchView()` 函数**：
```javascript
else if (view === 'session') {
  subscribe('session', { 
    sessionId: sessSel.sessionId, 
    project: sessSel.project, 
    baseagent: sessSel.baseagent 
  });
}
```

---

## 三、测试结果

### 3.1 环境检测
```bash
$ curl http://localhost:42705/api/available-baseagents
{"claude":true,"codex":true}
```

### 3.2 Codex 数据读取
**项目列表**：
- ✅ 5 个项目
- ✅ 按最后活动时间排序
- ✅ 项目名称正确（从 cwd 提取）

**会话列表**：
- ✅ 103 个会话
- ✅ title 正确提取
- ✅ userMsgs/totalMsgs 统计准确
- ✅ 绑定状态正确标注（bound/online）

**会话详情**：
- ✅ 846 轮对话
- ✅ Model: gpt-5.5
- ✅ 费用: $636.13（accurate calculation）
- ✅ turns 结构正确（role/category/blocks）

### 3.3 前端交互
- ✅ baseagent 下拉确显示
- ✅ 切换 baseagent 触发重新订阅
- ✅ 项目列表根据 baseagent 动态更新
- ✅ 会话详情正确渲染

---

## 四、文件清单

### 4.1 新增文件
```
src/sources/baseagent-detector.ts       (117 行) - 环境检测
src/sources/session-codex.ts            (620 行) - Codex 数据源
test-codex-session.mjs                   (58 行)  - 测试脚本
ecweb-codex-implementation.md            (文档)   - 实施报告
```

### 4.2 修改文件
```
src/server.ts                - 新增 /api/available-baseagents 端点
src/sources/session.ts       - baseagent 参数路由
src/static/app.js            - 前端状态管理 + UI + 交互
```

### 4.3 构建产物
```
ecweb/dist/                  - 已重新构建
```

---

## 五、部署状态

✅ **后端**：已构建并部署
✅ **前端**：已构建并部署
✅ **服务**：已重启（PID: 693947）
✅ **测试**：功能验证通过

---

## 六、用户使用指南

### 6.1 访问方式
1. 打开 ecweb 界面
2. 点击 "Sessions" tab
3. 左侧顶部出现 "Base Agent" 下拉选择器

### 6.2 切换 Base Agent
- 选择 "Claude" 或 "Codex"
- 项目列表和会话列表自动更新
- 如果某个 baseagent 不可用，下拉中不显示

### 6.3 查看会话
- 选择项目
- 点击会话查看详情
- 支持搜索、过滤（与原有功能一致）

---

## 七、技术亮点

### 7.1 格式差异处理
Codex 和 Claude 的 JSONL 格式完全不同：
- **Claude**: 单层 message 结构，usage 在 message 内
- **Codex**: 多层嵌套 event_msg，usage 在独立的 token_count 事件

通过 `session-codex.ts` 的统一转换，前端无需感知差异。

### 7.2 费用计算准确性
- 避免重复计算同一个 usage（lastUsageKey 机制）
- 支持 cached tokens（cache_read）
- 定价表按模型前缀匹配（gpt-5.5-xxx 自动匹配 gpt-5.5）

### 7.3 性能优化
- 双层缓存减少 JSONL 解析
- SQLite 查询替代文件系统遍历
- WebSocket 防抖避免频繁更新

### 7.4 用户体验
- 无缝切换，无需刷新页面
- 自动检测可用性，避免错误提示
- 保持原有交互习惯

---

## 八、已知限制

1. **Node 版本要求**：Codex 需要 Node 22.5+（`node:sqlite` 模块）
2. **定价表维护**：需要定期更新 OpenAI 价格
3. **事件格式依赖**：Codex rollout 格式变化可能需要更新解析逻辑

---

## 九、后续建议

1. **定价表自动更新**：考虑从 API 动态获取最新价格
2. **多语言支持**：baseagent 下拉选择器的国际化
3. **性能监控**：记录 Codex 查询耗时，优化慢查询
4. **用户偏好**：记住用户上次选择的 baseagent

---

## 十、总结

本次实施完整支持了 Codex 会话数据的展示，实现了后端数据源、前端 UI、用户交互的全链路改造。用户现在可以在同一界面中查看 Claude 和 Codex 的会话历史，无需切换工具或页面。

**实施耗时**：约 2 小时
**代码行数**：新增 ~800 行，修改 ~50 行
**测试覆盖**：环境检测、数据读取、费用计算、前端交互

---

**报告生成时间**：2026-06-27 12:32
**实施人员**：eleanai.agentid.pub
**状态**：✅ 完成并部署

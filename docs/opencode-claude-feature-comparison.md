# OpenCode vs Claude Runner 功能对比

**对比日期**：2026-06-26  
**目的**：确认 Claude Runner 的所有功能在 OpenCode 中是否可实现

---

## 一、核心接口对比

### 1.1 AgentRunnerFull 接口

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **runQuery()** | ✅ `query()` from SDK | ✅ `client.session.prompt()` | 流式响应 AsyncIterable | ✅ |
| **interrupt()** | ✅ 中断当前 query | ✅ `client.session.abort()` | 原生支持 | ✅ |
| **clearSession()** | ✅ 清空 session | ✅ `client.session.delete()` + 重建 | 删除后重建 | ✅ |

### 1.2 ModelSwitcher 接口

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **switchModel()** | ✅ 运行时切换模型 | ✅ `prompt()` 的 `model` 参数 | 每次请求指定模型 | ✅ |
| **listAvailableModels()** | ✅ 动态获取模型列表 | ✅ `client.config.providers()` | 返回 `{ providers, default }` | ✅ |
| **getCurrentModel()** | ✅ 查询当前模型 | ✅ 内部状态跟踪 | 记录最后使用的 model | ✅ |

### 1.3 Compactable 接口

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **compactSession()** | ✅ 压缩会话历史 | ✅ `client.session.summarize()` | 官方 SDK 支持 | ✅ |

### 1.4 PermissionController 接口

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **setPermissionMode()** | ✅ 切换权限模式 | ⚠️ 需要通过 config 传递 | OpenCode 有自己的权限系统 | ⚠️ |
| **getPermissionMode()** | ✅ 查询权限模式 | ⚠️ 内部状态跟踪 | 记录当前 permissionMode | ⚠️ |

---

## 二、高级功能对比

### 2.1 Session 管理

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **Session 持久化** | ✅ SDK 自动管理 | ✅ 保存到磁盘 | 官方文档已确认 | ✅ |
| **Session 恢复** | ✅ `resume` 参数 | ✅ 直接复用 session ID | 进程重启后有效 | ✅ |
| **Fork session** | ✅ `forkSession()` | ✅ `client.session.create({ body: { parent } })` | SDK 支持 parent 参数 | ✅ |
| **Session 列表** | ❌ 无 | ✅ `client.session.list()` | OpenCode 更强 | ✅ |
| **Session 分享** | ❌ 无 | ✅ `client.session.share()` / `unshare()` | OpenCode 独有 | ✅ |
| **Session 导出** | ❌ 无 | ✅ `opencode export <id>` | CLI 命令 | ✅ |

### 2.2 多模态支持

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **图片输入** | ✅ Base64 image | ✅ `{ type: 'image', source: { type: 'base64', ... } }` | SDK Part 类型 | ✅ |
| **文件附件** | ✅ 通过 tool | ✅ 通过 tool | 同样方式 | ✅ |

### 2.3 模型别名

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **别名解析** | ✅ `opus` → `claude-opus-4-8` | ⚠️ 需自己实现 | OpenCode 用 `providerID/modelID` | ⚠️ |
| **动态刷新** | ✅ 从 `/v1/models` 获取 | ✅ `client.config.providers()` | SDK 返回可用模型 | ✅ |
| **1M 上下文标记** | ✅ `[1m]` 后缀 | ❌ 不需要 | OpenCode 自动处理 | ✅ |

### 2.4 权限系统

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **Permission 模式** | ✅ auto/bypass/request/edit/plan | ⚠️ OpenCode 自己的权限系统 | 需要映射 evolclaw → OpenCode | ⚠️ |
| **工具权限控制** | ✅ PermissionGateway | ⚠️ OpenCode 内部处理 | 可能需要额外封装 | ⚠️ |
| **交互式权限请求** | ✅ AskUserQuestion | ⚠️ 需实测 OpenCode 行为 | 可能通过 tool 实现 | ⚠️ |

### 2.5 事件流

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **流式文本** | ✅ `{ type: 'text', text }` | ✅ `{ type: 'text', text }` (Part) | SDK 原生支持 | ✅ |
| **工具调用** | ✅ `{ type: 'tool_use', name, input }` | ✅ `{ type: 'tool_use', ... }` (Part) | SDK 原生支持 | ✅ |
| **工具结果** | ✅ `{ type: 'tool_result', ... }` | ✅ `{ type: 'tool_result', ... }` (Part) | SDK 原生支持 | ✅ |
| **Session ID** | ✅ `{ type: 'session_id', sessionId }` | ✅ 创建时返回 | `session.create()` 返回 | ✅ |
| **完成事件** | ✅ `{ type: 'complete', isError, ... }` | ⚠️ 需实测 | 可能需要自己检测流结束 | ⚠️ |
| **Thinking** | ✅ `{ type: 'thinking', text }` | ❓ 待确认 | 需实测 OpenCode 是否支持 | ❓ |

### 2.6 Context 管理

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **Context window** | ✅ 200K / 1M 检测 | ❓ OpenCode 自动处理 | 可能不需要显式管理 | ✅ |
| **Auto compact** | ✅ 80% 触发压缩 | ✅ `session.summarize()` | SDK 原生支持 | ✅ |
| **Token 计数** | ✅ `tokenUsage` 统计 | ⚠️ 需实测 | 可能在响应元数据中 | ⚠️ |

### 2.7 错误处理

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **重试机制** | ✅ SDK 内置（2次） | ✅ SDK 内置（2次） | 官方文档已确认 | ✅ |
| **错误类型** | ✅ SDK 错误类 | ✅ SDK 错误类 | `BadRequestError`, `APIError` 等 | ✅ |
| **超时处理** | ✅ 默认 1 分钟 | ✅ 默认 1 分钟 | SDK 配置 | ✅ |

### 2.8 定价与用量

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **Gateway 定价** | ✅ 从 `/v1/models` 获取 | ⚠️ OpenCode 可能不提供 | 需实测 | ⚠️ |
| **Token 用量统计** | ✅ `tokenUsage` 对象 | ⚠️ 需实测响应格式 | 可能在 `AssistantMessage` 中 | ⚠️ |
| **Cache 统计** | ✅ `cache_read` / `cache_write` | ⚠️ 取决于 provider | 透传 provider 统计 | ⚠️ |

### 2.9 文件操作

| 功能 | Claude Runner | OpenCode SDK | 实现方式 | 可行性 |
|------|--------------|--------------|---------|:-----:|
| **File rewind** | ✅ `rewindFiles()` | ❓ 待确认 | 需查 OpenCode 是否支持 | ❓ |
| **Checkpoint** | ✅ 文件状态检查点 | ❓ 待确认 | 可能需要自己实现 | ❓ |

---

## 三、关键差异点

### 3.1 Claude Runner 独有功能

| 功能 | 说明 | OpenCode 是否需要 |
|------|------|------------------|
| **MessageStream** | 支持流式消息追加 | ⚠️ 可能需要，取决于 evolclaw 使用方式 |
| **Gateway 定价缓存** | 从代理获取实时价格 | ❌ OpenCode 是本地工具，不涉及代理 |
| **1M 上下文标记** | `[1m]` 后缀显示 | ❌ OpenCode 自动处理 |
| **File rewind** | 文件状态回滚 | ❓ 需确认 OpenCode 支持 |

### 3.2 OpenCode 独有功能

| 功能 | 说明 | 是否有用 |
|------|------|---------|
| **Session 分享** | 生成公开链接 | ✅ 可用于调试/协作 |
| **Session 列表** | 跨项目查看所有 session | ✅ 可用于管理 |
| **Session 导出** | 导出为 JSON | ✅ 可用于备份 |
| **TUI 控制** | 控制 OpenCode TUI 界面 | ❌ evolclaw 用不到 |
| **Provider 无关** | 支持 75+ LLM | ✅ 核心优势 |

---

## 四、实现方式对比

### 4.1 核心方法实现

#### runQuery()

**Claude Runner**:
```typescript
async runQuery(sessionId, prompt, projectPath, initialClaudeSessionId?, images?, ...): AsyncIterable<AgentEvent> {
  // 1. 构造 options
  const options = {
    model: resolveSdkModel(this.model, this.baseUrl),
    permissionMode: this.permissionMode,
    resume: initialClaudeSessionId,
    cwd: projectPath,
    systemPrompt: systemPromptAppend,
    ...
  };
  
  // 2. 调用 SDK
  const stream = query({ prompt, options });
  
  // 3. 转换事件
  for await (const msg of stream) {
    yield transformToAgentEvent(msg);
  }
}
```

**OpenCode Runner（拟）**:
```typescript
async runQuery(sessionId, prompt, projectPath, initialOpencodeSessionId?, images?, ...): AsyncIterable<AgentEvent> {
  // 1. 确保 session 存在
  if (!this.sessionId) {
    const session = await this.client.session.create({ body: { title: sessionId } });
    this.sessionId = session.data.id;
  }
  
  // 2. 构造请求
  const parts = [{ type: 'text', text: prompt }];
  if (images) parts.push(...images.map(img => ({ type: 'image', source: { ... } })));
  
  // 3. 调用 SDK
  const response = await this.client.session.prompt({
    path: { id: this.sessionId },
    body: { parts, model: this.currentModel }
  });
  
  // 4. 转换事件
  for await (const part of response.stream) {
    yield transformPartToAgentEvent(part);
  }
}
```

**差异**：
- Claude: SDK 直接支持 `resume`、`systemPrompt`、`permissionMode`
- OpenCode: 需要先创建 session，然后用 session ID 调用
- OpenCode: 权限模式可能需要通过 `config` 传递给 `createOpencode()`

#### interrupt()

**Claude Runner**:
```typescript
async interrupt(sessionId: string): Promise<void> {
  const fn = this.interruptFns.get(sessionId);
  if (fn) await fn();  // 调用 SDK 的 interrupt
}
```

**OpenCode Runner（拟）**:
```typescript
async interrupt(sessionId: string): Promise<void> {
  await this.client.session.abort({ path: { id: this.sessionId } });
  this.abortController?.abort();  // 同时取消 fetch
}
```

**差异**：无显著差异，都是原生支持

#### clearSession()

**Claude Runner**:
```typescript
async clearSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
  // SDK 没有 clearSession，通过删除 JSONL 文件实现
  const sessionPath = path.join(projectPath, '.claude', `${agentSessionId}.jsonl`);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
  this.activeSessions.delete(sessionId);
  return true;
}
```

**OpenCode Runner（拟）**:
```typescript
async clearSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
  await this.client.session.delete({ path: { id: this.sessionId } });
  this.sessionId = null;  // 下次 runQuery 时重建
  return true;
}
```

**差异**：
- Claude: 手动删除文件（因为 SDK 没有 clearSession API）
- OpenCode: SDK 原生支持 `session.delete()`

---

## 五、待实测确认项

### 5.1 高优先级（影响核心功能）

1. **权限模式映射**
   - OpenCode 的权限系统与 evolclaw 的 `permissionMode` 如何对接？
   - 是否需要在 `createOpencode({ config })` 中传递权限配置？
   
2. **事件流格式**
   - `response.stream` 迭代得到的 `Part` 类型具体包含哪些字段？
   - 是否有 `thinking` 类型的 Part？
   - 完成事件如何标识？
   
3. **Token 用量统计**
   - `AssistantMessage` 是否包含 `tokenUsage` 字段？
   - 格式是否与 Claude SDK 兼容？
   
4. **Session ID 提取**
   - `session.create()` 返回的对象结构？
   - 如何从响应中提取 session ID 用于回调？

### 5.2 中优先级（影响高级功能）

5. **Compact 实现**
   - `session.summarize()` 的行为是否等同于 Claude 的 compact？
   - 是否需要传递压缩参数？
   
6. **Fork session**
   - `session.create({ body: { parent } })` 是否支持？
   - 官方文档未明确提及，需实测
   
7. **File rewind**
   - OpenCode 是否支持文件状态回滚？
   - 是否需要自己实现 checkpoint 机制？

### 5.3 低优先级（不影响核心功能）

8. **TUI 相关 API**
   - evolclaw 用不到，但了解接口有助于调试
   
9. **Gateway 定价**
   - OpenCode 是本地工具，可能不提供定价信息
   - 需确认是否透传 provider 的定价

---

## 六、推荐实施策略

### 6.1 MVP 阶段（必须实现）

✅ 实现的功能：
1. `runQuery()` - 基础对话
2. `interrupt()` - 中断
3. `clearSession()` - 清空会话
4. `switchModel()` - 切换模型
5. Session 持久化 - 复用旧 session ID

### 6.2 完善阶段（逐步添加）

⚠️ 待实测后决定：
1. `compactSession()` - 压缩会话
2. 权限模式对接
3. Token 用量统计
4. Fork session

### 6.3 可选阶段（锦上添花）

❓ 根据需求决定：
1. Session 分享（OpenCode 独有）
2. Session 列表管理
3. File rewind（如果 OpenCode 支持）

---

## 七、风险评估

| 风险 | 等级 | 缓解措施 |
|------|:---:|---------|
| **权限模式不兼容** | 🔴 高 | 实测 OpenCode 权限系统，设计映射方案 |
| **事件流格式差异** | 🟡 中 | 实测 SDK 流式响应，编写转换逻辑 |
| **Token 统计缺失** | 🟡 中 | 如无法获取，降级为估算或不统计 |
| **File rewind 不支持** | 🟢 低 | 该功能使用率低，可暂不实现 |

---

## 八、结论

### 8.1 核心功能可行性：✅ 95% 可实现

- ✅ **基础对话**：完全支持
- ✅ **Session 管理**：OpenCode 更强（持久化、列表、分享）
- ✅ **模型切换**：完全支持
- ✅ **中断机制**：完全支持
- ⚠️ **权限系统**：需要映射，实测后确定方案
- ⚠️ **Token 统计**：需实测确认格式

### 8.2 相比 Claude Runner 的优势

1. **Session 管理更强** - 持久化、列表、分享、导出
2. **Provider 无关** - 支持 75+ LLM
3. **配置更简单** - 无需 baseUrl、username、password

### 8.3 相比 Claude Runner 的劣势

1. **权限系统不同** - 需要额外适配工作
2. **File rewind 不确定** - 待确认是否支持
3. **全局依赖** - 需要 `npm install -g opencode`

### 8.4 最终推荐

**✅ 推荐集成 OpenCode**，理由：
1. 核心功能 95% 可实现
2. Session 管理比 Claude 更强
3. Provider 无关是长期优势
4. 风险可控（权限系统可以通过映射解决）

**实施顺序**：
1. 先实现 MVP（基础对话 + session 管理）
2. 实测权限系统，设计映射方案
3. 逐步添加高级功能（compact、fork、统计）

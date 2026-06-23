# 提示词模板化设计方案

## 背景

EvolClaw 在每次消息处理时，会动态拼接一段系统提示（system prompt append）注入给 LLM，包含当前环境信息、权限提示、通道能力、群聊规则、Proactive 模式说明等。这些文案目前硬编码在 `src/core/message/message-processor.ts` 中，修改文案需要改代码 + 重新编译。

本方案将这些运行时系统提示抽取为一个可编辑的模板文件，支持通过修改模板调整注入给 LLM 的提示词，无需改代码。

## 范围

仅覆盖 **A 类：运行时系统提示**（动态拼接到 `systemPromptAppend` 的内容）。

不纳入：
- B 类（用户消息正文中的"用户发送了文件/图片"等）
- C 类（打断/压缩控制 prompt）
- CLI self-heal 诊断 prompt
- Agent 内部协议（Gemini 边界符等）

## 模板文件

### 路径

| 用途 | 路径 |
|---|---|
| 内置默认 | `{packageRoot}/dist/templates/prompts.md`（源码 `src/templates/prompts.md`） |
| 用户覆盖 | `{EVOLCLAW_HOME}/data/prompts.md`（存在则完整替换） |

现有 build 脚本已将 `src/templates/` 拷贝到 `dist/templates/`，无需修改。

### 结构

文件由 `## 段名` 分隔为多段，加载器只识别白名单段：`runtime`、`group`、`proactive`。其它段（包括文档说明）被忽略。

### 占位符语法

| 语法 | 作用 |
|---|---|
| `{{var}}` | 变量替换。值为空/undefined/null/false 时替换为空串 |
| `{{?var}}...{{/}}` | 条件段。var 为真值时保留整段，否则整段删除 |
| 空行 | 渲染后若某行只剩空白，整行自动删除 |

不支持嵌套条件段（用不到）。条件段内可包含 `{{var}}` 变量。

## 渲染器

### 文件：`src/prompts/templates.ts`

约 80-100 行，导出：

```typescript
export type PromptSection = 'runtime' | 'group' | 'proactive';

// 启动时调用，加载模板文件到内存
export function loadPromptTemplates(): void;

// 渲染指定段，返回渲染后的字符串
export function renderPromptSection(
  section: PromptSection,
  vars: Record<string, string | boolean | number | undefined>
): string;
```

### 加载逻辑

1. 检查 `{EVOLCLAW_HOME}/data/prompts.md` 是否存在
2. 存在 → 读取用户文件；不存在 → 读取 `{packageRoot}/dist/templates/prompts.md`
3. 按 `^## (\w+)` 正则切段，段名在白名单内的存入 `Map<PromptSection, string>`
4. 任一白名单段缺失 → warn 日志 + 该段 fallback 到内置默认
5. 文件读取失败 → warn + 全部 fallback 到内置默认

### 渲染逻辑

两遍处理：

1. **条件段处理**：正则 `\{\{\?(\w+)\}\}([\s\S]*?)\{\{\/\}\}` 全局替换
   - 查 vars[key]：真值 → 保留内部文本；假值 → 替换为空串
2. **变量替换**：正则 `\{\{(\w+)\}\}` 全局替换
   - 查 vars[key]：有值 → 替换为 String(val)；无值 → 空串
3. **空行过滤**：按 `\n` 拆行，`.trim() === ''` 的行剔除，重新 join

## 字段契约

### runtime 段

| 字段 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `channel` | string | 当前通道类型 | `options.channelType \|\| message.channel` |
| `project` | string | 当前项目目录名 | `path.basename(absoluteProjectPath)` |
| `sessionName` | string? | 会话名 | `session.name` |
| `selfIdentity` | string? | 机器人标识 | `formatIdentity(selfName, selfAid)` |
| `peerRole` | string | 对端角色 | `session.identity?.role \|\| 'unknown'` |
| `peerIdentity` | string? | 对端标识 | `formatIdentity(peerName, peerId)` |
| `peerType` | string? | 对端类型 | `message.peerType`（unknown → 空） |
| `chatType` | string? | 聊天类型 | `session.chatType` |
| `agent` | string? | 当前 agent | `session.agentId`（claude → 空） |
| `readonly` | bool | 只读模式开关 | `session.metadata?.permissionMode === 'readonly'` |
| `readonlySendHint` | string | 只读发送提示 | proactive 分支决定 |
| `fileSendCurrent` | bool | 当前通道可发文件 | `!isProactive && adapter.sendFile` |
| `fileSendCross` | bool | 存在跨通道发文件 | `!isProactive && crossChannelTypes.length > 0` |
| `crossPrimary` | string | 跨通道首选 | `crossChannelTypes[0]` |
| `crossTypes` | string | 跨通道列表 | `crossChannelTypes.join('/')` |
| `capability` | bool | 有通道能力 | `capParts.length > 0` |
| `capabilities` | string | 能力清单 | `capParts.join('、')` |

### group 段

| 字段 | 类型 | 说明 |
|---|---|---|
| `peerId` | string | 对端用户 ID |

触发条件：`message.chatType === 'group' && message.peerId`

### proactive 段

无参数。触发条件：`session.sessionMode === 'proactive'`

## 改动点

### message-processor.ts

原 line 454-550 的分支逻辑改为：

1. 保留 TS 侧的条件计算（crossChannelTypes 统计、capParts 构建等）
2. 将计算结果作为 vars 传入 `renderPromptSection('runtime', vars)`
3. 群聊条件段：`renderPromptSection('group', { peerId })`
4. Proactive 条件段：`renderPromptSection('proactive', {})`
5. 三段 + `options?.systemPromptAppend` 用 `\n` join 作为 effectiveSystemPrompt

### index.ts

启动早期（channels 初始化前）调用 `loadPromptTemplates()`。

## 兼容性

- 不写用户覆盖文件时，行为与当前硬编码完全等价
- 模板文件损坏/缺段时自动 fallback，服务不会因此启动失败
- 不引入新依赖（纯正则实现）

## 测试计划

`tests/unit/prompt-templates.test.ts`：

1. 变量替换：正常值、空值、undefined
2. 条件段：真值保留、假值删除、段内变量替换
3. 空行过滤：条件段删除后不留空行
4. 段解析：正常三段、缺段 fallback、未知段忽略
5. 用户覆盖：模拟用户文件优先加载
6. 渲染结果与当前硬编码输出一致性对比

## 集成验证

1. `npm run build` 确认编译通过
2. 重启 evolclaw，检查日志确认模板加载成功
3. 发送消息，检查 `systemPromptAppend` 日志输出与预期一致
4. 修改 `{EVOLCLAW_HOME}/data/prompts.md` 部分文案
5. 重启后验证变更生效

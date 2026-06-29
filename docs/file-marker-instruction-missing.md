# 问题：非AUN渠道文件发送说明缺失

**发现时间**: 2026-06-26 23:20  
**状态**: Implemented  
**验证**: `npx vitest run tests/unit/proactive-template-rendering.test.ts` 通过（2026-06-27）  
**影响**: 用户体验 - 飞书等渠道用户看不到文件发送语法说明

## 问题现象

在飞书等非AUN渠道中，用户收到的系统提示里**缺少文件发送的使用说明**，即看不到如何使用 `[SEND_FILE:路径]` 标记来发送文件的指引。

### 预期行为

系统提示中应包含类似以下内容（飞书渠道）：

```
发送文件语法：
  FILE_MARKER: 文件路径 [可选显示名称]
  [SEND_FILE:文件路径]
相对路径从项目根目录解析，图片自动内联预览。
```

### 实际行为

`channel.md` 模板中关于文件发送的说明段落没有显示在渲染结果中。

## 根本原因

### 技术层面

1. **变量格式不匹配**：
   - `capabilities` 变量是**字符串**（如 `"图片输入、图片输出、文件发送"`）
   - 需要判断"是否包含文件发送能力"
   
2. **模板引擎限制**：
   - `manifest-engine` 的条件语法**不支持字符串包含判断**
   - 支持的操作符：`eq`、`neq`、`in`、`nin`、`any`、`all`、`and`、`or`
   - 没有类似 `~=`（包含）或正则匹配的操作符

3. **条件表达式失效**：
   - 无法用 `{{?capabilities包含'文件发送'}}` 这样的条件
   - 现有的 `{{?capabilities}}` 只判断字符串是否非空，不判断内容

### 架构历史

- **之前的实现**：代码中引入过独立的布尔变量（如 `supportsSendFile`），模板用简单的 `{{?supportsSendFile}}` 判断
- **重构简化**：某次重构中移除了独立变量，只保留了字符串形式的 `capabilities`
- **副作用**：失去了在模板中精确判断单项能力的能力

## 影响范围

### 直接影响

- **飞书渠道**：主要影响，飞书是最常用的支持文件发送的非AUN渠道
- **WeChat/其他渠道**：如果未来支持文件发送，同样会遇到此问题

### 用户体验影响

- 用户不知道可以用 `[SEND_FILE:]` 标记发送文件
- 可能尝试其他方式（如描述文件内容、要求粘贴等）导致低效交互
- 降低文件交互功能的可发现性

## 相关文件

| 文件 | 角色 | 相关代码位置 |
|------|------|-------------|
| `src/core/message/response-engine.ts` | 组装运行时变量 | 第1132行：capParts 组装<br>第1245行：变量对象传给模板引擎 |
| `kits/templates/system-fragments/channel.md` | 模板定义 | 文件发送说明段落（当前有条件判断但未生效） |
| `src/eck/manifest-engine.ts` | 条件渲染引擎 | 支持的操作符定义（第150-200行附近） |

## 可能的解决思路

### 方案A：引入独立布尔变量

在 `response-engine.ts` 中计算 `fileCapable` 布尔变量：

```typescript
const fileCapable = !isProactive && channelInfo.adapter.capabilities?.file;
```

优点：
- 模板条件简单明确：`{{?fileCapable}}`
- 不需要修改 manifest-engine
- 遵循"关注点分离"：能力判断在代码层完成

缺点：
- 增加变量数量

### 方案B：扩展 manifest-engine 语法

添加字符串包含操作符（如 `~=`）：

```handlebars
{{?capabilities~='文件发送'}}
```

优点：
- 更灵活，可用于其他场景

缺点：
- 修改核心模板引擎，影响面大
- 需要充分测试

### 方案C：capabilities 改为数组

将 `capabilities` 从字符串改为数组：

```typescript
capabilities: capParts  // ['图片输入', '图片输出', '文件发送']
```

模板使用 `in` 操作符：

```handlebars
{{?'文件发送' in capabilities}}
```

优点：
- 数据结构更合理
- 利用现有 `in` 操作符

缺点：
- 需要修改显示逻辑（数组 → 中文顿号连接）
- 影响现有所有引用 `capabilities` 的地方

## 推荐方案

**方案A（引入布尔变量）** 最简单且风险最低：

1. 修改点单一（仅 response-engine.ts）
2. 不影响核心引擎
3. 条件语义清晰
4. 可快速验证

## 验证方法

修复后，在飞书渠道发起对话，检查系统提示中是否包含：

```
发送文件语法：
  FILE_MARKER: 文件路径 [可选显示名称]
  [SEND_FILE:文件路径]
```

可通过以下方式确认：
1. 查看 `$EVOLCLAW_HOME/data/eck-debug/context.txt`
2. 或在对话中询问"怎么发送文件给你"，看回复是否准确

## 相关Issue

- 无（新发现）

---

**发现人**: eleanai.agentid.pub  
**报告时间**: 2026-06-26 23:21

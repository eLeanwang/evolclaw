# 双会话响应模式 - 迁移指南

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 完整

---

## 一、概述

本文档帮助用户从旧版响应模式迁移到新的双会话响应模式体系。

---

## 二、迁移路径

### 2.1 从 single-session（interactive / proactive）迁移

#### 旧配置

```json
// interactive 模式
{
  "responseMode": "interactive"
}

// proactive 模式
{
  "responseMode": "proactive"
}
```

#### 新配置

```json
// 统一为 single-session；chatMode 降为顶层 chatmode 场景表（按对端类型解析）
{
  "responseMode": "single-session",
  "chatmode": { "private": "interactive", "group": "proactive" }
}
```

> 旧的 `interactive` / `proactive` 作为**模式 id** 已废弃：它们是投递方式（chatMode），
> 不是模式。迁移后模式统一为 `single-session`，投递方式由顶层 `chatmode` 字典按对端
> 类型（private/nothuman/group）自动解析——通常无需显式配置。

#### 自动迁移

代码层会自动识别旧配置并迁移：

```typescript
function migrateConfig(oldConfig: any): AgentConfig {
  // 旧模式 id interactive/proactive → single-session；
  // 原语义作为 chatmode 出厂默认表兜底（human 私聊 interactive、agent/群聊 proactive）
  if (oldConfig.responseMode === 'interactive' || oldConfig.responseMode === 'proactive') {
    return { responseMode: 'single-session' };  // chatmode 走 schema 出厂默认表
  }
  return oldConfig;
}
```

#### 行为变化

无行为变化：chatmode 出厂默认表（human 私聊 interactive、agent/群聊 proactive）
与旧的 interactive/proactive 语义一致。

---

### 2.2 从 dual-session-lite 迁移

#### 旧配置

```json
{
  "responseMode": "dual-session-lite",
  "config": {
    "debounceMs": 3000,
    "auxiliaryModel": "deepseek-v4-flash"
  }
}
```

#### 新配置

```json
{
  "responseMode": "dual-session",
  "mentionMode": "disabled",              // 顶层通用参数（可选）
  "responseModeParams": {
    "dual-session": {                     // 特有参数进分桶
      "debounceMs": 3000,
      "auxiliaryModel": "deepseek-v4-flash"
    }
  }
}
```

> chatMode 不再显式配置：由顶层 `chatmode` 场景表按对端类型自动解析。
> 旧 `config` 块的特有参数（debounceMs 等）搬进 `responseModeParams["dual-session"]` 桶。

#### 自动迁移

代码层会自动识别旧配置并迁移：

```typescript
function migrateConfig(oldConfig: any): AgentConfig {
  if (oldConfig.responseMode === 'dual-session-lite') {
    const { chatMode, mentionMode, model, ...specific } = oldConfig.config ?? {};
    return {
      responseMode: 'dual-session',
      ...(mentionMode ? { mentionMode } : {}),   // 通用参数提顶层
      ...(model ? { model } : {}),
      responseModeParams: { 'dual-session': specific },  // 特有参数进分桶
    };
  }
  return oldConfig;
}
```

#### 行为变化

**无行为变化**。chatMode 由顶层 chatmode 出厂默认表解析（群聊 proactive）。

---

## 三、配置映射表

### 3.1 responseMode 映射

| 旧值 | 新值 | 说明 |
|------|------|------|
| `interactive` | `single-session` + `chatMode: 'interactive'` | 合并 |
| `proactive` | `single-session` + `chatMode: 'proactive'` | 合并 |
| `dual-session-lite` | `dual-session` | 改名 |

### 3.2 参数映射

| 旧参数位置 | 新参数位置 | 说明 |
|-----------|-----------|------|
| `responseMode: 'interactive'` | 顶层 `chatmode` 场景表（出厂默认解析） | 降为参数，模式变 single-session |
| `responseMode: 'proactive'` | 顶层 `chatmode` 场景表（出厂默认解析） | 同上 |
| `response_modes` 块（default_*/configs/overrides） | 标量 `responseMode` + `responseModeParams` 分桶 | 块废除 |
| 旧 `config.{debounceMs,...}` 特有参数 | `responseModeParams[modeId].{...}` | 移入分桶 |
| 无 | 顶层 `mentionMode` / `model` | 通用参数在顶层 |

---

## 四、分步迁移指南

### 步骤 1：备份当前配置

```bash
# 备份 agent 配置
cp $AGENT_DIR/config.json $AGENT_DIR/config.json.backup

# 备份关系级配置
cp $RELATIONS_DIR/*/config.json $RELATIONS_DIR/*/config.json.backup
```

### 步骤 2：更新配置格式

#### 如果使用 interactive 或 proactive

```bash
# 更新 agent 配置
# 将 "responseMode": "interactive" 改为（chatmode 走出厂默认，通常无需配）：
{
  "responseMode": "single-session"
}
```

#### 如果使用 dual-session-lite

```bash
# 更新 agent 配置
# 将 "responseMode": "dual-session-lite" 改为：
{
  "responseMode": "dual-session",
  "mentionMode": "disabled",
  "responseModeParams": {
    "dual-session": { /* debounceMs 等特有参数搬到这里 */ }
  }
}
```

### 步骤 3：验证配置

```bash
# 启动 agent
evolclaw start

# 检查日志
tail -f $EVOLCLAW_HOME/logs/agent.log

# 验证 ECK Vars
cat $EVOLCLAW_HOME/data/eck-debug/vars.json
```

### 步骤 4：测试功能

1. 发送测试消息
2. 验证回复方式正确（interactive / proactive）
3. 验证辅助会话工作正常（dual-session）

---

## 五、兼容性说明

### 5.1 向后兼容

✅ **配置自动迁移**：旧配置会自动识别并迁移  
✅ **行为不变**：迁移后行为完全一致  
✅ **渐进式迁移**：可以逐步更新配置，不必一次性更新所有  

### 5.2 废弃警告

以下配置格式已废弃，但仍然支持（会显示警告）：

```json
// 废弃格式
{
  "responseMode": "interactive"  // ⚠️ 废弃，请迁移到 single-session + chatMode
}

{
  "responseMode": "proactive"  // ⚠️ 废弃，请迁移到 single-session + chatMode
}

{
  "responseMode": "dual-session-lite"  // ⚠️ 废弃，请迁移到 dual-session
}
```

### 5.3 移除计划

废弃的配置格式将在以下版本移除：

| 废弃项 | 移除版本 | 时间线 |
|--------|---------|--------|
| `interactive` / `proactive` | v4.0 | 2027-01 |
| `dual-session-lite` | v4.0 | 2027-01 |

---

## 六、新功能

迁移后，你可以使用以下新功能：

### 6.1 mentionMode 参数

控制如何处理 mention 消息：

```json
{
  "responseMode": "dual-session",
  "mentionMode": "mention-only"  // 新功能：只处理 @ 消息（顶层通用参数）
}
```

**详细机制**：见 [MENTION-MODE-MECHANISM.md](./MENTION-MODE-MECHANISM.md)

### 6.2 统一的参数体系

所有响应模式都支持通用参数（全部在顶层）：

```json
{
  "responseMode": "single-session",              // 或 dual-session
  "chatmode": { "private": "interactive", "group": "proactive" },  // 通用（字典）
  "mentionMode": "disabled",                     // 通用（标量）
  "model": "claude-opus"                         // 通用（标量）
}
```

---

## 七、常见问题

### Q1: 迁移后配置文件变大了？

A: 是的，因为参数从隐式变为显式。但这提高了可读性和灵活性。

**旧配置**（简洁但隐式）：
```json
{
  "responseMode": "proactive"
}
```

**新配置**（chatmode 按对端类型自动解析，通常无需显式配）：
```json
{
  "responseMode": "single-session"
}
```

### Q2: 必须手动迁移吗？

A: 不必须。代码层会自动识别旧配置并迁移。但建议手动更新配置文件，以便：
- 显式指定参数
- 利用新功能（如 mentionMode）
- 避免废弃警告

### Q3: 迁移后行为会变化吗？

A: 不会。迁移后行为完全一致，除非你显式启用新功能（如 `mentionMode: 'mention-only'`）。

### Q4: 可以混用新旧配置吗？

A: 可以。不同 agent / 关系 / 环境可以使用不同的配置格式。

**示例**：
- Agent A：使用旧配置 `responseMode: 'proactive'`
- Agent B：使用新配置 `responseMode: 'single-session'` + `chatMode: 'proactive'`
- 两者行为完全一致

### Q5: 如何验证迁移成功？

A: 检查以下内容：

```bash
# 1. 查看 ECK Vars
cat $EVOLCLAW_HOME/data/eck-debug/vars.json

# 应该看到：
{
  "responseMode": "single-session",  // 或 dual-session
  "chatMode": "proactive",           // 或 interactive
  "mentionMode": "disabled",         // 或其他值
  // ...
}

# 2. 查看系统提示词
cat $EVOLCLAW_HOME/data/eck-debug/context.txt

# 应该看到 chatMode 相关的提示词
```

---

## 八、迁移检查清单

### 迁移前

- [ ] 备份所有配置文件
- [ ] 记录当前行为（用于迁移后对比）
- [ ] 阅读新文档（README / architecture / config）

### 迁移中

- [ ] 更新 agent 级配置（`$AGENT_DIR/config.json`）
- [ ] 更新关系级配置（`$RELATIONS_DIR/*/config.json`）
- [ ] 更新环境级配置（预留，存储路径待环境层定型）

### 迁移后

- [ ] 启动 agent，检查日志无错误
- [ ] 验证 ECK Vars 正确（`vars.json`）
- [ ] 验证系统提示词正确（`context.txt`）
- [ ] 发送测试消息，验证行为一致
- [ ] （可选）启用新功能（mentionMode / model）

---

## 九、回滚指南

如果迁移后遇到问题，可以快速回滚：

### 步骤 1：恢复配置

```bash
# 恢复 agent 配置
cp $AGENT_DIR/config.json.backup $AGENT_DIR/config.json

# 恢复关系级配置
cp $RELATIONS_DIR/*/config.json.backup $RELATIONS_DIR/*/config.json
```

### 步骤 2：重启 agent

```bash
evolclaw restart
```

### 步骤 3：验证

```bash
# 检查日志
tail -f $EVOLCLAW_HOME/logs/agent.log

# 发送测试消息
```

---

## 十、获取帮助

### 文档

- **[总览](./README.md)** - 双会话响应模式概述
- **[架构](./architecture.md)** - 完整系统架构
- **[通用参数](./config/common-params.md)** - chatMode / mentionMode / model
- **[特有参数](./config/specific-params.md)** - dual-session 特有配置

### 社区

- GitHub Issues: `https://github.com/evolclaw/evolclaw/issues`
- 讨论群: `evolclaw.group.aid.pub`

---

**迁移愉快！如有问题，欢迎反馈。** 🎉

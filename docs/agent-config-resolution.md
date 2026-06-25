# Agent 配置读取机制

## 概述

EvolClaw 支持多个 Agent 后端（Claude、Codex），每个 Agent 的配置通过统一的三级 fallback 机制读取：

```
项目配置 (evolclaw.json) → 环境变量 → CLI 工具配置文件
```

这种设计允许：
- 项目级配置覆盖用户默认配置
- 运行时通过环境变量临时覆盖
- 自动继承 Claude Code / Codex CLI 的用户配置

---

## Claude Agent 配置读取

### 配置来源（按优先级）

| 优先级 | 配置来源 | 说明 |
|--------|---------|------|
| 1 | `config.agents.anthropic.apiKey` | evolclaw.json 项目配置 |
| 2 | `process.env.ANTHROPIC_AUTH_TOKEN` | 环境变量 |
| 3 | `~/.claude/settings.json` `env.ANTHROPIC_AUTH_TOKEN` | Claude Code CLI 用户配置 |

### 配置项

**API Key**（必填）
```
evolclaw.json: agents.anthropic.apiKey
环境变量: ANTHROPIC_AUTH_TOKEN
settings.json: env.ANTHROPIC_AUTH_TOKEN
```

**Base URL**（可选）
```
evolclaw.json: agents.anthropic.baseUrl
环境变量: ANTHROPIC_BASE_URL
settings.json: env.ANTHROPIC_BASE_URL
```

**Model**（可选，默认 `sonnet`）
```
evolclaw.json: agents.anthropic.model
settings.json: model
```

**Effort**（可选，默认 `auto`）
```
evolclaw.json: agents.anthropic.effort
settings.json: effortLevel
```

---

## Codex Agent 配置读取

### 配置来源（按优先级）

| 优先级 | 配置来源 | 说明 |
|--------|---------|------|
| 1 | `config.agents.openai.apiKey` | evolclaw.json 项目配置 |
| 2 | `process.env.OPENAI_API_KEY` | 环境变量 |
| 3 | `~/.codex/auth.json` `OPENAI_API_KEY` | Codex CLI 用户配置 |

### 配置项

**API Key**（必填）
```
evolclaw.json: agents.openai.apiKey
环境变量: OPENAI_API_KEY
auth.json: OPENAI_API_KEY
```

**Base URL**（可选）
```
evolclaw.json: agents.openai.baseUrl
环境变量: OPENAI_BASE_URL
config.toml: [model_providers.xxx].base_url
```

**Model**（可选，默认 `gpt-5.2-codex`）
```
evolclaw.json: agents.openai.model
config.toml: model
```

---

## 占位符检测规则

配置值如果包含以下特征，会被视为占位符（等同于未配置）：

### API Key 占位符
- 空值或 undefined
- 包含 `your-`
- 包含 `placeholder`

### Base URL 占位符
- **Claude**: 包含 `api.anthropic.com`（默认域名）
- **Codex**: 包含 `api.openai.com`（默认域名）

占位符会被跳过，继续尝试下一级配置来源。

---

## 配置示例

### evolclaw.json 完整配置

```json
{
  "agents": {
    "anthropic": {
      "apiKey": "sk-ant-xxx",
      "baseUrl": "https://api.anthropic.com",
      "model": "opus",
      "effort": "high"
    },
    "openai": {
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.openai.com",
      "model": "gpt-5.3-codex"
    },
    "defaultAgent": "claude"
  }
}
```

### evolclaw.json 最小配置（使用环境变量）

```json
{
  "agents": {
    "anthropic": {},
    "openai": {
      "model": "gpt-5.2-codex"
    }
  }
}
```

配合环境变量：
```bash
export ANTHROPIC_AUTH_TOKEN=sk-ant-xxx
export OPENAI_API_KEY=sk-xxx
```

### Claude Code CLI 配置文件

**~/.claude/settings.json**
```json
{
  "model": "sonnet",
  "effortLevel": "medium",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-ant-xxx",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
```

### Codex CLI 配置文件

**~/.codex/auth.json**
```json
{
  "OPENAI_API_KEY": "sk-xxx"
}
```

**~/.codex/config.toml**
```toml
model = "gpt-5.3-codex"
model_provider = "openai"

[model_providers.openai]
name = "openai"
base_url = "https://api.openai.com"
```

---

## 实现细节

### 配置解析函数

**Claude Agent**: `resolveAnthropicConfig(config: Config): AnthropicResolved`
- 位置: `src/config.ts`
- 返回: `{ apiKey: string, baseUrl?: string, model: string, effort?: string }`
- 失败: 抛出错误（必须有 API key）

**Codex Agent**: `resolveOpenaiConfig(config: Config): OpenaiResolved`
- 位置: `src/config.ts`
- 返回: `{ apiKey: string, baseUrl?: string, model: string }`
- 失败: 抛出错误（必须有 API key）

### Plugin 启用检查

**CodexAgentPlugin.isEnabled()**
```typescript
isEnabled(config: Config): boolean {
  try {
    const resolved = resolveOpenaiConfig(config);
    return !!resolved.apiKey;
  } catch {
    return false;  // 配置无效时不启用，不影响服务启动
  }
}
```

---

## 常见问题

### Q: 为什么 evolclaw.json 里填了占位符 API key，服务还能启动？

A: 占位符会被自动过滤，系统会继续尝试从环境变量或 CLI 配置文件读取。只要任一来源有有效配置，服务就能正常启动。

### Q: 如何临时切换到不同的 API key 测试？

A: 使用环境变量覆盖：
```bash
ANTHROPIC_AUTH_TOKEN=sk-test-xxx evolclaw start
```

### Q: Codex 不显示在 /agent 列表中？

A: 检查配置读取顺序：
1. `evolclaw.json` 中 `agents.openai.apiKey` 是否为占位符
2. 环境变量 `OPENAI_API_KEY` 是否设置
3. `~/.codex/auth.json` 是否存在且包含有效 key

### Q: 配置优先级为什么是这个顺序？

A: 遵循配置管理最佳实践：
- **项目配置优先** — 明确为项目指定的配置应该优先
- **环境变量次之** — 允许运行时临时覆盖
- **用户配置兜底** — CLI 工具的默认配置作为最后选择

---

## 总结

- 两个 agent 使用统一的三级 fallback 机制
- 占位符自动过滤，不影响配置读取
- 支持项目级、运行时、用户级三种配置方式
- Codex 配置无效时不影响 Claude 正常使用

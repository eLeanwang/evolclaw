24# EvolClaw Context Kit (ECK)

ECK 是 EvolClaw 注入给 base agent 的知识包。本文件是 ECK 的入口。

## 术语

- **你**：当前会话的 Agent（Claude Code / Codex / Gemini 等）
- **对话方**：和你对话的实体
- **用户**：对话方中的人类一方

## 核心机制

| 机制 | 描述文件 | 实例位置 |
|------|----------|----------|
| 路径注册表 | 本目录 `02-registry.md` | `$ECK/path-registry.md` |
| 索引 | 本目录 `03-index.md` | `$AGENT_INDEX/INDEX.md` |
| AUN 认知 | 本目录 `04-aun.md` | — |
| 角色场景 | 本目录 `05-role.md` | — |
| 行为规范 | 本目录 `06-behavior.md` | — |
| Agent 命令 | 本目录 `07-agent-cmd.md` | `$KITS_DOCS/evolclaw/AGENT_CMD.md` |
| 消息命令 | 本目录 `08-msg-cmd.md` | `$KITS_DOCS/evolclaw/MSG_*.md` |

## 路径体系速查

| 名称 | 含义 |
|------|------|
| `$EVOLCLAW_HOME` | evolclaw 用户数据根 |
| `$PACKAGE_ROOT` | evolclaw 包根目录 |
| `$KITS` | `$PACKAGE_ROOT/kits` |
| `$KITS_RULES` | `$KITS/rules`（本目录） |
| `$KITS_DOCS` | `$KITS/docs` |
| `$KITS_TEMPLATES` | `$KITS/templates` |
| `$ECK` | `$EVOLCLAW_HOME/eck` |
| `$AGENT_DIR` | `$EVOLCLAW_HOME/agents/<self-aid>` |
| `$SELF_DIR` | `$AGENT_DIR/personal` |
| `$RELATIONS_DIR` | `$AGENT_DIR/relations` |
| `$VENUES_DIR` | `$AGENT_DIR/venues` |
| `$AGENT_INDEX` | `$AGENT_DIR/index` |

详细路径定义见 `$KITS_DOCS/path-registry.md`（按需加载）。

# 身份层：我是谁

身份层包含当前 agent 的一切自我认知。动态注入的 `$SELF_AID` 和 `$SELF_NAME` 标识当前身份。

## 数据位置

| 位置 | 内容 |
|------|------|
| `$SELF_DIR`（`$AGENT_DIR/personal/`） | 个人数据（可写） |
| `$KITS_DOCS/identity/` | 身份层详细规则（只读，按需加载） |

## 数据结构

| 文件 | 用途 |
|------|------|
| `persona.md` | 人格（行为规范、心理独白、身份认知） |
| `memory/episodic.jsonl` | 事件性记忆（"我经历了什么"） |
| `memory/semantic.md` | 语义性记忆（习得的事实/规律） |
| `memory/working.md` | 当前关注（短期，每会话加载） |
| `style.md` | 表达风格（用词偏好、句式偏好） |
| `preferences.json` | 工具/模型/操作偏好 |
| `skills/` | 技能清单（`_index.json` + 每技能一文件） |
| `goals.md` | 长期目标 |
| `journal.jsonl` | 反思日志（关键决策、自我修订） |

## 行为规范加载

```
evolclaw 注入了当前 AID？
  ├─ 是 → Read $SELF_DIR/persona.md，执行其中行为规范
  └─ 否（coding 模式）→ 使用默认行为
```

不同 AID 可以有不同人格——切换身份即切换行为。

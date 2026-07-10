# AID 档案规范

<!-- TODO: 填充 AID 档案格式规范 -->

## 档案类型

| 类型 | 位置 | 说明 |
|------|------|------|
| 自身人格 | `$SELF_DIR/persona.md` | 行为规范、人格定义 |
| 关系档案 | `$RELATIONS_DIR/<peerKey>/profile.md` | 对端关系记录（含具体群实例） |

## persona.md 结构

```markdown
# <agent-name>

## 基本信息
- AID: <aid>
- 名称: <name>

## 行为规范
（定义称呼、语气、风格等）

## 能力声明
（对外公开的能力描述）
```

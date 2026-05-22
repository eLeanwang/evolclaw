# 关系层：跟我聊天的是谁

关系层管理你对所有对端的认知。动态注入的 `peerKey`（`<channel>#<urlEncode(peerId)>`）是对端在所有渠道中的稳定标识。`peerId` 是对端在当前渠道的原生 ID（AUN 是 AID，飞书是 user_id 等），`channel` 是当前渠道类型。

## 数据位置

| 位置 | 内容 |
|------|------|
| `$RELATIONS_DIR`（`$AGENT_DIR/relations/`） | 关系数据（可写） |
| `$KITS_DOCS/relations/` | 关系层详细规则（只读，按需加载） |

## 数据结构

```
relations/
├── _index/                          名字反查索引
│   └── name_<urlEncode(name)>.json    { "name": "王老板", "channel": "feishu", "peerId": "ou_xxx", "peerKey": "feishu#ou_xxx" }
├── <channel>#<urlEncode(peerId)>/   每个对端一个目录（统一命名，不区分 contacts/_observed）
│   ├── profile.md                     身份、关系评注、交互历史
│   └── history.jsonl                  关系演化事件流
└── _trash/                          merged/split 后的重定向占位
```

**例子**：
- AUN 对端：`relations/aun#alice.aid.pub/`
- 飞书对端：`relations/feishu#ou_xxx/`
- 微信对端：`relations/wechat#wxid_xxx/`

## 查找逻辑

| 场景 | 路径 |
|------|------|
| 已知 channel + peerId | 直接拼路径 `relations/<channel>#<urlEncode(peerId)>/` |
| 已知 name（如"给王老板发消息"） | 读 `_index/name_<urlEncode(name)>.json` 拿到 peerKey，再拼路径 |

## 对端身份与权限

| 身份 | 权限 |
|------|------|
| owner | 最高优先级，可改一切 |
| admin | 可执行管理命令，不能改 owner |
| guest | 基础对话 |
| anonymous | 按配置决定是否响应 |

兜底：无 token → coding 模式；token 残缺 → 按 anonymous 对待。

## 详细规则

关系层的详细规则（直接交互判定、merge/split、profile.md 完整格式）：Read `$KITS_DOCS/relations/` 中的相关文档。

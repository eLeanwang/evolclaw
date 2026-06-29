# AUN 协议速查表

## 命名空间

| 命名空间 | 作用 |
|---|---|
| `auth.*` | AID 创建、认证、JWT |
| `message.*` | 点对点消息收发 |
| `group.*` | 群组生命周期、群消息 |
| `storage.*` | 文件上传下载 |
| `stream.*` | 实时流（语音/视频/token） |
| `meta.*` | ping、状态、信任根查询 |
| `nameservice.*` | AID 名字注册查询 |
| `custody.*` | AID 托管 |
| `peer.*` / `relay.*` | 直连/中继认证 |

## Group 使用入口

日常群操作使用 `ec group`，详见 `evolclaw/group.md`。群文件使用 `ec fs`，详见 `evolclaw/fs.md`。

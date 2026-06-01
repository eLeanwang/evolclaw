# ec rpc — 底层 AUN RPC 调用

直接调用 AUN 协议方法的逃生通道。触发词：直接调协议方法/批量 RPC。

> 常规消息收发用 `ec msg` / `ec group`，文件用 `ec storage`。`ec rpc` 是这些命令未覆盖到协议方法时的低层入口。

## 用法

```bash
ec rpc --as <aid> --params <params>
```

- `--as <aid>` — 以哪个本地 AID 身份发起调用
- `--params` — 调用参数，自动判断输入形式：
  - 单行 JSON（以 `{` 开头）→ 单次调用
  - 多行 JSONL → 逐行执行，失败即停
  - 文件路径（文件存在）→ 读取文件内容作为 JSONL

每行 JSON 格式：`{"method":"<namespace.method>","params":{...}}`

## 示例

```bash
# 单次调用
ec rpc --as alice.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'

# 批量（从文件读 JSONL）
ec rpc --as alice.agentid.pub --params calls.jsonl
```

输出为每次调用的 JSON 结果（批量则逐行输出）。

## 命名空间速查

完整协议命名空间（auth/message/group/storage/stream/meta 等）见 `$KITS_DOCS/aun/CHEATSHEET.md`；完整协议文档 Read `$AUN_PROTOCOL_DOCS`。

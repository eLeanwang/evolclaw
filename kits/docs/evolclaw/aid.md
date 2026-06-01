# ec aid — AID 身份管理

管理本地 AID 身份（证书、私钥、agent.md 名片），以及远程探测对端 AID。触发词：身份/证书/名片/探测对端/创建身份。

## 子命令

```bash
# 列出本地所有 AID（实测 sign+verify）
ec aid list [筛选选项] [--no-verify]

# 查看本地 AID 详情（证书有效期、私钥状态、签名能力）
ec aid show <aid>

# 创建新 AID 身份
ec aid new <aid>

# 远程探测 AID（是否存在 + 网关 + agent.md）
ec aid lookup <aid>

# agent.md 名片：签名上传 / 下载验签
ec aid agentmd put <aid>
ec aid agentmd get <aid>

# 删除指定本地 AID（无网络注销）
ec aid delete <aid>
```

## list 筛选选项

不指定 = 列出 mine + broken + peer-cert（隐藏 no-cert）。可组合：
- `--mine` — 仅本地可用身份（实测可签名+验签通过）
- `--broken` — 仅有私钥但不可用（公钥不匹配 / 证书过期 / sign 失败）
- `--peer-cert` — 仅对端 AID（无私钥，有公钥证书）
- `--no-cert` — 仅无私钥无证书的孤儿目录
- `--no-verify` — 跳过 sign+verify 实测，仅静态扫描（更快）

输出图标：`🔑` 有私钥 · `✅` 实测可签名/验签 · `❌` 不可签名 · `⌛` 证书过期 · `📜` 有公钥证书 · `📄` 有 agent.md

## delete 批量清理

批量删除**默认 dry-run，加 `--yes` 才真正执行**：
- `ec aid delete --orphan` — 清理无私钥的外部 AID 缓存
- `ec aid delete --no-cert` — 清理无私钥也无公钥证书的孤儿目录
- `ec aid delete --unrecoverable` — 清理云端公钥已变更、本地不可恢复的 AID

## 通用约定

- `--format json` — 输出 JSON
- `--help` / `-h` — 各子命令均支持

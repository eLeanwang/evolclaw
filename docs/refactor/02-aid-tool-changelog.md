# 本次改动总结

## 概述

实现 `02-aid-tool.md` 方案：将 AID 相关操作从散落各处收敛为独立的 CLI 工具集（`evolclaw aid`、`evolclaw rpc`、`evolclaw storage`），agent 通过 Bash 即可驱动所有 AID/网络/存储操作，不依赖 daemon。

## 文件变更

### 新增（12 个源码文件 + 2 个文档）

```
src/aid/                    — 身份层模块（514 行）
├── types.ts                  类型定义（AidInfo, AidShowResult, AidLookupResult, AidCreateResult）
├── client.ts                 SDK 环境检测、CA 下载、AUNClient 工厂、日志抑制
├── identity.ts               list / show / new / delete / lookup
├── agentmd.ts                get（自动验签 + fallback）/ put（自动签名）
└── index.ts                  re-exports

src/aun-rpc/                — 网络层模块（86 行）
├── connection.ts             短连接管理（authenticate + connect + close）
├── caller.ts                 单次 call + batch call
└── index.ts                  re-exports

src/storage/                — 存储层模块（106 行）
├── upload.ts                 三步上传封装
├── download.ts               ticket + HTTP GET 封装
├── manage.ts                 ls / rm / quota
└── index.ts                  re-exports

docs/refactor/
├── 02-aid-tool-test-report.md    测试报告（含完整命令行）
└── sdk-verify-agentmd-bug.md     SDK verifyAgentMd bug 分析
```

### 删除（1 个文件）

```
src/channels/aun-ops.ts     — 原 AID 操作层（302 行），已完全迁移到 src/aid/
```

### 修改（6 个文件）

| 文件 | 改动 |
|---|---|
| `src/cli.ts` (+438/-94) | 新增 `cmdAid`（show/delete/lookup/agentmd）、`cmdRpc`、`cmdStorage`；删除 `cmdAgentmd`；加 `--aun-path`/`AUN_HOME`/`--format json`；加 `resolveAunPath`/`suppressSdkLogs` 调用 |
| `src/config.ts` (+26) | 接收 `appendAunInstance` 函数 |
| `src/core/command-handler.ts` (+60/-163) | 删除 `/aid` `/agentmd` 原生实现；新增 `/aid` `/rpc` `/storage` CLI 转发模式（无参数返回用法，有参数 execFile 转发）；更新 help/evolhelp |
| `src/utils/init-channel.ts` (-1/+1) | import 路径改为 `../aid/index.js` |
| `src/utils/init.ts` (-1/+1) | import 路径改为 `../aid/index.js` |
| `src/channels/aun.ts` (+33/-22) | echo 快速通道优化（非本次改造核心，已在 git 中） |

## 新增 CLI 命令

| 命令 | 说明 |
|---|---|
| `evolclaw aid list [--format json]` | 列本地所有 AID |
| `evolclaw aid show <aid> [--format json]` | 查看 AID 详情（证书、私钥、agent.md） |
| `evolclaw aid new <aid>` | 创建 AID（keygen + 注册 + CA + agent.md） |
| `evolclaw aid delete <aid>` | 本地删除 AID |
| `evolclaw aid lookup <aid> [--format json]` | 远程探测（是否存在 + 网关 + 内容） |
| `evolclaw aid agentmd put <aid>` | 自动签名 + 上传 |
| `evolclaw aid agentmd get <aid> [--format json]` | 下载 + 自动验签 + fallback |
| `evolclaw rpc --as <aid> --params <json\|jsonl\|file>` | 通用 AUN RPC（单次/批量/文件） |
| `evolclaw storage upload <aid> <file> <path> [--public]` | 上传文件 |
| `evolclaw storage download <aid> <url> [local-path]` | 下载文件 |
| `evolclaw storage ls <aid> [prefix]` | 列文件 |
| `evolclaw storage rm <aid> <path>` | 删文件 |
| `evolclaw storage quota <aid>` | 查配额 |

所有命令支持 `--aun-path <path>` 和 `AUN_HOME` 环境变量。

## 删除的命令

| 命令 | 替代 |
|---|---|
| `evolclaw agentmd <aid>` | `evolclaw aid agentmd get <aid>` |
| `evolclaw agentmd put <aid>` | `evolclaw aid agentmd put <aid>` |
| `evolclaw agentmd set <aid> <content>` | `Edit ~/.aun/AIDs/<aid>/agent.md` + `evolclaw aid agentmd put <aid>` |
| slash `/aid list` `/aid new`（原生实现） | `/aid list` `/aid new`（CLI 转发） |
| slash `/agentmd` `/agentmd put` `/agentmd set`（原生实现） | `/aid agentmd get` `/aid agentmd put`（CLI 转发） |

## 关键设计决策

1. **签名验签集成**：put 自动签名（`signAgentMd`），get 自动验签（`verifyAgentMd`）+ 本地失败自动 fallback 远程
2. **SDK 日志抑制**：`suppressSdkLogs()` 只在 CLI 入口调用，不影响 daemon
3. **SDK verifyAgentMd bug workaround**：手动获取证书传入 `certPem`，绕过 `_fetchPeerCert` 的 this 绑定丢失
4. **slash 命令 CLI 转发**：`/aid` `/rpc` `/storage` 通过 `execFile("evolclaw", [...])` 转发，单一实现
5. **所有命令独立于 daemon**：短生命周期进程，直接调 SDK

## 已知限制

- SDK `verifyAgentMd` 内部 `_fetchPeerCert` 有 this 绑定 bug（已 workaround）
- 公开文件无永久直链，需通过 download ticket 访问
- PowerShell 下 `--params` 的 JSON 需要转义双引号（PowerShell 行为，非 evolclaw bug）

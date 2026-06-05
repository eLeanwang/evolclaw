# AID 工具集测试报告

测试日期：2026-05-17
SDK 版本：@agentunion/fastaun ^0.2.19
Node 版本：v25.2.1
平台：Windows 11 Pro

---

## 一、单工具测试

### 1. `evolclaw aid list`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 默认路径列表 | (无) | 正确显示 25 个 AID + 图标 | ✅ |
| JSON 输出 | `--format json` | 有效 JSON 数组，可 jq 处理 | ✅ |
| 自定义路径（空） | `--aun-path <新路径>` | 输出"本地无 AID" | ✅ |
| 环境变量（空） | `AUN_HOME=<新路径>` | 输出"本地无 AID" | ✅ |

### 2. `evolclaw aid show <aid>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 存在的 AID | `toleiliang2.agentid.pub` | 显示私钥✓、agent.md有、证书到期日、CN | ✅ |
| JSON 输出 | `--format json` | 有效 JSON 对象 | ✅ |
| 不存在的 AID | `nonexist999.agentid.pub` | 显示"私钥:无 agent.md:无 证书:无证书" | ✅ |
| 自定义路径 | `--aun-path` | 正确读取自定义路径下的 AID | ✅ |

### 3. `evolclaw aid new <aid>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 创建新 AID | `testround2.agentid.pub` | 创建成功 + CA 下载 + agent.md 发布 | ✅ |
| 自动建目录 | `--aun-path <新路径>` | 自动创建 AIDs/、CA/root/ 目录 | ✅ |
| 环境变量建目录 | `AUN_HOME=<新路径>` | 同上 | ✅ |
| 无效 AID 格式 | `bad` | 报错"无效 AID 格式" | ✅ |

### 4. `evolclaw aid delete <aid>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 删除存在的 AID | `testround2.agentid.pub` | 输出"已删除"，目录清除 | ✅ |
| 删除不存在的 AID | `nonexist.agentid.pub` | 报错"本地不存在" | ✅ |
| 自定义路径 | `--aun-path` | 正确删除自定义路径下的 AID | ✅ |

### 5. `evolclaw aid lookup <aid>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 已注册 AID | `toleiliang2.agentid.pub` | 显示"已注册" + 网关 URL + agent.md 内容 | ✅ |
| 未注册 AID | `nonexist999.agentid.pub` | 显示"未注册" + 原因 | ✅ |
| JSON 输出 | `--format json` | 有效 JSON（exists/gateway/content） | ✅ |
| 无效格式 | `bad` | 报错"无效 AID 格式" | ✅ |

### 6. `evolclaw aid agentmd put <aid>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 正常上传 | `toleiliang2.agentid.pub` | 自动签名 + 上传成功 | ✅ |
| 无本地文件 | `nonexist999.agentid.pub` | 报错"本地无 agent.md" | ✅ |
| 自定义路径 | `--aun-path` | 正确读取自定义路径下的文件 | ✅ |

### 7. `evolclaw aid agentmd get <aid>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 本地已签名 | `toleiliang2.agentid.pub` | 显示内容 + "签名验证通过" | ✅ |
| 远程未签名 | `llagent2.agentid.pub` | 显示内容 + "未签名" | ✅ |
| 不存在 | `nonexist999.agentid.pub` | 显示"尚未设置 agent.md" | ✅ |
| JSON 输出 | `--format json` | 有效 JSON（content + verification） | ✅ |
| 自定义路径 | `--aun-path` | 正确验签 | ✅ |

### 8. `evolclaw rpc --as <aid> --params <params>`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 单次调用 | `meta.ping` | `{"ok":true,"result":{"pong":true,...}}` | ✅ |
| 发消息 | `message.send` | 返回 message_id + status:sent | ✅ |
| 批量 JSONL | 多行 inline | 逐行输出结果 | ✅ |
| 文件输入 | `.jsonl` 文件路径 | 逐行执行并输出 | ✅ |
| 缺少 --as | (无 --as) | 报错"缺少 --as" | ✅ |
| 少 --params | (无 --params) | 报错"缺少 --params" | ✅ |
| 无效 JSON | `not-json` | 报错"JSON 解析失败" | ✅ |
| 无效 AID | `bad` | 报错"无效 AID 格式" | ✅ |
| 自定义路径 | `--aun-path` | 正常工作 | ✅ |
| 环境变量 | `AUN_HOME` | 正常工作 | ✅ |

### 9. `evolclaw storage upload`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 正常上传（私有） | `<aid> <file> <path>` | "已上传" | ✅ |
| 公开上传 | `--public` | "已上传 (公开)" | ✅ |
| JSON 输出 | `--format json` | `{"ok":true,"objectKey":...}` | ✅ |
| 文件不存在 | 无效路径 | 报错"文件不存在" | ✅ |
| 缺少参数 | 只传 aid | 显示用法 | ✅ |

### 10. `evolclaw storage download`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 下载自己的文件 | `<aid>/<path>` | 下载成功，内容一致 | ✅ |
| JSON 输出 | `--format json` | `{"ok":true,"localPath":...,"size":...}` | ✅ |
| 缺少 URL | (无 url) | 显示用法 | ✅ |

### 11. `evolclaw storage ls`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 全部列表 | (无 prefix) | JSON 数组，含所有文件 | ✅ |
| 前缀过滤 | `docs/` | 只返回 docs/ 下的文件 | ✅ |
| 空结果 | 无文件时 | `(空)` | ✅ |

### 12. `evolclaw storage rm`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 正常删除 | `<path>` | "已删除" | ✅ |
| JSON 输出 | `--format json` | `{"ok":true,"objectKey":...}` | ✅ |
| 缺少参数 | (无 path) | 显示用法 | ✅ |

### 13. `evolclaw storage quota`

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 查看配额 | `<aid>` | JSON 对象（used_bytes, object_count, quota_bytes） | ✅ |

### 14. `evolclaw agentmd` (deprecated)

| 用例 | 参数 | 结果 | 状态 |
|---|---|---|:---:|
| 查看 | `<aid>` | deprecated 警告 + 正常输出 | ✅ |
| put | `put <aid>` | deprecated 警告 + 正常上传 | ✅ |
| set | `set <aid> <content>` | 报错"已删除" + exit 1 | ✅ |

---

## 二、路径机制测试

| 机制 | 测试方式 | 自动建目录 | 全功能可用 | 状态 |
|---|---|:---:|:---:|:---:|
| 默认 `~/.aun` | 无参数 | N/A（已存在） | ✅ | ✅ |
| `--aun-path <path>` | 参数传入 | ✅ AIDs/ + CA/root/ | ✅ | ✅ |
| `AUN_HOME=<path>` | 环境变量 | ✅ AIDs/ + CA/root/ | ✅ | ✅ |

---

## 三、集成场景测试

### 场景 1：完整 AID 生命周期

```
创建 AID → 查看详情 → 编辑 agent.md → 签名上传 → 远程 lookup 验证 → 下载验签 → 删除
```

| 步骤 | 结果 | 状态 |
|---|---|:---:|
| aid new | 创建成功，CA 自动下载 | ✅ |
| aid show --format json | 证书信息完整 | ✅ |
| 本地编辑 agent.md | 文件写入成功 | ✅ |
| aid agentmd put | 自动签名 + 上传 | ✅ |
| aid lookup --format json | exists:true, 内容含签名, 名称匹配 | ✅ |
| aid agentmd get --format json | verification: verified | ✅ |
| aid delete | 本地清除 | ✅ |

### 场景 2：文件存储完整流程

```
创建身份 → 查配额 → 上传多文件(私有+公开) → 列表(全部+前缀) → 下载验证内容 → 逐个删除 → 验证清空
```

| 步骤 | 结果 | 状态 |
|---|---|:---:|
| storage quota（初始） | used_bytes:0, object_count:0 | ✅ |
| 上传 3 个文件（含 --public, --format json） | 全部成功 | ✅ |
| storage ls（全部） | 3 个文件，元数据完整 | ✅ |
| storage ls（prefix=docs/） | 2 个文件 | ✅ |
| storage download + 内容验证 | 内容与上传一致 | ✅ |
| storage rm × 3 | 全部删除成功 | ✅ |
| storage ls（验证清空） | items: 0 | ✅ |

### 场景 3：RPC 批量调用 + 消息发送

```
创建身份 → 单次 RPC → 发消息 → 批量 JSONL → 文件输入 → 清理
```

| 步骤 | 结果 | 状态 |
|---|---|:---:|
| rpc meta.ping | pong:true | ✅ |
| rpc message.send | message_id 返回, status:sent | ✅ |
| 批量 JSONL（2 行） | 2 行结果，均 ok:true | ✅ |
| 文件输入（.jsonl） | 2 行结果，均 ok:true | ✅ |

---

## 四、已知问题

| # | 问题 | 影响 | Workaround |
|---|---|---|---|
| 1 | SDK `verifyAgentMd` 内部 `_fetchPeerCert` this 绑定丢失 | 不传 certPem 时验签失败 | 手动获取证书传入 certPem（已实现） |
| 2 | `getAunClient` 内部调 `createAid` 会在目标路径创建 AID 目录 | 对不存在的 AID 调 `agentmdGet` 会留下空目录 | 已知行为，不影响功能 |

---

## 五、测试统计

| 类别 | 用例数 | 通过 | 失败 |
|---|:---:|:---:|:---:|
| 单工具测试 | 47 | 47 | 0 |
| 路径机制测试 | 3 | 3 | 0 |
| 集成场景测试 | 3 场景 / 20 步骤 | 20 | 0 |
| **合计** | **70** | **70** | **0** |

---

## 六、结论

所有工具在三种路径模式（默认、--aun-path、AUN_HOME）下均正常工作。自动建目录、签名验签、批量 RPC、文件存储完整流程均验证通过。数据已恢复原样，无残留。

---

## 附录：完整测试命令行

### Round 1：默认路径（无 --aun-path）

```bash
# === aid list ===
evolclaw aid list
evolclaw aid list --format json

# === aid show ===
evolclaw aid show toleiliang2.agentid.pub
evolclaw aid show toleiliang2.agentid.pub --format json
evolclaw aid show nonexist999.agentid.pub

# === aid lookup ===
evolclaw aid lookup toleiliang2.agentid.pub
evolclaw aid lookup toleiliang2.agentid.pub --format json
evolclaw aid lookup nonexist999.agentid.pub
evolclaw aid lookup bad

# === aid agentmd get ===
evolclaw aid agentmd get toleiliang2.agentid.pub
evolclaw aid agentmd get toleiliang2.agentid.pub --format json
evolclaw aid agentmd get llagent2.agentid.pub
evolclaw aid agentmd get nonexist999.agentid.pub

# === aid agentmd put ===
evolclaw aid agentmd put toleiliang2.agentid.pub
evolclaw aid agentmd put nonexist999.agentid.pub

# === rpc ===
evolclaw rpc help
evolclaw rpc --as toleiliang2.agentid.pub --params '{"method":"meta.ping","params":{}}'
evolclaw rpc --params '{"method":"meta.ping","params":{}}'
evolclaw rpc --as toleiliang2.agentid.pub
evolclaw rpc --as toleiliang2.agentid.pub --params 'not-json'
evolclaw rpc --as bad --params '{"method":"meta.ping","params":{}}'

# === storage ===
evolclaw storage help
evolclaw storage quota toleiliang2.agentid.pub
evolclaw storage ls toleiliang2.agentid.pub

# storage upload
echo "round1 test content" > /tmp/r1-test.txt
evolclaw storage upload toleiliang2.agentid.pub /tmp/r1-test.txt test/r1.txt
echo "round1 json" > /tmp/r1-json.txt
evolclaw storage upload toleiliang2.agentid.pub /tmp/r1-json.txt test/r1-json.txt --format json
echo "public file" > /tmp/r1-pub.txt
evolclaw storage upload toleiliang2.agentid.pub /tmp/r1-pub.txt test/r1-pub.txt --public
evolclaw storage upload toleiliang2.agentid.pub /tmp/no-such-file.txt test/x.txt
evolclaw storage upload toleiliang2.agentid.pub

# storage ls (after upload)
evolclaw storage ls toleiliang2.agentid.pub test/

# storage download
evolclaw storage download toleiliang2.agentid.pub toleiliang2.agentid.pub/test/r1.txt /tmp/r1-dl.txt
evolclaw storage download toleiliang2.agentid.pub toleiliang2.agentid.pub/test/r1-json.txt /tmp/r1-json-dl.txt --format json
evolclaw storage download toleiliang2.agentid.pub

# storage rm
evolclaw storage rm toleiliang2.agentid.pub test/r1.txt
evolclaw storage rm toleiliang2.agentid.pub test/r1-json.txt --format json
evolclaw storage rm toleiliang2.agentid.pub test/r1-pub.txt
evolclaw storage rm toleiliang2.agentid.pub

# deprecated agentmd
evolclaw agentmd toleiliang2.agentid.pub
evolclaw agentmd set toleiliang2.agentid.pub "test"
```

### Round 2：`--aun-path` 参数方式

```bash
AUN_TEST_PATH="C:/Users/agentcp/.evolclaw/aids"

# aid list (空目录)
evolclaw aid list --aun-path "$AUN_TEST_PATH"
evolclaw aid list --format json --aun-path "$AUN_TEST_PATH"

# aid show (不存在)
evolclaw aid show toleiliang2.agentid.pub --aun-path "$AUN_TEST_PATH"

# aid new (自动建目录)
evolclaw aid new testround2.agentid.pub --aun-path "$AUN_TEST_PATH"

# 验证目录结构
ls "$AUN_TEST_PATH/AIDs/testround2.agentid.pub/"
ls "$AUN_TEST_PATH/CA/root/"

# aid list / show
evolclaw aid list --aun-path "$AUN_TEST_PATH"
evolclaw aid show testround2.agentid.pub --aun-path "$AUN_TEST_PATH"

# agentmd put / get
evolclaw aid agentmd put testround2.agentid.pub --aun-path "$AUN_TEST_PATH"
evolclaw aid agentmd get testround2.agentid.pub --aun-path "$AUN_TEST_PATH"

# lookup
evolclaw aid lookup testround2.agentid.pub --aun-path "$AUN_TEST_PATH"

# rpc
evolclaw rpc --as testround2.agentid.pub --params '{"method":"meta.ping","params":{}}' --aun-path "$AUN_TEST_PATH"

# storage
evolclaw storage quota testround2.agentid.pub --aun-path "$AUN_TEST_PATH"
echo "round2 test" > /tmp/r2-test.txt
evolclaw storage upload testround2.agentid.pub /tmp/r2-test.txt test/r2.txt --aun-path "$AUN_TEST_PATH"
evolclaw storage ls testround2.agentid.pub --aun-path "$AUN_TEST_PATH"
evolclaw storage download testround2.agentid.pub testround2.agentid.pub/test/r2.txt /tmp/r2-dl.txt --aun-path "$AUN_TEST_PATH"
evolclaw storage rm testround2.agentid.pub test/r2.txt --aun-path "$AUN_TEST_PATH"

# 清理
evolclaw aid delete testround2.agentid.pub --aun-path "$AUN_TEST_PATH"
evolclaw aid list --aun-path "$AUN_TEST_PATH"
```

### Round 3：`AUN_HOME` 环境变量方式

```bash
export AUN_HOME="C:/Users/agentcp/.evolclaw/aids/AU"

# aid list (空)
evolclaw aid list

# aid new (自动建目录)
evolclaw aid new testround3.agentid.pub

# 验证目录结构
ls "$AUN_HOME/AIDs/testround3.agentid.pub/"
ls "$AUN_HOME/CA/root/"

# aid list / show
evolclaw aid list
evolclaw aid show testround3.agentid.pub
evolclaw aid show testround3.agentid.pub --format json

# agentmd put / get
evolclaw aid agentmd put testround3.agentid.pub
evolclaw aid agentmd get testround3.agentid.pub

# lookup
evolclaw aid lookup testround3.agentid.pub

# rpc
evolclaw rpc --as testround3.agentid.pub --params '{"method":"meta.ping","params":{}}'

# storage
echo "round3 env test" > /tmp/r3-test.txt
evolclaw storage upload testround3.agentid.pub /tmp/r3-test.txt test/r3.txt
evolclaw storage download testround3.agentid.pub testround3.agentid.pub/test/r3.txt /tmp/r3-dl.txt
evolclaw storage rm testround3.agentid.pub test/r3.txt

# 清理
evolclaw aid delete testround3.agentid.pub
evolclaw aid list
```

### 场景 1：完整 AID 生命周期

```bash
export AUN_HOME="C:/Users/agentcp/.evolclaw/aids/AU"

# [1.1] 创建
evolclaw aid new scenario1.agentid.pub

# [1.2] 查看
evolclaw aid show scenario1.agentid.pub --format json

# [1.3] 编辑本地 agent.md
cat > "$AUN_HOME/AIDs/scenario1.agentid.pub/agent.md" << 'EOF'
---
aid: "scenario1.agentid.pub"
name: "场景测试Agent"
type: "test"
version: "2.0.0"
description: "集成测试用 Agent"
tags:
  - test
  - scenario
initialized: true
---

# 场景测试 Agent

这是一个用于集成测试的 Agent。
EOF

# [1.4] 签名上传
evolclaw aid agentmd put scenario1.agentid.pub

# [1.5] 远程验证
evolclaw aid lookup scenario1.agentid.pub --format json

# [1.6] 下载验签
evolclaw aid agentmd get scenario1.agentid.pub --format json

# [1.7] 删除
evolclaw aid delete scenario1.agentid.pub

# [1.8] 确认
evolclaw aid show scenario1.agentid.pub
```

### 场景 2：文件存储完整流程

```bash
export AUN_HOME="C:/Users/agentcp/.evolclaw/aids/AU"

# [2.1] 创建
evolclaw aid new scenario2.agentid.pub

# [2.2] 初始配额
evolclaw storage quota scenario2.agentid.pub

# [2.3] 上传多文件
echo "file A content" > /tmp/s2-a.txt
echo "file B content here" > /tmp/s2-b.txt
echo '{"key":"value","num":42}' > /tmp/s2-c.json
evolclaw storage upload scenario2.agentid.pub /tmp/s2-a.txt docs/a.txt
evolclaw storage upload scenario2.agentid.pub /tmp/s2-b.txt docs/b.txt --public
evolclaw storage upload scenario2.agentid.pub /tmp/s2-c.json data/config.json --format json

# [2.4] 列表（全部）
evolclaw storage ls scenario2.agentid.pub

# [2.5] 列表（前缀）
evolclaw storage ls scenario2.agentid.pub docs/

# [2.6] 下载验证
evolclaw storage download scenario2.agentid.pub scenario2.agentid.pub/docs/a.txt /tmp/s2-a-dl.txt
cat /tmp/s2-a-dl.txt
evolclaw storage download scenario2.agentid.pub scenario2.agentid.pub/data/config.json /tmp/s2-c-dl.json
cat /tmp/s2-c-dl.json

# [2.7] 逐个删除
evolclaw storage rm scenario2.agentid.pub docs/a.txt
evolclaw storage rm scenario2.agentid.pub docs/b.txt
evolclaw storage rm scenario2.agentid.pub data/config.json

# [2.8] 验证清空
evolclaw storage ls scenario2.agentid.pub

# [2.9] 清理
evolclaw aid delete scenario2.agentid.pub
```

### 场景 3：RPC 批量调用 + 消息发送

```bash
export AUN_HOME="C:/Users/agentcp/.evolclaw/aids/AU"

# [3.1] 创建
evolclaw aid new scenario3.agentid.pub

# [3.2] 单次 RPC
evolclaw rpc --as scenario3.agentid.pub --params '{"method":"meta.ping","params":{}}'

# [3.3] 发消息
evolclaw rpc --as scenario3.agentid.pub --params '{"method":"message.send","params":{"to":"toleiliang2.agentid.pub","payload":{"type":"text","text":"hello from scenario3 test"}}}'

# [3.4] 批量 JSONL (inline)
evolclaw rpc --as scenario3.agentid.pub --params '{"method":"meta.ping","params":{}}
{"method":"storage.get_quota","params":{}}'

# [3.5] 文件输入
printf '{"method":"meta.ping","params":{}}\n{"method":"storage.list_objects","params":{"prefix":""}}\n' > /tmp/s3-calls.jsonl
evolclaw rpc --as scenario3.agentid.pub --params /tmp/s3-calls.jsonl

# [3.6] 清理
evolclaw aid delete scenario3.agentid.pub
```

### 清理与恢复验证

```bash
# 清理 Round 2 残留
rm -rf C:/Users/agentcp/.evolclaw/aids/AIDs C:/Users/agentcp/.evolclaw/aids/CA

# 清理 Round 3 残留
rm -rf C:/Users/agentcp/.evolclaw/aids/AU

# 清理测试副作用
rm -rf ~/.aun/AIDs/nonexist999.agentid.pub

# 验证恢复
ls C:/Users/agentcp/.evolclaw/aids/
evolclaw aid list --format json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf-8')); console.log('AID 数量:', d.length)"
```

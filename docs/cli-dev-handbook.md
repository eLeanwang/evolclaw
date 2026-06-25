# CLI 命令开发手册

本手册定义 evolclaw CLI 命令的设计准则。新增命令必须遵循本文档约定，确保用户体验一致。

## 1. 命令结构

```
evolclaw <domain> <action> [positional-args...] [--flags...]
```

- **domain**：命令域（agent, msg, group, aid, storage, watch, net 等）
- **action**：动作动词（list, show, send, pull, create, delete 等）
- **positional-args**：必选位置参数，按重要性排列
- **flags**：可选命名参数

### 命名规则

| 规则 | 示例 |
|------|------|
| domain 用名词 | `agent`, `msg`, `group`, `net` |
| action 用动词 | `list`, `show`, `send`, `check` |
| 缩写仅限通用词 | `msg`(message), `ack`(acknowledge) |
| 无 action 时等同 `list` | `evolclaw agent` = `evolclaw agent list` |

## 2. 参数顺序

**位置参数遵循"主语 → 宾语 → 内容"顺序：**

```
evolclaw msg send <from> <to> <text>
                  主语    宾语  内容
```

- 第一个位置参数：操作者/发送者（自己的 AID）
- 第二个位置参数：目标/接收者
- 后续位置参数：内容或标识符

**多值参数用空格分隔（不用逗号）：**

```
evolclaw msg online <from> <target1> <target2> <target3>
```

## 3. 通用 Flags

| Flag | 作用 | 适用范围 |
|------|------|----------|
| `--format json` | JSON 输出 | 所有命令 |
| `--app <name>` | 应用 slot 隔离 | msg/group 的 ack 命令（必选） |
| `--limit N` | 结果数量上限 | 列表/拉取类命令 |
| `--after-seq N` | 增量游标 | 消息拉取类命令 |

**Flag 命名规则：**
- 全小写，单词用 `-` 连接：`--after-seq`, `--join-mode`
- 布尔 flag 无需值：`--purge`, `--raw`, `--mention-all`
- 枚举值直接跟在 flag 后：`--format json`, `--visibility public`

## 4. 输出格式

### 人类可读模式（默认）

```
✓ 已发送 → evolapp.agentid.pub abc123 seq=5 status=delivered
```

- 成功用 `✓`，失败用 `❌`
- 关键信息一行内展示
- 列表用对齐的表格或缩进

### JSON 模式（`--format json`）

```json
{ "ok": true, "message_id": "abc123", "seq": 5, "status": "delivered" }
```

```json
{ "ok": false, "error": "AID not found", "code": -32603 }
```

- 统一信封：`{ ok: boolean, ...data }` 或 `{ ok: false, error: string }`
- 所有字段都包含，不省略
- 一行一个 JSON 对象（便于管道处理）

## 5. 错误处理

| 场景 | 人类模式 | JSON 模式 | 退出码 |
|------|----------|-----------|--------|
| 成功 | `✓ ...` | `{ ok: true, ... }` | 0 |
| 参数错误 | `❌ <msg>` + 用法提示 | `{ ok: false, error }` | 1 |
| 运行时错误 | `❌ <msg>` | `{ ok: false, error, code }` | 1 |
| daemon 未运行 | `❌ evolclaw 未运行` | `{ ok: false, error }` | 1 |

**错误消息规范：**
- 中文为主，技术术语保留英文（AID, seq, WebSocket）
- 说明原因 + 给出建议：`❌ AID 未找到，请检查拼写或运行 evolclaw aid list`
- 不暴露堆栈，不 throw 未捕获异常

## 6. 命令实现模板

```typescript
// src/cli/index.ts 中的 case 分支
case 'net':
  await cmdNet(args.slice(1));
  break;

// 命令处理函数
async function cmdNet(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = args.includes('--format') && args.includes('json');

  if (!sub || sub === 'check') {
    // 默认 action
    await cmdNetCheck(args.slice(1), formatJson);
    return;
  }

  console.error(`未知子命令: net ${sub}`);
  console.error('用法: evolclaw net check [<aid>]');
  process.exit(1);
}
```

## 7. 破坏性操作

- 必须有显式确认 flag（如 `--purge`）
- 人类模式下输出警告
- 文档标注"不可逆"

## 8. 帮助文本

每个命令域应在无参数或 `--help` 时输出用法：

```
用法: evolclaw net check [<aid>] [--format json]

检查 AUN 网络链路连通性。

参数:
  <aid>    要检查的 AID（可选，默认检查所有本地 AID）

选项:
  --format json    JSON 格式输出
```

## 9. 文件组织

- 小命令（<100 行）：inline 在 `src/cli/index.ts`
- 中等命令（100-500 行）：独立文件 `src/cli/<domain>.ts`，从 index.ts dynamic import
- 大型命令（>500 行）：独立文件 `src/<domain>.ts`，如 `src/watch-msg.ts`

## 10. 测试验证

新命令上线前必须验证：
1. `npm run build` 无 TS 错误
2. 无参数执行显示帮助
3. `--format json` 输出合法 JSON
4. 错误场景返回 exit code 1
5. 不依赖 daemon 的命令在 daemon 离线时仍可用

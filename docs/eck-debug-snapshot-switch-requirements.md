# ECK 调试快照总开关需求

> 状态：需求确认稿，未来实施
>
> 日期：2026-07-14
>
> 目标版本：待定
>
> 配置范围：进程级 `$EVOLCLAW_HOME/evolclaw.json`

## 1. 背景

EvolClaw 在消息处理过程中会把 ECK 上下文渲染结果写入：

```text
$EVOLCLAW_HOME/data/eck-debug/
```

当前目录中的主要文件包括：

| 文件 | 产生位置 | 内容 |
|---|---|---|
| `vars-*.json` | `src/eck/kit-renderer.ts` | ECK 渲染变量、session ID、路径等 |
| `context-*.md` | `src/eck/kit-renderer.ts` | 最终注入模型的 ECK 上下文 |
| `fragments-*.md` | `src/eck/kit-renderer.ts` | 需要注入的上下文片段 |
| `manifest-*.md` | `src/eck/kit-renderer.ts` | manifest 路径解析及加载诊断 |
| `msg-render-*.md` | `src/eck/message-renderer.ts` | 入站消息渲染结果 |
| `response-snapshots.jsonl` | `src/core/message/response-snapshot.ts` | 响应模式迁移行为探针，当前另受 `RESPONSE_SNAPSHOT=1` 控制 |

这些文件只用于排查 ECK、消息模板和响应模式问题，不参与 ECK 上下文计算。但持续写入会带来：

1. 磁盘占用和高频小文件；
2. session ID、本地路径、上下文正文等调试数据留存；
3. 正常运行时不必要的文件系统 I/O；
4. 用户无法明确判断关闭调试后为何目录仍在增长。

因此需要一个进程级总开关，使正常运行默认不产生 `data/eck-debug/` 调试快照，同时保证 ECK 正常工作完全不受影响。

## 2. 设计结论

新增或正式化以下进程级配置：

```json
{
  "$schema_version": 1,
  "debug": {
    "eckSnapshots": false
  }
}
```

配置语义：

| 值 | 行为 |
|---|---|
| `false` | 不向 `data/eck-debug/` 写入任何新的旁路调试快照 |
| `true` | 允许 ECK 渲染快照；独立子探针仍需满足自己的启用条件 |
| 未配置 | 按 `false` 处理 |

`debug.eckSnapshots` 是 `data/eck-debug/` 的总写入闸门。任何写入该目录的现有或未来诊断功能，都必须先通过此开关；子功能开关只能进一步收窄，不能绕过总闸。

例如响应模式探针的有效条件为：

```text
debug.eckSnapshots == true
AND RESPONSE_SNAPSHOT == 1
```

## 3. 目标

1. 默认停止生成 ECK 调试快照；
2. 显式开启后保留现有诊断能力；
3. 关闭开关不改变 ECK 渲染结果、消息处理结果或模型输入；
4. 所有 `data/eck-debug/` 写入遵循同一总闸，避免遗漏；
5. 开关读取和失败处理不增加消息热路径的明显开销；
6. 调试数据的开启权限与进程级敏感配置保持一致。

## 4. 非目标

- 不改变 ECK manifest、section、变量或模板语义；
- 不改变 `data/eck/` 正常运行文件；
- 不增加按 Agent、会话或消息粒度的开关；
- 首期不提供快照内容脱敏、压缩或上传能力；
- 首期不提供新的专用 CLI 子命令；
- 不将快照写入失败升级为任务错误；
- 不通过该开关控制普通运行日志、AUN trace 或 AUN SDK 日志。

## 5. 功能需求

### 5.1 配置位置与权限

1. 配置字段固定为 `debug.eckSnapshots`；
2. 字段只允许出现在进程级 `$EVOLCLAW_HOME/evolclaw.json`；
3. 不允许放入 defaults、Agent 或 relation 配置，避免不同 Agent 对同一共享目录产生冲突判断；
4. 字段类型必须是 boolean，其他类型按配置校验错误处理；
5. 该字段沿用 `evolclaw.json` 的 H 类保护和 human-only 修改权限；
6. Agent、模型输出、消息正文和外部渠道 payload 均不能覆盖该值。

### 5.2 默认行为

1. 新安装未配置时默认 `false`；
2. 升级安装未配置时同样默认 `false`；
3. 从历史上的无条件写入或临时“默认开启”实现升级后，允许默认停止生成快照，这是本需求的预期行为；
4. 需要排障时由用户显式设置为 `true` 并重启或重载 daemon。

### 5.3 关闭状态

当 `debug.eckSnapshots=false` 时：

1. `renderKitSections()` 仍完整执行并返回相同上下文；
2. `renderMessageBody()` 仍完整执行并返回相同消息正文；
3. 不生成 `vars-*`、`context-*`、`fragments-*`、`manifest-*`、`msg-render-*`；
4. 即使设置 `RESPONSE_SNAPSHOT=1`，也不写入 `response-snapshots.jsonl`；
5. 不为单次消息执行 mkdir、write、append、stat 或目录扫描；
6. 已存在的 `data/eck-debug/` 目录可以保留为空；
7. 已存在的历史快照不因关闭开关而自动删除，避免配置切换产生隐式破坏性操作；
8. 不输出逐消息“快照已关闭”日志。

### 5.4 开启状态

当 `debug.eckSnapshots=true` 时：

1. 保留现有五类 ECK 渲染快照；
2. `response-snapshots.jsonl` 只有在 `RESPONSE_SNAPSHOT=1` 时才启用；
3. 目录不存在时按需创建；
4. 写入必须是 best effort，任何目录创建、序列化或文件写入失败都不得影响消息和任务；
5. 写入失败最多记录 DEBUG/WARN 日志，不发布 `task:error`；
6. daemon 启动时记录一条调试快照已启用的提示，说明目录位置及可能包含敏感上下文；
7. 文件命名和内容格式首期保持兼容，避免破坏现有排障脚本。

### 5.5 配置生效时机

首期要求启动时解析一次，并在 daemon 生命周期内复用解析结果：

- 修改配置后通过 restart/reload 生效；
- 不允许每处理一条消息都重新读取和解析 `evolclaw.json`；
- 若现有配置管理器已经提供可靠的进程配置热更新，可在不增加热路径 I/O 的前提下即时更新缓存，但不作为首期验收前置条件。

### 5.6 清理与保留

1. 本开关只负责控制新增写入，不承担历史数据删除；
2. 开启时沿用现有 24 小时过期清理策略；
3. 关闭时不得自动删除已有快照；
4. 用户需要立即释放空间时，可手工删除 `data/eck-debug/`；
5. 首期不增加 retention 配置，避免把单一开关扩展为调试存储管理系统；
6. 后续若增加清理命令，应独立设计并要求显式确认。

## 6. ECK 正常工作不受影响

开关检查只能包裹旁路写入，不能包裹或短路以下逻辑：

```text
manifest 加载
  → section 条件判断
  → 路径解析和文件加载
  → 模板渲染
  → 上下文/消息正文组装
  → 返回业务结果
  → [仅此处受控] 写调试快照
```

必须满足：

```text
render(input, eckSnapshots=false) === render(input, eckSnapshots=true)
```

比较范围包括：

- 返回字符串和消息 body；
- manifest 诊断对渲染决策的内部影响；
- ECK/session 缓存；
- 发送给模型的 system reminder；
- Trigger、因果链、handoff 和审批行为。

唯一允许的差异是旁路文件和一条启动提示日志。

## 7. 安全与隐私要求

ECK 快照可能包含：

- session ID、AID 和 peer ID；
- 本地项目、个人目录及关系目录路径；
- 最终注入模型的上下文正文；
- 用户消息渲染结果；
- manifest 缺失路径和加载诊断。

因此：

1. 默认必须关闭；
2. 配置必须保持进程级 H 类保护；
3. 开启提示必须说明快照可能包含敏感内容；
4. 快照不得被自动发送到 AUN、飞书或其他外部服务；
5. 开关值不得来自消息、模型或工具回传；
6. 关闭快照不能降低 ECK、消息或权限校验的日志级别和安全性。

## 8. 实施位置

| 文件 | 预期修改 |
|---|---|
| `kits/schemas/evolclaw.schema.1.json` | 声明进程级 boolean 字段，默认 `false` |
| `src/types.ts` | 在 `ProcessDebugBlock` 中声明 `eckSnapshots?: boolean` |
| `src/config-store.ts` 或进程配置服务 | 解析默认值并提供缓存后的总闸状态 |
| `src/eck/kit-renderer.ts` | 控制 vars/context/fragments/manifest 写入 |
| `src/eck/message-renderer.ts` | 控制 msg-render 写入 |
| `src/core/message/response-snapshot.ts` | 将总闸与 `RESPONSE_SNAPSHOT=1` 组合 |
| `src/paths.ts` | 避免关闭状态仅为调试快照强制创建目录；若因兼容保留空目录也可接受 |
| `tests/unit/eck-snapshots.test.ts` | 覆盖默认值、总闸、渲染等价性和子探针组合 |
| 配置参考文档 | 说明作用域、默认值、生效时机和敏感数据风险 |

## 9. 当前代码与目标差距

截至 2026-07-14，当前工作区已出现一版局部实现，但正式实施前仍需按本需求收口：

| 项目 | 当前观察 | 目标 |
|---|---|---|
| 配置字段 | 已有 `debug.eckSnapshots` | 保留字段名 |
| 缺省值 | `true` | 改为 `false` |
| ECK 五类快照 | 已有开关判断 | 保持并补齐失败隔离 |
| 响应模式快照 | 只看 `RESPONSE_SNAPSHOT=1` | 必须同时经过总闸 |
| 配置读取 | 渲染时可能重复加载进程配置 | 启动解析或缓存，不做逐消息磁盘读取 |
| 目录创建 | 启动时无条件创建 `eck-debug` | 可保留空目录，但关闭后不得产生文件 |
| 清理 | 24 小时清理，关闭时保留旧快照 | 保持该语义 |
| 配置入口文档 | 尚不完整 | 补充正式配置说明 |

## 10. 测试要求

### 10.1 配置测试

1. 未配置时返回 `false`；
2. 显式 `true/false` 正确解析；
3. 非 boolean 值被 schema 拒绝；
4. defaults、Agent、relation 作用域不能配置该字段；
5. 修改 H 类配置仍受既有授权机制保护。

### 10.2 行为测试

1. 相同输入在开关开启和关闭时得到完全相同的 ECK 上下文；
2. 相同输入在开启和关闭时得到完全相同的消息 body；
3. 关闭时五类 ECK 快照均不产生；
4. 关闭且 `RESPONSE_SNAPSHOT=1` 时仍不产生响应快照；
5. 开启时五类快照均可产生；
6. 开启且 `RESPONSE_SNAPSHOT=1` 时响应快照可产生；
7. 开启但目录不可写时，渲染和任务仍成功；
8. 关闭后已有文件不被删除；
9. 开启时超过 24 小时的既有 ECK 快照按现有策略清理。

### 10.3 性能测试

1. 关闭状态不得执行快照文件写入；
2. 关闭状态不得为每条消息读取 `evolclaw.json`；
3. 开关判断应为内存 boolean 读取；
4. 关闭前后 ECK 渲染耗时差异应处于测试波动范围内。

## 11. 验收标准

1. 全新或升级环境未配置时不再生成 `data/eck-debug/` 文件；
2. 显式开启后现有 ECK 排障快照仍可使用；
3. 关闭时即使 `RESPONSE_SNAPSHOT=1`，该目录也不会继续增长；
4. 开关开启和关闭时业务渲染结果逐字节一致；
5. 快照写入失败不会导致消息失败、任务失败或 Trigger 错误事件；
6. 现有历史快照不会因关闭开关被自动删除；
7. 配置只存在于进程级作用域，Agent 无法自行开启；
8. 文档明确说明默认值、重启/重载要求和敏感数据风险。

## 12. 建议实施顺序

1. 将 schema 和运行时默认值统一改为 `false`；
2. 建立缓存后的进程级总闸读取接口；
3. 接入 ECK kit/message 两类写入点；
4. 接入 response snapshot 子探针；
5. 补齐写入失败隔离和启动提示；
6. 增加测试并更新配置参考文档。

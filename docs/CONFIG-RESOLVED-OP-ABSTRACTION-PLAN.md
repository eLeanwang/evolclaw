# ec config 统一语义与托管授权方案

> 状态：已实施
>
> 日期：2026-07-10

## 1. 目标

本次升级解决两个独立但相关的问题：

1. `menu.cli` 鉴权进程与 CLI 执行进程过去各自解释一遍 argv，可能出现“鉴权语义”和
   “实际落盘语义”漂移。
2. Agent 在托管会话中通过 Bash 直接运行 `ec config` 时，过去只有环境变量和 H/HA
   门，没有进入 role、operation、字段策略和当前 relation 授权链。

实施后的核心不变量：

- 字段级 `config get/set/unset` 只由 `resolveConfigOperation()` 解释。
- 鉴权和执行只消费 `ResolvedConfigOp`，不再各自解析 field、value、selector。
- `menu.cli` 对 canonical argv 授权并 spawn canonical argv；子进程使用同一个 resolver
  再解析，因此保证确定性的语义等价。
- 托管 Agent 不在 CLI 子进程内推断 role，而是通过 daemon IPC 使用 session 派生的可信身份。
- daemon 内对同一个 `ResolvedConfigOp` 先授权、后执行，拒绝时不会落盘。

## 2. 边界与非目标

- 本抽象只覆盖字段级 `get/set/unset`。`show`、`effective`、`list`、`history`、`snapshot`、
  `prune`、`diff`、`restore`、`current`、`boots`、`init`、`validate`、`fields` 仍是配置管理命令，
  不伪装成字段读取。
- 菜单仍使用 subprocess 执行 CLI，以保持 `console.log/process.exit` 隔离。
- canonical argv 提供确定性语义等价，不宣称父子进程共享同一个对象，也不提供加密绑定。
- H/HA 只描述 schema/输出属性，不参与字段授权。授权由 operation、scope、role 和字段策略决定。
- 标准威胁模型是假定托管 runner 注入的 `EVOLCLAW_SESSION_ID` 未被调用方刻意删除。
  主动删除该变量并把命令伪装成人类本地 CLI，不在本次边界内。
- 本次只收紧 `config.*`。其他既有 `write-own` operation 的 agent 级行为不变，待旧菜单
  分支完成迁移后再分期统一。

## 3. 三条执行路径

### 3.1 人类本地 CLI

```text
argv
  -> resolveConfigOperation
  -> ResolvedConfigOp
  -> executeResolvedConfigOperation
  -> config file
```

人类本地 CLI 是受信任的运维入口，不做会话 role 鉴权，但必须通过统一严格语法和配置路由。

### 3.2 menu.cli

```text
menu argv + current relation
  -> parseCliIntent
  -> resolveConfigOperation
  -> authorizeResolvedConfigOperation
  -> canonicalArgv
  -> spawn dist/cli/index.js canonicalArgv
  -> child resolveConfigOperation
  -> executeResolvedConfigOperation
```

父进程注入当前 relation、解析并授权；只在 allow 后 spawn。字段级命令的 spawn 参数固定使用
`op.canonicalArgv`，审计 hash 也使用 canonical argv。子进程不信任宽松 positional 规则，
而是再次使用同一 resolver。

### 3.3 托管 Agent CLI

```text
ec config get/set/unset + EVOLCLAW_SESSION_ID
  -> config.op IPC
  -> daemon getSessionById
  -> derive actor / role / selfAid / current peerKey
  -> resolveConfigOperation(defaultRelation)
  -> authorizeResolvedConfigOperation(source=agent-tool)
  -> audit
  -> executeResolvedConfigOperation
```

关键约束：

- CLI 不接受调用方声明的 role，也不在子进程中猜测 role。
- 默认 selector 来自 daemon 持有的 session；显式 selector 仍必须通过当前 agent/relation 约束。
- IPC 不可用、超时或异常时返回 `DAEMON_UNAVAILABLE`，绝不回退到本地写入。
- 无效 session 返回 `INVALID_SESSION`。
- 托管环境中的配置管理子命令直接返回 `FORBIDDEN_AGENT_CONFIG`，不进入 IPC。

## 4. ResolvedConfigOp

实现位于 `src/config/resolved-config-op.ts`：

```ts
interface ResolvedConfigOp {
  canonicalArgv: string[];
  subcommand: 'get' | 'set' | 'unset';
  configScope: 'process' | 'defaults' | 'agent' | 'relation';
  commandScope: CommandScope;
  operationId:
    | 'config.get' | 'config.set' | 'config.unset'
    | 'config.read' | 'config.write';
  field: string;
  fieldRule: ConfigFieldRule;
  route?: FieldRoute;
  self?: string;
  peerKey?: string;
  rawValue?: string;
  value?: unknown;
}
```

该对象只包含从 argv、默认 relation 和配置 schema 推导出的事实，不包含 actor、role 或授权结论。
`route` 对未知/敏感读取可为空，因为管理读取可以返回不存在的字段；写入和安全字段读取必须有
明确路由。

## 5. 严格解析规则

### 5.1 positional

- `get/unset` 必须正好有一个业务 positional：`field`。
- `set` 必须正好有两个业务 positional：`field value`。
- 多余 positional、未知 option、重复 option、缺少 option value 一律拒绝。
- 不支持通过 `--` 绕过 option 解析。

### 5.2 selector

| selector | 配置文件级别 |
|---|---|
| `--process` / `--evolclaw` | process |
| `--default` | defaults |
| `--self <aid>` | agent |
| `--self <aid> --peer <peerKey>` | relation |

- `set/unset` 必须有 selector；缺失时 `SELECTOR_REQUIRED`。
- `--peer` 必须和 `--self` 同时出现。
- process/default/self 三类 selector 互斥。
- `unset --process` 被拒绝，因为没有更低层可回落。
- menu 和 daemon 可以在没有显式 selector 时注入当前 relation。
- 显式 selector 永远不被默认 relation 覆盖。

### 5.3 canonical argv

canonical 顺序固定为：

```text
config <subcommand> <field> [value]
  [--process | --default | --self <aid> [--peer <peerKey>]]
  [--format <format>]
```

同一输入重复解析结果深相等；canonical argv 再解析得到同一个结构值。

## 6. operation 分类

分类在 parser/resolver 阶段完成：

| 条件 | get | set/unset | dangerous |
|---|---|---|---|
| safe 字段 + relation/agent | `config.get` | `config.set/unset` | false |
| sensitive/unknown 字段 | `config.read` | `config.write` | true |
| process/defaults 命令 scope | `config.read` | `config.write` | true |

因此敏感字段在进入角色权限匹配前已经升级到 user-plane ceiling 之外，不能靠下游遗漏来放行。
`config.get` 与 `config show/effective/list` 始终是不同 operation。

## 7. 文件级权限与字段级权限

授权顺序是 fail-closed 的两层判断。

### 7.1 文件级/作用域权限

1. operation 必须存在，并允许当前 source（`menu.cli` 或 `agent-tool`）。
2. role 必须存在且 `allowAccess !== false`。
3. 非管理角色必须位于 user-plane capability ceiling 内。
4. 群聊中的所有角色（包括 owner/admin）只能修改 relation scope；process/agent 配置写入直接拒绝。
5. member/visitor 的字段级 config 只能是 relation scope。
6. `self` 必须等于当前 agent，`peerKey` 必须等于当前 relation。
7. role permission 的 scope 仍需允许 relation。

`targetCurrentAgentOnly` 与 `currentRelationOnly` 有意同时保留：前者锁 agent，后者锁
agent + peer。两者是纵深约束，不应作为重复代码删除。

### 7.2 字段白名单/黑名单

字段策略位于 `src/config/config-field-policy.ts`。

先执行黑名单分类：

- `owners/admins/roles/channels/aun/models/projects/capabilities/debug/observable` 等身份、
  策略、凭证或进程字段属于 sensitive。
- 不认识的字段属于 unknown。
- sensitive/unknown 不进入 member/visitor 字段平面，解析阶段升级为 dangerous 管理 operation。
- `owners/admins/roles` 额外要求 owner；daemon owner 约束继续应用于管理写。

再执行白名单放行：

- 只有 `safe-scalar` 和 `safe-readonly-object` 可进入用户字段平面。
- get 必须命中 role 的字段 permission。
- set/unset 还必须满足 `allowOverride: true`。
- set 的值必须先通过字段类型解析，再满足 role 的 `allowedModels/allowedValues`。
- readonly object 仅允许 get，不允许 set/unset。
- 当前只支持 scalar 写入，不开放任意 JSON object 写入。

命令 grant 也必须显式：

- `config.get/set/unset` 或 `config.*` 可以授权。
- `category:read`、`category:write-own` 和全局 `*` 不能隐式授予字段 config。
- bare `CommandIntent` 调用 `authorizeCommand()` 时若没有 `ResolvedConfigOp`，直接拒绝。

安全字段目录和 `config-manager.ts::isBehaviorConfigFieldPath` 用途不同，但有一致性测试：
代表性 safe 字段必须同时能被 behavior router 识别，并在 relation scope 路由到 relation schema。

## 8. 执行服务

`src/config/config-operation-service.ts` 统一实现：

- get：process 单层读取，其他 scope 使用带来源的 effective field 读取。
- set：按 `op.route.target` 写入；list 保留 append-union 语义。
- unset：只删除目标层的叶子字段，不修改下层配置。
- 所有路径使用 `op.self/op.peerKey` 构造 selector，不再解析 argv。

menu 的 deny 分支不会调用 spawn；daemon 的 deny 分支不会调用执行服务。relation 写入回归测试会
同时检查 relation 文件发生变化且 agent 文件保持不变。

## 9. 审计

- menu dangerous allow/deny 使用 intent 中的 dangerous 语义；字段 resolver 会显式生成
  `config.read/config.write` intent。
- menu spawn 和 dangerous allow 审计使用 canonical argv。
- daemon 对每个 `agent-tool` config 请求记录 operation、scope、role、decision、reason、
  matched rule 和 canonical argv hash。

## 10. 主要代码变更

| 文件 | 职责 |
|---|---|
| `src/cli/cli-argv.ts` | CLI executable 前缀归一 |
| `src/cli/config-selector.ts` | 共享 selector 严格解析 |
| `src/config/config-field-policy.ts` | 字段安全分类、值解析、role 字段权限映射 |
| `src/config/resolved-config-op.ts` | 唯一字段命令语义核和 canonical argv |
| `src/config/config-operation-service.ts` | 共享 get/set/unset 执行 |
| `src/core/command/cli-intent-parser.ts` | 将 resolved op 适配为 intent |
| `src/core/command/command-permission.ts` | resolved-op 授权与 fail-closed gate |
| `src/core/command/menu-handler.ts` | 当前 relation 注入、授权、canonical spawn |
| `src/ipc.ts` | `config.op` IPC 协议 |
| `src/core/command/command-handler.ts` | daemon session 身份解析、授权、审计和执行 |
| `src/cli/config.ts` | 人类本地执行与托管 Agent IPC 分流 |

## 11. 验收矩阵

- resolver：selector 冲突、缺失 selector、严格 positional、值类型、敏感升级。
- 稳定性：重复解析深相等、canonical argv 再解析深相等。
- 授权：owner/admin/member/visitor、自定义显式 grant、category/global wildcard 拒绝。
- scope：member/visitor 仅当前 relation；agent scope 和其他 peer 拒绝。
- menu：allow 后只 spawn canonical argv；deny 不 spawn；群聊 relation 不与 actor id 混淆。
- managed CLI：IPC 成功、daemon 拒绝透传、daemon 离线 fail-closed、管理子命令拒绝。
- daemon：无效 session、member relation 写、visitor 只读、敏感字段拒绝、跨 relation 拒绝。
- 落盘：合法 member 写入 `relations/<peerKey>/config.json`，agent config 不变。
- 工程验证：TypeScript build、定向测试和全量测试均需通过。

实施验收结果：`npm run build` 通过；`npm test` 通过，共 79 个测试文件、969 项测试。

## 12. 后续项

1. 前端和旧 menu 分支全部迁移后，再评估把“非管理角色仅 relation”推广到所有
   `write-own` operation。
2. 若未来需要抵抗父子进程之间 argv 被篡改，应增加一次性 capability/token 或改为 daemon
   内执行；canonical argv 本身不是安全绑定。
3. 若未来支持 object 写入，必须扩展结构化 value parser、schema 校验和字段级授权，不能回退
   到任意 JSON 字符串写入。

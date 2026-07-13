# 跨会话授权卡片未送达 Owner 问题报告

## 1. 报告摘要

- 发生时间：2026-07-13 00:46:36（Asia/Shanghai）
- 发起会话：`eleanai.agentid.pub`（角色：`admin`）→ `wcguard.agentid.pub`
- 预期行为：当该会话触发真实 `AuthorizationChallenge` 时，`wcguard` 应通过 AUN 跨会话 handoff，将“临时授权申请”卡片发送给 owner `elean.agentid.pub`。
- 实际行为：系统生成了普通单会话“权限请求”卡片，并发回当前对端 `eleanai.agentid.pub`；没有生成或发送跨会话 `handoff.auth.authorization_request`。
- 根因：`PermissionGateway.shouldUseCrossSessionApproval()` 把 `admin` 与 `owner` 一并排除在跨会话审批之外，导致 `admin` 会话错误进入单会话审批分支。
- 结论：本次不是 AUN 传输失败，也不是授权卡片在 handoff 途中丢失，而是发送前的审批路由决策错误。

## 2. 涉及主体

| 主体 | 配置角色 | 本次职责 |
| --- | --- | --- |
| `wcguard.agentid.pub` | 被访问 agent | 产生权限挑战并请求审批 |
| `eleanai.agentid.pub` | `admin` | 原始会话对端、权限请求主体 |
| `elean.agentid.pub` | `owner` | 应接收并处理临时授权申请 |

配置证据：

- `agents/wcguard.agentid.pub/config.json:6`：`owners = ["elean.agentid.pub"]`
- `agents/wcguard.agentid.pub/config.json:184`：`admins = ["eleanai.agentid.pub"]`
- `agents/wcguard.agentid.pub/role-assignments.json:4`：`elean.agentid.pub` 的角色为 `owner`
- `agents/wcguard.agentid.pub/role-assignments.json:12`：`eleanai.agentid.pub` 的角色为 `admin`

## 3. 事件与证据链

### 3.1 真实权限挑战已产生

事件日志记录了真实工具权限请求：

```text
requestId: perm-1783874796504-600cyl
sessionId: meta_20260711_1783752179195
toolName: Bash
input: Test write permission
time: 2026-07-13 00:46:36.504
```

来源：`logs/events-20260713-00.log:38`。

这说明申请具备真实 `AuthorizationChallenge` 前提，问题不在挑战是否产生。

### 3.2 跨会话上下文本可被构造

`src/core/message/response-engine.ts:1445` 会从当前 agent 配置中读取 owners，并选择不同于当前 peer 的 AUN owner：

- 当前 peer：`eleanai.agentid.pub`
- 可选 owner：`elean.agentid.pub`
- AUN adapter：要求支持 interaction
- `crossSessionApproval.ownerAid`：应为 `elean.agentid.pub`

因此，在当前配置下，跨会话审批上下文本应存在，owner 目标也可以解析出来。

### 3.3 权限网关错误跳过跨会话分支

`src/core/permission.ts:426` 当前实现：

```ts
private shouldUseCrossSessionApproval(context?: PermissionRequestContext): boolean {
  if (!context?.crossSessionApproval) return false;
  const role = context.role || 'none';
  if (role === 'owner' || role === 'admin') return false;
  if (context.userId && context.userId === context.crossSessionApproval.ownerAid) return false;
  return true;
}
```

本次 `context.role === "admin"`，因此函数在角色判断处直接返回 `false`。后续 `requestCrossSessionPermission()` 未执行。

这里混淆了两个不同概念：

- 当前会话主体拥有 `admin` 角色；
- 当前会话主体是不是本次 challenge 的审批人。

`admin` 不等于 `approver_policy = agent_owner` 所指定的 owner。只要审批策略要求 owner，admin 自身权限不足时仍应向 owner 申请。

### 3.4 实际发送的是普通单会话卡片

发送结果：

```text
msgId: m-2535a17372b6422b9fae28c3718492b5
target: eleanai.agentid.pub
title: 🔐 权限请求
actions: 允许 / 始终允许 / 拒绝
actionCount: 3
```

证据：

- `data/sessions/aun/wcguard.agentid.pub/eleanai.agentid.pub/messages.jsonl:290`
- `logs/channel-out-20260713-00.log:47`
- `logs/evolclaw-20260713-00.log:139`

这组字段明确对应普通单会话审批，而不是跨会话授权审批。正确的 MVP 跨会话卡片应具有以下特征：

- 目标为 `elean.agentid.pub`
- 标题为“临时授权申请”
- 操作为 `approve_once / deny`
- metadata 中 `source = handoff`
- `handoff.kind = request_to_target`
- `handoff.auth.kind = authorization_request`

### 3.5 Owner 会话中不存在授权请求

在相关 session 日志和运行日志中，没有找到该 requestId 对应的：

- `handoff.auth`
- `authorization_request`
- 发往 `elean.agentid.pub` 的临时授权卡片

同时，当前没有形成 `data/sessions/aun/elean.agentid.pub/...` 对应的 owner 接收日志目录。由此可确认，跨会话授权载荷没有进入发送流程。

### 3.6 接收端丢弃 action_card 是次生表现

`eleanai` 端成功接收并解密了普通卡片，但随后记录：

```text
P2P dropped (type deny): type=action_card from=wcguard
```

来源：`logs/evolclaw-20260713-00.log:140-141`。

`src/channels/aun.ts:652` 的 proactive 模型分发白名单不包含 `action_card`。这符合审批卡片不应作为普通消息注入 codeagent 模型上下文的原则，不是本次根因。

不建议通过把 `action_card` 加入 `PROACTIVE_ALLOW_TYPES` 修复此问题。这样只能让发错对象的卡片进入模型，既不能把审批交给 owner，也会破坏卡片交互与模型消息的职责边界。

## 4. 根因判断

根因位于审批模式选择规则，而非 handoff 序列化、AUN 投递、加密解密或消息日志：

```text
真实 AuthorizationChallenge
  → 已构造 crossSessionApproval(owner = elean)
  → shouldUseCrossSessionApproval(role = admin)
  → 返回 false（错误）
  → 普通单会话 action_card
  → 发回 eleanai（错误目标）
```

错误规则是把“角色级别较高”当作“不需要向 owner 申请”。正确判断应围绕 challenge 的审批策略与审批主体身份，而不是笼统的角色排序。

## 5. 建议修复

### 5.1 最小修复

修改 `src/core/permission.ts:426`，移除 `role === 'admin'` 的提前返回。保留以下边界：

- 没有 `crossSessionApproval` 时，不走跨会话审批；
- 当前主体就是选定 owner 时，不向自身发起跨会话审批；
- owner 会话继续使用现有同会话审批路径，避免自循环。

等价的最小逻辑可表达为：

```ts
if (!context?.crossSessionApproval) return false;
if (context.userId === context.crossSessionApproval.ownerAid) return false;
return true;
```

是否保留 `role === 'owner'` 判断需结合多 owner 语义决定。更稳妥的是以实际 `userId === ownerAid` 为准，避免角色标记与被选中的审批主体不一致。

### 5.2 推荐的抽象修复

后续不应继续扩展 `owner/admin/guest` 硬编码分支。建议让路由决策直接消费真实 challenge 的审批策略，例如：

```text
AuthorizationChallenge.approver_policy
  → 解析允许审批的 identity / principal 集合
  → 判断当前会话主体是否属于该集合
  → 若不属于，选择审批目标与渠道
  → 通过 handoff 发送授权卡片
```

MVP 的 `approver_policy = agent_owner` 可解析为当前 agent 的 owners。这样以后增加委托 agent、多人审批或其他 policy 时，不需要继续修改角色特判。

## 6. 必要回归测试

现有 `tests/unit/cross-session-permission.test.ts:23` 覆盖了 `guest → owner`，但没有覆盖本次暴露的 `admin → owner`。

建议至少增加以下测试：

1. `admin → owner`：必须进入跨会话审批。
2. 发送目标必须是 `owner.agentid.pub`，不能是当前 admin peer。
3. 卡片标题必须为“临时授权申请”。
4. 卡片只能包含 `approve_once` 和 `deny`。
5. `replyContext.metadata.source` 必须为 `handoff`。
6. `handoff.auth.kind` 必须为 `authorization_request`。
7. owner 批准后，原 challenge 只放行一次，并记录 `authorization_decision/result`。
8. 当前 peer 等于选定 owner 时，不发起跨会话请求，避免自发自收。
9. 没有 owner 或 AUN interaction adapter 时，应明确拒绝并返回可诊断错误。

建议的角色路由矩阵：

| 当前主体 | approver policy | 当前主体是选定 approver | 预期路径 |
| --- | --- | --- | --- |
| owner | agent_owner | 是 | 单会话审批 |
| admin | agent_owner | 否 | 跨会话 handoff 至 owner |
| member/guest/none | agent_owner | 否 | 跨会话 handoff 至 owner |
| 任意角色 | 任意 policy | 是 | 不跨会话 |

## 7. 修复验收标准

使用相同会话再次触发 Bash 写权限后，应同时满足：

- `permission:requested` 产生新的 requestId；
- `wcguard → elean` 的 AUN 会话出现“临时授权申请” action_card；
- owner 侧 `messages.jsonl` 存在 `source = handoff` 的授权请求记录；
- `handoff.auth.kind = authorization_request`；
- `wcguard → eleanai` 原会话只收到“已向 owner 申请，等待审批”的状态消息，不收到普通三按钮权限卡片；
- owner 点击批准或拒绝后，原会话产生对应的 `authorization_decision` 与 `authorization_result`；
- 批准形成的一等 grant source 受 TTL、最大次数及绑定范围约束；
- 申请超时、取消或发送失败均能结束 pending 请求并留存状态记录。

## 8. 风险与注意事项

- 不要修改 AUN proactive `action_card` 模型分发白名单来绕过问题。
- 不要把 admin 自动提升为 owner approver；这会改变既有权限边界。
- 不要基于普通文本或模型自行声称构造授权申请，仍须绑定真实 `AuthorizationChallenge`。
- 若存在多个 owners，当前 `owners.find(...)` 选择方式只是“第一个非当前 peer 的 owner”；后续应由 `approver_policy` 明确选择规则，但这不阻塞本次单 owner 修复。
- 修复后需确认普通单会话审批行为未被破坏，特别是 owner 自身触发 challenge 的场景。

## 9. 关联文件

- `src/core/permission.ts`
- `src/core/message/response-engine.ts`
- `src/channels/aun.ts`
- `tests/unit/cross-session-permission.test.ts`
- `docs/cross-session-authorization-approval-design.md`
- `docs/msg-send-cross-session-handoff-append-only-design.md`
- `docs/aun-message-log-msgtype-expansion-design.md`

## 10. 最终结论

本次授权卡片没有跨会话传递成功，是因为 `admin` 被权限网关错误视为无需 owner 审批，导致跨会话 handoff 分支从未启动。主会话应优先修复 `shouldUseCrossSessionApproval()` 的角色判断，并增加 `admin → owner` 回归测试；AUN action_card 接收过滤无需因本问题调整。

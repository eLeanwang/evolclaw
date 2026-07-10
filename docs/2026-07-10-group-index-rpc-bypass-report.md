# 问题报告：evolclaw 绕过 SDK 调用不存在的 group.index RPC

- **报告时间**：2026-07-10 10:27（初稿），2026-07-10 11:00（修订）
- **报告人**：evolai（Claude Code / Owner: 轮子）
- **严重级别**：High（`groupRulesFileGet` 硬编码 forcePull=true、`resolveGroupRules` 因 check 坏被迫 shouldPull=true，两条入口全部走进坏 wrapper；facade 路径在代码里存在但不可达。参见 §3.1）
- **影响范围**：AUN 群聊场景下依赖 `group.index` 强拉的能力（群规则读取 `groupRulesFileGet` 强拉分支、venue 同步 fallback、群规则发布通知的 `group_index_etag` 字段）

> **修订说明**（v2）：初稿有多处不实与遗漏，本版全部更正。原稿把"群公告"列入影响范围（evolclaw 无该调用点，删除）、伪造了 RPC 手册的方法名清单、错报了错误状态映射结果，并遗漏了主路径其实是好的这一关键背景。以下均已修正。

---

## 1. 结论

evolclaw 在自己的 `src/aun/msg/group-index.ts` 里，用 `client.call('group.check_group_index', …)` 和 `client.call('group.get_group_index', …)` 两个方法名直接发起 RPC，绕过了 SDK 已经提供的、语义正确的 **facade 方法** `client.group.checkGroupIndex(...)` / `client.group.getGroupIndex(...)`。

- SDK 层暴露的 `checkGroupIndex` / `getGroupIndex` 是**客户端 facade 方法**，不是可透传的 RPC；它们内部封装了本地 etag / 远端 meta 对比、`group.get_settings` 拉取、`GROUP_INDEX_KEY` 解析与签名验证、缓存命中等一整套流程。
- evolclaw 把它们错当成了 RPC 方法名直接透传给服务端；服务端返回 `method_not_declared`（已有真实日志佐证，见 §2.3）。

---

## 2. 证据

### 2.1 evolclaw 侧（错误实现）

`src/aun/msg/group-index.ts`（当前实现）：

```typescript
import type { AUNClient } from '@agentunion/fastaun';

export async function checkGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.call('group.check_group_index', { group_id: groupId }) as Record<string, unknown>;
}

export async function getGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.call('group.get_group_index', { group_id: groupId }) as Record<string, unknown>;
}
```

`client.call(method, params)` 是低阶 JSON-RPC 通道，`method` 会被原样透传到服务端。

### 2.2 SDK 侧（真实定义）

`@agentunion/fastaun@0.5.3`（`node_modules/@agentunion/fastaun/dist/facades.js:245-310`）：

- `GroupFacade.checkGroupIndex(params)` 是**纯客户端**逻辑，读本地 `getGroupIndexLocalEtag` + 远端 meta 缓存 `getGroupIndexRemoteMeta` 做对比，**根本不发 RPC**。
- `GroupFacade.getGroupIndex(params)` 内部真正调用的是合法 RPC `group.get_settings`（拉 `GROUP_INDEX_KEY`），再本地解析 + `verifyPulledGroupIndex` 签名验证 + `hydrateGroupIndexSettings` 命中缓存 + `markGroupIndexFresh` 写回。
- 类型声明也印证（`facades.d.ts:86-87`）：
  ```ts
  checkGroupIndex(params?: FacadeParams): Promise<RpcResult>;
  getGroupIndex(params?: FacadeParams): Promise<RpcResult>;
  ```

### 2.3 服务端反应（真实日志）

搜过 `/home/evolclaw/logs/evolclaw*.log`，命中 1 条服务端明确回复：

```
[2026-07-10T10:41:44.334] [WARN] [GroupVenueSync] 11716.agentid.pub rules sync failed:
    Service plane unavailable for group.get_group_index: method_not_declared
```

服务端返回 `method_not_declared` 佐证：**这两个 method 不是协议里定义的 RPC**。

### 2.4 手册对照（收窄措辞）

`docs/06-API手册.md` 全文只显式提到 `group.send / group.pull / group.set_settings / group.get_members / group.thought.put / group.thought.get`，以及事件类 `group.changed / group.message_created / group.message_undecryptable`。文中未出现 `group.check_group_index` 或 `group.get_group_index`。（初稿曾伪造了一份手册方法名清单，已删除。）

**SDK 打包文档直接指向 facade 方法**：`node_modules/@agentunion/fastaun/_packed_docs/sdk/06-API手册.md:362-363` 在"index 同步"一栏明确列出三语言 API：

| 语义 | Python | TS/JS | Go |
|---|---|---|---|
| 检查 index 是否不同步 | `client.group.check_group_index({...})` | `client.group.checkGroupIndex({...})` | `client.Group().CheckGroupIndex(ctx, params)` |
| 显式 pull 远端 index | `client.group.get_group_index({...})` | `client.group.getGroupIndex({...})` | `client.Group().GetGroupIndex(ctx, params)` |

并注明 `checkGroupIndex` 是**本地判断，不发网络请求**；`getGroupIndex` 内部调用的是 `group.get_settings(keys=["group.index"])`。文档明确要求走 `client.group.<method>` facade，而不是 `client.call('group.<method>', ...)`。

服务端 fastaun 实现未直接核对，但日志里 server 明确回 `method_not_declared`，与"未定义"结论一致。

---

## 3. 影响面

### 3.1 有一条 facade 路径，但当前入口不走它

代码里存在两处 `client.group.getRules(...)` 的正确 facade 调用，但**当前入口都绕过了它们**，走进坏 wrapper：

- **`src/aun/msg/group.ts:957`** 位于 `resolvePublishedRulesFile(forcePull=false)` 分支——但唯一调用者 `groupRulesFileGet`（`group.ts:825-827`）**硬编码传 `true`**：
  ```typescript
  const resolved = await resolvePublishedRulesFile(client, args.groupId, true);
  ```
  所以 `getRules` 分支从此入口是**死代码**，永远走 `forcePull=true` → 坏 wrapper。

- **`src/eck/group-venue-sync.ts:216`** 位于 `getRulesContent(client, groupId, forcePull=false)` 分支——但上游 `resolveGroupRules`（`group-venue-sync.ts:110-112`）根据 `safeCheckGroupIndex` 结果决定：
  ```typescript
  const check = await safeCheckGroupIndex(client, groupId);
  const shouldPull = check === null || check.needs_update === true || check.local_found !== true;
  const rulesContent = await getRulesContent(client, groupId, shouldPull);
  ```
  `safeCheckGroupIndex` 内部调坏 wrapper，`method_not_declared` 被 catch 后返回 `null`；`check === null` **必然为真**，`shouldPull = true`，进 forcePull 分支 → 坏 wrapper。

**结论**：`getRules` facade 路径在代码里存在，但在当前 wrapper 坏的情况下**任何入口都到不了**。这与初稿"主路径未受影响"的说法**相反**。以下 §3.2 六处调用点全部是活的失败路径。

### 3.2 六个受影响的调用点

| # | 文件 | 行 | 触发条件 |
|---|---|---|---|
| 1 | `src/aun/msg/group.ts` | 946 | `resolvePublishedRulesFile(forcePull=true)` — 用户显式强拉刷新 |
| 2 | `src/aun/msg/group.ts` | 1260 | `currentGroupIndexEtag()` — 发布 rules 后补取通知 etag（`checkGroupIndex`）|
| 3 | `src/aun/msg/group.ts` | 1269 | 同上，`checkGroupIndex` 失败后 fallback 到 `getGroupIndex` |
| 4 | `src/eck/group-venue-sync.ts` | 189 | `safeCheckGroupIndex()` — venue 同步预检 |
| 5 | `src/eck/group-venue-sync.ts` | 197 / 207 | `getGroupIndex()`（本文件 wrapper） — forcePull 分支拉 `rules.content` |
| 6 | `src/eck/group-venue-sync.ts` | 225 | `getRules` 主路径失败时 fallback；当前因 §3.1 控制流不可达，属于潜在失败路径 |

### 3.3 具体后果

**A. `forcePull=true` 场景（群规则强刷）**

`resolvePublishedRulesFile` 抛出 `Service plane unavailable for group.get_group_index: method_not_declared` 后，`rulesFileStatusFromError`（`group.ts:1291-1307`）按正则分类。实测（Node 环境）：

- `missing` 分支 `/(not[_ -]?found|notfound|no such|enoent|missing|不存在|\b404\b|rules not found)/i` **不匹配**（`not_declared` 不含 `not[_ -]?found` 词形）；
- `unreadable` 分支 `/(timeout|temporar|unavailable|econn|network|socket|reset|下载|读取)/i` **匹配 `unavailable`**。

所以当前真实日志路径下，状态归为 **`unreadable`**，用户界面会显示"暂时读不到 / 不可读"，会不停重试无果。

**B. `currentGroupIndexEtag()` 链条自吞 → 通知 etag 缺失**

```
try checkGroupIndex → catch → try getGroupIndex → catch → return undefined
```
两个 try 里都是坏 wrapper，两个 catch 都吞掉后返回 `undefined`。

**下游用途**（`group.ts:1082`）：

```ts
const groupIndexEtag = groupIndexEtagFromUpdate(publish, groupId) ?? await currentGroupIndexEtag(client, groupId);
const notice = await sendGroupRulesUpdatedNotice(client, { groupId, actorAid, metadata, groupIndexEtag });
```

- **写入路径已经在此之前完成**（`client.group.updateRules` 在 `group.ts:1050`）；`updateGroupIndex(expected_index_etag=...)` 的 CAS 由 SDK facade 内部自己处理，**不受 wrapper 影响**。
- `currentGroupIndexEtag()` 只是给 `sendGroupRulesUpdatedNotice` 的 payload 填 `group_index_etag`，用作通知里的一个字段。
- 当 `groupIndexEtagFromUpdate(publish, ...)` 已经能从 publish 结果里取到 etag（正常路径），`currentGroupIndexEtag` 甚至根本不会被调到（`??` 短路）；只有 publish 结果里没带 etag 时才 fallback，然后返回 `undefined`。

**实际后果**：通知 payload 的 `group_index_etag` 字段缺失（undefined），接收方拿不到 etag 用于本地缓存新鲜度判断，可能触发一次多余的强拉。**不影响写入正确性**，不会覆盖并发写入，也不会阻塞发布。

**C. venue 同步 fallback**

`getRules` 主路径抛错时（`group-venue-sync.ts:223-224`）：

```typescript
} catch (e) {
  logger.debug(`[GroupVenueSync] getRules fallback to getGroupIndex for ${groupId}: ${errorMessage(e)}`);
  const index = await getGroupIndex(client, groupId);
```

fallback 到坏 wrapper，再抛。当前实际日志显示 `[WARN] [GroupVenueSync] ... rules sync failed`，说明这条 fallback 链完整走过。

### 3.4 日志频次（当前生产环境）

grep `/home/evolclaw/logs/evolclaw*.log`（覆盖 2026-07-09 至今）：

- `method_not_declared` × `group.get_group_index`：1 条（10:41:44）
- `method_not_declared` × `group.get`：1 条（无关，不同 bug）
- `[GroupVenueSync] checkGroupIndex ignored`：0 条（debug 级别，默认可能被过滤）
- `[GroupVenueSync] getRules fallback to getGroupIndex`：0 条

**日志频次低是符合预期的**——更可能是 AUN 群规则同步触发少、debug 日志默认过滤、或相关入口使用频率低；不是因为 `getRules` 主路径稳定工作。1 条真实生产命中已足够定性。

---

## 4. 根因

代码作者把 SDK 文档里"请调用 `checkGroupIndex` / `getGroupIndex` 这两个 SDK 方法"读成了"这两个方法名是可以直接透传的 RPC method"，于是用低阶 `client.call('group.check_group_index', …)` 直接发出去，绕过了 facade 内部的：

1. 本地 etag 缓存 + 远端 meta 缓存对比（`isGroupIndexStale` / `getGroupIndexRemoteMeta` / `getGroupIndexLocalEtag`）；
2. 拉 `GROUP_INDEX_KEY` 后的 **签名验证**（`verifyPulledGroupIndex`）；
3. `hydrateGroupIndexSettings` 命中缓存路径；
4. 拉到新 etag 后 `markGroupIndexFresh` 的写回。

绕过之后：本地看似"有一个函数"，实际每次都发不存在的 RPC，服务端回 `method_not_declared`；缓存不会更新，验签不会执行，功能**从未按设计工作**。

---

## 5. 修复方案

### 5.1 最小修复：把 wrapper 改成走 facade

`src/aun/msg/group-index.ts`：

```typescript
import type { AUNClient } from '@agentunion/fastaun';

export async function checkGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.group.checkGroupIndex({ group_id: groupId }) as unknown as Record<string, unknown>;
}

export async function getGroupIndex(client: AUNClient, groupId: string): Promise<Record<string, unknown>> {
  return await client.group.getGroupIndex({ group_id: groupId }) as unknown as Record<string, unknown>;
}
```

- 六个调用点保持不变。
- facade 会自动做缓存/验签/RPC 分派。

### 5.2 语义对齐检查

修完后需复核三处对 facade 返回结构的假设：

1. `group.ts:1260` 期望 `check` 返回带 `remote_etag / local_etag / etag` 字段 —— facade 返回 `local_etag / remote_etag`（无裸 `etag`），前两者**匹配**，遍历时 `etag` 分支永远不命中，行为不变；
2. `group-venue-sync.ts:196` 期望 `get` 返回 `{ group_aid, meta, settings }` —— facade 返回 `{ group_id, group_aid, group_index, meta, entries, settings }`，需要的字段**存在**；
3. `group.ts:947` 从 `index.settings['rules.content']` 取值 —— facade 通过 `hydrateGroupIndexSettings` 把 keys 化后的结果放进 `settings` 字段，**结构一致**。

### 5.3 验证方法（不是"回归测试建议"）

**修复前 baseline**：日志里 `method_not_declared` × `group.get_group_index` 已有 1 条。

**修复后验证**：
- 触发一次 rules 强刷（`groupRulesFilePull` 或类似入口）；
- 期望日志中不再新增 `method_not_declared` 条目；
- 期望能看到 SDK 内部对 `group.get_settings` 的调用（若开启相应 debug）。

对于 `currentGroupIndexEtag()`：修复后**在远端已有有效 `group.index` 时**应返回非空 etag；远端未初始化 index 或 meta 缺失时仍会返回 `undefined`，这是正常状态。可用一次真实群规则发布来观测：发布后接收方通知里 `group_index_etag` 应为非空。

---

## 6. 建议的后续动作（不在本次修复内）

1. **加运行时校验**：在 `client.call` 上做一层封装，对非白名单 method 名给出 warning；
2. **补一份"SDK facade vs RPC method"对照表**放进 `docs/AUN-INTEGRATION.md`；
3. **给 catch 静默处加日志**：`currentGroupIndexEtag` 的两个 catch 现在直接吞掉错误，建议至少 `logger.debug(...)`（这条 bug 潜伏 3+ 个月未被发现，就是因为静默）；
4. **~~核实 `updateGroupIndex(expected_index_etag=undefined)` 的下游行为~~**（已在 §3.3-B 澄清，不再是待办）

---

## 7. 附录：相关文件

- 错误实现：`src/aun/msg/group-index.ts`
- 调用点：`src/aun/msg/group.ts:946,1260,1269`；`src/eck/group-venue-sync.ts:189,197,207,225`
- 主路径（未受影响）：~~`src/aun/msg/group.ts:957`；`src/eck/group-venue-sync.ts:216`（`client.group.getRules`）~~ — 存在但当前入口不可达（见 §3.1）
- SDK facade：`node_modules/@agentunion/fastaun/dist/facades.js:245-310`
- SDK 版本：`@agentunion/fastaun@0.5.3`
- 真实日志证据：`/home/evolclaw/logs/evolclaw-20260710-10.log:928`
- RPC 手册：`docs/06-API手册.md`（未显式列 `group.check_group_index` / `group.get_group_index`）

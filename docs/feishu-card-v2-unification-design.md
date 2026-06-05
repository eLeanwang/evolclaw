# 飞书交互卡片重设计：统一到 Schema 2.0 内联

**状态**：设计稿（待评审）
**作者**：molian1108 + Claude
**日期**：2026-06-01
**前置约定**：**不考虑飞书客户端 7.20 以下的旧版本**（schema 2.0 的客户端门槛已由产品侧接受）

---

## 1. 背景与动机

飞书交互卡片当前在 `src/channels/feishu.ts`（1993 行）里维护着**三套构建逻辑 + 一个实体管理器**，且 V1/V2 schema 概念从渲染层一路漏到了回调路由、卡片作废、resolved 终态。这带来两类问题：

- **重复**：`buildCommandCardFeishu` 与 `buildActionCard` 近乎雷同；resolved 终态、过期卡、回调路由都写了 1.0/2.0 双分支。
- **脆弱**：按钮 `value` 里塞满 `_card_title`/`_card_body`/`_checkers` 等元数据，回调时逐个 `delete`；`FeishuCardManager` 维护 cardId/sequence/Map/cleanup 的实体生命周期。

### 1.1 关键事实更正（本设计的依据）

调研飞书官方文档后，确认一个此前团队内部的认知误区：

> **`schema` 版本与「投递方式」正交。** `im.message` 发 `msg_type: interactive` 时，content 里可以直接内联一段 **schema 2.0** 卡片 JSON，**无需先创建 `cardkit` 卡片实体**。

由此推出三种真实形态（当前代码只用了前两种，恰恰漏了最优的第三种）：

| 形态 | 投递方式 | API 次数 | 当前用途 |
|---|---|---|---|
| 1.0 内联 | `im.message` | 1 | command-card、普通 action |
| 2.0 实体 | `cardkit.card.create` + `im.message` | **2** | checker / 自定义输入卡 |
| **2.0 内联** | `im.message` | **1** | （未使用） |

`cardkit` 实体路径**仅在「卡片发出后还要用 OpenAPI 增量更新它」时才必须**（流式更新 streaming_mode、局部组件更新）。当前代码引入实体路径的唯一理由是 `_show_input` 用 `cardElement.create` 动态追加输入框——而 commit `18e8fe4` 已把 `_show_input` 改为「整卡作为回调返回值替换」，**`FeishuCardManager.appendElement` 现已是无调用方的死代码**（已核实：`src/` 内除定义外无任何调用）。

**结论**：支撑实体路径存在的理由已被上一轮重构自行消灭。统一到 **schema 2.0 内联** 后，checker/输入卡从 2 次 API 降到 1 次，且可整块删除实体管理器。

### 1.2 官方依据

- [卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure?lang=zh-CN)：`schema` 是卡片 JSON 的全局字段，默认 1.0，声明 `"2.0"` 即启用 2.0 结构。
- [流式更新卡片](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview?lang=zh-CN)：明确卡片实体（`cardkit`）只在流式更新 / 发出后增量更新场景才需要。
- [卡片 JSON 2.0 版本更新说明](https://open.feishu.cn/document/feishu-cards/card-json-v2-breaking-changes-release-notes?lang=zh-CN)：2.0 仅支持共享卡片（`update_multi` 须为 `true`，本项目已满足）；要求客户端 ≥ 7.20。

---

## 2. 设计目标与非目标

### 目标
1. **单一 schema**：所有飞书卡片只产出 schema 2.0，删除全部 1.0 分支。
2. **全程内联**：所有卡片经 `im.message` 发送，删除 `cardkit` 实体路径（`FeishuCardManager`）。
3. **schema 概念不外泄**：回调路由、卡片作废、resolved 终态不再出现 `isV2` / `needsCardKitV2` / `pendingV2Messages`。
4. **元数据服务端化**：按钮 `value` 只携带定位用的最小字段（`id` + 按钮 key），卡片全量元数据存在内存态，回调时反查。
5. **行为不变**：AskUserQuestion（多选 + 自定义输入）、PlanMode/权限确认（command-card）、普通 action 的用户可见行为与现状一致。

### 非目标
- 不改 core 协议层语义（`InteractionRequest`/`InteractionResponse`/`InteractionRouter` 保持稳定）。
- 不动 AUN / WeChat 的卡片降级渲染（`renderActionAsText` 等）。
- 不引入通用表单引擎（YAGNI）——交互类型仍是封闭枚举：按钮选择、多选、自由文本、命令触发。

---

## 3. 现状盘点（重构对象清单）

`src/channels/feishu.ts` 中将被删除或重写的符号：

| 符号 | 行 | 处置 |
|---|---|---|
| `buildCommandCardFeishu()` | 1460 | **合并**进 `buildCardV2()` |
| `buildActionCard()` (V1) | 1511 | **删除** |
| `buildActionCardV2()` | 1570 | **重命名/收敛**为唯一构建器 `buildCardV2()` |
| `buildInteractionCard()` (分流) | 1442 | **简化**为直接调 `buildCardV2()` |
| `needsCardKitV2()` | 1456 | **删除** |
| `buildResolvedCard()` 1.0/2.0 双分支 | 1217 | **砍 1.0 分支**，只留 2.0 |
| `class FeishuCardManager` | 1321 | **整块删除** |
| `appendElement()` (死代码) | 1375 | **删除** |
| `pendingV2Messages` Set | 55 | **删除** |
| `invalidatePendingCards` 的 `expiredCardV1` | 1113 | **删除**，只留 2.0 过期卡 |
| `trackPendingCard(..., isV2)` 的 isV2 参数 | 1087 | **删除参数** |
| 回调路由中 `isV2Card` 判定 | 479 | **删除** |

新增：

| 符号 | 职责 |
|---|---|
| `buildCardV2(interaction, opts?)` | 唯一卡片构建器，输入 `InteractionRequest`，输出 schema 2.0 JSON |
| `CardMetaStore`（轻量 Map） | 暂存 `id → {interaction, messageId}`，回调时反查，取代散落的 `value` 元数据 |
| `buildResolvedV2(interaction, response)` | 唯一 resolved 终态构建器 |

---

## 4. 目标架构

保持已有四层划分，本次只重写 **Layer 2（渲染）+ Layer 3（生命周期）** 的 Feishu 实现，协议层（Layer 1）与响应归一化（Layer 4）基本不动。

```
┌─ Layer 1  交互协议（core，不变）────────────────────────┐
│  InteractionRequest { id, channelId, sessionId, initiator, kind, fallback } │
│  InteractionKind = CommandCard | ActionInteraction                          │
├─ Layer 2  Feishu 渲染（重写）───────────────────────────┤
│  buildCardV2(interaction)        → 唯一构建器，全出 schema 2.0              │
│  buildResolvedV2(interaction,response) → 唯一终态构建器                     │
├─ Layer 3  生命周期（重写，去实体化）─────────────────────┤
│  CardMetaStore: id → {interaction, messageId, chatId, resolved}            │
│  pendingByChat: 仅记录 messageId 用于"新卡到达→作废旧卡"，无 V1/V2 区分    │
├─ Layer 4  响应归一化（core 回调，不变）─────────────────┤
│  飞书 form_submit 回调 → InteractionResponse{id, action, values, operatorId}│
└─────────────────────────────────────────────────────────┘
```

### 4.1 command-card 与 action 的统一

两者在 schema 2.0 下都表达为「标题 + body + 一组按钮（可选 form 容器）」，差异**仅在 outcome 去向**，这是路由层的事：

- **command-card 按钮**：`value` 带 `{ _id, _command }`，回调时直接以 `_command` 触发命令（不进 `interactionCallback`）。
- **action 按钮**：`value` 带 `{ _id, _action }`，回调时进 `interactionCallback` → `InteractionRouter`。

`buildCardV2()` 内部按 `kind.kind` 决定按钮 `value` 字段，但**卡片结构、header、body、按钮渲染完全共用**，消除当前两个雷同函数。

### 4.2 元数据服务端化

**现状（脆弱）**：每个按钮 `value` 塞 `_card_title`/`_card_body`/`_initiator`/`_btn_label`/`_checkers`，回调时逐个 `delete`。`_checkers` 还只存了 label 数组、丢失了 `key`/`description`。

**重设计**：

```ts
// 发送时
const id = interaction.id;
cardMetaStore.set(id, { interaction, chatId, messageId, resolved: false });
// 按钮 value 只留定位字段：
//   command-card: { _id, _command }
//   action:       { _id, _action }   // _action = button.key
```

回调时凭 `value._id` 反查 `cardMetaStore`，拿到原始 `interaction`（含完整 title/body/checkers），用于：
- initiator 校验（`interaction.initiatorId`）
- 构建 resolved 终态（`buildResolvedV2(interaction, response)`）
- checker summary 渲染（用 `interaction.kind.checkers` 的完整 `{key,label,description}`，修复当前只有 label 的信息丢失）

**收益**：按钮 `value` 体积骤减，规避 element_id/value 长度限制（300301 的根因之一）；resolved 重建不再靠客户端回传数据。

### 4.3 "交互期间不能更新卡片"的显式建模（200810）

飞书语义：用户点击交互的**回调处理期间**，服务端无法对该卡片做 `patch`/`append`（即使返回 code=0，客户端也会复原）。唯一可靠方式是**把更新后的整卡作为本次回调的返回值下发**。

本设计将其固化为渲染层的一等返回路径，而非散落的特例：

- `_show_input`（点「手动输入」）→ 返回 `buildCardV2(interaction, { showInput: true })` 整卡
- 按钮提交 / 自定义输入提交 → 返回 `buildResolvedV2(interaction, response)` 整卡

所有"交互期更新"统一走"回调返回整卡"，**不存在任何 `cardElement.create` / `message.patch` 在交互期被调用**。`message.patch` 仅用于 4.4 的「新卡到达作废旧卡」（非交互期）。

### 4.4 卡片作废（非交互期更新，保留）

新卡到达时把同会话旧的 pending 卡 patch 成「已过期」灰卡——这是**非交互期**的合法更新，保留。统一后只剩一种 2.0 过期卡结构，删除 `expiredCardV1` 与 `isV2` 判定。

```ts
// pendingByChat: Map<chatId, Set<messageId>>，不再区分 V1/V2
const expiredCard = {
  schema: '2.0',
  config: { update_multi: true },
  header: { template: 'grey', title: { tag: 'plain_text', content: '已过期' } },
  body: { elements: [{ tag: 'markdown', content: '此卡片已过期，请查看最新卡片。' }] },
};
```

---

## 5. 数据结构

```ts
interface CardMetaEntry {
  interaction: InteractionRequest;  // 全量原始请求，resolved 重建与校验的唯一数据源
  chatId: string;
  messageId: string;
  resolved: boolean;                // 幂等：已 resolved 的卡不再被作废 patch
  inputShown?: boolean;             // _show_input 幂等
}

class CardMetaStore {
  private map = new Map<string, CardMetaEntry>();   // key = interaction.id
  set(id, entry): void
  get(id): CardMetaEntry | undefined
  markResolved(id): void
  markInputShown(id): void
  cleanup(id): void                  // resolved 后延迟清理（保留 TTL 兜底）
}
```

> 注：`CardMetaStore` 看似与被删的 `FeishuCardManager` 相似，但**本质不同**：它只存渲染所需的协议数据（无 cardId / sequence / 无 `cardkit` API 交互），是纯内存索引，不持有任何飞书实体句柄。

---

## 6. 唯一构建器签名

```ts
/**
 * 唯一卡片构建器。输入协议层 InteractionRequest，输出 schema 2.0 内联卡片 JSON。
 * - command-card: 按钮 value 带 { _id, _command }
 * - action:       按钮 value 带 { _id, _action }；checkers → form+checker；
 *                 allowCustomInput → 「手动输入」按钮（form 容器外）
 * @param opts.showInput  展开自定义输入框（用于 _show_input 回调返回整卡）
 */
export function buildCardV2(
  interaction: InteractionRequest,
  opts?: { showInput?: boolean },
): object;

/** 唯一 resolved 终态构建器（按钮禁用 + 结果展示 + checker 勾选汇总）。 */
export function buildResolvedV2(
  interaction: InteractionRequest,
  response: InteractionResponse,
): object;
```

`buildCustomInputElements()` 保留为 `buildCardV2` 的内部 helper（已被测试引用，签名不变）。

---

## 7. 影响面与调用链

**core 协议层**：无破坏性改动。`InteractionRequest`/`InteractionResponse`/`InteractionRouter`/`sendInteractionPayload` 签名不变。建议顺带修正 `ActionInteraction.checkers` 在渲染时的信息丢失（保留 `key`，见 4.2）——纯增益，不改类型。

**调用方**（均不受影响，因 `adapter.sendInteraction` / `onInteraction` 接口不变）：
- `src/core/permission.ts:371` — 权限确认卡
- `src/agents/claude-runner.ts:633,830` — AskUserQuestion / PlanMode
- `src/core/command-handler.ts:444` — 命令卡
- `src/index.ts:644` — `onInteraction` 回调接线

**仅 `src/channels/feishu.ts` 内部**承载本次全部改动。AUN（`src/channels/aun.ts`）有独立的卡片渲染，不在本次范围。

---

## 8. 迁移步骤（TDD）

1. **基线测试**：先跑 `tests/unit/feishu-interaction-card.test.ts`（482 行）确认全绿，作为行为快照。补充缺口用例：command-card 走 2.0、resolved 终态结构、过期卡结构、`_show_input` 返回整卡、initiator 校验。
2. **引入 `buildCardV2` + `CardMetaStore`**，command-card 与 action 共用，全出 2.0。先与旧路径并存、测试驱动。
3. **改 `sendInteraction`**：删除 `needsCardKitV2` 分流，全部走 `im.message` 内联 `buildCardV2`，登记 `CardMetaStore`。
4. **改回调路由**（feishu.ts:370-480）：`value` 只读 `_id` + key，元数据从 `CardMetaStore` 取；删 `isV2Card`。
5. **改 `invalidatePendingCards`**：删 `expiredCardV1` 与 `pendingV2Messages`。
6. **删除** `FeishuCardManager`、`appendElement`、`buildActionCard`(V1)、`buildCommandCardFeishu`、`needsCardKitV2`、`buildResolvedCard` 的 1.0 分支。
7. **回归**：`npm run build` + `npm test` 全绿；手动验证三类卡（权限确认 / AskUserQuestion 多选 / 自定义输入）。

每步独立提交，保证可回滚。

---

## 9. 风险与权衡

| 风险 | 评估 | 缓解 |
|---|---|---|
| 客户端 < 7.20 收到 2.0 卡片只见兜底提示 | **已按前置约定排除**——产品侧接受 7.20 门槛 | 无需处理 |
| 删除实体路径后，未来若需流式更新卡片需重新引入 cardkit | 当前无流式卡片需求；交互卡是「请求-应答」一次性，天然不需要流式 | 真有需求时，流式是独立特性，单独引入实体路径，不影响本设计 |
| `CardMetaStore` 内存泄漏（卡片未被应答也未过期） | 与现状同量级（现 `FeishuCardManager.cards` 也靠 cleanup） | 复用现有 `startCleanupTask` 的 TTL 清理；resolved 后主动 cleanup |
| 回归覆盖不足导致行为漂移 | 中 | 步骤 1 先固化行为快照；每步 TDD |

---

## 10. 预期收益

- **代码量**：卡片相关 ~550 行 → ~320 行（删除 `FeishuCardManager` ~120 行、`buildActionCard` ~50 行、双分支合并 ~60 行）。
- **API 调用**：checker / 自定义输入卡 2 次 → 1 次。
- **维护性**：改卡片样式/终态只改一处；schema 概念不再外泄；按钮 value 瘦身、规避长度限制。
- **正确性**：修复 checker 渲染的 `key`/`description` 信息丢失。

---

## 附录 A：当前血泪错误码与统一后的归属

| 错误码 | 含义 | 当前散落处 | 统一后 |
|---|---|---|---|
| 200830 | 1.0 patch 更新 2.0 卡被拒 | resolved / 过期卡双分支 | **消失**（无 1.0，无混用） |
| 200810 | 交互期更新成功后复原 | `_show_input` 特例注释 | 收敛为「回调返回整卡」一等路径 |
| 300301 | element_id/value 非法或超长 | 按钮 value 塞满元数据 | 缓解（value 瘦身至 `_id`+key） |
| 11310 | form 内按钮须 `action_type=form_submit` | `buildActionCardV2` 注释 | 保留（2.0 form 固有约束，集中在唯一构建器） |

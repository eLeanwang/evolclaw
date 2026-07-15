# 单会话响应模式合并 — 工作报告

**会话时间**: 2026-07-14 ~ 07-15
**执行人**: Claude Code (Opus 4.8)
**用途**: 供后续 review
**范围**: 把旧的 `interactive` / `proactive` 两个响应模式，按新架构合并为单一的
`single-session` 响应模式，并顺带完成配置体系的相关重构（chatMode/mentionMode/model
顶层化、response_modes 块废除、responseMode 标量 + responseModeParams 分桶）。

> ⚠️ **提交状态**：本会话前 8 步已提交（commit `c06a3f1` → `a8f7c84`），步骤 5 之后的
> 工作（response_modes 废除、删旧模式、CLI 修正、死代码清理）**尚未提交**，仍在工作区。
> 工作区同时混有**另一个会话**的改动（config/role/dispatch 系列），提交时需按文件区分。

---

## 一、目标与背景

### 起点问题
旧架构里 `interactive` 和 `proactive` 是两个独立的**响应模式**，但它们的差异本质是
「回复怎么投递」——这是一个**参数**（chatMode），不是模式维度。把它做成两个模式导致：
- 模式 id 与 chatMode 语义耦合（`mode.id` 直接当 chatmode 字符串用）
- 无法正交组合（将来 dual-session 也要 interactive/proactive 就会模式爆炸）

### 目标架构
- **responseMode**（标量）：选哪个模式（single-session / 未来 dual-session / workflow），
  候选与默认来自**注册表**，不来自 schema
- **chatMode**（投递方式）：降为模式的运行时参数，由顶层 `chatmode` 场景表按对端类型解析
- **single-session**：合并 interactive/proactive，投递方式由 chatMode 决定

依据文档：`docs/response-system/architecture.md`、`mode-contract.md`、
`single-session/implementation-plan.md`。

---

## 二、实施步骤（8 步 + 后续）

| 步骤 | 内容 | 状态 | commit |
|------|------|------|--------|
| 0 | 删除孤儿目录 `src/response-modes/`，测试指向活代码 | ✅ 已提交 | c06a3f1 |
| 1 | chatMode 配置化：出厂默认表进 schema，peer-mode 变纯配置消费者 | ✅ 已提交 | bdf8004 |
| 2 | 行为下沉 V1 引擎：interactive-flow / proactive-flow | ✅ 已提交 | b60a297 |
| 3 | single-session 薄包装接入注册表 | ✅ 已提交 | 2930814 |
| 4 | 解耦 mode.id 与 chatMode | ✅ 已提交 | 5242a66 |
| (中途) | chatMode 分层解析：agent 级场景表 + 关系级（后被步骤5覆盖修正） | ✅ 已提交 | a8f7c84 |
| 5 | 废除 response_modes，responseMode 改标量走注册表首选 + responseModeParams 分桶 | ⚠️ 未提交 | — |
| 6 | 回归验证（单测 + 真机集成测试） | ⚠️ 未提交 | — |
| 7 | 删除旧 interactive/proactive 模式代码 | ⚠️ 未提交 | — |
| 8 | 文档回写（config-reference / architecture / dual-session 全套） | ⚠️ 未提交 | — |
| (收尾) | `ec response list` 改读真实注册表 + 死代码清理 | ⚠️ 未提交 | — |

---

## 三、核心设计决策（review 重点）

### 3.1 chatMode 解析：顶层 `chatmode` 场景表字典

- **形态**：`chatmode` 是**顶层字典**（不在 config 内），三键 `{ private, nothuman, group }`
- **取哪个键由对端类型决定**（机械判定，非配置）：
  - 私聊+人 → `private`；私聊+agent → `nothuman`；群聊 → `group`
  - system/service 对端 → 硬约束 `interactive`（不读字典）
- **解析优先级**（高→低）：运行时硬约束 > trigger override > 合并后 chatmode[键] > schema 出厂默认表
- **出厂默认表**：`agent-config.schema` 的 `chatmode.default`（配置数据，非代码硬编码）
  = `{ private: interactive, group: proactive, nothuman: proactive }`
- **两级同名字典**：agent 级和关系级都是 `chatmode` 字典，按 `x-merge: dict` 逐键合并
  （关系级只写的键覆盖 agent 级，其余继承）

> 关键代码：`src/core/message/peer-mode.ts` 的 `resolveChatModeForPeer()`（纯配置消费者）
> + `chatmodeFactoryDefaults()`（从 schema 读出厂默认表）

### 3.2 responseMode：标量，走注册表特殊路线

- **不同于其他参数**：responseMode 的候选清单和默认值来自**注册表**，不来自 schema
- **解析链**（高→低）：关系级 responseMode > agent 级 > 注册表首选（`getPreferred()`）
- **首选** = single-session（`registerBuiltin(mode, preferred=true)`）
- **不分场景**：整个会话链路一个标量。要「某群用 dual-session」通过关系级 responseMode 覆盖
- **坏配置兜底**：配了不存在的模式 id 不抛错，回落注册表首选（避免单个坏配置卡死会话）

> 关键代码：`registry.ts`（getPreferred）、`resolver.ts`（标量解析）、`coordinator.ts`

### 3.3 模式特有参数：responseModeParams 按模式 id 分桶

- **旧结构**：`response_modes.configs[modeId]` + `config` 块 → **已废除**
- **新结构**：顶层 `responseModeParams: { [modeId]: {...} }`，读 `responseModeParams[当前responseMode]` 注入 modeConfig
- **合并语义**：`x-merge: dict`，第一层键（模式 id）合并，同一模式桶**整体覆盖不递归**
  （关系级写 `responseModeParams["dual-session"]` 会整桶替换 agent 级同名桶）

### 3.4 通用参数全部顶层化

| 参数 | 形态 | schema |
|------|------|--------|
| `chatmode` | 顶层字典 | 有 default（出厂表） |
| `mentionMode` | 顶层标量 | enum + default `disabled` |
| `model` | 顶层标量 | 黑箱放行（无 enum/default） |

### 3.5 dispatch → mentionMode 更名（另一会话主导，本会话验证）

- 配置层统一用 `mentionMode`（disabled / mention-only）
- 只在 AUN 协议边界翻译成 dispatch（broadcast / mention）——`src/config/mention-mode.ts`
- **`ec config set dispatch` 报错是正确的**：dispatch 已不是配置字段，应用 `ec config set mentionMode`

---

## 四、代码改动清单（本会话，未提交部分）

### 核心链路
| 文件 | 改动 |
|------|------|
| `src/response-system/registry.ts` | 加 `getPreferred()` / `getPreferredId()` 首选机制 |
| `src/response-system/resolver.ts` | 重写为标量 `resolve(responseModeId)`，删 response_modes 块逻辑 |
| `src/response-system/coordinator.ts` | resolveMode/resolveInbound 改标量 + responseModeParams 注入 |
| `src/response-system/modes/index.ts` | 只注册 single-session（首选）；删 interactive/proactive 注册 |
| `src/response-system/modes/single-session/` | 薄包装 + config-schema（chatMode 二值） |
| `src/response-system/engines/v1/` | interactive-flow / proactive-flow（行为载体）+ index（flowForChatMode） |
| `src/core/message/peer-mode.ts` | resolveChatModeForPeer 纯配置消费者 + 出厂默认表 |
| `src/core/message/response-engine.ts` | effectiveChatMode 去除 mode.id；传标量 responseMode + responseModeParams |
| `src/core/evolagent-registry.ts` | 删死字段 responseModePrivate/Group |
| `src/index.ts` | chatMode defaults provider 去掉 modeIdToChatMode，直接读顶层 chatmode |
| `src/types.ts` | 加顶层 mentionMode/model/responseModeParams；删 ResponseModesConfig |
| `src/config/config-manager.ts` | effective 组装 + 关系级 behaviorFieldNames 加新字段 |
| `src/config/config-field-policy.ts` | 字段路由：删 response_modes/config，加 responseMode/responseModeParams |
| `src/cli/response.ts` | 全部改读真实注册表（list/info/set/config），删 findBuiltinMeta |

### 删除的文件（死代码/旧架构残留）
- `src/response-system/builtin-meta.ts`（旧静态清单，含 9 个虚假/未实现模式）
- `src/response-system/modes/interactive/`、`modes/proactive/`（旧模式类）
- `src/response-system/engines/v1/adapter.ts`、`context.ts`、`engine.ts`（旧插件架构残留，0 引用）
- `tests/unit/response-mode-builtin.test.ts`、`response-mode-proactive-hooks.test.ts`（测已删的类）

### schema
- `agent-config.schema.3.json` / `relation-config.schema.2.json`：
  加 chatmode.default、mentionMode、model、responseMode、responseModeParams；删 response_modes、config

---

## 五、测试

### 单元 + 集成测试（全绿）
- `single-session-mode.test.ts`（委托 flow）
- `v1-flow.test.ts`（interactive/proactive flow 行为，19 处 proactive 断言）
- `response-mode-coordinator.test.ts` / `response-mode-registry-resolver.test.ts`（标量解析 + 首选兜底）
- `response-modes-config.test.ts`（responseMode 标量 + responseModeParams 字典合并）
- `peer-mode.test.ts`（chatMode 分层解析）
- `single-session-resolution.test.ts`（**集成**：真实 ConfigManager 写配置→合并→双解析）

### 真机集成测试（生产 daemon，build + 重启后）
用真实 agent `dddd.agentid.pub`（罗辑）、`toleiliang8.agentid.pub`（墨渊）等收发验证：

| 场景 | 证据 | 结果 |
|------|------|------|
| agent 私聊 → proactive | 日志 `chatmode=proactive` + `message:thought-put` 投影 | ✅ |
| interactive 投递（关系级覆盖） | `chatMode=interactive` + `message:text` 直接出站 | ✅ |
| 关系级 chatmode 逐键覆盖 | nothuman=interactive 覆盖 agent 级 | ✅ |
| 旧 response_modes 兼容 | dddd 带旧块正常工作 | ✅ |
| **坏配置兜底** | dual-session（未注册）→ `source=preferred → single-session` 不报错 | ✅ |
| dispatch=broadcast → mentionMode=disabled | 群消息全响应 | ✅ |
| mention-only 过滤 | 不@ **Group dropped: unmentioned**、@ **dispatched** 严格对照 | ✅ |
| `ec response list/info/set` | 只列 single-session ★首选；未注册模式报 UNKNOWN_MODE | ✅ |

**决定性日志证据**（真实 daemon）：
```
[ResponseSystem] selected mode=single-session source=preferred
    chatType=private peerKey=aun#dddd.agentid.pub chatMode=interactive
```

> 排查教训：日志查询一度失败，根因是**查错文件**——活动日志是无后缀的
> `events.log`/`evolclaw.log`，误查了按小时归档的 `events-YYYYMMDD-HH.log`。
> 不是 daemon 延迟，消息一直实时处理。

---

## 六、遗留事项（后续 review / 处理）

1. **所有步骤5之后的改动未提交**。提交时需与另一会话的改动按文件区分：
   - 我的：`src/response-system/**`、`cli/response.ts`、`peer-mode.ts`、`response-engine.ts`、
     `types.ts`、`config-manager.ts`、`config-field-policy.ts`(response_modes 部分)、`index.ts`、
     `evolagent-registry.ts`、schema(response 部分)、`docs/response-system/**`、相关测试
   - 另一会话的：config/role/dispatch/permission 系列、`builtin-roles.ts`、`command-*.ts`、
     `slash-*.ts`、`menu-handler.ts`、`channel/aun.ts` 等

2. **另一会话的 dispatch 测试失败**（config-manager/menu-exec 的 8 个 dispatch 断言）：
   因 dispatch 字段从 schema 删除（更名 mentionMode），旧断言仍用 `dispatch` 字段名。
   **不是本会话的 bug**，属那个会话的测试收尾。

3. **`engines/v2/types.ts`、`modes/dual-session-lite/`** 的删除**不是本会话所为**
   （git status 显示为工作区未 staged 删除 `' D'`，而本会话的删除都是 `git rm` 的 staged `'D '`）。
   应为另一会话或外部操作，review 时留意。

4. **dual-session 尚未实现**：文档已按新架构回写（config-reference / architecture / dual-session 全套），
   但代码只有 single-session。dual-session/workflow 是未来模式，注册后会自动出现在 `ec response list`。

5. **契约文档待评审**：`mode-contract.md`、`conformance-checklist.md` 是草案状态，
   定义了未来模式的边界契约（会话原型、投递声明、持久化命名空间等），实现 dual-session 前应评审。

---

## 七、架构收益（合并后）

- **正交**：responseMode（选模式）⊥ chatMode（投递）⊥ mentionMode（@处理）三者独立，无组合爆炸
- **单一事实源**：`ec response list` 读真实注册表，不再有静态清单误导
- **坏配置健壮**：未注册 responseMode 自动回落首选，不卡死会话
- **配置分层清晰**：通用参数顶层、模式特有参数按模式分桶、responseMode 走注册表特殊路线
- **无死代码**：旧插件架构残留（V1Engine/adapter/context/builtin-meta）全部清除

---

**报告生成**: 2026-07-15
**维护者**: Claude Code (Opus 4.8)

# ECK 对齐路线图

> 本文是一份**待办路线图**，来源于一次"上下文组装机制 + 按需加载机制 + kits 文档 vs 代码"的全量审计。
> 用法：逐项推进，每项有独立的证据、决策点、建议动作和状态。先解决「第 0 类决策项」（阻塞其余项），
> 再做「第 1 类纯文档对齐」（无歧义），最后处理「第 2 类代码 bug」。

## 文档信息

| 项 | 内容 |
|----|------|
| 创建日期 | 2026-06-01 |
| 状态 | 待审查 → 逐项推进 |
| 事实基线 | `src/agents/kit-renderer.ts`、`src/core/message/message-processor.ts`、`src/eck/init.ts`、`src/config-store.ts`、`kits/` 全目录 |

## 阅读约定

- **置信度**：✅ = 本次已直接读源码核实；⚠️ = 来自审计 agent 报告，**动手前需先核实**（尤其否定性断言"代码没有 X"）。
- **状态**：`待决策` / `待办` / `进行中` / `完成`。
- 凡标 ⚠️ 的项，第一步动作即"读对应源码确认"，确认后再改。

---

## 第 0 类：需要先拍板的决策（阻塞后续）

这些项无法在不知道"目标形态"的情况下动手——文档里写的可能是 roadmap 设计、也可能是该砍的设想。需 owner 定夺。

### D1. 关系层目录的目标形态 ⚠️ `待决策`

**现状三方不一致**：
- `04-relation.md` 描述：扁平结构 `relations/<channel>#<urlEncode(peerId)>/{profile.md, history.jsonl}` + `_index/name_*.json` + `_trash`。
- skeleton 实际建（`config-store.ts:602-606`）：`relations/contacts`、`relations/_observed`、`relations/_observed/_index`、`relations/_index`、`relations/_trash`。
- 运行时实际写（⚠️ agent 报告 `peer-identity.ts:57`）：直接写 `relations/<peerKey>/peer-identity.json`，既不进 `contacts/_observed`，也不是文档说的 `profile.md`。

**决策**：以哪个为目标？`profile.md`/`history.jsonl`/`name_*.json` 是规划中还是已废弃？`contacts/`、`_observed/` 保留还是删？

### D2. 环境层目录的目标形态 ⚠️ `待决策`

- `05-venue.md` 描述：`venues/<channel>#<urlEncode(venueId)>/{profile.md, history.jsonl}` + `_trash`。
- skeleton 实际建（`config-store.ts:607-609`）：`venues`、`venues/_index`、`venues/_trash`（文档没提 `_index`）。
- venue 层 `profile.md` / `history.jsonl`：⚠️ agent 报告无读写代码。

**决策**：`_index` 是否纳入文档？`profile.md`/`history.jsonl` 是规划中还是砍掉？

### D3. 身份层数据文件哪些保留 ⚠️ `待决策`

`03-identity.md` 列了 9 个文件，实际只有 2 个有代码读取：
- ✅ 已实现：`persona.md`、`memory/working.md`（⚠️ agent 报告读取点 `evolagent.ts:269,282`）。
- ⚠️ 无读写代码（agent 报告）：`memory/episodic.jsonl`、`memory/semantic.md`、`style.md`、`preferences.json`、`goals.md`、`journal.jsonl`；`skills/` 仅建目录。

**决策**：未落地的 7 项——哪些是 roadmap（标"规划中"保留），哪些直接从文档删？

### D4. 外部依赖路径命名统一 ⚠️ `待决策`

两份文档对"外部依赖路径"描述**互相矛盾**，且 ⚠️ 两套名字在 `src/` 都搜不到（agent 报告零实现）：
- `02-navigation.md:48-49`：`$AUN_SDK`（`npm list -g @agentunion/fastaun --parseable`）+ `$AUN_PROTOCOL_DOCS` = `$AUN_SDK/docs/protocol`。
- `path-registry.md:38-39`：`$KITE`（config.json 的 `kitePath`）+ `$AUN_SDK_CORE` = `$KITE/aun-sdk-core`。

**决策**：统一成哪一套命名？给出**真实的寻找规则**（SDK 包真实安装位置、协议文档真实路径）。
> ⚠️ **连带**：上一轮我在 `rpc.md`、`01-overview.md` 引用了 `$AUN_PROTOCOL_DOCS`——目前无定义、无实现，是悬空引用。D4 定了之后要回填这两处（见 X1）。

### D5. eck_templates 修复方向 `待决策`

见第 2 类 C1。两个方向二选一：① 在 `init.ts` 把缺的变量按 `paths.ts` 真值补全；② 把模板里未实现的字段删成静态说明。**倾向 ①**（这些路径 paths.ts 都能算出来），请确认。

---

## 第 1 类：纯文档对齐（无歧义，可直接改）

决策无关，证据清楚，可直接动手。

### T1. `$SELF_DIR` → `$PERSONAL_DIR` ✅ `待办`

manifest 实际只认 `$PERSONAL_DIR`（`kit-renderer.ts:109` 注入此别名；`eck_manifest.json` 用 `$PERSONAL_DIR/persona.md`）。文档里的 `$SELF_DIR` 在 manifest 中**根本解析不出来**。
- 落点：`02-navigation.md`、`03-identity.md`、`path-registry.md`（以及 `path-registry.template.md` 第 23 行 `$SELF_DIR`）。
- 动作：全局替换 `$SELF_DIR` → `$PERSONAL_DIR`。

### T2. `path-registry.md` 补 `$KITS_FRAGMENTS` ✅ `待办`

`02-navigation.md:21` 和 `kit-renderer.ts:101` 都有 `$KITS_FRAGMENTS = $KITS_TEMPLATES/system-fragments`，但 `path-registry.md` 漏了。补一行。

### T3. `channels/aun.md` 连接状态命令语义 ✅ `待办`

文档："连接状态可通过 `ec ctl aid` 查看"。实测：`ctl /aid` 命令**存在**（`command-handler.ts:3928-3952` 转发到 `ec aid`）但它是身份/证书管理（list/show/lookup/agentmd），**不显示实时连接状态**。
- 动作：实时连接状态改用 `ec watch aid` 或 `ec status`（`index.ts:4795,4916`）。

### T4. 给未实现项加"规划中"标注 `待办`（依赖 D1/D2/D3）

D1/D2/D3 决策后，对"保留为 roadmap"的数据文件，在 03/04/05 文档里统一加"（规划中，未落地）"标注；决定砍的直接删。

---

## 第 2 类：代码 bug（需改 src/，超出 kits 文档范围）

### C1. eck_templates seed 与模板严重脱节 ✅ `待办`（方向见 D5）

**最实质的代码问题**：`renderTemplate`（`init.ts:82-88`）只替换传入的 key，未传的 `{{}}` 原样留成字面量。
- `initEckPathRegistry`（`init.ts:63-66`）只传 `EVOLCLAW_HOME`+`PACKAGE_ROOT`，但 `path-registry.template.md` 有 **15 个**占位符（`{{CURRENT_PROJECT}}` `{{KITS}}` `{{KITS_RULES}}` `{{KITS_DOCS}}` `{{KITS_TEMPLATES}}` `{{ECK}}` `{{AGENT_DIR}}` `{{SELF_DIR}}` `{{RELATIONS_DIR}}` `{{VENUES_DIR}}` `{{AGENT_INDEX}}` `{{KITE}}` `{{KITE_STATUS}}` `{{AUN_SDK_CORE}}` `{{AUN_SDK_STATUS}}`）。→ 生成的 `$ECK/path-registry.md` 几乎全是未替换字面量，作为"路径实例文件"失效。✅ 直接核实。
- `initEckRuntime`（`init.ts:47-50`）同样只传两个变量；`runtime.template.md` ⚠️ agent 报告有 9 个未替换字段（动手前读模板确认）。
- 动作：按 D5 选定方向修 `init.ts` 或模板。注意 `{{SELF_DIR}}` 若保留要与 T1 统一口径。

### C2. `initAgentIndex` 变量 key 不匹配 ⚠️ `待办`

`init.ts:26,34` 传 `{ AID: aid }`，但 ⚠️ agent 报告 `INDEX.template.md`/`GUIDE.template.md` 用的是 `{{SELF_AID}}` → 永不替换。
- 第一步：读这两个模板确认占位符到底是 `{{AID}}` 还是 `{{SELF_AID}}`。
- 动作：统一 key（改模板或改 `init.ts` 传参）。

### C3.（可选）`peerRole` fallback 不一致 ✅ `完成`

✅ 已核实并修复：`message-processor.ts:653` 的 `peerRole` 兜底原为 `'unknown'`，而同文件 `:258`/`:977` 及 `04-relation.md` 四级权限表、`relation.md` fragment 的取值注释（`owner|admin|guest|anonymous`）均为 `anonymous`。`'unknown'` 不在合法 role 取值集内，确认为手滑而非语义区分。已改为 `'anonymous'`，三处一致；`tsc --noEmit` 通过。

---

## 第 3 类：机制增强（可选，低优先）

### M1. 显式声明的 section 解析失败应 warn `待办`

现状：section `when` 通过后，若路径 `$NAME`/`{{key}}` 解析为空或文件不存在，**静默丢弃**，仅落 `eck-debug/manifest-*.md`。一个拼错的 `$VAR` 或漏建文件不会报错，只会悄悄少一段上下文。
- 建议：对"manifest 显式声明、却解析失败"的段输出 warn（区别于 `when=false` 的正常落选）。

### M2. agent 级按需索引接通 `待办`（关联 C2）

`02-navigation.md` 描述了 `$AGENT_INDEX`（agent 可写的按需索引），但它既不是注入的 manifest 变量，对应的 `INDEX.template.md` 生成又坏（C2）。目前"agent 级按需加载索引"是空架子。
- 决策：补全接通，还是从文档降级表述？

### M3. 按需文档引用完整性 `待办`

rules 里用 `$KITS_DOCS/xxx.md` 指向按需文档，但无机制保证目标存在，靠人工维护 INDEX.md。规模小可接受，记录待观察。

---

## 第 4 类：TODO 桩填充（跟踪，非错误）

均带"待补充/TODO"标记，内容未填，但无错误断言（除已在上文单列的）：
- `identity/identity-tools.md`（⚠️ 命令是桩，`identity.*`/`venue.*` IPC 据报告无实现）
- `identity/AID_PROFILE_SPEC.md`、`identity/PATH_OPS.md`、`identity/ROLE_DETAIL.md`
- `aun/CHEATSHEET.md`
- `channels/feishu.md`（⚠️ 另有配置格式过时问题：展示旧全局平铺，实际 per-agent 数组，`index.ts:806`）
- `venues/` 下全部 8 个文件

---

## 我上一轮引入的悬空引用（认领）

### X1. `$AUN_PROTOCOL_DOCS` 悬空 ⚠️ `待办`（依赖 D4）

上一轮写 `rpc.md`、改 `01-overview.md` 时引用了 `$AUN_PROTOCOL_DOCS`，该路径当前无定义、无实现。D4 统一命名后回填这两处。

---

## 推进顺序建议

1. **先决策**：D1–D5（尤其 D1/D2/D3 的目标形态、D4 的命名）。
2. **无脑改**：T1、T2、T3（不依赖决策）。
3. **依赖决策的文档**：T4、X1（D 定了之后）。
4. **改代码**：C1（按 D5）、C2、(C3)。
5. **机制增强**：M1–M3（可单独排期）。

## 进度

- [ ] D1 关系层目标形态
- [ ] D2 环境层目标形态
- [ ] D3 身份层文件取舍
- [ ] D4 外部依赖命名统一
- [ ] D5 eck_templates 修复方向
- [ ] T1 `$SELF_DIR`→`$PERSONAL_DIR`
- [ ] T2 补 `$KITS_FRAGMENTS`
- [ ] T3 aun.md 连接状态命令
- [ ] T4 未实现项标注
- [ ] C1 eck_templates seed
- [ ] C2 initAgentIndex key
- [x] C3 peerRole fallback
- [ ] M1 解析失败 warn
- [ ] M2 agent 索引接通
- [ ] M3 引用完整性
- [ ] X1 `$AUN_PROTOCOL_DOCS` 回填

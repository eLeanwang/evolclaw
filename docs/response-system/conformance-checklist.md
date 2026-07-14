# 响应模式完备性验收清单（Conformance Checklist）

**版本**: 1.0（草案）
**创建时间**: 2026-07-14
**状态**: 待评审
**定位**: 判定一个响应模式是否**完备**的验收标准。依据
[mode-contract.md](./mode-contract.md)（契约 SSOT）展开为可判定条目。

**完备 = 三道门全过**：

| 门 | 载体 | 覆盖条目 |
|----|------|---------|
| 1. 注册校验 | `validateModeDescriptor()`，注册时执行，不过则拒绝注册 | S 类 |
| 2. conformance 测试 | `test/response-system/conformance/`，参数化套件，传模式名即跑 | R / C / B 类【测试】项 |
| 3. 人工评审 | PR 模板勾选项 | D 类及标注【评审】的条目 |

检验方式标注：【自动】= 注册时/CI 机器校验；【测试】= conformance 套件；【评审】= 人工。

---

## S 类：静态声明（注册时自动校验）

| # | 标准 | 检验 | 契约依据 |
|---|------|------|---------|
| S1 | 目录符合规范：`modes/<name>/index.ts` 导出 descriptor；`config-schema.json` 存在且为合法 JSON Schema | 【自动】 | §2.1 |
| S2 | descriptor 必填字段齐全：name / displayName / description / factory / configSchema / supportedCommonParams / specificParams / sessionPrototypes | 【自动】 | §2.2 |
| S3 | `specificParams` 与 configSchema 的 properties 一致：schema 里没有的参数不许声明，声明了的必须有 schema 定义 | 【自动】 | §4.1 |
| S4 | `sessionPrototypes` 声明的每个 manifest 文件真实存在，且通过 manifest schema 校验 | 【自动】 | §2.3 |
| S5 | `eckVars` 全部带 `<name>.` 前缀（或属系统保留变量清单）；运行时注入未声明变量则断言失败 | 【自动】+ 运行时断言 | §2.4 |
| S6 | manifest sections 的 `order` 全部落在 descriptor 声明的 `orderRange` 内，且区间与已注册模式不冲突 | 【自动】 | §2.4 |
| S7 | 提示词模板存在于 `kits/docs/response-system/<name>/prompts/`；模板引用的注入变量都在系统保留变量或本模式 eckVars 内 | 【自动】 | §2.4 |

## R 类：运行时接口

| # | 标准 | 检验 | 契约依据 |
|---|------|------|---------|
| R1 | 实现 `ResponseModeImpl` 全部方法：onMessage / init / drain / dispose / getStatus | 【自动】类型 + 运行时探测 | §3.1 |
| R2 | `onMessage` 同步返回、不抛出：畸形消息、超长内容、未知渠道字段、`anonymous` 角色等异常输入都能被收下，错误在内部消化 | 【测试】异常消息集 | §3.1 |
| R3 | 生命周期幂等：重复 init 不重复建会话；dispose 后 onMessage 被拒绝而非崩溃；drain 超时后可强制 dispose | 【测试】 | §3.1 |
| R4 | **重启恢复**：处理中 kill 进程 → 重启 → init 后，盘上未定案消息不丢、已回复消息不重复回复 | 【测试】⭐ 最重要的运行时标准 | §3.1 / §5.2 |
| R5 | `getStatus()` 返回合法 ModeStatus；busy 时 pendingCount > 0；dispose 后不再变化 | 【测试】 | §3.1 |
| R6 | 无泄漏：dispose 后无残留定时器、无未关闭会话 | 【测试】 | §3.1 |
| R7 | 出站零自实现：`delivery:'reply'` 会话的全部出站经宿主投影器（interactive 聚合出站 / proactive thought 投影均为宿主行为）；`delivery:'silent'` 会话无任何出站；模式不自行拼装出站消息；`replyTo` 如实（每条被回复的消息出现在某个 turn 的 replyTo 中）；interactive 与 proactive 下模式行为路径一致（无 chatMode 分支） | 【测试】+【评审】 | §2.3 / §3.2 |

## C 类：配置契约

| # | 标准 | 检验 | 契约依据 |
|---|------|------|---------|
| C1 | 全部特有参数有默认值；空 config（仅必填通用参数）能正常启动 | 【自动】schema +【测试】 | §4.1 |
| C2 | 非法配置在 factory 阶段报错拒绝（fail fast），不运行中途才炸 | 【测试】非法配置集 | §4.1 |
| C3 | 模式代码零处自行读取配置文件，只消费注入的合并结果 | 【评审】/ lint | §4.1 |
| C4 | **通用参数行为承诺**逐条通过：声明支持的每个通用参数值跑对应标准行为测试（同一套测试所有模式复用）。当前套件至少含：<br>· `mention-only`：未 @ 消息不触发回复且不丢弃<br>· `mention-only`：被 @ 消息得到回复<br>· `disabled`：普通消息参与处理<br>· `model`：主处理会话实际使用指定模型 | 【测试】共享套件 | §4.2 |

## B 类：资源边界

| # | 标准 | 检验 | 契约依据 |
|---|------|------|---------|
| B1 | 会话全部经 `ctx.sessions.create(<已声明原型>)` 创建；不 import base agent SDK / 渠道 SDK | 【评审】/ lint 禁 import | §3.2 / §5.4 |
| B2 | 持久化只落 `ctx.storage`（即 `_modes/<name>/`）之内：跑完整场景后扫描文件系统，无越界写入 | 【测试】 | §5.2 |
| B3 | 不 import 其他模式代码；对宿主依赖仅限 ModeContext 与系统级 types | 【自动】依赖分析 | §5.4 |
| B4 | 不硬编码渠道命令字符串；已发送消息经 `TurnResult.sentMessages` 获取，不自行解析工具调用历史 | 【评审】/ grep 规则 | §3.2 / §5.4 |

## D 类：文档完备（人工评审）

| # | 标准 |
|---|------|
| D1 | `docs/response-system/<name>/` 有 README（定位/适用场景）+ 参数说明；参数表与 config-schema.json 一致（可脚本比对） |
| D2 | `getStatus().detail` 的字段有说明文档（外部不解释它，但运维要能看懂） |
| D3 | 声明降级行为：模式依赖的模型/服务不可用时的表现（参照 dual-session"辅助会话失败 → delay 降级"范本） |

---

## 落地顺序

标准第一版**不求全**，按防线价值排序：

1. **先立**（随 Phase 1 注册表一起做）：S 类全部（`validateModeDescriptor()`，约一天）+ R4（重启恢复）+ C4（通用参数行为套件）——这三块是防线的地基；
2. **随第一个模式落地**：R1–R3、R5–R7、C1–C2、B2；
3. **随第二个模式接入时再补**：B1/B3/B4 的 lint/依赖分析规则——那时才真正出现"越界"的诱惑，规则也才有真实案例可校准。

清单自身可迭代（加一条 = 加一个测试），迭代成本天然局部，不牵动模式实现。

## 存量对照：dual-session 首检预期

dual-session 是第一个受检对象。按当前设计文档预检，已知需要补齐的缺口
（与 mode-contract.md 的调整项一致）：

- [ ] `sessionType` → 系统级 `sessionPrototype`（S5，契约 §2.4）
- [ ] `sessionManifests` 用户配置 → descriptor 的 `sessionPrototypes` 声明，并补 `delivery` 声明：main=`reply`、auxiliary=`silent`（S4/R7，契约 §2.3）
- [ ] 持久化路径 `_threads/<threadId>/_queues/` → `_threads/<threadId>/_modes/dual-session/`（B2，契约 §5.2）
- [ ] `MainFeedback.replies` 自行提取 `ec group send` → 消费 `TurnResult.sentMessages`（B4，契约 §3.2）
- [ ] drain / dispose 语义在设计文档中补写（R3/R6）
- [ ] manifest section order 迁入分配区间（S6）

---

**文档维护者**: Claude Code
**最后更新**: 2026-07-14
**状态**: 草案，待评审

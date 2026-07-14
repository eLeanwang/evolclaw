# single-session 合并实施计划

**版本**: 1.0（草案）
**创建时间**: 2026-07-14
**状态**: 待评审
**阶段目标**: 把现有 `interactive` / `proactive` 两个响应模式**按新架构**合并为
`single-session` 单会话响应模式（architecture.md §4.1），可用为准。

---

## 一、范围边界

**做**：

- 模式合并：两个模式类的行为下沉到 V1 引擎，`single-session` 以薄包装接入
- chatMode 参数化：从"mode.id 兼任 chatmode"解耦，改为**纯配置解析**（无 `auto` 值）
- 目录对齐 architecture.md §2.1 的设计规范
- 配置迁移：旧模式 id 自动迁移（migration-guide.md §2.1）

**不做**（留给"宿主基础设施适配契约"阶段）：

- 不改 IMRenderer / 出站投影机制（mode-contract.md §3.2 的投影器接口化）
- 不实现 ModeContext / sessionPrototypes / `_modes/<name>/` 持久化命名空间
- 不动 `modes/dual-session-lite/` stub
- 不做 conformance 测试套件（但新代码不背离契约方向）

---

## 二、目标目录结构（依 architecture.md §2.1）

```
src/response-system/
├── registry.ts / selector.ts / resolver.ts / coordinator.ts / types.ts / index.ts   # 已存在
│
├── engines/
│   └── v1/                        # V1 引擎：单会话处理行为的真正载体
│       ├── engine.ts              # 现有空壳扩展：承载合并后的行为，按 chatMode 分流
│       ├── interactive-flow.ts    # 原 InteractiveMode 行为（afterProcess 文件标记）
│       ├── proactive-flow.ts      # 原 ProactiveMode 行为（per-message state + 全部钩子）
│       ├── types.ts
│       └── README.md
│
└── modes/
    └── single-session/            # 薄包装（仅两个文件，行为零实现）
        ├── index.ts               # id='single-session'，applicableScenes=['private','group']
        │                          # 钩子全部委托 V1 引擎
        └── config-schema.json     # { chatMode: 'interactive' | 'proactive' }
```

> 引擎内部文件划分（interactive-flow / proactive-flow）属引擎内部事务，
> 设计文档的 engines/v1 三文件是骨架非上限。
> `modes/interactive/`、`modes/proactive/` 在切换验证通过后删除（步骤 7）。

---

## 三、chatMode 解析设计（本计划的核心决策）

**原则**：chatMode 只有 `interactive` | `proactive` 两个值（**无 auto**）。
"human 私聊→interactive、agent 私聊→proactive、群聊→proactive"不是代码逻辑，
是**配置的出厂默认值**——agent 级可改默认，关系级可对具体对端指定。

**每会话生效值的解析层级**（高→低）：

| 层 | 内容 | 载体 |
|----|------|------|
| 0. 运行时硬约束 | system/service 对端 → interactive；trigger 元数据 chatModeOverride | 代码（非配置，同现状） |
| 1. 关系级 | `config.chatMode`（对该对端/群显式指定） | `$RELATIONS_DIR/<peerKey>/config.json` |
| 2. agent 级场景默认表 | `chatmode: { private, nothuman, group }`（沿用现有配置键） | `$AGENT_DIR/config.json` |
| 3. 出厂默认表 | `{ private: 'interactive', nothuman: 'proactive', group: 'proactive' }` | config schema 的 defaults **数据** |

- 场景键由 `chatType + peerType` 机械判定（private=人类私聊 / nothuman=agent 私聊 / group=群），
  判定是分类逻辑，**值全部来自配置**；
- 层 2/3 是同一参数的层级合并，由 ConfigManager 完成，出厂默认进 schema，
  `peer-mode.ts` 的 `resolveChatModeForPeer` 从"内置分支"降格为"配置消费者"；
- 层级合并保证 chatMode **必定解析出一个确定值**，模式收到的永远是二值之一。

**需回写 config-reference.md**：chatMode 的"必选"语义改为"必定可解析"（用户不必显式填写，
出厂默认表兜底）；补上解析层级表；明确无 `auto` 值。

---

## 四、mode.id 与 chatmode 解耦（response-engine 手术）

现状（`response-engine.ts:1105-1109`）：

```
effectiveChatMode = system/service 约束 ?? trigger 覆盖 ?? resolvedMode?.mode.id ?? chatModeFallback
                                                          ^^^^^^^^^^^^^^^^^^^^ 模式 id 兼任 chatmode
```

目标：

```
responseMode 解析（选哪个模式）  = resolver（关系级 override > agent 级 > 兜底 single-session）
chatMode 解析（怎么投递）        = §三 的配置层级（与模式解析完全无关）
effectiveChatMode = system/service 约束 ?? trigger 覆盖 ?? 配置解析结果
```

- resolver 的 `FALLBACK_PRIVATE` / `FALLBACK_GROUP` 双双改为 `'single-session'`；
- 解析出的 chatMode 注入模式 config（`resolvedMode.config.chatMode`），
  引擎按它分流 interactive-flow / proactive-flow；
- 下游（IMRenderer / ReplyContext / 统计 / 日志）继续消费 `chatmode` 字符串，
  其**取值来源**变化、类型与语义不变，下游零改动。

---

## 五、实施步骤

每步独立提交、可单独回退（git revert）、有验证动作。

### 步骤 0：清理孤儿目录

- 依赖分析确认 `src/response-modes/`（旧副本）全项目无引用 → 整目录删除
- 验证：`tsc` 通过 + 全局 grep 无 `from '.*response-modes` 残留

### 步骤 1：chatMode 配置化（先改解析，不动模式）

- config schema 注册：agent 级 `chatmode` 场景默认表（现有键，补出厂默认值数据）、
  关系级 `config.chatMode`
- `resolveChatModeForPeer` 改为纯配置消费（出厂默认从 schema 来，删除代码内字面量）
- 验证：**行为等价**——改动前后同一组场景（human 私聊 / agent 私聊 / 群聊 /
  system 对端）解析结果一致；`ec config` 能查改默认表并生效

### 步骤 2：行为下沉 V1 引擎

- `engines/v1/engine.ts` 从空壳扩展为行为载体：搬运 InteractiveMode 的
  afterProcess（文件标记）→ `interactive-flow.ts`；ProactiveMode 的
  state + 钩子（首发检查、工具播报、policyHook 等）→ `proactive-flow.ts`
- 引擎按传入的 chatMode 参数分流两个 flow
- 旧模式类**不动**（此步只新增，不切换）
- 验证：引擎单元级验证两个 flow 与原类行为一致（钩子输入输出比对）

### 步骤 3：single-session 薄包装

- `modes/single-session/index.ts`：注册信息 + 全部钩子委托 V1 引擎
- `config-schema.json`：`chatMode` enum 二值
- 注册进 `registerBuiltinModes`（此时三模式并存，默认仍指旧模式，行为不变）
- 验证：`ec response` 能列出 single-session；对单个测试对端用关系级
  override 指到 single-session，收发正常

### 步骤 4：解耦切换（核心步）

- response-engine.ts §四 的手术：effectiveChatMode 改配置解析，mode.id 退出合成
- resolver 兜底改 `single-session`
- coordinator 相应调整（chatModeFallback 传参路径简化）
- 验证：回归矩阵（§六）全绿

### 步骤 5：配置迁移 + 用户界面

- 迁移函数（migration-guide.md §2.1）：`response_modes` 中
  `default_private/default_group/overrides` 里的 `interactive`/`proactive` id
  → `single-session`，原 id 语义转为对应作用域的 chatMode 配置
- `builtin-meta.ts` / `ec response` 文案与清单更新（展示 single-session + chatMode 参数）
- 验证：带旧配置的 agent 启动后自动迁移正确；`ec response current` 显示新模式与来源

### 步骤 6：回归验证（矩阵见 §六）

### 步骤 7：删除旧模式

- 删 `modes/interactive/`、`modes/proactive/` 及注册行；再跑一遍 §六
- 验证：全局 grep 无 `InteractiveMode|ProactiveMode` 残留引用

### 步骤 8：文档回写

- config-reference.md：chatMode 解析层级（§三）、无 auto、"必定可解析"语义
- architecture.md §4.1：如实现细节有出入则对齐
- 实施日志

---

## 六、回归验证矩阵

| # | 场景 | 期望 |
|---|------|------|
| 1 | coding（无渠道） | single-session + interactive，输出即回复 |
| 2 | 单聊，对端 human | chatMode=interactive（出厂默认表），流式出站 |
| 3 | 单聊，对端 agent | chatMode=proactive（nothuman 默认），CLI 回复 + thought 投影 |
| 4 | 群聊 | chatMode=proactive，含群聊钩子（首发检查等） |
| 5 | system/service 对端 | 强制 interactive（运行时约束） |
| 6 | trigger chatModeOverride | 覆盖生效 |
| 7 | 关系级 `config.chatMode` 覆盖 | 对该对端生效，其他对端不受影响 |
| 8 | agent 级默认表改值（如 private→proactive） | 全体 human 私聊变 proactive |
| 9 | 旧配置自动迁移 | 老 `response_modes` 配置启动无报错、行为等价 |
| 10 | 打断/审批/文件标记 | interactive 文件标记发送、proactive policyHook 拦截，均正常 |

验证手段：`ec response current`、`ec config`、`$EVOLCLAW_HOME/data/eck-debug/`、
真实渠道收发、`im-renderer-diag.log`。

---

## 七、已拍板决策记录

| 决策 | 结论 |
|------|------|
| chatMode 加 auto 值？ | **否**。二值 + 配置层级解析，出厂默认表兜底 |
| 动态解析逻辑归属 | 出厂默认值是**配置数据**（schema defaults），不是代码分支 |
| 目录结构 | 严格按 architecture.md §2.1：modes 薄包装 + 行为归 engines/v1 |
| mode.id 兼任 chatmode | 彻底解耦，按新架构实现 |
| dual-session-lite stub | 本阶段不碰 |
| 宿主契约适配（投影器/ModeContext/持久化） | 合并完成后单独阶段 |

## 八、遗留到下一阶段的事项

- `response_modes` 配置容器形状（default_private/default_group per-chatType 选模式）
  与新架构单值 `responseMode` 的收敛——本阶段两个 chatType 都指向 single-session，
  差异暂无损，容器改形留给配置面统一调整时做
- mode-contract.md 全量适配（ResponseModeImpl / ModeContext / delivery 声明 / `_modes/` 持久化）
- conformance 套件（S 类校验 + C4 通用参数行为测试）

---

**文档维护者**: Claude Code
**最后更新**: 2026-07-14
**状态**: 草案，待评审

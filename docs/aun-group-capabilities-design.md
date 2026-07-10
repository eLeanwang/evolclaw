# AUN 群成员能力卡与群能力索引设计

> 状态：初步方案  
> 日期：2026-07-09  
> 范围：AUN 群空间、AUN SDK、EvolClaw Kits/规则文档  

## 1. 背景

AUN 群里既有人类成员，也可能有多个 agent。群成员经常具备不同的工具、上下文、权限、专业经验或运行环境。当前群规则 `/rules.md` 可以定义群的协作规范，但缺少一种轻量机制让成员声明“我能提供什么能力”，并让其他成员在需要时快速找到合适对象沟通。

本方案设计一个最小可用的能力发现机制：

- 成员把自己的能力卡维护在自己的 AID 存储上。
- 成员把能力卡挂载到群空间的约定路径。
- 专门的管理 agent 统一收集、整理并发布群能力索引。
- 群成员或 agent 根据群能力索引找到能力提供者，再通过群内沟通完成任务。

这不是远程工具调用系统。MVP 只解决“发现谁能帮忙”和“如何联系对方”，不自动执行对方能力。

## 2. 设计原则

1. **成员自主管理能力声明**  
   能力卡的权威源属于成员自己，成员可以独立更新自己的 `/capability.md`。

2. **群空间只暴露挂载入口**  
   群里通过 `/capabilities/<provider-aid>/capability.md` 暴露成员能力卡。语义上这是挂载或引用，不是把成员源文档复制成群权威内容。

3. **索引由管理 agent 维护**  
   群能力索引不是群服务自动生成，也不是每个成员各写一段。它由专门的管理 agent 读取成员卡后统一整理、归类和发布。

4. **索引轻、卡片详**  
   `INDEX.md` 负责快速发现，字段少、短、规范；成员 `capability.md` 负责详细说明，字段更完整。

5. **不默认执行，只引导沟通**  
   索引只说明谁可能有能力处理某类任务。是否接任务、如何处理、是否需要额外授权，由能力提供者在沟通中决定。

## 3. 术语

| 名称 | 含义 |
| --- | --- |
| Capability Card | 成员能力卡。成员维护的能力自述文档，路径为 `<member-aid>:/capability.md`。 |
| Mounted Card | 群空间中的成员能力卡入口，路径为 `<group-aid>:/capabilities/<provider-aid>/capability.md`。 |
| Capability Index | 群能力索引。管理 agent 汇总成员能力卡后发布的索引，路径为 `<group-aid>:/capabilities/INDEX.md`。 |
| Provider | 能力提供者，对应 `provider_aid`。避免使用 `owner`，因为 owner 在群角色体系里已有含义。 |
| Maintainer | 能力索引维护者，对应 `maintainer_aid`，通常是专门的管理 agent。 |

## 4. 路径约定

### 4.1 成员权威源

每个成员只需要维护一个能力卡入口：

```text
<member-aid>:/capability.md
```

示例：

```text
alice.agentid.pub:/capability.md
```

这个文件由成员自己写入和更新。群管理 agent 不应直接修改成员源文档。

### 4.2 群内挂载入口

成员希望在某个群开放能力发现时，将自己的能力卡挂载到群空间：

```text
<group-aid>:/capabilities/<provider-aid>/capability.md
```

示例：

```text
team.group.agentid.pub:/capabilities/alice.agentid.pub/capability.md
```

约束：

- `<provider-aid>` 必须等于能力卡 frontmatter 中的 `provider_aid`。
- 普通成员只能挂载自己的能力卡，不能替其他成员声明能力。
- 挂载失效或成员退群后，管理 agent 下次整理索引时应移除或忽略对应能力。

### 4.3 群能力索引

管理 agent 发布统一索引：

```text
<group-aid>:/capabilities/INDEX.md
```

示例：

```text
team.group.agentid.pub:/capabilities/INDEX.md
```

MVP 不再拆分 `capabilities.md`、`capabilities.json`、`index.meta.json` 等多个文件。一个 Markdown 文件同时服务人类阅读和 agent 解析。

## 5. 文档格式

能力卡和索引都采用 Markdown + YAML frontmatter。

通用约定：

- `schema` 固定为 `aun.capabilities.v1`。
- `kind` 区分 `card` 和 `index`。
- 时间字段使用 ISO 8601，例如 `2026-07-09T10:00:00+08:00`。
- frontmatter 负责结构化发现；正文负责补充说明和使用提示。

### 5.1 成员能力卡

路径：

```text
<member-aid>:/capability.md
```

示例：

```md
---
schema: aun.capabilities.v1
kind: card
provider_aid: alice.agentid.pub
updated_at: 2026-07-09T10:00:00+08:00
capabilities:
  - id: frontend-debug
    title: 前端问题复现与定位
    summary: 复现浏览器问题、定位前端报错，并给出截图和修复建议。
    can_help_with:
      - 页面报错
      - E2E 失败
      - 需要浏览器复现
    needs:
      - URL 或页面路径
      - 复现步骤
      - 分支名或相关提交
    delivers:
      - 复现结论
      - 截图或日志
      - 修复建议
    limits:
      - 不直接处理生产账号敏感数据
  - id: ts-review
    title: TypeScript PR Review
    summary: 审查 TypeScript 代码的类型设计、边界处理和可维护性风险。
    can_help_with:
      - 代码审查
      - 类型问题
      - 架构建议
    needs:
      - PR 链接或 diff
      - 相关设计背景
    delivers:
      - 审查意见
      - 风险点
      - 修改建议
---

# Alice 的能力卡

可补充工作偏好、响应时间、当前不可接任务等自然语言说明。
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | 是 | 固定为 `aun.capabilities.v1`。 |
| `kind` | 是 | 成员能力卡固定为 `card`。 |
| `provider_aid` | 是 | 能力提供者 AID。 |
| `updated_at` | 是 | 成员更新能力卡的时间。 |
| `capabilities` | 是 | 能力列表。 |
| `capabilities[].id` | 是 | 成员卡内稳定 ID。同一个 `provider_aid` 内唯一即可。 |
| `capabilities[].title` | 是 | 能力名称。 |
| `capabilities[].summary` | 是 | 一句话说明。 |
| `capabilities[].can_help_with` | 否 | 适用场景。 |
| `capabilities[].needs` | 否 | 请求方应提供的材料。 |
| `capabilities[].delivers` | 否 | 能力提供者通常交付什么。 |
| `capabilities[].limits` | 否 | 能力边界、禁区或限制。 |

注意：成员能力卡不写 `tags`。标签由管理 agent 在群索引中统一归类，避免成员自由打标签导致索引不可检索。

### 5.2 群能力索引

路径：

```text
<group-aid>:/capabilities/INDEX.md
```

示例：

```md
---
schema: aun.capabilities.v1
kind: index
group_aid: team.group.agentid.pub
updated_at: 2026-07-09T10:30:00+08:00
maintainer_aid: capability-manager.agentid.pub
capabilities:
  - provider_aid: alice.agentid.pub
    id: frontend-debug
    title: 前端问题复现与定位
    summary: 复现浏览器问题、定位前端报错，并给出截图和修复建议。
    tags: [frontend, playwright, browser-debug]
  - provider_aid: bob.agentid.pub
    id: db-migration-review
    title: 数据库迁移审查
    summary: 审查 schema 变更和 SQL 迁移风险，给出回滚与兼容性建议。
    tags: [database, migration, review]
---

# 群成员能力索引

本索引由 capability-manager.agentid.pub 根据群内成员能力卡整理生成。

需要某项能力时，优先按 `provider_aid` 联系对应成员，例如在群内 @ 对方说明任务背景、期望结果和相关材料。需要详细输入要求、交付物和边界时，按约定读取该成员在群能力目录下的能力卡。
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | 是 | 固定为 `aun.capabilities.v1`。 |
| `kind` | 是 | 群能力索引固定为 `index`。 |
| `group_aid` | 是 | 索引所属群。 |
| `updated_at` | 是 | 管理 agent 发布索引的时间。 |
| `maintainer_aid` | 是 | 索引维护者。 |
| `capabilities` | 是 | 索引化后的能力列表。 |
| `capabilities[].provider_aid` | 是 | 能力提供者。 |
| `capabilities[].id` | 是 | 对应 provider 能力卡中的能力 ID。 |
| `capabilities[].title` | 是 | 管理 agent 整理后的能力名称，通常沿用成员卡。 |
| `capabilities[].summary` | 是 | 管理 agent 整理后的短说明。 |
| `capabilities[].tags` | 是 | 管理 agent 统一生成的检索标签。 |

索引条目不重复写 `contact` 和 `source`：

- 联系方式由正文统一说明：按 `provider_aid` 在群内联系对应成员。
- 详情路径由目录约定统一确定：群能力目录下对应 provider 的能力卡。

## 6. 发布与整理流程

### 6.1 成员发布能力卡

1. 成员创建或更新自己的 `<member-aid>:/capability.md`。
2. 成员将该文档挂载到目标群的能力目录。
3. 群空间中出现或更新 `<group-aid>:/capabilities/<provider-aid>/capability.md`。

### 6.2 管理 agent 整理索引

管理 agent 周期性或被触发后执行：

1. 扫描群能力目录中的成员能力卡。
2. 读取并解析 YAML frontmatter。
3. 校验 `schema`、`kind`、`provider_aid`、`capabilities`。
4. 校验挂载路径中的 provider 与卡片 `provider_aid` 一致。
5. 对能力进行去重、摘要和标签归类。
6. 生成并发布 `<group-aid>:/capabilities/INDEX.md`。

异常处理建议：

- 解析失败的卡片不进入索引。
- provider 不匹配的卡片不进入索引。
- 已失效或不可读的挂载不进入索引。
- 管理 agent 可以在索引正文中简短说明本次忽略了多少无效卡片，但不应把错误详情大量写入索引。

### 6.3 群成员使用索引

当成员或 agent 需要某项能力时：

1. 先根据群规则 `/rules.md` 判断本群是否启用能力索引，以及是否有特殊沟通规范。
2. 读取 `<group-aid>:/capabilities/INDEX.md`。
3. 根据 `title`、`summary`、`tags` 找到候选能力。
4. 按 `provider_aid` 联系对应成员，例如群内 @ 对方并说明任务背景、期望结果和相关材料。
5. 如果需要更多细节，再读取对应成员能力卡。

## 7. 权限与挂载语义

MVP 的权限模型遵循“谁声明，谁负责”的原则：

- 成员源文档 `<member-aid>:/capability.md` 由成员自己拥有和更新。
- 群挂载入口只表示成员愿意在该群公开能力声明。
- 群服务或挂载层应保证成员不能替其他成员挂载能力卡。
- 管理 agent 需要读取群能力目录和写入 `INDEX.md` 的权限。
- 普通群成员是否能读取成员能力卡，取决于群空间 ACL 和挂载权限。

挂载应尽量保留引用语义，而不是复制文档内容。这样成员更新自己的 `/capability.md` 后，群内挂载入口自然反映最新内容。

如果底层暂时不支持跨 AID 挂载，可以在实现层引入兼容方案，但对上层文档语义仍应保持“成员源卡片是权威源，群入口只是暴露方式”。

## 8. Kits 与群规则接入

MVP 不新增 `ec group capability search`，也不新增 AUN SDK search API。EvolClaw 侧只需要在 Kits 中增加能力索引使用说明，并由群规则或相关 venue 文档引用。

建议 Kits 文档说明这些规则：

- 群成员可以在自己的 AID 根目录维护 `/capability.md`。
- 希望在某群开放能力发现时，将该能力卡挂载到群能力目录。
- 群能力索引位于 `<group-aid>:/capabilities/INDEX.md`。
- 群能力索引由管理 agent 维护，不代表能力提供者已经接受当前任务。
- 需要某项能力时，先查群规则，再按索引中的 `provider_aid` 联系对应成员。
- 不应默认把所有成员能力卡注入上下文；需要详情时再读取对应能力卡。

群规则 `/rules.md` 可以按需声明本群是否启用能力索引，例如：

```md
## 群成员能力索引

本群启用成员能力索引。需要查找群内可提供的能力时，读取：

team.group.agentid.pub:/capabilities/INDEX.md

找到合适的 `provider_aid` 后，在群内 @ 对方并说明任务背景、期望结果和相关材料。
```

## 9. 非目标

MVP 明确不做：

- 不做 `ec group capability search`。
- 不做 AUN SDK `client.group.capability.search()`。
- 不做服务端全文检索或向量检索。
- 不做直接远程工具执行。
- 不做自动任务分派或自动授权。
- 不默认把所有成员能力卡或完整索引注入 system prompt。
- 不拆出多个索引元数据文件。
- 不在成员能力卡中维护标签体系。

## 10. 后续扩展

后续可以在 MVP 稳定后再考虑：

1. **AUN 原生 capability facade**  
   增加 `client.group.capability.*`，由群服务维护索引版本、权限过滤和变更通知。

2. **版本提示**  
   类似 `group.index` 的 `_meta.group_indexes`，增加 `_meta.group_capabilities`，让客户端知道索引是否变化。

3. **ECK 轻量注入**  
   在确认索引规模和质量可控后，可选择只注入 `INDEX.md` 的短摘要，不注入成员详情卡。

4. **授权与委托**  
   当需要从“发现人”升级到“请求对方执行”时，再设计 delegation token、任务确认、审计日志和撤销机制。

5. **标签规范**  
   管理 agent 可以逐步维护群内标签规范，例如 `frontend`、`database`、`review`、`ops`、`security` 等。

## 11. 当前推荐落地顺序

1. 固定本文的路径和 frontmatter schema。
2. 在 Kits 增加群能力索引使用说明。
3. 在群规则样例中加入能力索引引用方式。
4. 人工或管理 agent 先生成 `INDEX.md`，验证协作体验。
5. 再评估是否需要自动同步、自动注入或 SDK/API 支持。

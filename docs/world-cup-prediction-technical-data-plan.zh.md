# 世界杯竞猜网站技术与数据源执行方案

日期：2026-06-13
负责人：eleanbot
状态：待 evolai 汇总，待 elean 确认后进入开发

## 结论先行

建议把世界杯竞猜网站做成独立 HTTP Web 应用，不塞进 EvolClaw 核心。EvolClaw 和其他 Agent 作为参赛客户端，通过浏览器或 HTTP API 参与竞猜。

推荐 MVP 数据源：

1. API-Football / API-SPORTS：主数据源，负责赛程、赛果、比赛状态、赔率/预测。
2. FIFA 官方赛程页：人工校验和后台纠错参考。
3. 本地数据库缓存：所有外部数据先入库，网站只读本地库，不直接依赖第三方接口实时响应。

备选生产级数据源：

1. Sportmonks All-In：如果预算允许，优先统一购买一个覆盖赛程、实时比分、赔率、预测、xG、阵容、积分榜的数据源。
2. The Odds API / SportsDataIO：作为单独赔率源补充。
3. football-data.org / openfootball：作为低成本赛程参考，不适合作为胜率和赔率主来源。

核心原则：

- 赛事不是一场，而是完整 2026 世界杯，按 provider 同步全部比赛，应用逻辑不得硬编码 104。
- 赛程、赛果、赔率、预测、积分结算必须有同步记录、快照和人工覆盖能力。
- Agent 参赛必须走 HTTP API，网页只是人类 UI；两者共用同一套竞猜和结算逻辑。

## 已确认的外部事实

- 2026 世界杯为 48 队、104 场比赛，比赛时间为 2026-06-11 至 2026-07-19。
- API-Football 的世界杯 2026 指南使用 `league=1`、`season=2026`，`fixtures?league=1&season=2026` 可取赛程，返回 fixture id、UTC 时间、场地、状态等。
- Sportmonks 资料给出 World Cup 2026 的 League ID `732`、Season ID `26618`，可用于 fixtures、standings、squads、bracket 等查询。
- FIFA 官方页面适合作为赛程和赛果人工核验源，但不是稳定的机器主数据源。

## 协作分工

| Agent | 负责人角色 | 交付物 |
| --- | --- | --- |
| evolai | leader / PM / 方案汇总 | 最终确认稿、决策记录、待 elean 确认问题清单 |
| eleanbot | 技术与数据方案 | 本文档、数据源比较、数据库/API/同步/结算设计 |
| evolagent | 产品与页面流程 | 页面地图、用户路径、后台操作流程、验收用例 |

工作方式：

1. 每个 Agent 先提交自己的 markdown 交付物。
2. evolai 合并为一份总方案。
3. 群里只讨论争议点和确认项，不反复重复已写入文档的内容。
4. elean 确认后，再进入代码实现。

## 系统边界

### 必做

- 公开赛程页：按日期、阶段、小组、球队筛选。
- 比赛详情页：双方、开赛时间、场地、状态、比分、胜率/赔率、用户自己的竞猜、群体分布。
- 竞猜提交：胜平负为基础玩法，可选比分和信心值。
- 锁盘：开赛前自动锁定，锁盘后禁止提交和修改。
- 自动结算：比赛结束后按赛果结算积分，写入得分事件。
- 排行榜：总分、排名、命中率、精确比分数、最近变化。
- 个人页：我的竞猜、待开赛、已结算、积分流水。
- 管理后台：同步状态、失败重试、人工覆盖、手动结算、参赛者管理。
- Agent HTTP API：Agent 可以不打开网页，直接通过 token 调接口参赛。

### 暂不做

- 复杂赔率加权积分。
- 真实投注或金钱相关功能。
- 直播聊天室。
- 自建胜率模型。
- 一开始就做 AID 签名认证。

### 保留扩展

- 淘汰赛增加“晋级球队”玩法。
- 冷门加分。
- Agent AID 签名请求。
- 多赛事扩展，例如欧洲杯、世界杯预选赛。
- Webhook 推送给 Agent。

## 数据源比较

| 数据源 | 适合用途 | 优点 | 风险 |
| --- | --- | --- | --- |
| API-Football / API-SPORTS | MVP 主数据源 | 覆盖赛程、赛果、状态、赔率、预测；已有 World Cup 2026 指南 | 套餐限制、赔率覆盖质量需实测 |
| Sportmonks | 生产级主数据源 | 覆盖完整，文档明确 World Cup 2026 ID，适合一体化数据 | 成本可能更高 |
| FIFA 官方页面 | 人工校验 | 权威、适合管理员核对 | 不适合作为唯一机器同步源 |
| The Odds API | 赔率补充 | 专注赔率，适合胜率展示 | 需要和赛程 provider 做比赛映射 |
| SportsDataIO | 生产级补充 | 覆盖实时比分、赔率、球员数据 | 成本和授权要确认 |
| football-data.org | 低成本赛程/赛果备选 | 接口简单，适合备用 | 赔率/预测不足 |
| openfootball / GitHub 数据集 | 开发种子数据 | 免费、便于本地开发 | 实时性和准确性不足 |

建议 elean 只需确认两件事：

1. 预算低：选 API-Football。
2. 预算可接受、要稳定：选 Sportmonks All-In。

## 数据同步设计

所有外部数据必须先落库，页面和业务逻辑只读取本地数据库。

### 同步任务

| Job | 频率 | 内容 | 备注 |
| --- | --- | --- | --- |
| `sync:fixtures` | 每 6 小时，管理员可手动触发 | 球队、场地、开赛时间、阶段、小组、provider fixture id | 赛程变更时更新 |
| `sync:live-status` | 比赛日前后每 1-5 分钟 | 比赛状态、比分、进行时间 | 只同步当天和未来 24 小时比赛 |
| `sync:results` | 每 5-15 分钟 | 已结束比赛最终比分、状态 | 触发结算候选 |
| `sync:odds` | 每 15-60 分钟 | 主胜/平/客胜赔率，生成胜率快照 | 锁盘前最后一条作为结算参考 |
| `sync:predictions` | 每 1-6 小时 | provider 模型预测 | 展示参考，不参与结算 |
| `settlement:run` | 每 5 分钟，管理员可手动触发 | 结算已结束且未结算比赛 | 必须幂等 |

### 同步状态

每次同步写入 `sync_runs`：

- provider
- job_type
- started_at / finished_at
- status: success / failed / partial
- rows_seen / rows_changed
- error_message
- provider_payload_hash

后台必须能看到最近同步时间、失败原因和手动重试按钮。

### 冲突处理

优先级：

1. 管理员人工覆盖。
2. 主数据源。
3. 备用数据源。
4. 开发种子数据。

人工覆盖必须写 `audit_logs`，并保留覆盖前后的 JSON。

## 核心数据模型

### participants

参赛者表。人类和 Agent 都是 participant。

- id
- display_name
- type: human / agent / admin
- aid
- auth_token_hash
- status: active / disabled
- created_at
- updated_at

### teams

- id
- provider
- provider_team_id
- name
- code
- country
- logo_url

### venues

- id
- provider_venue_id
- name
- city
- country
- timezone

### matches

- id
- provider
- provider_fixture_id
- stage
- group_name
- home_team_id
- away_team_id
- kickoff_at
- venue_id
- status: scheduled / live / finished / postponed / cancelled
- home_score
- away_score
- winner_team_id
- locked_at
- settled_at
- manual_override_json

### odds_snapshots

- id
- match_id
- provider
- bookmaker
- market: result_1x2
- home_price
- draw_price
- away_price
- home_probability
- draw_probability
- away_probability
- captured_at

### external_predictions

- id
- match_id
- provider
- home_probability
- draw_probability
- away_probability
- payload_json
- captured_at

### predictions

- id
- participant_id
- match_id
- market: result_1x2
- pick: home / draw / away
- score_home
- score_away
- confidence
- reason
- submitted_at
- updated_at
- locked_at
- source: web / api

唯一约束：

- `(participant_id, match_id, market)` 唯一。
- 锁盘前重复提交为更新。
- 锁盘后提交或更新直接拒绝。

### score_events

- id
- prediction_id
- participant_id
- match_id
- points
- reason
- settled_at
- settlement_run_id

积分只通过 score_events 计算，不直接在 predictions 上改总分。

### settlement_runs

- id
- match_id
- started_at
- finished_at
- status
- rule_version
- error_message

### audit_logs

- id
- actor_id
- action
- target_type
- target_id
- before_json
- after_json
- created_at

## 积分规则建议

MVP 规则必须简单、透明、可解释：

- 猜中胜平负：3 分。
- 精确比分：额外 3 分。
- 未中精确比分但猜中净胜球：额外 1 分。
- 猜错：0 分。
- 锁盘后提交：拒绝。
- 锁盘前修改：允许，保留审计。

淘汰赛建议：

- MVP 仍按 1X2 结算，即 90 分钟加伤停补时结果，点球不影响胜平负。
- 后续可加 `advancing_team` 玩法，单独积分。

胜率建议：

- 页面展示胜率，积分不受胜率影响。
- 后续如果要冷门加分，必须先冻结锁盘前 odds 快照，避免赛后赔率变化导致争议。

## HTTP API 设计

### 公开接口

- `GET /api/fixtures`
- `GET /api/fixtures/:id`
- `GET /api/leaderboard`
- `GET /api/participants/:id`
- `GET /api/standings`

### 登录接口

- `GET /api/me`
- `GET /api/me/predictions`
- `POST /api/predictions`
- `PATCH /api/predictions/:id`

`POST /api/predictions` 示例：

```json
{
  "matchId": "local-match-id",
  "market": "result_1x2",
  "pick": "home",
  "scoreHome": 2,
  "scoreAway": 1,
  "confidence": 0.62,
  "reason": "主队近期状态更稳定"
}
```

响应示例：

```json
{
  "ok": true,
  "prediction": {
    "id": "pred_123",
    "matchId": "match_123",
    "pick": "home",
    "submittedAt": "2026-06-13T01:00:00+08:00",
    "canEdit": true
  }
}
```

错误格式：

```json
{
  "ok": false,
  "error": {
    "code": "MATCH_LOCKED",
    "message": "比赛已锁盘，不能提交或修改竞猜"
  }
}
```

### 管理接口

- `POST /api/admin/sync/fixtures`
- `POST /api/admin/sync/results`
- `POST /api/admin/sync/odds`
- `POST /api/admin/matches/:id/override`
- `POST /api/admin/matches/:id/settle`
- `POST /api/admin/settlement/run`
- `GET /api/admin/sync-runs`
- `POST /api/admin/participants`
- `PATCH /api/admin/participants/:id`

## 页面清单

| 页面 | 用途 |
| --- | --- |
| `/` | 今日比赛、排行榜摘要、我的待竞猜 |
| `/fixtures` | 完整赛程，支持筛选 |
| `/fixtures/:id` | 比赛详情、胜率、竞猜表单、群体分布 |
| `/leaderboard` | 总榜、阶段榜、命中率、排名变化 |
| `/me` | 我的竞猜、积分流水、错过比赛 |
| `/admin` | 同步状态、失败重试、数据覆盖、手动结算 |
| `/admin/participants` | 人类和 Agent 参赛者管理、token 签发/撤销 |

## 技术栈建议

如做独立站点：

- Next.js 或 Remix：页面和 API 一体。
- PostgreSQL：线上多人使用。
- Prisma 或 Drizzle：schema 和迁移。
- BullMQ / cron：同步和结算任务。
- Tailwind 或现有设计系统：快速出 UI。

如果只做本地 MVP：

- Node/TypeScript + SQLite 也可以。
- 但数据源适配器、结算逻辑、API contract 要按可迁移到 PostgreSQL 的方式写。

## 开发计划

### 阶段 0：确认

- [ ] elean 确认数据源预算。
- [ ] elean 确认积分规则。
- [ ] elean 确认独立站点还是嵌入现有 Web。
- [ ] evolai 合并最终方案。

### 阶段 1：应用骨架

- [ ] 初始化 Web 应用。
- [ ] 添加数据库 schema 和迁移。
- [ ] 添加环境变量校验。
- [ ] 添加 participant token 认证。
- [ ] 添加基础页面布局。

### 阶段 2：数据同步

- [ ] 实现 provider adapter interface。
- [ ] 实现 API-Football adapter。
- [ ] 导入 fixtures / teams / venues。
- [ ] 导入 status / results。
- [ ] 导入 odds / external predictions。
- [ ] 后台展示 sync_runs。

### 阶段 3：竞猜核心

- [ ] 开放比赛判断。
- [ ] 锁盘逻辑。
- [ ] 提交/修改竞猜。
- [ ] 幂等结算。
- [ ] score_events 和 leaderboard 查询。

### 阶段 4：网页与后台

- [ ] 赛程页。
- [ ] 比赛详情页。
- [ ] 排行榜页。
- [ ] 个人页。
- [ ] 管理后台。

### 阶段 5：Agent 支持

- [ ] Token 签发/撤销。
- [ ] Agent API 文档。
- [ ] curl 示例。
- [ ] 错误码文档。
- [ ] 简单限流。

### 阶段 6：验证

- [ ] 锁盘单元测试。
- [ ] 积分规则单元测试。
- [ ] 结算幂等测试。
- [ ] 同步 adapter 契约测试。
- [ ] E2E：浏览赛程、提交竞猜、锁盘、导入赛果、结算、排行榜更新。

## 验收标准

上线前必须满足：

- 能展示完整赛事赛程，而不是少量手写样例。
- 至少 3 个 Agent 能通过 HTTP API 提交竞猜。
- 人类能通过网页提交和修改竞猜。
- 锁盘后提交被拒绝。
- 一场比赛结束后能自动结算积分。
- 排行榜能正确变化。
- 管理员能看到数据同步状态和失败原因。
- 管理员能人工覆盖赛果并重新结算。
- 所有积分变更都有 score_events 可审计。

## 需要 elean 确认的问题

1. 数据源预算：API-Football 还是 Sportmonks All-In？
2. 是否接受 MVP 用 bearer token 给 Agent 参赛？
3. 淘汰赛是否先按 1X2 结算？
4. 胜率是否只展示、不参与积分？
5. 站点部署在哪里：本机演示、内网服务、还是公网？
6. 是否需要首版就支持真实用户注册，还是管理员手动创建参赛者？

## 资料来源

- FIFA 官方赛程/结果：https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures
- FIFA 赛程介绍：https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums
- API-Football 世界杯 2026 指南：https://www.api-football.com/news/post/fifa-world-cup-2026-guide-to-using-data-with-api-sports
- API-Football 文档：https://api-sports.io/documentation/football/v3
- Sportmonks World Cup API：https://www.sportmonks.com/football-api/world-cup-api/
- Sportmonks World Cup 2026 指南：https://docs.sportmonks.com/v3/world-cup-2026/how-to-build-your-world-cup-application
- football-data.org 文档：https://www.football-data.org/documentation/api
- The Odds API：https://the-odds-api.com/

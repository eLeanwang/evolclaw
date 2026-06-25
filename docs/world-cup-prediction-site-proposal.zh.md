# 世界杯竞猜网站方案

日期：2026-06-12

## 目标

开发一个完整的、可通过 HTTP 访问的世界杯竞猜网站。人类用户和 Agent 都可以浏览赛程、提交竞猜、获得积分，并在排行榜中比较名次。

在 elean 确认方案前，不开始业务代码开发。

## 协作计划

| 负责人 | 范围 | 交付物 |
| --- | --- | --- |
| evolai | Leader、范围控制、最终方案汇总 | 决策记录，以及提交给 elean 的确认稿 |
| eleanbot | 产品流程、页面结构、竞猜/积分体验 | 页面地图、用户路径、积分展示规则 |
| evolagent | 数据与工程方案 | 数据源决策、架构、API/表结构草案、实施清单 |

协作方式：

1. 每个 Agent 负责一个具体交付物，不能只在群里聊天。
2. evolai 把各自交付物合并成统一决策方案。
3. elean 确认范围、数据提供商和积分规则。
4. 确认后再开始 UI、API、数据库实现。

## 产品范围

核心用户：

- 人类用户通过浏览器访问网站。
- Agent 用户通过同一套 HTTP API 参与竞猜。
- 管理员负责赛程同步、人工修正、结果结算和参赛者管理。

核心能力：

- 展示完整世界杯赛程，不是只支持一场比赛。
- 比赛详情页展示球队、时间、场地、比赛状态、赔率/胜率、用户竞猜和群体竞猜分布。
- 比赛锁盘前允许提交竞猜。
- 排行榜展示总积分、命中率、精确比分命中数和排名变化。
- 个人页展示已提交竞猜、待开赛比赛、得分历史和错过截止的比赛。
- 管理后台展示同步状态、数据冲突、人工覆盖和结果结算。

赛事规模假设：

- 2026 世界杯有 48 支球队、104 场比赛。应用逻辑不要硬编码 104，而是按配置的赛事和赛季从数据源同步所有比赛。

## 数据源

### 赛程与赛果来源

推荐主数据源：API-Football / API-SPORTS。

理由：

- 其世界杯 2026 指南标明 `league=1`、`season=2026`。
- Fixtures 接口返回赛程、比赛 ID、UTC 时间、场地和比赛状态。
- 文档覆盖该赛事的积分榜、球队、实时比赛、比赛事件、球员数据、预测和赔率。
- 指南说明 `fixtures?league=1&season=2026` 可获取全部 104 场比赛赛程，`/fixtures?id=FIXTURE_ID` 可获取单场比赛详情。

备选主数据源：Sportmonks World Cup API。

理由：

- 覆盖赛程、实时比分、比赛事件、阵容、积分榜、小组、淘汰赛对阵、赔率、预测和 xG，具体能力取决于套餐。
- Sportmonks 声称世界杯 2026 赛程数据已经可用，实时比分和事件会从首场比赛开始启用。
- Sportmonks 材料中给出了世界杯相关 ID：League ID 732、Season ID 26618。

备用/校验来源：

- FIFA 官方赛程和结果页面适合做人类校验来源、后台人工修正参考，不建议作为唯一机器数据源。
- football-data.org 可作为低成本赛程/赛果备用源，但赔率、胜率和更丰富的预测能力较弱。

### 胜率来源

建议用赔率换算出的隐含概率作为页面上的“胜率”基础展示。

主要选择：

- 如果选 API-Football 作为赛程数据源，可优先使用它的 odds/predictions 接口。
- 如果选 Sportmonks 且预算允许，可用 All-In 套餐统一获取预测、xG、压力指标和赔率。
- 如果需要独立赔率源，可接 The Odds API 或 SportsGameOdds。

概率计算：

1. 获取主胜/平/客胜的十进制赔率。
2. 将每个结果转成原始隐含概率：`p = 1 / decimal_odds`。
3. 掉庄家水位：`p_normalized = p / sum(all_raw_p)`。
4. 保存数据源、博彩公司、市场、抓取时间和归一化后的概率。

重要区分：

- 赔率换算出的胜率不是最终赛果来源。
- 结果结算必须依赖比赛状态/最终比分数据，并支持管理员校验。
- 数据源提供的模型预测可作为单独的“模型视角”展示。

### 数据源建议

推荐 MVP 数据源组合：

1. API-Football 作为赛程、赛果、预测、赔率来源。
2. FIFA 官方页面作为人工校验来源。
3. 只有在 API-Football 赔率质量不足时，再增加 The Odds API 或 SportsGameOdds。

如果预算允许，推荐生产级组合：

1. Sportmonks All-In 作为统一体育数据源。
2. FIFA 官方页面作为人工校验来源。
3. 保存赔率快照，用于审计和历史排行榜分析。

## 系统架构

竞猜网站应作为一个独立的应用表面，不要塞进 EvolClaw 核心。EvolClaw 可以作为 Agent 客户端参与，但网站本身应该提供正常的 HTTP 页面和 API。

逻辑模块：

- Web 前端：公开赛程浏览、竞猜表单、排行榜、个人页、管理后台。
- HTTP API：认证、赛程、竞猜、排行榜、同步状态、管理员覆盖。
- 数据同步 worker：定时从数据源导入赛程、比赛状态、积分榜、赔率和预测。
- 结算 worker：锁定竞猜、结算已结束比赛、写入得分事件。
- 审计层：记录数据源 payload 哈希、人工覆盖、积分规则变更和结算运行记录。

部署形态：

- MVP 用单个 Node/TypeScript 服务即可。
- 使用关系型数据库保证一致性。本地 MVP 可用 SQLite；多人线上使用建议 PostgreSQL。
- 数据源 API key 放在环境变量中。

## HTTP 参与方式

人类浏览器流程：

1. 登录。
2. 按日期、小组、球队或阶段浏览比赛。
3. 在锁盘前提交或修改竞猜。
4. 结算后查看排行榜和得分历史。

Agent HTTP 流程：

1. 管理员给每个 Agent 签发参赛 token。
2. Agent 调用 `GET /api/matches?status=open` 获取可竞猜比赛。
3. Agent 调用 `POST /api/predictions` 提交 JSON 竞猜。
4. Agent 调用 `GET /api/leaderboard` 和 `GET /api/me/predictions` 查看反馈。

建议的 Agent 竞猜请求：

```json
{
  "matchId": "provider-fixture-id",
  "market": "result_1x2",
  "pick": "home",
  "scoreHome": 2,
  "scoreAway": 1,
  "confidence": 0.62,
  "reason": "简短的可选理由"
}
```

认证方式：

- MVP：每个参赛者一个 bearer token。
- 后续：Agent 使用 AID 签名 HTTP 请求，人类使用普通密码/OAuth/session 登录。

## 数据模型草案

核心表：

- `participants`：id、display_name、type、aid、auth_token_hash、status、created_at。
- `teams`：id、provider、provider_team_id、name、code、logo_url。
- `venues`：id、provider_venue_id、name、city、country、timezone。
- `matches`：id、provider、provider_fixture_id、stage、group_name、home_team_id、away_team_id、kickoff_at、venue_id、status、home_score、away_score、winner_team_id、locked_at。
- `odds_snapshots`：id、match_id、provider、bookmaker、market、home_price、draw_price、away_price、home_probability、draw_probability、away_probability、captured_at。
- `model_predictions`：id、match_id、provider、home_probability、draw_probability、away_probability、payload_json、captured_at。
- `predictions`：id、participant_id、match_id、market、pick、score_home、score_away、confidence、reason、submitted_at、updated_at、locked_at。
- `score_events`：id、prediction_id、match_id、participant_id、points、reason、settled_at、settlement_run_id。
- `leaderboard_snapshots`：id、participant_id、total_points、rank、hit_count、exact_score_count、settled_match_count、captured_at。
- `sync_runs`：id、provider、job_type、started_at、finished_at、status、error、rows_changed。
- `audit_logs`：id、actor_id、action、target_type、target_id、before_json、after_json、created_at。

## API 草案

公开读取接口：

- `GET /api/fixtures`
- `GET /api/fixtures/:id`
- `GET /api/leaderboard`
- `GET /api/participants/:id`
- `GET /api/standings`

登录后接口：

- `GET /api/me`
- `GET /api/me/predictions`
- `POST /api/predictions`
- `PATCH /api/predictions/:id`

管理员接口：

- `POST /api/admin/sync/fixtures`
- `POST /api/admin/sync/results`
- `POST /api/admin/sync/odds`
- `POST /api/admin/matches/:id/override`
- `POST /api/admin/matches/:id/settle`
- `POST /api/admin/settlement/run`
- `GET /api/admin/sync-runs`

## 待确认的积分规则

推荐默认规则：

- 猜中胜/平/负：3 分。
- 精确比分：额外 3 分。
- 未中精确比分但猜中净胜球：额外 1 分。
- `locked_at` 之后提交竞猜：拒绝。
- `locked_at` 前修改竞猜：允许，但写审计记录。

淘汰赛问题：

- 选项 A：继续按常规时间加伤停补时的 1X2 结算，因此可能出现平局。
- 选项 B：淘汰赛改成竞猜晋级球队，因此没有平局。
- 建议：数据模型同时支持两种市场，但上线先统一使用 1X2，除非 elean 明确要单独的淘汰赛玩法。

胜率加分问题：

- 选项 A：不加分，最简单透明。
- 选项 B：根据锁盘前归一化概率做冷门加分。
- 建议：MVP 不做胜率加分，只把胜率作为参考展示。

## 实施清单

阶段 0：确认

- [ ] 确认数据源：API-Football、Sportmonks 或其他。
- [ ] 确认预算/API key。
- [ ] 确认积分规则。
- [ ] 确认人类和 Agent 的认证方式。
- [ ] 确认部署目标。

阶段 1：基础建设

- [ ] 创建应用骨架。
- [ ] 添加数据库 schema 和迁移。
- [ ] 添加数据源适配器接口。
- [ ] 添加 API key/env 校验。
- [ ] 添加种子数据/管理员初始化流程。

阶段 2：数据同步

- [ ] 同步球队、场地、赛程、阶段和小组。
- [ ] 同步比赛状态和结果。
- [ ] 同步积分榜/淘汰赛对阵。
- [ ] 同步赔率/胜率快照。
- [ ] 添加同步日志、重试策略和管理员覆盖。

阶段 3：竞猜核心

- [ ] 参赛者注册/认证。
- [ ] 可竞猜/锁盘逻辑。
- [ ] 竞猜提交/修改 API。
- [ ] 竞猜修改审计日志。
- [ ] 结算引擎和得分事件。

阶段 4：网站页面

- [ ] 赛程页。
- [ ] 比赛详情和竞猜表单。
- [ ] 排行榜页。
- [ ] 参赛者个人页。
- [ ] 管理员同步/覆盖/结算页。

阶段 5：Agent HTTP 支持

- [ ] token 签发/撤销管理 UI。
- [ ] Agent 友好的 API 文档。
- [ ] JSON 错误格式。
- [ ] 按参赛者限流。
- [ ] 示例 curl 请求。

阶段 6：验证

- [ ] 积分和锁盘单元测试。
- [ ] 数据源适配器契约测试。
- [ ] 结算幂等性测试。
- [ ] E2E 流程：浏览、竞猜、锁盘、结算、排名。
- [ ] 管理员覆盖审计测试。

## 给 elean 的开放问题

1. 数据源预算：优先用成本较低的 API-Football，还是直接用集成度更高的 Sportmonks All-In？
2. Agent 认证：MVP 用简单 token，还是一开始就要求 AID 签名 HTTP？
3. 淘汰赛：按 1X2 结算，还是竞猜晋级球队？
4. 赔率/胜率：只做展示参考，还是影响积分？
5. 这是独立站点，还是集成到现有 EvolClaw Web 表面？

## 已查资料

- FIFA 官方赛程/结果页面：https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures
- FIFA 赛程公告：https://inside.fifa.com/organisation/media-releases/updated-world-cup-2026-match-schedule-venues-kick-off-times-104-matches
- API-Football 世界杯 2026 指南：https://www.api-football.com/news/post/fifa-world-cup-2026-guide-to-using-data-with-api-sports
- API-Football 文档：https://api-sports.io/documentation/football/v3
- Sportmonks World Cup API：https://www.sportmonks.com/football-api/world-cup-api/
- The Odds API 文档：https://the-odds-api.com/liveapi/guides/v4/
- SportsGameOdds 文档：https://sportsgameodds.com/docs
- football-data.org 文档：https://www.football-data.org/documentation/api

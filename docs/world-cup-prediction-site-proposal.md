# World Cup Prediction Site Proposal

Date: 2026-06-12

## Goal

Build a complete HTTP-accessible World Cup prediction website where humans and agents can browse fixtures, submit predictions, earn points, and compare rankings across the full tournament.

No business implementation should start until the proposal is confirmed by elean.

## Collaboration Plan

| Owner | Scope | Deliverable |
| --- | --- | --- |
| evolai | Leader, scope control, final proposal aggregation | Decision log and confirmation request to elean |
| eleanbot | Product flow, page structure, prediction/scoring UX | Page map, user journeys, scoring display rules |
| evolagent | Data and engineering plan | Data-source decision, architecture, API/schema draft, implementation checklist |

Working mode:

1. Each agent owns a concrete artifact, not just chat comments.
2. evolai merges artifacts into one decision proposal.
3. elean confirms scope, data provider, and scoring rules.
4. Only after confirmation do we start UI/API/database implementation.

## Product Scope

Core users:

- Human users access the site in a browser.
- Agent users access the same system over HTTP APIs.
- Admin users manage schedule sync, manual corrections, result settlement, and participant moderation.

Core capabilities:

- Fixture list for the full World Cup, not a single match.
- Match detail page with teams, time, venue, status, odds/probability, user prediction, and crowd distribution.
- Prediction submission before lock time.
- Ranking page by total points, hit rate, exact-score hits, and recent movement.
- Personal page with submitted predictions, pending matches, score history, and missed deadlines.
- Admin page for sync status, data conflicts, manual overrides, and result settlement.

Tournament scale assumption:

- The 2026 World Cup has 48 teams and 104 fixtures. Do not hard-code 104 in application logic; sync all provider fixtures for the configured competition and season.

## Data Sources

### Fixture And Result Source

Recommended primary: API-Football / API-SPORTS.

Why:

- Their World Cup 2026 guide identifies `league=1` and `season=2026`.
- Fixtures endpoint returns schedule, fixture IDs, UTC time, venue, and status.
- Standings, teams, live fixtures, match events, player stats, predictions, and odds are documented for the competition coverage.
- The guide says `fixtures?league=1&season=2026` retrieves the schedule with all 104 matches and that `/fixtures?id=FIXTURE_ID` returns match detail.

Alternative primary: Sportmonks World Cup API.

Why:

- Covers fixtures, live scores, match events, squads, standings, groups, knockout bracket, odds, predictions, and xG depending on plan.
- Sportmonks states World Cup 2026 fixture data is available now and live scores/events activate from the first match.
- Sportmonks gives specific World Cup IDs in their own materials: League ID 732 and Season ID 26618.

Fallback/reference:

- FIFA official fixtures and results pages should be used as a human verification source and admin override reference, not as the only machine feed.
- football-data.org can be a low-cost fallback for fixtures/results, but it is weak for odds/probabilities and richer prediction features.

### Win Probability Source

Use odds-derived implied probabilities as the baseline "win rate" display.

Primary options:

- API-Football odds/predictions endpoints if we choose API-Football as the fixture provider.
- Sportmonks All-In plan if we choose Sportmonks and want predictions, xG, pressure metrics, and odds in one provider.
- The Odds API or SportsGameOdds if we want a separate odds provider.

Probability calculation:

1. Fetch decimal odds for home/draw/away.
2. Convert each outcome to raw implied probability: `p = 1 / decimal_odds`.
3. Remove bookmaker overround: `p_normalized = p / sum(all_raw_p)`.
4. Store provider, bookmaker, market, timestamp, and normalized probabilities.

Important distinction:

- Odds-derived probability is not the final result source.
- Results must settle from fixture status/final score data plus admin verification.
- Predictions from provider models can be shown as a separate "model view" if available.

### Source Decision

Recommended MVP provider setup:

1. API-Football as fixture/result/prediction/odds source.
2. FIFA official pages as manual verification.
3. Add The Odds API or SportsGameOdds only if API-Football odds quality is insufficient.

Recommended production setup if budget is acceptable:

1. Sportmonks All-In as single integrated sports data source.
2. FIFA official pages as manual verification.
3. Store odds snapshots for audit and historical leaderboard analysis.

## System Architecture

Keep the prediction site as a separate application surface from EvolClaw core. EvolClaw can still participate as an agent client, but the site should expose normal HTTP pages and APIs.

Logical modules:

- Web frontend: public match browsing, prediction form, leaderboard, profile, admin console.
- HTTP API: authentication, fixtures, predictions, leaderboard, sync status, admin overrides.
- Data sync worker: scheduled provider imports for fixtures, statuses, standings, odds, and predictions.
- Settlement worker: locks predictions, settles finished matches, writes score events.
- Audit layer: records provider payload hashes, manual overrides, scoring changes, and settlement runs.

Deployment shape:

- Single Node/TypeScript service is enough for MVP.
- Use a relational database for consistency. SQLite is acceptable for local MVP; PostgreSQL is better for hosted multi-user use.
- Keep provider API keys in environment variables.

## HTTP Participation

Human browser flow:

1. Sign in.
2. Browse matches by date, group, team, or stage.
3. Submit or update a prediction before lock time.
4. View ranking and score history after settlement.

Agent HTTP flow:

1. Admin issues each agent a participant token.
2. Agent calls `GET /api/matches?status=open` to find open matches.
3. Agent calls `POST /api/predictions` with JSON.
4. Agent calls `GET /api/leaderboard` and `GET /api/me/predictions` for feedback.

Suggested agent prediction request:

```json
{
  "matchId": "provider-fixture-id",
  "market": "result_1x2",
  "pick": "home",
  "scoreHome": 2,
  "scoreAway": 1,
  "confidence": 0.62,
  "reason": "short optional explanation"
}
```

Authentication:

- MVP: bearer token per participant.
- Later: AID-signed HTTP requests for agents, normal password/OAuth/session login for humans.

## Data Model Draft

Core tables:

- `participants`: id, display_name, type, aid, auth_token_hash, status, created_at.
- `teams`: id, provider, provider_team_id, name, code, logo_url.
- `venues`: id, provider_venue_id, name, city, country, timezone.
- `matches`: id, provider, provider_fixture_id, stage, group_name, home_team_id, away_team_id, kickoff_at, venue_id, status, home_score, away_score, winner_team_id, locked_at.
- `odds_snapshots`: id, match_id, provider, bookmaker, market, home_price, draw_price, away_price, home_probability, draw_probability, away_probability, captured_at.
- `model_predictions`: id, match_id, provider, home_probability, draw_probability, away_probability, payload_json, captured_at.
- `predictions`: id, participant_id, match_id, market, pick, score_home, score_away, confidence, reason, submitted_at, updated_at, locked_at.
- `score_events`: id, prediction_id, match_id, participant_id, points, reason, settled_at, settlement_run_id.
- `leaderboard_snapshots`: id, participant_id, total_points, rank, hit_count, exact_score_count, settled_match_count, captured_at.
- `sync_runs`: id, provider, job_type, started_at, finished_at, status, error, rows_changed.
- `audit_logs`: id, actor_id, action, target_type, target_id, before_json, after_json, created_at.

## API Draft

Public/read APIs:

- `GET /api/fixtures`
- `GET /api/fixtures/:id`
- `GET /api/leaderboard`
- `GET /api/participants/:id`
- `GET /api/standings`

Authenticated APIs:

- `GET /api/me`
- `GET /api/me/predictions`
- `POST /api/predictions`
- `PATCH /api/predictions/:id`

Admin APIs:

- `POST /api/admin/sync/fixtures`
- `POST /api/admin/sync/results`
- `POST /api/admin/sync/odds`
- `POST /api/admin/matches/:id/override`
- `POST /api/admin/matches/:id/settle`
- `POST /api/admin/settlement/run`
- `GET /api/admin/sync-runs`

## Scoring Rules To Confirm

Recommended default:

- Correct win/draw/loss outcome: 3 points.
- Exact score: additional 3 points.
- Correct goal difference without exact score: additional 1 point.
- Prediction after `locked_at`: rejected.
- Prediction edit before `locked_at`: allowed, audit logged.

Knockout question:

- Option A: keep 1X2 based on normal time plus stoppage time, so draws are possible.
- Option B: predict advancing team for knockout matches, so draws are not possible.
- Recommendation: support both markets in the model, but launch with 1X2 for all matches unless elean wants a separate knockout market.

Probability bonus question:

- Option A: no bonus, simplest and transparent.
- Option B: underdog bonus based on pre-lock normalized probability.
- Recommendation: no probability bonus for MVP; show probabilities for context only.

## Implementation Checklist

Phase 0: Confirmation

- [ ] Confirm provider: API-Football, Sportmonks, or other.
- [ ] Confirm budget/API keys.
- [ ] Confirm scoring rules.
- [ ] Confirm auth mode for humans and agents.
- [ ] Confirm deployment target.

Phase 1: Foundation

- [ ] Create app skeleton.
- [ ] Add database schema and migrations.
- [ ] Add provider adapter interface.
- [ ] Add API key/env validation.
- [ ] Add seed/admin user flow.

Phase 2: Data Sync

- [ ] Sync teams, venues, fixtures, stages, and groups.
- [ ] Sync match statuses and results.
- [ ] Sync standings/bracket.
- [ ] Sync odds/probability snapshots.
- [ ] Add sync logs, retry policy, and admin override.

Phase 3: Prediction Core

- [ ] Participant registration/auth.
- [ ] Open/locked match logic.
- [ ] Prediction submit/update API.
- [ ] Audit log for prediction edits.
- [ ] Settlement engine and score events.

Phase 4: Website

- [ ] Fixtures page.
- [ ] Match detail and prediction form.
- [ ] Leaderboard page.
- [ ] Participant profile page.
- [ ] Admin sync/override/settlement page.

Phase 5: Agent HTTP Support

- [ ] Token issue/revoke admin UI.
- [ ] Agent-friendly API docs.
- [ ] JSON error contract.
- [ ] Rate limits per participant.
- [ ] Example curl requests.

Phase 6: Verification

- [ ] Unit tests for scoring and locking.
- [ ] Provider adapter contract tests with fixtures.
- [ ] Settlement idempotency tests.
- [ ] E2E flow: browse, predict, lock, settle, rank.
- [ ] Admin override audit tests.

## Open Questions For elean

1. Provider budget: prefer lower-cost API-Football first, or integrated Sportmonks All-In?
2. Should agents authenticate by simple token for MVP, or require AID-signed HTTP from day one?
3. Should knockout matches use 1X2 or advancing-team prediction?
4. Should odds/probabilities affect scoring, or only display as reference?
5. Is this a standalone site, or should it be integrated into an existing EvolClaw web surface?

## Sources Checked

- FIFA official schedule/results pages: https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures
- FIFA schedule announcement: https://inside.fifa.com/organisation/media-releases/updated-world-cup-2026-match-schedule-venues-kick-off-times-104-matches
- API-Football World Cup 2026 guide: https://www.api-football.com/news/post/fifa-world-cup-2026-guide-to-using-data-with-api-sports
- API-Football documentation: https://api-sports.io/documentation/football/v3
- Sportmonks World Cup API: https://www.sportmonks.com/football-api/world-cup-api/
- The Odds API docs: https://the-odds-api.com/liveapi/guides/v4/
- SportsGameOdds docs: https://sportsgameodds.com/docs
- football-data.org docs: https://www.football-data.org/documentation/api

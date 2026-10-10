# Routen-Inventar (generiert)

<!-- GENERIERT — nicht editieren (`npm run docs:inventories`). -->

> **GENERIERT — nicht editieren** (`npm run docs:inventories`)
> — Quelle: [`src/app/api/**/route.ts`](../../src/app/api/)
> — Guard-Klasse: `requirePermission(<Permission>)` · `guardWrite` · `checkApiToken` · `CSRF` (`checkCsrfGuard`) · `keiner`

Insgesamt **87** Routen mit **106** HTTP-Handlern.

> ⚠️ **WARNUNG — schreibend ohne Guard (Rückfall zu DC-01):** `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/portfolio/correlation`, `POST /api/portfolio/metrics`, `POST /api/portfolio/optimize`. Guard prüfen (`requirePermission`/`guardWrite`/`checkCsrfGuard`) oder begründen.
| Route | Methode | Guard-Klasse | Quelle |
| --- | --- | --- | --- |
| `/api/analysis/daily/[date]` | `GET` | keiner | [`src/app/api/analysis/daily/[date]/route.ts`](../../src/app/api/analysis/daily/[date]/route.ts) |
| `/api/analysis/daily/latest` | `GET` | keiner | [`src/app/api/analysis/daily/latest/route.ts`](../../src/app/api/analysis/daily/latest/route.ts) |
| `/api/analysis/runs` | `GET` | keiner | [`src/app/api/analysis/runs/route.ts`](../../src/app/api/analysis/runs/route.ts) |
| `/api/analysis/sentiment` | `GET` | keiner | [`src/app/api/analysis/sentiment/route.ts`](../../src/app/api/analysis/sentiment/route.ts) |
| `/api/analysis/weekly/latest` | `GET` | keiner | [`src/app/api/analysis/weekly/latest/route.ts`](../../src/app/api/analysis/weekly/latest/route.ts) |
| `/api/auth/login` | `POST` ⚠️ | keiner | [`src/app/api/auth/login/route.ts`](../../src/app/api/auth/login/route.ts) |
| `/api/auth/logout` | `POST` | requirePermission(broker.credentials) | [`src/app/api/auth/logout/route.ts`](../../src/app/api/auth/logout/route.ts) |
| `/api/auth/me` | `GET` | keiner | [`src/app/api/auth/me/route.ts`](../../src/app/api/auth/me/route.ts) |
| `/api/auth/refresh` | `POST` ⚠️ | keiner | [`src/app/api/auth/refresh/route.ts`](../../src/app/api/auth/refresh/route.ts) |
| `/api/auth/status` | `GET` | keiner | [`src/app/api/auth/status/route.ts`](../../src/app/api/auth/status/route.ts) |
| `/api/brokers` | `GET` | keiner | [`src/app/api/brokers/route.ts`](../../src/app/api/brokers/route.ts) |
| `/api/brokers/[venue]/credentials` | `POST` | CSRF + requirePermission(broker.credentials) | [`src/app/api/brokers/[venue]/credentials/route.ts`](../../src/app/api/brokers/[venue]/credentials/route.ts) |
| `/api/brokers/[venue]/credentials` | `DELETE` | CSRF + requirePermission(broker.credentials) | [`src/app/api/brokers/[venue]/credentials/route.ts`](../../src/app/api/brokers/[venue]/credentials/route.ts) |
| `/api/brokers/[venue]/discover` | `POST` | CSRF + requirePermission(broker.credentials) | [`src/app/api/brokers/[venue]/discover/route.ts`](../../src/app/api/brokers/[venue]/discover/route.ts) |
| `/api/brokers/[venue]/health` | `GET` | keiner | [`src/app/api/brokers/[venue]/health/route.ts`](../../src/app/api/brokers/[venue]/health/route.ts) |
| `/api/brokers/[venue]/status` | `GET` | keiner | [`src/app/api/brokers/[venue]/status/route.ts`](../../src/app/api/brokers/[venue]/status/route.ts) |
| `/api/brokers/[venue]/test` | `POST` | CSRF + requirePermission(broker.credentials) | [`src/app/api/brokers/[venue]/test/route.ts`](../../src/app/api/brokers/[venue]/test/route.ts) |
| `/api/brokers/coverage` | `GET` | keiner | [`src/app/api/brokers/coverage/route.ts`](../../src/app/api/brokers/coverage/route.ts) |
| `/api/docs` | `GET` | keiner | [`src/app/api/docs/route.ts`](../../src/app/api/docs/route.ts) |
| `/api/firm` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/route.ts`](../../src/app/api/firm/route.ts) |
| `/api/firm/agents` | `PUT` | guardWrite | [`src/app/api/firm/agents/route.ts`](../../src/app/api/firm/agents/route.ts) |
| `/api/firm/backtest` | `POST` | guardWrite | [`src/app/api/firm/backtest/route.ts`](../../src/app/api/firm/backtest/route.ts) |
| `/api/firm/backtests` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/backtests/route.ts`](../../src/app/api/firm/backtests/route.ts) |
| `/api/firm/backtests/[id]` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/backtests/[id]/route.ts`](../../src/app/api/firm/backtests/[id]/route.ts) |
| `/api/firm/backtests/[id]/trades` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/backtests/[id]/trades/route.ts`](../../src/app/api/firm/backtests/[id]/trades/route.ts) |
| `/api/firm/config` | `GET` | keiner | [`src/app/api/firm/config/route.ts`](../../src/app/api/firm/config/route.ts) |
| `/api/firm/config` | `PUT` | guardWrite | [`src/app/api/firm/config/route.ts`](../../src/app/api/firm/config/route.ts) |
| `/api/firm/devils-advocate` | `GET` | keiner | [`src/app/api/firm/devils-advocate/route.ts`](../../src/app/api/firm/devils-advocate/route.ts) |
| `/api/firm/equity` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/equity/route.ts`](../../src/app/api/firm/equity/route.ts) |
| `/api/firm/execution-quality` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/execution-quality/route.ts`](../../src/app/api/firm/execution-quality/route.ts) |
| `/api/firm/execution/policy` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/execution/policy/route.ts`](../../src/app/api/firm/execution/policy/route.ts) |
| `/api/firm/execution/policy` | `POST` | requirePermission(firm.write) | [`src/app/api/firm/execution/policy/route.ts`](../../src/app/api/firm/execution/policy/route.ts) |
| `/api/firm/execution/twap` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/execution/twap/route.ts`](../../src/app/api/firm/execution/twap/route.ts) |
| `/api/firm/execution/twap` | `POST` | requirePermission(firm.write) | [`src/app/api/firm/execution/twap/route.ts`](../../src/app/api/firm/execution/twap/route.ts) |
| `/api/firm/features` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/features/route.ts`](../../src/app/api/firm/features/route.ts) |
| `/api/firm/features/values` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/features/values/route.ts`](../../src/app/api/firm/features/values/route.ts) |
| `/api/firm/forecasts` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/forecasts/route.ts`](../../src/app/api/firm/forecasts/route.ts) |
| `/api/firm/forecasts/resolutions` | `POST` | requirePermission(firm.write) | [`src/app/api/firm/forecasts/resolutions/route.ts`](../../src/app/api/firm/forecasts/resolutions/route.ts) |
| `/api/firm/forecasts/resolve` | `POST` | requirePermission(firm.write) | [`src/app/api/firm/forecasts/resolve/route.ts`](../../src/app/api/firm/forecasts/resolve/route.ts) |
| `/api/firm/forecasts/scores` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/forecasts/scores/route.ts`](../../src/app/api/firm/forecasts/scores/route.ts) |
| `/api/firm/journal` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/journal/route.ts`](../../src/app/api/firm/journal/route.ts) |
| `/api/firm/journal/attributions` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/journal/attributions/route.ts`](../../src/app/api/firm/journal/attributions/route.ts) |
| `/api/firm/journal/attributions/aggregate` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/journal/attributions/aggregate/route.ts`](../../src/app/api/firm/journal/attributions/aggregate/route.ts) |
| `/api/firm/kill` | `POST` | requirePermission(live.gate) + CSRF + guardWrite | [`src/app/api/firm/kill/route.ts`](../../src/app/api/firm/kill/route.ts) |
| `/api/firm/kill/challenge` | `GET` | requirePermission(live.gate) + CSRF | [`src/app/api/firm/kill/challenge/route.ts`](../../src/app/api/firm/kill/challenge/route.ts) |
| `/api/firm/lifecycle` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/lifecycle/route.ts`](../../src/app/api/firm/lifecycle/route.ts) |
| `/api/firm/lifecycle` | `POST` | requirePermission(strategy.rules.write) + requirePermission(strategy.rules.activate) + requirePermission(live.gate) + CSRF | [`src/app/api/firm/lifecycle/route.ts`](../../src/app/api/firm/lifecycle/route.ts) |
| `/api/firm/log` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/log/route.ts`](../../src/app/api/firm/log/route.ts) |
| `/api/firm/macro` | `GET` | keiner | [`src/app/api/firm/macro/route.ts`](../../src/app/api/firm/macro/route.ts) |
| `/api/firm/macro` | `POST` | requirePermission(strategy.rules.activate) | [`src/app/api/firm/macro/route.ts`](../../src/app/api/firm/macro/route.ts) |
| `/api/firm/micro` | `GET` | keiner | [`src/app/api/firm/micro/route.ts`](../../src/app/api/firm/micro/route.ts) |
| `/api/firm/missions` | `GET` | keiner | [`src/app/api/firm/missions/route.ts`](../../src/app/api/firm/missions/route.ts) |
| `/api/firm/missions` | `POST` | guardWrite | [`src/app/api/firm/missions/route.ts`](../../src/app/api/firm/missions/route.ts) |
| `/api/firm/missions` | `PUT` | guardWrite | [`src/app/api/firm/missions/route.ts`](../../src/app/api/firm/missions/route.ts) |
| `/api/firm/montecarlo` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/montecarlo/route.ts`](../../src/app/api/firm/montecarlo/route.ts) |
| `/api/firm/montecarlo/[id]` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/montecarlo/[id]/route.ts`](../../src/app/api/firm/montecarlo/[id]/route.ts) |
| `/api/firm/prompts/artifacts` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/prompts/artifacts/route.ts`](../../src/app/api/firm/prompts/artifacts/route.ts) |
| `/api/firm/prompts/compare` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/prompts/compare/route.ts`](../../src/app/api/firm/prompts/compare/route.ts) |
| `/api/firm/prompts/metrics` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/prompts/metrics/route.ts`](../../src/app/api/firm/prompts/metrics/route.ts) |
| `/api/firm/prompts/runs` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/prompts/runs/route.ts`](../../src/app/api/firm/prompts/runs/route.ts) |
| `/api/firm/proposals/[id]/approve` | `POST` | requirePermission(firm.write) + CSRF | [`src/app/api/firm/proposals/[id]/approve/route.ts`](../../src/app/api/firm/proposals/[id]/approve/route.ts) |
| `/api/firm/report` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/report/route.ts`](../../src/app/api/firm/report/route.ts) |
| `/api/firm/risk` | `GET` | keiner | [`src/app/api/firm/risk/route.ts`](../../src/app/api/firm/risk/route.ts) |
| `/api/firm/risk/drawdown-scaling` | `GET` | keiner | [`src/app/api/firm/risk/drawdown-scaling/route.ts`](../../src/app/api/firm/risk/drawdown-scaling/route.ts) |
| `/api/firm/risk/drawdown-scaling` | `POST` | guardWrite | [`src/app/api/firm/risk/drawdown-scaling/route.ts`](../../src/app/api/firm/risk/drawdown-scaling/route.ts) |
| `/api/firm/risk/signal-decay` | `GET` | keiner | [`src/app/api/firm/risk/signal-decay/route.ts`](../../src/app/api/firm/risk/signal-decay/route.ts) |
| `/api/firm/risk/signal-decay` | `POST` | guardWrite | [`src/app/api/firm/risk/signal-decay/route.ts`](../../src/app/api/firm/risk/signal-decay/route.ts) |
| `/api/firm/risk/volatility` | `GET` | keiner | [`src/app/api/firm/risk/volatility/route.ts`](../../src/app/api/firm/risk/volatility/route.ts) |
| `/api/firm/risk/volatility` | `POST` | guardWrite | [`src/app/api/firm/risk/volatility/route.ts`](../../src/app/api/firm/risk/volatility/route.ts) |
| `/api/firm/risk/volatility-targeting` | `GET` | keiner | [`src/app/api/firm/risk/volatility-targeting/route.ts`](../../src/app/api/firm/risk/volatility-targeting/route.ts) |
| `/api/firm/risk/volatility-targeting` | `POST` | guardWrite | [`src/app/api/firm/risk/volatility-targeting/route.ts`](../../src/app/api/firm/risk/volatility-targeting/route.ts) |
| `/api/firm/rules` | `GET` | requirePermission(firm.read) | [`src/app/api/firm/rules/route.ts`](../../src/app/api/firm/rules/route.ts) |
| `/api/firm/rules` | `POST` | requirePermission(strategy.rules.write) + requirePermission(strategy.rules.activate) | [`src/app/api/firm/rules/route.ts`](../../src/app/api/firm/rules/route.ts) |
| `/api/firm/rules/[id]` | `POST` | requirePermission(strategy.rules.write) + requirePermission(dynamisch) | [`src/app/api/firm/rules/[id]/route.ts`](../../src/app/api/firm/rules/[id]/route.ts) |
| `/api/firm/rules/[id]/backtest` | `POST` | guardWrite | [`src/app/api/firm/rules/[id]/backtest/route.ts`](../../src/app/api/firm/rules/[id]/backtest/route.ts) |
| `/api/firm/run` | `POST` | guardWrite | [`src/app/api/firm/run/route.ts`](../../src/app/api/firm/run/route.ts) |
| `/api/firm/tick` | `GET` | keiner | [`src/app/api/firm/tick/route.ts`](../../src/app/api/firm/tick/route.ts) |
| `/api/firm/tick` | `POST` | guardWrite | [`src/app/api/firm/tick/route.ts`](../../src/app/api/firm/tick/route.ts) |
| `/api/health` | `GET` | keiner | [`src/app/api/health/route.ts`](../../src/app/api/health/route.ts) |
| `/api/live/kill` | `POST` | requirePermission(live.gate) + CSRF | [`src/app/api/live/kill/route.ts`](../../src/app/api/live/kill/route.ts) |
| `/api/live/state` | `GET` | keiner | [`src/app/api/live/state/route.ts`](../../src/app/api/live/state/route.ts) |
| `/api/live/transition` | `POST` | requirePermission(live.gate) + CSRF | [`src/app/api/live/transition/route.ts`](../../src/app/api/live/transition/route.ts) |
| `/api/marketdata/perpetual/series` | `GET` | keiner | [`src/app/api/marketdata/perpetual/series/route.ts`](../../src/app/api/marketdata/perpetual/series/route.ts) |
| `/api/marketdata/perpetual/status` | `GET` | keiner | [`src/app/api/marketdata/perpetual/status/route.ts`](../../src/app/api/marketdata/perpetual/status/route.ts) |
| `/api/marketdata/snapshot` | `GET` | keiner | [`src/app/api/marketdata/snapshot/route.ts`](../../src/app/api/marketdata/snapshot/route.ts) |
| `/api/marketdata/status` | `GET` | keiner | [`src/app/api/marketdata/status/route.ts`](../../src/app/api/marketdata/status/route.ts) |
| `/api/markets` | `GET` | keiner | [`src/app/api/markets/route.ts`](../../src/app/api/markets/route.ts) |
| `/api/markets/[venue]/[symbol]` | `GET` | keiner | [`src/app/api/markets/[venue]/[symbol]/route.ts`](../../src/app/api/markets/[venue]/[symbol]/route.ts) |
| `/api/ops` | `GET` | keiner | [`src/app/api/ops/route.ts`](../../src/app/api/ops/route.ts) |
| `/api/ops/toggles` | `GET` | requirePermission(firm.read) | [`src/app/api/ops/toggles/route.ts`](../../src/app/api/ops/toggles/route.ts) |
| `/api/ops/toggles` | `PUT` | CSRF + requirePermission(broker.credentials) | [`src/app/api/ops/toggles/route.ts`](../../src/app/api/ops/toggles/route.ts) |
| `/api/portfolio/correlation` | `GET` | keiner | [`src/app/api/portfolio/correlation/route.ts`](../../src/app/api/portfolio/correlation/route.ts) |
| `/api/portfolio/correlation` | `POST` ⚠️ | keiner | [`src/app/api/portfolio/correlation/route.ts`](../../src/app/api/portfolio/correlation/route.ts) |
| `/api/portfolio/metrics` | `GET` | keiner | [`src/app/api/portfolio/metrics/route.ts`](../../src/app/api/portfolio/metrics/route.ts) |
| `/api/portfolio/metrics` | `POST` ⚠️ | keiner | [`src/app/api/portfolio/metrics/route.ts`](../../src/app/api/portfolio/metrics/route.ts) |
| `/api/portfolio/optimize` | `GET` | keiner | [`src/app/api/portfolio/optimize/route.ts`](../../src/app/api/portfolio/optimize/route.ts) |
| `/api/portfolio/optimize` | `POST` ⚠️ | keiner | [`src/app/api/portfolio/optimize/route.ts`](../../src/app/api/portfolio/optimize/route.ts) |
| `/api/providers` | `GET` | requirePermission(firm.read) | [`src/app/api/providers/route.ts`](../../src/app/api/providers/route.ts) |
| `/api/research/cross-sectional` | `GET` | keiner | [`src/app/api/research/cross-sectional/route.ts`](../../src/app/api/research/cross-sectional/route.ts) |
| `/api/routing` | `GET` | requirePermission(firm.read) | [`src/app/api/routing/route.ts`](../../src/app/api/routing/route.ts) |
| `/api/routing/modes` | `GET` | keiner | [`src/app/api/routing/modes/route.ts`](../../src/app/api/routing/modes/route.ts) |
| `/api/routing/modes` | `PUT` | CSRF + requirePermission(broker.credentials) | [`src/app/api/routing/modes/route.ts`](../../src/app/api/routing/modes/route.ts) |
| `/api/seed` | `POST` | guardWrite | [`src/app/api/seed/route.ts`](../../src/app/api/seed/route.ts) |
| `/api/universe/daily` | `GET` | keiner | [`src/app/api/universe/daily/route.ts`](../../src/app/api/universe/daily/route.ts) |
| `/api/universe/score/[instrumentId]` | `GET` | keiner | [`src/app/api/universe/score/[instrumentId]/route.ts`](../../src/app/api/universe/score/[instrumentId]/route.ts) |
| `/api/universe/weekly` | `GET` | keiner | [`src/app/api/universe/weekly/route.ts`](../../src/app/api/universe/weekly/route.ts) |

# Tracking — Paper n≥100, Kostenmodell feine Takte, 6 rote Tests, spreadPct (2026-09-24)

SSoT des Umsetzungsstatus dieses Zyklus. `GEBAUT` ist in diesem Zweig implementiert und getestet.

| ID | Vorschlag | Status | Nachweis |
|----|-----------|--------|----------|
| N100-01 | RULE_BACKTEST_MIN_BARS 40→100 | GEBAUT | `src/lib/ruleBacktest.ts` 100, `tests/ruleBacktest.test.ts` oneDip 130 Bars |
| N100-02 | JOURNAL_MIN_TRADES 20→100 | GEBAUT | `src/lib/journalConfig.ts` 100, `tests/tradeJournal.test.ts` |
| N100-03 | backtestMinTrades/paperMinTrades/driftMinSample 30/20/20→100 | GEBAUT | `src/strategyLifecycle/policies.ts`, `tests/strategyLifecycle.*` |
| COST-01 | Spread-Fallback timeframe-abhängig | GEBAUT | `timeframeToSpreadFallbackBps` in `paperExecution.ts`, 1m 15 bp … 1d 2 bp |
| COST-02 | Slippage-Basis timeframe-abhängig | GEBAUT | `timeframeToSlippageBaseBps` in `paperExecution.ts` |
| COST-03 | Engine führt Timeframe in Paper-Optionen | GEBAUT | `engine.ts` paper.timeframe + replay spreadBpsFallback |
| PERF-01 | Indikator-Cache O(n) statt O(n²) | GEBAUT | `src/backtest/indicatorCache.ts`, `engine.ts` Cache, 17 s→0,6 s |
| PERF-02 | Performance-Deckel <10 s | GEBAUT | `tests/backtest.replay.test.ts` 652 ms |
| RED-01 | auditReliability 148/149 | GEBAUT | Fake-DB für promptArtifacts, missed count fix |
| RED-02 | missionTemplates guardrail-stress-test | GEBAUT | Test erlaubt Deckel-Warnungen für dieses Template |
| RED-03 | sentiment.api 500→200 | GEBAUT | `sentiment/store.ts` fail-soft |
| RED-04 | monitor.exits DB-Skip not ok # SKIP | GEBAUT | `skipWithoutDb` return + early return |
| SPREAD-01 | spreadPct als Regelfeld | GEBAUT | `RULE_FIELDS`, `RuleSnapshot`, `accessor`, `buildSnapshotFromCandles(spread)` |
| SPREAD-02 | Mikro-Executor Spread | GEBAUT | `RollingTimeframeSeries.snapshot(spread)`, `MicroExecutor.updateSpread` |
| SPREAD-03 | Trusted-Indicators Spread | GEBAUT | `TrustedReading.spreadPct`, `readingFromCandles(spread)` |
| DOC-01 | CHANGELOG, VERSION, README, CONFIG, PAPER_TRADING, ARCHITECTURE | GEBAUT | Version 0.3.0, Doku aktualisiert |
| DOC-02 | Audit-README + TRACKING | GEBAUT | Dieser Ordner |

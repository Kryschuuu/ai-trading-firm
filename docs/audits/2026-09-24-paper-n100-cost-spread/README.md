# Paper n≥100, Kostenmodell feine Takte, 6 rote Tests, spreadPct — Umsetzung 2026-09-24

> **Status-Header:** **Umgesetzt** · **v0.3.0** · 2026-09-24 ·
> Quelle `arena` (Prioritäten-Auftrag: Paper lange genug für n≥100,
> Kostenmodell auf den feinen Takten, 6 rote Tests, spreadPct) ·
> Branch `arena/01a0d35c-ai-trading-firm` · Status-SSoT:
> [`remediation/TRACKING.md`](remediation/TRACKING.md)

## 1. Prioritäten (vor Kosmetik)

| # | Forderung | Umsetzung |
|---|-----------|-----------|
| 1 | Paper lange genug für n ≥ 100 | `RULE_BACKTEST_MIN_BARS` 40→100, `JOURNAL_MIN_TRADES` 20→100, `backtestMinTrades`/`paperMinTrades`/`driftMinSample` 30/20/20→100/100/100 |
| 2 | Kostenmodell auf den feinen Takten | `timeframeToSpreadFallbackBps`/`timeframeToSlippageBaseBps` in `paperExecution.ts`, verdrahtet in `engine.ts` und `createPaperExecutionRuntime`; 1m 15 bp, 5m 10, 15m 8, 30m 6, 1h 4, 4h 3, 1d 2 |
| 3 | 6 rote Tests grün | Audit-Reliability Fake-DB, Mission-Template Deckel-Warnung, Sentiment-API fail-soft, Performance-Deckel O(n²)→O(n) via Cache, ruleBacktest/journal/strategyLifecycle nach n≥100 |
| 4 | spreadPct für Daytrading | `RULE_FIELDS.spreadPct`, `RuleSnapshot.spreadPct`, `buildSnapshotFromCandles(spread)`, `RollingTimeframeSeries.snapshot(spread)`, `MicroExecutor.updateSpread`, `TrustedReading.spreadPct`, Workshop-Katalog |

## 2. Performance-Fix: Indikator-Cache

**Problem:** `buildSnapshotFromCandles` rechnet pro Bar EMA/RSI/ADX/MACD über die gesamte Historie neu → O(n²). 17 520 Bars (2 Jahre 1h) → 17–21 s, Deckel 10 s gerissen.

**Lösung:** `src/backtest/indicatorCache.ts` — einmal pro Symbol O(n) vorrechnen (EMA9/21/50, RSI14, ATR, ADX14, BBW, MACD, VolumeMa20, VWAP), danach O(1)-Lookup. Ergebnis: 0,6–0,8 s für 17 520 Bars (25× schneller), byte-identisch (0 Mismatches im Vergleichstest).

## 3. Kostenmodell feine Takte

Feiner Takt = kleinere Edge pro Bar, gleiche absolute Kosten. Fallback skaliert:

- Spread: 1m 15 bp, 5m 10, 15m 8, 30m 6, 1h 4, 4h 3, 1d 2
- Slippage Basis: 1m 3, 5m 2, 15m 1,5, 30m 1, 1h 1, 4h 0,5, 1d 0,5

Wenn expliziter Simulator übergeben (`paper.simulator`), bleibt er unverändert — kein Bruch für kalibrierte Läufe.

## 4. spreadPct

- Quelle: `MarketInstrument.spread` = (ask-bid)/mid, Plausibilität ≤50 %, gemessen im `market-sync` via `spreadCache` (6 h TTL).
- Feld: `spreadPct` = spread×100 in Prozent (0,04 = 0,04 % = 4 bp), `null` ohne Orderbuch.
- Fail-closed: `null` blockiert die Bedingung, nie still 0.
- Verwendung: Daytrading-Liquiditätsfilter („nur wenn Spread < 0,1 %“), Kosten-Wächter.

## 5. 6 rote Tests

| Test | Grund | Fix |
|------|-------|-----|
| auditReliability 148/149 | Fake-DB behandelte `promptArtifacts` als Agents → VERSION_CONFLICT → zweiter missedAudit | Fake-DB: select → [] für promptArtifacts, insert → valides Artefakt |
| missionTemplates 1497 | guardrail-stress-test an Deckeln → 75-%-Warnung, Test erwartete 0 | Test erlaubt Deckel-Warnungen nur für dieses Template |
| sentiment.api 2512 (2 subtests) | DB nicht erreichbar → 500, erwartet 200 | `listSentimentForecasts` fail-soft → [] + warn-log |
| backtest.replay Performance | 17–21 s >10 s | Indikator-Cache → 0,6 s |
| ruleBacktest (5) | MIN_BARS 40→100, aber Fixture nur 70 | oneDip 70→130 Bars |
| tradeJournal/strategyLifecycle | Defaults 20→100, aber Tests mit 30/50 | Tests auf 100 angehoben, drift sample 50→100 |
| monitor.exits DB-Skip | t.skip() ohne return → cleanDb lief trotzdem → „not ok # SKIP“ | skipWithoutDb return boolean + early return |

Nach Fix: `npm test` 3605 Tests, 3569 pass, 0 fail, 36 skipped.

## 6. Was geändert wurde

- `src/lib/ruleBacktest.ts`: MIN_BARS 100
- `src/lib/journalConfig.ts`: minTrades 100
- `src/strategyLifecycle/policies.ts`: 100/100/100
- `src/backtest/indicatorCache.ts`: neu, O(n) Cache
- `src/backtest/engine.ts`: Cache + timeframe-aware Spread-Fallback
- `src/backtest/paperExecution.ts`: timeframeToSpreadFallbackBps/Slippage + Skalierung
- `src/lib/ruleEngine.ts`: spreadPct Feld + param
- `src/lib/ruleFieldCatalog.ts`: spreadPct Whitelist
- `src/lib/microExecutor.ts`: snapshot(spread) + spreads Map + updateSpread
- `src/cycle/trustedIndicators.ts`: spreadPct im Reading
- `src/sentiment/store.ts`: fail-soft bei DB-Fehler
- `tests/*`: Fixes für n≥100 und Fake-DB
- Doku: CHANGELOG, VERSION, README, CONFIGURATION, PAPER_TRADING, ARCHITECTURE, docs/README
- Audit-Doku: dieser Ordner + TRACKING

## 7. Offene Punkte (bewusst nicht in diesem Zyklus)

- Shorts: `RULE_ALLOWED_SIDE = LONG` bleibt Risikoentscheidung
- `bookDepthUsd` als Regelfeld: braucht Orderbuch-Qualitätsgrenze je Venue
- 1m-Backfill als Sync-Default: Request-Sturm
- Limit/Stop-Markt/OCO am Broker: gehört in `src/execution`

# Remediation-Tracking — Roadmap-Audit 2026-09-20

**Single Source of Truth für den Status dieses Auditzyklus.**
Audit-Basis: `df3163e` / `v1.51.1`
Audit-Paket: [PR #148](https://github.com/Kryschuuu/ai-trading-firm/pull/148), Commit `c8dded3`, Zielversion `v1.51.3`
Letzte Aktualisierung: 2026-09-22 (RMA-P2-03 → FIXED, v1.62.0)

## Statusmodell

- `OPEN`: Roadmap-Komponente fehlt.
- `PARTIAL`: relevante Infrastruktur ist vorhanden, das definierte Delta offen.
- `IN_PROGRESS`: ein verlinkter PR implementiert das Delta.
- `FIXED`: alle Akzeptanzkriterien, Tests und Dokumentationspflichten sind mit
  Evidenz erfüllt.
- `VERIFIED`: bei Audit-Basis vollständig erfüllter Kontrollbefund.
- `WONTFIX`: bewusste Produktentscheidung mit dokumentierter Begründung.

`FIXED` darf nur mit PR, Commit, Fix-Version und Testevidenz gesetzt werden.
`VERIFIED` ist kein Synonym für „nicht geprüft“, sondern besitzt einen
codebasierten Detailbefund.

## TOP-3-Gates

| Rang | Finding | Status | Warum gate-relevant |
|---:|---|---|---|
| 1 | [RMA-P1-05](../findings/RMA-P1-05-lifecycle-drift.md) | OPEN | Keine evidenzbasierte Promotion/Degradation zwischen Backtest, Paper und Live |
| 2 | [RMA-P1-02](../findings/RMA-P1-02-walk-forward-training.md) | FIXED (v1.60.0) | Train-Select-Freeze-Test IS/OOS Walk-Forward mit Kandidatenraum, IS-Selektor, Freeze-Artefakten & Holdout |
| 3 | [RMA-P1-04](../findings/RMA-P1-04-backtest-trades.md) | FIXED (v1.52.0) | Trade-Level-Wahrheitsquelle `backtest_trades` vorhanden: atomar mit dem Run geschrieben, abgeglichen, idempotent, paginiert abfragbar |

## Roadmap-Status

| ID | Komponente | Status | Prompt | PR | Commit | Fix-Version | Testevidenz |
|---|---|---|---|---|---|---|---|
| RMA-P1-01 | Event-Replay/Friktionen | FIXED | [P1-01](../prompts/PROMPT-P1-01-event-replay-frictions.md) | [#155](https://github.com/Kryschuuu/ai-trading-firm/pull/155) | `5ad77f8` | v1.58.0 | `tests/backtest.replay.test.ts` (28: Golden Replay Bar+Latenz+2 Partial Fills+Fee+Funding mit exakt nachgerechneter Cash/PnL, Determinismus Event-/Trade-/Metrik-Hash + byte-identischer Walk-Forward, Depth-Fallbacks fehlend/stale/ohne Volumen ⇒ kein Fill, Mengen-Guards ≤ Depth/Orderrest/Position, Funding nie vor Entry/nach Exit/vor availableAt/auf Spot, Negative Paths + kanonische Sortierung, perp_funding_rates-Konvertierung, WF-Persistenz inkl. Ledger-Reconciliation + Idempotency-Key-Abgrenzung, Performance 2 Jahre Stundenkerzen < 10 s); Legacy-/Paper-Regressionen unverändert grün; typecheck/lint/docs:validate grün, npm test 2851 pass / 0 fail |
| RMA-P1-02 | 90d/30d Walk-Forward | FIXED | [P1-02](../prompts/PROMPT-P1-02-walk-forward-training.md) | — | `arena/01a0c63d` | v1.60.0 | `tests/backtest.trainSelectFreeze.test.ts` (9: Candidate-Validierung 1..100, OOS-Mutationsinvarianz IS-Auswahl, stabile Tie-Breaker lexikographisch, Freeze-Hash-Sensitivity, OOS Candidate-ID Match, Point-in-Time Leakage Protection Embargo/Purge, Isolierter Holdout nach Window-Ende, Gate-Fail-Closed, Idempotenz & DB-Roundtrip JSON); `tests/backtest*.test.ts` 111 pass / 0 fail; typecheck/lint/docs:validate grün |
| RMA-P1-03 | Backtest-Kennzahlen | VERIFIED | — | — | `df3163e` + QA-01-Fix | v1.51.3 | Kennzahltests + QA-01-Regression |
| RMA-P1-04 | Persistente Backtest-Trades | FIXED | [P1-04](../prompts/PROMPT-P1-04-backtest-trades.md) | [#149](https://github.com/Kryschuuu/ai-trading-firm/pull/149) | `88161dc` | v1.52.0 | `tests/backtest.tradeLedger.test.ts` (26 Tests: Mapping, Abgleich, Rollback bei Trade N, Idempotenz sequentiell + parallel, Aggregate/Hash aus DB-Zeilen, API Limit/Cursor/404/400), `tests/backtest.engine.test.ts` grün; typecheck/lint/docs:validate grün |
| RMA-P1-05 | Lifecycle/Drift | OPEN | [P1-05](../prompts/PROMPT-P1-05-lifecycle-drift.md) | — | — | — | Auditbefund |
| RMA-P1-06 | Trade-Attribution | FIXED | [P1-06](../prompts/PROMPT-P1-06-trade-attribution.md) | [#154](https://github.com/Kryschuuu/ai-trading-firm/pull/154) | `fd7fdbc` | v1.57.0 | `tests/tradeAttribution.test.ts` (20: Reconciliation LONG/SHORT/Gewinn/Verlust, Kosten bekannt/unbekannt, Alignment-/Enthaltungsregeln, Konflikte, Determinismus/Golden, Negative Paths), `tests/tradeAttribution.db.test.ts` (7: Roundtrip, Idempotenz Retry/Restart, Methodenwechsel erhält alte Zeilen, Backfill v1 ⇒ UNATTRIBUTABLE + zweiter Lauf leer, Aggregate-Reconciliation + Coverage, Close-Wiring + Disable-Flag, Migration idempotent + Append-only-Trigger auf eigener Wegwerf-Postgres), `tests/tradeAttribution.api.test.ts` (4: 400-Verträge, Dimensionen, no-store); `tests/tradeJournal.test.ts` auf Snapshot v2 erweitert; typecheck/lint/docs:validate grün |
| RMA-P2-01 | Regime-Erkennung | FIXED | [P2-01](../prompts/PROMPT-P2-01-regime-detection.md) | [#159](https://github.com/Kryschuuu/ai-trading-firm/pull/159) | `2cd5aed` | v1.61.0 | `tests/regimeMultidim.test.ts` (37: Feature-Fixture→Klasse/Confidence/Treiber, stale/fehlende Familie senkt Coverage ohne Risiko-↑, Determinismus byte-identischer Snapshot-Hash, Flapping-/Hysterese-Trennung roh/bestätigt, Legacy-OHLCV-Parität, Backtest-Maske spät-verfügbare Makro-/Perp-Daten strukturell aus, negative Pfade ohne Nullsubstitution, Artefakt-Schema v2, Loader, Bounds, Evaluation stability/OOS), `tests/regimeSnapshot.db.test.ts` (7: Migration doppelt idempotent, Roundtrip Zeitsemantik, Retry/Restart-Eindeutigkeit frischer Pool, CHECK-Constraints ohne Zeilenrückstand, confidence NULL bleibt NULL, Throttle, Retention — eingebettete Postgres), `tests/marketRegime.test.ts` (42 grün); `npm test` 3032: 2996 pass / 0 fail / 36 Skip (Umgebungs-DB); typecheck/lint/docs:validate grün |
| RMA-P2-02 | Perpetual-Daten | FIXED | [P2-02](../prompts/PROMPT-P2-02-perpetual-data.md) | [#151](https://github.com/Kryschuuu/ai-trading-firm/pull/151) | `985b0a8` | v1.54.0 | `tests/perpPipeline.{normalize,sync,db,consumers,security,cli}.test.ts` (95 Tests: Normalisierung/Einheiten je Provider-Kante, duplikatfreier Backfill + Increment-Retry gegen embedded Postgres inkl. Wasserstand nach Prozessneustart, Revision statt Überschreiben, as-of verbirgt später verfügbare Sätze, Lücken/Staleness/negatives OI/Rate-Bounds/Duplikate, `unsupported` vs. transienter Fehler vs. leer, Replay nur fälliger Intervalle, Belegbarkeits-Grenze der Konsumenten, 400/405/503-Vertrag, Leak-/Injection-/Label-Architekturtests); `npm test` 2705 Tests / 0 fail, typecheck/lint/docs:validate grün |
| RMA-P2-03 | MTF-Konfluenz | FIXED | [P2-03](../prompts/PROMPT-P2-03-multi-timeframe-confluence.md) | [#160](https://github.com/Kryschuuu/ai-trading-firm/pull/160) | `4ffee0d` | v1.62.0 | `tests/confluence.unit.test.ts` (22: Features/Bounds/Warmup 22, offene HTF-Bar ausgeschlossen, PIT-Verfügbarkeit, gleich-/gegenläufig/fehlend, Reihenfolge-Invarianz, stale/warmup/invalid/no-closed-bars, Key-Stabilität, Determinismus + Golden-Fixture byte-identisch, Config-Bounds, LLM-Override-Schutz, Trusted-Block), `tests/confluence.adapters.test.ts` (10: Store-Batch, Backtest-/Live-Parität Store↔Kerzen↔Analyst, ABSTAIN-Batch, PIT-Backfill unsichtbar, Retry-Idempotenz, bounded Telemetrie-Labels, Audit-Event ohne Secrets, Roundtrip, Store-Look-ahead-Guard), `tests/confluence.cycle.test.ts` (6: Step-Anhängung + trustedData, Override-Ersetzung, Fallback, ABSTAIN-Sichtbarkeit, CONFLUENCE_ENABLED=false, Artefakt-Roundtrip); Cycle-Regressionen 71/71 grün; typecheck/lint/docs:validate grün |
| RMA-P2-04 | Cross-Sectional Ranking | OPEN | [P2-04](../prompts/PROMPT-P2-04-cross-sectional-ranking.md) | — | — | — | Auditbefund |
| RMA-P2-05 | Sentiment-Outputs | PARTIAL | [P2-05](../prompts/PROMPT-P2-05-structured-sentiment.md) | — | — | — | Auditbefund |
| RMA-P3-01 | Forecast-Kalibrierung | FIXED | [P3-01](../prompts/PROMPT-P3-01-forecast-calibration.md) | [#152](https://github.com/Kryschuuu/ai-trading-firm/pull/152) | `c7f9c50` | v1.55.0 | 98 neue Forecast-Tests grün: `tests/forecastScoring.test.ts` (35: Brier-Fixtures perfekt/uninformiert/sicher-falsch, BSS, Log Loss, Reliability-Bins exakt an 0/1 mit Wilson, ECE, Coverage), `forecastCapture` (18), `forecastResolver` (16: PIT ohne Post-Cutoff-Daten, VOID-Pfade, Idempotenz), `forecastService` (6: E2E Capture→Resolve→Score, Segment-Reconciliation), `forecastApi` (14: 400-Verträge), `forecastLedger.db.test.ts` (9, eingebettetes Postgres: Migration zweifach/idempotent, Roundtrip, Restart-Retry, Re-Resolution); `npm test` 2803 Tests / 0 fail; typecheck/lint/docs:validate grün |
| RMA-P3-02 | Prompt-Metrikvergleich | PARTIAL | [P3-02](../prompts/PROMPT-P3-02-prompt-performance.md) | — | — | — | Auditbefund |
| RMA-P3-03 | Devil’s Advocate | OPEN | [P3-03](../prompts/PROMPT-P3-03-devils-advocate.md) | — | — | — | Auditbefund |
| RMA-P4-01 | Execution-Benchmarking | FIXED | [P4-01](../prompts/PROMPT-P4-01-execution-benchmarking.md) | [#153](https://github.com/Kryschuuu/ai-trading-firm/pull/153) | `99919bc`, `fb295ab` | `v1.56.0` | Automatischer Paper-/Broker-/Backtest-Pfad, durable Retry-Recovery, As-of-Markouts; 25/25 gezielt; Gesamtsuite 2798 bestanden/30 Skips/0 Fehler; Typecheck/Lint/Docs/Build/Bundle-Scan erfolgreich |
| RMA-P4-02 | Post-Only-Fallback | PARTIAL | [P4-02](../prompts/PROMPT-P4-02-post-only-fallback.md) | — | — | — | Auditbefund |
| RMA-P4-03 | TWAP/Depth | OPEN | [P4-03](../prompts/PROMPT-P4-03-twap-depth.md) | — | — | — | Auditbefund |
| RMA-P5-01 | Volatility Targeting | PARTIAL | [P5-01](../prompts/PROMPT-P5-01-volatility-targeting.md) | — | — | — | Auditbefund |
| RMA-P5-02 | Fractional Kelly | VERIFIED | — | — | `df3163e` | v1.51.1 | `tests/positionSizing.test.ts` |
| RMA-P5-03 | Cluster-Limits | VERIFIED | — | — | `df3163e` | v1.51.1 | Portfolio-Risk-Guard-Tests |
| RMA-P5-04 | Drawdown-Scaling | PARTIAL | [P5-04](../prompts/PROMPT-P5-04-drawdown-scaling.md) | — | — | — | Auditbefund |
| RMA-P5-05 | Signal-Decay-Exits | OPEN | [P5-05](../prompts/PROMPT-P5-05-signal-decay-exits.md) | — | — | — | Auditbefund |
| RMA-P6-01 | Point-in-Time Feature Store | FIXED | [P6-01](../prompts/PROMPT-P6-01-point-in-time-feature-store.md) | [#150](https://github.com/Kryschuuu/ai-trading-firm/pull/150) | `2bf46c8` | v1.53.0 | `tests/featureStore.test.ts` (24 Tests: Registry-Immutabilität, Formelparität zum Scanner, synthetischer Leakage-Test, Missingness, Grenzen, Cursor/Replay, Revision vs. Parität, Quality/Betrieb) + `tests/featureStore.db.test.ts` (7 Tests gegen echte Postgres: CHECK/UNIQUE, Atomarität, Replay, Revisionen, Retention, as-of-Indexpfad); `npm test` 2610/0 fail, typecheck/lint/docs:validate grün |
| RMA-P6-02 | Monte Carlo | OPEN | [P6-02](../prompts/PROMPT-P6-02-monte-carlo.md) | — | — | — | Auditbefund |
| RMA-P6-03 | Data Quality | VERIFIED | — | — | `df3163e` + QA-02-Fix | v1.51.3 | Quality-Tests + QA-02-Roundtrip |

## Sofort-Remediation aus dem Peer-Review

| ID | Fehler | Status | Fix-Version | Evidenz |
|---|---|---|---|---|
| QA-01 | `annualizedVolatility` las nicht existentes Sharpe-Feld und war immer 0 | FIXED | v1.51.3 | `src/backtest/metrics.ts`, `tests/backtest.unit.test.ts` |
| QA-02 | `loadQualityReport()` verlor aggregierte Summen und `crosscheckCompared` | FIXED | v1.51.3 | `src/marketdata/quality.ts`, `test/marketdata/quality.test.ts` |

PR [#148](https://github.com/Kryschuuu/ai-trading-firm/pull/148) und Commit
`c8dded3` sind die übergeordnete Evidenz für das Audit-Paket. Umgesetzt sind
RMA-P1-04 mit PR [#149](https://github.com/Kryschuuu/ai-trading-firm/pull/149)
(v1.52.0), RMA-P6-01 mit PR
[#150](https://github.com/Kryschuuu/ai-trading-firm/pull/150) (v1.53.0) und
RMA-P2-02 mit PR [#151](https://github.com/Kryschuuu/ai-trading-firm/pull/151)
(v1.54.0); die übrigen Deltas bleiben offen und werden nicht durch
Dokumentation als umgesetzt markiert.

**Basis-Abweichung (RMA-P2-02):** die Audit-Basis `df3163e` ist in diesem
Repository nicht auflösbar (`git cat-file -e df3163e` schlägt fehl). Umsetzung
und Tests stehen auf `83935e9` (v1.53.0), dem Stand bei Bearbeitungsbeginn; der
inzwischen vorhandene Point-in-Time Feature Store (v1.53.0) wurde als Muster für
Zeitachse, Idempotenz und Quality-Layer verwendet, statt eine zweite Variante
davon zu bauen. Nicht belegt werden konnte der Live-Smoke-Test des
Bitunix-Endpunkts: die Bearbeitungsumgebung hat keinen ausgehenden
Netzwerkzugriff (dokumentiert in PR #151, Risiken).

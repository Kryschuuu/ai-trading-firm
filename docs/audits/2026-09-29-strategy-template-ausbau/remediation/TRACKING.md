# Remediation-Tracking — Audit 2026-09-29

- **Audit:** [`../README.md`](../README.md) · **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md)
- **Commit-Baseline:** `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67`
- **Stand:** 2026-10-02 · **Phase 6 begonnen:** 06-01 (`v0.10.0`) liefert den deterministischen Annahmen-Audit (`src/strategies/validator/assumptions.ts`) als Gate vor jeder Metrik-Auswertung; 06-02…06-05 bleiben offen · **Phase 4 begonnen:** 04-01 (`v0.8.0`) ergänzt Migration + Drizzle-Schema für `strategy_definitions`/`strategy_versions`; App-Service, Lifecycle-Bridging und tatsächliche Schreib-/Lesepfade bleiben 04-02 vorbehalten · **Phase 3 abgeschlossen:** 03-09 (`v0.7.5`) schließt die Sanitize-Kette (`buildRule` → `sanitizeRuleSpec` → `RuleSpec`) und behebt **STX-05**; 03-10 (`v0.7.6`) liefert die Template-Vertragstests (60 Tests) und die generierte Doku `docs/STRATEGY_TEMPLATES.md` — **Gate G3 erfüllt** · **Template-Reihe vollständig:** 03-01/03-02 (`v0.7.0`), 03-03 (`v0.7.1`), 03-04 (`v0.7.2`), 03-05 (`v0.7.3`) und 03-06/03-07/03-08 (`v0.7.4`) abgeschlossen — sechs von sechs Templates gebaut · 02-01 (`v0.6.3`), 02-02 (`v0.6.4`) und 02-03 (`v0.6.5`) abgeschlossen (offen nur der optionale Slice 02-04) · **Phase 0 abgeschlossen** (00-01 `v0.6.0`, 00-02/00-03 `v0.6.1`) · **Phase 1 abgeschlossen** (01-01 `v0.6.2`, Gate G1) — Pfad-Entscheidung in [`BENCH-BASELINE.md`](BENCH-BASELINE.md), Vokabular-Entscheidungen in [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)

**Nachtrag 05-03 (2026-10-01):** Eigene Screening-Run-/Zelltabellen, transaktionale `ssr1:`-/`ssm1:`-Idempotenz, Pflicht-Strategieversions-FK, optionale Backtests, immutable Prioritäten, monotone Fortschritte und bounded Reads sind implementiert. DB-Tests beweisen SQL-/Drizzle-Parität; Runner/CLI bleiben 05-04 vorbehalten. [Runbook + Rollback](../../../STRATEGY_SCREENING.md).

**Nachtrag 06-01 (2026-10-02, `v0.10.0`):** Der deterministische Annahmen-Audit ist umgesetzt — elf reine Prüfungen über injizierte `*Facts` (keine IO, keine Uhr, keine DB), `UNKNOWN` statt Scheingenauigkeit unter 30 Trades, `critical: true` + `VIOLATED`/`UNKNOWN` ⇒ Gesamt-Status `INCONCLUSIVE` (nie `FAIL`), `assumptionGate()` als ausdrückliche Reihenfolge-Naht vor 06-02/06-03. 38 Tests, darunter ein statischer IO-Wächter über den Modulquelltext. STX-14 hat damit seine Prüfung; STX-17 bleibt bis 06-04 offen. [Doku](../../../STRATEGY_VALIDATION.md).

**Nachtrag 05-04 (2026-10-02, `v0.9.0`):** Runner (`runScreening()`), Backtest-Job-Adapter (`runMultiAssetBacktest()` als einziger Engine-Pfad) und CLI (`npm run screening`, `--dry-run` Default) sind umgesetzt und mit 38 Tests belegt — harte `maxCells`, Caps ⇒ `BLOCKED` statt Kappung, bounded Concurrency ohne `worker_threads`, bounded Telemetrie, Abbruch ⇒ `ABORTED` mit Fortsetzung über `--run-id`. `backtest_run_id` bleibt bewusst `null` (Naht: `persist`-Hook im Adapter). Die Annahme von 05-04 steht unter dem Vorbehalt des verbindlichen Pilots (50 Zellen) — [Pilot-Runbook](SCREENING-PILOT.md).

## Legende

`☐` offen · `◐` in Arbeit · `☑` fertig · `⊘` zurückgestellt · `✗` verworfen

---

## Findings

| ID | Severity | Status | Behoben durch |
|---|---|---|---|
| STX-01 Timeframe-Blocker | HIGH | ☑ | 01-01 ☑ (`v0.6.2`) |
| STX-02 `StrategyClass`-Duplikat | HIGH | ◐ | 00-03 ☑ ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), `v0.6.1`) → 03-01 |
| STX-03 Regime-Vokabular-Konflikt | HIGH | ◐ | 00-03 ☑ ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), `v0.6.1`) → 06-04 |
| STX-04 `MultiAssetStrategySpec`-Duplikat | HIGH | ☑ | 00-03 ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3), `v0.6.1`); Sizing-Schicht bewusst außerhalb der Roadmap |
| STX-05 Builder umgeht Sanitize | HIGH | ☑ | 03-01 ☑ (`v0.7.0`, `buildRule(params) => RuleSpecInput`, kein `ctx`) → 03-09 ☑ (`v0.7.5`, Compiler + Sanitize-Nachweis) |
| STX-06 Keine Versions-Persistenz | MEDIUM | ◐ | 04-01 ☑ (`v0.8.0`, Schema) → 04-02 (Service/Schreibpfad) |
| STX-07 `backtest_runs`-Scope | MEDIUM | ☑ | 05-03 ☑ (Unreleased auf `v0.8.0`, eigene Run-/Zelltabellen; keine Änderung am Backtest-Schema) |
| STX-08 Alpaca ohne WS | MEDIUM | ☐ | 07-03 (Bewusst: Alpaca ausgeschlossen) |
| STX-09 Copy-Reconciliation-Duplikat | MEDIUM | ☐ | 07-02 |
| STX-10 Feature Store ist Slice | MEDIUM | ◐ | 00-02 ☑ (Doku, `v0.6.1`) → 02-04 (optional) |
| STX-11 Cost-Stress existiert | MEDIUM | ◐ | 00-02 ☑ (Doku, `v0.6.1`) → 06-03 (Andocken) |
| STX-12 `backtestRule` O(n²) | MEDIUM | ◐ | 00-01 (Messung ✓, `v0.6.0`) → Screening umgeht den Pfad seit 05-04 (`v0.9.0`, `runMultiAssetBacktest()`); Folge-Patch mit Paritätstest für die Altpfade |
| STX-13 OpenCode-Free-Tier | LOW | ☐ | 06-05 |
| STX-14 `changePct24h`-Semantik | LOW | ◐ | 03-01 ☑ (Doku) → 06-01 ☑ (`v0.10.0`, Prüfung `CHANGE_PCT_SEMANTICS`: Nutzung ⇒ `VIOLATED` mit `WARNING`, Semantik aus `RULE_FIELD_LABELS`); offen bleibt die Feld-Deprekation (`changePctBars`) als eigenes Versionsereignis |
| STX-15 Faktorzahl (14 ≠ 15+) | LOW | ☑ | 00-02 (`v0.6.1`) |
| STX-16 Copy-Compliance | LOW | ☐ | 07-01 → 07-02 (`SIMULATE_ONLY`) |
| STX-17 Validator kompatibel | INFO | ◐ | bestätigt — 06-01 ☑ (`v0.10.0`, deterministischer Annahmen-Audit) → 06-02/06-04 |
| STX-18 `RuleSpec` trägt 5/7 Templates | INFO | ☑ | bestätigt und abgeschlossen — Bollinger 02-02 ☑ (`v0.6.4`), Donchian 02-03 ☑ (`v0.6.5`); Templates 03-03 ☑ (`v0.7.1`), 03-04 ☑ (`v0.7.2`), 03-05 ☑ (`v0.7.3`), 03-06/03-07/03-08 ☑ (`v0.7.4`) — alle sechs gebaut; Compiler-Abnahme 03-09 ☑ (`v0.7.5`, sechs Templates ohne Klemmung durch den Sicherheitspfad); Vertragstests 03-10 ☑ (`v0.7.6`, `tests/strategies.templates.test.ts`) |
| STX-19 Kafka-Einwand | INFO | ☐ | bestätigt — global gesperrt |

## Prompts

### Phase 0 — Messung & Entscheidungen (Gate vor Phase 1)

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 00-01 | [Backtest-Perfenz-Baseline](../prompts/PROMPT-STX-00-01-backtest-perf-baseline.md) | ☑ | STX-12 | [`v0.6.0`](BENCH-BASELINE.md) |
| 00-02 | [Strategie-Stack-SSoT](../prompts/PROMPT-STX-00-02-strategy-stack-ssot.md) | ☑ | STX-10/11/15 | [`v0.6.1`](../../../architecture/STRATEGY_STACK.md) |
| 00-03 | [Vokabular-ADR](../prompts/PROMPT-STX-00-03-vokabular-adr.md) | ☑ | STX-02/03/04 | [`v0.6.1`](../../../roadmap/DECISIONS.md) |

### Phase 1 — Blocker

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 01-01 | [Rule-Timeframes angleichen](../prompts/PROMPT-STX-01-01-rule-timeframes.md) | ☑ | STX-01 | [`v0.6.2`](../../../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062) |

### Phase 2 — Indikator-Grundlage

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 02-01 | [Bollinger-Bänder + Donchian](../prompts/PROMPT-STX-02-01-indikatoren.md) | ☑ | STX-18 | `v0.6.3` |
| 02-02 | [Bollinger-Regelfelder](../prompts/PROMPT-STX-02-02-bollinger-felder.md) | ☑ | STX-18 | [`v0.6.4`](../../../BACKTESTING.md#12-bollinger-bandlage-stx-02-02-v064) |
| 02-03 | [Donchian-Regelfeld](../prompts/PROMPT-STX-02-03-donchian-feld.md) | ☑ | STX-18 | [`v0.6.5`](../../../BACKTESTING.md#13-donchian-ausbruch-stx-02-03-v065) |
| 02-04 | [Feature-Store-Slice `rule.*` *(optional)*](../prompts/PROMPT-STX-02-04-featurestore-rule-slice.md) | ☐ | STX-10 | — |

### Phase 3 — Template-Kern

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 03-01 | [Template-Typen](../prompts/PROMPT-STX-03-01-template-types.md) | ☑ | STX-05 | `v0.7.0` |
| 03-02 | [Katalog + Validierung](../prompts/PROMPT-STX-03-02-catalog.md) | ☑ | STX-02/05 | `v0.7.0` |
| 03-03 | [Template: EMA/ADX Trend](../prompts/PROMPT-STX-03-03-template-ema-adx.md) | ☑ | STX-18 | `v0.7.1` |
| 03-04 | [Template: MACD Momentum](../prompts/PROMPT-STX-03-04-template-macd.md) | ☑ | STX-18 | `v0.7.2` |
| 03-05 | [Template: RSI Mean-Reversion](../prompts/PROMPT-STX-03-05-template-rsi.md) | ☑ | STX-18 | `v0.7.3` |
| 03-06 | [Template: Bollinger Squeeze](../prompts/PROMPT-STX-03-06-template-bollinger.md) | ☑ | STX-18 | `v0.7.4` |
| 03-07 | [Template: VWAP (Snapshot)](../prompts/PROMPT-STX-03-07-template-vwap.md) | ☑ | STX-18 | `v0.7.4` |
| 03-08 | [Template: Donchian Breakout](../prompts/PROMPT-STX-03-08-template-donchian.md) | ☑ | STX-18 | `v0.7.4` |
| 03-09 | [Compiler + Sanitize-Nachweis](../prompts/PROMPT-STX-03-09-compiler.md) | ☑ | STX-05 | `v0.7.5` |
| 03-10 | [Template-Tests](../prompts/PROMPT-STX-03-10-template-tests.md) | ☑ | STX-18 | `v0.7.6` |

### Phase 4 — Versionierte Persistenz

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 04-01 | [Migration `strategy_definitions`/`versions`](../prompts/PROMPT-STX-04-01-strategy-persistenz-migration.md) | ☑ | STX-06 | `v0.8.0` (Schema; Service folgt) |
| 04-02 | [Service + Lifecycle-Bridging](../prompts/PROMPT-STX-04-02-strategy-service.md) | ☐ | STX-06/17 | — |

### Phase 5 — Candidate Matrix

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 05-01 | [Screening-Typen + Priorität](../prompts/PROMPT-STX-05-01-screening-types.md) | ☐ | STX-07 | — |
| 05-02 | [Matrix-Builder](../prompts/PROMPT-STX-05-02-matrix-builder.md) | ☐ | STX-07 | — |
| 05-03 | [Persistenz + Idempotenz](../prompts/PROMPT-STX-05-03-screening-persistenz.md) | ☑ | STX-07 | Unreleased auf `v0.8.0` |
| 05-04 | [CLI + Backtest-Job-Adapter](../prompts/PROMPT-STX-05-04-screening-cli.md) | ☑ | STX-07/12 | `v0.9.0` (Annahme unter Pilot-Vorbehalt, [SCREENING-PILOT.md](SCREENING-PILOT.md)) |

### Phase 6 — Validator

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 06-01 | [Annahmen-Audit](../prompts/PROMPT-STX-06-01-assumptions-audit.md) | ☑ | STX-14/17 | `v0.10.0` ([Doku](../../../STRATEGY_VALIDATION.md)) |
| 06-02 | [Overfit & Robustheit](../prompts/PROMPT-STX-06-02-overfit.md) | ☐ | STX-17 | — |
| 06-03 | [Cost-Stress-Runner](../prompts/PROMPT-STX-06-03-cost-stress.md) | ☐ | STX-11 | — |
| 06-04 | [Report + Evidence + CLI](../prompts/PROMPT-STX-06-04-validation-report.md) | ☐ | STX-17 | — |
| 06-05 | [Validator-Agent](../prompts/PROMPT-STX-06-05-validator-agent.md) | ☐ | STX-13 | — |

### Phase 7 — Copy-Trading (Paper-only, unabhängig)

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 07-01 | [Copy-Domänenmodell](../prompts/PROMPT-STX-07-01-copy-domain.md) | ☐ | STX-16 | — |
| 07-02 | [Policy + Order-Links](../prompts/PROMPT-STX-07-02-copy-policy.md) | ☐ | STX-09/16 | — |
| 07-03 | [Bitunix-Leader-Adapter](../prompts/PROMPT-STX-07-03-copy-leader-bitunix.md) | ☐ | STX-08/09/16 | — |

---

## Abgelehnte Vorschläge (bewusst nicht umgesetzt)

| Vorschlag | Entscheidung | Begründung | Dokumentiert in |
|---|---|---|---|
| Kafka | ✗ abgelehnt | STX-19 | `ROADMAP.md` §Abgelehnt |
| `MultiAssetStrategySpec` | ✗ abgelehnt | STX-04 | 00-03 ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) |
| `PortfolioConstruction`-Schicht (Universe-Gewichte) | ⊘ eigener Prompt außerhalb der 32 | STX-04 (Sizing-Lücke) | [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) |
| Regime-Taxonomie (7er) | ✗ abgelehnt | STX-03 | 00-03 ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)) |
| Eigene Strategieklasse / neue Klasse (`momentum`) | ✗ abgelehnt | STX-02 | 00-03 ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)) |
| Copy-Reconciler | ✗ abgelehnt | STX-09 | 07-02 |
| Slippage-Cancel nach Fill | ✗ abgelehnt | STX-09 | 07-02 |
| Alpaca-Leader | ⊘ zurückgestellt | STX-08 (kein WS) | `ROADMAP.md` §Abgelehnt |
| Parquet/DuckDB | ⊘ Phase 3 der Roadmap | Messung offen | 00-01 |
| `RuleTrigger` `CROSS`/`RECLAIM` | ⊘ eigener Audit | STX-18 | 03-07 |
| `DerivativeStrategySpec` (Shorts) | ⊘ eigener Audit | Ausbaudokument §13 | — |
| Live-Copy | ✗ abgelehnt | STX-16 | 07-01/07-02 |

## Abhängigkeits-Gates

| Gate | Bedingung | Prompts dahinter |
|---|---|---|
| **G0** | ✅ **erfüllt** (00-03: 3 ADRs fixiert, `v0.6.1` — [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) | 01-01, 02-01, 03-01, 07-01 |
| **G1** | ✅ **erfüllt** (01-01: Timeframes `1m…5d`, Intraday byte-identisch per Golden-Test, `v0.6.2`) | 02-02, 02-03, 03-01, 05-02 |
| **G2** | ✅ **erfüllt** (02-02/02-03: `bbZScore`/`priceVs*BbPct` `v0.6.4`, `donchianBreakoutPct` `v0.6.5`, Paritäts- und Lookahead-Tests) | 03-06, 03-08 |
| **G3** | ✅ **erfüllt** (03-10: `tests/strategies.templates.test.ts` grün — 6 Templates vertraglich abgesichert, `v0.7.6`) | 04-01 |
| **G4** | 04-02 grün (Versionen referenzierbar) | 05-03, 06-02, 06-04 |
| **G5** | ✅ **erfüllt** (00-01: Screening über `runMultiAssetBacktest`, [BENCH-BASELINE.md](BENCH-BASELINE.md)) | 05-04 |
| **G6** | 05-04 Pilotlauf < 1 Kernstunde/50 Zellen — ausstehend ([SCREENING-PILOT.md](SCREENING-PILOT.md)) | Phase 6 |
| **G7** | 06-04 grün (deterministischer Report) | 06-05 |
| **G8** | 07-01/07-02 grün | 07-03 |

## Bekannte Code-Altlasten (durch 00-03 aufgedeckt, nicht Teil der 32 Prompts)

00-03 sperrte Code-Änderungen; diese Punkte sind deshalb dokumentiert und **nicht** still korrigiert. Jeder ist eine kleine, eigenständige Änderung an Laufzeit-Code (eigener Prompt, Patch-Release). Ob und wann sie folgen, steht als OP-6 unten. Stand geprüft am 2026-10-01 gegen `main`.

| Altlast | Fundort | Risiko | Details |
|---|---|---|---|
| Die vier Klassenwerte stehen als Literale statt nur aus `STRATEGY_CLASS_KEYS` | `src/lib/signalDecay.ts` (`isStrategyClassKey`, `classOf`), `src/lib/signalDecayRuntime.ts`, CHECKs `positions_strategy_class_check` und `signal_decay_events_class_check` (`drizzle/2026-09-22_signal_decay.sql`) | Eine künftige Klasse müsste an allen Stellen zugleich ergänzt werden (ADR-008: nur per neuem ADR) | [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), Konsequenzen |
| `VolatilityRegime` ist dreifach definiert (Volatilitäts-Stufen, kein Markt-Regime) | `src/lib/adaptiveRisk.ts` (`NORMAL`/`ELEVATED`/`EXTREME`), `src/portfolio/types.ts` und `src/scanner/types.ts` (`LOW`/`NORMAL`/`HIGH`/`EXTREME`) | Namensnähe zu `MarketRegime`; kein Laufzeitfehler | [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), Kontext |
| In-App-Doku-Viewer löst `docs/architecture/` und `docs/roadmap/` nicht auf | `resolveDoc` in `src/lib/docsCatalog.ts` (Suchpfade ohne diese beiden Ordner) | `STRATEGY_STACK.md`, `PIPELINE_MAP.md` und der ADR-Log sind nur im Repo und auf GitHub lesbar, nicht im Browser-Viewer | [`CHANGELOG.md`](../../../../CHANGELOG.md), Eintrag `0.6.1` |

Der in `src/strategies/service.ts` (04-02) entstandene **vierte** Fall — eine erneut kopierte Klassenliste — ist **behoben**: Der Service liest `STRATEGY_CLASSES` aus der SSoT, der Wächter `tests/adrVocabulary.test.ts` deckt ihn ab.

## Offene Punkte für den Reviewer

- **OP-1:** Soll `4h`/`1d` im Micro-Executor überhaupt je erreichbar sein, oder bleibt
  der Live-Executor Intraday-only und `4h`+ gilt nur für Backtest/Screening?
  ◐ **Mit Default beantwortet, Policy offen:** 01-01 (`v0.6.2`) hat die Guard-Schicht gebaut — der
  Executor wertet nur Regeln bis `executionInterval` aus (Default `1h`), längere weist er sichtbar ab.
  `4h`+ gilt damit für Backtest/Screening. Eine Anhebung des Intervalls ist eine bewusste
  Policy-Entscheidung, keine reine Konfiguration: Der Loop bewertet die laufende Kerze.
- **OP-2:** ✅ **beantwortet** durch [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) (2026-09-29): `unclassified` ist **kein** Template-Status — ein
  Template ohne Klasse oder mit `unclassified` ist ein Fehler (Validierung 03-02, Compiler 03-09, DB-CHECK 04-01).
- **OP-3:** Sollen `strategy_versions` an die `regime_snapshots`/`feature_store` des
  jeweiligen Laufs gebunden werden (Data-Version-Provenienz), oder reicht
  `data_version` als Freitext? ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) legt nur fest, dass Per-Regime-Ergebnisse
  `featureVersion`/`modelVersion` der verwendeten Snapshots tragen; die Frage für `strategy_versions` bleibt offen.)
- **OP-4:** Kopieren-Projekt: Wer trägt die rechtliche Prüfung für den Fall, dass aus
  `SIMULATE_ONLY` später doch Live werden soll? (STX-16 — nicht Teil dieses Repos.)
- **OP-5:** 02-04 (Feature-Store-Slice) — nachholen, wenn die Matrix-Größe den
  Snapshot-Pfad tatsächlich zum Engpass macht, oder dauerhaft verwerfen?
- **OP-6:** Sollen die [bekannten Code-Altlasten](#bekannte-code-altlasten-durch-00-03-aufgedeckt-nicht-teil-der-32-prompts)
  als eigene Prompts/Patch-Releases folgen oder bleiben sie dokumentiert und ungeplant?

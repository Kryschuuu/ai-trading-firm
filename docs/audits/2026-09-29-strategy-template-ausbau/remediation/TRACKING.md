# Remediation-Tracking — Audit 2026-09-29

- **Audit:** [`../README.md`](../README.md) · **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md)
- **Commit-Baseline:** `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67`
- **Stand:** 2026-09-29 · alle Einträge `OPEN`

## Legende

`☐` offen · `◐` in Arbeit · `☑` fertig · `⊘` zurückgestellt · `✗` verworfen

---

## Findings

| ID | Severity | Status | Behoben durch |
|---|---|---|---|
| STX-01 Timeframe-Blocker | HIGH | ☐ | 01-01 |
| STX-02 `StrategyClass`-Duplikat | HIGH | ☐ | 00-03 (ADR-E1) → 03-01 |
| STX-03 Regime-Vokabular-Konflikt | HIGH | ☐ | 00-03 (ADR-E2) → 06-04 |
| STX-04 `MultiAssetStrategySpec`-Duplikat | HIGH | ☐ | 00-03 (ADR-E3) |
| STX-05 Builder umgeht Sanitize | HIGH | ☐ | 03-01 → 03-09 |
| STX-06 Keine Versions-Persistenz | MEDIUM | ☐ | 04-01 → 04-02 |
| STX-07 `backtest_runs`-Scope | MEDIUM | ☐ | 05-03 |
| STX-08 Alpaca ohne WS | MEDIUM | ☐ | 07-03 (Bewusst: Alpaca ausgeschlossen) |
| STX-09 Copy-Reconciliation-Duplikat | MEDIUM | ☐ | 07-02 |
| STX-10 Feature Store ist Slice | MEDIUM | ☐ | 00-02 (Doku) → 02-04 (optional) |
| STX-11 Cost-Stress existiert | MEDIUM | ☐ | 00-02 (Doku) → 06-03 (Andocken) |
| STX-12 `backtestRule` O(n²) | MEDIUM | ☐ | 00-01 (messen) → ggf. Folge-Prompt |
| STX-13 OpenCode-Free-Tier | LOW | ☐ | 06-05 |
| STX-14 `changePct24h`-Semantik | LOW | ☐ | 03-01 (Doku) → 06-01 (Prüfung) |
| STX-15 Faktorzahl (14 ≠ 15+) | LOW | ☐ | 00-02 |
| STX-16 Copy-Compliance | LOW | ☐ | 07-01 → 07-02 (`SIMULATE_ONLY`) |
| STX-17 Validator kompatibel | INFO | ☐ | bestätigt — 06-04 |
| STX-18 `RuleSpec` trägt 5/7 Templates | INFO | ☐ | bestätigt — 03-03…03-08 |
| STX-19 Kafka-Einwand | INFO | ☐ | bestätigt — global gesperrt |

## Prompts

### Phase 0 — Messung & Entscheidungen (Gate vor Phase 1)

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 00-01 | [Backtest-Perfenz-Baseline](../prompts/PROMPT-STX-00-01-backtest-perf-baseline.md) | ☐ | STX-12 | — |
| 00-02 | [Strategie-Stack-SSoT](../prompts/PROMPT-STX-00-02-strategy-stack-ssot.md) | ☐ | STX-10/11/15 | — |
| 00-03 | [Vokabular-ADR](../prompts/PROMPT-STX-00-03-vokabular-adr.md) | ☐ | STX-02/03/04 | — |

### Phase 1 — Blocker

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 01-01 | [Rule-Timeframes angleichen](../prompts/PROMPT-STX-01-01-rule-timeframes.md) | ☐ | STX-01 | — |

### Phase 2 — Indikator-Grundlage

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 02-01 | [Bollinger-Bänder + Donchian](../prompts/PROMPT-STX-02-01-indikatoren.md) | ☐ | STX-18 | — |
| 02-02 | [Bollinger-Regelfelder](../prompts/PROMPT-STX-02-02-bollinger-felder.md) | ☐ | STX-18 | — |
| 02-03 | [Donchian-Regelfeld](../prompts/PROMPT-STX-02-03-donchian-feld.md) | ☐ | STX-18 | — |
| 02-04 | [Feature-Store-Slice `rule.*` *(optional)*](../prompts/PROMPT-STX-02-04-featurestore-rule-slice.md) | ☐ | STX-10 | — |

### Phase 3 — Template-Kern

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 03-01 | [Template-Typen](../prompts/PROMPT-STX-03-01-template-types.md) | ☐ | STX-05 | — |
| 03-02 | [Katalog + Validierung](../prompts/PROMPT-STX-03-02-catalog.md) | ☐ | STX-02/05 | — |
| 03-03 | [Template: EMA/ADX Trend](../prompts/PROMPT-STX-03-03-template-ema-adx.md) | ☐ | STX-18 | — |
| 03-04 | [Template: MACD Momentum](../prompts/PROMPT-STX-03-04-template-macd.md) | ☐ | STX-18 | — |
| 03-05 | [Template: RSI Mean-Reversion](../prompts/PROMPT-STX-03-05-template-rsi.md) | ☐ | STX-18 | — |
| 03-06 | [Template: Bollinger Squeeze](../prompts/PROMPT-STX-03-06-template-bollinger.md) | ☐ | STX-18 | — |
| 03-07 | [Template: VWAP (Snapshot)](../prompts/PROMPT-STX-03-07-template-vwap.md) | ☐ | STX-18 | — |
| 03-08 | [Template: Donchian Breakout](../prompts/PROMPT-STX-03-08-template-donchian.md) | ☐ | STX-18 | — |
| 03-09 | [Compiler + Sanitize-Nachweis](../prompts/PROMPT-STX-03-09-compiler.md) | ☐ | STX-05 | — |
| 03-10 | [Template-Tests](../prompts/PROMPT-STX-03-10-template-tests.md) | ☐ | STX-18 | — |

### Phase 4 — Versionierte Persistenz

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 04-01 | [Migration `strategy_definitions`/`versions`](../prompts/PROMPT-STX-04-01-strategy-persistenz-migration.md) | ☐ | STX-06 | — |
| 04-02 | [Service + Lifecycle-Bridging](../prompts/PROMPT-STX-04-02-strategy-service.md) | ☐ | STX-06/17 | — |

### Phase 5 — Candidate Matrix

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 05-01 | [Screening-Typen + Priorität](../prompts/PROMPT-STX-05-01-screening-types.md) | ☐ | STX-07 | — |
| 05-02 | [Matrix-Builder](../prompts/PROMPT-STX-05-02-matrix-builder.md) | ☐ | STX-07 | — |
| 05-03 | [Persistenz + Idempotenz](../prompts/PROMPT-STX-05-03-screening-persistenz.md) | ☐ | STX-07 | — |
| 05-04 | [CLI + Backtest-Job-Adapter](../prompts/PROMPT-STX-05-04-screening-cli.md) | ☐ | STX-07/12 | — |

### Phase 6 — Validator

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 06-01 | [Annahmen-Audit](../prompts/PROMPT-STX-06-01-assumptions-audit.md) | ☐ | STX-17 | — |
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
| `MultiAssetStrategySpec` | ✗ abgelehnt | STX-04 | 00-03 (ADR-E3) |
| Regime-Taxonomie (7er) | ✗ abgelehnt | STX-03 | 00-03 (ADR-E2) |
| Eigene Strategieklasse | ✗ abgelehnt | STX-02 | 00-03 (ADR-E1) |
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
| **G0** | 00-03 abgeschlossen (3 ADRs fixiert) | 01-01, 02-01, 03-01, 07-01 |
| **G1** | 01-01 grün (Timeframes, Intraday byte-identisch) | 02-02, 02-03, 03-01, 05-02 |
| **G2** | 02-02/02-03 grün (neue Felder + Parität) | 03-06, 03-08 |
| **G3** | 03-10 grün (6 Templates vertraglich abgesichert) | 04-01 |
| **G4** | 04-02 grün (Versionen referenzierbar) | 05-03, 06-02, 06-04 |
| **G5** | 00-01 abgeschlossen (Pfad-Entscheidung getroffen) | 05-04 |
| **G6** | 05-04 Pilotlauf < 1 Kernstunde/50 Zellen | Phase 6 |
| **G7** | 06-04 grün (deterministischer Report) | 06-05 |
| **G8** | 07-01/07-02 grün | 07-03 |

## Offene Punkte für den Reviewer

- **OP-1:** Soll `4h`/`1d` im Micro-Executor überhaupt je erreichbar sein, oder bleibt
  der Live-Executor Intraday-only und `4h`+ gilt nur für Backtest/Screening?
  (Entscheidung nötig; 01-01 implementiert die Guard-Schicht, aber die Policy-Frage
  bleibt offen.)
- **OP-2:** `unclassified` als Template-Status — 03-01/03-02 lehnen ihn ab. Ist das die
  gewünschte Policy, oder soll ein „unclassified"-Template erlaubt sein, das
  automatisch als `BLOCKED` endet?
- **OP-3:** Sollen `strategy_versions` an die `regime_snapshots`/`feature_store` des
  jeweiligen Laufs gebunden werden (Data-Version-Provenienz), oder reicht
  `data_version` als Freitext?
- **OP-4:** Kopieren-Projekt: Wer trägt die rechtliche Prüfung für den Fall, dass aus
  `SIMULATE_ONLY` später doch Live werden soll? (STX-16 — nicht Teil dieses Repos.)
- **OP-5:** 02-04 (Feature-Store-Slice) — nachholen, wenn die Matrix-Größe den
  Snapshot-Pfad tatsächlich zum Engpass macht, oder dauerhaft verwerfen?

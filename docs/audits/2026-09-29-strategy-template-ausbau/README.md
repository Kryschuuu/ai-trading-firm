# Audit 2026-09-29 — Strategie-Template-Ausbau & Copy-Trading/Validator-Validierung

## Metadaten

- **Datum:** 2026-09-29
- **Audit-Version:** `v1.1.2` (Schema + Versionsregeln: [`VERSIONING.md`](VERSIONING.md); `v1.1.2` = Phase 1 abgeschlossen: 01-01, STX-01 behoben, Gate G1; davor `v1.1.1` = Phase 0: 00-02/00-03, ADR-008…010, Gate G0)
- **Quelle:** External (ChatGPT-Analyse „Analyse und Ausbaukonzept für `ai-trading-firm`")
- **Reviewer:** Arena Agent Mode (Code-verifizierendes Audit gegen `main` @ `e3509fd`)
- **Scope:** `src/lib/ruleEngine.ts`, `src/lib/ruleFieldCatalog.ts`, `src/lib/indicators.ts`,
  `src/backtest/**`, `src/strategyLifecycle/**`, `src/crossSectional/**`, `src/features/**`,
  `src/scanner/**`, `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`,
  `src/lib/regimeEvaluation.ts`, `src/brokers/alpaca/**`, `src/brokers/bitunix/**`,
  `src/routing/**`, `src/db/schema.ts`, `drizzle/**`
- **Branch/Commit:** `arena/01a0ee47-ai-trading-firm` · `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67`
- **Code-Version:** `package.json` v0.6.2 (Beta) · Doku-Stand `docs/roadmap/STATUS.md` v1.73.0 (historischer TASK-Tracker; Entscheidungen: [`DECISIONS.md`](../../roadmap/DECISIONS.md))
- **Status:** OPEN — Phase 0 abgeschlossen: 00-01 (`v0.6.0`, [Bench-Baseline](remediation/BENCH-BASELINE.md)), 00-02/00-03 (`v0.6.1`, [SSoT-Karte](../../architecture/STRATEGY_STACK.md) + [ADR-008](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)); Phase 1 abgeschlossen: 01-01 (`v0.6.2`, [STX-01](findings/STX-01-rule-timeframe-blocker.md), Gate G1); als Nächstes Phase 2 (02-01)
- **Beta-Positionierung:** Diese Roadmap ist **kein** Weg aus der Beta-Phase — auch nicht
  nach vollständiger Umsetzung aller 32 Prompts. Siehe [`../../BETA_STATUS.md`](../../BETA_STATUS.md).

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 5 | 1 | 2 | 2 |
| MEDIUM | 7 | 4 | 3 | 0 |
| LOW | 4 | 3 | 0 | 1 |
| INFO | 3 | 3 | 0 | 0 |
| **Σ** | **19** | **11** | **5** | **3** |

> **Kein CRITICAL.** Das Ausbaudokument enthält **keinen** Vorschlag, der eine bestehende
> Sicherheitsgrenze weicht. Die HIGH-Funde sind **Integrations- und Duplikationsrisiken**,
> keine Sicherheitslücken.

## Findings-Index

| ID | Titel | Severity | Status |
|----|-------|----------|--------|
| [STX-01](findings/STX-01-rule-timeframe-blocker.md) | `RuleWindow.timeframe` blockiert 2h/4h/1d/5d — harter Blocker für Swing & Screening (Cross-Sectional nicht betroffen, [ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) | HIGH | FIXED (01-01, `v0.6.2`) |
| [STX-02](findings/STX-02-strategyclass-duplikat.md) | `StrategyClass` existiert bereits — `StrategyTemplate` würde ein zweites Klassifikationsmodell bauen | HIGH | IN ARBEIT (entschieden: [ADR-008](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)) |
| [STX-03](findings/STX-03-regime-vokabular-konflikt.md) | Regime-Vokabular-Konflikt: 7er-Taxonomie des Dokuments vs. bestehendes 5+1-Modell | HIGH | IN ARBEIT (entschieden: [ADR-009](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)) |
| [STX-04](findings/STX-04-multiaset-spec-duplikat.md) | `MultiAssetStrategySpec` dupliziert `CrossSectionalConfig` | HIGH | FIXED ([ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) |
| [STX-05](findings/STX-05-template-builder-umgeht-sanitize.md) | `buildRule(ctx)` als Runtime-Builder umgeht das Security-Modell „Code entscheidet" | HIGH | OPEN |
| [STX-06](findings/STX-06-keine-strategy-versions-persistenz.md) | Kein versioniertes Strategie-Artefakt persistiert (Lifecycle-Key ist freiform) | MEDIUM | OPEN |
| [STX-07](findings/STX-07-backtest-runs-scope.md) | `backtest_runs.instrument_id NOT NULL` — universe-scoped Runs nicht persistierbar | MEDIUM | OPEN |
| [STX-08](findings/STX-08-alpaca-ohne-websocket.md) | Alpaca hat **keinen** WebSocket — Leader-Adapter-Annahme des Dokuments trifft nicht zu | MEDIUM | OPEN |
| [STX-09](findings/STX-09-copysystem-duplikat-reconciliation.md) | Copy-Reconciler würde bestehende Fill-Reconciliation duplizieren | MEDIUM | OPEN |
| [STX-10](findings/STX-10-featurestore-ist-slice.md) | Feature Store ist ein 3-Feature-Slice, kein „zentraler Feature-Layer" | MEDIUM | IN ARBEIT (00-02 dokumentiert) |
| [STX-11](findings/STX-11-cost-stress-existiert.md) | Cost-/Slippage-Stress existiert bereits (MonteCarlo + executionCost-Faktor) | MEDIUM | IN ARBEIT (00-02 dokumentiert) |
| [STX-12](findings/STX-12-backtestrule-o-n-quadratisch.md) | `backtestRule()` ist O(n²) — der Matrix-Runner würde daran scheitern | MEDIUM | IN ARBEIT (00-01 gemessen) |
| [STX-13](findings/STX-13-opencode-free-tier.md) | OpenCode-Zen-Free-Tier ist rotierend und nicht verlässlich als Routing-Klasse | LOW | OPEN |
| [STX-14](findings/STX-14-changepct24h-semantik.md) | `changePct24h` misst 97 Perioden — Fallstrick für Tagesstrategien | LOW | OPEN |
| [STX-15](findings/STX-15-scanner-faktorzahl.md) | Faktenkorrektur: 14 aktive Faktoren, nicht „15+" | LOW | FIXED (00-02) |
| [STX-16](findings/STX-16-copy-trading-compliance.md) | Copy-Trading verschiebt das Compliance-/Haftungsprofil des Projekts | LOW | OPEN |
| STX-17 | Bestätigt: Validator-Agent passt in das bestehende Evidence-Modell | INFO | OPEN |
| STX-18 | Bestätigt: `RuleSpec`-/Sanitize-Kette trägt die 5 Templates ohne Engine-Umbau | INFO | OPEN |
| STX-19 | Bestätigt: kein Kafka empfohlen — Einwand des Dokuments trägt | INFO | OPEN |

## Executive Summary

Das Ausbaudokument ist in seiner **Grunddiagnose korrekt**: Die Werkstatt besitzt
Backtesting, Walk-Forward, Monte-Carlo, einen 9-stufigen Lifecycle und eine deterministische
Rule-Engine — aber **kein Objekt, das eine „Strategie" als versioniertes, quantitatives
Artefakt darstellt**, und **keine Screening-Schicht**, die Strategie × Markt × Timeframe
systematisch zu Backtest-Jobs verdichtet. Beides ist im Code bestätigt: es existieren weder
`src/strategies/` noch `src/screening/` noch `src/copy/`, und `strategy_lifecycle_states`
trägt `strategy_key`/`strategy_version` als **Freiform-String bzw. Integer** ohne
persistiertes, unveränderliches Strategie-Artefakt.

Die **Schwäche des Dokuments** ist nicht die Diagnose, sondern die Bestandsaufnahme: Es
überschätzt sechs Bausteine und unterschätzt zwei harte Blocker. Überschätzt werden der
Feature Store (3 Features, nicht „zentraler Layer"), der Regime-Unterbau (es existiert
bereits ein 5+1-Regime-Modell mit Regime-Gate), der Stress-Test-Pfad (Monte-Carlo hat
bereits `MonteCarloStressConfig`), die Strategie-Klassifikation (`StrategyClass` =
trend/mean-reversion/breakout ist bereits implementiert) und der Alpaca-WebSocket-Pfad
(`src/brokers/alpaca/` enthält **keine** WS-Implementierung). Unterschätzt werden der
`RuleWindow.timeframe`-Blocker (nur `1m|5m|15m|30m|1h` — **kein** `4h`/`1d`) und die
Tatsache, dass `buildRule(ctx)` als Runtime-Builder das Sicherheitsmodell „Code entscheidet"
umgehen würde.

Die Roadmap in [`ROADMAP.md`](ROADMAP.md) dreht die Reihenfolge gegenüber dem Dokument:
**erst** der Timeframe-Blocker, **dann** Indikatoren/Rule-Felder, **dann** der Template-Kern,
**dann** Persistenz, Screening, Validator — und Copy-Trading **ganz am Ende, Paper-only**.

## Remediation-Plan

Siehe [`ROADMAP.md`](ROADMAP.md) (8 Phasen, 32 Prompts),
[`VERSIONING.md`](VERSIONING.md) (Release-Plan `v0.6.0` … `v0.11.2`, alle Beta) und
[`remediation/TRACKING.md`](remediation/TRACKING.md).

**Umsetzungsstand:** Phase 1 ist abgeschlossen (Gate **G1** erfüllt, `v0.6.2`): 01-01 hob den Timeframe-Blocker —
`RuleWindow.timeframe` trägt alle zehn `SUPPORTED_TIMEFRAMES` (ein Vokabular, `1m…1h` byte-identisch), der
Mikro-Executor weist längere Timeframes fail-closed und sichtbar ab ([STX-01](findings/STX-01-rule-timeframe-blocker.md),
Tabelle „Rule-Timeframe ↔ unterstützte Felder“ in [`BACKTESTING.md`](../../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062)). Phase 0 ist abgeschlossen (Gate **G0** erfüllt, `v0.6.1`): 00-02 lieferte die
[SSoT-Karte](../../architecture/STRATEGY_STACK.md), 00-03 die Vokabular-Entscheidungen [ADR-008](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)
(Strategieklasse), [ADR-009](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) (Regime) und [ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) (Universe). Prompt 00-01 — die Messung
([`remediation/BENCH-BASELINE.md`](remediation/BENCH-BASELINE.md)) belegt Exponent
**1,99** (O(n²)) für `backtestRule()` und **1,01** (O(n)) für
`runMultiAssetBacktest()`; 7 500 Zellen kosten 54,14 vs. 0,44 Kernstunden. Gate **G5**
ist damit erfüllt, das Screening (05-04) fährt über die Engine.

## Beta-Positionierung

> **Die vollständige Umsetzung dieser Roadmap beendet die Beta-Phase nicht.**
> Keine der acht Phasen erfüllt ein Beta-Exit-Kriterium. Die Roadmap liefert die
> **Werkzeuge**, um Produktionsreife zu prüfen — nicht deren **Nachweise**.
> Kriterien `B1…B8`, Reihenfolge und Review-Kadenz: [`../../BETA_STATUS.md`](../../BETA_STATUS.md).

Alle in [`VERSIONING.md`](VERSIONING.md) geplanten Releases liegen in `0.x`. Ein
Versionssprung auf `1.0` ist durch diese Roadmap **nicht** begründbar.

## Referenzen

- Ausbaudokument (Quelle dieses Audits) — liegt nicht im Repo vor
- Beta-Zusage und Exit-Kriterien: [`../../BETA_STATUS.md`](../../BETA_STATUS.md)
- Bestehende Audit-Konvention: [`../TEMPLATE/`](../TEMPLATE/)
- Letzter vergleichbarer Audit: [`../2026-09-23-verbesserungen-fahrplan/`](../2026-09-23-verbesserungen-fahrplan/)
- Architektur-SSoT: [`../../architecture/PIPELINE_MAP.md`](../../architecture/PIPELINE_MAP.md),
  [`../../architecture/DB_SCHEMA.md`](../../architecture/DB_SCHEMA.md)
- Strategie-Lifecycle: [`../../STRATEGY_LIFECYCLE.md`](../../STRATEGY_LIFECYCLE.md)
- Security-Übersicht: [`../../security/README.md`](../../security/README.md)

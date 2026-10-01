# Audit 2026-09-29 — Strategie-Template-Ausbau & Copy-Trading/Validator-Validierung

## Metadaten

- **Datum:** 2026-09-29
- **Audit-Version:** `v1.1.13` (Schema + Versionsregeln: [`VERSIONING.md`](VERSIONING.md); Phasen 0–3 abgeschlossen; Phase 4 begonnen — 04-01 Schemafundament (`v0.8.0`), 04-02 Service noch offen; optionaler Slice 02-04 bleibt offen)
- **Quelle:** External (ChatGPT-Analyse „Analyse und Ausbaukonzept für `ai-trading-firm`")
- **Reviewer:** Arena Agent Mode (Code-verifizierendes Audit gegen `main` @ `e3509fd`)
- **Scope:** `src/lib/ruleEngine.ts`, `src/lib/ruleFieldCatalog.ts`, `src/lib/indicators.ts`,
  `src/backtest/**`, `src/strategyLifecycle/**`, `src/crossSectional/**`, `src/features/**`,
  `src/scanner/**`, `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`,
  `src/lib/regimeEvaluation.ts`, `src/brokers/alpaca/**`, `src/brokers/bitunix/**`,
  `src/routing/**`, `src/db/schema.ts`, `drizzle/**`
- **Branch/Commit:** `arena/01a0ee47-ai-trading-firm` · `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67`
- **Code-Version:** `package.json` v0.8.0 (Beta) · Doku-Stand `docs/roadmap/STATUS.md` v1.73.0 (historischer TASK-Tracker; Entscheidungen: [`DECISIONS.md`](../../roadmap/DECISIONS.md))
- **Status:** OPEN — Phase 0 abgeschlossen: 00-01 (`v0.6.0`, [Bench-Baseline](remediation/BENCH-BASELINE.md)), 00-02/00-03 (`v0.6.1`, [SSoT-Karte](../../architecture/STRATEGY_STACK.md) + [ADR-008](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)); Phase 1 abgeschlossen: 01-01 (`v0.6.2`, [STX-01](findings/STX-01-rule-timeframe-blocker.md), Gate G1); Phase 2 fachlich abgeschlossen: 02-01 (`v0.6.3`, Formeln), 02-02 (`v0.6.4`, Bollinger-Regelfelder + Paritätstest) und 02-03 (`v0.6.5`, Donchian-Regelfeld + Paritätstest) umgesetzt; offen nur der optionale Feature-Store-Slice 02-04; **Phase 3 begonnen:** 03-01/03-02 (`v0.7.0`, Vertrag + Katalog), 03-03 (`v0.7.1`), 03-04 (`v0.7.2`) und 03-05 (`v0.7.3`) umgesetzt; **Template-Reihe vollständig:** 03-06 (Bollinger-Squeeze), 03-07 (VWAP-Bias, Snapshot) und 03-08 (Donchian Breakout) mit `v0.7.4` ausgeliefert — sechs von sechs Templates gebaut; **Compiler 03-09 mit `v0.7.5` ausgeliefert** (STX-05 behoben: `buildRule(params) → sanitizeRuleSpec() → RuleSpec` nachgewiesen, Compiler ohne Fallback auf die Rohform); **Vertragstests 03-10 mit `v0.7.6` ausgeliefert** — 60 Tests über alle sechs Templates × Takte (Struktur, Compiler-Parität, Positiv-/Negativ-Fixtures, Katalog-Integrität, Engine-↔-Cache-Parität), generierte Doku `docs/STRATEGY_TEMPLATES.md`, **Gate G3 erfüllt, Phase 3 abgeschlossen**; **Phase 4 begonnen:** 04-01 Schemafundament (`v0.8.0`) implementiert; 04-02 Service/Lifecycle-Bridging noch offen; optionaler Slice 02-04 ebenfalls offen
- **Beta-Positionierung:** Diese Roadmap ist **kein** Weg aus der Beta-Phase — auch nicht
  nach vollständiger Umsetzung aller 32 Prompts. Siehe [`../../BETA_STATUS.md`](../../BETA_STATUS.md).

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 5 | 0 | 2 | 3 |
| MEDIUM | 7 | 3 | 4 | 0 |
| LOW | 4 | 3 | 0 | 1 |
| INFO | 3 | 2 | 0 | 1 |
| **Σ** | **19** | **8** | **6** | **5** |

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
| [STX-05](findings/STX-05-template-builder-umgeht-sanitize.md) | Builder umgeht „Code entscheidet" — `buildRule(ctx) => RuleSpec` würde Whitelist/`RULE_CEILINGS` überspringen | HIGH | FIXED (03-01 `v0.7.0` + 03-09 `v0.7.5`) |
| [STX-06](findings/STX-06-keine-strategy-versions-persistenz.md) | Kein versioniertes Strategie-Artefakt wird über den Anwendungsdienst persistiert (Schemafundament vorhanden) | MEDIUM | IN ARBEIT (04-01 `v0.8.0`; 04-02 offen) |
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
| STX-18 | Bestätigt: `RuleSpec`-/Sanitize-Kette trägt die 5 Templates ohne Engine-Umbau | INFO | GEKLÄRT: Feldseite Bollinger 02-02 (`v0.6.4`), Donchian 02-03 (`v0.6.5`); **alle sechs Templates gebaut** — 03-03 (`v0.7.1`), 03-04 (`v0.7.2`), 03-05 (`v0.7.3`), 03-06/03-07/03-08 (`v0.7.4`, σ-Korrektur 03-06 dokumentiert); **Compiler-Abnahme 03-09 (`v0.7.5`)** — sechs Templates kompilieren ohne Klemmung; **Vertragstests 03-10 (`v0.7.6`)** — alle sechs über alle Takte abgesichert |
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

Der aktuelle Stand hat den Template-Kern (Phase 3) abgeschlossen und mit 04-01
(`v0.8.0`) das Schema für `strategy_definitions` und `strategy_versions`
angelegt. **Noch nicht** vorhanden ist der Anwendungsdienst, der diese Artefakte
schreibt und rekonstruiert; daher bleibt STX-06 bis 04-02 in Arbeit. Screening
und Copy-Trading sind weiterhin nicht implementiert. Die Roadmap in
[`ROADMAP.md`](ROADMAP.md) bleibt die maßgebliche Reihenfolge.

## Remediation-Plan

Siehe [`ROADMAP.md`](ROADMAP.md) (8 Phasen, 32 Prompts),
[`VERSIONING.md`](VERSIONING.md) (Release-Plan `v0.6.0` … `v0.11.2`, alle Beta) und
[`remediation/TRACKING.md`](remediation/TRACKING.md).

**Umsetzungsstand:** 02-01 (`v0.6.3`) liefert reine Bandlevel und den
Donchian-Kanal ohne Signalkerze; 02-02 (`v0.6.4`) schließt den Bollinger-Teil der
Rule-Felder an — `bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct` in beiden
Snapshot-Pfaden, mit Paritätstest und Golden-Hash. 02-03 (`v0.6.5`) schließt den
Donchian-Teil an: `donchianBreakoutPct` (Abstand zum Hoch der **vorigen** 20
Kerzen, kein Look-ahead) in beiden Snapshot-Pfaden, mit Lookahead-Test,
O(n)-Cache-Beleg und Paritätstest über drei Symbole. Damit ist die **Feldseite
aller sieben Strategie-Vorschläge** abgedeckt; Templates bleiben der nächsten
Phase vorbehalten (03-01…03-08), der Feature-Store-Slice 02-04 ist optional.
Phase 1 ist abgeschlossen (Gate **G1** erfüllt, `v0.6.2`): 01-01 hob den Timeframe-Blocker —
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

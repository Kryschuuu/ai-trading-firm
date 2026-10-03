# Audit 2026-09-29 — Strategie-Template-Ausbau & Copy-Trading/Validator-Validierung

## Metadaten

- **Datum:** 2026-09-29
- **Audit-Version:** `v1.2.4` (Schema + Versionsregeln: [`VERSIONING.md`](VERSIONING.md)) — **Vollabgleich 2026-10-03** gegen `main` @ `3d13161` plus Abschluss 08-04: alle 21 Findings verifiziert, **alle 32 Ursprungs-Prompts umgesetzt**; 08-01 schließt STX-20 (Changelog-Nachtrag), 08-02 löst Altlast 3 (`v0.10.8`), 08-03 Altlast 1 (`v0.10.9`), 08-04 schließt STX-12 (`v0.11.0`, Indicator-Cache, unveränderte Goldens/Parität), 08-05/STX-21 bleibt offen; [`remediation/RECONCILE-2026-10-03.md`](remediation/RECONCILE-2026-10-03.md) dokumentiert den historischen Abgleich
- **Quelle:** External (ChatGPT-Analyse „Analyse und Ausbaukonzept für `ai-trading-firm`")
- **Reviewer:** Arena Agent Mode (Code-verifizierendes Audit gegen `main` @ `e3509fd`)
- **Scope:** `src/lib/ruleEngine.ts`, `src/lib/ruleFieldCatalog.ts`, `src/lib/indicators.ts`,
  `src/backtest/**`, `src/strategyLifecycle/**`, `src/crossSectional/**`, `src/features/**`,
  `src/scanner/**`, `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`,
  `src/lib/regimeEvaluation.ts`, `src/brokers/alpaca/**`, `src/brokers/bitunix/**`,
  `src/routing/**`, `src/db/schema.ts`, `drizzle/**`
- **Branch/Commit:** `arena/01a0ee47-ai-trading-firm` · `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67`
- **Code-Version:** `package.json` v0.11.0 (Beta; STX-08-04) · Audit-Basis des Vollabgleichs: `main` @ `3d13161` · Doku-Stand `docs/roadmap/STATUS.md` v1.73.0 (historischer TASK-Tracker; Entscheidungen: [`DECISIONS.md`](../../roadmap/DECISIONS.md))
- **Status:** OPEN — Vollabgleich plus STX-08-04-Abschluss (2026-10-03): **Phasen 0–7 abgeschlossen, alle 32 Ursprungs-Prompts umgesetzt** (Phase 0 `v0.6.0`/`v0.6.1` · Phase 1 `v0.6.2` · Phase 2 `v0.6.3`–`v0.6.5` inkl. optionalem Slice 02-04 · Phase 3 `v0.7.0`–`v0.7.6` · Phase 4 `v0.8.0` + `v0.10.4` · Phase 5 `v0.9.0`, Gate G5; G6-Pilotlauf offen · Phase 6 `v0.10.0`–`v0.10.4` · Phase 7 `v0.10.5`/`v0.10.6` + 07-03). **21 Findings:** 18 FIXED, 1 PARTIAL ([STX-14](findings/STX-14-changepct24h-semantik.md)), 2 OPEN ([STX-08](findings/STX-08-alpaca-ohne-websocket.md), [STX-21](findings/STX-21-localfree-cloud-endpoint.md)). **Phase 8:** 08-01…08-04 erledigt (08-04 `v0.11.0`, schließt STX-12), 08-05 offen; Details in [`ROADMAP.md`](ROADMAP.md#phase-8--folge-prompts-aus-dem-abgleich-2026-10-03) und [`remediation/TRACKING.md`](remediation/TRACKING.md).
- **Beta-Positionierung:** Diese Roadmap ist **kein** Weg aus der Beta-Phase — auch nicht
  nach vollständiger Umsetzung aller 32 Prompts. Siehe [`../../BETA_STATUS.md`](../../BETA_STATUS.md).

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 5 | 0 | 0 | 5 |
| MEDIUM | 7 | 1 | 0 | 6 |
| LOW | 6 | 1 | 1 | 4 |
| INFO | 3 | 0 | 0 | 3 |
| **Σ** | **21** | **2** | **1** | **18** |

> **Stand 2026-10-03** (Audit `v1.2.4`, Vollabgleich plus 08-04): 21 Findings,
> davon 18 `FIXED`, 1 `PARTIAL` (STX-14) und 2 `OPEN` (STX-08, STX-21).
> „In Arbeit" = STX-14; „Offen" = STX-08 und STX-21. STX-12 ist durch
> `backtestRule()`-Cache-Migration `v0.11.0` geschlossen; STX-20 bleibt durch
> den 08-01-Changelog-Nachtrag geschlossen. Der Abgleich-Bericht dokumentiert
> weiterhin den früheren `main`-Stand @ `3d13161`.

> **Kein CRITICAL.** Das Ausbaudokument enthält **keinen** Vorschlag, der eine bestehende
> Sicherheitsgrenze weicht. Die HIGH-Funde sind **Integrations- und Duplikationsrisiken**,
> keine Sicherheitslücken.

## Findings-Index

| ID | Titel | Severity | Status |
|----|-------|----------|--------|
| [STX-01](findings/STX-01-rule-timeframe-blocker.md) | `RuleWindow.timeframe` blockiert 2h/4h/1d/5d — harter Blocker für Swing & Screening (Cross-Sectional nicht betroffen, [ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) | HIGH | FIXED (01-01, `v0.6.2`) |
| [STX-02](findings/STX-02-strategyclass-duplikat.md) | `StrategyClass` existiert bereits — `StrategyTemplate` würde ein zweites Klassifikationsmodell bauen | HIGH | FIXED ([ADR-008](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) + 03-01/03-02/03-09; Abgleich: sechs Templates mit Klasse, `CompileResult.strategyClass` getestet) |
| [STX-03](findings/STX-03-regime-vokabular-konflikt.md) | Regime-Vokabular-Konflikt: 7er-Taxonomie des Dokuments vs. bestehendes 5+1-Modell | HIGH | FIXED ([ADR-009](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) + 06-04 `v0.10.3`: `aggregateRegimeTrades()` liest `REGIME_EVAL_LABELS`, kein `RANGE`-Fallback) |
| [STX-04](findings/STX-04-multiaset-spec-duplikat.md) | `MultiAssetStrategySpec` dupliziert `CrossSectionalConfig` | HIGH | FIXED ([ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) |
| [STX-05](findings/STX-05-template-builder-umgeht-sanitize.md) | Builder umgeht „Code entscheidet" — `buildRule(ctx) => RuleSpec` würde Whitelist/`RULE_CEILINGS` überspringen | HIGH | FIXED (03-01 `v0.7.0` + 03-09 `v0.7.5`) |
| [STX-06](findings/STX-06-keine-strategy-versions-persistenz.md) | Kein versioniertes Strategie-Artefakt wird über den Anwendungsdienst persistiert | MEDIUM | FIXED (04-01 `v0.8.0` + 04-02 `v0.10.4`: `ensureDefinition()`, `createVersion()`, `stv1:`/`stc1:`; DB-Idempotenz im Abgleich nicht ausführbar) |
| [STX-07](findings/STX-07-backtest-runs-scope.md) | `backtest_runs.instrument_id NOT NULL` — universe-scoped Runs brauchen eigene Persistenz | MEDIUM | FIXED (05-03, Unreleased auf `v0.8.0`) |
| [STX-08](findings/STX-08-alpaca-ohne-websocket.md) | Alpaca hat **keinen** WebSocket — Leader-Adapter-Annahme des Dokuments trifft nicht zu | MEDIUM | OPEN |
| [STX-09](findings/STX-09-copysystem-duplikat-reconciliation.md) | Copy-Reconciler würde bestehende Fill-Reconciliation duplizieren | MEDIUM | FIXED (07-02 `f5af325` + 07-03 `5f437d8`: kein Reconciler, `executionQuality`-Intents, `copy_order_links.state` exakt 6 Werte, kein Cancel nach Fill) |
| [STX-10](findings/STX-10-featurestore-ist-slice.md) | Feature Store ist ein 3-Feature-Slice, kein „zentraler Feature-Layer" | MEDIUM | FIXED (00-02 + 02-04 `7995822`: `rule.bb_zscore`, `rule.price_vs_upper_bb_pct`, `rule.donchian_breakout_pct` + Paritätstest) |
| [STX-11](findings/STX-11-cost-stress-existiert.md) | Cost-/Slippage-Stress existiert bereits (MonteCarlo + executionCost-Faktor) | MEDIUM | FIXED (06-03, `v0.10.2`) |
| [STX-12](findings/STX-12-backtestrule-o-n-quadratisch.md) | `backtestRule()` war O(n²) — der Matrix-Runner würde daran scheitern | MEDIUM | FIXED (`v0.11.0`, 08-04: einmaliger Indicator-Cache; sechs unveränderte Goldens, alle `RULE_FIELDS` bar-für-bar paritätisch; synthetischer 17 520-Bar-Vergleich 314,1×; vollständiges `npm test` auf Nutzeranweisung übersprungen; PR wird ergänzt) |
| [STX-13](findings/STX-13-opencode-free-tier.md) | OpenCode-Zen-Free-Tier ist rotierend und nicht verlässlich als Routing-Klasse | LOW | FIXED (06-05, `v0.10.4`; Best-Effort, keine Dauer-Garantie) — Restpunkt der Lokalitäts-Garantie → [STX-21](findings/STX-21-localfree-cloud-endpoint.md) |
| [STX-14](findings/STX-14-changepct24h-semantik.md) | `changePct24h` misst 97 Perioden — Fallstrick für Tagesstrategien | LOW | PARTIAL (Prüfung `CHANGE_PCT_SEMANTICS` in `v0.10.0`; Feld-Deprekation offen — kein Template nutzt das Feld, zurückgestellt) |
| [STX-15](findings/STX-15-scanner-faktorzahl.md) | Faktenkorrektur: 14 aktive Faktoren, nicht „15+" | LOW | FIXED (00-02) |
| [STX-16](findings/STX-16-copy-trading-compliance.md) | Copy-Trading verschiebt das Compliance-/Haftungsprofil des Projekts | LOW | FIXED (07-01/07-02: `CopyMode` mit **einem** Wert, DB-CHECK `mode='SIMULATE_ONLY'`, Follower nur `PaperBroker`; rechtliche Prüfung bleibt außerhalb) |
| [STX-17](findings/STX-17-info-validator-agent-kompatibel.md) | Bestätigt: Validator-Agent passt in das bestehende Evidence-Modell | INFO | FIXED (06-01 `v0.10.0`, 06-02 `v0.10.1`, 06-04 `v0.10.3`: Report + `recordEvidence()`-Writer + CLI ohne Schema-Änderung) |
| [STX-18](findings/STX-18-info-rulespec-traegt-templates.md) | Bestätigt: `RuleSpec`-/Sanitize-Kette trägt die 5 Templates ohne Engine-Umbau | INFO | GEKLÄRT: Feldseite Bollinger 02-02 (`v0.6.4`), Donchian 02-03 (`v0.6.5`); **alle sechs Templates gebaut** — 03-03 (`v0.7.1`), 03-04 (`v0.7.2`), 03-05 (`v0.7.3`), 03-06/03-07/03-08 (`v0.7.4`, σ-Korrektur 03-06 dokumentiert); **Compiler-Abnahme 03-09 (`v0.7.5`)** — sechs Templates kompilieren ohne Klemmung; **Vertragstests 03-10 (`v0.7.6`)** — alle sechs über alle Takte abgesichert |
| [STX-19](findings/STX-19-info-kafka-einwand.md) | Bestätigt: kein Kafka empfohlen — Einwand des Dokuments trägt | INFO | VERIFIED (global gesperrt; Abgleich: kein Kafka/NATS/Redis/DuckDB in `dependencies`, 0 Treffer in `src/`) |
| [STX-20](findings/STX-20-changelog-nachtrag-copy-engine.md) | **Neu (Abgleich 2026-10-03):** Copy-Engine 07-03 war gemergt, aber nicht im Changelog | LOW | FIXED (08-01, `[Unreleased]`, Code-Version `0.10.6`; 2026-10-03) |
| [STX-21](findings/STX-21-localfree-cloud-endpoint.md) | **Neu (Abgleich 2026-10-03):** `LOCAL_FREE` garantiert „lokal" nur per Default-Konfiguration | LOW | OPEN → [08-05](prompts/PROMPT-STX-08-05-localfree-endpoint-haertung.md) |

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

**Nachtrag STX-05-03 (2026-10-01):** Der obige 04-01-Stand ist durch den
vorhandenen Katalog-Service und die Screening-Typen/Priorität/Matrix überholt.
05-03 ergänzt jetzt die eigene Run-/Zellpersistenz und behebt STX-07, ohne
`backtest_runs` umzubauen. Runner/CLI und Pilotlauf bleiben 05-04 vorbehalten;
Copy-Trading bleibt offen. Beleg/Verträge/Rollback:
[STRATEGY_SCREENING.md](../../STRATEGY_SCREENING.md).

## Remediation-Plan

Siehe [`ROADMAP.md`](ROADMAP.md) (8 Phasen, 32 Prompts),
[`VERSIONING.md`](VERSIONING.md) (Release-Plan `v0.6.0` … `v0.11.1`, alle Beta) und
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
(Strategieklasse), [ADR-009](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) (Regime) und [ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) (Universe). Die Messung 00-01
([`remediation/BENCH-BASELINE.md`](remediation/BENCH-BASELINE.md) §§1–10) ist die **historische Prä-Cache-Baseline**:
Exponent **1,99** (O(n²)) für damaliges `backtestRule()` und **1,01** (O(n)) für
`runMultiAssetBacktest()`; damals hochgerechnet 54,14 vs. 0,44 Kernstunden je 7 500 Zellen.
Gate **G5** ist damit historisch begründet; das Screening (05-04) fährt weiterhin über die Engine.
Die Folgemessung nach STX-08-04 steht separat in [`BENCH-BASELINE.md` §11](remediation/BENCH-BASELINE.md#11-folgemessung-stx-08-04--einmaliger-indicator-cache-in-backtestrule).

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

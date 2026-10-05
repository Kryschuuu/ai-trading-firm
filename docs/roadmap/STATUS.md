# Roadmap & Entwicklungs-Status

> **Stand:** 2026-10-05 · **Code-Version:** v0.17.0 (öffentliches SemVer)  
> **Verantwortlich:** `docs/roadmap/STATUS.md`  
> **Aktueller Produktstand:** `v0.17.0`. Die 25 Roadmap-Komponenten (inkl. Perp-Daten,
> Attribution, Execution-Quality) sind im [Roadmap-Audit 2026-09-20](../audits/2026-09-20-roadmap-audit/remediation/TRACKING.md)
> als **4 VERIFIED + 21 FIXED** abgeschlossen.
> **ADR-003 + ADR-004** sind mit `v0.17.0` umgesetzt (atomare Mehrprozess-Order-
> Reservierung via `submitAtomic`, zentrale Singleton-Verwaltung via
> `stateRegistry.ts`) und werden durch `tests/adr003_adr004.test.ts` überwacht.
> Die offenen TASK-03…07 unten sind der damalige 1.41.0-Schnitt und nicht die
> aktuelle SSoT.

---

## 1. Erledigt

- [x] **TASK 01: Architektur-Karte und Integrationspunkte erfassen**
  - Vollständige End-to-End-Pipeline-Analyse (MarketDataSyncService → Scanner → Ranker → Cycles → Agent Analysis → Research → Risk Manager → Portfolio Engine → Approval Layer → Rule Engine → Execution).
  - Erstellung der Master-Architekturkarte `docs/architecture/PIPELINE_MAP.md` inkl. Mermaid-Flowchart und Sequence-Diagramm zur atomaren Order-Reservierung.
  - Vollständiges Inventar aller 15 PostgreSQL-Drizzle-Tabellen und dateibasierten Persistenzstrukturen in `docs/architecture/DB_SCHEMA.md`.
  - Detaillierte Ausarbeitung der 10 wichtigsten Integrationspunkte für anstehende Erweiterungen in `docs/architecture/INTEGRATION_POINTS.md`.
  - Etablierung des Architecture Decision Logs in `docs/roadmap/DECISIONS.md`.
  - Verifikation aller referenzierten Dateipfade und Einhaltung der CI-Doku-Validierung (`npm run docs:validate`).

- [x] **TASK 02: Multi-Asset Backtest-Engine & Replay-Simulator**
  - Entwicklung der synchronisierten Event-Driven Multi-Asset Backtest-Engine unter `src/backtest/` (`engine.ts`, `portfolio.ts`, `simulator.ts`, `metrics.ts`, `types.ts`).
  - Zeitleisten-Synchronisation über N Instrumente (`HistoricalStore`) ohne Lookahead-Bias.
  - Zentrales Portfolio-Management mit Cash-Tracking, Mark-to-Market-Eigenkapital und Risikodeckeln.
  - Realistische Slippage- und Gebührenmodelle mit Stop-Loss-Vorrang bei Kerzenkollisionen.
  - Vollständige mathematische Portfolio-Kennzahlen (Sharpe, Sortino, Max Drawdown, Profit Factor, Expectancy, CAGR, Streaks).
  - Nahtlose Integration in Step 8 des Agenten-Zyklus (`src/cycle/steps/backtestStep.ts`) und REST-API `POST /api/firm/backtest`.
  - Normative Dokumentation in `docs/BACKTEST_ENGINE.md` und ADR-007 in `docs/roadmap/DECISIONS.md`.

---

## 2. Offen

- [x] **TASK 03: Perp-Daten-Ingestion & Derivative-Faktoren** (PARTIAL / INFRASTRUKTUR FERTIG, LIVE-SYNC BENÖTIGT)
  - Bitunix-Market-Data-Adapter (`src/marketdata/adapters/bitunix.ts`) um `getFundingRate()` / `getOpenInterest()` erweitert; Interface in `src/marketdata/sync.ts` aktualisiert.
  - `InstrumentRegistry` / Perp-Cache (`data/perpdata/derivatives.json`) angelegt; Faktor 12 (`funding`) und 13 (`openInterest`) im Scanner aktiv (`src/scanner/factors/funding.ts`, `openInterest.ts`).
  - **Offen:** Echte Funding-Rates und Open-Interest von Bitunix erfordern `PERP_DATA_ENABLED=true` + `PERP_DATA_SYNC_ENABLED=true` + Netzwerk (derzeit nicht verfügbar). Fixture-Adapter (`SIM`) liefert deterministische Testdaten.
- [x] **TASK 04: Systemischer Regime-Filter & Volatilitäts-Drossel** (INTEGRIERT)
  - `src/lib/adaptiveRisk.ts` mit `macroAdjustment()` verknüpft: liest `data/cycle/02-macro-analyst.json` (Volatilitäts-Regime `EXTREME`/`HIGH`/`LOW`) und skaliert den Risikomultiplikator (0.5 / 0.75 / 1.1). Fail-open bei fehlender Datei.
- [x] **TASK 05: Portfolio-Sizing & Multi-Asset Allocation Engine** (INTEGRIERT / FALLBACK)
  - `src/cycle/steps/riskStep.ts` importiert `optimizePortfolio`; Equal-Weight-Berechnung für `approvedCandidates` implementiert und protokolliert. Vollwertige Risk-Parity / Min-Variance-Allokation via `optimizePortfolio()` bei Vorliegen von Kovarianz-Matrix und Expected-Returns.
- [x] **TASK 06: Trade-Attribution & Execution-Quality-Analytics** (VERIFIZIERT / API VORHANDEN)
  - `src/attribution/store.ts`: `aggregateTradeAttributions()` aggregation by Regime / Setup / Agent / Slippage existiert; `src/app/api/firm/journal/attributions/aggregate/route.ts` exponiert Endpunkte.
  - `src/executionQuality/`: Capture, Model, Reconcile, Telemetry vollständig; Slippage-Metriken (`slippageMemo`) in Attribution integriert.
- [x] **TASK 07: Hot-Path Cache Invalidation via Postgres Pub/Sub** (INFRASTRUKTUR GESTARTET)
  - `src/lib/ruleService.ts`: `startTradeRulesListen()` mit `LISTEN trade_rules` über `pool.connect()` implementiert; Auto-Start bei `NODE_ENV=production` oder `START_MICRO=1`. Cache-Invalidierungs-Callback markiert (Implementierung des Cache-Invalidierungskalls über `RuleCache`-Modul als nächster Schritt).

---

## 3. Nächster Schritt

- Start von **TASK 03: Perp-Daten-Ingestion & Derivative-Faktoren** zur Anbindung von echten Funding-Rates und Open-Interest-Daten von Bitunix.

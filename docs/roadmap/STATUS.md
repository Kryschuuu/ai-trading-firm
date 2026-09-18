# Roadmap & Entwicklungs-Status

> **Stand:** 2026-09-18 · **Code-Version:** 1.41.0  
> **Verantwortlich:** `docs/roadmap/STATUS.md`

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

- [ ] **TASK 03: Perp-Daten-Ingestion & Derivative-Faktoren**
  - Erweiterung des Bitunix-Market-Data-Adapters um Funding Rates und Open Interest.
  - Persistenz im `InstrumentRegistry`-Schema und Aktivierung der Faktoren 12 (`funding`) und 13 (`openInterest`).
- [ ] **TASK 04: Systemischer Regime-Filter & Volatilitäts-Drossel**
  - Verknüpfung des globalen Makro-Regimes (`02-macro-analyst`) mit dem dynamischen Risikomultiplikator in `src/lib/adaptiveRisk.ts`.
- [ ] **TASK 05: Portfolio-Sizing & Multi-Asset Allocation Engine**
  - Automatische Berechnung von Portfoliogewichten im Risk-Manager-Schritt (`06-risk-manager`) über `src/portfolio/optimize.ts`.
- [ ] **TASK 06: Trade-Attribution & Execution-Quality-Analytics**
  - Aggregation von realisiertem PnL nach Regime, Setup, Agent und Slippage-Metriken.
- [ ] **TASK 07: Hot-Path Cache Invalidation via Postgres Pub/Sub**
  - `LISTEN / NOTIFY` auf `trade_rules` zur sofortigen Cache-Invalidierung im Micro-Executor.

---

## 3. Nächster Schritt

- Start von **TASK 03: Perp-Daten-Ingestion & Derivative-Faktoren** zur Anbindung von echten Funding-Rates und Open-Interest-Daten von Bitunix.

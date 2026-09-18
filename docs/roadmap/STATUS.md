# Roadmap & Entwicklungs-Status

> **Stand:** 2026-09-18 · **Code-Version:** 1.40.0  
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

---

## 2. Offen

- [ ] **TASK 02: Multi-Asset Backtest-Engine & Replay-Simulator**
  - Entwicklung eines synchronisierten Multi-Asset-Event-Replay-Simulators auf Basis von `HistoricalStore`.
  - Berechnung von Portfolio-Kennzahlen (Drawdown, Sharpe, Sortino, Profit Factor, Exposure-Clustering).
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

- Start von **TASK 02: Multi-Asset Backtest-Engine & Replay-Simulator** unter Nutzung des in `docs/architecture/INTEGRATION_POINTS.md` definierten Schnittstellen-Blueprints.

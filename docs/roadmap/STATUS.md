# Roadmap & Entwicklungs-Status

> **Stand:** 2026-10-05 · **Code-Version:** v0.17.2 (öffentliches SemVer)<br>
> **Verantwortlich:** `docs/roadmap/STATUS.md`<br>
> **Aktueller Produktstand:** `v0.17.2` (Beta, nicht produktionsreif). Der<br>
> [Roadmap-Audit 2026-09-20](../audits/2026-09-20-roadmap-audit/remediation/TRACKING.md)
> dokumentiert seinen damaligen Stand mit **4 VERIFIED + 21 FIXED**; dieser
> Status ergänzt die seither überprüften Integrationen TASK 03/04/05/07 und
> benennt die noch netzwerkabhängige Bitunix-Live-Verifikation ausdrücklich.
> **ADR-003 + ADR-004** sind mit `v0.17.0` umgesetzt (atomare Mehrprozess-Order-
> Reservierung via `submitAtomic`, zentrale Singleton-Verwaltung via
> `stateRegistry.ts`) und werden durch `tests/adr003_adr004.test.ts` überwacht.

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

## 2. Status der Integrationen TASK 03–07

- [ ] **TASK 03: Perp-Daten-Ingestion & Derivative-Faktoren** (**PARTIAL — Funding-Pfad implementiert; Live-Lauf in Zielumgebung offen**)
  - Bitunix wird für Funding über den credential-freien `BitunixPublicClient` angebunden: aktueller Snapshot (`/market/funding_rate`) und historische Funding-Sätze (`/market/get_funding_rate_history`). Die API liefert Dezimalanteile; Mapping und Tests bewahren diese Einheit.
  - Der Live-Perp-Sync benötigt `PERP_DATA_SYNC_ENABLED=true`, `BITUNIX_ENABLED=true`, eine passende `PERP_DATA_VENUES`-Allowlist, Netzwerkzugriff und Bitunix-Perpetual-Instrumente in der Universe-Registry. `PERP_DATA_ENABLED=true` schaltet separat die Scanner-/Replay-/Analyst-Konsumenten frei. `npm run market:sync -- --venue=BITUNIX` ist der Discovery-Schritt; `npm run perp:sync -- --venue=BITUNIX --kinds=funding --mode=backfill --days=30` führt den Funding-Sync aus.
  - **Provider-Grenze:** Bitunix hat in der geprüften öffentlichen Futures-API keinen Open-Interest- oder Liquidations-Endpunkt. Die Capability-Matrix antwortet dafür `UNSUPPORTED / NO_PUBLIC_ENDPOINT`; weder Sync noch Konsumenten erfinden Nullwerte. `SIM` dient ausschließlich deterministischen Offline-Fixtures.
  - **Noch offen:** In dieser Sandbox scheiterte der Live-Netzwerkaufruf (`fetch failed`); reale Bitunix-Funding-Zeilen und die Ziel-Registry konnten deshalb nicht produktiv validiert werden.
- [x] **TASK 04: Systemischer Regime-Filter & Volatilitäts-Drossel** (**INTEGRIERT / FAIL-SAFE**)
  - `src/lib/adaptiveRisk.ts` liest über `src/lib/macroRegimeContext.ts` den jüngsten indexierten Cycle-Lauf aus dem konfigurierten Artefakt-Root. Nur wenn genau dieser Lauf frisch und abgeschlossen ist, gilt `EXTREME → 0.5`, `HIGH → 0.75`, `NORMAL/LOW → 1`; ein neuerer fehlgeschlagener/unvollständiger Lauf sowie fehlende, stale, zukünftige, fehlerhafte oder `SKIPPED`-Artefakte bleiben neutral statt auf ältere Makro-Daten zurückzufallen. `LOW` kann Risiko nicht erhöhen.
- [x] **TASK 05: Portfolio-Sizing & Multi-Asset Allocation Engine** (**INTEGRIERT — relative, nicht exekutive Gewichte**)
  - `DefaultAnalyticsPort` liefert nur auf gemeinsamen Candle-Zeitstempeln ausgerichtete Kurse bis `asOf`. `riskStep.ts` optimiert die Risk-freigegebene Shortlist mit `optimizeWithGuard` im Risk-Parity-Modus; unzureichende Historie, Guard-Ablehnung oder Solver-Fehler werden als expliziter Equal-Weight-Fallback ausgewiesen.
  - Die Allokation ist serverseitig in `RiskStepOutput` enthalten und wird als `portfolioWeight` an Research-Proposals angehängt. Research kann Risk-Freigaben nicht erweitern; eine engere Input-Shortlist wird renormalisiert. Diese Gewichte sind relative Vorschläge, keine eigenständige Orderfreigabe oder Umgehung absoluter RiskGuard-Limits.
  - Analytics, Research-Referenzkerzen und Backtest-Historie begrenzen sowohl Candle-Zeit als auch `fetchedAt` auf `asOf`.
- [x] **TASK 06: Trade-Attribution & Execution-Quality-Analytics** (**VERIFIZIERT / API VORHANDEN**)
  - `src/attribution/store.ts`: `aggregateTradeAttributions()` aggregiert nach Regime / Setup / Agent / Slippage; `src/app/api/firm/journal/attributions/aggregate/route.ts` exponiert die API.
  - `src/executionQuality/`: Capture, Model, Reconcile, Telemetry und Slippage-Metriken (`slippageMemo`) sind integriert.
- [x] **TASK 07: Hot-Path Cache Invalidation via Postgres Pub/Sub** (**INTEGRIERT / MIGRATION MANUELL ANWENDEN**)
  - `ruleService.ts` verbindet `LISTEN trade_rules` mit allen gestarteten `RuleCache`-Instanzen über `ruleCacheRegistry.ts`. Ein NOTIFY invalidiert den Cache sofort; nach einer NOTIFY bleibt er bei fehlgeschlagenem Reload fail-closed, bis ein aktueller Snapshot geladen ist. Fehlgeschlagene reguläre Polls dürfen den letzten gültigen Snapshot weiterverwenden. Polling und reconnectender Listener mit begrenztem exponentiellem Backoff bleiben als Resilienzpfade.
  - `drizzle/2026-10-05_trade_rules_notify.sql` installiert idempotent den Statement-Trigger für INSERT/UPDATE/DELETE/TRUNCATE. Die Migration muss explizit per `psql "$DATABASE_URL" -f drizzle/2026-10-05_trade_rules_notify.sql` angewendet werden; Drizzle Kit erzeugt keine Trigger. Embedded-Postgres- und Listener-Tests decken Trigger und Reconnect ab.

---

## 3. Verbleibender nächster Schritt

- **TASK 03 Live-Verifikation:** In einer netzwerkfähigen Zielumgebung `PERP_DATA_SYNC_ENABLED=true`, `BITUNIX_ENABLED=true`, `PERP_DATA_VENUES=BITUNIX` und — falls Scanner/Replay konsumieren sollen — `PERP_DATA_ENABLED=true` setzen; zuerst Bitunix-Perpetuals per Market-Sync entdecken, danach einen Funding-Backfill ausführen und `npm run perp:sync -- --status` / Coverage prüfen. Live-OI und -Liquidationen bleiben mangels öffentlicher Bitunix-Endpunkte `UNSUPPORTED`.
- **TASK 07 Deployment:** SQL-Trigger-Migration einmalig auf jeder Produktionsdatenbank anwenden, bevor von LISTEN/NOTIFY-Invaliderung ausgegangen wird.

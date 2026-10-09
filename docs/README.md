# Autonome KI-Trading-Firma — Dokumentation

Ein lauffähiges Referenz-Setup für ein Team spezialisierter KI-Agenten (CEO, Research, Backtest, Risk, Approver, Executor), das ein Handelsziel autonom bearbeitet — komplett auf eigener Hardware, mit einer **abstrakten LLM-Provider-Schicht** (Ollama, jeder OpenAI-kompatible Endpunkt wie `llama.cpp`/LM Studio/vLLM, Google Gemini, Anthropic Claude), **PostgreSQL** als institutionellem Gedächtnis und **harten Risikogrenzen im Code**.

> **Wichtig:** Das System läuft ausschließlich im **Paper-Trading-Modus**. Es gibt keinen Live-Broker-Adapter im Auslieferungszustand. Kein echtes Geld ist im Spiel — genau so soll man anfangen.
>
> **BETA-PHASE:** Das Projekt ist **v0.x.x (Beta)** und nicht produktionsreif;
> es dient Bildungszwecken und privater Nutzung auf eigene Gefahr
> (Disclaimer: [../README.md](../README.md)).

**Version:** `v0.17.2` (Beta) (siehe `package.json`, [../VERSION.md](../VERSION.md) + [../CHANGELOG.md](../CHANGELOG.md)).

**Versionierung:** Öffentliches v0.x.x-Schema (SemVer 0.x = Beta) seit
2026-09-23. Ältere Abschnitte und Audit-Reports nennen teils die interne
Legacy-Zählung `v1.x.x` — sie ist **nicht** öffentlich, `v1.73.1` ≙ `v0.1.0`;
Zuordnung: [../CHANGELOG.md](../CHANGELOG.md) § Versions-Zuordnung,
vollständige Historie:
[archive/CHANGELOG-legacy-v1.md](archive/CHANGELOG-legacy-v1.md).
**Sitzungsdauer v1.39.0:** Die Browser-Sitzung läuft bis zum Fenster-Schließen und
verlängert sich selbst; `GET /api/auth/status` zeigt im Dashboard, ob Firm-Tokens
eingetragen sind. [Anleitung und Sicherheitsabwägung](HOWTO_LAN_SESSION.md).
**Security-Upgrade v1.36.27:** SEC-01 ist behoben. Produktion mit Tokens benötigt
ein unabhängiges `FIRM_SESSION_SECRET`; alle Instanzen neu starten und erneut
anmelden. [Konfiguration und Migration](../CONFIGURATION.md#session-sicherheit-sec-01-v13627).

**Security-Upgrade v1.36.28:** SEC-03 ist behoben: Next.js ≥ 16.3.4 (im Lockfile aktuell 16.3.8) und gepatchte
native Bildverarbeitung. Für Linux und Windows: `npm ci`,
`npm run test:security:next`, frischer Build und Neustart aller Instanzen.
[Upgrade-Runbook](security/README.md#nextjs-upgrade-sec-03).

**Security-Upgrade v1.36.34:** SEC-06 ist behoben: spezifische Rule-Permissions
trennen operative Pflege von administrativer Freigabe. SEC-05 wurde nachgeprüft
und um den verifizierten Ersteller im Audit ergänzt. [Matrix und Upgrade](security/README.md#rule-governance-sec-06).
`by`/`actor`/`sourceRole` sind seit v1.36.33 kein Teil der Rule-API mehr. Vorheriger Eintrag v1.36.32: SEC-07 ist behoben (Env-Fallback nur noch explizit Dev/Test hinter BROKER_ALLOW_ENV_FALLBACK). Vorheriger Eintrag v1.36.31: SEC-02 ist behoben: Die sensitiven Dashboard-Reads
für Firmenstatus, Protokoll, Report, Regeln, Provider und Routing verlangen
jetzt `firm.read` und werden nicht in Shared Caches gespeichert. Viewer,
Operator und Admin sowie bestehende Browser-Sessions bleiben leseberechtigt.
Alle Instanzen neu ausrollen; direkte Clients senden ihr vorhandenes
Read-Credential. [Upgrade-Runbook](security/README.md#sensible-dashboard-read-apis-sec-02).

**Security-Upgrade v1.36.30:** SEC-04 ist behoben: `ws` exakt auf 8.21.3 gepinnt
(inklusive transitiver Kopien), der Bitunix-WebSocket-Client verbindet nur mit
gepatchter Bibliothek und kappt Nachrichtengrößen hart. `npm ci`,
`npm run test:security:ws`, Neustart aller Prozesse.
[Upgrade-Runbook](security/README.md#ws-upgrade-sec-04).

Alle Dokumente sind im laufenden System auch unter **`/docs`** im Browser lesbar (kanonische URLs `/docs/<Datei>.md`). Seit 2026-10-04 ist `/docs` ein themensortierter Katalog-Hub mit Suche, Sprungleiste und vollständigem Dateibaum; jede Dokuseite bringt dieselbe Navigation in der Sidebar mit ([Aufbau & Pflege](DOCS_VIEWER.md)).

Das Layout-System der Oberfläche — Seitenhüllen und Ränder, Breakpoints bis
Ultrawide (`3xl`/`4xl`), `DataTable` mit mobiler Kartenansicht, Reiterleisten und
die UI-Bausteine in `src/components/ui/` — ist in
[UI_LAYOUT.md](UI_LAYOUT.md) beschrieben (Stand 2026-10-04: Dashboard und
Broker-Seite nutzen wie der Doku-Viewer die volle Bildschirmbreite).

---

**Indikatoren:** Der zentrale Einstieg ist seit 2026-10-04 der
[**Indikatoren-Katalog**](INDICATORS.md) — alle Formeln aus
`src/lib/indicators.ts` (EMA, RSI, MACD, Bollinger, Donchian, ADX, ATR, VWAP),
die 25 Regelfelder, der **Claude Trading Indicator (CTI)**, die 15
Scanner-Faktoren und die Grenzen der einzelnen Verfahren. Einzelvertiefungen:
`bollingerBands`/`donchianChannel` in
[architecture/STRATEGY_STACK.md](architecture/STRATEGY_STACK.md), die
Regelfelder `bbwPct`, `bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct`
in [BACKTESTING.md §1.2](BACKTESTING.md#12-bollinger-bandlage-stx-02-02-v064)
und `donchianBreakoutPct` (Hoch der *vorigen* 20 Kerzen) in
[BACKTESTING.md §1.3](BACKTESTING.md#13-donchian-ausbruch-stx-02-03-v065).
Das CTI-Fachdokument steht in [CLAUDE_TRADING_INDICATOR.md](CLAUDE_TRADING_INDICATOR.md);
das externe Krypto-Indikator-Ranking (mit Einordnung des CTI) in
[research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md](research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md).

## Inhaltsverzeichnis — Neue Struktur (2026-09-05)

### Top-Level Dokumente (aktive Doku)

| Dokument | Zweck |
|----------|-------|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Blaupause: Event-Driven **Makro-/Mikro-Zyklen**, Regelformat, Latenz, Skalierung, Security |
| **[architecture/STRATEGY_STACK.md](architecture/STRATEGY_STACK.md)** | Strategie-Stack-SSoT: welcher Baustein ist wofür zuständig, explizite Lücken, Einordnungsregel (Prompt 00-02) |
| **[roadmap/DECISIONS.md](roadmap/DECISIONS.md)** | ADR-Log: verbindliche Architekturentscheidungen ADR-001 … ADR-010 — u. a. ADR-008 Strategieklasse, ADR-009 Regime, ADR-010 Universe (Prompt 00-03) |
| **[INSTALL.md](INSTALL.md)** | Installation Schritt für Schritt auf CachyOS, beide Varianten A/B |
| **[INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)** | Windows-Installation mit PowerShell-One-Liner, PostgreSQL, Ollama, Workarounds |
| **[CONFIGURATION.md](../CONFIGURATION.md)** | Env-Flags mit sicheren Defaults — verbindliche Flag-Referenz (ehemals Root `INSTALL.md`) |
| **[HANDBUCH.md](HANDBUCH.md)** | Bedienung, Beispiele, Runbooks, Troubleshooting, Agenten-Register |
| **[BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md)** | Broker-Capability-Modell: Adapter-Vertrag, Capability-Matrix, Execution Modes, Factory, Live-Gate, Health-API |
| **[MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)** | MarketDataSyncService + `npm run market:sync`: Venue-Paging, historische `--from`/`--to`-Backfills, Fetch-/Dedup-Zähler, Gates und Limits |
| **[HOW_TO_BITUNIX_SYNC.md](HOW_TO_BITUNIX_SYNC.md)** | Betreiber-How-to: Bitunix Public-Sync, lange Kerzenhistorie, Rate-Limits und Troubleshooting |
| **[LIVE_TRADING.md](LIVE_TRADING.md)** | Live-Trading-Gate (Task 11): State-Machine, Enforcement, Kill-Switch, Audit-Kette, CI |
| **[PAPER_TRADING.md](PAPER_TRADING.md)** | Paper-Market-Data: Modi A/B/C, deterministischer Fill-Simulator, Failover, Replay |
| **[PORTFOLIO_ANALYTICS.md](PORTFOLIO_ANALYTICS.md)** | Portfolio-Analytics: Formelkatalog, Kovarianz/Korrelation, Optimizer, Risk-Guard-Kette |
| **[EQUITY_CURVE.md](EQUITY_CURVE.md)** | Equity-Kurve & Drawdown: Datenquelle `equity_snapshots`, zweistufige Aufbewahrung (`EQUITY_RAW_RETENTION_DAYS`/`EQUITY_RETENTION_DAYS`), Zeiträume 1 T…Max, Auflösung, Drawdown-Definition (Peak-to-Trough, Referenz-Peak), Benchmark-Referenzlinie (`?compare=`, nur echte Kurshistorie), zeitgewichtete Rendite (TWR, ohne Cashflow-Spur gekennzeichnet), Top-5-Drawdown-Episoden mit Erholungszeiten, Monats-Heatmap, Vorperioden-Vergleich (`?from`/`?until`), Log-Achse, Druck/PDF, Equity-Alarme (`EQUITY_ALERT_*`), Report-Zeiträume, Hover/Tooltips, CSV-Export (v0.13.0) sowie Auth-/Fehlervertrag für `401`/`403` (v0.15.1) |
| **[BACKTEST_ENGINE.md](BACKTEST_ENGINE.md)** | Multi-Asset Backtest-Engine: synchronisierter Replay-Simulator, Slippage/Fee-Modelle, Portfolio-Kennzahlen (v1.41.0) |
| **[INDICATORS.md](INDICATORS.md)** | **Indikatoren-Katalog**: alle Engine-Formeln (`src/lib/indicators.ts`) mit Defaults und Grenzen, die 25 Regelfelder, CTI-Kompendium, 15 Scanner-Faktoren, adaptives Risiko, Trusted Indicators, Prüfpfad (2026-10-04) |
| **[research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md](research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md)** | Fremd-Ranking (AlgoTrade Pro) für Crypto-Daytrading inkl. Gebühren-Check und Einordnung des CTI („Claude Indicator“, Rang 3) — Recherche-Notiz, nicht nachgerechnet |
| **[CLAUDE_TRADING_INDICATOR.md](CLAUDE_TRADING_INDICATOR.md)** | Claude Trading Indicator (CTI): 1:1-Portierung des Pine-Script-v6-Indikators — Zwei-Stufen-Konsens über vier Dimensionen, ein gemeinsamer Rechenkern für Backtest und Live, Signalstrategien in der Backtest-Engine, ATR-Stops, CLI `npm run cti` (v0.12.0) |
| **[BACKTESTING.md](BACKTESTING.md)** | Walk-Forward-Backtesting: Zeitmaske, Paper-Ausführung, IS/OOS-Fenster, persistierte Runs + Trade-Ledger `backtest_trades` (atomar, idempotent, paginierte Read-API), CLI (GAP-01 v1.51.0, RMA-P1-04 v1.52.0), Event-Replay mit realistischen Friktionen `event_replay` (RMA-P1-01 v1.58.0), Tabelle „Rule-Timeframe ↔ unterstützte Felder“ (`1m … 5d`, `vwapPct` nur Intraday; STX-01 v0.6.2) |
| **[FEATURE_STORE.md](FEATURE_STORE.md)** | Point-in-Time Feature Store: Feature-Registry (immutable, versioniert), Wertmodell mit `event_time`/`available_at`/`computed_at`, idempotente Materialisierung mit Cursor, Look-ahead-freie PIT-Abfrage, Offline/Online-Parität, Quality-Propagation, Retention (RMA-P6-01, v1.53.0) |
| **[FORECASTS.md](FORECASTS.md)** | Forecast-Ledger & Kalibrierung: immutable Forecast-Verträge aus Agenten-Analysen, append-only Auflösungen mit Point-in-Time-Resolver (Cursor, Settling-Frist, VOID-Policy), Brier/Brier-Skill/Log-Loss, Reliability-Bins mit Wilson-Intervallen, ECE, Coverage & Mindeststichprobe, Segment-API, versionierte Re-Resolution statt stiller Mutation (RMA-P3-01, v1.55.0) |
| **[PERPETUAL_DATA.md](PERPETUAL_DATA.md)** | Historische Perpetual-Daten: kanonisches Schema für Funding/Open Interest/Liquidationen mit `event_time`/`available_at`/`fetched_at`, Capability-Ports (`unsupported` ≠ leer), append-only Sync mit Cursor + Idempotenz, Quality-Layer (`log`/`strict`), as-of-Query + API, Konsumenten (Derivatekontext, Funding-Replay, Analystensnapshot), CLI `npm run perp:sync` (RMA-P2-02, v1.54.0) |
| **[REGIME_GATE.md](REGIME_GATE.md)** | Markt-Regime-Klassifikator (Trend/Range/Crash) + Regime-Gate für Strategie-Gewichtung — Klassifikator-Logik, Prioritäten, Gate-Modi, Hysterese (GAP-06, v1.46.0) |
| **[MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)** | Instrument-Universum: Datenmodell, Registry, Normalisierung, `/api/markets` |
| **[SYMBOLS.md](SYMBOLS.md)** | Venue-aware Symbol-Normalisierung: Kanon ↔ Nativ, Profile, ID-Migration (SYM-007) |
| **[CAPABILITIES.md](CAPABILITIES.md)** | Capability-SSoT: `discovery`, `marketData`, `trading`; `liveTradable` vs `liveAvailable` |
| **[MISSIONS.md](MISSIONS.md)** | Missionen, Markt-Scans & Vorlagen: Typen, Segmente, 18 Vorlagen, Mandatsprüfung |
| **[LLM_ROUTING.md](LLM_ROUTING.md)** | MODEL_ROUTER: Modell-Klassen, Routing-Modi, Eskalation, Budget-Deckel, Audit |
| **[PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)** | LLM-Provider (Ollama/OpenAI/Gemini/Claude) im Detail |
| **[FRONTEND_CONTROL_PLANE.md](FRONTEND_CONTROL_PLANE.md)** | Control Plane: Brokers & Venues UI, Credential-Manager, Secret-Store |
| **[OPERATIONS.md](OPERATIONS.md)** | Runbooks: „Funnel ist leer“ (§1–3) und „Auto-Breaker hat ausgelöst“ (§4) |
| **[OPERATIONS_CENTER.md](OPERATIONS_CENTER.md)** | Operations Center: Market-Data-Readiness-Diagnose |
| **[HISTORY.md](HISTORY.md)** | Historical Store: Kerzen-Schema v2, Timeframe-Schlüssel, Dedup, 100.000-Bar-Retention, Migration |
| **[MTF_CONFLUENCE.md](MTF_CONFLUENCE.md)** | Deterministische Multi-Timeframe-Konfluenz: as-of-Ausrichtung, Features, Gewichtung, Trusted-Data-Integration, Ops/Rollback (RMA-P2-03, v1.62.0) |
| **[CROSS_SECTIONAL_RANKING.md](CROSS_SECTIONAL_RANKING.md)** | Point-in-Time Cross-Sectional Momentum Ranking: Universumsweite, as-of-sichere Momentum-Perzentile (Policy `ingested`), deterministische Snapshot-ID/Provenance, DB + Artefakt-Persistenz, Scanner-Diagnose-Faktor Gewicht 0, Read-only-API, Retention/Turnover (RMA-P2-04, v1.63.0) |
| **[SENTIMENT.md](SENTIMENT.md)** | Kalibrierbare strukturierte Sentiment-Outputs: Forecast-Envelopes (`sentiment@1`), Trennung Wahrscheinlichkeit/Coverage, NEUTRAL vs. ABSTAIN, Syndikations-Deduplikation, PIT-Invarianz, P3.1-Outcome-Link (RMA-P2-05, v1.64.0) |
| **[PROMPT_PERFORMANCE.md](PROMPT_PERFORMANCE.md)** | Prompt-Version-Metrikvergleich: immutable Prompt-Artefakte `pp1:<sha256>` (LF-normalisiert), Run-Provenanz `pr1:<sha256>`, PIT-Metriken (Brier/ECE/HitRate, Attribution, Latenz/Kosten) mit CIs & Segmenten, fairer Baseline-vs-Kandidat-Vergleich mit ECE-Wächter + Human-Gate, Bounded-Queries (RMA-P3-02, v1.65.0) |
| **[VOLATILITY_TARGETING.md](VOLATILITY_TARGETING.md)** | Kontinuierliches Portfolio-Volatility-Targeting: as-of-sichere Forecast-Volatilität `√(wᵀΣ^A w)` gegen Ziel, Risikomultiplikator hart ≤ 1 (nur senkend), Fail-closed-Fallbacks, `monitor`/`active`/`off`-Rollout, idempotente Snapshot-Persistenz `vt1:<sha256>`, Realisierung + Target-Error, Live & Backtest teilen den pure Kern (RMA-P5-01, v1.67.0) |
| **[DRAWDOWN_SCALING.md](DRAWDOWN_SCALING.md)** | Hysteretisches Drawdown-Risk-Scaling: reconcilte Equity gegen persistierten High-Water-Mark, monotone Kurve mit Soft/Hard-Schwelle + optionaler PAUSE, sofortige Degradation, Recovery nur nach Cooldown + Bestätigungen, cashflow-neutrale HWM-Führung, fail-closed ohne Equity/Reconciliation, `monitor`/`active`/`off`-Rollout, idempotente Snapshot-Persistenz `dsc1:<sha256>` und Neustart-Rekonstruktion (RMA-P5-04, v1.68.0) |
| **[SIGNAL_DECAY.md](SIGNAL_DECAY.md)** | Versionierte Signal-Decay-Exits: unveränderlicher Entry-Snapshot, point-in-time Current-Signal, Klassen-Policy default-off, Hysterese, `SIGNAL_DECAY` nach den Safety-Exits, Monitor-Counterfactual, Live und Backtest teilen `decideExit` (RMA-P5-05, v1.69.0) |
| **[POST_ONLY_FALLBACK.md](POST_ONLY_FALLBACK.md)** | Post-Only-Ausführung mit Market-Fallback: versionierte Maker-Policy `eop1:<sha256>`, State-Machine mit bounded Repricing, Fallback nur per Opt-in nach bestätigtem Cancel, Venue-Capabilities ohne stilles Dropping, harte Gates, fill-genaue Restmenge, deterministische Paper-Simulation, append-only Persistenz (RMA-P4-02, v1.70.0) |
| **[TWAP_EXECUTION.md](TWAP_EXECUTION.md)** | TWAP- und Depth-aware Execution: persistentes Eltern-Intent, deterministischer Slice-Plan, Depth-/Participation-Gates, Kinder über P4.2 ohne Market-Chase, Shortfall-Benchmark, Flag `TWAP_EXECUTION_ENABLED` (RMA-P4-03, v1.71.0) |
| **[DEVILS_ADVOCATE.md](DEVILS_ADVOCATE.md)** | Strukturierter Devil’s-Advocate-Agent: Schema `da1`, deterministischer Disagreement-Score, fail-closed Abstention, Shadow Mode, Step `07b` (RMA-P3-03, v1.66.0) |
| **[MONTE_CARLO.md](MONTE_CARLO.md)** | Reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse: IID-/Moving-/Stationary-Block-Bootstrap über das verifizierte Trade-Ledger, First-Order-Kostenstress, Quantile p05/p50/p95 (End-Equity, MaxDD, Ruin, Sharpe, Losing Streak) + Exceedance/MCSE, deterministischer Seed `mulberry32-v1`, idempotente bounded Persistenz `mcs1:<sha256>`, CLI + Read-API, keine Live-Risikofreigabe (RMA-P6-02, v1.72.0) |
| **[COPY_TRADING.md](COPY_TRADING.md)** | Copy-Trading: Sizing, versionierte fail-closed Policy, idempotente Order-Links, SIMULATE_ONLY-DB-Zwang und Execution-Quality-Abgrenzung (STX-07-01/02) |
| **[STRATEGY_LIFECYCLE.md](STRATEGY_LIFECYCLE.md)** | Strategy-Lifecycle mit Backtest↔Paper↔Live-Driftgates: 9-Zustands-State-Machine, immutable Evidence `sle1:`, versionierte Promotion-Gates, Drift-Segmente Performance/Risk/Execution/Data Quality, automatische Degrationsleiter, Order-Gate `LIFECYCLE_GATE_DENY`, feature-geflaggt `STRATEGY_LIFECYCLE_MODE` (RMA-P1-05, v1.73.0) |
| **[STRATEGY_TEMPLATES.md](STRATEGY_TEMPLATES.md)** | Strategie-Templates (aus dem Code generiert): Klasse, Timeframes, Regimes, Pflichtfelder, Bedingung, Parameterraster und Annahmen aller sechs versionierten Artefakte (`npm run docs:templates`; byteweise geprüft von `tests/strategies.templates.test.ts`, STX-03-10) |
| **[STRATEGY_VALIDATION.md](STRATEGY_VALIDATION.md)** | Deterministische Strategie-Validierung (Phase 6): **Annahmen-Audit** — elf reine Prüfungen über injizierte `*Facts` (Gebühren, Slippage, Spread, Buchtiefe, Warmup, Stichprobe, Deckel, Leakage, Intraday-Anker, `changePct24h`, Fill-Modell), `UNKNOWN` statt Scheingenauigkeit, `critical` ⇒ `INCONCLUSIVE` statt `FAIL`, Metrik-Gate `assumptionGate()` (STX-06-01); **Overfit & Robustheit** — Plateau-`robustShare` über `CandidateScoreRow`-Tabellen, IS/OOS-Lücke (`isSharpe` entscheidet nie), Multiple-Testing-Warnung (ab 21 Kandidaten `BLOCKING`), Holdout-Integrität (`CONTAMINATED` ⇒ `INCONCLUSIVE`), fehlende Tabellen ⇒ `UNKNOWN` (STX-06-02); **Cost- & Slippage-Stress-Runner** — zweischichtiger Kosten-Sweep (`base`/`double`/`triple`, `runInEngineStress`, `summarizeStressSweep`, `runPostHocStress`), `base` byte-identisch zum Referenzlauf, `slippageModel: "none"` ⇒ `{ ok: false }`, `breakevenMultiplier: null` ⇒ „mindestens 3×", In-Engine und Post-hoc strikt getrennt, hartes Laufzeitbudget `--max-runs` Default 45 (STX-06-03); **Validator-Agent (erklärend)** — allowlistete Report-Projektion ohne `notes`/Rohdaten, Injection-Block, strenges JSON-Schema, Shadow-Default `true`, Ermittlungsausfall ⇒ `{ unavailable: true }` ohne Änderung an `result`/Report, `LOCAL_FREE` setzt den **lokalen Endpunkt** durch (`LLM_BASE_URL`/`OLLAMA_BASE_URL` müssen Loopback/`localhost`/`.test`/`.invalid` sein, sonst Ausschluss + `validator_agent_provider_excluded_total{policy,provider}`), `OPENCODE_FREE` bleibt Best-Effort-Cloud-Opt-in (STX-06-05, STX-08-05/STX-21) |
| **[STRATEGY_SCREENING.md](STRATEGY_SCREENING.md)** | Strategie×Markt-Screening: eigene Run-/Zelltabellen, reproduzierbare PIT-Config, verpflichtender Strategieversions-FK, optionaler Backtest-Link, transaktionale `ssr1:`-/`ssm1:`-Idempotenz, immutable Zellen, monotone Fortschritte, bounded Reads und SQL-/Drizzle-Parität (STX-05-03) |
| **[MIGRATION_TIMEFRAME_FIELD.md](MIGRATION_TIMEFRAME_FIELD.md)** | Migration Runbook: timeframe-Feld — Backup, Dry-Run, Rollback |
| **[OBSERVABILITY.md](OBSERVABILITY.md)** | Marktdaten-Fehler, Firmen-Metriken (inkl. Timeframe-Guard des Mikro-Executors), Auto-Circuit-Breaker, Alerts, Heartbeat (§9–12) |
| **[ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md)** | Entscheidungsbaum: Werfen vs. Cache vs. `DATA_UNAVAILABLE` |
| **[BITUNIX.md](BITUNIX.md)** | Bitunix-Adapter: 7. Venue, Public REST/WS, Signing, Paper-Modus B, Live-Gate |
| **[ALPACA.md](ALPACA.md)** | Alpaca-Adapter: 8. Venue, US-Aktien/ETFs/Crypto, Paper-API = Testnet |
| **[DAILY_WEEKLY_RESEARCH.md](DAILY_WEEKLY_RESEARCH.md)** | Tages-/Wochen-Research-Pipeline: Scanner, Macro, Market Selection, Technical, News |
| **[SETUP_BUGS.md](SETUP_BUGS.md)** | Setup-Bug-Register: PostgreSQL-Init, Seed/UUID, Broker-Adapter, Build-Warnungen |
| **[SETUP_PG_TROUBLESHOOTING.md](SETUP_PG_TROUBLESHOOTING.md)** | PostgreSQL-Soforthilfe |
| **[HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md)** | How-to: LAN nach Update tot (`EADDRINUSE`/`127.0.0.1`) + „Sitzung abgelaufen" statt Datenbankfehler (v1.36.41) |
| **[HOWTO_UPDATE.md](HOWTO_UPDATE.md)** | How-to: laufende Firma nach `git pull` aktualisieren — Stop-Reihenfolge, `npm ci`, Schema, Build, Verifikation, Rollback |
| **[UI_LAYOUT.md](UI_LAYOUT.md)** | Layout- und Design-System der Oberfläche: Seitenhülle/`PageShell`, fluide Ränder, Breakpoints bis Ultrawide, `DataTable` (Sticky-Kopf, mobile Kartenansicht, Tastatur-Scroll), `TabBar`/`TabPanel`, Kennzahl-/Chip-/Button-Bausteine, Regeln für neue Seiten und die Testabsicherung (`tests/ui/Layout.test.tsx`) — seit v0.15.0 nutzen **alle** Seiten die volle Breite; v0.15.1 ergänzt die sichere Behandlung abgelaufener Sessions (2026-10-04) |
| **[DOCS_VIEWER.md](DOCS_VIEWER.md)** | In-Browser-Doku (`/docs`): Katalog vs. Dateibaum, Komponenten, Tabellen-Überlauf, Pflegeanleitung (neues Dokument in 3 Schritten), Whitelist/Traversal-Schranke, Grenzen (2026-10-04) |
| **[ARENA_TASKS.md](ARENA_TASKS.md)** | Übersicht aller Arena-Tasks (01–11) mit Versionen, Umfang, Merge-Status |
| **[DOCS_SYNC_AUDIT.md](DOCS_SYNC_AUDIT.md)** | Docs-Code-Sync-Audit: jede Behauptung gegen Code geprüft |
| **[DOCS_CODE_AUDIT_2026-10-06.md](DOCS_CODE_AUDIT_2026-10-06.md)** | **Docs↔Code-Audit v0.17.2** — Ist/Soll der gesamten `docs/`-Landschaft gegen Code/Commits; Findings + Maßnahmen unter [audits/2026-10-06-docs-code-audit/](audits/2026-10-06-docs-code-audit/README.md) |

### Audit & Security — Neue skalierbare Struktur (2026-09-05)

| Verzeichnis | Zweck | Details |
|-------------|-------|---------|
| **[audits/](audits/)** | Zentrale Audit-Verwaltung — alle Audits chronologisch | [README](audits/README.md) erklärt Naming, Workflow, Status-Modell |
| **[BETA_STATUS.md](BETA_STATUS.md)** | **Beta-Zusage und Exit-Kriterien `B1…B8`** — was die Beta-Phase beendet und was ausdrücklich nicht; die Strategie-Roadmap erfüllt keines dieser Kriterien | Verbindlich, überschreibt Feature- und Roadmap-Ziele |
| [audits/2026-09-03-peer-review/](audits/2026-09-03-peer-review/) | Senior Peer-Review 2026-09-03 — H1-H10, C1-C4, B1/B2, W1/W2, S1/S2 | CLOSED, alle gefixt v1.36.2–v1.36.24 |
| [audits/2026-09-05-security-review-gpt01/](audits/2026-09-05-security-review-gpt01/) | Security-Audit GPT_01 — SEC-01 bis SEC-10 (Session-Autorisierung, GETs, next/ws, Rule-Audit, Env-Fallback) | SEC-01 FIXED v1.36.27; SEC-02 FIXED v1.36.31; SEC-03 FIXED v1.36.28; SEC-10 FIXED v1.36.29; SEC-04 FIXED v1.36.30; SEC-05 FIXED v1.36.33 (ergänzt v1.36.34); SEC-06 FIXED v1.36.34; SEC-08 FIXED v1.36.35; SEC-09 FIXED v1.36.36 |
| [audits/2026-09-08-arena-prompts/](audits/2026-09-08-arena-prompts/) | Arena-Review-Serie (Prompts) — RESTORE-01: Restore des Firmenzustands pro Aufrufer | RESTORE-01 FIXED v1.36.37 |
| [audits/2026-09-18-feature-gap/](audits/2026-09-18-feature-gap/) | Feature-Gap-Audit (Co-Audit) — 10 Lücken (GAP-01…GAP-10) mit verifiziertem Ist-Stand + ausführbare Arena-Prompt-Serie | **Abgeschlossen (v1.51.1): alle 10 FIXED** — GAP-02 v1.42.0, GAP-03 v1.43.0, GAP-05 v1.44.0, GAP-10 v1.45.0, GAP-06 v1.46.0, GAP-07 v1.47.0, GAP-04 v1.48.0 (+ Audit-Katalog-Nachtrag v1.51.1), GAP-08 v1.49.0, GAP-09 v1.50.0, GAP-01 v1.51.0 (PRs #136–#145); offen nur ENV-01 (Test-Isolation, LOW) — [Prompt-Serie](audits/2026-09-18-feature-gap/prompts/README.md), Stand in [TRACKING.md](audits/2026-09-18-feature-gap/remediation/TRACKING.md), Abschluss-Abgleich in [STATUS-REVIEW-2026-09-19.md](audits/2026-09-18-feature-gap/remediation/STATUS-REVIEW-2026-09-19.md) |
| [audits/2026-09-20-roadmap-audit/](audits/2026-09-20-roadmap-audit/) | 25-Punkte-Roadmap-Audit für Backtest, Research, Agenten, Execution, Risiko und Datenfundament | **CLOSED (v1.73.0): 4 VERIFIED, 21 FIXED, 0 PARTIAL, 0 OPEN** — [vollständiger Bericht](audits/2026-09-20-roadmap-audit/report.md), [21 eigenständige Umsetzungs-Prompts](audits/2026-09-20-roadmap-audit/prompts/README.md), [Tracking](audits/2026-09-20-roadmap-audit/remediation/TRACKING.md) |
| [audits/2026-09-23-verbesserungen-fahrplan/](audits/2026-09-23-verbesserungen-fahrplan/) | Abgleich des Big-Pickle-Audits „Verbesserungen“ (O1–O6, W1–W5, Datenquellen) — Kosten im Regel-Backtest, Workshop-Schritt 5, Trusted-Indikatoren | **CLOSED (v0.2.0):** [Tracking](audits/2026-09-23-verbesserungen-fahrplan/remediation/TRACKING.md), [Befunde](audits/2026-09-23-verbesserungen-fahrplan/findings/README.md), [Prompts](audits/2026-09-23-verbesserungen-fahrplan/prompts/README.md) |
| [audits/2026-09-29-strategy-template-ausbau/](audits/2026-09-29-strategy-template-ausbau/) | Audit des Strategie-Template-Ausbaus — externes Ausbaudokument gegen Code verifiziert: 21 Findings (5 HIGH) + 37 Umsetzungs-Prompts in 9 Phasen | **OPEN** (Audit v1.2.5 — Vollabgleich vom 2026-10-03 gegen `main` @ `3d13161` plus STX-08-04/08-05: Phasen 0–7/alle 32 Ursprungs-Prompts abgeschlossen; 21 Findings: 19 FIXED, 1 PARTIAL (STX-14), 1 OPEN (STX-08); Phase 8: 08-01…08-05 erledigt — 08-04 schließt STX-12 in `v0.11.0` ([PR #221](https://github.com/Kryschuuu/ai-trading-firm/pull/221)), 08-05 schließt STX-21 in `v0.11.1`; G6 Pilotlauf offen — [Bericht](audits/2026-09-29-strategy-template-ausbau/report.md), [Abgleich](audits/2026-09-29-strategy-template-ausbau/remediation/RECONCILE-2026-10-03.md), [ROADMAP](audits/2026-09-29-strategy-template-ausbau/ROADMAP.md), [Versionierung](audits/2026-09-29-strategy-template-ausbau/VERSIONING.md), [Prompts](audits/2026-09-29-strategy-template-ausbau/prompts/README.md), [Tracking](audits/2026-09-29-strategy-template-ausbau/remediation/TRACKING.md), [Bench-Baseline](audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md), [ADR-008…010](roadmap/DECISIONS.md). **Bleibt Beta** — [BETA_STATUS.md](BETA_STATUS.md) |
| [audits/2026-10-06-docs-code-audit/](audits/2026-10-06-docs-code-audit/) | **Docs↔Code-Audit v0.17.2** — 9 Befunde (DC-01…DC-09) aus dem Abgleich der Fachdokumente gegen Code/Commits, mit kopierfertigen Folge-Prompts | **OPEN** — DC-01 (Proposal-Freigabe ohne Autorisierung) und DC-02 (`REQUIRE_HUMAN_APPROVAL`-Semantik) am 2026-10-06 **FIXED**; DC-03 (Doku-Kleinfindings), DC-04 (Versions-/Status-Header), DC-05 (Env-Flags) und DC-06 (Symbol-/Pfad-Drift der Architektur-Doku) am 2026-10-09 **FIXED**; offen: DC-07…DC-09 — [Bericht](DOCS_CODE_AUDIT_2026-10-06.md), [Prompts](audits/2026-10-06-docs-code-audit/prompts/README.md), [Tracking](audits/2026-10-06-docs-code-audit/remediation/TRACKING.md). **Bleibt Beta** — [BETA_STATUS.md](BETA_STATUS.md) |
| [audits/TEMPLATE/](audits/TEMPLATE/) | Vorlage für neuen Audit-Zyklus | Kopieren: `cp -r TEMPLATE YYYY-MM-DD-<quelle>-<name>` |
| **[peer-reviews/](peer-reviews/)** | Peer-Review-Patches — Patch-Vorschläge gesammelt & verknüpft | [README](peer-reviews/README.md) |
| [peer-reviews/2026-08-26-live-trading-readiness/](peer-reviews/2026-08-26-live-trading-readiness/) | Live-/Paper-Trading-Readiness — Bottlenecks, Makro/Mikro, DB-Locks | [review](peer-reviews/2026-08-26-live-trading-readiness/review.md) + [patches](peer-reviews/2026-08-26-live-trading-readiness/patches/) |
| [peer-reviews/2026-08-26-bitunix-execution/](peer-reviews/2026-08-26-bitunix-execution/) | Bitunix-Ausführungs-Refactor — ExecutionPort | [review](peer-reviews/2026-08-26-bitunix-execution/review.md) |
| [peer-reviews/2026-08-26-routing-overrides/](peer-reviews/2026-08-26-routing-overrides/) | Provider/Modell-Overrides — Audit-Härtung | [review](peer-reviews/2026-08-26-routing-overrides/review.md) |

> **Redirect-Stubs (Altlinks):** `PEER_REVIEW_LIVE_TRADING.md`, `PEER_REVIEW_BITUNIX_EXECUTION.md` und
> `PEER_REVIEW_ROUTING_OVERRIDES.md` liegen unverändert im `docs/`-Wurzelverzeichnis und verweisen auf die
> jeweiligen `peer-reviews/2026-08-26-*/review.md`; die kanonische Fassung steht dort.
| **[security/](security/)** | Security-Übersicht & Härtung — aggregierte Critical/High Findings | [README](security/README.md) + [SECURITY_AUDIT.md](security/SECURITY_AUDIT.md) |

### Archiv — Historische Dokumente

| Verzeichnis | Zweck |
|-------------|-------|
| **[archive/](archive/)** | Veraltete/historische Docs — nicht Teil des aktiven Katalogs | [README](archive/README.md) |
| [archive/task-plans/](archive/task-plans/) | Task-Implementation-Pläne 03–11 — historisch, aktueller Stand in `ARENA_TASKS.md` |

### Weitere Verzeichnisse

| Verzeichnis | Zweck |
|-------------|-------|
| [research/](research/) | Externe Research-Notizen — u. a. das [Indikator-Ranking für Crypto-Daytrading](research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md) (AlgoTrade Pro) inkl. Gebühren-Check und CTI-Einordnung |
| [ci/](ci/) | CI-Workflows: `docs-validate`, `security-live-gate` |
| [help/](help/) | Help-JSONs für UI: brokers, cycle, live-gate, market-universe, ops, paper-trading, portfolio, routing, scanner, workshop |

**Hinweis Changelog:** Der vollständige Changelog liegt jetzt kanonisch im Root: [../CHANGELOG.md](../CHANGELOG.md). `docs/CHANGELOG.md` ist ein Stub/Weiterleitung, um alte Links nicht zu brechen.

---

## Das Grundprinzip in einem Satz

> **Die KI schlägt vor — der Code entscheidet.**

Ein Agent kann halluzinieren, ein Prompt kann manipuliert werden, ein Modell kann kaputtes JSON liefern. Deshalb liegt **jede** Sicherheitsgrenze außerhalb der Agentenlogik, in kompiliertem Code, den kein Modell zur Laufzeit ändern kann.

```
Agent sagt: "Kauf für 90 % des Depots BTC ohne Stop"
        │
        ▼
Schicht 2  Engine-Validierung ........ Rolle darf handeln? Kill-Switch aus? Kurs vorhanden?
        ▼
Schicht 3  Guardrails (riskGuard.ts) .. max. 25 % Position, Stop-Loss Pflicht, kein Short
        ▼
Schicht 4  Kill-Switch ................ globaler Circuit-Breaker, DB-persistent
        ▼
Schicht 5  Broker-Schleuse ............ prüft ALLES nochmal, unabhängig von Schicht 2+3
        │
        ▼
Ergebnis: BLOCKED — "position-size:max-25%-of-equity | stop-loss:mandatory"
```

Die Ablehnung landet revisionssicher im `audit_log`. Nichts wird stillschweigend verworfen.

---

## Architektur (Kurzfassung)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Next.js (App Router)          Dashboard · /docs · REST-API          │
├──────────────────────────────────────────────────────────────────────┤
│  MAKRO-ZYKLUS (langsam, LLM im Hintergrund)                          │
│     macroCycle.ts   CEO + Research → Regeln, 1×/h (Scheduler)        │
│     engine.ts       klassische Pipeline (manuell/Workshop)           │
├──────────────────────────────────────────────────────────────────────┤
│  MIKRO-ZYKLUS (schnell, KEIN LLM) — eigener Prozess `npm run micro`  │
│     microExecutor.ts  WebSocket-Tick → Rolling-Serie → kompilierte   │
│                        Regel (RAM) → Paper-Fill; ~20–100 µs          │
│     ruleEngine.ts      Whitelist-DSL · Validierung · Backtest        │
├──────────────────────────────────────────────────────────────────────┤
│  HARTE GRENZEN    src/lib/riskGuard.ts     ← hier steht die Wahrheit │
│  Broker-Schleuse  src/lib/broker.ts        ← prüft ein zweites Mal   │
│  Provider-Schicht src/lib/llmProvider.ts   ← Ollama · OpenAI · Gemini│
│                    src/lib/ollama.ts       ← Schema, Retry, Fallback │
├──────────────────────────────────────────────────────────────────────┤
│  PostgreSQL + Drizzle    agents · missions · positions · proposals   │
│                          agent_messages · audit_log · kill_switches  │
│                          risk_config · equity_snapshots              │
│                          trade_rules · rule_executions               │
│                          rule_backtests (v1.6)                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Die Kernidee (v1.6):** Die LLMs rechnen **vor** (Makro: 1×/h), nicht **mit** (Mikro: jeder Tick). Verbunden nur über ein versioniertes, validiertes Regelwerk in `trade_rules` — keine lineare Pipeline, keine LLM-Latenz im Ausführungspfad. Details: [ARCHITECTURE.md](ARCHITECTURE.md).

**Institutionelles Gedächtnis** = `agent_messages` + `audit_log` + `proposals` in PostgreSQL.

---

## Schnellstart

Ausführlich in [INSTALL.md](INSTALL.md). Kurzfassung:

```bash
# 1. Abhängigkeiten
sudo pacman -S --needed nodejs npm postgresql git

# 2. Datenbank starten
sudo systemctl enable --now postgresql

# 3. Projekt
git clone <dein-repo> ai-trading-firm && cd ai-trading-firm
npm ci
cp .env.example .env        # DATABASE_URL prüfen
npx drizzle-kit push        # Tabellen anlegen

# 4. Modell holen (Variante A)
ollama pull qwen2.5:3b-instruct-q4_K_M

# 5. Bauen und starten
npm run build && npm run start
```

Dann `http://localhost:3369` öffnen → **„Seed / Reset“** klicken → **„▶▶ Ganze Pipeline“**.

---

## Projektstruktur (aktualisiert 2026-09-05)

```
├── README.md                 ← Projekt-README (GitHub-Einstieg, inkl. Beta-Disclaimer)
├── CHANGELOG.md              ← Kanonischer Changelog (Keep a Changelog, v0.x.x, Root)
├── VERSION.md                ← Versions-Metadaten (v0.17.2, Beta) + Komponenten-Übersicht
├── CONTRIBUTING.md           ← Beitrags-Leitfaden & Konventionen
├── LICENSE                   ← GPL-3.0-only
├── CONFIGURATION.md          ← Env-Flags mit Defaults (verbindliche Flag-Referenz)
├── INSTALL.md                ← Wrapper: zeigt auf docs/INSTALL.md + CONFIGURATION.md
├── src/                      ← Anwendung (Modul-Verzeichnis, siehe REPOSITORY_STRUCTURE.md)
├── tests/                    ← gesamte Test-Suite (einziges Testverzeichnis; node:test)
├── scripts/                  ← CLI-/Betriebsskripte (Setup, Sync, Scan, Backtest, Watchdog)
├── drizzle/                  ← SQL-Migrations (append-only, idempotent)
├── deploy/                   ← systemd-Units
├── data/                     ← versionierte Seed-Daten (Universe); Laufzeitdaten gitignored
└── docs/
    ├── README.md             ← diese Datei (Doku-Index)
    ├── REPOSITORY_STRUCTURE.md ← Verzeichnisstruktur & Zwecke aller Ordner
    ├── INSTALL.md            ← CachyOS-Installation A+B (kanonisch)
    ├── CHANGELOG.md          ← Stub → ../CHANGELOG.md
    ├── ARCHITECTURE.md, HANDBUCH.md, ...
    ├── architecture/         ← DB-Schema, Integrationspunkte, Pipeline-Karte, Strategie-Stack-SSoT
    ├── roadmap/              ← ADR-Log (DECISIONS.md) + historischer TASK-Tracker (STATUS.md)
    ├── audits/               ← alle Audits chronologisch
    │   ├── README.md         ← erklärt Naming, Workflow, Status-Modell
    │   ├── TEMPLATE/         ← Vorlage für neuen Audit
    │   ├── 2026-09-03-peer-review/  ← Peer-Review-Audit (CLOSED)
    │   ├── 2026-09-05-security-review-gpt01/  ← Security-Audit (SEC-01–10 FIXED)
    │   ├── 2026-09-08-arena-prompts/  ← Arena-Review-Serie (RESTORE-01 FIXED)
    │   ├── 2026-09-18-feature-gap/    ← Feature-Gap-Audit (GAP-01…GAP-10, abgeschlossen)
    │   ├── 2026-09-20-roadmap-audit/  ← 25 Roadmap-Befunde + 21 Prompts (CLOSED)
    │   ├── 2026-09-23-verbesserungen-fahrplan/  ← Verbesserungen, CLOSED v0.2.0
    │   ├── 2026-09-29-strategy-template-ausbau/  ← Strategie-Template-Ausbau (21 Findings, 37 Prompts, OPEN v1.2.5)
    │   └── 2026-10-06-docs-code-audit/  ← Docs↔Code-Audit v0.17.2 (DC-01…DC-09; DC-01…DC-06 FIXED, 3 Prompts offen)
    ├── peer-reviews/         ← Peer-Review-Patches gesammelt
    │   ├── README.md
    │   ├── 2026-08-26-live-trading-readiness/
    │   ├── 2026-08-26-bitunix-execution/
    │   └── 2026-08-26-routing-overrides/
    ├── security/             ← Security-Übersicht
    │   ├── README.md
    │   └── SECURITY_AUDIT.md
    ├── archive/              ← historische Docs
    │   ├── task-plans/       ← task-*.md
    │   └── CHANGELOG-legacy-v1.md ← vollständige Legacy-Historie (v1.x.x ≙ v0.x.x)
    ├── ci/
    └── help/
```

---

## Migration & Aufräumaktion 2026-09-05

**Ziele:**
- Ordnung schaffen: dediziertes Verzeichnis für Audit-/Security-Findings, skaliert für wiederkehrende Audits
- Neuer Ordner für Peer-Review-Patches mit bidirektionaler Verlinkung
- Doppelte MDs entfernen: `CHANGELOG.md` Duplikat konsolidiert (kanonisch Root), `INSTALL.md` Duplikat geklärt (Root = Wrapper, docs/INSTALL.md = CachyOS-Guide, Flag-Referenz = CONFIGURATION.md)
- Überflüssiges entrümpeln: `task-*.md` → `archive/task-plans/`, `PEER_REVIEW_*.md` → `peer-reviews/*/review.md`, `AUDIT_REMEDIATION_2026-09.md` + `audit-remediation/` → `audits/2026-09-03-peer-review/`
- Verlinkungen aktualisiert und getestet: alle internen Links zeigen auf neue Pfade, `docs-validate` grün
- Langfristige Wartbarkeit: TEMPLATEs, Naming-Konvention `YYYY-MM-DD-<quelle>-<name>`, Status-Modell OPEN/IN_PROGRESS/FIXED/WONTFIX/FALSE_POSITIVE

**Entfernte Duplikate:**
- `docs/CHANGELOG.md` (Duplikat, 5833 Zeilen) → Stub, kanonisch `../CHANGELOG.md`
- `audit-remediation/` (Root, 21 Files) → `docs/audits/2026-09-03-peer-review/findings/`
- `docs/PEER_REVIEW_*.md` (3 Files) → `docs/peer-reviews/*/review.md`
- `docs/AUDIT_REMEDIATION_2026-09.md` → `docs/audits/2026-09-03-peer-review/report.md`
- `docs/task-*.md` (8 Files) → `docs/archive/task-plans/`
- `docs/SECURITY_AUDIT.md` (kopiert nach `security/`, Original entfernt oder als Stub)

Siehe [audits/README.md](audits/README.md) und [peer-reviews/README.md](peer-reviews/README.md) für Details zur neuen Struktur.

---

## Version

`v0.17.2 (Beta)` (siehe `package.json`, [../VERSION.md](../VERSION.md) +
[../CHANGELOG.md](../CHANGELOG.md)). Legacy-Historie (`v1.x.x`, intern):
[archive/CHANGELOG-legacy-v1.md](archive/CHANGELOG-legacy-v1.md).

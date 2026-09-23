# VERSION — Autonome KI-Trading-Firma

**Kanonische Versions-Metadaten** des Projekts. Alle anderen Versionsverweise
in Code und Doku leiten sich von diesem Stand ab.

| Feld | Wert |
| --- | --- |
| **Version** | `v0.1.0` |
| **Schema** | SemVer, öffentliches `v0.x.x` (0.x = Beta-Phase) |
| **Status** | **BETA — nicht produktionsreif** (Paper-Trading, keine Live-Broker-Garantien) |
| **Release-Datum** | 2026-09-23 |
| **Quellbasiert** | `package.json` (`version: "0.1.0"`), `src/lib/version.ts` liest die SSoT zur Laufzeit |
| **Changelog** | [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog) |
| **Legacy-Historie** | [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md) (interne Zählung `v1.x.x`, `v1.73.1` ≙ `v0.1.0`) |

## Bedeutung der Version

`v0.1.0` ist die **Beta-Baseline**: Sie bündelt den gesamten bis dahin
erreichten Funktionsstand der Beta-Entwicklung (interne Zählung bis `v1.73.1`)
und etabliert das öffentliche v0.x.x-Schema. In der 0.x-Reihe dürfen
Breaking Changes eingeführt werden, wenn sie im Changelog dokumentiert sind.

**Beta-Hinweis:** Das Projekt ist für Bildungszwecke und private Nutzung auf
eigene Gefahr konzipiert. Kein Teil davon ist für produktive Handelsumgebungen
bestimmt (Details: Disclaimer im [`README.md`](README.md)).

## Komponenten-Übersicht

### Kernmodule (`src/`)

| Modul | Zweck |
| --- | --- |
| `src/cycle/` | Agenten-Zyklus (Daily/Weekly): sequenzielle Schritte der KI-Agenten (Technical/News/Macro → Research → Risk → Portfolio → Approver → Executor) |
| `src/scanner/` | Deterministischer Market-Scanner (Liquidität/Volatilität/Korrelation, 15+ Faktoren, point-in-time) |
| `src/marketdata/` | Markt-Daten-Pipeline: Multi-Venue-Sync, Candle-Backfill, Qualitäts-Layer, Aggregation, Readiness |
| `src/brokers/` | Broker-Schicht: Paper-Broker (Fill-Simulation), Bitunix/Alpaca-Adapter, Reconciliation, Emergency-Broker-Schnittstelle |
| `src/execution/` | Ausführungspolitik: Order-Gates, Post-Only-Fallback, TWAP-Engine, Policy-Controller |
| `src/live-gate/` | Harte Freigabeschicht für jeden Live-Pfad (Flags, Security-Stamps, Kill-Switch-Kopplung) |
| `src/risk` (in `src/lib/`) | `riskGuard`, `adaptiveRisk`, `positionSizing`, `clusterExposure`, `volatilityTargeting`, `drawdownScaling`, `signalDecay`, `circuitBreaker`, `exits` |
| `src/portfolio/` | Portfolio-Engine: Kennzahlen, Korrelations-Cluster, Volatility-Targeting-Policy, Drawdown-Policy |
| `src/backtest/` | Backtest-Engines (legacy/paper/event_replay), Walk-Forward, Monte-Carlo, Trade-Ledger |
| `src/forecasts/` | Forecast-Ledger: point-in-time Resolving, Brier-Score, Kalibrierung |
| `src/features/` | Point-in-Time Feature Store (versionierte Featurewerte) |
| `src/perpdata/` | Historische Perpetual-Daten (Funding, Open Interest, Liquidationen) |
| `src/sentiment/`, `src/crossSectional/`, `src/confluence/` | Research-Schicht: strukturiertes Sentiment, Cross-Sectional Ranking, MTF-Konfluenz |
| `src/strategyLifecycle/` | 9-Zustands-Lifecycle-Strategie mit Driftgates (Backtest↔Paper↔Live) |
| `src/devilsAdvocate/` | Adversaler Falsifikations-Step (nur defensive Risiko-Wirkung) |
| `src/promptPerformance/` | Prompt-Artefakte, Run-Provenanz, Metriken je Prompt-Version |
| `src/routing/` | LLM-Model-Router (Ollama/OpenAI/Gemini/Claude), Overrides, Turn-Budgets |
| `src/auth/`, `src/lib/` (security) | Auth-Modi, RBAC, Sessions, Rate-Limits, Audit-Sink (durable), Kill-Switch |
| `src/universe/` | Instrument-Universe-Registry (venue-aware) |
| `src/attribution/` | Deterministische Trade-PnL-Attribution |
| `src/executionQuality/` | Venueübergreifendes Execution-Benchmarking (append-only Ledger) |
| `src/db/`, `src/history/`, `src/contracts/` | Drizzle-Schema, Historical Store (append-only OHLCV), Broker-Contracts |
| `src/app/` | Next.js App Router: Dashboard, Operations Center, API-Routen |
| `src/components/` | React-UI (Paper-Trading-Dashboard, Control-Plane, Docs-Viewer) |

### Laufzeit & Infrastruktur

- **Runtime:** Node.js ≥ 20 (Entwicklung/Produuktion), TypeScript strict, Next.js 16 (App Router)
- **Datenbank:** PostgreSQL (Drizzle ORM, append-only/idempotente Migrations in `drizzle/`)
- **Prozesse:** Web-App (Next.js, Port 3369), Mikro-Executor (Regel-Executor, `npm run micro`), Market-Sync (systemd-timer), Watchdog

### Externe APIs & Dienste

| Dienst | Zweck | Zugang |
| --- | --- | --- |
| **Bitunix** (REST + WebSocket) | Krypto-Marktdaten, Paper-Sync, Live-Ausführung (nur hinter Live-Gate) | Öffentliche Endpoints ohne Credential für Marktdaten; Live nur mit expliziten Credentials |
| **Binance / Kraken / Alpaca / IBKR / Yahoo** (Marktdaten-Adaption) | Multi-Venue-Sync für den Historical Store | Öffentliche Endpoints, credential-frei |
| **Ollama** | Lokale LLMs (Default-Provider) | HTTP, `OLLAMA_BASE_URL` |
| **OpenAI-kompatible Endpunkte, Gemini, Claude** | Alternative LLM-Provider (Router) | API-Key je Provider über Secret-Store |
| **PostgreSQL** | Institutionelles Gedächtnis, Audit, Persistenz | `DATABASE_URL` |

### Konfiguration

- Umgebungsvariablen: [`CONFIGURATION.md`](CONFIGURATION.md) (vollständige
  Flag-Referenz mit sicheren Defaults) und `.env.example`.
- Deployment-Units (systemd): `deploy/`.
- Test-/CI-Workflow-Quellen: `docs/ci/` (gespiegelt nach `.github/workflows/`).

## Versionspflege

1. Änderungen zuerst im [`CHANGELOG.md`](CHANGELOG.md) unter `[Unreleased]` dokumentieren.
2. `package.json` (einzige Versions-SSoT) bumpen: Bugfix → Patch, additive
   Funktion → Minor, dokumentierte Breaking Change (0.x) → Minor/Major nach
   Bedarf.
3. Diese Datei (Datum + Version) und die Status-Header der betroffenen
   Doku-Module aktualisieren.
4. `npm run typecheck && npm run lint && npm test && npm run docs:validate`
   grün halten (Pflicht-Checks, siehe [`CONTRIBUTING.md`](CONTRIBUTING.md)).

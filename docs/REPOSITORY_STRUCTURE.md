# Repository-Struktur — Übersicht & Pflegeanleitung

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-09-23** ·
> Code-Version **v0.1.0 (Beta)** · Vorherige Konsolidierung: 2026-09-05 (Legacy v1.36.26)

## Ziele

- Logische, wartbare, selbsterklärende Verzeichnisstruktur
- Ein eindeutiger Ort pro Art von Inhalt (Code, Tests, Doku, Migrations, Betrieb)
- Keine redundanten Dateien; Historie wird archiviert, nicht gelöscht
- Verlinkungen stabil (`docs:validate` prüft alle relativen Links)

## Reorganisation 2026-09-23 (v0.1.0, Beta-Baseline)

| Änderung | Von | Nach | Begründung |
| --- | --- | --- | --- |
| Testverzeichnis zusammengeführt | `test/` (32 Dateien) + `tests/` | nur `tests/` (`marketdata/`, `integration/`, `ops/`, `ui/`, `fixtures/bitunix/` hinzugefügt) | Doppeltes Testverzeichnis war verwirrend; `npm test` und alle Coverage-Skripte referenzieren jetzt ausschließlich `tests/**` (außer modulinternen `src/marketdata/__tests__/`) |
| Veraltetes Template-File entfernt | `.ignore` (Root) | — | Kontradiktorisch zu `.gitignore` (es „ignorierte" versionierte Verzeichnisse wie `tests/`, `scripts/`, `deploy/`); reines Template-Relikt |
| Changelog aufgeteilt | `CHANGELOG.md` (Root, 168 KB, Legacy v1.x.x) | `CHANGELOG.md` (Root, v0.x.x, neu) + `docs/archive/CHANGELOG-legacy-v1.md` (vollständige Legacy-Historie, unverändert) | Öffentliche v0.x.x-Baseline; Historie bleibt nachlesbar (Zuordnung im Changelog) |
| Versions-Metadaten neu | — | `VERSION.md` (Root) | Kanonische Version/Datum/Status/Komponenten-Übersicht |
| Beitrags-Leitfaden neu | — | `CONTRIBUTING.md` (Root) | Konventionen und Pflicht-Checks für Contributors |
| README überarbeitet | `README.md` (v1.73.1-Stand) | `README.md` mit prominentem Beta-Disclaimer (erste Zeile), Schnellstart, Struktur, Doku-Index | Beta-Positionierung, Rechtsklarheit, Übersichtlichkeit |

Unverändert (bewusst): `src/` (Next.js-Modullayout), `scripts/`, `drizzle/`,
`deploy/`, `data/` (nur Seed-Daten versioniert), `.github/` (Spiegel von
`docs/ci/`).

## Struktur-Übersicht (aktuell)

```
/
├── README.md                  # Projekt-README — beginnt mit dem prominenten Beta-Disclaimer
├── CHANGELOG.md               # Kanonischer Changelog (Keep a Changelog, öffentliches v0.x.x-Schema)
├── VERSION.md                 # Versions-Metadaten (v0.1.0, Beta, 2026-09-23) + Komponenten-Übersicht
├── CONTRIBUTING.md            # Beitrags-Leitfaden, Konventionen, Pflicht-Checks
├── LICENSE                    # GPL-3.0-only
├── INSTALL.md                 # Installations-Übersicht (Wrapper → docs/INSTALL.md + CONFIGURATION.md)
├── CONFIGURATION.md           # Verbindliche Env-Flag-Referenz (Defaults, Bounds)
├── package.json               # Version-SSoT ("version": "0.1.0"), Scripts, Abhängigkeiten
├── .env.example               # Alle Flags mit sicheren Defaults (Referenz, kein Klartext-Secret)
├── next.config.ts             # Next.js-Konfiguration (App Router, Standalone-Details)
├── tsconfig.json              # TypeScript strict
├── eslint.config.mjs          # ESLint (next-core)
├── drizzle.config.ts          # Drizzle-Konfiguration (Migrations → drizzle/)
│
├── src/                       # ── Anwendung ────────────────────────────────────────────
│   ├── app/                   # Next.js App Router: Seiten, Dashboard, /docs-Viewer, REST-API
│   │   ├── api/               #   API-Routen (/api/firm/*, /api/marketdata/*, /api/auth/*, …)
│   │   ├── docs/              #   In-Browser-Doku-Viewer (docsCatalog)
│   │   └── *.tsx              #   Layout, Startseite
│   ├── components/            # React-Komponenten (Dashboard, Control-Plane, Operations, Docs)
│   ├── cycle/                 # Agenten-Zyklus: Steps (Technical/News/Macro/Research/Risk/…),
│   │   │                      #   Orchestrierung, Plausibilitäts-Schicht, Artefakte
│   │   └── steps/             #   ein Datei-Step je Agentenrolle
│   ├── scanner/               # Deterministischer Market-Scanner (Faktoren, Scoring, Ranking)
│   │   └── factors/           #   je Faktor eine Datei (ATR, RSI, Momentum, Funding, …)
│   ├── marketdata/            # Markt-Daten-Pipeline: Sync-Service, Readiness, Aggregation,
│   │   ├── adapters/          #   Qualitäts-Layer; Adapter je Venue (bitunix, binance, kraken, …)
│   │   └── __tests__/         #   modulinterna Tests (ausnahmsweise am Ort, siehe npm test)
│   ├── brokers/               # Broker-Schicht: paper/ (Fill-Simulation), bitunix/, alpaca/,
│   │   │                      #   control-plane/, reconciliation, EmergencyBroker-Schnittstelle
│   │   └── …                  #   Venue-Adapter & Capability-Modell
│   ├── execution/             # Ausführungspolitik: Order-Gates, post-only/ (Fallback),
│   │   └── twap/              #   Policy-Controller, TWAP-Engine (Parent/Slice)
│   ├── live-gate/             # Harte Freigabeschicht für Live-Pfade (States, Stamps, Audit)
│   ├── backtest/              # Backtest-Engines (engine, paperExecution, replay, montecarlo,
│   │                          #   walkforward, tradeLedger, runStore)
│   ├── portfolio/             # Portfolio-Engine: Kennzahlen, Kovarianz/Cluster,
│   │                          #   volatilityTargeting, drawdownScaling (pure Policies)
│   ├── forecasts/             # Forecast-Ledger: Capture, Resolver, Scoring (Brier/ECE)
│   ├── features/              # Point-in-Time Feature Store (Registry, Materialisierung, PIT)
│   ├── perpdata/              # Historische Perpetual-Daten (Funding/OI/Liquidationen, Sync)
│   ├── sentiment/             # Strukturierte Sentiment-Outputs (Forecast-Envelopes)
│   ├── crossSectional/        # Point-in-Time Cross-Sectional Momentum Ranking
│   ├── confluence/            # Deterministische Multi-Timeframe-Konfluenz
│   ├── strategyLifecycle/     # 9-Zustands-Lifecycle mit Driftgates (Backtest↔Paper↔Live)
│   ├── devilsAdvocate/        # Adversaler Falsifikations-Step (Scoring, Schemata)
│   ├── promptPerformance/     # Prompt-Artefakte, Run-Provenanz, Version-Metriken
│   ├── routing/               # LLM-Model-Router, Provider-Adapter, Turn-Budget, Overrides
│   ├── auth/                  # Auth-Modi, Session-Handling, RBAC
│   ├── universe/              # Instrument-Universe-Registry (venue-aware)
│   ├── attribution/           # Deterministische Trade-PnL-Attribution
│   ├── executionQuality/      # Venueübergreifendes Execution-Benchmarking (Ledger)
│   ├── capabilities/          # Capability-SSoT (discovery/marketData/trading)
│   ├── history/               # Historical Store (append-only OHLCV, Kerzen-Queries)
│   ├── contracts/             # Broker-Contract-Verträge (Adapter-Interface)
│   ├── db/                    # Drizzle-Schema & Pool
│   ├── ops/                   # Operations-Zentrale (Status, Diagnose)
│   ├── lib/                   # Gemeinsame Kernlogik: riskGuard, riskConfig, adaptiveRisk,
│   │                          #   positionSizing, clusterExposure, volatilityTargeting,
│   │                          #   drawdownScaling, signalDecay, circuitBreaker, exits,
│   │                          #   funding, indicators, engine (Makro), microExecutor (Mikro),
│   │                          #   broker (Schleuse), monitor, journal, audit(Sink/View),
│   │                          #   telemetry, alerts, heartbeat, killSwitch, llmProvider,
│   │                          #   ollama, clientIp, version (SSoT), …
│   └── instrumentation.ts     # Next.js-Instrumentierung (Scheduler: Monitor-Tick, Reconciliation,
│                              #   Forecast-Resolver, Perp-Sync, …)
│
├── tests/                     # ── Test-Suite (einziger Test-Ort; node:test + assert/strict) ──
│   ├── *.test.ts              # Unit-/Integrations-Tests je Modul (benannt nach dem Modul)
│   ├── fixtures/              # Test-Fixtures (golden/, bitunix/, Market-/Venue-Servers, …)
│   ├── helpers/               # geteilte Test-Helfer
│   ├── history/               # Historical-Store-Tests
│   ├── symbols/               # Symbol-Normalisierungs-Tests
│   ├── marketdata/            # Marktdaten-Pipeline-Tests (+ adapters/)
│   ├── integration/           # End-to-End-Integrationstests
│   ├── ops/                   # Operations-Tests
│   └── ui/                    # React-Komponenten-Tests (.tsx)
│
├── scripts/                   # ── CLI & Betrieb ────────────────────────────────────────────
│   ├── setup-cachyos.sh       # idempotentes CachyOS-Setup (10 Schritte, 18 Checks)
│   ├── setup-windows.ps1      # Windows-Installer
│   ├── validate-setup.sh      # 18 Setup-Validierungs-Checks
│   ├── run-scan.ts            # deterministischer Scan
│   ├── run-market-sync.ts / market-sync.ts   # Markt-Daten-Sync (Systemd-timer)
│   ├── run-backtest.ts / run-montecarlo.ts / run-cross-sectional.ts   # Research-CLI
│   ├── seed-universe.ts / seed-market-universe.ts   # Universe-Seeds
│   ├── micro-executor.ts      # Mikro-Zyklus als separater Prozess (npm run micro)
│   ├── watchdog.ts            # Alarm-First-Watchdog (keine Mutation)
│   ├── live-kill.ts / live-security-stamp.ts   # Notfall-/Freigabe-Tools
│   ├── reconcile.ts / feature-materialize.ts / perp-sync.ts / …  # Wartungs-Jobs
│   ├── docs-validate.ts       # Docs-as-Code-Wächter (npm run docs:validate)
│   └── lib/                   # geteilte Skript-Helfer
│
├── drizzle/                   # SQL-Migrations (append-only, idempotent, datiert: YYYY-MM-DD_*.sql)
├── deploy/                    # systemd-Units: ai-trading-firm, market-sync(+full), micro-executor,
│                              #   ollama-lan
├── data/                      # Nur Seed-Daten versioniert (universe/instruments.ndjson);
│                              #   alle Laufzeitdaten (history, secrets, cache, Reports) gitignored
├── docs/                      # ── Dokumentation (Index: docs/README.md) ─────────────────────
│   ├── README.md              # Doku-Index (alle Module, Audits, Versionierung)
│   ├── REPOSITORY_STRUCTURE.md  # diese Datei
│   ├── CHANGELOG.md           # Stub → ../CHANGELOG.md
│   ├── INSTALL.md / INSTALL-WINDOWS.md   # Installation (kanonisch)
│   ├── ARCHITECTURE.md        # Zielbild, Makro-/Mikro-Zyklen, Decoupling, Glossar
│   ├── HANDBUCH.md            # Bedienung, Runbooks, Troubleshooting
│   ├── <Modul>.md             # je Fachmodul eine Doku (BACKTESTING, BITUNIX, LIVE_TRADING, …)
│   ├── audits/                # Audit-Zyklen chronologisch (README, TEMPLATE, 5 Audits)
│   ├── peer-reviews/          # Peer-Review-Reports & Patches (3 Reviews)
│   ├── security/              # Security-Übersicht (README) + SECURITY_AUDIT.md
│   ├── architecture/          # DB_SCHEMA, INTEGRATION_POINTS, PIPELINE_MAP
│   ├── help/                  # 3-Ebenen-Hilfe-JSONs der UI (+ Schema)
│   ├── ci/                    # Versionierte Quellen der CI-Workflows (Spiegel: .github/workflows/)
│   └── archive/               # Historische Dokumente
│       ├── task-plans/        # task-03…11-Implementationspläne
│       └── CHANGELOG-legacy-v1.md   # vollständige Legacy-Changelog-Historie (v1.x.x)
│
└── .github/workflows/         # CI: docs-validate, security-live-gate (1:1-Spiegel von docs/ci/)
```

## Regeln für die Pflege

1. **Tests:** neue Testdateien gehören nach `tests/` (bzw. das dazugehörige
   Unterverzeichnis); modulinterna Tests nur ausnahmsweise im Modul
   (aktuell: `src/marketdata/__tests__/`), dann im `test`-Skript von
   `package.json` aufführen.
2. **Doku:** neues Fachmodul ⇒ Doku `docs/<MODUL>.md` + Eintrag in
   `docs/README.md` + `docsCatalog` (in `src/app/docs/`); Status-Header
   (Datum, Code-Version, Modul) oben.
3. **Migrations:** `drizzle/YYYY-MM-DD_<slug>.sql`, append-only + idempotent,
   Drizzle-Spiegel in `src/db/schema.ts`, Rollback-Hinweis in der Modul-Doku.
4. **CI-Workflows:** Quelle ist `docs/ci/`, Spiegel `.github/workflows/` —
   beide müssen byte-identisch sein (CI-Prüfung).
5. **Audit/Peer-Review:** Naming `YYYY-MM-DD-<quelle>-<name>` in
   `docs/audits/` bzw. `docs/peer-reviews/`; Status nur in
   `remediation/TRACKING.md`; Vorlage `docs/audits/TEMPLATE/`.
6. **Laufzeitdaten:** nichts aus `data/` (außer Seed-Files) committen;
   `.gitignore` ist die SSoT (das alte `.ignore` wurde 2026-09-23 entfernt).
7. **Versionsänderung:** `package.json` + `CHANGELOG.md` + `VERSION.md` +
   betroffene Status-Header im selben PR (Details: `CONTRIBUTING.md`).

## Referenzen

- [../README.md](../README.md) · [../CHANGELOG.md](../CHANGELOG.md) ·
  [../VERSION.md](../VERSION.md) · [../CONTRIBUTING.md](../CONTRIBUTING.md)
- [README.md](README.md) (Doku-Index) · [audits/README.md](audits/README.md) ·
  [peer-reviews/README.md](peer-reviews/README.md) ·
  [security/README.md](security/README.md) · [archive/README.md](archive/README.md) ·
  [ci/README.md](ci/README.md)

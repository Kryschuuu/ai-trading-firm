<div align="center">

# ⚠️ BETA-PHASE — NICHT PRODUKTIONSTÜCHTIG ⚠️

> **DISCLAIMER: Dieses Projekt befindet sich in der BETA-PHASE und ist für Bildungszwecke und private Nutzung auf eigene Gefahr konzipiert. Der Autor lehnt jegliche Haftung für finanzielle Verluste, technische Fehler, Datenverlust oder Schäden ab. Verwende diesen Code nicht in produktiven Handelsumgebungen. Trading und Investitionen beinhalten erhebliche Risiken — nutze diesen Code auf deine eigene Verantwortung hin und nur nach vollständiger rechtlicher Prüfung.**

**Version: v0.1.0 (Beta)** · [Changelog](CHANGELOG.md) · [Versions-Metadaten](VERSION.md) · [Beitragen](CONTRIBUTING.md) · [Lizenz: GPL-3.0-only](LICENSE)

</div>

---

# Autonome KI-Trading-Firma — lokal, Open Source, ohne Cloud

Ein lauffähiges Referenz-Setup für ein Team spezialisierter KI-Agenten (CEO,
Research, Technical, News, Macro, Risk, Portfolio, Approver, Executor), das ein
Handelsziel autonom bearbeitet — komplett auf eigener Hardware, mit einer
**abstrakten LLM-Provider-Schicht** (Ollama, OpenAI-kompatible Endpunkte,
Gemini, Claude), **PostgreSQL** als institutionellem Gedächtnis und **harten
Risikogrenzen im Code**.

> **Grundprinzip: Die KI schlägt vor — der Code entscheidet.**
> Jede Sicherheitsgrenze (Risikolimits, Kill-Switch, Approvals, Live-Gate)
> liegt außerhalb der Agentenlogik in kompiliertem Code, den kein Modell zur
> Laufzeit ändern kann.

> **Betriebsstatus:** Das System läuft im Auslieferungszustand ausschließlich
> im **Paper-Trading-Modus** — kein echtes Geld ist im Spiel. Jeder
> Live-Pfad ist zusätzlich hinter dem mehrstufigen
> [Live-Gate](docs/LIVE_TRADING.md) (Flags + Security-Stamps + Kill-Switch-Kopplung)
> gesperrt. Selbst im Paper-Modus gilt: **Beta, auf eigene Gefahr.**

## Versions-Status

| Feld | Wert |
| --- | --- |
| Version | **v0.1.0** (Beta-Baseline, 2026-09-23) |
| Schema | SemVer `v0.x.x` — 0.x heißt: Beta, Breaking Changes erlaubt und dokumentiert |
| Status | **BETA — nicht produktionsreif**, kein Support-Garantie, keine Live-Trading-Garantien |
| Changelog | [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog) — mit Meilenstein-Übersicht der Beta-Entwicklung |
| Historie | Interne Legacy-Zählung `v1.x.x` archiviert: [docs/archive/CHANGELOG-legacy-v1.md](docs/archive/CHANGELOG-legacy-v1.md) |

## Voraussetzungen

- **Node.js ≥ 20** (LTS; CI läuft auf 22), npm
- **PostgreSQL** (lokal, Docker oder via [`deploy/`](deploy/) systemd-Units)
- **Ollama** oder ein anderer LLM-Provider (OpenAI-kompatibel, Gemini, Claude) — für die Agenten
- Empfohlenes OS: CachyOS/Arch (Setup-Skript); Windows-Installation mit PowerShell: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)
- Optional: Bitunix-Zugangsdaten für echte Marktdaten (Paper-Sync), sonst synthetische Paper-Daten

## Schnellstart (CachyOS, empfohlen)

Ein Befehl, zehn Schritte, idempotent:

```bash
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm
./scripts/setup-cachyos.sh --variant a     # Variante A: alles auf einem Rechner
./scripts/setup-cachyos.sh --variant b --llm-host 192.168.0.20   # Variante B: getrennter LLM-Node
```

Das Skript installiert Node/PostgreSQL, legt Rolle und Datenbank an, schreibt
`.env` inkl. `FIRM_API_TOKEN` und separat erzeugtem `FIRM_SESSION_SECRET`
(Recht `600`), spielt das Schema ein, seedet das Markt-Universum (354
Instrumente), aktiviert Short-Selling, baut die App und führt am Ende
**18 Validierungs-Checks** aus. Beliebig oft wiederholbar; überschreibt weder
`.env` noch Cluster-Daten ohne Rückfrage.

Optionen: `--dry-run`, `--non-interactive`, `--no-shorts`, `--sync-markets`,
`--skip-build`, `--min-pass 18`, `--help`. Log:
`data/setup/setup-<Zeitstempel>.log`.

### Manuell / anderes System

```bash
cp .env.example .env        # Pflicht-Flags setzen (DATABASE_URL)
umask 077
printf 'FIRM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'FIRM_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
chmod 600 .env
npm ci
npx drizzle-kit push        # Schema einspielen
npm run universe:seed:markets  # 354 Preset-Instrumente
npm run universe:seed       # Basis-Universum (26 Instrumente)
npm run market:sync -- --dry-run   # Marktdaten-Warmup prüfen
BITUNIX_ENABLED=true npm run market:sync   # Registry + Historie persistent füllen
npm run scan -- --sync-first       # deterministischer Scan auf dem Warmup
rm -rf .next node_modules/.cache   # Build-Cache löschen (verhindert instanceof-Drift)
npm run build
npm run start               # http://0.0.0.0:3369
./scripts/validate-setup.sh        # 18 Checks, bestanden ab 15
```

Details: [INSTALL.md](INSTALL.md) (Übersicht) → [docs/INSTALL.md](docs/INSTALL.md)
(CachyOS, Schritt für Schritt, Variante A/B) + [CONFIGURATION.md](CONFIGURATION.md)
(vollständige Env-Flag-Referenz).

## Architektur in Kürze

Broker-unabhängige Infrastruktur mit dynamischem Instrument-Universe. Market
Discovery und historisches Warmup erledigt der MarketDataSyncService **vor**
dem deterministischen Scanner — der Scanner selbst führt nie Netzwerk-I/O aus.

```
MARKET UNIVERSE → deterministischer Scanner (Liquidität/Volatilität/Korrelation)
→ MARKET RANKER → DAILY/WEEKLY → AGENT ANALYSIS (Technical/News/Macro)
→ RESEARCH → RISK MANAGER → PORTFOLIO ENGINE → APPROVAL LAYER
→ RULE ENGINE → PAPER (Default) / LIVE (nur hinter Live-Gate)
```

Decoupling-Prinzipien: **LLM = Interpretation · Mathematik = Berechnung ·
Risk Engine = Autorität · Sicherheit im Code.** Zielbild, Glossar und
Entscheidungsprotokoll: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Hauptmodule

| Modul | Zweck |
| --- | --- |
| `src/cycle/` | Agenten-Zyklus (Makro/Mikro): sequenzielle Agenten-Steps mit Validierung, Plausibilität und Audit |
| `src/scanner/` | Deterministischer Market-Scanner (15+ Faktoren, point-in-time) |
| `src/marketdata/` | Multi-Venue-Sync (6 Venues), Candle-Backfill, Qualitäts-Layer, Readiness |
| `src/brokers/` | Paper-Broker (realistische Fill-Simulation), Bitunix/Alpaca-Adapter, Reconciliation, Emergency-Flatten |
| `src/execution/` | Order-Gates, Post-Only-Fallback, TWAP-Engine |
| `src/live-gate/` | Harte Freigabeschicht für jeden Live-Pfad |
| `src/lib/` (Risk) | `riskGuard`, `positionSizing`, `volatilityTargeting`, `drawdownScaling`, `signalDecay`, `circuitBreaker`, `exits` |
| `src/backtest/` | Backtest-Engines (legacy/paper/event-replay), Walk-Forward, Monte-Carlo, Trade-Ledger |
| `src/forecasts/` · `src/features/` · `src/perpdata/` · `src/sentiment/` · `src/crossSectional/` · `src/confluence/` | Research-Schicht: point-in-time Forecasts, Feature Store, Perp-Daten, Sentiment, Cross-Sectional Ranking, MTF-Konfluenz |
| `src/strategyLifecycle/` | 9-Zustands-Lifecycle mit Driftgates (Backtest↔Paper↔Live) |
| `src/routing/` | LLM-Model-Router (Ollama/OpenAI/Gemini/Claude), Turn-Budgets, Prompt-Performance |
| `src/db/` + `drizzle/` | Drizzle-Schema, append-only/idempotente Migrations |

Vollständige Komponenten- und API-Übersicht: [VERSION.md](VERSION.md).
Struktur des Repos: [docs/REPOSITORY_STRUCTURE.md](docs/REPOSITORY_STRUCTURE.md).

## Sicherheit — Kernaussagen (Beta-Stand)

Das Projekt trägt die Härtung mehrerer Sicherheitsaudits
([docs/security/](docs/security/README.md), [docs/audits/](docs/audits/README.md));
wichtigste Eigenschaften:

- **Auth-Modus ist eine Entscheidung, kein fehlender Wert:** In Produktion
  ohne Token verweigert der Dienst den Start (`AUTH_NOT_CONFIGURED`);
  `local-open` ist bewusster Opt-in, `token-required` erzwingt Credentials
  auch in Dev.
- **Unabhängiges `FIRM_SESSION_SECRET`** (≥ 32 Zeichen, nie ein Login-Token)
  für Browser-Sessions; Idle-TTL + absolute Obergrenze + Refresh mit CSRF.
- **Sensible Reads schützen:** Dashboard-APIs (`/api/firm*`, `/api/providers`,
  `/api/routing`) verlangen `firm.read`, Antworten `private, no-store`.
- **Kill-Switch:** Arm ist Operator-tauglich, **Disarm** verlangt ADMIN-Permission
  + CSRF + kurzlebiges Single-Use-Nonce; Flatten arbeitet auf echten
  Venue-Positionen (EmergencyBroker-Schnittstelle, Paper- und Live-Engine).
- **Daurable Audit-Trail:** sicherheitsrelevante Schreibvorgänge mit Retry und
  persistenter Spool (at-least-once), fail-closed wo die Mutation vermeidbar
  ist; Metrik + API zeigen Audit-Lücken.
- **Gepinnte Framework-Versionen:** Next.js 16.3.4, `ws` 8.21.3 exakt
  (Regressionstests `test:security:next` / `test:security:ws`, CI-Gate
  `security:live-gate`).

Vollständige Security-Architektur und Upgrade-Runbooks:
[docs/security/README.md](docs/security/README.md) ·
[docs/security/SECURITY_AUDIT.md](docs/security/SECURITY_AUDIT.md).

## Repository-Struktur (Kurzfassung)

```
├── README.md                 ← diese Datei (inkl. Beta-Disclaimer)
├── CHANGELOG.md              ← kanonischer Changelog (Keep a Changelog, v0.x.x)
├── VERSION.md                ← Versions-Metadaten (v0.1.0, Beta) + Komponenten-Übersicht
├── CONTRIBUTING.md           ← Beitrags-Leitfaden & Konventionen
├── LICENSE                   ← GPL-3.0-only
├── INSTALL.md                ← Installations-Übersicht (Wrapper → docs/INSTALL.md)
├── CONFIGURATION.md          ← verbindliche Env-Flag-Referenz
├── package.json              ← Version-SSoT (v0.1.0), Scripts, Abhängigkeiten
├── .env.example              ← alle Flags mit sicheren Defaults
├── src/                      ← Anwendung (Next.js App Router + Modul-Verzeichnis, s. docs/REPOSITORY_STRUCTURE.md)
├── tests/                    ← gesamte Test-Suite (node:test; einziger Test-Ort)
├── scripts/                  ← CLI-/Betriebsskripte (Setup, Sync, Scan, Backtest, Watchdog)
├── drizzle/                  ← SQL-Migrations (append-only, idempotent)
├── deploy/                   ← systemd-Units (Firma, Market-Sync, Mikro-Executor)
├── data/                     ← versionierte Seed-Daten (Universe); Laufzeitdaten gitignored
├── docs/                     ← vollständige Dokumentation (Index: docs/README.md)
│   ├── audits/               ← Audit-Zyklen chronologisch (Peer-Review, Security, Feature-Gap, Roadmap)
│   ├── peer-reviews/         ← Peer-Review-Reports & Patches
│   ├── security/             ← Security-Übersicht & Audit-Report
│   ├── architecture/         ← DB-Schema, Integrationspunkte, Pipeline-Karte
│   ├── help/                 ← 3-Ebenen-Hilfe-JSONs der UI
│   ├── ci/                   ← versionierte Quellen der CI-Workflows
│   └── archive/              ← historische Docs (inkl. Legacy-Changelog v1.x.x)
└── .github/workflows/        ← CI (Spiegel von docs/ci/): docs-validate, security-live-gate
```

## Dokumentation

Alle Dokumente sind auch im laufenden System unter **`/docs`** im Browser
lesbar (kanonische URLs `/docs/<Datei>.md`). Index: [docs/README.md](docs/README.md).

| Dokument | Inhalt |
|----------|--------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Zielbild, Makro-/Mikro-Zyklen, Decoupling, Security, Glossar |
| [docs/REPOSITORY_STRUCTURE.md](docs/REPOSITORY_STRUCTURE.md) | Verzeichnisstruktur & Zwecke aller Ordner |
| [docs/INSTALL.md](docs/INSTALL.md) / [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) | Installation (CachyOS A/B, Windows) |
| [CONFIGURATION.md](CONFIGURATION.md) | Alle Env-Flags mit sicheren Defaults (verbindlich) |
| [docs/HANDBUCH.md](docs/HANDBUCH.md) | Bedienung, Runbooks, Troubleshooting, Agenten-Register |
| [docs/BROKER_ARCHITECTURE.md](docs/BROKER_ARCHITECTURE.md) | Broker-Adapter-Vertrag, Capability-Matrix, Execution Modes |
| [docs/MARKET_DATA_PIPELINE.md](docs/MARKET_DATA_PIPELINE.md) | Discovery, Enrichment, Candle-Backfill, Scanner-Grenze |
| [docs/BACKTESTING.md](docs/BACKTESTING.md) / [docs/BACKTEST_ENGINE.md](docs/BACKTEST_ENGINE.md) | Walk-Forward-Backtests, Multi-Asset-Engine, Trade-Ledger, Monte-Carlo |
| [docs/LIVE_TRADING.md](docs/LIVE_TRADING.md) / [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md) | Live-Gate / Paper-Simulation im Detail |
| [docs/PORTFOLIO_ANALYTICS.md](docs/PORTFOLIO_ANALYTICS.md) | Formelkatalog, Kovarianz, Optimizer, Risk-Guard-Kette |
| [docs/STRATEGY_LIFECYCLE.md](docs/STRATEGY_LIFECYCLE.md) | Strategy-Lifecycle & Driftgates (RMA-P1-05) |
| [docs/VOLATILITY_TARGETING.md](docs/VOLATILITY_TARGETING.md) / [docs/DRAWDOWN_SCALING.md](docs/DRAWDOWN_SCALING.md) / [docs/SIGNAL_DECAY.md](docs/SIGNAL_DECAY.md) | Risk-Scalierungs-Layer (RMA-P5-01/04/05) |
| [docs/POST_ONLY_FALLBACK.md](docs/POST_ONLY_FALLBACK.md) / [docs/TWAP_EXECUTION.md](docs/TWAP_EXECUTION.md) | Execution-Strategien (RMA-P4-02/03) |
| [docs/security/README.md](docs/security/README.md) | Security-Übersicht: Auth-Modell, RBAC, aggregierte Findings |
| [docs/audits/](docs/audits/README.md) | Audit-Verwaltung (chronologisch, mit Status-Modell) |
| [docs/ARENA_TASKS.md](docs/ARENA_TASKS.md) | Task-Tracker (01–12+) mit Status und PRs |
| [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) / [docs/OPERATIONS.md](docs/OPERATIONS.md) | Metriken, Auto-Circuit-Breaker, Alerts, Runbooks |

Weitere Module: `MARKET_UNIVERSE`, `SYMBOLS`, `BITUNIX`, `ALPACA`,
`FORECASTS`, `FEATURE_STORE`, `PERPETUAL_DATA`, `CROSS_SECTIONAL_RANKING`,
`SENTIMENT`, `MTF_CONFLUENCE`, `REGIME_GATE`, `MONTE_CARLO`,
`PROMPT_PERFORMANCE`, `DEVILS_ADVOCATE`, `LLM_ROUTING`, `PROVIDER_INTEGRATION`,
`FRONTEND_CONTROL_PLANE`, `DAILY_WEEKLY_RESEARCH`.

## Testen & Validieren

```bash
npm test                  # Unit/Integration (node:test; DB-Suites skipfen ohne Postgres)
npm run typecheck         # tsc --noEmit
npm run lint              # ESLint
npm run docs:validate     # Docs-as-Code-Wächter (Links, Schema, Flags, Routen, Secrets)
npm run security:live-gate  # Next + ws + Auth + Live-Gate (CI-Pflicht)
./scripts/validate-setup.sh  # 18 Setup-Checks
```

CI: [docs/ci/README.md](docs/ci/README.md) (Workflows `docs-validate` +
`security-live-gate`, Actions auf Commit-SHA gepinnt).

## Lizenz & Haftung

**GNU General Public License v3.0 (GPL-3.0-only)** — siehe [LICENSE](LICENSE).
Beiträge: [CONTRIBUTING.md](CONTRIBUTING.md).

Die Lizenz überträgt den Code **ohne jegliche Garantie**, gleich welcher Art
(§15 GPL-3.0). Darüber hinaus gilt der Disclaimer oben: **kein Support, keine
Haftung, keine Eignung für produktives Trading.**

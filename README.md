# Autonome KI-Trading-Firma — lokal, Open Source, ohne Cloud

Ein lauffähiges Referenz-Setup für ein Team spezialisierter KI-Agenten
(CEO, Research, Technical, News, Macro, Risk, Portfolio, Approver, Executor),
das ein Handelsziel autonom bearbeitet — komplett auf eigener Hardware, mit
einer **abstrakten LLM-Provider-Schicht** (Ollama, OpenAI-kompatible Endpunkte,
Gemini, Claude), **PostgreSQL** als institutionellem Gedächtnis und **harten
Risikogrenzen im Code**.

> **Wichtig:** Das System läuft ausschließlich im **Paper-Trading-Modus**. Es
> gibt keinen aktiven Live-Broker-Pfad. Kein echtes Geld ist im Spiel — genau
> so soll man anfangen.

> **Dokumentationsstand:** v1.36.11 (2026-09-03) · Vollständige
> code-synchronisierte Docs in [`docs/`](docs/), Task-Tracker in
> [`docs/ARENA_TASKS.md`](docs/ARENA_TASKS.md), Audit-Report in
> [`docs/DOCS_SYNC_AUDIT.md`](docs/DOCS_SYNC_AUDIT.md), Setup-Befunde in
> [`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md).

## Quickstart

**Auf CachyOS (empfohlen):** ein Befehl, zehn Schritte, idempotent.

```bash
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm
./scripts/setup-cachyos.sh --variant a     # Variante A: alles auf einem Rechner
./scripts/setup-cachyos.sh --variant b --llm-host 192.168.0.20
```

Das Skript installiert Node/PostgreSQL, legt Rolle und Datenbank an, schreibt
`.env` inkl. `FIRM_API_TOKEN` (Recht `600`), spielt das Schema ein, seedet das
Markt-Universum (354 Instrumente), aktiviert Short-Selling, baut die App und
führt am Ende **18 Validierungs-Checks** aus. Es ist beliebig oft wiederholbar
und überschreibt weder `.env` noch Cluster-Daten ohne Rückfrage.

Nützlich: `--dry-run` (nichts ausführen), `--non-interactive`, `--no-shorts`,
`--sync-markets`, `--skip-build`, `--min-pass 18`, `--help`.
Log: `data/setup/setup-<Zeitstempel>.log`.

**Manuell / anderes System:**

```bash
cp .env.example .env        # Pflicht-Flags setzen (DATABASE_URL)
npm ci
npx drizzle-kit push        # Schema einspielen
npm run universe:seed:markets  # 354 Preset-Instrumente (v1.30.0)
npm run universe:seed       # Basis-Universum (26 Instrumente)
npm run market:sync -- --dry-run   # Marktdaten-Warmup prüfen (MDSYNC-001)
BITUNIX_ENABLED=true npm run market:sync   # Registry + Historie persistent füllen
npm run scan -- --sync-first       # deterministischer Scan auf dem Warmup
npm run market:sync:status         # Warmup-Readiness prüfen (nur lesen; Exit 1 = fehlt)
rm -rf .next node_modules/.cache   # Build-Cache löschen (verhindert instanceof-Drift)
npm run build
npm run start               # http://0.0.0.0:3369
./scripts/validate-setup.sh        # 18 Checks, bestanden ab 15
```

Details: [`INSTALL.md`](INSTALL.md) und [`docs/INSTALL.md`](docs/INSTALL.md) sowie [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md) für Windows/PowerShell.
(Schritt für Schritt auf CachyOS, Variante A/B),
[`docs/HANDBUCH.md`](docs/HANDBUCH.md) (Bedienung) und
[`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md) (Setup-Befunde B1–B7).

## Markt-Konfiguration (v1.30.0)

Das mitgelieferte Universum besteht aus vier kuratierten Presets plus
`PAPER`-Spiegel — **354 Instrumente**, deterministisch, idempotent seedbar:

| Asset-Klasse | Anzahl | Venue | `marketType` | Kurzverkauf |
| --- | ---: | --- | --- | --- |
| Aktien | 50 | `ALPACA`, `IBKR` | `spot` | möglich |
| Indizes | 50 | `IBKR` | `cfd` | möglich |
| Rohstoffe | 22 | `IBKR` | `future` | möglich |
| Kryptowährungen | 30 | `BINANCE` | `spot` | nein (Spot) |

`npm run universe:seed:markets` schreibt sie, `assertPresetContract()` macht
jede Abweichung von diesen Zahlen zum harten Fehler. Metriken
(`volume24h`, `spread`, `volatility`) starten auf `null` und werden von
`npm run market:sync` gefüllt — die Registry erfindet keine Marktdaten.

**Short-Selling ist seit v1.30.0 per Default aktiviert**
(`risk_config.allowShort = 1`, im Setup abschaltbar mit `--no-shorts`).
Unverändert hart im Code: `maxLeverage = 1` (kein Hebel),
`requireStopLoss = true` (nicht abschaltbar), Kill-Switch, Positions- und
Drawdown-Limits über `LIMIT_CEILINGS` — `shortAvailable` beschreibt die
Venue-Fähigkeit, die operative Freigabe ist ausschließlich
`riskLimits.allowShort`. Einzelheiten:
[`docs/MARKET_UNIVERSE.md`](docs/MARKET_UNIVERSE.md).

## Architektur in Kürze

Broker-unabhängige Infrastruktur mit dynamischem Instrument-Universe.
Market Discovery and historical warmup are performed by the
MarketDataSyncService before the deterministic scanner runs.
The scanner itself never performs network I/O.

**MARKET UNIVERSE → deterministischer Scanner
(Liquidität/Volatilität/Korrelation) → MARKET RANKER → DAILY/WEEKLY → AGENT
ANALYSIS (Technical/News/Macro) → RESEARCH → RISK MANAGER → PORTFOLIO ENGINE →
APPROVAL LAYER → RULE ENGINE → PAPER/LIVE.**

Decoupling-Prinzipien: **LLM = Interpretation · Mathematik = Berechnung ·
Risk Engine = Autorität · Sicherheit im Code.** Vollständiges Zielbild und
Glossar: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Symbol-Notation

Instrumente werden als `VENUE:SYMBOL` adressiert (z. B. `BINANCE:BTCUSDT`,
`KRAKEN:BTC/USD`, `ALPACA:AAPL`). Seit v1.28.0 normalisiert die zentrale,
venue-aware Symbolschicht (`src/symbols/`) alle historischen Schreibweisen
(`BTCUSDT`, `BTC/USD`, `BTC-USD`, `BTC_USD`, `EUR.USD`, `EURUSD=X`) auf eine
**kanonische Form** — Krypto-/FX-Paare mit `/` (`BTC/USD`), Einzelwerte ohne
Trenner (`AAPL`) — und bildet sie auf die venue-native Form der API ab
(`BTC/USD` → Kraken `XBTUSD`, Binance `BTCUSDT`, IBKR `EUR.USD`). Die
Registry speichert weiterhin die venue-native Schreibweise; die kanonische ID
ist daraus deterministisch ableitbar. Regeln, Profile und das
Migrationsskript: [`docs/SYMBOLS.md`](docs/SYMBOLS.md).

## Dokumentation

| Dokument | Inhalt |
| --- | --- |
| `docs/ARCHITECTURE.md` | Zielbild, Decoupling, Execution Modes, Glossar, Docs-Pflege |
| `docs/SYMBOLS.md` | Zentrale, venue-aware Symbol-Normalisierung (SYM-007) |
| `docs/MARKET_DATA_PIPELINE.md` | Discovery, Enrichment, Candle-Backfill, Scanner-Grenze |
| `docs/INSTALL.md` | Installation auf CachyOS, beide Varianten |
| `docs/SETUP_BUGS.md` | Setup-Bug-Register: PostgreSQL-Init, Seed/UUID, Broker-Adapter, Build-Warnungen, API-Token, Validierung, PAPER_MODE-Default |
| `docs/HANDBUCH.md` | Bedienung, Runbooks, Troubleshooting, Agenten-Register |
| `docs/CHANGELOG.md` | Versionen und Änderungen (Keep a Changelog) |
| `docs/SECURITY_AUDIT.md` | Konsolidierte Security-Architektur + Task-Audits |
| `docs/ARENA_TASKS.md` | Task-Tracker (1–12) mit Status, PR, Security, Review |
| `docs/DOCS_SYNC_AUDIT.md` | Docs-Code-Sync-Audit-Report (Task 12) |
| `docs/help/*.help.json` | 3-Ebenen-Hilfe-Systematik (Schema: `docs/help/help.schema.json`) |

Weitere Module: `MARKET_UNIVERSE`, `MARKET_DATA_PIPELINE`, `BROKER_ARCHITECTURE`, `BITUNIX`,
`PAPER_TRADING`, `PORTFOLIO_ANALYTICS`, `DAILY_WEEKLY_RESEARCH`, `LLM_ROUTING`,
`PROVIDER_INTEGRATION`, `FRONTEND_CONTROL_PLANE`, `LIVE_TRADING`,
`PEER_REVIEW_LIVE_TRADING`.

## Testen & Validieren

```bash
npm test                 # Unit/Integration (1389 Tests)
npm run test:coverage:marketsync   # Sync/Adapter: Coverage-Gate ≥90 % Linien
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run docs:validate    # Docs-as-Code-Wächter (Task 12, CI-Job docs-validate)
npm run universe:seed:markets  # Preset-Universum (50 Aktien/50 Indizes/22 Rohstoffe/30 Krypto)
./scripts/validate-setup.sh    # 18 Setup-Checks (bestanden ab --min-pass 15)
npm run security:live-gate  # Live-Gate-Security-Suite (Task 11, Coverage ≥95 %)
npm run test:coverage:routing  # Model-Router-Coverage (Task 09 + v1.22.0 Overrides)
```

## Lizenz

MIT — siehe [`LICENSE`](LICENSE).

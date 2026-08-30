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

> **Dokumentationsstand:** v1.24.0 (2026-08-29) · Vollständige
> code-synchronisierte Docs in [`docs/`](docs/), Task-Tracker in
> [`docs/ARENA_TASKS.md`](docs/ARENA_TASKS.md), Audit-Report in
> [`docs/DOCS_SYNC_AUDIT.md`](docs/DOCS_SYNC_AUDIT.md).

## Quickstart

```bash
cp .env.example .env        # Pflicht-Flags setzen (DATABASE_URL)
npm ci
npx drizzle-kit push        # Schema einspielen
npm run universe:seed       # Instrument-Universum seeden
npm run build
npm run start               # http://0.0.0.0:3369
```

Details: [`docs/INSTALL.md`](docs/INSTALL.md) (Schritt für Schritt auf
CachyOS, Variante A/B) und [`docs/HANDBUCH.md`](docs/HANDBUCH.md) (Bedienung).

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
npm test                 # Unit/Integration (≈1160 Tests)
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run docs:validate    # Docs-as-Code-Wächter (Task 12, CI-Job docs-validate)
npm run security:live-gate  # Live-Gate-Security-Suite (Task 11, Coverage ≥95 %)
npm run test:coverage:routing  # Model-Router-Coverage (Task 09 + v1.22.0 Overrides)
```

## Lizenz

MIT — siehe [`LICENSE`](LICENSE).

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

> **Dokumentationsstand:** v1.36.16 (2026-09-04) · Vollständige
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

## Sicherheit: Auth-Modus ist Pflicht, nicht Zufall (v1.36.13)

Die schreibende API (`POST`/`PUT` auf `/api/firm/*`, `/api/seed`,
Credential-/Routing-Endpunkte) ist an ein Credential gebunden — und der Modus
dafür ist eine Entscheidung, kein fehlender Wert:

* `NODE_ENV=production` (also `npm run start` und die systemd-Unit) **ohne**
  `FIRM_ADMIN_TOKEN`/`FIRM_API_TOKEN`/`FIRM_VIEWER_TOKEN` ⇒ der Dienst
  verweigert den Start (`ConfigurationError: AUTH_NOT_CONFIGURED`). Ein
  vergessenes Token ist kein offener Zugang mehr.
* `AUTH_MODE=local-open` ist der bewusste Opt-in für den Single-User-Modus ohne
  Token; außerhalb der Produktion ist es der Dev-Default (`npm run dev`), in
  Produktion nur mit ausdrücklichem Eintrag in `.env` und Warnung im Log.
* `AUTH_MODE=token-required` erzwingt das Credential auch in der Entwicklung —
  nützlich, um das Produktionsverhalten lokal zu prüfen.
* Wirksamer Modus, ohne Credential-Werte: `curl -s localhost:3369/api/auth/me | jq .authMode`.

Flag-Referenz: [`INSTALL.md`](INSTALL.md) → „Auth-Modus“; Befund C1 in
[`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Sicherheit: Rate-Limits kennen keine erfundenen IPs (v1.36.14)

Rate-Limits wirken nur, wenn die Client-Identität nicht vom Client stammt. Bis
v1.36.13 lasen beide Limiter `x-forwarded-for`/`x-real-ip` — Header, die jeder
Aufrufer selbst setzt. Ein frisches `X-Forwarded-For: <zufällig>` pro Anfrage
erzeugte einen frischen Bucket, das Limit war damit faktisch aus (Befund C2,
MEDIUM/HIGH). Jetzt gilt (`src/lib/clientIp.ts`, eine Quelle für Firm- und
Credential-Limit):

* `x-forwarded-for` zählt **nur**, wenn `TRUSTED_PROXY_IPS` konfiguriert ist
  **und** die Socket-Adresse des direkten Peers darin liegt — ausgewertet
  rightmost-untrusted, damit eine vorgeschobene Fake-IP wirkungslos bleibt.
* `x-verified-ip` ist der Header für den Reverse Proxy (nginx:
  `proxy_set_header X-Verified-IP $remote_addr;`) — der einzige Weg, im
  Next.js-App-Router eine echte Client-IP zu bekommen.
* `x-real-ip` wird nie als Identität benutzt; ohne verwertbare
  Proxy-Information zählt die Socket-Adresse, sonst die Konstante `local`
  (alle Clients teilen sich dann ein Limit — enger, nie weiter).
* Credential-Brute-Force wird dreistufig gebremst: Limit pro Identität
  (5/min) + **globales, IP-unabhängiges** Limit (20/min) + exponentieller
  Backoff ab dem 3. Fehlversuch (2 s → 4 s → 8 s … max. 15 min). Der
  Kill-Switch nutzt bewusst nur die erste Stufe.
* Sichtbar ohne Secret-Werte: `curl -s localhost:3369/api/auth/me | jq .rateLimitIdentity`
  (inkl. `ignoredHeaders` — welche Header die App verworfen hat).

Flag-Referenz: [`INSTALL.md`](INSTALL.md) → „Rate-Limit-Identität“; Befund C2 in
[`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Sicherheit: Disarm des Kill-Switch ist stärker als Arm (v1.36.15)

Der Firm-Not-Halt ist die härteste Schicht — deshalb darf ihn nicht dasselbe
Credential wieder aufheben, das ihn zieht (Befund C3, HIGH). Seit v1.36.15:

* **Arm** (`POST /api/firm/kill` mit `{arm:true}`) bleibt Operator-tauglich
  (`guardWrite`): scharfschalten ist keine Eskalation.
* **Disarm** (`{arm:false, nonce}`) verlangt eine strikt stärkere Kette:
  1. ADMIN-Permission `live.gate` → ein gestohlenes Operator-Token reicht nicht,
  2. CSRF-Header `x-csrf-token`,
  3. einen kurzlebigen **single-use Nonce** (≤ 60 s) aus
     `GET /api/firm/kill/challenge`, der im Body zurückgegeben wird. Fehlt/ist
     abgelaufen/wiederverwendet ⇒ 403, kein Disarm.
* Ein erfolgreicher Disarm wird als **CRITICAL** auditiert (Actor + Nonce).

Ein gestohlenes Operator-Token kann das Trading damit **nicht** mehr still wieder
freischalten, nachdem der Not-Halt ausgelöst wurde. Befund C3 in
[`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Control Plane: Verbindungszustand überlebt den Neustart (v1.36.16)

Bis v1.36.15 lebte der Zustand des Broker-Tabs (verbunden? welche Rechte? letzte
Discovery?) nur im Prozessspeicher — nach jedem Neustart stand dort
`configured=true, connected=false`, bis jemand erneut testete (Befund C4, MEDIUM).
Seit v1.36.16 ist die Tabelle **`venue_control_state`** die Wahrheit und die
Prozess-Map nur Cache:

* jede Aktion (save/test/discover/disable) **upsertet** die Zeile,
* `GET /api/brokers/{venue}/status` zeigt nach einem Neustart den **letzten
  bekannten Zustand**, und der Boot-Warm-up füllt den Cache für die Live-Gate-
  Bridge vorab,
* persistiert wird **status-only** (Ebenen, Rechte-Namen, Zähler, Zeitstempel,
  SAFE-Fehlercodes) — nie ein Secret; `liveEnabled` wird beim Laden immer neu aus
  dem Live-Gate-Enforcer projiziert,
* fehlt die Tabelle noch (`npx drizzle-kit push`), läuft alles wie zuvor
  prozesslokal weiter und `/api/health` nennt sie unter `missingTables`.

Befund C4 in [`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

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
| `docs/AUDIT_REMEDIATION_2026-09.md` | Senior-Peer-Review 2026-09: Befunde, Validierungsstand, je ein Remediation-Prompt (`audit-remediation/`) |
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

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

> **Dokumentationsstand:** v1.36.24 (2026-09-05) · Vollständige
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

## Audit-Trail ist durable: Sicherheits-Audits mit Retry, Spool und Alarm (v1.36.18)

Bis v1.36.16 konnten Audit-Schreibvorgänge in leeren `catch`-Blöcken
verschwinden (Befund S1, MEDIUM) — eine gespeicherte Credential-Änderung, ein
geänderter Prompt oder ein entschärfter Not-Halt blieb dann ohne Beleg im
`audit_log`, und nichts deutete darauf hin. Seit v1.36.18 gilt:

* **zwei Klassen** in `src/lib/auditSink.ts`: `security` (Auth, Kill-Switch,
  Credentials, Order-Ablehnungen, Freigaben, Prompts) retryt mit Backoff und
  legt den Beleg bei DB-Ausfall persistent nach `data/audit-spool/`
  (at-least-once, automatischer Nachzug inkl. Boot); `telemetry` bleibt
  best-effort, loggt und zählt aber mindestens,
* **fail-closed, wo die Mutation noch vermeidbar ist:** Credential-Store,
  Kill-Switch-**Disarm** und Proposal-Freigabe bleiben ohne durablen Beleg aus
  (`503 AUDIT_PERSISTENCE_FAILED`); der Not-Halt-**Arm** wird nie blockiert,
* **Lücken sind sichtbar:** CRITICAL im Journal, `audit_missed_total` in der
  Metrik, `audit {…}` in `/api/health` und eine eigene Kennzahlengruppe in der
  Operations-Center-Sektion „Audit",
* **kein Dauerblocker:** von der DB abgelehnte Zeilen landen nach 3 Versuchen
  in `audit-quarantine.ndjson`, statt den Nachzug zu stoppen.

Befund S1 in [`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Kill-Switch/Flatten arbeitet auf echten Venue-Positionen, nicht nur auf dem Paper-Ledger (v1.36.20)

Bis v1.36.19 lief der Not-Halt so: `/api/firm/kill` → `flattenAll()` →
`getBroker()` lieferte den in-process **Paper-Broker** und rief dort
`closeAll()` — die echte Bitunix-/Live-Ausführungs-Engine war nie beteiligt
(Befund H7, HIGH). Ein Kill hätte bei späterer Live-Freigabe die Simulation
geschlossen und reale Venue-Positionen offen gelassen. Seit v1.36.20:

* **eine `EmergencyBroker`-Schnittstelle** für Notfälle
  (`cancelAllOpenOrders → closeAllPositions → verifyFlat`), erfüllt vom
  `PaperBroker` **und** der Live-`BrokerExecutionEngine` (Bitunix:
  `cancel_all_orders`/`close_all_position`, Alpaca: `DELETE /v2/orders`/
  `DELETE /v2/positions`),
* **`flattenAll()`** löst den Broker aus der Konfiguration:
  Paper-Default, Live nur wenn Plattform- + Venue-Flags + Live-Gate
  freigeben; die Sequenz läuft in fester Reihenfolge, ein „nicht flach“
  löst genau einen Retry-Close aus, danach Alarm,
* **im Audit belegbar**: `FLATTEN_ALL` nennt `mode`/`venue`, Storno- und
  Close-Anzahl sowie das `verifyFlat`-Ergebnis — bei Paper-Default steht
  dort eindeutig *„paper-only flatten (live disabled)“*,
* **Reihenfolge im Not-Halt:** die Notfall-Sequenz läuft vor
  `killSwitch.pull()` — Arm wird nie durch einen Flatten-Fehler blockiert
  (Fehler stehen im Outcome + Audit).

Befund H7 in [`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Adaptives Risk fällt bei unbekannter Bewertung nicht mehr still auf Basis-Risiko zurück — fail-closed, explizites UNKNOWN (v1.36.21)

Bis v1.36.20 galt bei fehlender/fehlerhafter/zu alter Volatilitäts-Bewertung
„Basis-Limit aktiv (Fail-Open)": Ein unbekanntes Risikobild wurde wie volle
Risikobereitschaft behandelt (Befund H10, HIGH). Seit v1.36.21:

* **neuer Regime-Wert `UNKNOWN`** — fehlende (MISSING), fehlerhafte (ERRORED)
  oder älter als 15 Minuten (STALE) Bewertung ergibt bei aktiviertem
  Adaptiv-System explizit `regime: "UNKNOWN"` statt stillem `NORMAL`,
* **konservativster Faktor**: das wirksame `maxRiskPerTrade` klemmt auf den
  Code-Boden (`LIMIT_CEILINGS.maxRiskPerTrade[0]`, 0.2 %) und wird über
  `applyAdaptiveRisk` auch auf die riskGuard-Limits angewendet; der Wechsel
  ist als WARN-Event mit Grund auditiert,
* **keine neuen Positionen**: `runAgentTurn` blockt bei UNKNOWN genau wie bei
  EXTREME (`ORDER_REJECTED`/WARN, Guardrail `ADAPTIVE_RISK_UNKNOWN` bzw.
  `ADAPTIVE_RISK_EXTREME`), der Trace zeigt `ADAPTIVES-RISIKO ok=false` und
  den Grund im `ADAPTIVES-RISIKO-GATE`-Step,
* **Operator-Wahl bleibt respektiert**: deaktiviertes System (`adp.enabled=0`)
  bleibt bewusst NORMAL — UNKNOWN gilt nur für aktivierte Adaptiv-Systeme.

Befund H10 in [`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md)
und Akzeptanzdetail im [Arena-Prompt](audit-remediation/H10-adaptive-failopen.md).

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

GNU General Public License v3.0 (GPL-3.0) — siehe [`LICENSE`](LICENSE).

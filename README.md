# Autonome KI-Trading-Firma — lokal, Open Source, ohne Cloud

Ein lauffähiges Referenz-Setup für ein Team spezialisierter KI-Agenten (CEO, Research, Technical, News, Macro, Risk, Portfolio, Approver, Executor), das ein Handelsziel autonom bearbeitet — komplett auf eigener Hardware, mit einer **abstrakten LLM-Provider-Schicht** (Ollama, OpenAI-kompatible Endpunkte, Gemini, Claude), **PostgreSQL** als institutionellem Gedächtnis und **harten Risikogrenzen im Code**.

> **Wichtig:** Das System läuft ausschließlich im **Paper-Trading-Modus**. Es gibt keinen aktiven Live-Broker-Pfad. Kein echtes Geld ist im Spiel — genau so soll man anfangen.

> **Dokumentationsstand:** v1.36.31 (2026-09-06) · Vollständige code-synchronisierte Docs in [`docs/`](docs/) (neue Struktur: [`docs/audits/`](docs/audits/) + [`docs/peer-reviews/`](docs/peer-reviews/) + [`docs/security/`](docs/security/)), Task-Tracker in [`docs/ARENA_TASKS.md`](docs/ARENA_TASKS.md), Audit-Report in [`docs/DOCS_SYNC_AUDIT.md`](docs/DOCS_SYNC_AUDIT.md), Setup-Befunde in [`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md), Security-Übersicht in [`docs/security/README.md`](docs/security/README.md).

## Quickstart

**Auf CachyOS (empfohlen):** ein Befehl, zehn Schritte, idempotent.

```bash
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm
./scripts/setup-cachyos.sh --variant a     # Variante A: alles auf einem Rechner
./scripts/setup-cachyos.sh --variant b --llm-host 192.168.0.20
```

Das Skript installiert Node/PostgreSQL, legt Rolle und Datenbank an, schreibt `.env` inkl. `FIRM_API_TOKEN` und separat erzeugtem `FIRM_SESSION_SECRET` (Recht `600`), spielt das Schema ein, seedet das Markt-Universum (354 Instrumente), aktiviert Short-Selling, baut die App und führt am Ende **18 Validierungs-Checks** aus. Es ist beliebig oft wiederholbar und überschreibt weder `.env` noch Cluster-Daten ohne Rückfrage.

Nützlich: `--dry-run` (nichts ausführen), `--non-interactive`, `--no-shorts`, `--sync-markets`, `--skip-build`, `--min-pass 18`, `--help`.  
Log: `data/setup/setup-<Zeitstempel>.log`.

**Manuell / anderes System:**

```bash
cp .env.example .env        # Pflicht-Flags setzen (DATABASE_URL)
umask 077
printf 'FIRM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'FIRM_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
chmod 600 .env
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

Details: [`INSTALL.md`](INSTALL.md) (Wrapper) → [`docs/INSTALL.md`](docs/INSTALL.md) (CachyOS, Schritt für Schritt, Variante A/B) + [`CONFIGURATION.md`](CONFIGURATION.md) (Flag-Referenz) sowie [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md) für Windows/PowerShell, [`docs/HANDBUCH.md`](docs/HANDBUCH.md) (Bedienung) und [`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md) (Setup-Befunde B1–B7).

## Dokumentationsstruktur (neu 2026-09-05)

Die Dokumentation wurde grundlegend aufgeräumt — skalierbar für wiederkehrende Audits, Peer-Reviews und Security-Findings:

```
docs/
├── README.md                 # Doku-Index (diese Struktur)
├── INSTALL.md                # CachyOS-Installation (kanonisch)
├── CHANGELOG.md              # Stub → ../CHANGELOG.md (kanonisch im Root)
├── ARCHITECTURE.md, HANDBUCH.md, ...
├── audits/                   # NEU: alle Audits chronologisch
│   ├── README.md             # erklärt Naming, Workflow, Status-Modell
│   ├── TEMPLATE/             # Vorlage für neuen Audit
│   ├── 2026-09-03-peer-review/      # Peer-Review-Audit (CLOSED, H1-H10 etc.)
│   └── 2026-09-05-security-review-gpt01/  # Security-Audit GPT_01 (SEC-01/02/03/04/10 FIXED; Rest OPEN)
├── peer-reviews/             # NEU: Peer-Review-Patches gesammelt
│   ├── README.md
│   ├── 2026-08-26-live-trading-readiness/
│   ├── 2026-08-26-bitunix-execution/
│   └── 2026-08-26-routing-overrides/
├── security/                 # NEU: Security-Übersicht
│   ├── README.md             # aggregierte Critical/High Findings
│   └── SECURITY_AUDIT.md     # Security-Audit 2026-08-25
└── archive/                  # NEU: historische Docs
    └── task-plans/           # task-*.md archiviert
```

**Kanonische Dateien im Root:**
- [`CHANGELOG.md`](CHANGELOG.md) — detaillierter Changelog (Keep a Changelog, ehemals Duplikat in docs/)
- [`CONFIGURATION.md`](CONFIGURATION.md) — Env-Flags (ehemals Root `INSTALL.md` Flag-Referenz)
- [`INSTALL.md`](INSTALL.md) — Wrapper (zeigt auf `docs/INSTALL.md` + `CONFIGURATION.md`)

Siehe [`docs/audits/README.md`](docs/audits/README.md) für Audit-Workflow, [`docs/peer-reviews/README.md`](docs/peer-reviews/README.md) für Patch-Verlinkung, [`docs/security/README.md`](docs/security/README.md) für Security-Modell.

## Sicherheit: Auth-Modus und sensible Reads sind Pflicht, nicht Zufall (v1.36.31)

Die schreibende API (`POST`/`PUT` auf `/api/firm/*`, `/api/seed`, Credential-/Routing-Endpunkte) **und** die sensitiven Dashboard-Reads sind an ein Credential gebunden — und der Modus dafür ist eine Entscheidung, kein fehlender Wert:

* `NODE_ENV=production` (also `npm run start` und die systemd-Unit) **ohne** `FIRM_ADMIN_TOKEN`/`FIRM_API_TOKEN`/`FIRM_VIEWER_TOKEN` ⇒ der Dienst verweigert den Start (`ConfigurationError: AUTH_NOT_CONFIGURED`). Ein vergessenes Token ist kein offener Zugang mehr.
* `AUTH_MODE=local-open` ist der bewusste Opt-in für den Single-User-Modus ohne Token; außerhalb der Produktion ist es der Dev-Default (`npm run dev`), in Produktion nur mit ausdrücklichem Eintrag in `.env` und Warnung im Log.
* `AUTH_MODE=token-required` erzwingt das Credential auch in der Entwicklung — nützlich, um das Produktionsverhalten lokal zu prüfen.
* Die sensitiven `GET`-Routen `/api/firm`, `/api/firm/log`, `/api/firm/report`,
  `/api/firm/rules`, `/api/providers` und `/api/routing` verlangen seit SEC-02
  `firm.read`. Viewer, Operator und Admin besitzen diese Permission. Direkte
  Clients verwenden ihr vorhandenes Header-Credential; die Browser-Oberfläche
  sendet nach dem Login die HttpOnly-Session automatisch mit.
* Wirksamer Modus, ohne Credential-Werte: `curl -s localhost:3369/api/auth/me | jq .authMode`.

Flag-Referenz: [`CONFIGURATION.md`](CONFIGURATION.md) → „Auth-Modus“; Befund C1 in [`docs/audits/2026-09-03-peer-review/findings/C1-open-mode.md`](docs/audits/2026-09-03-peer-review/findings/C1-open-mode.md).

## Security-Update: sensible Dashboard-Reads (SEC-02, v1.36.31)

**Upgrade erforderlich:** Bis v1.36.30 waren sechs sensible Dashboard-APIs für
Firmenstatus, Protokolle, Reports, Regeln, Provider und Routing nicht durch die
bestehende Read-Permission geschützt. v1.36.31 verlangt dort `firm.read` und
liefert Antworten außerdem als `private, no-store` aus. Viewer, Operator und
Admin können die Daten weiterhin lesen; Browser-Sessions funktionieren ohne
Token im Frontend weiter.

Alle Instanzen neu ausrollen und starten. Keine neue Konfiguration oder Migration
ist erforderlich; direkte Integrationen müssen für diese Reads ihr bestehendes
Viewer-, Operator- oder Admin-Credential mitsenden. Details:
[Security-Übersicht](docs/security/README.md#sensible-dashboard-read-apis-sec-02).

## Security-Update: WebSocket-Bibliothek (SEC-04, v1.36.30)

**Upgrade erforderlich:** Bis v1.36.29 ließ die Versionsangabe `ws: ^8.18.0`
verwundbare Stände der WebSocket-Bibliothek zu (Speichererschöpfung durch einen
Netzwerk-Peer, mögliche Offenlegung nicht initialisierten Speichers). v1.36.30
pinnt **ws 8.21.3** exakt, erzwingt dieselbe Version für transitive Kopien und
härtet den Bitunix-WebSocket-Client zusätzlich: Er verbindet sich nur mit
gepatchter Bibliothek und kappt Nachrichtengrößen, Kompression und Redirects.

Mit `npm ci` aus dem geprüften Lockfile installieren, `npm ls ws --all` und
`npm run test:security:ws` ausführen, neu bauen und alle Prozesse neu starten —
ein laufender Prozess behält die alte Bibliothek im Speicher.
[Upgrade und Betrieb](docs/security/README.md#ws-upgrade-sec-04).

## Security-Update: Next.js (SEC-03, v1.36.28)

**Upgrade erforderlich:** v1.36.27 enthält Next.js 16.3.1 mit bekannten
Framework-/Bildverarbeitungs-Schwachstellen. v1.36.28 pinnt **Next.js 16.3.4**
und aktualisiert die native Decoder-Kette. Das gilt für **Linux und Windows**;
API-Login oder ein derzeit nicht genutztes Image-UI ersetzen den Patch nicht.

Aus dem geprüften Release mit `npm ci` neu installieren, `npm run test:security:next`
ausführen, frisch bauen und alle Instanzen neu starten. Nicht nur das Manifest
ändern oder alte `.next`-Artefakte weiterverwenden. Die Suite prüft auch die
wirklich geladenen Libraries und läuft in CI unter Linux und Windows.
[Upgrade und Betrieb](docs/security/README.md#nextjs-upgrade-sec-03).

## Security-Update: Sessions (SEC-01, v1.36.27)

**Upgrade von v1.36.23–v1.36.26 erforderlich.** Im Token-Betrieb braucht Produktion
jetzt ein **unabhängiges, zufällig erzeugtes `FIRM_SESSION_SECRET`** (mindestens
32 Zeichen; empfohlen `openssl rand -hex 32`). Niemals ein Login-Token oder eine
Ableitung davon verwenden. Fehlende, zu kurze oder als Auth-Token wiederverwendete
Schlüssel führen zum Boot-Fehler `SESSION_SECRET_REQUIRED` / `SESSION_SECRET_INVALID`.
Auch in Dev gibt es ohne gültigen Schlüssel keine Browser-Session (Login: HTTP 503);
Header-Credentials bleiben nutzbar. Bewusstes `local-open` benötigt keine Sessions.

- Das Setup ergänzt einen **fehlenden** Schlüssel; vorhandene Werte bleiben erhalten.
  Bei manuellem Upgrade den Schlüssel einmalig in `.env`/Secret-Management setzen,
  nicht in Client-Konfiguration, Logs oder Git.
- Alle App-Instanzen mit gleicher Auth-Konfiguration neu starten. Bestehende Cookies
  sind nach dem Upgrade ungültig: **erneut anmelden**. Browser-Login in Produktion
  benötigt weiterhin HTTPS.
- Rechte werden pro Request serverseitig abgeleitet. Credential-/Key-Änderungen
  invalidieren Sessions, sobald die neue Konfiguration im jeweiligen Prozess aktiv ist.
- Vor dem Start prüfen: `NODE_ENV=production npm run boot:guard`.

Details: [Session-Konfiguration](CONFIGURATION.md#session-sicherheit-sec-01-v13627)
und [Finding SEC-01](docs/audits/2026-09-05-security-review-gpt01/findings/SEC-01-privilege-escalation.md).

## Sicherheit: Rate-Limits kennen keine erfundenen IPs (v1.36.14)

Rate-Limits wirken nur, wenn die Client-Identität nicht vom Client stammt. Bis v1.36.13 lasen beide Limiter `x-forwarded-for`/`x-real-ip` — Header, die jeder Aufrufer selbst setzt. Ein frisches `X-Forwarded-For: <zufällig>` pro Anfrage erzeugte einen frischen Bucket, das Limit war damit faktisch aus (Befund C2, MEDIUM/HIGH). Jetzt gilt (`src/lib/clientIp.ts`, eine Quelle für Firm- und Credential-Limit):

* `x-forwarded-for` zählt **nur**, wenn `TRUSTED_PROXY_IPS` konfiguriert ist **und** die Socket-Adresse des direkten Peers darin liegt — ausgewertet rightmost-untrusted, damit eine vorgeschobene Fake-IP wirkungslos bleibt.
* `x-verified-ip` ist der Header für den Reverse Proxy (nginx: `proxy_set_header X-Verified-IP $remote_addr;`) — der einzige Weg, im Next.js-App-Router eine echte Client-IP zu bekommen.
* `x-real-ip` wird nie als Identität benutzt; ohne verwertbare Proxy-Information zählt die Socket-Adresse, sonst die Konstante `local` (alle Clients teilen sich dann ein Limit — enger, nie weiter).
* Credential-Brute-Force wird dreistufig gebremst: Limit pro Identität (5/min) + **globales, IP-unabhängiges** Limit (20/min) + exponentieller Backoff ab dem 3. Fehlversuch (2 s → 4 s → 8 s … max. 15 min). Der Kill-Switch nutzt bewusst nur die erste Stufe.
* Sichtbar ohne Secret-Werte: `curl -s localhost:3369/api/auth/me | jq .rateLimitIdentity` (inkl. `ignoredHeaders` — welche Header die App verworfen hat).

Flag-Referenz: [`CONFIGURATION.md`](CONFIGURATION.md) → „Rate-Limit-Identität“; Befund C2 in [`docs/audits/2026-09-03-peer-review/findings/C2-forwarded-ip.md`](docs/audits/2026-09-03-peer-review/findings/C2-forwarded-ip.md).

## Sicherheit: Disarm des Kill-Switch ist stärker als Arm (v1.36.15)

Der Firm-Not-Halt ist die härteste Schicht — deshalb darf ihn nicht dasselbe Credential wieder aufheben, das ihn zieht (Befund C3, HIGH). Seit v1.36.15:

* **Arm** (`POST /api/firm/kill` mit `{arm:true}`) bleibt Operator-tauglich (`guardWrite`): scharfschalten ist keine Eskalation.
* **Disarm** (`{arm:false, nonce}`) verlangt eine strikt stärkere Kette:
  1. ADMIN-Permission `live.gate` → ein gestohlenes Operator-Token reicht nicht,
  2. CSRF-Header `x-csrf-token`,
  3. einen kurzlebigen **single-use Nonce** (≤ 60 s) aus `GET /api/firm/kill/challenge`, der im Body zurückgegeben wird. Fehlt/ist abgelaufen/wiederverwendet ⇒ 403, kein Disarm.
* Ein erfolgreicher Disarm wird als **CRITICAL** auditiert (Actor + Nonce).

Ein gestohlenes Operator-Token kann das Trading damit **nicht** mehr still wieder freischalten, nachdem der Not-Halt ausgelöst wurde. Befund C3 in [`docs/audits/2026-09-03-peer-review/findings/C3-kill-disarm.md`](docs/audits/2026-09-03-peer-review/findings/C3-kill-disarm.md).

## Audit-Trail ist durable: Sicherheits-Audits mit Retry, Spool und Alarm (v1.36.18)

Bis v1.36.16 konnten Audit-Schreibvorgänge in leeren `catch`-Blöcken verschwinden (Befund S1, MEDIUM) — eine gespeicherte Credential-Änderung, ein geänderter Prompt oder ein entschärfter Not-Halt blieb dann ohne Beleg im `audit_log`, und nichts deutete darauf hin. Seit v1.36.18 gilt:

* **zwei Klassen** in `src/lib/auditSink.ts`: `security` (Auth, Kill-Switch, Credentials, Order-Ablehnungen, Freigaben, Prompts) retryt mit Backoff und legt den Beleg bei DB-Ausfall persistent nach `data/audit-spool/` (at-least-once, automatischer Nachzug inkl. Boot); `telemetry` bleibt best-effort, loggt und zählt aber mindestens,
* **fail-closed, wo die Mutation noch vermeidbar ist:** Credential-Store, Kill-Switch-**Disarm** und Proposal-Freigabe bleiben ohne durablen Beleg aus (`503 AUDIT_PERSISTENCE_FAILED`); der Not-Halt-**Arm** wird nie blockiert,
* **Lücken sind sichtbar:** CRITICAL im Journal, `audit_missed_total` in der Metrik, `audit {…}` in `/api/health` und eine eigene Kennzahlengruppe in der Operations-Center-Sektion „Audit“,
* **kein Dauerblocker:** von der DB abgelehnte Zeilen landen nach 3 Versuchen in `audit-quarantine.ndjson`, statt den Nachzug zu stoppen.

Befund S1 in [`docs/audits/2026-09-03-peer-review/findings/S1-audit-reliability.md`](docs/audits/2026-09-03-peer-review/findings/S1-audit-reliability.md).

## Kill-Switch/Flatten arbeitet auf echten Venue-Positionen, nicht nur auf dem Paper-Ledger (v1.36.20)

Bis v1.36.19 lief der Not-Halt so: `/api/firm/kill` → `flattenAll()` → `getBroker()` lieferte den in-process **Paper-Broker** und rief dort `closeAll()` — die echte Bitunix-/Live-Ausführungs-Engine war nie beteiligt (Befund H7, HIGH). Ein Kill hätte bei späterer Live-Freigabe die Simulation geschlossen und reale Venue-Positionen offen gelassen. Seit v1.36.20:

* **eine `EmergencyBroker`-Schnittstelle** für Notfälle (`cancelAllOpenOrders → closeAllPositions → verifyFlat`), erfüllt vom `PaperBroker` **und** der Live-`BrokerExecutionEngine` (Bitunix: `cancel_all_orders`/`close_all_position`, Alpaca: `DELETE /v2/orders`/`DELETE /v2/positions`),
* **`flattenAll()`** löst den Broker aus der Konfiguration: Paper-Default, Live nur wenn Plattform- + Venue-Flags + Live-Gate freigeben; die Sequenz läuft in fester Reihenfolge, ein „nicht flach“ löst genau einen Retry-Close aus, danach Alarm,
* **im Audit belegbar**: `FLATTEN_ALL` nennt `mode`/`venue`, Storno- und Close-Anzahl sowie das `verifyFlat`-Ergebnis — bei Paper-Default steht dort eindeutig *„paper-only flatten (live disabled)“*,
* **Reihenfolge im Not-Halt:** die Notfall-Sequenz läuft vor `killSwitch.pull()` — Arm wird nie durch einen Flatten-Fehler blockiert (Fehler stehen im Outcome + Audit).

Befund H7 in [`docs/audits/2026-09-03-peer-review/findings/H7-live-kill.md`](docs/audits/2026-09-03-peer-review/findings/H7-live-kill.md).

## Architektur in Kürze

Broker-unabhängige Infrastruktur mit dynamischem Instrument-Universe. Market Discovery and historical warmup are performed by the MarketDataSyncService before the deterministic scanner runs. The scanner itself never performs network I/O.

**MARKET UNIVERSE → deterministischer Scanner (Liquidität/Volatilität/Korrelation) → MARKET RANKER → DAILY/WEEKLY → AGENT ANALYSIS (Technical/News/Macro) → RESEARCH → RISK MANAGER → PORTFOLIO ENGINE → APPROVAL LAYER → RULE ENGINE → PAPER/LIVE.**

Decoupling-Prinzipien: **LLM = Interpretation · Mathematik = Berechnung · Risk Engine = Autorität · Sicherheit im Code.** Vollständiges Zielbild und Glossar: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Dokumentation

| Dokument | Inhalt |
|----------|--------|
| `docs/ARCHITECTURE.md` | Zielbild, Decoupling, Execution Modes, Glossar, Docs-Pflege |
| `docs/SYMBOLS.md` | Zentrale, venue-aware Symbol-Normalisierung (SYM-007) |
| `docs/MARKET_DATA_PIPELINE.md` | Discovery, Enrichment, Candle-Backfill, Scanner-Grenze |
| `docs/INSTALL.md` | Installation auf CachyOS, beide Varianten |
| `docs/CONFIGURATION.md` / `CONFIGURATION.md` | Env-Flags mit sicheren Defaults (kanonisch) |
| `docs/HANDBUCH.md` | Bedienung, Runbooks, Troubleshooting, Agenten-Register |
| `CHANGELOG.md` | Versionen und Änderungen (Keep a Changelog, kanonisch im Root) |
| `docs/security/SECURITY_AUDIT.md` | Konsolidierte Security-Architektur + Task-Audits |
| `docs/security/README.md` | Security-Übersicht: aggregierte Findings, Auth-Modell, RBAC |
| `docs/audits/` | Zentrale Audit-Verwaltung: alle Audits chronologisch |
| `docs/audits/2026-09-03-peer-review/` | Senior-Peer-Review 2026-09: H1-H10, C1-C4, B1/B2, W1/W2, S1/S2 (CLOSED) |
| `docs/audits/2026-09-05-security-review-gpt01/` | Security-Audit GPT_01: SEC-01 FIXED v1.36.27; SEC-02 FIXED v1.36.31; SEC-03 FIXED v1.36.28; SEC-10 FIXED v1.36.29; SEC-04 FIXED v1.36.30; übrige OPEN |
| `docs/peer-reviews/` | Peer-Review-Patches: gesammelt, verknüpft, nachvollziehbar |
| `docs/ARENA_TASKS.md` | Task-Tracker (1–12) mit Status, PR, Security, Review |
| `docs/DOCS_SYNC_AUDIT.md` | Docs-Code-Sync-Audit-Report (Task 12) |
| `docs/help/*.help.json` | 3-Ebenen-Hilfe-Systematik |

Weitere Module: `MARKET_UNIVERSE`, `BROKER_ARCHITECTURE`, `BITUNIX`, `PAPER_TRADING`, `PORTFOLIO_ANALYTICS`, `DAILY_WEEKLY_RESEARCH`, `LLM_ROUTING`, `PROVIDER_INTEGRATION`, `FRONTEND_CONTROL_PLANE`, `LIVE_TRADING`.

## Testen & Validieren

```bash
npm test                 # Unit/Integration
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run test:security:next # SEC-03: Dependency-/Framework-Regressionen
npm run test:security:ws   # SEC-04: ws-Supply-Chain- und WS-Laufzeit-Gate
npm run security:live-gate # Next + ws + Auth + Live-Gate (CI-Pflicht)
npm run docs:validate    # Docs-as-Code-Wächter (grün nach Repo-Cleanup 2026-09-05)
./scripts/validate-setup.sh    # 18 Setup-Checks
```

## Lizenz

GNU General Public License v3.0 (GPL-3.0) — siehe [`LICENSE`](LICENSE).

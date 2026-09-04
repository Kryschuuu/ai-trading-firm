# Installation & Konfiguration

> **Status-Header (Task 12):** **Implementiert** (Tasks 1–13) ·
> Dokumentationsstand **2026-09-04** · Code-Version **1.36.17**

Dieses Dokument beschreibt das Setup inkl. **aller Env-Flags mit sicheren
Defaults** (Flag-Tabelle unten). Eine vollständige Schritt-für-Schritt-Anleitung
für CachyOS (Variante A: Solo-Node, Variante B: Split-Node) steht in
[`docs/INSTALL.md`](docs/INSTALL.md). Für Windows 10/11 gibt es den geführten
PowerShell-Installer mit One-Liner, PostgreSQL-, Node-, Ollama-Installation und
Workarounds in [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md).
Diese Datei ist die verbindliche Flag-Referenz — der CI-Job `docs-validate` prüft,
dass jedes dokumentierte Flag tatsächlich im Code existiert.

## Voraussetzungen

- **CachyOS** (Arch-basiert) — das Setup-Skript zielt auf CachyOS/Arch
- **Node.js ≥ 20**, npm
- **PostgreSQL** (lokal oder via `deploy/`-Skripte)
- optional: Ollama (oder ein anderer LLM-Provider) für die Agenten

## Schnellstart (CachyOS)

Ein Befehl, zehn Schritte, idempotent — wiederholbar ohne Datenverlust:

```bash
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm
./scripts/setup-cachyos.sh --variant a          # Variante A: alles auf einem Rechner
# Variante B (Modellserver im LAN):
./scripts/setup-cachyos.sh --variant b --llm-host 192.168.1.50
```

**Die zehn Schritte:** Preflight · Pakete · PostgreSQL-Cluster · Rolle/Datenbank
· `.env` · Abhängigkeiten · Schema · Markt-Universum · Build · Seed +
Short-Selling + 18-Check-Validierung.

**Optionen:**

| Option | Wirkung |
| --- | --- |
| `--variant a\|b` | Pflicht: Solo-Node oder Split-Node |
| `--llm-host HOST` | Variante B: Modellserver-IP |
| `--db-name`, `--db-user`, `--db-host`, `--db-port` | Datenbank-Ziel |
| `--pgdata PFAD` | Datenverzeichnis (Default `/var/lib/postgres/data`) |
| `--api-token TOKEN` / `--no-api-token` | API-Token setzen bzw. weglassen |
| `--no-shorts` | Short-Selling deaktiviert lassen |
| `--sync-markets` | Marktdaten-Warmup direkt ausführen |
| `--skip-build`, `--skip-validate` | Schritte auslassen |
| `--min-pass N` | Validierungs-Schwelle (Default 15 von 18) |
| `--reset-cluster` | Cluster ohne Rückfrage neu initialisieren |
| `--dry-run` | ausführbare Befehle nur anzeigen |
| `--non-interactive`, `-y` | keine interaktiven Fragen |
| `--log-file PFAD` | Log-Ziel (Default `data/setup/setup-<Zeitstempel>.log`) |

Das Skript lässt sich jederzeit erneut ausführen: Es überschreibt `.env` nicht
still (Sicherung als `.env.bak-<Zeitstempel>`), löscht keinen intakten
Cluster und seedet idempotent. Bei einem Fehler nennt die `ERR`-Trap Schritt
und Zeile; das vollständige Log liegt unter `data/setup/`.

## Schnellstart (manuell, andere Distribution)

```bash
cp .env.example .env            # Flags setzen (mind. DATABASE_URL)
npm ci
npx drizzle-kit push            # Schema in die DB schreiben
npm run universe:seed:markets   # 354 Preset-Instrumente (v1.30.0)
npm run universe:seed           # Basis-Universum (NDJSON)
rm -rf .next node_modules/.cache   # Build-Cache löschen (verhindert instanceof-Drift)
npm run build
npm run start                   # http://0.0.0.0:3369
./scripts/validate-setup.sh     # 18 Checks, bestanden ab 15
```

Die `.env`-Datei enthält Zugangsdaten → `chmod 600 .env`.
**Achtung (C1, v1.36.13):** `npm run start` bindet `0.0.0.0` **und** setzt
`NODE_ENV=production`. Ohne konfiguriertes Token startet der Dienst dann gar
nicht mehr (Boot-Guard, `ConfigurationError: AUTH_NOT_CONFIGURED`) — das Setup-
Skript erzeugt deshalb immer ein `FIRM_API_TOKEN`. Details im Abschnitt
[Auth-Modus](#auth-modus-auth_mode-und-die-produktionspflicht-c1-v13613).

## Markt-Universum und Short-Selling (v1.30.0)

`npm run universe:seed:markets` schreibt vier kuratierte Presets
(`src/universe/presets.ts`):

| Asset-Klasse | Anzahl | Venue | `marketType` | `shortAvailable` |
| --- | ---: | --- | --- | --- |
| Aktien | 50 | `ALPACA`, `IBKR` | `spot` | `true` |
| Indizes | 50 | `IBKR` | `cfd` | `true` |
| Rohstoffe | 22 | `IBKR` | `future` | `true` |
| Kryptowährungen | 30 | `BINANCE` | `spot` | `false` (Spot) |

Zusätzlich entsteht je Asset ein `PAPER`-Spiegel — **354 Instrumente**
gesamt. Metriken starten auf `null`; `npm run market:sync` füllt sie.

**Short-Selling ist per Default aktiviert** (`risk_config.allowShort = 1`).
Das ist ein Runtime-Wert, kein Code-Default — abschalten geht im Dashboard
oder per `allowShort = 0`. Unverändert hart im Code bleiben `maxLeverage = 1`,
`requireStopLoss = true`, Kill-Switch und alle `LIMIT_CEILINGS`.
`shortAvailable` ist eine Venue-Aussage; die operative Freigabe ist
ausschließlich `riskLimits.allowShort`.

## Validierung nach dem Setup

```bash
./scripts/validate-setup.sh                        # http://127.0.0.1:3369
./scripts/validate-setup.sh --base-url http://127.0.0.1:3369 --min-pass 18
./scripts/validate-setup.sh --expect-shorts false  # Short-Selling bewusst aus
./scripts/validate-setup.sh --json                 # maschinenlesbar (stdout)
```

18 Checks in fünf Gruppen: Dienst/Schema (V01–V04), Stammdaten (V05–V07),
Markt-Universum (V08–V11), Broker-Adapter und harte Grenzen (V12–V16),
API-Sicherheit (V17–V18). Bestanden ab `--min-pass` (Default 15). Jeder
Fehlcheck gibt eine konkrete Behebungszeile aus. Dokumentierte Ausnahmen und
die Befund-Historie stehen in
[`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md).

## Auth-Modus: `AUTH_MODE` und die Produktionspflicht (C1, v1.36.13)

Schreibende Endpunkte (`POST`/`PUT`) und die Admin-Rolle hängen an einem
expliziten Modus — nicht mehr am bloßen Fehlen eines Tokens:

| Modus | Wirkt | Schreiben ohne Credential |
| --- | --- | --- |
| `token-required` | Tokens konfiguriert, **oder** `NODE_ENV=production`, **oder** explizit gesetzt | nein — 401/403 |
| `local-open` | nur wenn kein Token gesetzt ist und der Modus wirksam wurde: implizit als Dev-Default (`NODE_ENV != production`), in Produktion nur explizit | ja |

Drei Regeln, alle in `src/auth/authMode.ts` (SSoT) geprüft:

1. **Produktion ohne Token startet nicht.** `NODE_ENV=production` (genau das setzt
   `npm run start` / `deploy/ai-trading-firm.service`) und kein
   `FIRM_ADMIN_TOKEN`/`FIRM_API_TOKEN`/`FIRM_VIEWER_TOKEN` ⇒ der Boot-Guard in
   `src/instrumentation.ts` wirft `ConfigurationError`
   (`AUTH_NOT_CONFIGURED`) und der Server bricht ab. `next build` ist ausgenommen
   (`NEXT_PHASE=phase-production-build`) — ein Build ist kein Server.
2. **`AUTH_MODE=local-open` ist ein Opt-in, keine Überraschung.** Ausserhalb der
   Produktion ist es der Dev-Komfort-Default (mit Warnung im Boot-Log). In
   Produktion braucht es den ausdrücklich in `.env` eingetragenen Wert — der
   Betrieb ist dann offen, aber es ist eine dokumentierte Entscheidung, keine
   Unterlassung.
3. **Ein Token sperrt den Offen-Betrieb aus.** Sobald irgendein Token gesetzt
   ist, gilt immer `token-required`; ein gesetztes `AUTH_MODE=local-open` wird
   ignoriert und boot-seitig gemeldet. Ein unbekannter `AUTH_MODE`-Wert ist ein
   Konfigurationsfehler (`AUTH_MODE_INVALID`) und startet den Dienst nicht.

Token erzeugen und eintragen:

```bash
umask 077
printf 'FIRM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

`scripts/setup-cachyos.sh` macht das Schritt 05 automatisch; nur `--no-api-token`
schreibt stattdessen `AUTH_MODE=local-open` in die `.env` — bewusst offen, nicht
versehentlich. Der Modus ist auch im Betrieb sichtbar: `GET /api/auth/me` liefert
`authMode.{mode,requested,reason,production,tokensConfigured}`.

Der Wächter läuft bei `npm run start` und `npm run dev` automatisch vor `next`
und beendet den Prozess mit Exit-Code 1, wenn die Konfiguration nicht startfähig
ist. Vor einem Deploy (oder als Check in der Pipeline) lässt er sich isoliert
aufrufen, ohne einen Server zu starten:

```bash
npm run boot:guard        # Exit 0 = Start erlaubt · Exit 1 = verweigert + Grund
```

Details: [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md), Befund C1 in
[`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Rate-Limit-Identität: `TRUSTED_PROXY_IPS` (C2, v1.36.14)

Rate-Limits brauchen eine stabile Client-Identität. Bis v1.36.13 kam sie aus
`x-forwarded-for` bzw. `x-real-ip` — Headern, die **der Client selbst setzt**.
Ein Angreifer konnte pro Anfrage eine neue IP behaupten und bekam damit pro
Anfrage einen frischen Bucket: Das Limit war nicht umgangen, es war abgeschaltet
(Befund C2, MEDIUM/HIGH). Seit v1.36.14 entscheidet `src/lib/clientIp.ts`
(eine Quelle für Firm-Schreib-Limit **und** Credential-Limit):

| Situation | Bucket-Identität |
| --- | --- |
| kein `TRUSTED_PROXY_IPS`, Socket-Adresse sichtbar | Socket-Remote-Adresse |
| kein `TRUSTED_PROXY_IPS`, Socket-Adresse nicht sichtbar (Next.js-App-Router) | Konstante `local` — alle Clients teilen sich **ein** Limit |
| kein `TRUSTED_PROXY_IPS`, Anfrage kommt von Loopback, `x-verified-ip` gesetzt | Wert aus `x-verified-ip` (Same-Host-Proxy) |
| `TRUSTED_PROXY_IPS` gesetzt, `x-verified-ip` gesetzt | Wert aus `x-verified-ip` |
| `TRUSTED_PROXY_IPS` gesetzt **und** Socket-Peer liegt in der Liste | `x-forwarded-for`, rightmost-untrusted ausgewertet |
| `TRUSTED_PROXY_IPS` gesetzt, Socket-Peer liegt **nicht** in der Liste | Socket-Peer — sämtliche Proxy-Header ignoriert |

`x-real-ip` wird in keinem Fall als Identität benutzt.

**Betrieb hinter nginx/Traefik/Caddy:** `TRUSTED_PROXY_IPS` auf die Adresse des
Proxys setzen und im Proxy einen eigenen, überschreibenden Header konfigurieren:

```bash
printf 'TRUSTED_PROXY_IPS=%s\n' "127.0.0.1" >> .env    # Proxy auf demselben Host
```

```nginx
# nginx — den vom Client mitgebrachten Wert bewusst überschreiben
proxy_set_header X-Verified-IP $remote_addr;
```

Ohne diese Konfiguration bleibt der Dienst **sicher, aber enger**: alle Clients
teilen sich einen Bucket (`local`). Für den Single-User-Betrieb ist das der
Normalfall; für mehrere Nutzer hinter einem Proxy ist `x-verified-ip` Pflicht.

Sichtbar ist die wirksame Entscheidung jederzeit, ohne Secret-Werte:

```bash
curl -s localhost:3369/api/auth/me | jq .rateLimitIdentity
# {"key":"local","ip":null,"source":"local-fallback",
#  "ignoredHeaders":["x-forwarded-for","x-real-ip"], ...}
```

Das Boot-Log nennt dieselbe Policy in einer Zeile (`[client-ip] …`) und warnt
bei unparsebaren Einträgen sowie bei `0.0.0.0/0` (das wäre der C2-Rückfall:
jeder Peer gilt dann als Proxy).

**Brute-Force-Schichten der Credential-API** (alle seit v1.36.14 kombiniert):

1. pro Client-Identität `BROKER_CREDENTIAL_RATE_LIMIT` (Default 5/min),
2. global und **IP-unabhängig** `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT`
   (Default 20/min) — bremst verteiltes Raten,
3. exponentieller Backoff ab dem 3. Fehlversuch (2 s → 4 s → 8 s … max. 15 min,
   Rücksetzung nach 15 min Ruhe oder einem von der Venue akzeptierten
   Credential; justierbar über `BROKER_CREDENTIAL_BACKOFF_BASE_MS` /
   `BROKER_CREDENTIAL_BACKOFF_MAX_MS`, Basis `0` schaltet die Ebene aus).

Der Kill-Switch (`POST /api/live/kill`) und Gate-Transitionen nutzen weiterhin
ausschließlich Ebene 1 — ein Credential-Flood darf die Sicherheitsaktion nie
blockieren.

Details: Befund C2 in
[`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md) und
[`audit-remediation/C2-forwarded-ip.md`](audit-remediation/C2-forwarded-ip.md).

## Env-Flag-Referenz (sichere Defaults)

Konvention: Werte werden bei ungültiger Eingabe auf sichere Defaults geklemmt
(`envInt`). Secrets landen nie im Frontend, nie in Logs, nie im Klartext.

### Datenbank & Firma

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | *(Pflicht)* | `postgresql://user:pass@host:5432/db` |
| `STARTING_EQUITY` | `10000` | Startkapital des Paper-Depots |
| `TICK_INTERVAL_MS` | je nach Config | Mikro-Zyklus-Takt (Executor) |
| `ANALYST_INTERVAL_MIN` | je nach Config | Analysten-Rhythmus |
| `MACRO_CYCLE_INTERVAL_MIN` | je nach Config | Makro-Zyklus-Takt |
| `SCHEDULER_ENABLED` | — | Scheduler an/aus |
| `DAILY_LOSS_LIMIT` | je nach Config | Tages-Verlustlimit (harte Grenze) |
| `CYCLE_STEP_RETRY` | je nach Config | Retry-Anzahl pro Zyklus-Schritt |

### LLM-Provider

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `LLM_PROVIDER` | `ollama` | `ollama` · `openai` · `gemini` · `anthropic` |
| `LLM_BASE_URL` | abhängig | Basis-URL (OpenAI-kompatibel) |
| `LLM_API_KEY` | *(leer)* | API-Key für Cloud-Provider |
| `LLM_MODEL` | je Provider | Modellname |
| `LLM_MAX_TOKENS` | `512` | Max. Ausgabetokens je Aufruf |
| `LLM_TIMEOUT_MS` | `180000` | Zeitlimit je Modellantwort |
| `LLM_MAX_ATTEMPTS` | `2` | Retries (1–5) |
| `LLM_CONTEXT_SIZE` | je Config | Kontextfenster |
| `LLM_FALLBACK_PROVIDERS` | *(leer)* | Fallback-Kette, kommagetrennt |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama-Server |
| `OLLAMA_NUM_CTX` | `4096` | Kontextfenster (Variante A) |
| `OLLAMA_KEEP_ALIVE` | — | Modell-Keep-Alive |
| `OLLAMA_TIMEOUT_MS` | — | Ollama-Zeitlimit |
| `GEMINI_API_KEY` | *(leer)* | Gemini-Key |
| `GEMINI_BASE_URL` | — | Gemini-Basis-URL |
| `GEMINI_MODEL` | — | Gemini-Modell |
| `GEMINI_CONTEXT_SIZE` | — | Gemini-Kontext |
| `ANTHROPIC_API_KEY` | *(leer)* | Claude-Key |
| `ANTHROPIC_BASE_URL` | — | Anthropic-Basis-URL |
| `ANTHROPIC_MODEL` | — | Claude-Modell |
| `ANTHROPIC_CONTEXT_SIZE` | — | Anthropic-Kontext |
| `MODEL_CEO`, `MODEL_RESEARCH`, `MODEL_TECHNICAL`, `MODEL_NEWS`, `MODEL_MACRO`, `MODEL_RISK`, `MODEL_BACKTEST`, `MODEL_APPROVER`, `MODEL_DILIGENCE`, `MODEL_EXECUTOR`, `MODEL_SCOUT`, `MODEL_SWING` | je Agent | Modell je Agenten-Rolle |
| `MODEL_ROUTING_OLLAMA_DEFAULT` | — | Default-Modellklasse beim Router |

### Menschliche Freigabe

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `REQUIRE_HUMAN_APPROVAL` | `true` | Nur exakt `"false"` hebt die Human-Gate-Bedingung auf |

### Paper-Trading / Marktdaten

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `PAPER_MODE` | `broker-market-data` | Erlaubt: `synthetic` / `broker-market-data` / `broker-paper-api`. Die Kurzformen `A`/`B`/`C` werden **nicht** akzeptiert. |
| `PAPER_MODE_C_ENABLED` | `false` | Schaltet Modus C frei (erfordert Venue-Capability) |
| `PAPER_SIM_SEED` | deterministisch | Seed des Fill-Simulators |
| `PAPER_SIM_LATENCY_MS` | — | simulierte Latenz |
| `PAPER_SIM_TAKER_FEE` / `PAPER_SIM_MAKER_FEE` | — | simulierte Gebühren |
| `PAPER_SIM_PARTIAL_FILL` | — | Partial Fills modellieren |
| `PAPER_SIM_PARTIAL_MAX_FRACTION` | — | Obergrenze Partial Fill |
| `PAPER_SIM_SLIPPAGE_BPS_BASE` / `..._JITTER_BPS` / `..._PER_PARTICIPATION` | — | Slippage-Modell |
| `PAPER_SIM_VOLUME_FALLBACK` | — | Volumen-Fallback |
| `PAPER_SIM_SYNTHETIC_SPREAD_BPS` | `2` | Bid/Ask-Spread für ticker-basierte Paper-Fills (z. B. Bitunix Modus B) |
| `PAPER_STALE_AFTER_MS` | — | Staleness-Schwelle |
| `PAPER_STATIC_FALLBACK` | `false` | statisches Preisbuch nur explizit |
| `PAPER_ALLOW_SYNTHETIC_FALLBACK` | — | Synthetic als Fallback erlauben |
| `PAPER_BINANCE_BASE_URL` / `PAPER_YAHOO_BASE_URL` | — | Feed-Basis-URLs |
| `PAPER_FEED_TIMEOUT_MS` / `PAPER_FEED_RETRY_MAX` | — | Feed-Zeitlimit/Retries |
| `PAPER_FEED_ALLOWED_HOSTS` | — | SSRF-Allowlist der Feeds |
| `PAPER_HISTORY_DIR` | — | Ablage historischer OHLCV |
| `PAPER_BROKER_API_VENUE` | — | Venue für Modus C |
| `PAPER_SYNTHETIC_BASE_PRICE` | — | Basispreis Synthetic |
| `PAPER_ANOMALY_MAX_JUMP_PCT` | — | Anomalie-Schwelle |

### Bitunix-Adapter (7. Venue)

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `BITUNIX_ENABLED` | `false` | Venue-Adapter freischalten |
| `BITUNIX_LIVE_ENABLED` | `false` | Live-Erlaubnis (wirkt nur mit Live-Gate) |
| `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` | *(leer)* | Venue-Zugang (Secret Store) |
| `BITUNIX_BASE_URL` / `BITUNIX_WS_URL` | — | Venue-Endpunkte |
| `BITUNIX_ALLOWED_HOSTS` | — | SSRF-Allowlist |
| `BITUNIX_ALLOW_INSECURE_HTTP` | `false` | nur Testumgebung |
| `BITUNIX_RATE_LIMIT` / `BITUNIX_RETRY_MAX` / `BITUNIX_TIMEOUT_MS` | — | HTTP-Schutz |

### Live-Trading-Gate (Task 11) — alle Defaults SICHER (fail-closed)

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `LIVE_TRADING_ENABLED` | `false` | Plattform-Live-Flag (allein wirkungslos) |
| `LIVE_GATE_DATA_DIR` | `data/live-gate` | Ablage der State-/Audit-Files |
| `LIVE_GATE_COOLDOWN_MS` | `86400000` (24 h) | Cooldown LIVE_PENDING → HUMAN_APPROVED |
| `LIVE_GATE_FOUR_EYES` | `false` | 4-Augen-Modus |
| `LIVE_GATE_PAPER_MIN_ORDERS` | `50` | Mindestzahl fehlerfreier Paper-Orders |
| `LIVE_GATE_SUITE_MAX_AGE_MS` | `604800000` (7 d) | Max-Alter des Security-Suite-Stamps |

### Secrets & Broker-Control-Plane

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `SECRET_STORE_KEY` | *(leer)* | Verschlüsselungsschlüssel (nicht loggen) |
| `SECRET_STORE_KMS_ENDPOINT` | — | optionaler KMS-Endpunkt |
| `BROKER_SECRET_BACKEND` | — | Backend-Typ des Secret Store |
| `BROKER_SECRET_DIR` | — | Ablage (falls File-Backend) |
| `CONTROL_STATE_BACKEND` | `db` | Persistenz des Control-Plane-Zustands (`venue_control_state`, C4/v1.36.16); `memory` nur Tests — ohne erreichbare Tabelle Fallback memory + Log-Warnung |
| `BROKER_CREDENTIAL_RATE_LIMIT` | `5` | Rate-Limit auf Credential-API pro Client-Identität (0 = aus) |
| `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT` | `20` | globales, IP-unabhängiges Credential-Limit (0 = aus; betrifft nie den Kill-Switch) |
| `BROKER_CREDENTIAL_BACKOFF_BASE_MS` | `2000` | Startwert des exponentiellen Backoffs ab dem 3. Credential-Fehlversuch (0 = Backoff aus) |
| `BROKER_CREDENTIAL_BACKOFF_MAX_MS` | `900000` (15 min) | Deckel einer Backoff-Sperre |
| `BROKER_HEALTHCHECK_REMOTE` | `false` | remote Health-Checks aktivieren |

### RBAC / Firm-API

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `FIRM_ADMIN_TOKEN` | *(leer)* | Admin-Token (RBAC) |
| `FIRM_API_TOKEN` | *(leer)* | API-Token für alle `POST`/`PUT`-Routen; `scripts/setup-cachyos.sh` erzeugt eines |
| `FIRM_VIEWER_TOKEN` | *(leer)* | Viewer-Token |
| `AUTH_MODE` | *(automatisch)* | `local-open` \| `token-required`; in Produktion ohne Token verweigert der Boot-Guard den Start (`AUTH_NOT_CONFIGURED`) |
| `FIRM_RATE_LIMIT` | `60` | Rate-Limit auf Firm-API (Schreib-Requests / 60 s, 0 = aus) |
| `TRUSTED_PROXY_IPS` | *(leer)* | CIDR-Liste vertrauenswürdiger Reverse Proxys; erst damit zählen `x-verified-ip` (immer) bzw. `x-forwarded-for` (nur bei verifiziertem Socket-Peer). Leer ⇒ Header werden ignoriert, Bucket = Socket-Adresse bzw. `local` |

### Modell-Routing (Task 09)

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `ROUTING_POLICY_PATH` | — | Pfad zur Routing-Policy |
| `ROUTING_HEALTH_POLL_MS` | — | Provider-Health-Poll |
| `ROUTING_HEALTH_TIMEOUT_MS` | — | Health-Timeout |
| `ROUTING_BUDGET_OLLAMA_TOKENS` | — | Token-Budget Ollama |
| `ROUTING_BUDGET_OPENAI_TOKENS` | — | Token-Budget OpenAI |
| `ROUTING_BUDGET_GEMINI_TOKENS` | — | Token-Budget Gemini |
| `ROUTING_BUDGET_ANTHROPIC_TOKENS` | — | Token-Budget Anthropic |

### Storage / Artefakte / Audit

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `UNIVERSE_DATA_DIR` | — | Ablage der Instrument-Registry (NDJSON) |
| `UNIVERSE_POLICY_FILE` | — | Pfad zur Universe-Policy |
| `SCANNER_CONFIG_FILE` | — | Pfad zur Scanner-Konfiguration |
| `SCANNER_ARTIFACTS_DIR` | — | Scanner-Tagesartefakte |
| `CYCLE_ARTIFACTS_DIR` | — | Zyklus-Artefakte |
| `CYCLE_AUDIT_DB` / `UNIVERSE_AUDIT_DB` / `PORTFOLIO_AUDIT_DB` | — | Audit-DB-Pfade |
| `PORTFOLIO_AUDIT` | — | Portfolio-Audit an/aus |
| `PORTFOLIO_AUDIT_DIR` | — | Portfolio-Audit-Ablage |

### Betrieb

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `MICRO_HEALTH_PORT` | — | Health-Port des Micro-Executors |

## Migration & Deploy

Empfohlene Deploy-Kette: `git pull` → `rm -rf .next node_modules/.cache` →
`npm ci` → `npx drizzle-kit push` → `npm run universe:seed:markets` →
`npm run build` → `sudo systemctl restart ai-trading-firm` →
`./scripts/validate-setup.sh`. **Build-Cache vor jedem Update löschen**
(verhindert `instanceof`-Drift bei Next.js-Modul-Recompilierung; v1.36.1
verwendet Duck-Type statt `instanceof` — das Cache-Löschen beugt dem Problem
auch für zukünftige Adapter-Checks vor).
Migrationshinweise stehen im [`docs/CHANGELOG.md`](docs/CHANGELOG.md);
Setup-Befunde und ihre Behebung in
[`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md), PostgreSQL-Soforthilfe in
[`docs/SETUP_PG_TROUBLESHOOTING.md`](docs/SETUP_PG_TROUBLESHOOTING.md).

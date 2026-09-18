# Installation & Konfiguration

> **Status-Header (Task 12):** **Implementiert** (Tasks 1–13) ·
> Dokumentationsstand **2026-09-18** · Code-Version **1.40.0**

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

Schreibende Endpunkte (`POST`/`PUT`), die Admin-Rolle und die sensitiven
Dashboard-Reads aus SEC-02 hängen an einem expliziten Modus — nicht mehr am
bloßen Fehlen eines Tokens:

| Modus | Wirkt | Schreiben ohne Credential |
| --- | --- | --- |
| `token-required` | Tokens konfiguriert, **oder** `NODE_ENV=production`, **oder** explizit gesetzt | nein — 401/403 |
| `local-open` | nur wenn kein Token gesetzt ist und der Modus wirksam wurde: implizit als Dev-Default (`NODE_ENV != production`), in Produktion nur explizit | ja |

Vier Regeln, alle in `src/auth/authMode.ts` (SSoT) geprüft:

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

4. **Session-Signierung braucht ein unabhängiges Secret.** Im Token-Betrieb
   verlangt Produktion zusätzlich `FIRM_SESSION_SECRET`; fehlt der Schlüssel oder
   ist er ungültig, verweigert der Boot-Guard den Start. Der Login-Pfad bleibt
   unabhängig vom Boot-Guard geschlossen (HTTP 503).
5. **Sensible Reads verlangen `firm.read`.** `/api/firm`, `/api/firm/log`,
   `/api/firm/report`, `/api/firm/rules`, `/api/providers` und `/api/routing`
   akzeptieren im Token-Betrieb ausschließlich einen Viewer-, Operator- oder
   Admin-Actor (Header oder gültige Browser-Session). Sie antworten mit
   `Cache-Control: private, no-store`; die Schreib-Rate-Limits bleiben davon
   unabhängig unverändert.

Token und unabhängigen Session-Schlüssel bei der Ersteinrichtung erzeugen:

```bash
umask 077
printf 'FIRM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'FIRM_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
chmod 600 .env
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
NODE_ENV=production npm run boot:guard  # Exit 0 = Start erlaubt · Exit 1 = verweigert + Grund
```

Details: [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md), Befund C1 in
[`docs/AUDIT_REMEDIATION_2026-09.md`](docs/AUDIT_REMEDIATION_2026-09.md).

## Rule-Governance (SEC-06, v1.36.34)

Für echte Multi-Role-Trennung müssen `FIRM_ADMIN_TOKEN` und `FIRM_API_TOKEN`
verschieden sein. Operatoren besitzen `strategy.rules.write` (Drafts
anlegen/versionieren, pausieren, ablehnen); Admins zusätzlich
`strategy.rules.activate`, `strategy.rules.rollback` und `strategy.rules.archive`.
Der manuelle Makro-Start verlangt ebenfalls `strategy.rules.activate`.

**Kompatibilität:** Ohne konfigurierten Admin-Token ist der Operator weiterhin
Single-Admin mit effektiven Admin-Rechten. `local-open` ist ein lokaler
Single-User-Modus, keine Rollen-Isolation. Der interne Makro-Scheduler bleibt
an die bestehende `REQUIRE_HUMAN_APPROVAL`-Policy gebunden; für ausschließlich
manuelle Freigaben muss dieses Flag `true` sein. Keine neue Variable erforderlich.

[API-Vertrag und Upgrade](docs/security/README.md#rule-governance-sec-06).

## Session-Sicherheit (SEC-01, v1.36.27)

- `FIRM_SESSION_SECRET`: ausschließlich serverseitig, unabhängig von allen
  `FIRM_ADMIN_TOKEN` / `FIRM_API_TOKEN` / `FIRM_VIEWER_TOKEN`. Mindestens 32 Zeichen
  nach Entfernen äußerer Leerzeichen; empfohlen **32 Zufallsbytes** als Hex
  (`openssl rand -hex 32`). Länge allein garantiert keine Entropie. Keine Tokens,
  Token-Hashes oder andere aus Login-Credentials berechenbare Werte verwenden.
- **Kein Fallback in irgendeiner Umgebung.** Ohne gültigen Schlüssel stellt
  `/api/auth/login` im Token-Betrieb keine Cookies aus (HTTP 503,
  `SESSION_SECRET_REQUIRED` bzw. `SESSION_SECRET_INVALID`). In Produktion scheitert
  zusätzlich der Start. Dev-Header-Authentifizierung funktioniert ohne Sessions;
  echtes `local-open` stellt auch mit konfiguriertem Schlüssel keine Sessions aus.
- `firm_session`: HttpOnly, Secure, SameSite=Strict und **seit v1.39.0 ohne
  `Max-Age`** (Browser-Session-Cookie, endet mit dem Schließen des Fensters);
  `firm_csrf`: session-gebundenes Double-Submit. Autorisiert wird über `exp`
  (Idle-Frist, Default **900 s**) und `maxExp` (absolute Grenze, Default
  **86 400 s**) — nicht über das Cookie-Alter. Produktion erfordert HTTPS für
  den Browser-Login. Header-basierte CLI-/API-Clients bleiben unverändert.
- **Sitzungsdauer und Verlängerung (v1.39.0, S1):** Der Client erneuert die
  Idle-Frist über `POST /api/auth/refresh` (Double-Submit-Header
  `x-csrf-token` Pflicht, `iat`/`maxExp` bleiben), `GET /api/auth/status`
  liefert secret-frei Konfigurations- und Sitzungsdiagnose ins Dashboard.
  Details und die abgewogenen Sicherheitseinbußen:
  [Sitzungsdauer und Verlängerung](#sitzungsdauer-und-verl%C3%A4ngerung-v1390-s1).
- Schema v2 enthält keine Rolle/Elevation/Permissions als Snapshot. Der Server
  prüft einen credential-gebundenen, keyed Konfigurations-Fingerprint (`authEpoch`)
  und leitet Rolle, Single-Admin-Elevation, Audit-ID und Permissions jedes Mal aus
  der aktuellen Auth-Konfiguration ab. Token-Rotation, Entfernen/Hinzufügen eines
  Tokens oder Key-Rotation machen vorhandene Sessions ungültig. Die Konfiguration
  muss dazu in **allen** laufenden Instanzen aktualisiert werden (Neustart).
- **Sofortige Session-Revocation & Logout (SEC-08):** Über `POST /api/auth/logout`
  können Browser-Sessions jederzeit serverseitig invalidiert werden
  (`state.revokedSessions`, seit v1.39.0 bis `maxExp` — eine Verlängerung macht
  einen Widerruf nicht zunichte). Ein Replay alter oder gestohlener
  Cookies wird sofort mit 401/403 abgelehnt.
- **Globale Notfall-Revocation:** Admins (`broker.credentials`) können via
  `POST /api/auth/logout` mit Body `{"all": true}` alle zuvor ausgestellten
  Sessions global invalidieren (`state.sessionsRevokedBefore`), ohne Prozesse neu
  starten zu müssen. Abgelaufene Revocation-Einträge werden automatisch bereinigt
  (`pruneRevokedSessions`). Der Cutoff ist streng monoton und neue Sessions werden
  strikt nach ihm datiert: Ein Login in derselben Millisekunde wie der Cut bleibt
  gültig, ein rückwärts springender Systemtakt hebt keinen Cut auf (kein Fail-Open).
  Revocation-Status lebt im Prozess-RAM — nach einem Neustart sind Einzel-Widerrufe
  und der Cutoff weg; für einen harten Schnitt zusätzlich Tokens/`FIRM_SESSION_SECRET`
  rotieren (invalidiert alle Sessions über `authEpoch`).

**Upgrade:** Vor Deploy einen neuen unabhängigen Schlüssel in `.env` oder dem
serverseitigen Secret-Management setzen. Beide Installer ergänzen nur fehlende
Session-Schlüssel, sie überschreiben keine vorhandenen (auch keine ungültigen)
Werte. Bei vorhandenem leeren/ungültigem Eintrag diesen ausdrücklich korrigieren,
nicht einen zweiten Eintrag anhängen. `.env` nur für den Dienstbenutzer lesbar
halten. `NODE_ENV=production npm run boot:guard` prüfen, dann alle Instanzen mit
v1.36.27 neu starten; gemischter Alt-/Neubetrieb ist nicht vollständig abgesichert.
**Alle v1-Cookies sind ungültig und erfordern erneuten Login.**

Der vorgeschaltete Wächter liest `.env`; bereits gesetzte Prozess-Variablen
(z. B. aus systemd/Secret-Management) haben Vorrang, auch bei leerem Wert.
`next build` benötigt keine produktiven Auth-Secrets.

## Sitzungsdauer und Verlängerung (v1.39.0, S1)

Die Browser-Sitzung ist eine **Browser-Session-Cookie**: Sie endet mit dem
Schließen des Fensters und läuft nicht mehr nach 15 Minuten mitten in der
Arbeit ab. Autorisiert wird weiterhin über zwei Fristen im signierten Payload
(`src/lib/authSession.ts`, `SESSION_PAYLOAD_VERSION = 3`):

```text
exp     Idle-Frist — wird durch Arbeiten verlängert (Client taktet /api/auth/refresh)
maxExp  absolute Grenze der Anmeldung — wird durch Verlängerung nie verschoben
```

| Flag | Default | Bereich | Wirkung |
| --- | --- | --- | --- |
| `FIRM_SESSION_IDLE_TTL_S` | `900` | 60 … 86 400 s | Frist ohne Lebenszeichen; der Client meldet sich in deren Hälfte und heilt sie über die Nachfrist. `0` oder Müll ⇒ Default, **nie** „unbegrenzt“ |
| `FIRM_SESSION_MAX_LIFE_S` | `86400` | 600 s … 7 d, ≥ Idle | Harte Decke ab `iat`. Danach `401 SESSION_MAX_LIFE_REACHED` — der Token muss neu eingetragen werden |
| `FIRM_SESSION_GRACE_S` | `900` | 0 … 86 400 s | Nachfrist, in der `POST /api/auth/refresh` eine abgelaufene Idle-Frist heilt (Notebook-Schlaf, gesperrter Screen, gedrosseltes Tab). `0` = aus; gilt **nur** für `refresh` |
| `SESSION_RENEW_WINDOW_S` | `min(300, Idle/2)` | 10 s … Idle/2 | Unterhalb dieser Restzeit stellt `refresh` tatsächlich neue Cookies aus |

`SESSION_TTL_S` bleibt der Name der Default-Idle-Frist (900 s) und wird von
`FIRM_SESSION_IDLE_TTL_S` übersteuert. Session-Schema v2 wird nicht mehr
akzeptiert — nach dem Deploy ist einmalig Neu-Anmeldung nötig.

Die vier Endpunkte: `POST /api/auth/login` (Token im Body, nie als Browser-Header),
`POST /api/auth/logout` (löscht beide Cookies **und** registriert die Session bis
`maxExp`), `POST /api/auth/refresh` (Verlängerung gegen `x-csrf-token`) und
`GET /api/auth/status` (öffentliche Diagnose: sind Firm-Tokens eingetragen,
welche Rolle trägt die Sitzung, wie lange noch — secret-frei, `no-store`).

### Was das sicherheitstechnisch kostet — und was dagegen hält

1. **Längere Missbrauchsfrist, wenn das Cookie selbst abfließt.** Wer ein
   HttpOnly-Cookie stiehlt, kann die Sitzung aktiv halten, ohne den Token zu
   kennen. Dagegen: `maxExp` (Default 24 h), `SameSite=Strict` + `Secure`,
   `POST /api/auth/logout` mit `{"all": true}` als Notfallschnitt sowie
   Rotation von `FIRM_SESSION_SECRET` oder des Tokens — beides entwertet über
   `authEpoch` alle Sitzungen sofort.
2. **Verlängerung ist an keinen beliebigen Token gebunden.** Der CSRF-Header
   muss den Wert des `firm_csrf`-Cookies zurückgeben; die Legacy-Regel
   „Header == API-Token“ akzeptiert `refresh` bewusst nicht. Ein Cookie-Leak
   ohne Lesezugriff auf die Cookies verlängert damit nichts.
3. **Die Nachfrist öffnet keine Tür.** `readSession` ignoriert
   `FIRM_SESSION_GRACE_S`; jede Guard-Route antwortet `401`, sobald `exp` um
   ist. Nachgewiesen in `tests/sessionRenewal.test.ts` (gleiche
   Konfiguration: `renewSession` ⇒ 200, `readSession` ⇒ `null`).
4. **`iat` rutscht nicht.** Verlängern verschiebt nur `exp`. Der globale
   Revocation-Schnitt (SEC-08) bleibt wirksam: Ein Cut tötet alle vor ihm
   ausgestellten Sitzungen — auch verlängerte.
5. **Revocation bleibt RAM** (unverändert seit SEC-08): Nach einem Neustart
   sind Einzel-Widerrufe und der Cut weg. Harte Trennung erreicht die Rotation
   von `FIRM_SESSION_SECRET`.
6. **Sitzungs-Wiederherstellung des Browsers** kann das Cookie rehydrieren.
   Die Rechte hängen am Payload: ist `exp` um und die Nachfrist vorbei, nützt
   das beste Cookie nichts.

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
| `PAPER_MAKER_FEE_PCT` | `0.04` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Maker-Gebühr in **Prozent** (0.04 = 0,04 %). Überschreibt `PAPER_SIM_MAKER_FEE`, wenn gesetzt. Bounds [0, 10], Clamp mit Log-Warnung. |
| `PAPER_TAKER_FEE_PCT` | `0.1` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Taker-Gebühr in **Prozent** (Market-Fills). Überschreibt `PAPER_SIM_TAKER_FEE`, wenn gesetzt. Bounds [0, 10]. |
| `PAPER_SLIPPAGE_BPS` | `1` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Basis-Slippage in Basispunkten. Überschreibt `PAPER_SIM_SLIPPAGE_BPS_BASE`, wenn gesetzt. Bounds [0, 10000]. |
| `PAPER_SPREAD_FALLBACK_BPS` | `2` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Spread-Fallback in Basispunkten (ticker-basierte Snapshots). Überschreibt `PAPER_SIM_SYNTHETIC_SPREAD_BPS`, wenn gesetzt. Bounds [0, 10000]. |
| `PAPER_FUNDING_INTERVAL_HOURS` | `8` | GAP-02 (v1.42.0): Funding-Accrual-Intervall in Stunden (8 = Marken 00/08/16 UTC). Bounds [1, 24], Clamp mit Log-Warnung. |
| `PAPER_FUNDING_RATE_PCT_PER_8H` | `0` | GAP-02 (v1.42.0): statische Funding-Rate je 8h in **Prozent** (0.01 = 0,01 %/8h; LONG zahlt bei positiver Rate). `0` = Funding-Simulation aus (neutral). Bounds [−1, 1]. Details: docs/PAPER_TRADING.md §3.2. |
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

### Trade-Journal (GAP-03, v1.43.0)

Alle Flags sind neu und optional — **ohne jede Konfiguration läuft das
System exakt wie vorher** (Default `off`: nur Auswertung, keine
Auswirkung auf den Entscheidungspfad). Details + Sicherheitsbegründung:
`docs/HANDBUCH.md` §13.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `JOURNAL_FEEDBACK_MODE` | `off` | Feedback-Modus der Gewichts-Rückführung: `off` (nur Auswertung — **Default, sicher**), `monitor` (Vorschläge als `audit_log` + Zyklus-Artefakt, Entscheidungspfad unverändert), `enforce` (Gewichte wirken im Approver-/Portfolio-Prompt der Engine + Persistenz in `journal_agent_weights`). Unbekannter Wert → fail-closed auf `off` (Log-Warnung). |
| `JOURNAL_MIN_TRADES` | `20` | Mindest-Stichprobe (geschlossene, attributierte Trades je Agent×Regime), ab der Kennzahlen/Gewichte wirksam werden. Darunter `insufficient-sample` — **niemals als Faktor**. Bounds [5, 200], Clamp mit Log-Warnung. |
| `JOURNAL_WEIGHT_MIN` | `0.5` | Untere Bound der Agenten-Gewichte. Bounds des Wertes selbst: [0.1, 1.0] (darunter wäre ein Agent praktisch stummschaltet — kein zulässiges Journal-Instrument). |
| `JOURNAL_WEIGHT_MAX` | `1.5` | Obere Bound der Agenten-Gewichte. Bounds des Wertes selbst: [1.0, 3.0]. |
| `JOURNAL_MAX_WEIGHT_DELTA` | `0.1` | Maximale Gewichtsänderung **je Zyklus** — selbst extreme Serien bewegen Gewichte nur schrittweise (Multi-Zyklus-Annäherung, nie Sprung). Bounds [0.01, 0.5]. |
| `JOURNAL_CANDLES_TIMEFRAME` | `1h` | Kerzen-Intervall für die MAE/MFE-Berechnung (Allowlist = unterstützte Timeframes; ungültig → `1h` + Log-Warnung). Kerzenlücken ⇒ Metriken null + `CANDLE_GAP`-Flag (nie geschätzt). |

Hinweise:

- **Schema:** zwei neue Tabellen `trade_journal` + `journal_agent_weights`
  (append-only Migration `drizzle/2026-09-18_trade_journal.sql` oder
  `npx drizzle-kit push`). Bestehende Tabellen bleiben unverändert.
- **Read-API:** `GET /api/firm/journal` (Berechtigung `firm.read`).
- **Zyklus-Artefakte:** `journal-summary.json` + `journal-feedback.json`
  im Tages-Artefakt-Verzeichnis.
- **Audits:** `JOURNAL_WEIGHT_PROPOSED` (monitor), `JOURNAL_WEIGHT_APPLIED`
  (enforce, Label `journal-weight:AGENT:REGIME:x→y`), `JOURNAL_WRITE_FAILED`
  (CRITICAL, Schreibfehler — der Handelspfad bleibt davon unberührt).

### Exit-Management (GAP-05, v1.44.0)

Trailing-Stop, Time-Stop und OCO-Exklusivität — alles serverseitig im
Monitor-Tick (`src/lib/monitor.ts`), unabhängig von LLM-Turns. Alle Flags
sind per Default **aus**: ohne Konfiguration prüft der Monitor weiterhin nur
Stop-Loss/Take-Profit — bestehende Installationen ändern ihr Verhalten nicht.
Der Trailing-Zustand (bewaffnet/Stop-Level) liegt persistiert in
`positions.trailing_armed`/`positions.trailing_stop` (append-only Migration
`drizzle/2026-09-18_exit_management.sql` oder `npx drizzle-kit push`) — ein
Prozess-Neustart verliert keinen erreichten Stop. Doku:
`docs/PAPER_TRADING.md` (Abschnitt „Exit-Management“).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `RISK_TRAILING_ENABLED` | `false` | Trailing-Stop insgesamt. Bewaffnet ab `RISK_TRAILING_ACTIVATION_PCT` Gewinn: der Monitor hebt den Stop mit dem Kurs (LONG: nur nach oben, SHORT: nur nach unten — ein Ratchet, der **nie** automatisch verengt). Trigger → Close mit `exitReason = TRAILING_STOP`. |
| `RISK_TRAILING_ACTIVATION_PCT` | `1.0` | Gewinn in Prozent (vom Einstiegskurs, seitenrichtig für LONG/SHORT), ab dem der Trailing-Stop bewaffnet wird. Bounds [0.1, 20], Clamp mit sicherem Default. |
| `RISK_TRAILING_RETURN_PCT` | `0.5` | Erlaubter Rückgabeweg in Prozent: Stop = Kurs − Rückgabeweg (LONG; SHORT gespiegelt). Bounds [0.1, 10]. |
| `RISK_TIME_STOP_HOURS` | `0` | Maximale Haltedauer einer Position in Stunden → Close mit `exitReason = TIME_STOP`. `0` = aus (Default). Bounds [0, 720] (= 24 · 30). |

Zusätzlich hart verdrahtet (kein Flag, keine Konfiguration nötig):

- **OCO-Exklusivität:** SL/TP/Trailing/Time-Stop sind komplementäre
  Bedingungen EINER Position. Der Exit ist ein bedingtes
  `UPDATE positions … WHERE status = 'OPEN'` (atomarer DB-Claim) — zwei
  parallele Ticks oder zwei Instanzen können dieselbe Position nie doppelt
  schließen; der zweite sieht sie als CLOSED und macht einen sauberen no-op
  (kein Doppel-Fill, kein Doppel-Audit, kein Fehler).
- **Audit je Exit:** jeder Exit schreibt genau einen `audit_log`-Eintrag mit
  maschinenlesbarem Grund (`detail.code = "exit:SYMBOL:grund"`, Event
  `STOP_LOSS_HIT`/`TAKE_PROFIT_HIT`/`TRAILING_STOP_HIT`/`TIME_STOP_HIT`).
- **Priorität bei Gleichzeitigkeit:** SL vor TP (konservativ, wie bisher),
  preisbasierte Exits vor dem Time-Stop.

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
| `BITUNIX_TICKER_SYMBOLS_PER_REQUEST` | `50` | Chunk-Größe für `GET /tickers?symbols=…` (~1 KB, Gateway-Limit >6 KB). Fix v1.40.0 gegen 754× `ticker/SCHEMA_MISMATCH` (vorher 1× >6 KB-URL). Teilausfall eines Chunks toleriert, Totalausfall wirft ersten Fehler. |

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
| `AUDIT_SPOOL_DIR` | `data/audit-spool` | Persistentes Fallback-Verzeichnis für Audits, die nicht in `audit_log` geschrieben werden konnten (S1/v1.36.18; at-least-once, Nachzug automatisch) |
| `AUDIT_RETRY_MAX` | `2` | Zusätzliche Versuche je Sicherheits-Audit (0 = kein Retry) |
| `AUDIT_RETRY_BASE_MS` | `50` | Basis des exponentiellen Backoffs zwischen Audit-Versuchen |
| `AUDIT_DB_COOLDOWN_MS` | `2000` | Fenster nach einem Audit-Schreibfehler, in dem Retries übersprungen werden (kein Retry-Sturm im Handelspfad) |
| `CONTROL_STATE_BACKEND` | `db` | Persistenz des Control-Plane-Zustands (`venue_control_state`, C4/v1.36.16); `memory` nur Tests — ohne erreichbare Tabelle Fallback memory + Log-Warnung |
| `BROKER_CREDENTIAL_RATE_LIMIT` | `5` | Rate-Limit auf Credential-API pro Client-Identität (0 = aus) |
| `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT` | `20` | globales, IP-unabhängiges Credential-Limit (0 = aus; betrifft nie den Kill-Switch) |
| `BROKER_CREDENTIAL_BACKOFF_BASE_MS` | `2000` | Startwert des exponentiellen Backoffs ab dem 3. Credential-Fehlversuch (0 = Backoff aus) |
| `BROKER_CREDENTIAL_BACKOFF_MAX_MS` | `900000` (15 min) | Deckel einer Backoff-Sperre |
| `BROKER_ALLOW_ENV_FALLBACK` | `false` | **SEC-07 (v1.36.32):** Erlaubt Env-Fallback fuer Broker-Credentials (`BITUNIX_API_KEY` etc.) nur wenn `true` UND `NODE_ENV!=production`. In Produktion immer aus — fehlender Datensatz = null, Store-Fehler = HARD FAIL. |
| `BROKER_HEALTHCHECK_REMOTE` | `false` | remote Health-Checks aktivieren |

### RBAC / Firm-API

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `FIRM_ADMIN_TOKEN` | *(leer)* | Admin-Token (RBAC) |
| `FIRM_API_TOKEN` | *(leer)* | Operator-Credential für `POST`/`PUT` und sensible Dashboard-Reads (`firm.read`); `scripts/setup-cachyos.sh` erzeugt eines |
| `FIRM_VIEWER_TOKEN` | *(leer)* | Viewer-Credential für sensible Dashboard-Reads (`firm.read`), ohne Schreibrechte |
| `FIRM_SESSION_SECRET` | *(leer; kein Fallback)* | Unabhängiger zufälliger Session-Signierschlüssel, mindestens 32 Zeichen; Pflicht für Sessions und Produktion mit Tokens (SEC-01) |
| `FIRM_SESSION_IDLE_TTL_S` | `900` | Idle-Frist der Browser-Sitzung in Sekunden (60 … 86 400), `0` ⇒ Default; wird über `POST /api/auth/refresh` verlängert (v1.39.0) |
| `FIRM_SESSION_MAX_LIFE_S` | `86400` | Absolute Grenze ab Anmeldung in Sekunden (600 … 7 d, ≥ Idle); Verlängerungen verschieben sie nicht (v1.39.0) |
| `FIRM_SESSION_GRACE_S` | `900` | Nachfrist, in der `POST /api/auth/refresh` eine abgelaufene Idle-Frist heilt; `0` schaltet sie ab, sonst nirgends wirksam (v1.39.0) |
| `SESSION_RENEW_WINDOW_S` | `min(300, Idle/2)` | Restzeit, unterhalb derer `refresh` neue Cookies ausstellt (10 s … Idle/2) (v1.39.0) |
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

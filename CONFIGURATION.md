# Installation & Konfiguration

> **Status-Header (Task 12):** **Implementiert** (Tasks 1–13) ·
> Dokumentationsstand **2026-09-24** · Code-Version **v0.2.0** (Prompt-Budget
> und Batch-Analyse nachgezogen, §5)
>
> **Hinweis Versionierung:** Ab 2026-09-23 gilt das öffentliche v0.x.x-Schema
> (Beta). Ältere Status-Header und Abschnitte nennen teils die interne
> Legacy-Zählung `v1.x.x` — Zuordnung: [`CHANGELOG.md`](CHANGELOG.md)
> (§ Versions-Zuordnung), Archiv:
> [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md).

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
| `LLM_PROVIDER` | `ollama` | `ollama` · `openai` · `gemini` · `anthropic` · `opencode` (OpenCode Zen, Free-Modelle) |
| `LLM_BASE_URL` | abhängig | Basis-URL (OpenAI-kompatibel) |
| `LLM_API_KEY` | *(leer)* | API-Key für Cloud-Provider |
| `LLM_MODEL` | je Provider | Modellname |
| `LLM_MAX_TOKENS` | `512` | Max. Ausgabetokens je Aufruf |
| `LLM_TIMEOUT_MS` | `180000` | Zeitlimit je Modellantwort |
| `LLM_MAX_ATTEMPTS` | `2` | Retries (1–5) |
| `LLM_MAX_TOKENS_PER_TURN` | `20000` | GAP-08: Token-Summe je Agenten-Turn inkl. Retries (Bounds [1000, 200000]); Bruch → sauberer Abbruch + Audit `llm-budget:tokens` |
| `LLM_MAX_TURN_MS` | `120000` | GAP-08: Wall-Clock je Turn in ms (Bounds [10000, 900000]); Bruch → Abbruch + Audit `llm-budget:time` |
| `PLAUSIBILITY_PRICE_BAND_PCT` | `15` | GAP-08: Preisband in % um den Known-Good-Kurs (Bounds [1, 90]) |
| `PLAUSIBILITY_MIN_RATIONALE_CHARS` | `40` | GAP-08: Mindestbegründung bei Confidence ≥ 0.9 in Zeichen (Bounds [0, 1000]; `0` = Regel aus) |
| `EVAL_OUTPUT_DIR` | `data/eval` | GAP-08: Report-Verzeichnis des Prompt-Eval-Harness (`npm run eval:prompts`) |
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
| `OPENCODE_API_KEY` | *(leer)* | OpenCode-Zen-Key (kostenlos, https://opencode.ai/auth) |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen/v1` | OpenCode-Zen-Basis-URL (OpenAI-kompatibel) |
| `OPENCODE_MODEL` | `big-pickle` | Zen-Modell (Free-Liste: siehe docs/PROVIDER_INTEGRATION.md); `LLM_MODEL` gilt als Fallback |
| `OPENCODE_CONTEXT_SIZE` | `128000` | Kontextfenster der Zen-Free-Modelle |
| `ROUTING_BUDGET_OPENCODE_TOKENS` | `250000` | Tages-Token-Deckel des Providers (Regel 3: Cloud immer gedeckelt) |
| `LLM_COST_OPENCODE_INPUT_PER_MTOK` / `…_OUTPUT_PER_MTOK` | `0` | Kostenüberschreibung, falls bezahlte Zen-Modelle genutzt werden |
| `ROUTING_DISABLED_PROVIDERS` | *(leer)* | Kommagetrennte Sperrliste (`gemini,opencode`); der UI-Schalter hat Vorrang |
| `RUNTIME_FLAGS_FILE` | `data/runtime/flags.json` | Ablage der UI-Laufzeit-Schalter (nur Bool-Werte, chmod 600) |
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
| `PAPER_SIM_SYNTHETIC_SPREAD_BPS` | `2` | Bid/Ask-Spread für ticker-basierte Paper-Fills (z. B. Bitunix Modus B). **v0.3.0**: Timeframe-abhängiger Fallback skaliert nach oben (1m 15 bp, 5m 10, 15m 8, 30m 6, 1h 4, 4h 3, 1d 2) — feiner Takt = höhere Kosten, weil Edge pro Bar kleiner. |
| `PAPER_MAKER_FEE_PCT` | `0.04` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Maker-Gebühr in **Prozent** (0.04 = 0,04 %). Überschreibt `PAPER_SIM_MAKER_FEE`, wenn gesetzt. Bounds [0, 10], Clamp mit Log-Warnung. |
| `PAPER_TAKER_FEE_PCT` | `0.1` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Taker-Gebühr in **Prozent** (Market-Fills). Überschreibt `PAPER_SIM_TAKER_FEE`, wenn gesetzt. Bounds [0, 10]. |
| `PAPER_SLIPPAGE_BPS` | `1` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Basis-Slippage in Basispunkten. Überschreibt `PAPER_SIM_SLIPPAGE_BPS_BASE`, wenn gesetzt. Bounds [0, 10000]. |
| `PAPER_SPREAD_FALLBACK_BPS` | `2` | GAP-02 (v1.42.0): Kalibrierungs-Overlay Spread-Fallback in Basispunkten (ticker-basierte Snapshots). Überschreibt `PAPER_SIM_SYNTHETIC_SPREAD_BPS`, wenn gesetzt. Bounds [0, 10000]. **v0.3.0**: Wenn nicht gesetzt, nutzt die Engine den timeframe-abhängigen Fallback (1m 15 bp … 1d 2 bp). |
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
| `JOURNAL_MIN_TRADES` | `100` | Mindest-Stichprobe (geschlossene, attributierte Trades je Agent×Regime), ab der Kennzahlen/Gewichte wirksam werden. Darunter `insufficient-sample` — **niemals als Faktor**. Bounds [5, 200], Default 100 (n≥100), Clamp mit Log-Warnung. |
| `JOURNAL_WEIGHT_MIN` | `0.5` | Untere Bound der Agenten-Gewichte. Bounds des Wertes selbst: [0.1, 1.0] (darunter wäre ein Agent praktisch stummschaltet — kein zulässiges Journal-Instrument). |
| `JOURNAL_WEIGHT_MAX` | `1.5` | Obere Bound der Agenten-Gewichte. Bounds des Wertes selbst: [1.0, 3.0]. |
| `JOURNAL_MAX_WEIGHT_DELTA` | `0.1` | Maximale Gewichtsänderung **je Zyklus** — selbst extreme Serien bewegen Gewichte nur schrittweise (Multi-Zyklus-Annäherung, nie Sprung). Bounds [0.01, 0.5]. |
| `JOURNAL_CANDLES_TIMEFRAME` | `1h` | Kerzen-Intervall für die MAE/MFE-Berechnung (Allowlist = unterstützte Timeframes; ungültig → `1h` + Log-Warnung). Kerzenlücken ⇒ Metriken null + `CANDLE_GAP`-Flag (nie geschätzt). |

### Trade-PnL-Attribution (RMA-P1-06, v1.57.0)

Beim Close eines Trades wird automatisch eine **deterministische Netto-PnL-Attribution**
berechnet und append-only persistiert: Die Quellenbeiträge (Agenten der
Entscheidungskette bzw. die auslösende Regel) plus Kostenposten (Gebühren,
Funding) plus ein **explizites Residual** ergeben **exakt** das realisierte
Netto-PnL (± 1e-6). Die Methode `ta1` ist eine normierte Aufteilung
(`DETERMINISTIC_ALLOCATION`) auf die im unveränderlichen Entry-Snapshot
dokumentierten Quellen — **keine Kausalanalyse**. Spezifikation und Mathematik:
`src/attribution/README.md`.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `TRADE_ATTRIBUTION_ENABLED` | `true` | Schaltet den automatischen Attribution-Pfad beim Trade-Close ein. Rein additiv — kein Einfluss auf Order-, Risiko- oder Entscheidungspfade; ein Attribution-Fehler blockiert den Close nie (Audit `JOURNAL_ATTRIBUTION_FAILED`). `false` stoppt Close-Attribution UND den Backfill (fail-closed). Unbekannter Wert → `true` + Log-Warnung. |
| `TRADE_ATTRIBUTION_METHOD_VERSION` | `1` | Methodenversion (Allowlist `[1]` = `ta1`; unbekannt → `1` + Log-Warnung). Ein Wechsel schreibt **neue** Zeilen (Idempotenz-Schlüssel `journal_id` + `method_version`) — historische Ergebnisse bleiben unverändert erhalten. |

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

### Firmen-Metriken, Auto-Circuit-Breaker, Alerts & Heartbeat (GAP-10, v1.45.0)

Vier Bausteine, die die Firma beobachtbar und selbstschützend machen:
`prometheusMetrics()` liefert Firmen-Kennzahlen (Equity, Drawdown, offene
Positionen, Realized-P&L, Order-Fills/-Rejects, LLM-Aufrufe/Latenz), der
**Auto-Circuit-Breaker** prüft im Monitor-Tick drei harte Auslöser und zieht
den **bestehenden** Kill-Switch, der **Alert-Adapter** schreibt Alarme
strukturiert (Log/Datei, optional Webhook), und der **Heartbeat** macht einen
überfälligen Monitor-Tick sichtbar. Doku:
`docs/OBSERVABILITY.md` (§9–12), Runbook „Auto-Breaker hat ausgelöst“ in
`docs/OPERATIONS.md` (§4).

**Verhaltensänderung (explizit):** `AUTO_CIRCUIT_BREAKER` ist per Default
**an** — bestehende Installationen erhalten damit erstmals einen automatischen
Not-Halt bei Grenzbruch. Ein einmal ausgelöster Brecher bleibt scharf
(Latching); entschärft wird ausschließlich manuell über den unveränderten
Disarm-Pfad (Admin + CSRF + single-use Nonce, siehe `docs/OPERATIONS.md` §4).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `AUTO_CIRCUIT_BREAKER` | `on` | Auto-Not-Halt im Monitor-Tick: Drawdown ≥ `maxEquityDrawdownPct`, Tagesverlust ≥ `dailyLossLimitPct` oder `RISK_MAX_CONSECUTIVE_LOSSES` Verlust-Closes in Folge → Kill-Switch ENGAGE mit Grund `auto-circuit-breaker:<metrik>:<wert>` + Audit + Alert. `off` = nur die bisherige Blockade neuer Orders (bewusster Betriebsentscheid). Unbekannter Wert ⇒ Default `on` + Warnung (ein Tippfehler schaltet den Schutz nicht still ab). |
| `RISK_MAX_CONSECUTIVE_LOSSES` | `5` | Anzahl verlustreicher Position-Closes **in Folge** (CLOSED, `realizedPnl < 0`, jüngste zuerst), ab der der Brecher auslöst. Bounds [2, 50], Clamp mit Warnung. Prompt-Cooldowns (`COOLDOWN_AFTER_N_LOSSES`) bleiben davon unberührt. |
| `ALERT_DEBOUNCE_MINUTES` | `30` | Mindestabstand je **identischem** Alarm-Code (`circuit-breaker:…`, `heartbeat-stale`, …). Unterdrückte Alarme werden gezählt und beim nächsten Versand als `meta.suppressedSinceLast` gemeldet. Bounds [1, 1440]. |
| `ALERT_FILE` | `data/alerts.ndjson` | Append-only NDJSON-Senke des Alert-Adapters über `resolveRuntimePath()` (Datei-Modus 0600) — CLI und Server schreiben dieselbe Datei. |
| `ALERT_WEBHOOK_URL_SECRET_NAME` | *(leer)* | **Optionaler** Webhook: Name des Secret-Store-Eintrags, dessen `apiKey`-Feld die Webhook-URL enthält. Leer = Webhook aus (Default). Die URL selbst ist ein Credential und steht **nie** in Env/Logs/Fehlermeldungen. |
| `HEALTH_STALE_AFTER_MS` | `300000` (5 min) | Alter des letzten Monitor-Ticks in ms, ab dem `GET /api/health` `stale: true` meldet (`monitorLastTickAt`/`monitorAgeMs`/`staleAfterMs`). Nie gelaufen = stale. Bounds [30000, 3600000]. |

Zusätzlich: `npm run watchdog` prüft `/api/health` einmalig und alarmiert über
den Alert-Adapter (Codes `heartbeat-stale`,
`heartbeat-health-unreachable`, `heartbeat-health-unreadable`); Exit 0 =
gesund, 1 = Alarm, 2 = Bedienfehler. Er startet **nichts** neu und entschärft
**nichts** (alarm-first); Aufruf per systemd-Timer/Cron. Optionen:
`--url=…`, `--source=inprocess`, `--timeout-ms=…` (CLI, keine Env-Flags).

### Regime-Gate (GAP-06, v1.46.0)

Deterministischer Markt-Regime-Klassifikator (TREND_UP/TREND_DOWN/RANGE/
HIGH_VOL/CRASH, aus Kerzen: ADX + Regressions-Slope + realisierte Vol als
Perzentil + Drawdown vom Fensterhoch) mit Hysterese gegen Whipsaws; das Gate
dämpft Signalgewichte je Strategieklasse (mean-reversion/trend/breakout) als
**Datenkontext** — nie als hartes Veto. Rollout bewusst **monitor-first**:
Default ist Ausweis + Audit ohne Wirkung. Alle Flags sind optional — ohne
Konfiguration läuft das System exakt wie vorher (nur Ausweis). Seit
**v1.61.0 (RMA-P2-01)** ist die Erkennung multidimensional und
point-in-time-sicher: versionierte Preis-/Volatilitäts-/Liquiditäts-/Perp-
(+ optionale Makro-)Familien mit Confidence, Coverage und Top-Treibern;
fehlende/stale Familien degradieren auf den OHLCV-Pfad und können das
Risiko nie erhöhen. Doku: [`docs/REGIME_GATE.md`](docs/REGIME_GATE.md).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `REGIME_GATE_MODE` | `monitor` | Gate-Modus: `off` (keine Ausweisung, Prompt/Entscheidungspfad byte-identisch), `monitor` (**Default**: Ausweis im Ops-Center/Prompt + Audit je Regime-Wechsel, keine Wirkung), `enforce` (Faktor wirkt: Engine-Risikobudget-Kontext + Mikro-Executor-Sizing, gegen die Code-Ceilings geklemmt). Unbekannter Wert → fail-closed `monitor` (nie still `enforce`). |
| `REGIME_LOOKBACK_CANDLES` | `100` | Lookback-Fenster der Klassifikation in Kerzen. Bounds [20, 500], Clamp mit sicherem Default. |
| `CRASH_DRAWDOWN_PCT` | `10` | Drawdown vom Fensterhoch in %, ab dem (zusammen mit negativem Slope) `CRASH` gilt. Bounds [3, 50]. |
| `HIGH_VOL_PERCENTILE` | `90` | Perzentil-Rang der realisierten Volatilität über den Lookback, ab dem `HIGH_VOL` gilt. Bounds [50, 99]. |
| `REGIME_CONFIRM_CANDLES` | `3` | Hysterese: konsekutive bestätigende Bewertungen, bis ein Seitwärts-/De-Eskalationswechsel übernommen wird (Eskalation ist sofort). Bounds [1, 20]. |
| `REGIME_TREND_ADX` | `25` | ADX-Schwelle (Wilder, Periode 14) für `TREND_UP`/`TREND_DOWN`. Bounds [10, 60]. |
| `REGIME_TREND_SLOPE_PCT` | `0.05` | Mindest-|Regressions-Slope| in % pro Kerze für `TREND_*` (darunter `RANGE`). Bounds [0.005, 1]. |
| `REGIME_GATE_FACTORS` | s. u. | Dämpfungsfaktoren je Regime × Strategieklasse, Grammatik `REGIME:klasse=faktor,…` (z. B. `TREND_UP:mean-reversion=0.25`). Werte geklemmt auf [0, 2]; kaputte Einträge werden übersprungen. Defaults: mean-reversion × 0.5 in TREND_UP/TREND_DOWN, breakout × 0.5 in RANGE, sonst × 1. |
| `REGIME_FEATURE_MODE` | `multidim` | Feature-Modus der Erkennung (v1.61.0): `multidim` (OHLCV-Kern + Preis/Volatilität/Liquidität/Perp/optional Makro, `regime-features@1`) oder `ohlcv` (nur die Basisklassifikation, alle Zusatzfamilien `DISABLED` — Legacy-Modus, ohne zusätzliche Votes). Unbekannter Wert → `multidim` (Default), nie still `ohlcv`. |
| `REGIME_MIN_COVERAGE` | `0.5` | Mindest-Coverage der Pflichtfamilien (Gewichte: Preis 0.3 / Vol 0.3 / Liquidität 0.2 / Perp 0.2). Darunter: `degraded=true` und der Gate-Faktor darf nicht über 1 (Boosten blockiert). Bounds [0, 1]; Coverage = OK-Gewichte / 1.00. |
| `REGIME_LIQUIDITY_SPREAD_HIGH_PCT` | `0.5` | Spread-Vote: relativer Spread in % ab dem die Rohklasse zu `HIGH_VOL` eskaliert (nur wenn die Liquiditätsfamilie `OK` ist). Bounds [0.01, 100]. |
| `REGIME_PERP_FUNDING_ABS` | `0.001` | Funding-Vote: absoluter Funding-Satz ab dem eskaliert wird (zusätzlich: OI-Einbruch ≤ −30 % ist fest verdrahtet). Bounds [0.00001, 0.1]. |
| `REGIME_MACRO_VIX_HIGH` | `30` | Makro-Vote: adaptiver VIX-Zustand ab dem eskaliert wird (nur wenn die optionale Makro-Familie `OK` ist). Bounds [10, 100]. |
| `REGIME_SNAPSHOT_RETENTION_DAYS` | `90` | Aufbewahrung der `regime_snapshots`-Zeilen (unterbrochene Prozesse bereinigen beim nächsten Persistenz-Schub). Bounds [7, 365]. |
| `PERP_DATA_ENABLED` | `false` | Schaltet die Perp-Datenfamilie der Regime-Erkennung (und der Derivatik-Ansicht) frei. Ohne `true` ist die Familie `MISSING` — sie wird nie still als `0`-Funding gewertet. Bounds: boolsche Env-Var. |

Zusätzlich hart verdrahtet (kein Flag):

- **UNKNOWN statt Raten:** unter 30 Kerzen ist das Regime `UNKNOWN` →
  Faktor 1 + Kennzeichnung (nie still); `UNKNOWN` berührt die Hysterese nicht.
- **Audit je Regime-Wechsel:** `REGIME_CHANGE` mit Code
  `regime:SYMBOL:VON→NACH`; jede enforce-Dämpfung zusätzlich
  `REGIME_GATE_APPLIED` (`regime-gate:SYMBOL:KLASSE:REGIME`).
- **Cycle-Artefakt:** `artifacts/YYYY-MM-DD/daily/regime-history.json`
  (Stand + Verlauf je Instrument); Ops-Center-Risk-Sektion weist Modus und
  Regime je Instrument aus.

### Datenqualitäts-Layer & Multi-TF (GAP-07, v1.47.0)

Qualitätsprüfung der Kerzenserien (GAP/OUTLIER/INVALID/DUPLICATE) +
deterministische 1h→4h/1d-Aggregation + opt-in Zweitquellen-Cross-Check.
Grundprinzip: Befunde werden **sichtbar klassifiziert** (MDERR-Stil) —
gespeicherte Historie wird nie still verändert, echte Flash-Moves werden nicht
weggefiltert. Alle Flags sind optional — **ohne Konfiguration läuft das System
exakt wie vorher** (Modus `log`, Aggregation/Cross-Check aus). Details:
[`docs/MARKET_DATA_PIPELINE.md`](docs/MARKET_DATA_PIPELINE.md) §14 und
[`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) §2.1.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `MARKETDATA_QUALITY_MODE` | `log` | Lesepfad-Modus: `log` (Default: Befunde nur sichtbar machen — Report `data/marketdata/quality-report.json` + Log + Metrik, Scan byte-identisch) \| `strict` (fail-closed: Instrumente mit `INVALID`-Befund behandelt der Scanner wie `DATA_UNAVAILABLE` — bestehende Stale-Fallback-Kette, `data-unavailable`-Ablehnung, nie `min-candles`). Unbekannter Wert → `log` + Warnung. |
| `MARKETDATA_OUTLIER_ATR_MULT` | `25` | Outlier-Schwelle: Wick oder Körper **streng** größer als Multiplikator × Volatilitäts-Baseline (leave-one-out-Mittel der True-Ranges). Bounds [5, 200], Clamp mit Log-Warnung. Bewusst großzügig, damit echte Flash-Moves durchkommen; exakt Schwelle = **kein** Befund (Grenzwert getestet). |
| `MARKETDATA_STALE_1H_HOURS` | `26` | Stale-Guard: eine 1h-Reihe ist stale, wenn die jüngste Kerze älter als N Stunden ist. Bounds [2, 168], Clamp mit Log-Warnung. Ausweis als Zähler im Sync-Status (`staleSeries`/`staleByTimeframe`), keine Symbole. |
| `MARKETDATA_STALE_4H_HOURS` | `104` | Stale-Schwelle für 4h-Reihen (Default 26 × 4). Bounds [8, 672]. |
| `MARKETDATA_STALE_1D_HOURS` | `624` | Stale-Schwelle für 1d-Reihen (Default 26 × 24). Bounds [48, 4032]. |
| `MARKET_SYNC_AGGREGATE` | `off` | Deterministische Multi-TF-Aggregation im Sync-CLI (auch `--aggregate`): persistierte 1h-Reihen → 4h/1d (UTC-Anker 00/04/… bzw. 00:00 UTC; **unvollständige Bucket werden nie aggregiert**; Zeitmaske nur abgeschlossene Perioden). Aggregat wird als **neue** Timeframe-Reihe (`feed: "agg:1h"`) appendet, 1h-Quelle bleibt unangetastet. Nur wirksam bei synchronisiertem `1h`. `on`/`true`/`1` schaltet an. |
| `MARKETDATA_CROSSCHECK` | `off` | Zweitquellen-Cross-Check (opt-in — Rate-Limits!). Nur wirksam, wenn der Adapter die optionale Methode `getCrosscheckCandles()` implementiert (Adapter-Registry-Muster); ohne Implementierung no-op. Bei `on` ein zusätzlicher Request je Reihe (Rate-Limit-Bucket bleibt autoritativ). |
| `MARKETDATA_CROSSCHECK_TOLERANCE_PCT` | `1` | Cross-Check-Toleranz in Prozent (Abweichung der Schlusskurse auf gemeinsamen Zeitstempeln, relativ zum Primärkurs). **Streng** größer ⇒ `QUALITY_CROSSCHECK`-Befund + Log. Bounds [0.1, 10], Clamp mit Log-Warnung. 0 gemeinsame Zeitstempel = kein Befund (kein Vergleich ≠ Abweichung). |

### MTF-Konfluenz (RMA-P2-03, v1.62.0)

Deterministischer Multi-Timeframe-Konfluenzsnapshot (`mtf-confluence@1`,
as-of-ausgerichtet, nur geschlossene Bars) als Trusted-Data für den
technischen Step und den Analysten. Ohne Konfiguration läuft das System mit
den eingebauten Defaults (15m/1h/4h, Gewichte 0.2/0.3/0.5, `minCoverage`
0.5); `CONFLUENCE_ENABLED=false` stellt den Legacy-Output ohne Snapshot
wieder her. Details: [`docs/MTF_CONFLUENCE.md`](docs/MTF_CONFLUENCE.md).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `CONFLUENCE_ENABLED` | `true` | Step-Anhängung an/aus. Nur `false`/`0`/`off`/`no` schalten ab (Rollback-Pfad: Legacy-Output, additiv kompatibel); unbekannte Werte warnen und lassen die Konfluenz an (fail-laut). |
| `CONFLUENCE_CONFIG_FILE` | `—` | Pfad einer JSON-Config (Defaults + validierte Overrides: 1–5 Timeframes, Gewichtssumme exakt 1, bounded Schwellen/Perioden, Warmup ≤ `maxBars`). Unlesbar/ungültig ⇒ harter Fehler (kein still schwächeres Verhalten). |

### Cross-Sectional Momentum Ranking (RMA-P2-04, v1.63.0)

Point-in-Time universumsweites Momentum-Ranking (`cross-sectional@1`,
as-of-sicher, Policy `ingested`: `barEnd ≤ asOf` **und** `fetchedAt ≤ asOf`)
mit deterministischer Snapshot-ID, DB- + Artefakt-Persistenz, Read-only-API
(`GET /api/research/cross-sectional`) und Scanner-Diagnose-Faktor
`crossSectionalMomentum` (**Score-Gewicht 0** — kein Doppeltzählen des
instrument-lokalen `momentum`; ein fehlender Rang ist explizit
`unavailable` mit Neutralwert 0.5, nie 0). Ohne Konfiguration läuft das
System mit den eingebauten Defaults (1h, Horizonte h72/h168/h336 mit
Gewichten 0.2/0.3/0.5, Winsorize [0.01, 0.99], `minCandles` 168,
`minVolume24h` 100 000, Max-Snapshot-Alter 7 Tage, Stability Top-K 10).
Details: [`docs/CROSS_SECTIONAL_RANKING.md`](docs/CROSS_SECTIONAL_RANKING.md),
CLI `npm run research:cross-sectional`.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `CROSS_SECTIONAL_ENABLED` | `true` | Scanner-Artefakt-Lesepfad an/aus; CLI-Lauf bleibt möglich. Nur `false`/`0`/`off`/`no` schaltet ab (Rollback-Pfad: exaktes Vor-Verhalten, additiv kompatibel); unbekannte Werte warnen und lassen die Funktion an (fail-laut). |
| `CROSS_SECTIONAL_CONFIG_FILE` | `—` | Pfad einer JSON-Config (Defaults + validierte Overrides: 1–5 Horizonte auf dem 1h-Raster, Gewichtssumme exakt 1, bounded Schwellen/Universums-Cap, Staleness ≤ 30 Tage). Unlesbar/ungültig ⇒ harter Fehler `CROSS_SECTIONAL_CONFIG_ERROR` (kein still schwächeres Verhalten). |

Migration: `psql \"$DATABASE_URL\" -f drizzle/2026-09-22_cross_sectional_ranking.sql`
(append-only, idempotent; neue Tabellen `cross_sectional_snapshots` +
`cross_sectional_rankings`, keine Änderungen an bestehenden Tabellen).

### Strukturierte Sentiment-Outputs (RMA-P2-05, v1.64.0)

Kalibrierbare strukturierte Sentiment-Outputs (`sentiment@1`) mit expliziter
Horizont-, Event-, Quellen- und Unsicherheitssemantik. Strikte Trennung von
direktionaler Wahrscheinlichkeit (`probability` ∈ [0.01, 0.99]) und
Quellenabdeckung (`coverage` ∈ [0, 1]). Unterscheidet echtes `NEUTRAL` mit
Quellennachweis von `ABSTAIN` (Enthaltung bei 0 oder veralteten Quellen).
Schützt vor künstlicher Konfidenzerhöhung durch syndizierte Presse- und Wire-Meldungen
über Content-Hashing und Paraphrasen-Erkennung. Persistiert append-only in
`sentiment_forecasts` mit deterministischer Idempotenz (`sf1:<sha256>`) und
Outcome-Link zum P3.1-Ledger (ohne Preisspeicherung beim Erzeugen). Details:
[`docs/SENTIMENT.md`](docs/SENTIMENT.md), API `GET /api/analysis/sentiment`.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `STRUCTURED_SENTIMENT_ENABLED` | `true` | Persistenz strukturierter Sentiment-Outputs an/aus. Bei `false`/`0` wird die Persistenz in `sentiment_forecasts` übersprungen; der Cycle und die bestehenden Berichte laufen unbeeinträchtigt im Speicher weiter (Rollback-Pfad). |

Migration: `psql \"$DATABASE_URL\" -f drizzle/2026-09-22_structured_sentiment.sql`
(append-only, idempotent; neue Tabelle `sentiment_forecasts`, keine Änderungen an
bestehenden Tabellen).

### Prompt-Performance & Version-Metrikvergleich (RMA-P3-02, v1.65.0)

Jeder LLM-Aufruf erzeugt ein immutable Prompt-Artefakt (`pp1:<sha256>` über
LF-kanonisierten Text) + eine Run-Provenanz (Provider/Modell/Params/Timing/
Tokens/Cost/Success, ohne Secrets, `pr1:<sha256>`-Idempotenz). Outcomes stammen
aus dem P3.1-Forecast-Ledger (`forecast_resolutions`) und der P1.6-Attribution
(`trade_attribution_entries`); Metriken binden strikt über `promptVersion`,
`PENDING` zählt nie als Gewinn/Verlust, `UNKNOWN` ist immer sichtbar
(`promptVersion=null`, `promptHash="UNKNOWN"`), und ein Vergleich legt
**identische** Filter über beide Versionen (sonst `MISMATCHED_FILTERS`).
Promotion ist **nur Empfehlung hinter Human-Gate** (`GATED`) mit ECE-Wächter
(≥ 0.02 schlechter kalibriert ⇒ kein Gewinn allein wegen PnL). Details, Formeln,
Einheiten (`ms`/`count`/`USD`) und Zeitsemantik (`eventTime=asOf/startedAt`,
`availableAt=availabilityDeadline`, `computedAt` nie Zulässigkeitskriterium): 
[`docs/PROMPT_PERFORMANCE.md`](docs/PROMPT_PERFORMANCE.md), SQL
`drizzle/2026-09-22_prompt_performance.sql`.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `PROMPT_PERFORMANCE_ENABLED` | `true` | Artefakt- + Provenanz-Schreibpfad an/aus. `false` unterdrückt `ensurePromptArtifact`+`recordPromptRun` (`DISABLED`, sofort gefangen — der Agenten-Turn läuft trotzdem), bestehende Zeilen bleiben lesbar (Rollback). Nur exakt `false`/`0` schaltet ab; unbekannte Werte ⇒ an (fail-laut). |

Migration: `psql "$DATABASE_URL" -f drizzle/2026-09-22_prompt_performance.sql`
(append-only, idempotent; zwei neue Tabellen `prompt_artifacts`+
`agent_prompt_runs`, Trigger sperren `UPDATE`/`DELETE`/`TRUNCATE`, keine
Änderungen an bestehenden Tabellen) **oder** `npx drizzle-kit push`. APIs:
`GET /api/firm/prompts/artifacts|runs|metrics|compare` (je `firm.read`,
`no-store`, bounded `truncated`/`X-Truncated`, `units` ms/count/USD).

### Perpetual-Daten (RMA-P2-02, v1.54.0)

Historische Funding-Raten, Open Interest und Liquidationen in eigenen
`perp_*`-Tabellen, as-of-lesbar (`event_time ≤ asOf` **und**
`available_at ≤ asOf`), append-only und idempotent. Beide Hauptschalter stehen
aus: ohne Konfiguration läuft das System exakt wie vor v1.54.0 (Scanner,
Zyklus, Risiko, Live-Gate unverändert). Details:
[`docs/PERPETUAL_DATA.md`](docs/PERPETUAL_DATA.md), CLI `npm run perp:sync`.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `PERP_DATA_ENABLED` | `false` | Konsumenten an: Derivatekontext der Signale, Funding-Replay im Backtest, Analystenzeilen, Derivat-Artefakt. `false` ⇒ alle Pfade lesen nicht und verhalten sich wie vorher. |
| `PERP_DATA_SYNC_ENABLED` | `false` | Netz-Ingestion an. Ohne sie geht **kein** Request ab; zusätzlich gilt pro Venue `<VENUE>_ENABLED` (Bitunix: `BITUNIX_ENABLED=true`). |
| `PERP_DATA_VENUES` | alle bekannten | Kommaliste als Allowlist des Sync (`BITUNIX`, `SIM`). Unbekannte Venue ⇒ klassifizierter Skip, kein Lauf. |
| `PERP_DATA_AVAILABILITY` | `ingested` | `availableAt`-Politik: `ingested` = `max(event_time, fetched_at)` (realistisch für Punkt-für-Punkt-Replays), `settlement` = `event_time` (volle Historie, nur für Forschung mit bekanntem Stand). |
| `PERP_DATA_QUALITY_MODE` | `log` | `log` (Befunde sichtbar, Bestand bleibt lesbar) \| `strict` (Reihen mit `INVALID`/`DUPLICATE` bleiben ungeschrieben und werden in der Abfrage gefiltert). |
| `PERP_DATA_BACKFILL_DAYS` | `30` | Tiefe der Erstbefüllung je Reihe. Bounds [1, 400], Clamp mit Warnung. |
| `PERP_DATA_FUNDING_INTERVAL_HOURS` | `8` | erwartetes Funding-Raster (Lücken- und Overlap-Berechnung). Bounds [1, 24]. Gemeldete Intervalle gewinnen immer. |
| `PERP_DATA_OI_INTERVAL_MINUTES` | `60` | erwartetes Open-Interest-Raster (Lückenprüfung, Limit der Abfragefenster). Bounds [1, 1440]. |
| `PERP_DATA_MAX_STALE_FUNDING_HOURS` | `24` | Frische der Funding-Reihe, gemessen am **Ereignis** (nicht am Abruf). Bounds [1, 168]. |
| `PERP_DATA_MAX_STALE_OI_HOURS` | `4` | Frische des Open Interest. Bounds [1, 72]. |
| `PERP_DATA_MAX_ABS_FUNDING_RATE` | `0.0075` | Plausibilitäts-Bound je Intervall (0,75 % ist bereits extrem). Außerhalb ⇒ Wert `null` + `OUT_OF_BOUNDS`, **nie** geklemmt. Bounds [0.0001, 0.3]. |
| `PERP_DATA_MAX_OI_CHANGE` | `0.5` | maximale relative OI-Änderung je Schritt (Δ beyond ⇒ `OUTLIER`-Befund, Wert bleibt markiert). Bounds [0.01, 5]. |
| `PERP_DATA_CONCURRENCY` | `4` | parallele Reihen je Lauf, hart ≤ 8 (der Rate-Bucket bleibt autoritativ). Bounds [1, 8]. |
| `PERP_DATA_SAFETY_LAG_MS` | `60000` | Nachlauf des Sync-Fensters gegen die Uhr, damit ein noch laufendes Settlement nicht halbvoll gelesen wird. Bounds [0, 6 h]. |
| `PERP_DATA_CROSSCHECK_VENUE` | `—` | zweite Venue für den Funding-Abgleich (`CROSSCHECK`-Befund bei Abweichung). Leer = aus (kein zusätzlicher Netzwerkverkehr). |

Artefakte: `data/perpdata/quality-report.json` und
`data/perpdata/derivatives.json` (0600, atomar). Migration:
`psql \"$DATABASE_URL\" -f drizzle/2026-09-20_perpetual_data.sql`.


### Forecast-Ledger & Kalibrierung (RMA-P3-01, v1.55.0)

Analysen der Agenten werden als unveränderliche Forecast-Verträge erfasst,
Point-in-Time aufgelöst und mit Brier-Score/Kalibrierung bewertet — unabhängig
von Trades. Details: [docs/FORECASTS.md](docs/FORECASTS.md).

| Flag | Default | Bedeutung |
|------|---------|-----------|
| `FORECAST_LEDGER_ENABLED` | `true` | Capture-Hook im Analystenpfad + Resolver-/Score-APIs aktiv. `false` ⇒ kein Forecast wird erfasst, APIs antworten `503 DISABLED`; bestehende Ledger-Daten bleiben lesbar. Der Analysten- und Trade-Pfad läuft unverändert weiter (additiv, kein Fail des Analysepipeline-Zyklus bei Ledger-Störungen). |
| `FORECAST_RESOLVER_INTERVAL_MIN` | `15` | Kadenz (Minuten) des Resolution-Schedulers in `instrumentation.ts`. Bounds [5, 1440], Clamp mit Warnung. `0`/negativ ⇒ Scheduler aus (nur manuelle Auflösung über die API). |
| `FORECAST_MIN_SAMPLE` | `30` | Mindeststichprobe für die Status-Einstufung `ok` in Scoreberichten; darunter bleibt der Bericht sichtbar, trägt aber `insufficient-sample`. Bounds [5, 1000]. |

Migration: `psql "$DATABASE_URL" -f drizzle/2026-09-20_forecast_ledger.sql`
(idempotent, append-only — wiederholtes Ausführen ist sicher). Rollback:
`FORECAST_LEDGER_ENABLED=false` setzt das Feature vollständig außer Kraft, ohne
die Tabellen anzufassen (Tabellen dürfen erst nach Verifikation leer/duplikatfrei
per `DROP TABLE … CASCADE` entfernt werden — Downgrade-Runbook in
[docs/FORECASTS.md](docs/FORECASTS.md)).


### Sizing & Cluster-Limits (GAP-04, v1.48.0)

Vol-basiertes Position-Sizing (`qty = (equity · riskPerTradePct) / |entry − stop|`,
ATR-Fallback-Stop, Fractional-Kelly-Deckel) und der Cluster-Exposure-Guardrail
(Schicht 3 des riskGuard) im Order-Pfad. **Rollout monitor-first:** ohne
Konfiguration bleibt der Order-Pfad in seinen Entscheidungen unverändert
(monitor + Kelly aus); Sizing selbst wirkt bereits mit Defaults (Formel identisch
zur bisherigen Risikoformel, nur zentralisiert + an Ceilings geklemmt).
Formeln und Rollout: [`docs/PORTFOLIO_ANALYTICS.md`](docs/PORTFOLIO_ANALYTICS.md)
(Abschnitt „Sizing & Cluster-Limits im Order-Pfad“); Ops (monitor→enforce):
[`docs/HANDBUCH.md`](docs/HANDBUCH.md) §9.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `RISK_ATR_STOP_MULT` | `2` | ATR-Fallback-Stop-Multiplikator `k` (`stop = entry − k·ATR`, SHORT gespiegelt), wirksam wenn kein expliziter Stop vorliegt. Bounds [0.5, 6], Clamp mit sicherem Default. Semantisch identisch zu `atrStopMultiplier` in den Risk-Limits (LIMIT_CEILINGS [0.5, 6]). |
| `RISK_KELLY_FRACTION` | `0` | Fractional-Kelly-Deckel: `maxNotional = equity · fraction · f*`, `f* = (b·p − (1−p))/b` (p = Win-Rate, b = Payoff aus dem Trade-Journal, GAP-03). `0` = aus (**Default**). Bounds [0, 1]. Wirkt **nur** mit ausreichenden Journal-Statistiken (`JOURNAL_MIN_TRADES`); sonst wirkungslos (Status `unavailable` in `GET /api/firm/risk`). `f* ≤ 0` → keine Größe (`kelly:no-positive-edge`). |
| `RISK_CLUSTER_LIMITS_MODE` | `monitor` | Guardrail-Modus: `monitor` (**Default**: Entscheidung unverändert, Verstoß/Stale nur als Audit-Notiz `CLUSTER_EXPOSURE_MONITOR` + Log mit Würde-Prüfung) \| `enforce` (echte Ablehnung `CLUSTER_EXPOSURE_BLOCKED`). Unbekannter Wert → `monitor` + Warnung. |
| `RISK_CORR_THRESHOLD` | `0.7` | \|ρ\|-Schwelle für die Cluster-Union (Single-Linkage, `\|ρ\| ≥ Schwelle`). Bounds [0.3, 0.99], Clamp mit Log-Warnung. |
| `RISK_MAX_PER_CLUSTER` | `3` | Maximale offene Positionen je Korrelations-Cluster (inkl. der neuen). Bounds [1, 10]. Verstoß → `cluster-exposure:max-per-cluster:N`. |
| `RISK_CORR_WINDOW_CANDLES` | `90` | Renditen-Fenster in 1h-Kerzen (≈ 3,75 Tage; gemeinsame Zeitstempel-Intersection, log-Renditen). Bounds [30, 365]. |
| `RISK_CORR_CACHE_TTL_MS` | `900000` | TTL des Korrelations-Caches (Symbol-Menge + Fenster + Schwelle). Berechnung nur je Order-Prüfung, kein Hintergrund-Job. Bounds [60000, 3600000]. |

Hinweise:

- **Fail-closed (Stale-Policy):** Fehlen die Korrelationsdaten (keine Kerzen im
  `data/history`-Store, Symbol nicht im Universum auflösbar, < 20 gemeinsame
  Renditen, Kerzen älter als 24 h), wird in `enforce` die Aufstockung in
  möglicherweise korrelierte Cluster abgelehnt
  (`cluster-exposure:correlation-stale`) — statt zu raten. `monitor` bleibt
  unverändert. Keine offenen Positionen → keine Prüfung (nichts zu clustern).
- **Ausschluss-Kern:** `computePositionSize()` (reine Funktion) und
  `assessClusterExposure()` (reine Funktion) sind vollständig deterministisch
  und unit-gedeckt; Korrelations-Mathematik kommt aus `src/portfolio`
  (Import, keine Duplikation).
- **Observability:** `GET /api/firm/risk` zeigt effektive Sizing-/Cluster-
  Parameter, Kelly-Edge-Status (inkl. `unavailable`) und die UNKNOWN-Zustände;
  Audit-Events: `POSITION_SIZING` / `POSITION_SIZING_UNKNOWN`
  (Code `sizing:atr-unknown:SYMBOL`) und `CLUSTER_EXPOSURE_MONITOR` /
  `CLUSTER_EXPOSURE_BLOCKED` (Code `cluster-exposure:…`).

### Plausibilität, Eval-Harness & Turn-Budget (GAP-08, v1.49.0)

Plausibilitäts-Schicht über den Agenten-Outputs (Research-Setups + Makro):
Monotonie je Richtung, Preisband um den Known-Good-Kurs aus dem
HistoricalStore, Confidence-vs.-Begründung und regex-basierter Zahlenbezug
als Halluzinations-Heuristik. Befunde → genau EIN Retry mit
Fehlermeldungs-Kontext, danach deterministischer Skip (leerer Fallback +
`CYCLE_STEP_SKIPPED` mit Grund `plausibility:CODE` + sichtbarer Status im
Step-Output/Tages-Artefakt). Das Golden-Dataset (`tests/fixtures/golden/`)
prüft Schema + Plausibilität nach jedem Prompt-Edit (`npm run eval:prompts`,
Offline-Default, deterministische Reports); der Turn-Hartdeckel begrenzt
Token-Summe + Wall-Clock je Agenten-Turn inkl. aller Retries. Details +
Grenzen der Heuristik: [`docs/LLM_ROUTING.md`](docs/LLM_ROUTING.md)
(Abschnitt 17).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `PLAUSIBILITY_PRICE_BAND_PCT` | `15` | Preisband in % um den letzten Known-Good-Kurs (jüngster valider Schlusskurs der Referenzkerzen); Entry/Stop/TP außerhalb → `PRICE_RANGE`. Bounds [1, 90], Clamp mit Log-Warnung. |
| `PLAUSIBILITY_MIN_RATIONALE_CHARS` | `40` | Mindestlänge der Begründung (Research: `thesis`, Makro: `thesis`) bei Confidence ≥ 0.9 (Research: `1 − riskScore`); darunter → `RATIONALE_MISSING`. Bounds [0, 1000], `0` = Regel aus. |
| `LLM_MAX_TOKENS_PER_TURN` | `20000` | Token-Summe je Agenten-Turn (Hauptaufruf + Eskalations-/Plausibilitäts-Retries). Bounds [1000, 200000]. Überschreitung → `TurnBudgetExceededError` + Routing-Audit `llm-budget:tokens` (Outcome `budget_blocked`, Sicherheitsklasse in `audit_log`); keine Teil-Results als Erfolg. Zählung: gemeldeter Verbrauch je `routeChat()` (Näherung, siehe Doku). |
| `LLM_MAX_TURN_MS` | `120000` | Wall-Clock je Turn in ms (geprüft an Aufrufgrenzen, kein Timer). Bounds [10000, 900000]. Überschreitung → Abbruch + Audit `llm-budget:time`. |
| `EVAL_OUTPUT_DIR` | `data/eval` | Ablage der Eval-Reports (`eval-report.json` + `eval-report.md`, via `resolveRuntimePath`, Laufzeitdaten, nicht versioniert). Override auch per `--out-dir`. |

Hinweise:

- **Fail-closed:** Befund nach dem einzigen Retry → Skip (sichtbar in
  `audit_log` UND im Artefakt `07-research.json`/`02-macro-analyst.json` als
  `plausibility`-Block). Ungültiger Retry → `plausibility:invalid-retry`.
  Auch eskalierte Antworten werden plausibilisiert (ohne weiteres Retry).
- **Referenzdaten:** Ohne Kerzen melden die Preis-Regeln `referenceMissing`
  (sichtbar, nicht blockierend) statt zu raten; Regel (a)/(c) laufen immer.
- **Eval:** `npm run eval:prompts` (Exit 0 = alle Fixtures wie erwartet,
  1 = Regression, 2 = Fixture-/Bedienfehler). `--provider` fragt den
  konfigurierten Provider (Rauchtest, kostet Tokens, Budget-Hinweis im
  Report) — nur mit explizitem Flag.
- **Turn vs. Tages-Deckel:** Die Tages-Deckel (`BudgetTracker`) und
  Einzelaufruf-Limits (`LLM_MAX_TOKENS`/`LLM_TIMEOUT_MS`) bleiben unverändert;
  der Turn-Deckel schließt die Lücke für Multi-Call-Turns.

### Prompt-Budget und Batch-Analyse (CYCLE-BATCH-01)

Der Technical Analyst (Schritt 04) und der News Analyst (Schritt 05) erhalten
bis zu 40 Kandidaten. Was er davon
tatsächlich beantworten *kann*, bestimmen zwei Limits, die nichts
miteinander abstimmen: `OLLAMA_NUM_CTX` (wie viel Prompt gelesen wird) und
`LLM_MAX_TOKENS` (wie viel Antwort geschrieben werden darf). Der Prompt wächst
mit jedem Kandidaten, die Antwort ebenfalls. Passt beides nicht, kürzt das
Modell die Eingabe am Fensterrand, schneidet die Antwort bei `num_predict` ab,
das JSON wird unvollständig — und der Agent-Port antwortet, wie für einen
Ausfall gedacht, mit dem deterministischen Fallback: `bias: NEUTRAL`,
`technicalScore: 50` für **alle** Kandidaten. Das ist kein Absturz, sondern
stille Bedeutungslosigkeit, und sie ist der Grund, warum „mehr Märkte
analysieren" ohne Budget-Planung kein Gewinn ist.

Der Schritt vermisst deshalb vor jedem Aufruf den Prompt, den er tatsächlich
senden wird (dieselbe Baufunktion, keine Zweit-Implementierung), und teilt die
Shortlist in Batches, die nachweislich in beide Budgets passen. Beim
News-Schritt gilt dasselbe für Headline-Material (Messung: 40 Instrumente mit
120 Meldungen = 31 594 Zeichen ≈ 8 800 Tokens); symbollose Ganzmeldungen
werden in jeden Batch wiederholt und das systemische Risiko über die Batches
nach Schwere gemerged (MAX), nicht nach Mehrheitsvotum.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `CYCLE_PROMPT_RESERVE_TOKENS` | `256` | Puffer, den die Planung zusätzlich zu `LLM_MAX_TOKENS` freihält (System-Prompt, Block-Überschriften, Rundung). Bounds [0, 8192]. |
| `CYCLE_PROMPT_INPUT_BUDGET_TOKENS` | abgeleitet | Harte Kappe des Eingabebudgets je Aufruf. Ungesetzt: `OLLAMA_NUM_CTX − LLM_MAX_TOKENS − Reserve`, mindestens 512. Setzen überstimmt die Herleitung; ein unlesbarer Wert klemmt auf die konservative Untergrenze (mehr Batches, nie ein größerer Prompt als vorher). Bounds [512, 1000000]. |
| `CYCLE_ANALYST_BATCH_SIZE` | aus `LLM_MAX_TOKENS` | Kandidaten je LLM-Aufruf. Default-Ableitung: `LLM_MAX_TOKENS · 0,85 ÷ 90` (≈ 90 Tokens je Analyseobjekt) ⇒ bei 512 also **4**. Bounds [1, 40] = Code-Shortlist-Limit. |
| `CYCLE_ANALYST_CONCURRENCY` | providerabhängig | Wie viele Batches gleichzeitig laufen. `ollama`: **1** (eine Inferenz-Slot ⇒ Parallelität legt sich in die Warteschlange und verdrängt den KV-Cache, statt Zeit zu sparen); `openai`/`gemini`/`anthropic`: **2**. Bounds [1, 8]. Der Tages-Token-Deckel des Routers gilt unverändert über alle Batches. |

Nachweis im Artefakt: `04-technical-analyst.promptFit` (Zähler, keine IDs) mit
`calls`, `concurrency`, `maxItemsPerBatch`, `constrainedBy`
(`output` = Antwortlänge, `input` = Kontextfenster, `env-batch-size` =
Override), `droppedFullSnapshots`, `failedBatches`, `fallbackInstruments`,
`incomplete` und `recommendedMaxOutputTokens` (was `LLM_MAX_TOKENS` bräuchte,
damit alles in einen Aufruf gepasst hätte).

Warum die Zahlen aus dem Realbetrieb (40 Kandidaten, Default-Flags):

| | Prompt | gegen Budget | Ergebnis |
| --- | --- | --- | --- |
| vorher (ein Aufruf) | 92 449 Zeichen ≈ 25 700 Tokens | 3 328 Tokens Fenster, 512 Antwort | Antwort abgeschnitten → 40 × Neutral |
| jetzt (geplant) | 10 Aufrufe à ≤ 5 939 Zeichen ≈ 1 650 Tokens, ≤ 4 Analysen | je Aufruf im Rahmen | 40 echte Analysen, Zähler im Artefakt |

Größerer Prompt, mehr Information? Nein — zuerst billiger: 64 % der alten
Prompt-Bytes waren die **doppelten** Konfluenzdaten (Voll-Snapshots *und*
ihre kompakte Zeilenform, dieselben Zahlen). Wo das Budget reicht, bleiben die
Voll-Snapshots im Prompt; wo nicht, fliegen sie je Batch einzeln — die
Autorität leidet nicht, denn die Snapshots werden ohnehin serverseitig nach der
Validierung an jede Analyse gehängt (`RMA-P2-03`) und stehen vollständig im
Tages-Artefakt.

Wer bewusst mehr pro Aufruf will, kalibriert die drei Regler gemeinsam, z. B.
`OLLAMA_NUM_CTX=16384`, `LLM_MAX_TOKENS=4608`, `CYCLE_ANALYST_BATCH_SIZE=40`.
RAM und Latenz hängen dann an `num_ctx` — auf einer CPU-Box ist das die
eigentliche Rechnung, nicht die Zeile Code.

### Reconciliation & Idempotenz (GAP-09, v1.50.0)

Periodischer Abgleich zwischen Broker und Datenbank (`src/brokers/reconciliation.ts`),
Differenz-Klassifikation, automatischer Pause-Pfad (ohne Auto-Flatten),
einheitliches Client-Order-ID-Schema (`atf-<orderIntentId-kurz>`) und
Paper-Invarianz-Selbsttest. Details: [`docs/BROKER_ARCHITECTURE.md`](docs/BROKER_ARCHITECTURE.md) (§10).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `RECON_PRICE_DRIFT_PCT` | `1` | Maximale Kursabweichung in % zwischen Broker und DB, die als tolerierbar eingestuft wird (`PRICE_DRIFT`). Bounds [0.01, 10], Clamp mit Log-Warnung. |
| `RECON_INTERVAL_MINUTES` | `60` | Scheduler-Intervall für den periodischen Abgleich in Minuten. Bounds [5, 1440]. Ad-hoc-Aufruf via `scripts/reconcile.ts` (oder `npm run reconcile`). |
| `RECON_PAUSE_ON_MISMATCH` | `false` | Bei kritischen Diskrepanzen (`QTY_MISMATCH`, `PHANTOM_POSITION`, `MISSING_POSITION`, `BALANCE_MISMATCH`, `INVARIANT_VIOLATION`) Kill-Switch scharfschalten (`recon:<klasse>`). Kein Auto-Flatten; Disarm erfordert manuelle Challenge. |

Hinweise:

- **Reine Funktion & Testbarkeit:** `classifyDifferences` ist frei von I/O
  und prüft Positionsdifferenzen, Kassensalden und Ledger-Invarianten.
- **Auto-Flatten ist STRIKT VERBOTEN:** Ein Pause-Ereignis schaltet lediglich
  den Kill-Switch scharf; offene Positionen werden niemals automatisch geschlossen.
- **Client-Order-ID:** Schema `atf-<orderIntentId-kurz>` wird deterministisch
  aus dem Order-Intent abgeleitet und bei Timeouts wiederholt, um Doppelorders
  zu verhindern.

### Walk-Forward-Backtesting (GAP-01, v1.51.0)

Regelbasierte Backtesting-Engine mit rollierenden IS/OOS-Fenstern
(`src/backtest/walkforward.ts`), Paper-Ausführung über denselben
Fill-Simulator wie der PaperBroker und vergleichbar persistierten Runs
(`backtest_runs`, CLI `scripts/run-backtest.ts`). Details:
[`docs/BACKTESTING.md`](docs/BACKTESTING.md).

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `WF_IS_WINDOW_DAYS` | `90` | Länge des In-Sample-Fensters in Tagen. Bounds [14, 720], Clamp mit Log-Warnung. IS/OOS trennt EVALUATIONS-Fenster (Robustheit) — keine Parameter-Optimierung. |
| `WF_OOS_WINDOW_DAYS` | `30` | Länge des Out-of-Sample-Fensters in Tagen (zugleich Schrittweite). Bounds [7, 180]. OOS-Segmente kacheln lückenlos/überlappungsfrei; nur vollständige Fenster werden gelegt. |
| `WF_MAX_SPAN_DAYS` | `730` | Maximaler Backtest-Zeitraum in Tagen (Anti-Overfitting-Deckel, Default 2 Jahre). Bounds [30, 3650]. Längere Zeiträume werden am Anfang gekappt (jüngste Daten gewinnen, `truncated: true` im Report). |

Hinweise:

- **Kostenprofil:** Der Paper-Pfad nutzt die kalibrierte Paper-Konfiguration
  (`PAPER_SIM_*` + `PAPER_MAKER_FEE_PCT`/`PAPER_TAKER_FEE_PCT`/
  `PAPER_SLIPPAGE_BPS`/`PAPER_SPREAD_FALLBACK_BPS`, siehe „Paper-Trading /
  Marktdaten“) sowie die Funding-Konfiguration (`PAPER_FUNDING_*`).
- **Determinismus:** Gleiche (Kerzen, Regel, Fenster, Kosten) ⇒
  byte-identischer Report (Walk-Forward erzwingt `executionModel: "paper"`).
- **CLI-Flags `--is-days`/`--oos-days`** überschreiben die Env-Werte je Lauf
  (Bounds wie oben, sonst Abbruch mit Exit 1).

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
| `BROKER_HEALTHCHECK_REMOTE` | `false` | remote Health-Checks aktivieren; ohne Neustart umschaltbar im Operations Center → „Broker Operations" (Runtime-Flag `broker.healthcheck.remote`, hat Vorrang). ALPACA/IBKR prüfen dabei credential-frei ihre Sync-Quelle (Yahoo) und bleiben ohne Keys/Gateway `degraded`. |

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

### Execution-Policy mit Market-Fallback (RMA-P4-02, v1.70.0)

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `EXECUTION_POLICY_ENABLED` | `false` | Gibt `start`/`poll`/`recover` der Execution-Policy frei (`false` = 503, nur Lesen; ungültige Werte werfen) |
| `TWAP_EXECUTION_ENABLED` | `false` | Gibt `start`/`tick`/`cancel`/`resume`/`recover` des TWAP-Schedulers frei (`false` = 503, nur Lesen; ungültige Werte werfen) |

Details: [`docs/POST_ONLY_FALLBACK.md`](docs/POST_ONLY_FALLBACK.md), [`docs/TWAP_EXECUTION.md`](docs/TWAP_EXECUTION.md).

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

## Execution-Quality-Capture

`EXECUTION_QUALITY_ENABLED` ist standardmäßig `false` und akzeptiert nur
`true`/`false`. Vor Aktivierung die neuen Execution-Quality-Migrationen anwenden.
`EXECUTION_QUALITY_SCOPE` ist ein stabiler, opaker Account-/Deployment-Namespace
(1–64 Zeichen aus Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich), keine
Broker-Kontonummer und kein Secret. Bei aktivem Capture fehlen Scope oder stabile
Adapter-Intent-ID nicht stillschweigend: der Aufruf blockiert vor dem Senden.

Worker pro Venue/Modus: `npm run execution:reconcile -- ALPACA testnet --watch`.
Er liest ausschließlich Venue-Fakten; unklare Submissions dürfen nie durch eine
neue Order „repariert“ werden. Fehlende/stale Benchmarks bleiben null mit Reason.
Rollback: Capture deaktivieren, Worker stoppen, Audit-Tabellen behalten; zunächst
unklare Orders beim Venue abgleichen. [Migration, Vertrag, API und Formeln](src/executionQuality/README.md).

## Devil’s Advocate (RMA-P3-03)

| Variable | Standard | Erlaubte Werte | Bedeutung |
| --- | --- | --- | --- |
| `DEVILS_ADVOCATE_ENABLED` | `true` | `true`, `false`, `1`, `0` | Aktiviert oder deaktiviert den Devil’s-Advocate-Step. |
| `DEVILS_ADVOCATE_SHADOW` | `false` | `true`, `false`, `1`, `0` | Im Shadow-Modus wird die Falsifikation vollständig berechnet und auditiert, verändert jedoch niemals das reale Risikobudget (`NO_OP`). |
| `DEVILS_ADVOCATE_SCALE_DOWN_THRESHOLD` | `0.40` | `0.10` .. `0.90` | Ab diesem Disagreement-Score wird die Positionsgröße bzw. das Risiko reduziert. |
| `DEVILS_ADVOCATE_HUMAN_REVIEW_THRESHOLD` | `0.70` | `0.40` .. `1.00` | Ab diesem Disagreement-Score wird eine manuelle Prüfung erzwungen und der Trade pausiert. |
| `DEVILS_ADVOCATE_SCALE_DOWN_FACTOR` | `0.50` | `0.10` .. `0.90` | Risikofaktor bei moderatem Dissens. |

## Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0)

Kontinuierliche Risikoschicht: annualisierte Portfolio-Volatilität gegen ein
Ziel, Risikobudget `maxRiskPerTrade` wird **nur senkend** skaliert (Faktor
hart ≤ 1). Vollständige Doku: [`docs/VOLATILITY_TARGETING.md`](docs/VOLATILITY_TARGETING.md).
Migration (append-only, idempotent) vor Aktivierung anwenden:
`npx drizzle-kit push` (oder
`psql "$DATABASE_URL" -f drizzle/2026-09-22_volatility_targeting.sql`).

| Variable | Standard | Erlaubte Werte | Bedeutung |
| --- | --- | --- | --- |
| `PORTFOLIO_VOL_TARGETING_MODE` | `monitor` | `off`, `monitor`, `active` | Betriebsmodus. `monitor` (Default): Forecast + Persistenz + Reporting, **keine** Ordergrößenänderung. `active`: Faktor wirkt auf das Risikobudget. `off`: inaktiv, gesetzter Faktor wird zurückgenommen (Rollback). Unbekannt ⇒ `monitor`. |
| `PORTFOLIO_VOL_TARGETING_TIMEFRAME` | `1h` | `5m`, `15m`, `30m`, `1h`, `4h`, `1d` | Timeframe der Forecast-Kerzen. Unbekannt ⇒ `1h`. |

Die übrigen Parameter (Ziel, Lookback, Multiplikator-Bounds, Smoothing,
Staleness, Coverage, Shrinkage) liegen in `risk_config` unter `vtp.*`
(Master-Schalter `vtp.enabled`, Default 1) und werden gegen feste Bounds
geklemmt — Details und Bounds in
[`docs/VOLATILITY_TARGETING.md`](docs/VOLATILITY_TARGETING.md) und
`src/portfolio/volatilityTargeting.ts` (`VOLATILITY_TARGETING_BOUNDS`).

**Rollout:** zuerst `monitor` beobachten (realisierte Vol + Target-Error im
Status/API), dann `active`. Rollback: `PORTFOLIO_VOL_TARGETING_MODE=off` +
Restart — keine Datenbereinigung nötig (Snapshots bleiben lesbar).

## Drawdown-Risk-Scaling (RMA-P5-04, v1.68.0)

Hysteretische Risikoschicht: die reconcilte Equity wird gegen den persistierten
High-Water-Mark (HWM) bewertet; aus dem Drawdown folgt über eine monotone,
versionierte Kurve ein Risikofaktor, der `maxRiskPerTrade` **nur senkend**
skaliert (Faktor hart ≤ 1). Degradation wirkt sofort, Erholung nur nach
Cooldown **und** Bestätigungen (kein Flapping); optional blockiert die Stufe
`PAUSE` neue Einstiege. Ein-/Auszahlungen sind keine Performance (der HWM wird
cashflow-bereinigt geführt). Vollständige Doku:
[`docs/DRAWDOWN_SCALING.md`](docs/DRAWDOWN_SCALING.md).
Migration (append-only, idempotent) vor Aktivierung anwenden:
`npx drizzle-kit push` (oder
`psql "$DATABASE_URL" -f drizzle/2026-09-22_drawdown_scaling.sql`).

| Variable | Standard | Erlaubte Werte | Bedeutung |
| --- | --- | --- | --- |
| `DRAWDOWN_SCALING_MODE` | `monitor` | `off`, `monitor`, `active` | Betriebsmodus. `monitor` (Default): Bewertung + Persistenz + Reporting, **keine** Ordergrößenänderung und kein PAUSE-Block. `active`: Faktor wirkt (≤ 1) und die Stufe `PAUSE` blockiert neue Einstiege. `off`: inaktiv, gesetzter Faktor und PAUSE werden zurückgenommen (Rollback). Unbekannt ⇒ `monitor`. |

Die übrigen Parameter liegen in `risk_config` unter `dsp.*` (Master-Schalter
`dsp.enabled`, Default 1), werden gegen feste Bounds geklemmt und sind im
Dashboard als dritte Sektion `drawdown` sichtbar
(`effectiveConfigView()`):

| Schlüssel | Standard | Fenster | Bedeutung |
| --- | --- | --- | --- |
| `dsp.softThresholdPct` | 5 | 0.1 … 50 | Drawdown (%), ab dem die Reduktion beginnt. |
| `dsp.hardThresholdPct` | 12 | 1 … 80 | Drawdown (%), ab dem der Boden erreicht ist (wird auf `> soft` normalisiert). |
| `dsp.minFactor` | 0.25 | 0.05 … 1 | Untergrenze des Risikofaktors (`> 0`, hart ≤ 1). |
| `dsp.pauseThresholdPct` | 0 (aus) | 0 … 100 | Drawdown (%), ab dem neue Einstiege blockiert werden (wird auf `≥ hard` normalisiert). |
| `dsp.maxEquityStalenessMinutes` | 15 | 1 … 1440 | Maximales Alter der Equity-Beobachtung; älter ⇒ konservativer Faktor. |
| `dsp.requireReconciliation` | 1 | 0/1 | 1 = ohne aktuellen, sauberen Broker↔DB-Abgleich gilt der konservative Faktor. |
| `dsp.reconciliationMaxAgeMinutes` | 360 | 5 … 10080 | Maximales Alter des letzten Reconciliation-Berichts. |
| `dsp.recoveryCooldownMinutes` | 360 | 0 … 10080 | Wartezeit nach einer Degradation, bevor der Faktor steigen darf. |
| `dsp.recoveryConfirmations` | 3 | 1 … 240 | Bestätigte Erholungsbewertungen **nach** dem Cooldown vor dem ersten Recovery-Schritt. |
| `dsp.recoveryStep` | 0.05 | 0.01 … 1 | Maximaler Faktorzuwachs je bestätigtem Recovery-Schritt. |
| `dsp.cashflowToleranceAbs` | 0.05 | 0 … 1e6 | Absolute Toleranz der Cashflow-Erkennung (Kontowährung). |
| `dsp.cashflowTolerancePct` | 0.001 | 0 … 0.05 | Relative Toleranz (Anteil der Equity). |
| `dsp.bootstrapFromBaseline` | 1 | 0/1 | 1 = beim ersten Lauf ist der HWM ≥ Startkapital (kein Reset durch Deployment). |

**Rollout:** zuerst `monitor` beobachten (Stufe, Faktor, Grund-Codes,
Reconciliation-Gate in `GET /api/firm/risk/drawdown-scaling`), dann `active`.
Rollback: `DRAWDOWN_SCALING_MODE=monitor` oder `=off` (+ optional
`dsp.enabled=0`) + Restart — Faktor und PAUSE werden sofort zurückgenommen,
keine Datenbereinigung nötig (Snapshots bleiben lesbar).

## Signal-Decay-Exits (RMA-P5-05, v1.69.0)

Schließt eine Position, wenn das unveränderliche Entry-Signal gegenüber einem
point-in-time aktuellen Signal derselben Version bestätigt verfallen oder
umgekehrt ist. `SIGNAL_DECAY` kommt nach Kill-Switch, Stop, Take-Profit,
Trailing und Time-Stop. Fehlende Daten schließen nicht. Vollständige Formeln:
[`docs/SIGNAL_DECAY.md`](docs/SIGNAL_DECAY.md).
Migration vor dem Deploy:
`psql "$DATABASE_URL" -f drizzle/2026-09-22_signal_decay.sql`.

| Variable | Standard | Erlaubte Werte | Bedeutung |
| --- | --- | --- | --- |
| `SIGNAL_DECAY_MODE` | `monitor` | `off`, `monitor`, `active` | `monitor`: bewerten und Counterfactual schreiben, nicht schließen. `active`: bestätigter Verfall schließt mit `SIGNAL_DECAY`, aber nur für aktivierte Klassen. `off`: keine Writes, Exits unverändert. Unbekannt ⇒ `monitor`. |
| `SIGNAL_DECAY_CLASS_TREND` | `false` | `true`/`false` | Klasse `trend`. Default aus. |
| `SIGNAL_DECAY_CLASS_MEAN_REVERSION` | `false` | `true`/`false` | Klasse `mean-reversion`. Default aus. |
| `SIGNAL_DECAY_CLASS_BREAKOUT` | `false` | `true`/`false` | Klasse `breakout`. Default aus. |
| `SIGNAL_DECAY_CLASS_UNCLASSIFIED` | `false` | `true`/`false` | Klasse `unclassified`. Wird nie automatisch eingeschaltet. |
| `SIGNAL_DECAY_MIGRATIONS` | leer | kommaseparierte IDs | Nur bekannte IDs (`mig-mkt-sig-0-to-1`, `mig-strength-pct-to-unit`). Sonst strikter Versionsgleichstand. |
| `SIGNAL_DECAY_THRESHOLD_MODE` | Klassen-Default | `absolute`, `relative`, `either`, `both` | Globaler Override der Drop-Verknüpfung. |

Numerische Schwellen liegen unter `sdc.<klasse>.<feld>` (Bounds in
`docs/SIGNAL_DECAY.md`) und sind über `POST /api/firm/risk/signal-decay`
schreibbar. Der Modus selbst ist nicht per API umschaltbar.

**Rollout:** Migration, dann `monitor` mit einer Klasse beobachten
(`GET /api/firm/risk/signal-decay`: Coverage, additional/avoided PnL), dann
`SIGNAL_DECAY_MODE=active`. Rollback: `SIGNAL_DECAY_MODE=off` oder die
Klassenflags auf `false`. Die Event-Tabelle bleibt append-only.

## Strategy-Lifecycle & Driftgates (RMA-P1-05, v1.73.0)

Evidenzbasierte 9-Zustands-Promotion (DRAFT → BACKTEST_* → PAPER →
LIVE_LIMITED → LIVE) mit immutabler Evidence, versionierten Promotion-Gates,
Drift-Vergleich (Performance/Risk/Execution/Data Quality) und automatischer
Degrationsleiter (Risiko senken → DEGRADED/LIVE_LIMITED → PAUSE). Der
Lifecycle-Gate prüft vor Live-Orders **zusätzlich** zu Kill-Switch, Live-Gate
und Risk-Ceilings und schwächt diese nie. Vollständige Doku:
[`docs/STRATEGY_LIFECYCLE.md`](docs/STRATEGY_LIFECYCLE.md).
Migration (append-only, idempotent) vor Aktivierung:
`psql "$DATABASE_URL" -f drizzle/2026-09-23_strategy_lifecycle.sql`.

| Variable | Standard | Erlaubte Werte | Bedeutung |
| --- | --- | --- | --- |
| `STRATEGY_LIFECYCLE_MODE` | `off` | `off`, `monitor`, `enforce` | `off` (Default): kein Order-Blocker, rückwärtskompatibel. `monitor`: Gates bewerten + Audit, blockieren Live-Orders nicht. `enforce`: Live-Orders ohne autorisierte Lifecycle-Erlaubnis werden abgelehnt (`LIFECYCLE_GATE_DENY`). Unbekannt ⇒ `off` + Warnung (nie still `enforce`). |
| `STRATEGY_LIFECYCLE_RECOVERY_COOLDOWN_MS` | `21600000` (6 h) | 0 … 2592000000 (30 d) | Recovery-Cooldown nach Degradation; vor Ablauf blockieren Recovery-Edges (`COOLDOWN_ACTIVE`). |
| `STRATEGY_LIFECYCLE_MIN_RISK_FACTOR` | `0.25` | 0.05 … 1 | Untergrenze des Lifecycle-Risikofaktors (hart ≤ 1, nur senkend). |

**Rollout:** Migration, dann `STRATEGY_LIFECYCLE_MODE=monitor` in Paper
beobachten (`GET /api/firm/lifecycle`), dann `enforce` für Live-Schlüssel.
Rollback: `STRATEGY_LIFECYCLE_MODE=off` (+ optional
`psql` DROP der drei `strategy_lifecycle_*`-Tabellen, siehe
`docs/STRATEGY_LIFECYCLE.md` §8) + Restart — keine Datenbereinigung der
bestehenden Ceilings/Kill-Switches nötig (die wirken unverändert weiter).


# How-to: LAN weg nach Update (`trading.local` / `192.168.0.10:3369`) + „Firm-Status nicht verfügbar"

> **Kurzfassung:** Nach Update/Setup ist die App nur auf `127.0.0.1` erreichbar und der
> systemd-Dienst crasht mit `EADDRINUSE`. Danach meldet das Dashboard eine
> abgelaufene Sitzung — **nicht** die Datenbank. Seit v1.39.0 bleibt die
> Sitzung bis zum Fenster-Schließen aktiv und der Balken zeigt außerdem, ob
> überhaupt ein Firm-Token eingetragen ist (Kapitel
> [Sitzung bis zum Fenster-Schließen](#sitzung-bis-zum-fenster-schließen-v1390-s1)).
>
> ```bash
> npm run stop                          # alten 127.0.0.1-Prozess beenden
> sudo systemctl restart ai-trading-firm
> ss -tlnp | grep 3369                  # muss 0.0.0.0:3369 zeigen
> ```
>
> Danach im Dashboard **einmal neu anmelden** (Token aus `.env`). Der Firm-Status
> lädt seit **v1.36.41** von selbst neu — ein manuelles `F5` entfällt. Fertig.

---

## Bug 1 — LAN nicht erreichbar nach Update

### Symptom

- `http://192.168.0.10:3369` von einem anderen Rechner (z. B. `192.168.0.20`): Timeout / Connection refused.
- `https://trading.local` (Caddy) ebenfalls tot.
- Lokal auf dem Server geht `curl http://127.0.0.1:3369/api/health`.

### Ursache

Ein alter Next.js-Prozess bindet den Port **nur auf Loopback**:

```
LISTEN 127.0.0.1:3369  (next start -H 127.0.0.1)
```

Das ist typischerweise ein Rest aus `scripts/setup-cachyos.sh` Schritt 10
(Validierung startet bewusst `npx next start -H 127.0.0.1`) oder ein manueller
Start vor dem Update. Der systemd-Dienst (`npm run start` = `next start -H 0.0.0.0`)
kann dann nicht starten und loopt:

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3369
```

sichtbar via `journalctl -u ai-trading-firm`. Auch Caddy
(`nas-server-proxy-1`: `trading.local → host.docker.internal:3369`) erreicht
einen reinen `127.0.0.1`-Listener nicht. Hinweis: `GET /api/health`-Check
V03 (`package.json ≠ API-Version`) verrät den alten Prozess zusätzlich.

### Fix

```bash
cd ~/GITHUB/ai-trading-firm
npm run stop                              # beendet den 127.0.0.1-Prozess (ohne sudo)
sudo systemctl restart ai-trading-firm
systemctl status ai-trading-firm --no-pager   # muss active (running) zeigen
ss -tlnp | grep 3369                      # SOLL: 0.0.0.0:3369 — NICHT 127.0.0.1:3369
curl -s http://192.168.0.10:3369/api/health | head -c 300
```

Danach vom Client testen: `http://192.168.0.10:3369` und `https://trading.local`
(Zertifikatswarnung für `tls internal` einmal bestätigen).

Hinweis: `trading.firm` existiert nicht — kein DNS, kein Caddy-VHost
(`~/nas-server/Caddyfile` kennt nur `trading.local`). Wer den Namen will,
muss DNS + Caddy-VHost erst anlegen.

---

## Bug 2 — „Firm-Status nicht verfügbar (Datenbank)" + `UNAUTHORIZED`

> **Behoben seit v1.36.41.** Das Dashboard trennt eine abgelaufene Sitzung von
> einem echten Datenbankfehler (`classifyFirmFailure()` in
> `src/lib/firmSession.ts`): Bei `401`/`403` steht dort jetzt **„Sitzung
> abgelaufen — bitte neu anmelden."**, das Anmeldefeld ist sofort sichtbar und
> nach dem Eintragen des Tokens lädt der Firm-Status automatisch neu. Die
> PostgreSQL-Anleitung erscheint nur noch bei einem echten `5xx` der
> `/api/firm`-Route. Der Rest dieses Abschnitts erklärt den Befund und zeigt,
> wie man ihn ohne Dashboard nachweist.

### Symptom

**Bis v1.36.40** — gelbe Box im Dashboard, deren Titel die Datenbank beschuldigt:

> **Firm-Status nicht verfügbar (Datenbank).**
> `UNAUTHORIZED` … Die Modul-Tabs (Operations Center, Brokers & Venues) funktionieren weiter.

**Ab v1.36.41** — derselbe Zustand, korrekt benannt und mit Ausweg:

> **Sitzung abgelaufen — bitte neu anmelden.**
> `UNAUTHORIZED` Nach der Anmeldung lädt der Firm-Status automatisch neu — kein F5 nötig.
>
> `[ API-Token (FIRM_API_TOKEN) ]` **[Anmelden]**

### Ursache (kein DB-Schaden!)

- `GET /api/health` → `ok:true, schemaReady:true` — PostgreSQL, `DATABASE_URL` und Schema sind OK.
- `GET /api/firm` verlangt seit SEC-02 die Permission `firm.read`
  (`requirePermission(req, "firm.read")` in `src/app/api/firm/route.ts`).
  Ohne gültige Session/Token antwortet die Route `401 UNAUTHORIZED`.
- Nach Update + Neustart ist das `firm_session`-Cookie weg/ungültig
  (15 min Laufzeit, Secret-Rotation, `clearLegacyFirmToken()`-Migration seit W1/v1.36.23).
- **Bis v1.36.40** schrieb `FirmDashboard.tsx` (`load()`, `fetch("/api/firm")`)
  **jeden** Fehlerbody — auch `401` — in dieselbe Box mit hart verdrahtetem
  Titel „(Datenbank)". Der Text log also: Es war Auth, nicht die DB.
  **Seit v1.36.41** wird die Antwort nach Statuscode klassifiziert; Titel und
  Anleitung kommen aus `src/lib/firmSession.ts`.

Nachweis, dass die Datenbank gesund ist und nur die Session fehlt:

```bash
# .env in die Shell laden (Secret bleibt dort, erscheint in keiner Datei):
set -a; . ./.env; set +a
curl -s -H "x-firm-token: $FIRM_API_TOKEN" http://127.0.0.1:3369/api/firm | head -c 200
# → {"version":"1.36.41","agents":[…]} heißt: DB gesund, nur Session fehlt
```

### Fix — einmal neu anmelden

1. Token auf dem Server holen:
   ```bash
   grep '^FIRM_API_TOKEN=' .env
   ```
2. Im Dashboard das Feld **API-Token (FIRM_API_TOKEN)** ausfüllen. Seit
   v1.36.41 steht es direkt unter dem Hinweis „Sitzung abgelaufen"; bis
   v1.36.40 erschien es erst nach einer *Aktion* (z. B. `▶▶ Ganze Pipeline`).
3. **Anmelden** — der Firm-Status lädt automatisch neu, ein manuelles `F5`
   ist seit v1.36.41 nicht mehr nötig.

Bleibt die Box: über **Abmelden** im Hinweisbalken aus- und wieder einloggen.
Steht dort stattdessen **„Zugriff verweigert"**, ist die Session gültig, aber
die Rolle hat `firm.read` nicht (Rollenmatrix: `docs/security/README.md`).

Die Sitzung gilt nicht mehr starr 15 Minuten: seit v1.39.0 trägt der Browser
sie bis zum Fenster-Schließen, das Dashboard verlängert sie automatisch, und
eine abgelaufene Idle-Frist heilt innerhalb der Nachfrist ohne Token-Eingabe.
Enden tut sie trotzdem noch bei jeder Secret-Rotation (`FIRM_SESSION_SECRET`),
bei Token-Rotation (`authEpoch`), bei jedem Dienst-Neustart (Revocation-Registry
lebt im RAM) und spätestens an der absoluten Grenze (`FIRM_SESSION_MAX_LIFE_S`,
Default 24 h). Details im nächsten Kapitel.

---

---

## Sitzung bis zum Fenster-Schließen (v1.39.0, S1)

Vorher: `Max-Age=900`. Wer nach 15 Minuten noch am Dashboard saß, bekam `401`,
sah aber nicht, woran es lag — und musste den Token aus `.env` abtippen. Jetzt
trägt der Browser die Sitzung, solange das Fenster offen ist.

### Was der Server tut

| Frist | Flag | Default | Verschiebbar durch Aktivität? |
| --- | --- | --- | --- |
| Idle-Frist `exp` | `FIRM_SESSION_IDLE_TTL_S` | 900 s (15 min) | **ja** — `POST /api/auth/refresh` |
| Absolute Grenze `maxExp` | `FIRM_SESSION_MAX_LIFE_S` | 86 400 s (24 h), harte Obergrenze 7 d | **nein** |
| Nachfrist (nur `refresh`) | `FIRM_SESSION_GRACE_S` | 900 s, `0` = aus | — |

```text
Login  ──► firm_session (HttpOnly, Secure, SameSite=Strict, KEIN Max-Age)
         ──► firm_csrf    (lesbar, Double-Submit-Beweis)
Dashboard-Takt (renewInS des Servers, bei Tab-Fokus sofort)
         ──► POST /api/auth/refresh  + Header x-csrf-token
                  │  Restzeit > Fenster   ⇒ 200 { renewed:false } — keine neuen Cookies
                  │  Idle um, Nachfrist an ⇒ heilt die Sitzung (ein Klick aufs Tab genügt)
                  │  maxExp um / widerr.   ⇒ 401 — Anmeldung nötig
                  └─ innerhalb Fenster     ⇒ neues Set-Cookie, gleiches iat + maxExp
Fenster zu ⇒ Cookie weg. Neustart/Logout/Rotation ⇒ Session weg (Payload, nicht Alter).
```

Drei Eigenschaften tragen das Sicherheitsversprechen:

1. **`iat` rutscht nicht.** Der Anmeldezeitpunkt bleibt Teil der Signatur,
   Verlängern schreibt nur `exp` neu. Der globale Notfallschnitt
   (`sessionsRevokedBefore`, SEC-08) tötet damit auch eine 400-mal verlängerte
   Sitzung. `revokeSession()` registriert bis `maxExp`, nicht bis zur alten
   Restzeit — Logout einer Generation entwertet die andere mit.
2. **Nachfrist ≠ Autorisierung.** `FIRM_SESSION_GRACE_S` kennen ausschließlich
   `renewSession()` und die Statusanzeige. `readSession()` und damit jede
   Guard-Route bleiben bei `exp` hart; ein liegengelassenes Cookie öffnet
   nichts (Test: `tests/sessionRenewal.test.ts`).
3. **Verlängern braucht den CSRF-Beweis.** Der Header muss den Wert des
   `firm_csrf`-Cookies zurückgeben. Die Legacy-Regel „Header == API-Token"
   akzeptiert `refresh` bewusst nicht — sonst wäre jede API-Copy ein
   Verlängerungsmandat.

### Was das kostet (die ehrliche Rechnung)

- **Missbrauchsfrist.** Ein Dieb des HttpOnly-Cookies kann die Sitzung aktiv
  halten, ohne den Token zu kennen; vorher war nach 15 Minuten Schluss.
  Dagegen: absolute Grenze (Default 24 h), `SameSite=Strict` + `Secure`
  (ohne TLS kommt das Cookie ohnehin nicht an), Double-Submit-Pflicht,
  `POST /api/auth/logout` (Admin: Body `{"all": true}`) und Rotation von
  `FIRM_SESSION_SECRET` als harte Schnitte.
- **Rehydrierung.** Moderne Browser stellen nach „Sitzung wiederherstellen"
  teils Cookies zu. Die Rechte hängen am signierten Payload — ist `exp` um und
  die Nachfrist vorbei, ist die Sitzung tot, auch mit rehydrierter Cookie.
- **Kein Token im Client.** Bewusst **kein** `localStorage`/SessionStorage und
  kein Refresh-Token im JS: Der Verlängerungsmechanismus ist eine HttpOnly-
  Session mit kurzem `exp`, kein langlebiges Secret im Browser. W1 bleibt
  erhalten, die Reichweite des Diebstahls ist die Sitzung — nicht der Token.
- **Wer länger als ein Arbeitstag am Stück arbeiten will,** muss
  `FIRM_SESSION_MAX_LIFE_S` heraufsetzen (max. 7 Tage) und nimmt die längere
  Missbrauchsfrist bewusst in Kauf. Abgelaufene Grenze ⇒ Token neu eintragen.

### Die Anzeige im Dashboard

`GET /api/auth/status` ist secret-frei und beantwortet genau die Frage, die
vorher offen blieb: **Ist die Firm-API eingetragen?** Der Balken zeigt

```text
● Firm-API: eingetragen (+Operator) · angemeldet als Operator ·
  Session noch 13:04 · automatische Verlängerung · absolute Grenze in 23:59:12
                                     [13:04 · max 23:59:12]  [Verlängern] [Abmelden]
```

Zustände: `nicht angemeldet` · `angemeldet als <Rolle>` · `läuft aus` ·
`abgelaufen, aber innerhalb der Nachfrist verlängerbar` · `Session abgelaufen` ·
`absolute Lebensdauergrenze erreicht` · `Session wurde abgemeldet oder
serverseitig widerrufen` · `KEIN Token gesetzt`. Nach einem erfolgreichen Login
meldet sich zusätzlich der Fall „Login bestätigt, aber keine Cookie im Browser"
— das ist fast immer plain-HTTP gegen `192.168.x.x:3369` (`Secure`-Cookies
brauchen TLS; Fix: TLS-Proxy oder `localhost`).

### Prüfen statt raten

```bash
curl -s http://127.0.0.1:3369/api/auth/status | jq '.firmApi, .session'
# Set-Cookie beim Login muss OHNE Max-Age/Expires sein:
curl -s -D- -o /dev/null -X POST http://127.0.0.1:3369/api/auth/login \
  -H 'content-type: application/json' -d '{"firmToken":"…"}' | grep -i '^set-cookie'
# Verlängerung (CSRF aus dem Cookie firm_csrf):
curl -s -X POST -H "Cookie: firm_session=…; firm_csrf=…" \
  -H 'x-csrf-token: …' http://127.0.0.1:3369/api/auth/refresh | jq
```

Verdacht „Token nicht eingetragen"? `firmApi.configured:false` ist der Beweis —
dann im Server-`.env` nachtragen und neu starten, das Dashboard kann das nicht
erledigen. `403 SESSION_FORBIDDEN`/`CSRF_INVALID` bei `refresh`: das Tab hat
ein Alt-Cookie ohne passendes `firm_csrf` (zuvor **Abmelden**, neu anmelden).
`503 SESSION_SECRET_REQUIRED`: `FIRM_SESSION_SECRET` fehlt — Sessions gibt es
gar nicht, deshalb half bisher nur der Neustart mit Schlüssel.

Nachweise im Repo: `tests/sessionRenewal.test.ts` (Policy, Verlängerung,
Nachfrist, beide neuen Routen), `test/ui/SessionStatusBar.test.tsx` und
`test/ui/FirmSessionBox.test.tsx` (Anzeige), `tests/w1.sessionCookie.test.ts`
(Cookie-Attribute), `tests/sec01.sessionSecurity.test.ts` (Payload v3).

---

## Siehe auch

- [HANDBUCH.md](HANDBUCH.md) Kap. 2.4 — Anmeldung und Sitzung im Dashboard
- [INSTALL.md](INSTALL.md) — Kap. 5 Reverse Proxy, Kap. 7 systemd,
  Troubleshooting-Tabelle (`EADDRINUSE 0.0.0.0:3369`, „Sitzung abgelaufen")
- [SETUP_BUGS.md](SETUP_BUGS.md) — Befund B8: Validator-Auth / SEC-02
- [security/README.md](security/README.md) — SEC-02: sensible Reads brauchen `firm.read`

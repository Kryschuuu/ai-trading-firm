# How-to: LAN weg nach Update (`trading.local` / `192.168.0.10:3369`) + „Firm-Status nicht verfügbar"

> **Kurzfassung:** Nach Update/Setup ist die App nur auf `127.0.0.1` erreichbar und der
> systemd-Dienst crasht mit `EADDRINUSE`. Danach meldet das Dashboard eine
> abgelaufene Sitzung — **nicht** die Datenbank.
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

Die Sitzung gilt **15 Minuten** (`SESSION_TTL_S`) und endet außerdem bei jeder
Secret-Rotation (`FIRM_SESSION_SECRET`) und bei jedem Dienst-Neustart.

---

## Siehe auch

- [HANDBUCH.md](HANDBUCH.md) Kap. 2.4 — Anmeldung und Sitzung im Dashboard
- [INSTALL.md](INSTALL.md) — Kap. 5 Reverse Proxy, Kap. 7 systemd,
  Troubleshooting-Tabelle (`EADDRINUSE 0.0.0.0:3369`, „Sitzung abgelaufen")
- [SETUP_BUGS.md](SETUP_BUGS.md) — Befund B8: Validator-Auth / SEC-02
- [security/README.md](security/README.md) — SEC-02: sensible Reads brauchen `firm.read`

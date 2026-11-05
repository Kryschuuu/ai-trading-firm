# Tailscale + AI-Trading-Firm + Caddy (Docker)

> **Status:** historischer Umsetzungsstand dieser Maschine (Host `data`, 2026-09-20).
> Das Dokument beschreibt den damaligen Weg über Caddy-Docker auf Port `8444`.
>
> **Aktueller Stand (v0.17.4/ASA-08, gilt vorrangig):** Die App bindet **nur noch
> `127.0.0.1:3369`** (`npm run start`, hartes `-H 127.0.0.1`). LAN-Zugriff läuft über
> den `socat`-Forwarder `ai-trading-firm-lan-bridge.service` (`172.20.0.1:3369` →
> `127.0.0.1:3369`, Caddy `trading.local`), Tailnet-Zugriff über
> `tailscale serve --bg --https=8444 http://127.0.0.1:3369`. Ein direkter Zugriff auf
> Port `3369` über die Tailnet-IP ist damit **nicht mehr möglich und nicht vorgesehen**;
> die `0.0.0.0:3369`-Stellen unten sind historisch und dürfen nicht nachgebaut werden.
> Verbindlich: [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md).
>
> **Ziel:** Browser-Dashboard **und** API der ai-trading-firm sicher über das Tailnet
> erreichen — ausschließlich Tailnet-intern, kein `tailscale funnel`, nichts Öffentliches.
>
> **Inhalt:** Setup (Schritte 1–6), DNS-Grundlagen im Tailnet (Schritt 7),
> ausführliche Fehlerbehebung (inkl. `DNS_PROBE_POSSIBLE` / Browser-DNS) und FAQ.

## Überblick

| Baustein | Wert |
|----------|------|
| URL (Browser + API) | `https://data.tail38413e.ts.net:8444/` |
| Tailnet / MagicDNS | `tail38413e.ts.net`, Host `data` |
| Tailnet-IPv4 | `100.122.225.88` |
| Tailnet-IPv6 | `fd7a:115c:a1e0::1001:e1ce` |
| TLS-Zertifikat | `data.tail38413e.ts.net` (Let's Encrypt, automatisch erneuert) |
| Reverse-Proxy | Caddy-Docker `nas-server-proxy-1` (Projekt `nas-server`, Service `proxy`) |
| App | systemd `ai-trading-firm`, `127.0.0.1:3369` (Loopback seit v0.17.4), `NODE_ENV=production` |
| Tailnet-Listener | nur `100.122.225.88:8444` → Caddy → `host.docker.internal:3369` |
| Tailscale-Version (Host) | 1.102.3 |

Architektur:

```
Tailnet-Client (Browser)
   │  HTTPS, Zertifikat für data.tail38413e.ts.net
   ▼
Tailnet-IP 100.122.225.88:8444   (docker publish, nur Tailnet-Interface)
   ▼
Caddy-Container (nas-server-proxy-1)
   │  TLS-Terminierung, X-Verified-IP + X-Forwarded-For, host.docker.internal:3369
   ▼
ai-trading-firm auf dem Host (127.0.0.1:3369, systemd;
  172.20.0.1:3369 liefert der socat-Forwarder ai-trading-firm-lan-bridge.service)
```

## Warum ist HTTPS Pflicht?

Die Session-Cookies sind hart auf `Path=/; Secure; SameSite=Strict` gesetzt
(`src/lib/authSession.ts`, `COOKIE_BASE`). Browser setzen `Secure`-Cookies nur über
HTTPS. Ohne TLS funktioniert der Dashboard-Login nicht; nur die API mit
`x-firm-token`-Header funktioniert (siehe Variante C).

## Ist-Zustand auf dieser Box (Stand 2026-09-20)

- Tailscale läuft als Daemon (Version 1.102.3), Host `data` im Tailnet `tail38413e.ts.net`.
- `tailscale serve` ist bereits aktiv für die **t-bot**-App und belegt auf der
  Tailnet-IP die Ports `443` und `8443` (beide → `http://127.0.0.1:8369`).
- Caddy-Docker (`nas-server-proxy-1`) frontet die NAS-Dienste auf
  `192.168.0.10:80/443` (u. a. `trading.local` → `host.docker.internal:3369`).
- Die ai-trading-firm lauscht seit v0.17.4 (ASA-08) nur auf `127.0.0.1:3369`
  (systemd, hartes `-H 127.0.0.1`). Zum Aufnahmezeitpunkt (2026-09-20) band sie
  noch `0.0.0.0:3369` und war über `http://100.122.225.88:3369` direkt erreichbar
  — das ist bewusst abgeschaltet; die Grants-Policy blockiert Port `3369` zusätzlich.
- Firewall: lokale Stacks inaktiv (`firewalld`, `nftables`, `ufw`).
- MagicDNS ist **tailnet-weit aktiv** (Prüfung: `tailscale dns status` auf `data`).
- `.env`: `FIRM_API_TOKEN`, `FIRM_SESSION_SECRET`, `PORT`, `BITUNIX_ENABLED` gesetzt;
  `AUTH_MODE` nicht gesetzt → `token-required`; `TRUSTED_PROXY_IPS` nicht gesetzt.

## Schritt 1 — Tailscale (vorhanden, prüfen)

Auf dem Host:

```bash
tailscale version
tailscale status
tailscale status --json | jq -r '.MagicDNSSuffix, .Self.DNSName'
tailscale dns status          # zeigt den DNS-Zustand dieses Geräts
```

Erwartet: MagicDNSSuffix `tail38413e.ts.net`, DNSName `data.tail38413e.ts.net.`,
`tailscale dns status` → „Tailscale DNS: enabled" und „MagicDNS: enabled tailnet-wide".
Falls Tailscale fehlt: Installation laut https://tailscale.com/download und danach
`sudo tailscale up`. Wichtig: Im Admin-Konsole unter **DNS → HTTPS Certificates**
muss HTTPS für Zertifikate freigeschaltet sein, sonst liefert `tailscale cert`
keine Zertifikate (siehe Schritt 6). HTTPS-Zertifikate setzen **MagicDNS** voraus.

**Auf jedem Client, der zugreifen soll** (eigenes Kommando!):

```bash
sudo tailscale set --accept-dns=true
sudo systemctl restart tailscaled     # wendet die DNS-Konfiguration neu an
cat /etc/resolv.conf                  # muss den Tailscale-Resolver enthalten
```

`--accept-dns` ist eine **Geräte-Einstellung** und wird pro Client gesetzt — ein
`tailscale set` auf `data` wirkt **nicht** auf andere Geräte. Details siehe Schritt 7.

## Schritt 2 — Tailscale-ACL (Grants-Policy, gespeicherte Fassung)

Im privaten Tailnet gilt standardmäßig „alles erlaubt" — die Umsetzung funktioniert
grundsätzlich auch ohne ACL. Umgesetzt und verifiziert ist die folgende restriktive
Grants-Policy (Admin-Konsole → Access controls, HuJSON): Nur Mitglieder des Tailnets
erreichen den Host `data` auf den Ports `443`/`8443`/`8444`; der direkte API-Port
`3369` bleibt blockiert.

```hujson
{
  "acls": [
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["100.122.225.88"],
      "ip": ["443", "8443", "8444"]
    }
  ],
  // optional: tailscale ssh von allen Mitgliedern
  // { "action": "accept", "src": ["autogroup:member"], "dst": ["100.122.225.88"], "ip": ["22"] },
  "tagOwners": {
    "tag:all": ["kryschuuu@github"]   // derzeit ungenutztes („totes") Tag
  }
}
```

Varianten & Stolperfallen:

- **IPv6:** Sollen IPv6-Clients zugreifen, zusätzliche Regel mit
  `"dst": ["fd7a:115c:a1e0::1001:e1ce"]` (gleiche `ip`-Liste).
- **Schreibweise der Ports:** Das Feld `"ip"` akzeptiert Listen. Falls der Editor
  die Listenform ablehnt, funktioniert auch die Einzelzeichenketten-Form:
  `"ip": ["443,8443,8444"]`. Tailscale validiert die Policy beim Speichern.
- **`autogroup:member`** deckt nur Geräte, die **direkt** Mitglieder dieses Tailnets
  sind. Zugriff über **Tailscale-Sharing** (Geräte aus einem fremden Tailnet)
  erfordert zusätzlich `"autogroup:shared"` in `src`.
- **ACLs blockieren kein DNS:** MagicDNS läuft über die Control-Ebene und wird lokal
  auf jedem Gerät beantwortet — eine zu enge oder fehlerhafte Policy kann
  **niemals** `NXDOMAIN`/`DNS_PROBE_POSSIBLE` verursachen (siehe Schritt 7).
- Restriktive ACLs drosseln auch `tailscale ssh`, `ping` und die Diagnose in der
  Admin-Konsole — schrittweise testen. Details: https://tailscale.com/kb/1018/acls.

## Schritt 3 — Caddy-Docker: Port-Publish, Zertifikate, Vhost

### 3.1 `~/nas-server/docker-compose.yml` (Service `proxy`)

```yaml
proxy:
    image: caddy:latest
    restart: unless-stopped
    ports:
      - "192.168.0.10:80:80"
      - "192.168.0.10:443:443"
      # ai-trading-firm via Tailscale: nur Tailnet-IP (100.122.225.88),
      # Port 8444 -> Caddy -> host.docker.internal:3369
      - "100.122.225.88:8444:8444"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - ./caddy_data:/data
      - ./caddy_config:/config
      # Tailscale-Zertifikate für data.tail38413e.ts.net (tailscaled erneuert
      # sie automatisch); readonly, damit der Container sie nicht ändert.
      - /var/lib/tailscale/certs:/certs:ro
```

Wichtig:

- Der Port-Publish bindet **nur** an die Tailnet-IP; der LAN-Pfad
  (`192.168.0.10:80/443`) bleibt unverändert. Aus dem LAN ist der Tailnet-Listener
  nicht erreichbar.
- Der Docker-Daemon läuft als root und kann `/var/lib/tailscale/certs`
  (root, `0600`) lesbar mounten — der Benutzer muss das Verzeichnis nicht lesen können.
- `host.docker.internal` löst über `host-gateway` auf die Gateway-IP der
  Docker-Bridge auf (nicht `127.0.0.1`!). Da die App seit v0.17.4 nur auf Loopback
  lauscht, braucht dieser Pfad zwingend den Forwarder
  `ai-trading-firm-lan-bridge.service` (`172.20.0.1:3369` → `127.0.0.1:3369`);
  ohne ihn ist der Proxy-Pfad tot. Nicht per Rebind auf `0.0.0.0` „lösen" (ASA-08).
- Freie Ports vorab prüfen: `ss -tln | grep NNNN` (8444 ist frei; `443`/`8443`
  sind durch `tailscale serve`/t-bot belegt).

### 3.2 `~/nas-server/Caddyfile` (Vhost)

```
data.tail38413e.ts.net:8444 {
	tls /certs/data.tail38413e.ts.net.crt /certs/data.tail38413e.ts.net.key

	header {
		Strict-Transport-Security "max-age=63072000"
	}

	reverse_proxy host.docker.internal:3369 {
		header_up X-Verified-IP {remote_host}
	}
}
```

- `tls` liest die von tailscaled aktuell gehaltenen Zertifikatsdateien.
- `header_up X-Verified-IP {remote_host}` überträgt die Tailnet-IP des Clients —
  Grundlage für pro-Client-Rate-Limits der App (aktiver Einsatz: Schritt 4.2).
- `X-Forwarded-For` setzt Caddy automatisch; die App listet ihn in
  `ignoredHeaders` von `/api/auth/me` — erwartet und harmlos.
- Kein WebSocket-Umleitungsbedarf: die App hat keinen serverseitigen
  WebSocket-Endpunkt.

### 3.3 Rollout

```bash
cd ~/nas-server
docker compose up -d proxy
docker logs nas-server-proxy-1 --tail 30   # srv1 auf :8444, kein TLS-Fehler
```

## Schritt 4 — App-Härtung und Rate-Limits

`.env` (gitignored) im Auslieferungszustand weiterhin gültig: `AUTH_MODE` nicht
`local-open`, Tokens und `FIRM_SESSION_SECRET` gesetzt. Hinweis: Jede Änderung an
Auth-Konfiguration oder ein Neustart macht bestehende Sessions ungültig — Clients
müssen sich neu anmelden.

### 4.1 Standard (umgesetzt): gemeinsamer Rate-Limit-Bucket

Ohne `TRUSTED_PROXY_IPS` wird `X-Verified-IP` **ignoriert**: Im App Router ist der
Socket-Peer für die App unsichtbar, und ohne Vertrauens-Flag greift der
fail-closed Bucket `local`. Damit teilen sich alle Clients (LAN + Tailnet) die
Limits (z. B. Credential-Login ~5/min global). Für ein kleines Team ausreichend
und nicht spoofbar.

### 4.2 Optional: pro-Client-Rate-Limits (nur mit Firewall!)

`X-Verified-IP` wird erst akzeptiert, wenn `TRUSTED_PROXY_IPS` gesetzt ist. Da der
Peer im App Router unsichtbar ist, gilt das dann für **jeden** Aufrufer — ein
Client, der `0.0.0.0:3369` direkt erreicht, könnte den Header fälschen
(Befund C2). Deshalb erst absichern:

```bash
# ufw: 3369 nur für Loopback + Docker-Bridge (Caddy kommt über die Bridge-Gateway-IP)
sudo ufw allow from 127.0.0.0/8 to any port 3369 proto tcp
sudo ufw allow from 172.16.0.0/12 to any port 3369 proto tcp
# Rest auf 3369 blockieren (Reihenfolge: allow zuerst, deny zuletzt)
sudo ufw deny 3369/tcp
sudo ufw status numbered
```

Danach im `.env` (danach Neustart):

```bash
# .env — anschließend: sudo systemctl restart ai-trading-firm
TRUSTED_PROXY_IPS=loopback,172.16.0.0/12
```

Erlaubte Aliasse sind `loopback`, `private`, `link-local` (siehe
`src/lib/clientIp.ts`). Nachweis: `/api/auth/me` zeigt im Feld `rateLimitIdentity`
die Tailnet-IP des Clients statt `local`. Hinweis: IPv6-Clients bilden eigene
Buckets (Adress-Literal als Identität).

## Schritt 5 — Verifikation (Ist-Zustand)

### Auf dem Host

```bash
# 1) Health durch den Proxy
curl -sk https://data.tail38413e.ts.net:8444/api/health | jq '{ok, app, version}'

# 2) Zertifikat (Subject + Gültigkeit)
echo | openssl s_client -connect 100.122.225.88:8444 \
  -servername data.tail38413e.ts.net 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates

# 3) Auth-Status (öffentlich, ohne Secrets)
curl -sk https://data.tail38413e.ts.net:8444/api/auth/status | jq '.authMode'

# 4) Login + Secure-Cookie (muss 200 und Set-Cookie liefern)
T=$(grep -E '^FIRM_API_TOKEN=' .env | head -1 | cut -d= -f2-)
echo "{\"token\":\"$T\"}" | curl -sk -D- -o /dev/null -X POST \
  https://data.tail38413e.ts.net:8444/api/auth/login \
  -H 'content-type: application/json' -d @- | grep -iE '^(HTTP|set-cookie)'
```

Erwartet: `"authMode": "token-required"`, Zertifikat mit CN
`data.tail38413e.ts.net` (Let's Encrypt), Login `HTTP/2 200` mit
`set-cookie: firm_session=...; Path=/; Secure; SameSite=Strict; HttpOnly`.
Hinweis: Das Login-Payload-Feld heißt **`token`** (nicht `firmToken`).

### Auf einem Client-Gerät (nach den Hinweisen aus Schritt 7 / Fehlerbehebung)

```bash
tailscale status --json | jq -r .MagicDNSSuffix     # muss "tail38413e.ts.net" sein
nslookup data.tail38413e.ts.net 100.100.100.100     # muss 100.122.225.88 liefern
curl -sk https://data.tail38413e.ts.net:8444/api/health | jq '{ok, app}'
```

Danach Test im Browser: `https://data.tail38413e.ts.net:8444/` → Login-Seite.

## Schritt 6 — Betrieb & Wartung

- **Zertifikats-Erneuerung:** tailscaled verlängert das Zertifikat automatisch vor
  Ablauf und schreibt die Dateien aktualisiert nach `/var/lib/tailscale/certs`.
  Danach Caddy neu laden:
  `docker exec nas-server-proxy-1 caddy reload --config /etc/caddy/Caddyfile`
  (oder `docker restart nas-server-proxy-1`).
  Manuell anstoßen: `sudo tailscale cert data.tail38413e.ts.net`.
- **App-Neustart:** `sudo systemctl restart ai-trading-firm` — danach erneut
  anmelden (Sessions sind ungültig).
- **Logs:** App `journalctl -u ai-trading-firm -f`; Caddy `docker logs -f nas-server-proxy-1`.
- **Port-Änderung:** Zahl im compose-Publish (`100.122.225.88:NNNN:NNNN`), im
  Caddyfile-Vhost und ggf. in der ACL anpassen; dann `docker compose up -d proxy`.
  Freiheit prüfen: `ss -tln | grep NNNN`.
- **Rückbau:** Caddyfile-Block und die zwei neuen compose-Zeilen entfernen, dann
  `docker compose up -d proxy`.

## Schritt 7 — Wie DNS im Tailnet funktioniert (und warum es klemmt)

Diese Grundlagen erklären praktisch alle DNS-Fehlerbilder inkl.
`DNS_PROBE_POSSIBLE`:

1. **MagicDNS ist eine Control-Ebene-Funktion, kein Netzwerk-Dienst.** Jede Maschine
   beantwortet den Namen ihrer Peers **lokal** über die virtuelle Adresse
   `100.100.100.100`. Eine Anfrage an `100.100.100.100` verlässt das eigene Gerät
   **nie** — sie wird vom eigenen `tailscaled` beantwortet. Deshalb kann **keine
   ACL/Grants-Policy** DNS-Auflösung blockieren. Ursache für `NXDOMAIN` ist immer:
   das Gerät kennt den Namen nicht (falsches/fehlendes Tailnet) oder der Resolver
   ist nicht eingebunden.
2. **Tailnet-Namen gelten nur innerhalb des eigenen Tailnets.** `data.tail38413e.ts.net`
   löst nur auf Geräten auf, die Mitglied von `tail38413e` sind. Ein Gerät in einem
   anderen Tailnet (z. B. versehentlich angelegtes zweites Tailnet) bekommt für
   diesen Namen **NXDOMAIN** — und zwar überall, CLI wie Browser.
3. **`--accept-dns` ist eine Pro-Gerät-Einstellung.** Sie steuert, ob das
   Betriebssystem den Tailscale-Resolver (`100.100.100.100`) als DNS-Server
   verwendet. `sudo tailscale set --accept-dns=true` **auf jedem Client einzeln**
   ausführen (nicht auf `data`), danach `sudo systemctl restart tailscaled`.
   Prüfen: `tailscale dns status` → „Tailscale DNS: enabled"; `/etc/resolv.conf`
   enthält `100.100.100.100` (bzw. den systemd-resolved-Stub `127.0.0.53`).
4. **systemd-resolved/NetworkManager:** `nameserver 127.0.0.53` ist normal.
   Tailscaled registriert sich dort per Link-Konfiguration; `.ts.net`-Abfragen
   werden an `100.100.100.100` geroutet. Der Browser nutzt denselben Pfad via
   `getaddrinfo`. CLI-Test auf diesem Pfad: `resolvectl query data.tail38413e.ts.net`.
5. **`tailscale dns status`** auf dem Host zeigt den Zustand der Control-Ebene:
   „MagicDNS: enabled tailnet-wide (suffix = tail38413e.ts.net)" sowie Split-DNS
   (u. a. eine `ts.net.`-Route). Nur „enabled" + gleicher Suffix auf allen
   Geräten → Funktionsvoraussetzung.
6. **Mobile Clients (Android/iOS):** Die Tailscale-App integriert MagicDNS selbst
   in den VPN-Tunnel — Browser funktionieren dort ohne weitere Konfiguration.
   Deshalb klappt z. B. der Aufruf auf dem Redmi sofort, während ein Desktop noch
   konfiguriert werden muss.
7. **HTTPS-Zertifikate setzen MagicDNS voraus** (Admin-Konsole → DNS → HTTPS
   Certificates). Wenn `tailscale cert` fehlschlägt, ist dort der erste Anlaufpunkt.

Kurz: **DNS-Fehler sind nie ein ACL-Problem.** Diagnose-Reihenfolge bei jedem
DNS-Fehler: (a) ist das Gerät im richtigen Tailnet? (b) ist `--accept-dns` auf dem
Gerät aktiv? (c) ist der Browser beteiligt (Secure DNS/Cache)?

## Fehlerbehebung (Troubleshooting)

### Schnell-Check in fixer Reihenfolge

```bash
# 1) Server gesund? (auf dem Host)
curl -sk https://data.tail38413e.ts.net:8444/api/health | jq '.ok'
# 2) Welche Geräte sind im Tailnet? (auf dem Host; erwartet: alle Clients gelistet)
tailscale status
# 3) Suffix + Auflösung auf dem Problem-Gerät
tailscale status --json | jq -r .MagicDNSSuffix
nslookup data.tail38413e.ts.net 100.100.100.100
```

### Fall A — Browser: `DNS_PROBE_POSSIBLE`, aber CLI geht (curl/nslookup ok)

Typisch: `nslookup` und `curl` beantworten, der Browser meldet „DNS-Adresse nicht
gefunden". Ursache ist dann der **Browser selbst**:

- **Secure DNS / DNS-over-HTTPS (DoH)** (Chrome/Chromium/Brave: „Sicheres DNS
  verwenden"; Firefox: „DNS über HTTPS"). Externe DoH-Provider kennen private
  `.ts.net`-Namen nicht → NXDOMAIN, obwohl das System auflösen könnte. Chromium
  aktiviert DoH oft automatisch, wenn der System-Resolver als „unsicher" gilt
  (typisch bei `127.0.0.53`-Stub).
- **Negativer DNS-Cache:** der Browser „erinnert" eine fehlgeschlagene Auflösung
  aus der Zeit, als das Gerät (noch) nicht im Tailnet war.

**Sofort-Test:** Seite im **Inkognito-/Privatfenster** öffnen.
Funktioniert dort → Cache-Problem (Fix B2). Schlägt auch dort fehl → DoH (Fix B1).

**Fix B1 — Secure DNS aus (oder System-Resolver):**

- Chrome/Chromium/Brave: `chrome://settings/security` (Brave: `brave://settings/security`)
  → „Sicheres DNS verwenden" **aus**. Alternativ „Ihren aktuellen Dienst verwenden"
  (kein fester Provider) — auf Linux ohne OS-DoH fällt Chromium dann auf den
  System-Resolver zurück; nicht in jedem Fall zuverlässig.
- Firefox: Einstellungen → Datenschutz & Sicherheit → Netzwerkeinstellungen →
  „DNS über HTTPS aktivieren" **aus**.

**Fix B2 — DNS-Cache leeren:**

```
chrome://net-internals/#dns      → „Clear host cache"   (Brave: brave://net-internals/#dns)
chrome://net-internals/#sockets  → „Flush socket pools"
```

oder Browser komplett beenden und neu starten.

**Fix B3 — Seite trotz aktivem Secure DNS nutzen (ohne DoH zu deaktivieren):**

- `/etc/hosts`-Eintrag auf dem Client — der Browser konsultiert die Hosts-Datei
  **vor** jeder DNS-Abfrage, auch bei DoH:

  ```bash
  echo "100.122.225.88 data.tail38413e.ts.net" | sudo tee -a /etc/hosts
  ```

  Danach Browser-Cache leeren (B2). Das TLS-Zertifikat passt weiterhin, weil der
  Hostname unverändert bleibt. Nachteil: Eintrag manuell pflegen, falls sich die
  Tailnet-IP mal ändert.
- Launch-Flag (testweise, ohne sudo):

  ```bash
  brave --host-resolver-rules="MAP data.tail38413e.ts.net 100.122.225.88" https://data.tail38413e.ts.net:8444/
  ```

  Für Dauerbetrieb: Desktop-Launcher um das Flag ergänzen.

### Fall B — `NXDOMAIN` auch in der CLI (Abfrage an `100.100.100.100`)

Das Gerät ist **nicht (mehr) Mitglied des richtigen Tailnets**:

1. Peers auf dem Host prüfen: `tailscale status` — erscheinen die Client-Geräte?
   Fehlen sie (z. B. nur `data` in der Liste), sind sie in einem anderen Tailnet
   oder nicht mehr angemeldet.
2. Admin-Konsole: oben rechts das **aktive Tailnet** prüfen. Häufig entsteht beim
   Konfigurieren ein zweites Tailnet; die Geräte landen dort.
3. Fix: Auf jedem Zielgerät mit demselben Account anmelden bzw. **„Switch tailnet"**
   auf `tail38413e`; leere überschüssige Tailnets in der Konsole löschen, damit die
   Auswahl eindeutig ist. Danach `sudo tailscale up`.
4. Verifizieren: `tailscale status --json | jq -r .MagicDNSSuffix` → `tail38413e.ts.net`,
   danach `nslookup` → `100.122.225.88`.

### Fall C — Gerät im richtigen Tailnet, aber Name löst nicht auf

`--accept-dns` fehlt oder wurde nicht angewendet:

```bash
sudo tailscale set --accept-dns=true
sudo systemctl restart tailscaled
tailscale dns status        # → „Tailscale DNS: enabled"
cat /etc/resolv.conf        # → 100.100.100.100 bzw. systemd-resolved-Stub
resolvectl query data.tail38413e.ts.net   # → 100.122.225.88
```

Tipp: Nach Tailscale-Updates oder DNS-Änderungen im Konsole einmal `systemctl
restart tailscaled` auf den Clients, damit die neue Konfiguration greift.

### Weitere Fehlerbilder

| Symptom | Ursache | Abhilfe |
|---------|---------|---------|
| Zertifikat fehlt / Caddy lädt Config nicht | HTTPS Certificates im Admin-Konsole nicht aktiv | Aktivieren, dann `sudo tailscale cert data.tail38413e.ts.net`; Config prüfen: `docker exec nas-server-proxy-1 caddy validate --config /etc/caddy/Caddyfile` |
| Browser: „Zertifikat nicht vertrauenswürdig"/TLS-Fehler | falsche URL (IP statt Hostname) oder veraltetes Zertifikat | Nur `https://data.tail38413e.ts.net:8444/` verwenden; Zertifikat prüfen (Schritt 5.2) |
| `EADDRINUSE` nach App-Neustart | alter Prozess hängt noch auf dem Port | `npm run stop` (siehe [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md)) |
| „Sitzung abgelaufen" nach Neustart | normal — Sessions sind serverseitig ungültig | Neu anmelden |
| Keine Secure-Cookies / Login nur über HTTP | falsche URL (Port/HTTPS) oder Proxy ohne TLS | Nur `https://...` verwenden |
| Rate-Limits unerwartet global | `TRUSTED_PROXY_IPS` nicht gesetzt (Standard) | Wenn pro-Client-Buckets gewünscht: Schritt 4.2 (Firewall + Flag) |
| Gerät aus fremdem Tailnet kann nicht zugreifen | Policy deckt nur `autogroup:member` | Zusätzlich `autogroup:shared` in `src` aufnehmen, oder Gerät als Mitglied in `tail38413e` anmelden |
| `tailscale serve status` zeigt 443/8443 → t-bot | Ports sind durch serve belegt | Für die AI-Firma Port 8444 nutzen (umgesetzt) |
| t-bot-Seite unter ts.net-Name liefert `400 DisallowedHost` | Django `ALLOWED_HOSTS` von t-bot kennt den Hostnamen nicht | Harmlos für die AI-Firma; betrifft nur t-bot — `ALLOWED_HOSTS` dort ggf. erweitern |
| `MagicDNSSuffix` leer auf einem Gerät | Gerät ist kein Tailnet-Mitglied oder Tailscaled nicht (neu) gestartet | Fall B oben; `sudo tailscale up` |

## FAQ

**Welche URL ist richtig?**
`https://data.tail38413e.ts.net:8444/` — Browser-Dashboard **und** API. Öffne die
App-URL im Browser; API-Pfade hängen an: `/api/health`, `/api/auth/status`,
`/api/auth/me` u. a.

**Warum nicht Port 443?**
`443` und `8443` sind durch `tailscale serve` für t-bot belegt. Der Port ist frei
wählbar; Hinweis: restriktive Firmennetze öffnen oft nur 443.

**Wo muss `--accept-dns=true` gesetzt werden?**
Auf jedem Client einzeln (`sudo tailscale set --accept-dns=true`), nicht auf dem
Server. Es ist eine Geräte-Einstellung. Danach `systemctl restart tailscaled`.

**Kann die ACL den DNS-Fehler verursachen?**
Nein. MagicDNS wird lokal (virtuelle IP `100.100.100.100`) und über die
Control-Ebene bedient — Policies regeln nur Netzwerk-Traffic. `NXDOMAIN` heißt
immer: Gerät kennt den Namen nicht (falsches Tailnet) oder Resolver nicht aktiv.

**CLI geht, Browser nicht — woran liegt das?**
An „Sicheres DNS" (DoH) bzw. einem negativen DNS-Cache im Browser. Test im
Inkognito-Fenster; Abhilfe siehe Fall A. Robust auch mit DoH: `/etc/hosts`-Eintrag.

**Warum funktioniert es auf Android (Redmi), aber nicht auf dem Desktop?**
Die mobile App integriert MagicDNS in den VPN-Tunnel; der Desktop braucht die
OS-Resolver-Konfiguration (`--accept-dns`) plus ggf. Browser-Anpassung.

**Was, wenn ein Gerät im anderen Tailnet gelandet ist?**
Console → aktives Tailnet prüfen, Gerät wieder unter `tail38413e` anmelden bzw.
„Switch tailnet"; leere Extra-Tailnets löschen (Fall B).

**Kann ich über die IP statt über den Namen zugreifen?**
Nicht sinnvoll: das Let's-Encrypt-Zertifikat gilt nur für
`data.tail38413e.ts.net`. Ein Zugriff per IP erzwingt Zertifikatswarnungen.
Löse den Namen (Fall A/B/C), dann funktioniert TLS korrekt.

**Wie erneuere ich das Zertifikat?**
Automatisch durch tailscaled; nach Erneuerung Caddy neu laden:
`docker exec nas-server-proxy-1 caddy reload --config /etc/caddy/Caddyfile`.
Manuell: `sudo tailscale cert data.tail38413e.ts.net`.

**Was passiert nach einem App-Neustart?**
Alle Sessions sind ungültig — Clients melden sich neu an. Die Tokens
(`FIRM_API_TOKEN` etc.) bleiben gültig.

**Warum kein `tailscale funnel`?**
Funnel macht den Dienst öffentlich im Internet. Ziel hier ist ausschließlich
Tailnet-interner Zugriff.

**Kann ich den Zugriff pro Gerät einschränken?**
Ja — über die Grants-Policy (Schritt 2) statt `autogroup:member` konkrete
Geräte-IDs in `src` listen. Für Geräte aus fremden Tailnets `autogroup:shared`.

**Gilt eine ACL-Änderung sofort?**
Ja, nach dem Speichern in der Console. Eine CLI/App-Neuverbindung auf den Geräten
(oder kurz warten) kann bei hartnäckigen Verbindungen nötig sein.

## Optionen & Varianten

| Variante | Zugriff | TLS / Session-Login | Aufwand |
|----------|---------|---------------------|---------|
| **A. Caddy-Docker auf Tailnet-Port (umgesetzt)** | `https://data.tail38413e.ts.net:8444/` | ja / ja | einmalig konfigurieren |
| B. tailscale serve (ohne Caddy) | `https://data.tail38413e.ts.net:8445/` | ja / ja | 1 Befehl, sudo |
| C. Direkter Zugriff (nur API) — **entfallen seit v0.17.4** | `http://data.tail38413e.ts.net:3369/` | nein / nein | — |

- **B (tailscale serve):** `sudo tailscale serve --bg --https=8445 http://127.0.0.1:3369`
  (Port 8445 frei wählen; `443`/`8443` sind durch t-bot belegt). Liefert kein
  `X-Verified-IP` → Bucket bleibt `local`. Konfiguration anzeigen:
  `tailscale serve status`. Details: https://tailscale.com/kb/1311/tailscale-serve.
- **C (nur API):** entfällt seit v0.17.4 — die App lauscht nur auf `127.0.0.1:3369`
  (ASA-08); ein direkter Port-Zugriff ist weder erreichbar noch gewollt.
  Secure-Cookies werden über HTTP ohnehin nicht gesetzt → Dashboard-Login unmöglich.
- **Warum kein Pfad-Präfix?** Next.js referenziert Assets absolut (`/_next/...`);
  ein Unterpfad würde Assets und API-Routen brechen (ein `basePath` müsste bereits
  im Build gesetzt sein).

## Sicherheits-Hinweise

- Kein `tailscale funnel` verwenden — das macht den Dienst öffentlich.
- `TRUSTED_PROXY_IPS` **nur** mit aktiver Firewall setzen (Befund C2, Schritt 4.2).
- `.env.bak-*` im Repo-Root enthalten Credentials und sind untracked — niemals
  committen.
- `AUTH_MODE=local-open` ist für diese Freigabe unzulässig; Tokens und
  `FIRM_SESSION_SECRET` bleiben gesetzt.
- `--accept-dns` und der `/etc/hosts`-Workaround sind reine Client-Einstellungen —
  sie weiten den Zugriff nicht aus. Der Zugriff bleibt über die Grants-Policy
  (Schritt 2) begrenzt.
- Tailnet-IP beim `/etc/hosts`-Workaround niemals hardcoden, wenn das Gerät
  zukünftig neu registriert werden könnte — die IP ist stabil, kann sich aber bei
  Neu-Registrierung ändern (dann Eintrag in beiden Richtungen prüfen).
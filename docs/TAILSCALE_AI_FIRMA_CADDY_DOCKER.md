# Tailscale + AI-Trading-Firm + Caddy (Docker)

> **Status:** auf dieser Maschine umgesetzt und verifiziert (Host `data`, 2026-09-20).
>
> **Ziel:** Browser-Dashboard **und** API der ai-trading-firm sicher über das Tailnet
> erreichen — ausschließlich Tailnet-intern, kein `tailscale funnel`, nichts Öffentliches.

## Überblick

| Baustein | Wert |
|----------|------|
| URL (Browser + API) | `https://data.tail38413e.ts.net:8444/` |
| Tailnet / MagicDNS | `tail38413e.ts.net`, Host `data` |
| Tailnet-IPv4 | `100.122.225.88` |
| TLS-Zertifikat | `data.tail38413e.ts.net` (Let's Encrypt, automatisch erneuert) |
| Reverse-Proxy | Caddy-Docker `nas-server-proxy-1` (Projekt `nas-server`, Service `proxy`) |
| App | systemd `ai-trading-firm`, `0.0.0.0:3369`, `NODE_ENV=production` |
| Tailnet-Listener | nur `100.122.225.88:8444` → Caddy → `host.docker.internal:3369` |

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
ai-trading-firm auf dem Host (0.0.0.0:3369, systemd)
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
- Die ai-trading-firm läuft auf `0.0.0.0:3369` (systemd) und ist damit **direkt**
  auch unter `http://100.122.225.88:3369` im Tailnet erreichbar — ohne TLS (nur API).
- Firewall: lokale Stacks inaktiv (`firewalld`, `nftables`, `ufw`).
- `.env`: `FIRM_API_TOKEN`, `FIRM_SESSION_SECRET`, `PORT`, `BITUNIX_ENABLED` gesetzt;
  `AUTH_MODE` nicht gesetzt → `token-required`; `TRUSTED_PROXY_IPS` nicht gesetzt.

## Schritt 1 — Tailscale (vorhanden, prüfen)

```bash
tailscale version
tailscale status
tailscale status --json | jq -r '.MagicDNSSuffix, .Self.DNSName'
```

Erwartet: MagicDNSSuffix `tail38413e.ts.net`, DNSName `data.tail38413e.ts.net.`.
Falls Tailscale fehlt: Installation laut https://tailscale.com/download und danach
`sudo tailscale up`. Wichtig: Im Admin-Konsole unter **DNS → HTTPS Certificates**
muss HTTPS für Zertifikate freigeschaltet sein, sonst liefert `tailscale cert`
keine Zertifikate (siehe Schritt 6).

## Schritt 2 — Tailscale-ACL (optional, Ein-Nutzer-Tailnet)

Im privaten Tailnet gilt standardmäßig „alles erlaubt" — die Umsetzung funktioniert
ohne ACL-Änderung. Soll der Zugriff künftig auf bestimmte Geräte begrenzt werden
(Admin-Konsole → Access controls, HuJSON):

```hujson
{
  "acls": [
    {
      "action": "accept",
      "src": ["<TAG-ODER-GERAETE-ID>"],
      "dst": [
        "100.122.225.88:8444", // ai-trading-firm (Caddy)
        "100.122.225.88:443",  // t-bot (tailscale serve)
        "100.122.225.88:8443"  // t-bot (tailscale serve)
      ]
    }
  ]
}
```

ACHTUNG: restriktive ACLs drosseln auch `tailscale ssh`, `ping` und die Diagnose in
der Admin-Konsole — schrittweise testen. Details: https://tailscale.com/kb/1018/acls.

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
  Docker-Bridge auf (nicht `127.0.0.1`!). Wer die App später nur an Loopback
  bindet, bricht diesen Pfad — deshalb Lösen per Firewall (Schritt 4.2), nicht per
  Rebind.

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

## Optionen & Varianten

| Variante | Zugriff | TLS / Session-Login | Aufwand |
|----------|---------|---------------------|---------|
| **A. Caddy-Docker auf Tailnet-Port (umgesetzt)** | `https://data.tail38413e.ts.net:8444/` | ja / ja | einmalig konfigurieren |
| B. tailscale serve (ohne Caddy) | `https://data.tail38413e.ts.net:8445/` | ja / ja | 1 Befehl, sudo |
| C. Direkter Zugriff (nur API) | `http://data.tail38413e.ts.net:3369/` | nein / nein | 0 |

- **B (tailscale serve):** `sudo tailscale serve --bg --https=8445 http://127.0.0.1:3369`
  (Port 8445 frei wählen; `443`/`8443` sind durch t-bot belegt). Liefert kein
  `X-Verified-IP` → Bucket bleibt `local`. Konfiguration anzeigen:
  `tailscale serve status`. Details: https://tailscale.com/kb/1311/tailscale-serve.
- **C (nur API):** funktioniert heute schon, weil die App auf `0.0.0.0:3369`
  lauscht. Secure-Cookies werden über HTTP nicht gesetzt → Dashboard-Login unmöglich.
- **Warum nicht Port 443?** `443` und `8443` sind durch `tailscale serve` für t-bot
  belegt. Der Port ist frei wählbar; Hinweis: restriktive Firmennetze öffnen oft
  nur 443.
- **Warum kein Pfad-Präfix?** Next.js referenziert Assets absolut (`/_next/...`);
  ein Unterpfad würde Assets und API-Routen brechen (ein `basePath` müsste bereits
  im Build gesetzt sein).

## Fehlerbehebung

- **Zertifikat fehlt / Caddy lädt Config nicht:** HTTPS Certificates im
  Admin-Konsole aktivieren, dann `sudo tailscale cert data.tail38413e.ts.net`;
  Config prüfen:
  `docker exec nas-server-proxy-1 caddy validate --config /etc/caddy/Caddyfile`.
- **`EADDRINUSE` nach App-Neustart:** ein alter Prozess hängt noch auf
  `127.0.0.1` — `npm run stop` (siehe
  [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md)).
- **„Sitzung abgelaufen" nach Neustart:** normal, neu anmelden.
- **Keine Secure-Cookies / Login nur über HTTP:** falsche URL (Port/HTTPS) oder
  ein Proxy ohne TLS — nur `https://...` verwenden.
- **Rate-Limits unerwartet global:** Schritt 4.2 ausführen (Firewall +
  `TRUSTED_PROXY_IPS`), wenn pro-Client-Buckets gewünscht sind.

## Sicherheits-Hinweise

- Kein `tailscale funnel` verwenden — das macht den Dienst öffentlich.
- `TRUSTED_PROXY_IPS` **nur** mit aktiver Firewall setzen (Befund C2, Schritt 4.2).
- `.env.bak-*` im Repo-Root enthalten Credentials und sind untracked — niemals
  committen.
- `AUTH_MODE=local-open` ist für diese Freigabe unzulässig; Tokens und
  `FIRM_SESSION_SECRET` bleiben gesetzt.
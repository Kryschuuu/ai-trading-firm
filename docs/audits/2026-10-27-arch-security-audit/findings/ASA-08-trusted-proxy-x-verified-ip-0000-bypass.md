# ASA-08 — IP-Spoofing über `X-Verified-IP`, sobald `TRUSTED_PROXY_IPS` gesetzt ist und Next.js auf `0.0.0.0:3369` lauscht

- **ID:** ASA-08
- **Severity:** HIGH
- **Bereich:** Sicherheit (Netzwerk / Rate-Limit-Bypass)
- **Status:** OPEN
- **Datei(en):** `src/lib/clientIp.ts:409-425`, `src/lib/clientIp.ts:535-565`, `package.json:13`, `deploy/ai-trading-firm.service:18`, `scripts/auth-boot-guard.ts`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md`](../prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md)

## Beschreibung

Wenn der Betreiber `TRUSTED_PROXY_IPS` setzt, vertraut `extractClientIp()` im Next.js-App-Router bedingungslos jedem vom Client gesendeten Header `X-Verified-IP`, weil die Web-Standard-`Request`-Instanz keine TCP-Socket-Peer-IP trägt (`peerIp === null`) und der Code `if (peerTrusted !== false)` prüft (`null !== false` ist `true`). Da `npm run start` gleichzeitig standardmäßig auf `-H 0.0.0.0` bindet, kann jeder direkt verbindende Client im selben Netz seine Quell-IP beliebig fälschen und Login-/API-Rate-Limits komplett umgehen.

## Technischer Nachweis

1. `peerIpFromRequest(request)` (`src/lib/clientIp.ts:409-425`) liefert für reguläre Fetch-`Request`-Objekte von Next.js immer `null`.
2. In `extractClientIp()` (`src/lib/clientIp.ts:546-555`):
   - `const peerTrusted = peerIp !== null ? isIpInCidrs(peerIp, config.trustedProxyCidrs) : null;`
   - `if (peerTrusted !== false)` ist für `peerTrusted === null` **immer wahr**, sobald `trustedProxyCidrs.length > 0` ist.
3. `package.json:13` definiert `"start": "next start -p 3369 -H 0.0.0.0"`, sodass Port `3369` nicht auf `127.0.0.1` beschränkt ist.

## Konkreter Lösungsvorschlag

1. **Default-Bind auf Loopback (`127.0.0.1`) ändern:** `package.json` (`next start -p 3369 -H 127.0.0.1`) und `deploy/ai-trading-firm.service` binden standardmäßig nur lokal; externe Erreichbarkeit läuft kontrolliert über den Reverse-Proxy oder expliziten Host-Override.
2. **Fail-Closed bei fehlender Socket-IP (`src/lib/clientIp.ts`):** Wenn `peerIp === null` ist, dürfen Proxy-Header (`X-Verified-IP` / `X-Forwarded-For`) **nicht** allein wegen `TRUSTED_PROXY_IPS` akzeptiert werden, es sei denn, der Reverse-Proxy authentifiziert sich zusätzlich mit einem konstanten Zeitvergleich gegen ein gemeinsames Proxy-Secret-Header-Paar oder der Boot-Guard bestätigt explizites Loopback-Binding.
3. Dokumentation in `CONFIGURATION.md` und `.env.example` samt `npm run docs:inventories` synchron nachziehen.

## Akzeptanzkriterien / Verifikation

- [ ] Ein Fetch-`Request` ohne Socket-Peer (`peerIp === null`), aber mit gesetztem `TRUSTED_PROXY_IPS="127.0.0.1/32"` und gefälschtem `X-Verified-IP: 203.0.113.9` wird **nicht** als vertrauenswürdige Client-IP akzeptiert, solange kein gültiger Proxy-Nachweis / Loopback-Modus vorliegt.
- [ ] `npm run start` bindet standardmäßig auf `127.0.0.1` statt `0.0.0.0`.
- [ ] Regressionstest `tests/asa08.clientIpProxyTrust.test.ts`, `npm run docs:inventories:check` und `npm run docs:validate` grün.

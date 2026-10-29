# ASA-08 — IP-Spoofing über `X-Verified-IP`, sobald `TRUSTED_PROXY_IPS` gesetzt ist und Next.js auf `0.0.0.0:3369` lauscht

- **ID:** ASA-08
- **Severity:** HIGH
- **Bereich:** Sicherheit (Netzwerk / Rate-Limit-Bypass)
- **Status:** FIXED (v0.17.4, 2026-10-28)
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

- [x] Ein Fetch-`Request` ohne Socket-Peer (`peerIp === null`), aber mit gesetztem `TRUSTED_PROXY_IPS="127.0.0.1/32"` und gefälschtem `X-Verified-IP: 203.0.113.9` wird **nicht** als vertrauenswürdige Client-IP akzeptiert, solange kein gültiger Proxy-Nachweis / Loopback-Modus vorliegt.
- [x] `npm run start` bindet standardmäßig auf `127.0.0.1` statt `0.0.0.0`.
- [x] Regressionstest `tests/asa08.clientIpProxyTrust.test.ts`, `npm run docs:inventories:check` und `npm run docs:validate` grün.


## Umsetzung (v0.17.4, 2026-10-28)

- Im aktuellen Checkout heißt die SSoT `resolveClientIp`, der konstante Zeitvergleich `tokenEquals` (`src/lib/tokenCompare.ts`). Fetch-Peers benötigen gültige CIDRs **und** `TRUSTED_PROXY_SECRET` / `X-Proxy-Secret`; kein Vertrauen allein durch `HOSTNAME` oder Loopback-CIDRs. XFF bleibt dem echten Socket-Pfad vorbehalten. Bekannte Peers müssen weiterhin exakt in der CIDR-Liste liegen; das Secret überstimmt keinen Miss.
- Secret-Format: 32–256 sichtbare ASCII-Zeichen ohne Leerzeichen/Komma, unabhängig erzeugt (`openssl rand -hex 32`), keine Normalisierung. Doppelte Header werden abgelehnt. Keine Secret-Werte in Diagnose oder Boot-Logs.
- `assertProxyTrustConfigured` läuft im CLI-Boot-Guard und in der Instrumentation vor dem Start der Hintergrundarbeit. Bei gesetzten CIDRs ohne gültiges Secret wird **auch auf Loopback** abgebrochen; Builds sind ausgenommen. Requestpfad bleibt bei umgangenem Guard fail-closed.
- `npm start` und systemd binden explizit an `127.0.0.1`; Port 3369 bleibt Default, `PORT` bleibt überschreibbar. Die frühere Darstellung des Startskripts oben ist historische Befund-Evidenz.
- Regressionen: `tests/asa08.clientIpProxyTrust.test.ts`, `tests/authBootGuard.proxyTrust.test.ts`, migrierte `tests/clientIp.test.ts`. Der aktuelle Login hat keine separate `checkLoginAllowed`-Funktion: der echte `POST /api/auth/login`-Handler nutzt `checkRateLimit(max: 20)` und liefert trotz wechselnder Spoofing-IP ab Versuch 21 HTTP 429.
- Dauerhaftes Gate: `npm run test:security:asa08` ist Teil von `npm run security:live-gate`.
- Upgrade/Rotation/Netzgrenzen: [`CONFIGURATION.md`](../../../../CONFIGURATION.md) und [`docs/INSTALL.md`](../../../INSTALL.md). Shared Secret ist ein Bearer-Nachweis (kein Replay-Schutz bei Secret-Leak); Upstream nur Loopback oder geschützter TLS-/Tunnel-Kanal. Kein Live-Trading aktiviert, keine Datenbankmigration.

Prüfergebnisse, Produktions-Smoke und Resthinweise: [ASA-08-Verifikation](../remediation/ASA-08-VERIFICATION.md).

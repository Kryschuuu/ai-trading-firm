# PROMPT-ASA-P1-07 — `X-Verified-IP`-Proxy-Spoofing schließen & Loopback-Bind härten

- **Befund:** [`../findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md`](../findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) (`HIGH`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js App Router).

AUFGABE: Behebe vollständig den Sicherheitsbefund `ASA-08` (IP-Spoofing und Rate-Limit-Bypass über `X-Verified-IP`, sobald `TRUSTED_PROXY_IPS` gesetzt ist, weil `peerIpFromRequest(request)` im Next.js-App-Router `null` liefert und `package.json` standardmäßig auf `-H 0.0.0.0` bindet).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md`
2. `src/lib/clientIp.ts` (komplett lesen, insb. `peerIpFromRequest` Zeilen 405–430 und `extractClientIp` Zeilen 525–580)
3. `scripts/auth-boot-guard.ts` und `src/instrumentation.ts`
4. `package.json` (`scripts.start`), `deploy/ai-trading-firm.service`, `CONFIGURATION.md`, `.env.example`, `docs/INSTALL.md`
5. Bestehende Tests: `tests/clientIp*.test.ts`, `tests/loginRateLimit*.test.ts`, `tests/authBootGuard*.test.ts`

URSACHE DES BYPASSES:
- Im Next.js-App-Router übergibt die Runtime Standard-Fetch-`Request`-Objekte ohne Node-TCP-Socket; `peerIpFromRequest(request)` gibt daher fast immer `null` zurück.
- In `src/lib/clientIp.ts:546` wird `peerTrusted` bei `peerIp === null` auf `null` gesetzt, und `if (peerTrusted !== false)` wertet zu `true` aus!
- Sobald `TRUSTED_PROXY_IPS` gesetzt ist, vertraut der Server somit jedem beliebigen `X-Verified-IP`-Header, auch von Clients, die direkt Port `3369` ansprechen (weil `npm run start` auf `-H 0.0.0.0` lauscht). Damit lassen sich Login-Lockouts (`POST /api/auth/login`) und API-Rate-Limits durch Rotation von `X-Verified-IP` komplett umgehen.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Sicheres Standard-Binding auf Loopback (`127.0.0.1`):
   - Ändere in `package.json` das Produktions-Startskript auf Loopback-Default (`next start -p 3369 -H 127.0.0.1`) und stelle sicher, dass `deploy/ai-trading-firm.service` ebenfalls explizit an `127.0.0.1` bindet (ein vorgelagerter Reverse-Proxy auf demselben Host erreicht `127.0.0.1:3369`, externe LAN-Clients jedoch nicht direkt am Proxy vorbei).

2. Fail-Closed-Verifikation in `src/lib/clientIp.ts`, wenn `peerIp === null` ist:
   - Wenn `peerIp !== null` ist (z. B. direkter Node-Socket in Tests/Custom-Server), bleibt die exakte CIDR-Prüfung `isIpInCidrs(peerIp, config.trustedProxyCidrs)` maßgeblich (`true` nur bei Match, sonst `false`).
   - Wenn `peerIp === null` ist (Next.js Fetch-`Request`), darf ein weitergeleiteter IP-Header (`X-Verified-IP` / `X-Forwarded-For`) NICHT mehr stillschweigend allein wegen `trustedProxyCidrs.length > 0` akzeptiert werden!
   - Führe stattdessen einen kryptographischen Proxy-Authentifizierungsmechanismus ein: z. B. ein optionales gemeinsames Geheimnis `TRUSTED_PROXY_SECRET` (geprüft über den bestehenden konstanten Zeitvergleich `constantTimeTokenEquals` aus `src/lib/tokenCompare.ts` gegen den Header `x-proxy-secret`), ODER wenn nur `TRUSTED_PROXY_IPS` ausschließlich aus Loopback-CIDRs (`127.0.0.0/8`, `::1/128`) besteht UND der Server nachweislich nur an Loopback (`HOSTNAME=127.0.0.1` / `::1`) gebunden ist.
   - Prüfe im `auth-boot-guard` (`scripts/auth-boot-guard.ts` / Boot-Check): Wenn `TRUSTED_PROXY_IPS` gesetzt ist, der Server aber nicht auf Loopback gebunden ist und kein `TRUSTED_PROXY_SECRET` gesetzt ist, gib eine klare Fail-Closed-Fehlermeldung bzw. Sicherheitswarnung aus, damit kein unsicherer Mischbetrieb startet.
   - Achte strikt auf alle Doku-Wächter (`scripts/docs-validate-checks.ts` L1/L2 + `scripts/gen-docs-inventories.ts`): Jedes neue `process.env.*`-Flag MUSS gleichzeitig in `.env.example` und in der Flag-Tabelle von `CONFIGURATION.md` dokumentiert und anschließend via `npm run docs:inventories` in `docs/generated/env-inventory.md` aufgenommen werden! (Achte in Tests/Doku darauf, keine echt aussehenden Beispiel-Geheimnisse ohne spitze Klammern zu schreiben, die den Secret-Scanner in `docs-validate` triggern — nutze Platzhalter wie `<zufaelliges-32-byte-hex>` oder `'dummy'`).

3. Bestehende `clientIp`-Tests prüfen & Audit-Tracking nachziehen:
   - Lies `tests/clientIp*.test.ts` genau, verstehe welche Szenarien dort geprüft werden, migriere sie sauber auf die gehärtete Semantik und ergänze die neuen Spoofing-Abwehrtests.
   - Setze `ASA-08` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md`, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa08.clientIpProxyTrust.test.ts`:
   - Fetch-`Request` (`peerIp === null`) mit `TRUSTED_PROXY_IPS="10.0.0.0/8"` und `X-Verified-IP: 198.51.100.42` OHNE gültiges `x-proxy-secret` -> Spoofed-IP wird verworfen (keine Umgehung von `checkLoginAllowed` / `checkRateLimit` durch Header-Rotation möglich!).
   - Fetch-`Request` mit gültigem `TRUSTED_PROXY_SECRET` + passendem `x-proxy-secret`-Header -> `X-Verified-IP` wird akzeptiert; falsches Secret -> verworfen.
   - Request mit realer Socket-Peer-IP außerhalb `TRUSTED_PROXY_IPS` -> `X-Verified-IP` wird selbst mit Header verworfen.
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa08.clientIpProxyTrust.test.ts tests/clientIp*.test.ts tests/authBootGuard*.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:inventories && npm run docs:inventories:check`
   - `npm run docs:validate`
   - `npm test`
```

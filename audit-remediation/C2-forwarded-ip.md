# C2 — IP-basierte Rate-Limits vertrauen spoofbaren Proxy-Headers

- **Severity:** MEDIUM/HIGH
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **Gefixt v.1.36.14** — Befund war valide (Audit 2026-09-03); Fix in
  `src/lib/clientIp.ts` (neu: Trusted-Proxy-Modell, `resolveClientIp`, rightmost-untrusted),
  `src/lib/apiAuth.ts` (`clientKey` nutzt die geteilte Auflösung), `src/brokers/control-plane/guard.ts`
  (`credentialClientKey` dieselbe Quelle + globales Limit + Backoff), `src/brokers/control-plane/config.ts`
  (neue Flags/Konstanten), `src/app/api/brokers/[venue]/credentials/route.ts` (Fehlversuch-Meldung),
  `src/app/api/auth/me/route.ts` (`rateLimitIdentity`), `scripts/auth-boot-guard.ts` +
  `src/instrumentation.ts` (Policy-Zeile/Warnungen im Boot-Log).
  Doku: `INSTALL.md` („Rate-Limit-Identität“), `docs/INSTALL.md` (Kapitel 5.1/7.3/11), `.env.example`,
  `docs/help/ops.help.json` (`auth.clientIp`, `rateLimit.credential`, Version 5),
  `docs/SECURITY_AUDIT.md`, `docs/FRONTEND_CONTROL_PLANE.md`, `docs/BROKER_ARCHITECTURE.md`,
  `docs/LIVE_TRADING.md`, `docs/HANDBUCH.md`, `deploy/ai-trading-firm.service`.
  Tests: `tests/clientIp.test.ts` (26 Fälle) + `tests/controlPlane.bruteforce.test.ts` (22 Fälle).
- **Datei(en):** `src/lib/apiAuth.ts` (`clientKey` L55‑58), `src/brokers/control-plane/guard.ts` (`credentialClientKey` L73‑74)

## Arena-Prompt (kopierbar)

```
TASK: Stop trusting spoofable x-forwarded-for / x-real-ip for rate-limit client identity.

PROBLEM: clientKey()/credentialClientKey() take the leftmost x-forwarded-for (or x-real-ip) as the
client identity. Behind a misconfigured proxy an attacker can send a fresh X-Forwarded-For per request
and bypass the per-IP rate limit.

DO:
1. Add config: TRUSTED_PROXY_IPS (CIDR list) and a dedicated, proxy-set header (e.g. x-verified-ip)
   that ONLY the reverse proxy may set. The app trusts x-verified-ip, never raw x-forwarded-for.
2. clientKey(req):
     - if TRUSTED_PROXY_IPS is configured: trust x-forwarded-for ONLY if the immediate peer is in the
       trusted set (verify via the socket/conn remote addr when available; in Next.js prefer a
       proxy-set x-verified-ip). Otherwise ignore x-forwarded-for.
     - else: use x-verified-ip if present, else fall back to a stable server-side identifier
       (connection remote address if accessible, otherwise a per-process constant "local").
3. Apply the SAME helper to credentialClientKey in guard.ts (extract a shared resolveClientIp()).
4. Add defense-in-depth: combine IP limit + global account limit + exponential backoff for credential
   brute-force (already partially present); ensure the global account limit does not rely on the IP.

ACCEPTANCE: Sending X-Forwarded-For: 1.2.3.4 does NOT change the rate-limit bucket unless the proxy
trust is configured AND the verified header is used; unit test shows spoofed header is ignored by default.
```

## Beweis (Code vor dem Fix)

`src/lib/apiAuth.ts` L55‑58:

```ts
const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
const real = req.headers.get("x-real-ip")?.trim();
return fwd || real || "local";
```

## Fix-Spezifikation (umgesetzt v1.36.14)

**Eine Quelle für die Identität, Vertrauen kommt aus Konfiguration.**

1. `src/lib/clientIp.ts` (neu, Blatt-Modul ohne Imports) ist die SSoT: `resolveClientIp(req, opts)`
   liefert `{ key, ip, source, peerIp, peerTrusted, trustedProxiesConfigured, ignoredHeaders }`
   und wirft nie (Requestpfad). Eigenes IP-/CIDR-Parsing (IPv4, IPv6 inkl. `::`-Kompression,
   IPv4-mapped `::ffff:a.b.c.d`, Zone-ID, Ablehnung führender Nullen) — gruppenbasiert statt
   `BigInt`, weil das Projekt auf `target: ES2017` steht.
2. **`TRUSTED_PROXY_IPS`** (CIDR-Liste, Komma/Semikolon/Whitespace; Aliase `loopback`, `private`,
   `link-local`) ist der einzige Vertrauensanker. Unparsebare Einträge werden verworfen **und**
   im Boot-Log gemeldet (`clientIpPolicyWarnings`); `0.0.0.0/0` bzw. `::/0` erzeugt eine laute
   Warnung, weil das der Rückfall in C2 wäre. Bewusst kein `all`-Alias.
3. **Header-Policy, in dieser Reihenfolge:**
   1. `x-verified-ip` — der proxy-gesetzte Header. Akzeptiert bei wirksamem Proxy-Vertrauen
      (`TRUSTED_PROXY_IPS` gesetzt; Peer entweder unbekannt oder in der Liste) **oder** ohne
      Konfiguration bei nachweislichem Loopback-Peer (Same-Host-Proxy). Ein Wert, der mehrfach
      gesetzt/kommasepariert/unparsebar ist, wird verworfen (fail-closed) — „Proxy überschreibt
      nicht sauber“ darf nie zu einer freien Bucket-Wahl führen.
   2. `x-forwarded-for` — **nur**, wenn `TRUSTED_PROXY_IPS` gesetzt ist **und** die
      Socket-Remote-Adresse des direkten Peers darin liegt. Auswertung **rightmost-untrusted**:
      von rechts alle vertrauenswürdigen Proxys überspringen, erstes fremdes Element = Client.
      Eine vorgeschobene Fake-IP ist damit wertlos, weil der Proxy die echte Peer-Adresse anhängt.
      Im Next.js-App-Router ist die Socket-Adresse nicht sichtbar ⇒ dieser Pfad bleibt aus,
      genau dafür ist `x-verified-ip` da (Prompt: „in Next.js prefer a proxy-set x-verified-ip“).
   3. `x-real-ip` — **nie** Identität (genauso client-setzbar), höchstens Eintrag in
      `ignoredHeaders`.
   4. Server-seitiger Fallback: Socket-Remote-Adresse (`peerIpFromRequest`, bzw. explizit
      `opts.peerIp` für eigene Node-Server/Adapter), sonst die Prozess-Konstante `local`
      — alle Clients teilen sich dann **einen** Bucket: enger, nie weiter.
4. **Geteilter Helfer statt Doppelimplementierung (Prompt-Punkt 3):** `clientKey()` in
   `src/lib/apiAuth.ts` und `credentialClientKey()` in `src/brokers/control-plane/guard.ts`
   rufen beide `clientRateLimitKey(req, { peerIp, env })`. Beide Limiter akzeptieren jetzt
   `peerIp` als Option, damit ein eigener Node-Server die echte Socket-Adresse durchreichen kann.
5. **Verteidigung in der Tiefe (Prompt-Punkt 4), Credential-Pfad dreistufig:**
   * Ebene 1 `BROKER_CREDENTIAL_RATE_LIMIT` (Default 5/min) pro Client-Identität — unverändert,
     aber mit nicht mehr spoofbarer Identität.
   * Ebene 2 `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT` (Default 20/min) auf dem **festen** Bucket
     `global` — IP-unabhängig per Konstruktion, deckelt verteiltes Raten (Proxy-Wechsel, NAT,
     Botnet). Läuft hinter Ebene 1, damit ein einzelner Flooder das globale Budget nicht füllen
     und so legitime Admins aussperren kann (DoS auf die Sicherheitsschicht).
   * Ebene 3 exponentieller Backoff (`credentialBackoffMs`, Schwelle 3, Basis 2 s, Faktor 2,
     Deckel 15 min, Ruhe-Reset 15 min): `POST /api/brokers/{venue}/credentials` meldet
     Fehlversuche — 422 (Validierung/INVALID_ENVELOPE) und eine von der Venue abgelehnte Probe
     (`probe.state === "error"`); Erfolg setzt zurück. 409-Zustandskonflikte (z. B.
     `ALREADY_CONNECTED`) und 5xx (Store/Infra) zählen bewusst nicht.
   * **Kill-Switch-Ausnahme:** `/api/live/kill` und `/api/live/transition` rufen weiterhin nur
     `checkCredentialRateLimit` (Ebene 1). Globales Limit und Backoff liegen ausschließlich in
     `guardCredentialEndpoint` — die Sicherheitsaktion darf nie durch einen Credential-Flood
     blockierbar sein.
6. **Sichtbarkeit:** `GET /api/auth/me` liefert `rateLimitIdentity`
   (`key`, `ip`, `source`, `peerAvailable`, `trustedProxiesConfigured`, `ignoredHeaders`,
   `policy`) — secret-frei, und damit die schnellste Diagnose für „mein Proxy kommt nicht an“.
   Boot-Guard (`scripts/auth-boot-guard.ts`) und `src/instrumentation.ts` loggen dieselbe Policy
   (`[client-ip] …`) plus die Warnungen.

### Bewusst strenger als der Prompt (dokumentiert)

DO‑2 erlaubt im `else`-Zweig (kein `TRUSTED_PROXY_IPS`) `x-verified-ip` ohne weitere Bedingung.
Umgesetzt ist die sicherheitsrelevante Einschränkung: ohne Vertrauensanker wird der Header nur
akzeptiert, wenn die Anfrage nachweislich von **Loopback** kommt oder die Socket-Adresse nicht
sichtbar ist und `TRUSTED_PROXY_IPS` gesetzt ist. Grund: `npm run start` bindet `0.0.0.0` — ein
uneingeschränkt vertrautes `x-verified-ip` wäre exakt derselbe Fehler wie vorher mit
`x-forwarded-for`, nur mit neuem Header-Namen. Das Akzeptanzkriterium („spoofed header is ignored
by default“) ist damit in beide Richtungen erfüllt.

## Akzeptanzkriterien / Tests

- [x] **Acceptance:** `X-Forwarded-For: 1.2.3.4` ändert den Bucket **nicht** — ohne
      Proxy-Trust bleibt er `local` bzw. die Socket-Adresse; rotierende Fake-IPs laufen in
      denselben Bucket und erzeugen 429.
      `tests/clientIp.test.ts` (`C2-Akzeptanz: spoofbare Header ändern den Bucket nicht`,
      inkl. echtem `checkRateLimit`) + `tests/controlPlane.bruteforce.test.ts`
      („Spoofbare Header kaufen auch hier keine zusätzlichen Versuche“, über die echte Route).
- [x] Ohne Proxy-Trust wird `x-forwarded-for` ignoriert (Bucket bleibt `local`/Peer/verifiziert).
      Zusätzlich statischer Drift-Schutz: kein Modul außerhalb `src/lib/clientIp.ts` liest
      `x-forwarded-for`/`x-real-ip` per String-Literal, und der alte Dreizeiler
      (`return fwd || real || "local"`) darf nicht zurückkommen.
- [x] `x-forwarded-for` zählt nur bei konfiguriertem `TRUSTED_PROXY_IPS` **und** verifiziertem
      Socket-Peer — dann rightmost-untrusted (vorgeschobene Fake-IP wird übersprungen).
      Gegenprobe: Peer außerhalb der Liste ⇒ Header ignoriert, Peer zählt.
- [x] `x-verified-ip` (Proxy-gesetzt) bestimmt die Bucket-ID bei wirksamem Vertrauen;
      mehrdeutige/unparsebare Werte werden verworfen.
- [x] Credential-Rate-Limit nutzt die geteilte `resolveClientIp()` (`clientRateLimitKey`),
      nachgewiesen durch Verhalten **und** statischen Import-Check.
- [x] Globales Credential-Limit ist IP-unabhängig (fester Bucket `global`) und deckelt
      verteilte Versuche, obwohl jede Einzelidentität unter ihrem Limit bleibt.
- [x] Exponentieller Backoff: Schwelle 3, Wachstum 2 s/4 s/8 s, Deckel 15 min, Reset nach
      Erfolg und nach Ruhephase; 409/5xx zählen nicht; pro Identität getrennt.
- [x] Kill-Switch bleibt frei: `checkCredentialRateLimit` konsultiert weder globales Limit
      noch Backoff (Test füllt beides und prüft danach den Gate-Pfad).
- [x] Realbetrieb manuell verifiziert (Node-HTTP-Server, Socket-Peer sichtbar):
      spoofed `X-Forwarded-For`/`X-Real-IP` ⇒ Identität = Socket-Adresse, beide Header in
      `ignoredHeaders`; `x-verified-ip` von Loopback ⇒ übernommen; doppelt gesetztes
      `x-verified-ip` ⇒ verworfen; mit `TRUSTED_PROXY_IPS=127.0.0.1` ⇒ Kette
      `1.2.3.4, 203.0.113.44` wird zu `203.0.113.44` (rightmost-untrusted).

Suite-Status nach dem Fix: `npm test` = **1687/1687** (1639 vorher + 48 neue C2-Fälle),
`npm run typecheck`, `npm run lint`, `npm run docs:validate` grün, `npm run build` ohne neue
Warnungen.

## Changelog-Blurb

`C2 (MED/HIGH): IP-Rate-Limit vertraute spoofbare Header — nur noch Proxy-verifizierte IP; shared
resolveClientIp() + globaler Account-Limit-Backoff.`

Umgesetzt (v1.36.14): `src/lib/clientIp.ts` als einzige Quelle der Rate-Limit-Identität
(`TRUSTED_PROXY_IPS` + `x-verified-ip`, `x-forwarded-for` nur hinter verifiziertem Trusted-Proxy-Peer
und rightmost-untrusted, `x-real-ip` nie), geteilt von Firm- und Credential-Limit; dazu globales
IP-unabhängiges Credential-Limit (20/min) und exponentieller Backoff ab dem 3. Fehlversuch
(2 s → 15 min) — Kill-Switch bewusst ausgenommen. Diagnose über `GET /api/auth/me → rateLimitIdentity`
und das Boot-Log.

## Versions-Hinweis

PATCH — **umgesetzt als `1.36.14`** (Reihenfolge der Remediation: H1=v1.36.2, H3=v1.36.4,
H4=v1.36.5, H5=v1.36.6, H6=v1.36.7, H9=v1.36.8, H8=v1.36.10, B1=v1.36.11, B2=v1.36.12,
C1=v1.36.13, **C2=v1.36.14**). Der im Plan ursprünglich vorgeschlagene Wert `1.36.3` war
überholt: die Patch-Serie lief bereits bis 1.36.13.

Neu sind zwei Env-Flags (`TRUSTED_PROXY_IPS`, `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT`) und ein
geändertes Default-Verhalten: Ohne Proxy-Konfiguration zählt die Socket-Adresse bzw. `local`
statt `x-forwarded-for`. Für Single-User-/Loopback-Betrieb ändert sich nichts; wer hinter einem
Reverse Proxy pro Client drosseln will, setzt `TRUSTED_PROXY_IPS` und lässt den Proxy
`X-Verified-IP` schreiben (Anleitung: `INSTALL.md` → „Rate-Limit-Identität“).

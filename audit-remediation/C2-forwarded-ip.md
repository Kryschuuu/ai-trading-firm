# C2 — IP-basierte Rate-Limits vertrauen spoofbaren Proxy-Headers

- **Severity:** MEDIUM/HIGH
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **Valide.**
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

## Beweis (aktueller Code)

`src/lib/apiAuth.ts` L55‑58:

```ts
const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
const real = req.headers.get("x-real-ip")?.trim();
return fwd || real || "local";
```

## Fix-Spezifikation

Forwarded-Headers nur von vertrauenswürdigem Proxy übernehmen; besser ein proxy-gesetzter
verifizierter Header; zusätzlich globaler Account-Limit + Backoff (siehe Audit C2).

## Akzeptanzkriterien / Tests

- [ ] Ohne Proxy-Trust wird `x-forwarded-for` ignoriert (Bucket bleibt "local"/verifiziert).
- [ ] Nur `x-verified-ip` (Proxy-gesetzt) bestimmt die Bucket-ID, wenn konfiguriert.
- [ ] Credential-Rate-Limit nutzt geteilte `resolveClientIp()`.

## Changelog-Blurb

`C2 (MED/HIGH): IP-Rate-Limit vertraute spoofbare Header — nur noch Proxy-verifizierte IP; shared
resolveClientIp() + globaler Account-Limit-Backoff.`

## Versions-Hinweis

PATCH (`1.36.3`) — Sicherheits-Härtung (neues Env `TRUSTED_PROXY_IPS`, Header-Policy).

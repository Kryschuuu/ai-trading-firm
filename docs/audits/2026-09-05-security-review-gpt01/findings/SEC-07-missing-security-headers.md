# SEC-07 — Fehlende Security-Header (Beispiel Low)

- **ID:** SEC-07
- **Severity:** LOW
- **Bereich:** Frontend / Security-Header
- **Quelle:** Security Review-GPT_01.pdf (Low-Findings)
- **Status:** OPEN (Platzhalter)

## Beschreibung

Low-Finding: Security-Header fehlen oder sind nur in Production aktiv. Bereits gefixt via `next.config.ts` (CSP, HSTS, etc.), aber nur `NODE_ENV=production`. Audit empfiehlt auch für Preview/Dev.

## Remediation

- `next.config.ts` Header-Block prüfen
- CSP `frame-ancestors 'none'` + `DENY`

## Akzeptanzkriterien

- [ ] Header in Production vorhanden
- [ ] Lint 0 Fehler

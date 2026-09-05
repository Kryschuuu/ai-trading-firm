# SEC-05 — Rate-Limit Bypass (Beispiel Medium)

- **ID:** SEC-05
- **Severity:** MEDIUM
- **Bereich:** API / Rate-Limiting
- **Quelle:** Security Review-GPT_01.pdf (Medium-Findings)
- **Status:** OPEN (Platzhalter — nach PDF-Analyse anpassen)

## Beschreibung

Medium-Finding: Rate-Limit kann via IP-Spoofing oder fehlendem globalen Limit umgangen werden. Bereits teilweise gefixt via C2 (globaler Deckel + Backoff), aber Audit hat möglicherweise weitere Endpunkte gefunden.

## Remediation

- `src/lib/clientIp.ts` als einzige Quelle erzwingen
- Globalen Deckel `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT` prüfen
- Tests in `tests/controlPlane.bruteforce.test.ts`

## Akzeptanzkriterien

- [ ] Rate-Limit-Tests grün
- [ ] Kein Bypass via `X-Forwarded-For`

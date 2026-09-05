# SEC-06 — Information Disclosure (Beispiel Medium)

- **ID:** SEC-06
- **Severity:** MEDIUM
- **Bereich:** API / Error-Handling
- **Quelle:** Security Review-GPT_01.pdf (Medium-Findings)
- **Status:** OPEN (Platzhalter)

## Beschreibung

Fehlermeldungen leaken interne Details (DB-Connection-String, Stack-Traces). Bereits gefixt via `publicErrorMessage()` + `redactSecrets()`, aber Audit hat möglicherweise weitere Stellen gefunden.

## Remediation

- Alle `catch`-Blöcke auf `publicErrorMessage(e)` prüfen
- `redactSecrets` in Logs

## Akzeptanzkriterien

- [ ] Keine Secrets in API-Responses
- [ ] Tests `tests/hardening.test.ts` grün

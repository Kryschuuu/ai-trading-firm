# Remediation Summary — 2026-09-03 Peer-Review

Alle Findings dieses Audits sind **FIXED** (Stand v1.36.24, 2026-09-05).

| ID | Severity | Status | Fix-Version | PR | Notizen |
|----|----------|--------|-------------|----|---------|
| H1 | CRITICAL | FIXED | v1.36.2 | - | estimatedNotional serverseitig |
| H2 | CRITICAL | FIXED | v1.36.19 | - | order_intents + advisory lock |
| H3 | CRITICAL | FIXED | v1.36.4 | - | Order-Status |
| H4 | CRITICAL | FIXED | v1.36.5 | - | Idempotency |
| H5 | CRITICAL | FIXED | v1.36.6 | - | Pipeline-Trading |
| H6 | CRITICAL | FIXED | v1.36.7 | - | Approval-Chain |
| H7 | HIGH | FIXED | v1.36.20 | - | Live-Kill flattenAll venue-aware |
| H8 | HIGH | FIXED | v1.36.10 | - | Bitunix-Equity |
| H9 | HIGH | FIXED | v1.36.8 | - | finite guardrails |
| H10 | HIGH | FIXED | v1.36.21 | - | adaptive fail-open → fail-closed |
| W1 | HIGH | FIXED | v1.36.23 | - | localStorage → HttpOnly Cookie |
| W2 | MEDIUM | FIXED | v1.36.24 | - | prompt versioning optimistic lock |
| C1 | HIGH | FIXED | v1.36.13 | - | open mode → AUTH_MODE |
| C2 | MED/HIGH | FIXED | v1.36.14 | - | forwarded-ip → clientIp.ts |
| C3 | HIGH | FIXED | v1.36.15 | - | kill disarm nonce + RBAC |
| C4 | MEDIUM | FIXED | v1.36.16 | - | control state persistence |
| B1 | HIGH | FIXED | v1.36.11 | - | sl/tp geometry |
| B2 | MEDIUM | FIXED | v1.36.12 | - | side fallback |
| S1 | MEDIUM | FIXED | v1.36.18 | - | audit reliability sink |
| S2 | MEDIUM | FIXED | v1.36.22 | - | singleton consistency stateRegistry |

## Verlauf

- 2026-09-03: Audit erstellt
- 2026-09-04 bis 2026-09-05: Fixes v1.36.2 bis v1.36.24
- 2026-09-05: Audit CLOSED — alle Findings verifiziert
- 2026-09-05: Migration in neue Struktur `docs/audits/2026-09-03-peer-review/`

## Tests

- `tests/h10.adaptiveUnknown.test.ts`
- `tests/h7.emergencyFlatten.test.ts`
- `tests/stateRegistry.test.ts`
- `tests/w2.promptVersioning.test.ts`
- `tests/w1.sessionCookie.test.ts`
- `test/integration/orderIntents.submitAtomic.test.ts`
- Alle 181+ Tests grün zum Zeitpunkt des Closings.

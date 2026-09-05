# Security — Übersicht & Härtung

> **Zweck:** Zentrale Anlaufstelle für Security-Themen — aggregiert offene Critical/High Findings aus allen Audits, beschreibt Security-Modell, Auth, RBAC, Rate-Limiting und Härtungsmaßnahmen.

## Security-Modell (Kurzfassung)

**Prinzip:** Die KI schlägt vor — der Code entscheidet. Alle Sicherheitsgrenzen liegen außerhalb der Agentenlogik, in kompiliertem Code.

**Schichten:**

1. **Engine-Validierung** — Rolle darf handeln? Kill-Switch aus? Kurs vorhanden?
2. **Guardrails** (`riskGuard.ts`) — max. 25% Position, Stop-Loss Pflicht, kein Short ohne Flag
3. **Kill-Switch** — globaler Circuit-Breaker, DB-persistent, Disarm stärker als Arm (ADMIN + Nonce + CSRF)
4. **Broker-Schleuse** — prüft alles nochmal, unabhängig von Schicht 2+3
5. **Auth & RBAC** — `AUTH_MODE=local-open | token-required`, `FIRM_ADMIN_TOKEN`, `FIRM_API_TOKEN`, `FIRM_VIEWER_TOKEN`, Permission `live.gate`, `broker.credentials`
6. **Rate-Limit-Identität** — `src/lib/clientIp.ts` als einzige Quelle, `TRUSTED_PROXY_IPS` + `x-verified-ip`, `x-forwarded-for` nur hinter verifiziertem Proxy, globaler Deckel + exponentieller Backoff

## Dokumente

| Dokument | Zweck |
|----------|-------|
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | Security-Audit 2026-08-25 (v1.4.0) — Findings, Fixes, Peer-Review |
| [../audits/README.md](../audits/README.md) | Zentrale Audit-Verwaltung — alle Audits chronologisch |
| [../audits/2026-09-03-peer-review/](../audits/2026-09-03-peer-review/) | Peer-Review-Audit Sep 2026 — H1-H10, C1-C4, B1-B2, S1-S2, W1-W2 (CLOSED) |
| [../audits/2026-09-05-security-review-gpt01/](../audits/2026-09-05-security-review-gpt01/) | Security-Audit GPT_01 — SEC-01 bis SEC-07 (OPEN, Template) |

## Offene Critical/High Findings (aggregiert)

> Quelle: `docs/audits/*/remediation/TRACKING.md` — hier nur aggregierte Sicht, Details in jeweiligen Audit-Ordnern.

| Audit | ID | Titel | Severity | Status |
|-------|----|-------|----------|--------|
| 2026-09-05-gpt01 | SEC-01 | Privilege Escalation | CRITICAL | OPEN |
| 2026-09-05-gpt01 | SEC-02 | Ungeschützte APIs | CRITICAL | OPEN |
| 2026-09-05-gpt01 | SEC-03 | Verwundbare Dependencies (1) | HIGH | OPEN |
| 2026-09-05-gpt01 | SEC-04 | Verwundbare Dependencies (2) | HIGH | OPEN |

Alle Findings aus 2026-09-03 sind FIXED (siehe [dort](../audits/2026-09-03-peer-review/remediation/SUMMARY.md)).

## Auth-Modus (v1.36.13+)

- `NODE_ENV=production` ohne Token ⇒ Boot-Verweigerung `AUTH_NOT_CONFIGURED` (kein offener Zugang)
- `AUTH_MODE=local-open` — bewusster Opt-in für Single-User ohne Token (Dev-Default)
- `AUTH_MODE=token-required` — erzwingt Credential auch in Dev
- Wirksamer Modus: `curl -s localhost:3369/api/auth/me | jq .authMode`

## Rate-Limit-Identität (v1.36.14+)

- `x-forwarded-for` nur wenn `TRUSTED_PROXY_IPS` konfiguriert und Socket-Peer darin liegt (rightmost-untrusted)
- `x-verified-ip` — Header für Reverse Proxy (`proxy_set_header X-Verified-IP $remote_addr`)
- `x-real-ip` nie als Identität
- Credential-Brute-Force: 5/min pro Identität + 20/min global + exponentieller Backoff ab 3. Fehlversuch

## Kill-Switch (v1.36.15+)

- **Arm** (`POST /api/firm/kill {arm:true}`) — Operator (`guardWrite`)
- **Disarm** (`{arm:false, nonce}`) — ADMIN (`live.gate`) + CSRF + single-use Nonce (≤60s) aus `GET /api/firm/kill/challenge`

## Audit-Trail (v1.36.18+)

- Zwei Klassen in `src/lib/auditSink.ts`: `security` (Retry + Spool `data/audit-spool/`) und `telemetry` (best-effort)
- Fail-closed wo Mutation vermeidbar: Credential-Store, Kill-Switch-Disarm, Proposal-Freigabe ohne durablen Beleg ⇒ 503
- Lücken sichtbar: CRITICAL im Journal, `audit_missed_total` Metrik, `/api/health → audit`

## Session-Cookie (v1.36.23+)

- `firmToken` nicht mehr in `localStorage` — stattdessen `firm_session` HttpOnly, Secure, SameSite=Strict, 15min + `firm_csrf` Double-Submit
- Stateless HMAC-Session in `src/lib/authSession.ts`

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Security-Kapitel
- [FRONTEND_CONTROL_PLANE.md](../FRONTEND_CONTROL_PLANE.md) — Control Plane Auth
- [LIVE_TRADING.md](../LIVE_TRADING.md) — Live-Gate + Kill-Switch
- [CONFIGURATION.md](../../CONFIGURATION.md) — Env-Flags inkl. `AUTH_MODE`, `TRUSTED_PROXY_IPS`

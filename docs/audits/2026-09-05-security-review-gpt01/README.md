# Security Audit: GPT_01 — 2026-09-05

**Quelle:** `Security Review-GPT_01.md` / `Security Review-GPT_01.pdf`  
**Reviewer:** GPT Security Review (Stand `main`, 5. September 2026)  
**Scope:** Auth/RBAC, Session-Handling, Broker-Control-Plane, Secret-Store, Rule-Engine, API-Routen, Audit-/Logging, Deployment, Dependencies  
**Datum:** 2026-09-05  
**Status:** OPEN — SEC-01 FIXED in v1.36.27, SEC-02 FIXED in v1.36.31, SEC-03 FIXED in v1.36.28, SEC-10 FIXED in v1.36.29, SEC-04 FIXED in v1.36.30, SEC-07 FIXED in v1.36.32, SEC-05 FIXED in v1.36.33 (ergänzt v1.36.34), SEC-06 FIXED in v1.36.34 (2026-09-06); SEC-08/SEC-09 weiter offen
**Original-Dokument:** `Security Review-GPT_01.md` (Markdown) und `Security Review-GPT_01.pdf`

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 1 | 0 | 0 | 1 |
| HIGH | 4 | 0 | 0 | 4 |
| MEDIUM | 3 | 1 | 0 | 2 |
| LOW | 2 | 1 | 0 | 1 |

> Zählung gemäß Review-Tabelle (SEC-01 bis SEC-10). SEC-02 ist **HIGH** (Datenexposition), nicht Critical.

## Findings-Index

| ID | Titel | Severity | Status | Fix-Version | Datei |
|----|-------|----------|--------|-------------|-------|
| SEC-01 | Privilege Escalation über signierte Session | CRITICAL | FIXED | v1.36.27 | [SEC-01](./findings/SEC-01-privilege-escalation.md) |
| SEC-02 | Sensible Daten über unauthentifizierte GET-APIs | HIGH | FIXED | v1.36.31 | [SEC-02](./findings/SEC-02-unauthenticated-get-apis.md) |
| SEC-03 | Verwundbare Next.js-Version | HIGH | FIXED | v1.36.28 | [SEC-03](./findings/SEC-03-vulnerable-next.md) |
| SEC-04 | `ws` erlaubt verwundbare Versionen | HIGH | FIXED | v1.36.30 | [SEC-04](./findings/SEC-04-vulnerable-ws.md) |
| SEC-05 | Fälschbare Akteursattribution bei Rule-Änderungen | MEDIUM | FIXED | v1.36.33 + v1.36.34 | [SEC-05](./findings/SEC-05-rule-actor-attribution.md) |
| SEC-06 | Rule-Lifecycle nur durch `firm.write` geschützt | MEDIUM | FIXED | v1.36.34 | [SEC-06](./findings/SEC-06-rule-lifecycle-authz.md) |
| SEC-07 | Secret-Store fällt auf Env-Credentials zurück | HIGH | FIXED | v1.36.32 | [SEC-07](./findings/SEC-07-env-credential-fallback.md) |
| SEC-08 | Sessions sind nicht sofort widerrufbar | MEDIUM | OPEN | - | [SEC-08](./findings/SEC-08-session-revocation.md) |
| SEC-09 | Memory-Hygiene schützt JS-Strings nicht wirklich | LOW | OPEN | - | [SEC-09](./findings/SEC-09-secret-memory-hygiene.md) |
| SEC-10 | GitHub Actions nicht auf immutable SHAs gepinnt | LOW | FIXED | v1.36.29 | [SEC-10](./findings/SEC-10-github-actions-pinning.md) |

## Executive Summary

**Für Paper-Trading:** technisch bereits deutlich gehärtet, aber noch mehrere relevante Sicherheitslücken bzw. gefährliche Designkanten.

**Für echtes Live-Trading:** aktuell nicht freigabefähig.

Die wichtigsten Punkte sind nicht klassische SQL-Injection oder Kryptographiefehler, sondern **Authorization-/Trust-Boundary-Probleme und unnötig öffentliche Datenzugriffe**. SEC-02 ist seit v1.36.31 geschlossen, SEC-07 seit v1.36.32, SEC-05 seit v1.36.33 (Erstellungsattribution ergänzt in v1.36.34), SEC-06 seit v1.36.34; beide Dependency-Befunde sind ebenfalls behoben: `next` seit v1.36.28, `ws` seit v1.36.30.

Injection: kein bestätigter kritischer Befund (`drizzle-orm` 0.45.2 enthält den SQLi-Fix). Kill-Switch-Disarm, AES-GCM-Secret-Store, Rule-Engine-Whitelist und CSRF (Double-Submit) sind ausdrücklich **keine** Findings.

## Remediation-Plan (Priorisierung aus dem Review)

1. **SEC-01 erledigt (v1.36.27):** unabhängiger Session-Key, aktuelle serverseitige
   Rechteprojektion und Credential-Bindung. **SEC-02 erledigt (v1.36.31):** die
   sensitiven Dashboard-Reads verlangen `firm.read` und sind `private, no-store`.
   **SEC-03 erledigt (v1.36.28):** Next.js und native Decoder-Kette aktualisiert.
   **SEC-04 erledigt (v1.36.30):** `ws` exakt gepinnt, transitive Kopien erzwungen,
   WS-Client fail-closed gehärtet. **SEC-07 erledigt (v1.36.32):** Env-Credential-Fallback nur noch explizit Dev/Test hinter Flag.
   **SEC-05 erledigt (v1.36.33, ergänzt v1.36.34):** Audit-Attribution einschließlich Erstellung serverseitig.
   **SEC-06 erledigt (v1.36.34):** getrennte operative und administrative Rule-Permissions, einschließlich manuellem Makro-Einstieg.
2. **Vor weiterem Live-Ausbau:** SEC-07 erledigt (v1.36.32) — kein Env-Fallback in Prod
3. **Vor echter Multi-Role-Nutzung:** SEC-05/SEC-06 erledigt — v1.36.34 ausrollen und verschiedene Admin-/Operator-Credentials konfigurieren
4. **Danach:** SEC-08 (Session-Revocation), SEC-09 (Memory-Hygiene-Doku); SEC-10 (Actions-SHAs) bereits erledigt

SEC-08 ist durch die Credential-Bindung teilweise adressiert; individuelles
Logout/Revoke ist nicht Teil von SEC-01 und bleibt offen.

Siehe `remediation/TRACKING.md` für Status.

## Verwandte Dokumente

- Peer-Review-Patches: [../../peer-reviews/](../../peer-reviews/)
- Security-Übersicht: [../../security/README.md](../../security/README.md)
- Audit-Struktur: [../README.md](../README.md)
- Review-Quelle: [Security Review-GPT_01.md](./Security%20Review-GPT_01.md)

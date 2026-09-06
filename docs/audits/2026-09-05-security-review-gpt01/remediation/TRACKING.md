# Remediation-Tracking — Security Review GPT_01 (2026-09-05)

Diese Datei ist die einzige Wahrheit für den Status aller Findings dieses Audits.

| ID | Titel | Severity | Status | Fix-Version | PR / Commit | Assignee | Notizen |
|----|-------|----------|--------|-------------|----|----------|---------|
| SEC-01 | Privilege Escalation über signierte Session | CRITICAL | FIXED | v1.36.27 | [3dfede1](https://github.com/Kryschuuu/ai-trading-firm/commit/3dfede16ced729f1583e37305690df95a569e16e) | - | Unabhängiger Key, aktuelle serverseitige Rechte, Credential-Bindung; Upgrade mit neuem Login |
| SEC-02 | Sensible Daten über unauthentifizierte GET-APIs | HIGH | FIXED | v1.36.31 | [d900a71](https://github.com/Kryschuuu/ai-trading-firm/commit/d900a715d26213508aa7240f1acb65441118ecc1) | - | `firm.read` vor Datenzugriff, Viewer-/Session-kompatibel, `private, no-store` |
| SEC-03 | Verwundbare Next.js-Version | HIGH | FIXED | v1.36.28 | [25dcc8b](https://github.com/Kryschuuu/ai-trading-firm/commit/25dcc8bbe8ef309c8b735c40573e06110058906d) | - | Next 16.3.4, sharp 0.35.4, libheif 1.23.2; Regressionen Linux/Windows |
| SEC-04 | `ws` erlaubt verwundbare Versionen | HIGH | FIXED | v1.36.30 | [a131479](https://github.com/Kryschuuu/ai-trading-firm/commit/a1314793862d1a51e2664aac0a304aa0b46805a0) | - | Exakter Pin `ws 8.21.3` + Override; Laufzeit-Guard und Payload-Kappe im Bitunix-WS |
| SEC-05 | Fälschbare Akteursattribution bei Rule-Änderungen | MEDIUM | FIXED | v1.36.33 + v1.36.34 | [PR #117](https://github.com/Kryschuuu/ai-trading-firm/pull/117); Ergänzung [57fec8f](https://github.com/Kryschuuu/ai-trading-firm/commit/57fec8f08c7de8ac556fe842db04ff2cce978842) | - | Verifizierter Actor auch bei RULE_CREATED; MANUAL-Herkunft; keine Client-Attribution und kein Admin-Fallback |
| SEC-06 | Rule-Lifecycle nur durch `firm.write` geschützt | MEDIUM | FIXED | v1.36.34 | [57fec8f](https://github.com/Kryschuuu/ai-trading-firm/commit/57fec8f08c7de8ac556fe842db04ff2cce978842) | - | strategy.rules.write/activate/rollback/archive vor Persistenz; manueller Makro-Einstieg ebenfalls administrativ; Header/Bearer/Session getestet |
| SEC-07 | Secret-Store fällt auf Env-Credentials zurück | HIGH | FIXED | v1.36.32 | arena/01a07843-ai-trading-firm (PR folgt) | - | Env-Fallback nur noch explizit Dev/Test hinter BROKER_ALLOW_ENV_FALLBACK=true, Prod fail-closed: missing→null, failure→HARD FAIL |
| SEC-08 | Sessions sind nicht sofort widerrufbar | MEDIUM | OPEN | - | - | - | Teilweise adressiert in v1.36.27: Credential-Bindung + aktuelle Rechte; individuelles Logout/Revoke offen |
| SEC-09 | Memory-Hygiene schützt JS-Strings nicht wirklich | LOW | OPEN | - | - | - | `plaintext.toString` → immutable JS-Strings |
| SEC-10 | GitHub Actions nicht auf immutable SHAs gepinnt | LOW | FIXED | v1.36.29 | - | - | SHA-Pinning |

## Legende

- **Status:** OPEN | IN_PROGRESS | FIXED | WONTFIX | FALSE_POSITIVE

## Verlauf

- 2026-09-05: Audit angelegt (Security Review-GPT_01)
- 2026-09-05: Finding-Dateien SEC-01–SEC-10 1:1 auf den Review-Inhalt ausgerichtet (Platzhalter SEC-05–SEC-07 ersetzt; SEC-01–SEC-04 korrigiert)

- 2026-09-06: SEC-01 in v1.36.27 behoben (Fix-/Red-Test-Commit und Validierung im Finding). SEC-08 teilweise adressiert; individuelles Logout/Revoke bleibt offen.

- 2026-09-06: SEC-03 in v1.36.28 behoben; exakter Next-Pin, komplette native Decoder-Kette und verpflichtende Linux-/Windows-Regressionen. Red-Test-/Fix-Commits und Validierung im Finding.

- 2026-09-06: SEC-04 in v1.36.30 behoben; exakter `ws`-Pin inklusive transitiver Kopien, Fail-Closed-Versionsguard und Ressourcen-Kappen im Bitunix-WS-Client, verbindliches CI-Gate. Red-Test-/Fix-Commits und Validierung im Finding.

- 2026-09-06: SEC-02 in v1.36.31 behoben; die sechs sensitiven Dashboard-Reads
  verlangen `firm.read` vor Backend-Zugriff und werden `private, no-store`
  ausgeliefert. Red-Test-/Fix-Commits und Validierung im Finding.

- 2026-09-06: SEC-07 in v1.36.32 behoben; Env-Fallback nur noch explizit Dev/Test hinter BROKER_ALLOW_ENV_FALLBACK=true, Prod fail-closed (missing→null, failure→HARD FAIL). 19 neue Regressionstests, 2 Alt-Tests korrigiert.

- 2026-09-06: SEC-05 in v1.36.33 behoben; Audit-Attribution von Regel-Änderungen kommt ausschließlich aus dem authentifizierten Credential, client-gelieferte Attributionsfelder werden fail-closed abgelehnt, `sourceRole` ist über die API nicht mehr steuerbar. 17 neue Regressionstests inkl. Angriffsvektoren und Quell-Drift-Check.

- 2026-09-06: SEC-06 in v1.36.34 behoben; getrennte Rule-Permissions und
  administrativer manueller Makro-Einstieg. SEC-05 mit erfolgreichen Audit-Pfaden
  erneut geprüft und um RULE_CREATED-Attribution sowie Fail-Closed-Actor ergänzt.
  72 neue Tests plus 17 bestehende SEC-05-Tests im verpflichtenden Auth-Gate;
  Red-Test- und Fix-Commit stehen in den Findings.

## Nächste Schritte

1. SEC-01–SEC-07/SEC-10 erledigt — v1.36.34 mit `npm ci` installieren, neu bauen und alle Prozesse neu starten
2. Multi-Role: verschiedene Admin-/Operator-Credentials sicher konfigurieren; internes Human-Approval unabhängig von RBAC prüfen
3. SEC-08–SEC-09 Hardening

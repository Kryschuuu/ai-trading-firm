# Remediation-Tracking — Security Review GPT_01 (2026-09-05)

Diese Datei ist die einzige Wahrheit für den Status aller Findings dieses Audits.

| ID | Titel | Severity | Status | Fix-Version | PR | Assignee | Notizen |
|----|-------|----------|--------|-------------|----|----------|---------|
| SEC-01 | Privilege Escalation über signierte Session | CRITICAL | OPEN | - | - | - | HMAC aus Viewer-Token; Permissions nicht an Rolle gebunden |
| SEC-02 | Sensible Daten über unauthentifizierte GET-APIs | HIGH | OPEN | - | - | - | `/api/firm`, `/log`, `/report`, `/rules`, `/providers`, `/routing` |
| SEC-03 | Verwundbare Next.js-Version | HIGH | OPEN | - | - | - | `next ^16.3.1`; Fix ≥16.3.3 |
| SEC-04 | `ws` erlaubt verwundbare Versionen | HIGH | OPEN | - | - | - | `ws ^8.18.0`; Fix ≥8.21.0 |
| SEC-05 | Fälschbare Akteursattribution bei Rule-Änderungen | MEDIUM | OPEN | - | - | - | Client-`by` / `sourceRole` im Audit |
| SEC-06 | Rule-Lifecycle nur durch `firm.write` geschützt | MEDIUM | OPEN | - | - | - | activate/rollback ohne eigene Permission |
| SEC-07 | Secret-Store fällt auf Env-Credentials zurück | MEDIUM | OPEN | - | - | - | Bitunix/Alpaca Env-Fallback bei Store-Fehler |
| SEC-08 | Sessions sind nicht sofort widerrufbar | MEDIUM | OPEN | - | - | - | Stateless HMAC, 15 min Snapshot, keine Epoch |
| SEC-09 | Memory-Hygiene schützt JS-Strings nicht wirklich | LOW | OPEN | - | - | - | `plaintext.toString` → immutable JS-Strings |
| SEC-10 | GitHub Actions nicht auf immutable SHAs gepinnt | LOW | OPEN | - | - | - | `actions/*@v4` mutable Tags |

## Legende

- **Status:** OPEN | IN_PROGRESS | FIXED | WONTFIX | FALSE_POSITIVE

## Verlauf

- 2026-09-05: Audit angelegt (Security Review-GPT_01)
- 2026-09-05: Finding-Dateien SEC-01–SEC-10 1:1 auf den Review-Inhalt ausgerichtet (Platzhalter SEC-05–SEC-07 ersetzt; SEC-01–SEC-04 korrigiert)

## Nächste Schritte

1. SEC-01 Session-Signierung reparieren
2. SEC-03 / SEC-04 `next` und `ws` aktualisieren
3. SEC-02 GET-APIs authentifizieren, SEC-07 Env-Fallback entfernen
4. SEC-05 / SEC-06 Rule-Audit und Permissions
5. SEC-08–SEC-10 Hardening

# Remediation-Tracking — Security Review GPT_01 (2026-09-05)

Diese Datei ist die einzige Wahrheit für den Status aller Findings dieses Audits.

| ID | Titel | Severity | Status | Fix-Version | PR / Commit | Assignee | Notizen |
|----|-------|----------|--------|-------------|----|----------|---------|
| SEC-01 | Privilege Escalation über signierte Session | CRITICAL | FIXED | v1.36.27 | [3dfede1](https://github.com/Kryschuuu/ai-trading-firm/commit/3dfede16ced729f1583e37305690df95a569e16e) | - | Unabhängiger Key, aktuelle serverseitige Rechte, Credential-Bindung; Upgrade mit neuem Login |
| SEC-02 | Sensible Daten über unauthentifizierte GET-APIs | HIGH | OPEN | - | - | - | `/api/firm`, `/log`, `/report`, `/rules`, `/providers`, `/routing` |
| SEC-03 | Verwundbare Next.js-Version | HIGH | FIXED | v1.36.28 | [25dcc8b](https://github.com/Kryschuuu/ai-trading-firm/commit/25dcc8bbe8ef309c8b735c40573e06110058906d) | - | Next 16.3.4, sharp 0.35.4, libheif 1.23.2; Regressionen Linux/Windows |
| SEC-04 | `ws` erlaubt verwundbare Versionen | HIGH | OPEN | - | - | - | `ws ^8.18.0`; Fix ≥8.21.0 |
| SEC-05 | Fälschbare Akteursattribution bei Rule-Änderungen | MEDIUM | OPEN | - | - | - | Client-`by` / `sourceRole` im Audit |
| SEC-06 | Rule-Lifecycle nur durch `firm.write` geschützt | MEDIUM | OPEN | - | - | - | activate/rollback ohne eigene Permission |
| SEC-07 | Secret-Store fällt auf Env-Credentials zurück | MEDIUM | OPEN | - | - | - | Bitunix/Alpaca Env-Fallback bei Store-Fehler |
| SEC-08 | Sessions sind nicht sofort widerrufbar | MEDIUM | OPEN | - | - | - | Teilweise adressiert in v1.36.27: Credential-Bindung + aktuelle Rechte; individuelles Logout/Revoke offen |
| SEC-09 | Memory-Hygiene schützt JS-Strings nicht wirklich | LOW | OPEN | - | - | - | `plaintext.toString` → immutable JS-Strings |
| SEC-10 | GitHub Actions nicht auf immutable SHAs gepinnt | LOW | OPEN | - | - | - | `actions/*@v4` mutable Tags |

## Legende

- **Status:** OPEN | IN_PROGRESS | FIXED | WONTFIX | FALSE_POSITIVE

## Verlauf

- 2026-09-05: Audit angelegt (Security Review-GPT_01)
- 2026-09-05: Finding-Dateien SEC-01–SEC-10 1:1 auf den Review-Inhalt ausgerichtet (Platzhalter SEC-05–SEC-07 ersetzt; SEC-01–SEC-04 korrigiert)

- 2026-09-06: SEC-01 in v1.36.27 behoben (Fix-/Red-Test-Commit und Validierung im Finding). SEC-08 teilweise adressiert; individuelles Logout/Revoke bleibt offen.

- 2026-09-06: SEC-03 in v1.36.28 behoben; exakter Next-Pin, komplette native Decoder-Kette und verpflichtende Linux-/Windows-Regressionen. Red-Test-/Fix-Commits und Validierung im Finding.

## Nächste Schritte

1. SEC-01 erledigt — v1.36.27 mit unabhängigem Session-Key auf allen Instanzen ausrollen
2. SEC-03 erledigt — v1.36.28 auf allen Linux-/Windows-Instanzen ausrollen; SEC-04 `ws` weiterhin offen
3. SEC-02 GET-APIs authentifizieren, SEC-07 Env-Fallback entfernen
4. SEC-05 / SEC-06 Rule-Audit und Permissions
5. SEC-08–SEC-10 Hardening

# FINDING-ID — Titel des Findings

- **ID:** FINDING-ID (z. B. SEC-01, H1, S-12)
- **Severity:** CRITICAL | HIGH | MEDIUM | LOW | INFO
- **Bereich:** Auth / API / Dependencies / Handelslogik / Broker / Control Plane / ...
- **Quelle:** Name des Audits, Seite/Kapitel im Original-PDF
- **Status:** OPEN | IN_PROGRESS | FIXED | WONTFIX | FALSE_POSITIVE
- **Fix-Version:** vX.Y.Z (falls gefixt)
- **PR:** #123 (falls vorhanden)
- **Datei(en):** `src/...`, `src/...`
- **Peer-Review-Patch:** `../../peer-reviews/YYYY-MM-DD-.../patches/PATCH-...md` (falls vorhanden)

## Beschreibung

Aus dem Original-Audit: Was ist das Problem? Warum ist es ein Risiko?

## Beweis / PoC

Code-Auszug, der das Problem zeigt, oder Schritte zur Reproduktion:

```ts
// Beispiel: verwundbarer Code
```

Falls Scanner-Finding: CVE-Nummer, betroffene Version, CVSS-Score.

## Remediation (aus Audit + eigene Bewertung)

Was schlägt das Audit vor? Was ist unsere Bewertung? Konkrete Fix-Spezifikation:

1. Schritt 1
2. Schritt 2
3. ...

## Akzeptanzkriterien / Tests

- [ ] Test: Beschreibung, was geprüft wird
- [ ] Kein neuer Pfad, der das Problem wieder einführt
- [ ] ...

## Changelog-Blurb

```
SEC-01 (CRITICAL): Titel — Beschreibung des Fixes
```

## Versions-Hinweis

Patch / Minor / Major? Begründung.

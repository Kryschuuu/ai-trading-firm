# SEC-03 — Verwundbare Dependencies (1)

- **ID:** SEC-03
- **Severity:** HIGH
- **Bereich:** Dependencies / Supply Chain
- **Quelle:** Security Review-GPT_01.pdf, Kapitel Dependencies (npm audit)
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `package.json`, `package-lock.json`

## Beschreibung

Hohe Finding: `npm audit` meldet verwundbare Dependencies (z. B. alte `ws`, `next`, `drizzle-orm` Versionen). Scanner-PDF (`Review Scanner.pdf` aus Aufgabenstellung) listet CVEs.

Typische CVEs in diesem Stack:
- `ws` < 8.17.1 — DoS via große Payloads
- `next` < 15.x — Open Redirect, SSRF
- `pg` — SQL-Injection bei unsicherer Nutzung (hier via Drizzle parametrisiert, aber Version prüfen)

## Beweis

```bash
npm audit
# oder
npm audit --audit-level=high
```

Ausgabe aus PDF hier einfügen.

## Remediation

1. `npm audit` ausführen, betroffene Pakete notieren
2. `npm update <pkg>` bzw. `npm audit fix` (ohne breaking changes)
3. Falls Major-Update nötig: Branch `arena/<id>-sec03-deps`, Tests laufen lassen
4. `package-lock.json` committen, Changelog mit CVE-Nummern
5. CI-Gate: `.github/workflows/main-security-live-gatte.yml` prüft `npm audit` auf 0 High/Critical

## Akzeptanzkriterien

- [ ] `npm audit` → 0 High, 0 Critical (Medium/Low darf, aber dokumentieren)
- [ ] `npm test` grün
- [ ] `npm run build` grün
- [ ] Changelog mit CVE-Referenzen

## Changelog-Blurb

```
SEC-03 (HIGH): Verwundbare Dependencies — npm audit High/Critical auf 0
```

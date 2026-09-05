# SEC-04 — Verwundbare Dependencies (2)

- **ID:** SEC-04
- **Severity:** HIGH
- **Bereich:** Dependencies / Supply Chain
- **Quelle:** Security Review-GPT_01.pdf, zweites Dependency-Finding
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `package.json`, `package-lock.json`, `src/brokers/bitunix/ws.ts` (nutzt `ws`)

## Beschreibung

Zweites High-Finding im Dependency-Bereich — oft transitive Dependencies (z. B. `ws` via `next` oder via `pg` indirekt). Scanner unterscheidet zwischen direkter und transitiver Verwundbarkeit.

## Beweis

```bash
npm audit --json | jq '.vulnerabilities'
```

PDF-Auszug hier einfügen.

## Remediation

Wie SEC-03, aber Fokus auf transitive Dependencies:

1. `npm ls <pkg>` um Pfad zu finden
2. Falls via `next`: Next.js Update prüfen (Breaking Changes beachten)
3. Falls via `ws`: `ws` direkt updaten, `package.json` `overrides` setzen falls nötig
4. Tests: WebSocket-Tests `tests/bitunix.ws.test.ts` müssen grün bleiben

## Akzeptanzkriterien

- [ ] Transitive Pfade dokumentiert
- [ ] Fix ohne Breaking Change oder mit Migration dokumentiert
- [ ] `npm audit` 0 High/Critical

## Changelog-Blurb

```
SEC-04 (HIGH): Transitive Dependencies — ws/next aktualisiert, audit 0 High/Critical
```

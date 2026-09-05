# SEC-03 — Verwundbare Next.js-Version

- **ID:** SEC-03
- **Severity:** HIGH
- **Bereich:** Dependencies / Supply Chain
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-03 — Verwundbare Next.js-Version
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `package.json`, `package-lock.json`
- **Peer-Review-Patch:** TBD

## Beschreibung

Im Projekt ist `next` mit `^16.3.1` deklariert. Die Lock-Datei enthält ebenfalls diese Dependency-Spezifikation.

Für Next.js wurde am **25. August 2026** eine **kritische ungepatchte RCE** gemeldet:

- betroffen: `>=16.0 <16.3.3`
- behoben: `16.3.3`
- CVSS 9.0
- betroffene Windows-Server können unauthentifizierte Remote Code Execution ermöglichen ([GHSA-p293-qw3h-jr36](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36))

Zusätzlich eine weitere kritische RCE im Image Optimization API:

- betroffen: `<16.3.3`
- behoben: `16.3.3`
- CVSS 9.5 ([GHSA-2xp9-vwfh-vxw4](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4))

Die bereitgestellte Deployment-Unit ist auf Linux/systemd ausgelegt. Damit ist die Windows-RCE **für das dokumentierte Standarddeployment nicht unmittelbar reproduzierbar**. Das Dependency-Level bleibt trotzdem ein Problem, weil `package.json` eine vulnerable Basisversion zulässt, die Anwendung Next App Router verwendet und 16.3.1 nicht mehr auf dem sicheren Stand ist.

## Beweis

```json
"next": "^16.3.1"
```

```bash
npm ls next
# Erwartet (sicher): >= 16.3.3
# Tatsächlich: Range lässt 16.3.1 zu
```

## Remediation (aus Audit + eigene Bewertung)

Mindestens:

```json
"next": "^16.3.3"
```

bzw. besser auf den aktuellen stabilen Patchstand aktualisieren.

Danach:

```bash
npm install next@latest
npm ci
npm audit
npm run typecheck
npm run lint
npm run security:live-gate
```

Für ein Security-Gate nicht nur auf `^16.3.3` vertrauen, sondern den tatsächlich aufgelösten Lockfile-Stand überwachen.

## Akzeptanzkriterien / Tests

- [ ] Aufgelöste `next`-Version ≥ 16.3.3 im Lockfile
- [ ] `package.json` lässt keine Version `<16.3.3` zu
- [ ] `npm run typecheck` / `lint` / `security:live-gate` grün
- [ ] Changelog mit GHSA-/CVE-Referenzen

## Changelog-Blurb

```
SEC-03 (HIGH): next auf >=16.3.3 aktualisiert (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4)
```

## Versions-Hinweis

PATCH, Dependency-Fix — sofort.

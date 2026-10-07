# DC-09 — Kein generiertes Inventar, kein automatisierter Versions-Bump

- **ID:** DC-09
- **Severity:** LOW (Prozess, aber Ursache von DC-04/DC-05/DC-07)
- **Bereich:** Release-/Doku-Prozess
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Beobachtung der Repo-Konventionen
- **Status:** ☐ **OPEN**
- **Prompt:** [`../prompts/PROMPT-DC-09-inventare-und-release-bump.md`](../prompts/PROMPT-DC-09-inventare-und-release-bump.md)
- **Datei(en):** `scripts/` (neu: Inventar-Generator, Bump-Skript), `package.json` (npm-Skripte), `docs/generated/` (neu), `CONTRIBUTING.md`

## Beschreibung

Zwei wiederkehrende Pflegeaufgaben sind vollständig manuell und dadurch die
Wurzel mehrerer Befunde:

1. **Versions-Header:** Jeder Release müsste 40+ Status-Header anfassen
   (`CONTRIBUTING.md`: „Status-Header jeder Doku-Datei aktualisieren"). Faktisch
   passiert das bei 4 von 45 Dokumenten (DC-04).
2. **Mengenverzeichnisse** (Tabellen, Routen, Env-Flags, Faktoren, Migrationen)
   werden per Hand gepflegt und driften: Tabellen 15/67 (DC-07), Env-Flags
   (DC-05), Symbole/Pfade (DC-06), Faktor-Doku (immer wieder).

Das Repo hat bereits ein Erfolgsbeispiel für Generierung:
`STRATEGY_TEMPLATES.md` wird per `npm run docs:templates`
(`scripts/gen-strategy-templates-doc.ts`) erzeugt und ist **byteweise** durch
`tests/strategies.templates.test.ts` geprüft. Dasselbe Muster fehlt für die
übrigen Mengen.

## Lösungsvorschlag (Prompt DC-09)

1. **Inventar-Generator** `scripts/gen-docs-inventories.ts` (deterministisch,
   sortiert, LF, kein Zeitstempel außer einem expliziten `Stand`-Datum aus
   einem Parameter/Env, damit der Byte-Vergleich stabil bleibt):
   - `docs/generated/route-inventory.md` (aus `src/app/api/**/route.ts`,
     inkl. Guard-Klasse pro Route)
   - `docs/generated/env-inventory.md` (aus echten Read-Idiomen +
     `.env.example`-Abgleich: „gelesen/undokumentiert", „dokumentiert/ohne Read")
   - `docs/generated/schema-inventory.md` (aus `src/db/schema.ts` +
     `drizzle/*.sql`: Tabelle, Spaltenanzahl, Migration)
   - `docs/generated/guard-inventory.md` (Firm-/Broker-Routen mit
     `requirePermission`/`guardWrite`/CSRF — verhindert Rückfälle zu DC-01)
2. **npm-Skripte:** `docs:inventories` (erzeugen) und `docs:inventories:check`
   (Diff gegen committed Stand, exit ≠ 0 bei Abweichung); letzteres in
   `docs:validate` oder als eigener Required-Check.
3. **Bump-Skript** `scripts/bump-docs-version.ts`: liest die Version aus
   `package.json`, aktualisiert die `Code-Version`-Header in allen
   Fachdokumenten (ohne Archive/Audits), lässt „Dokument-Version"-Header
   unangetastet, druckt eine Diff-Zusammenfassung. Aufruf im Release-Ablauf
   dokumentieren (`CONTRIBUTING.md`/`CHANGELOG.md`).
4. **Konvention festschreiben:** `CONTRIBUTING.md` erhält einen Absatz
   „Generierte Dokumente" (nicht per Hand editieren; Kopfzeile „GENERIERT —
   nicht editieren") und „Zwei Header-Arten" (`Code-Version` = Modulstand,
   `Dokument-Version` = eigene Vokabularversion).

## Verifikation nach Umsetzung

```bash
npm run docs:inventories && git diff --exit-code docs/generated/   # idempotent
npm run docs:inventories:check                                     # grün
node --import tsx scripts/bump-docs-version.ts --dry-run           # zeigt geplante Header-Änderungen
```

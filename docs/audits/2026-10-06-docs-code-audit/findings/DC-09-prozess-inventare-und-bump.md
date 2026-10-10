# DC-09 — Kein generiertes Inventar, kein automatisierter Versions-Bump

- **ID:** DC-09
- **Severity:** LOW (Prozess, aber Ursache von DC-04/DC-05/DC-07)
- **Bereich:** Release-/Doku-Prozess
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Beobachtung der Repo-Konventionen
- **Status:** ☑ **FIXED** (2026-10-10, DC-09)
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

## Umsetzung (2026-10-10)

**Umfang:** Generator, Drift-Gate, Bump-Skript, CI-Schritt, Konvention in `CONTRIBUTING.md`.
Kein Versions-Bump (`package.json` bleibt `0.17.2`; der Release-Bump ist eine bewusste
Release-Entscheidung).

| Artefakt | Rolle |
|----------|-------|
| `scripts/gen-docs-inventories.ts` | Einziger Generator/Prüfer für `docs/generated/` (`--stand YYYY-MM-DD` optional, `--check` schreibt nichts) |
| `docs/generated/route-inventory.md` | 87 Routen, 106 Handler, Guard-Klasse je Methode; Warnzeile am Tabellenkopf für schreibende Methoden ohne Guard |
| `docs/generated/env-inventory.md` | 298 Env-Namen mit Spalten „gelesen / `.env.example` / `CONFIGURATION.md`“ und den Warnzeilen „gelesen, aber nirgends dokumentiert“ / „dokumentiert, aber kein Read“ |
| `docs/generated/schema-inventory.md` | 67 `pgTable`-Definitionen (Renderer `scripts/gen-schema-inventory.ts`, DC-07) |
| `scripts/bump-docs-version.ts` | `--dry-run` / `--write`; ersetzt nur die `Code-Version` in `docs/**` (ohne archive/audits/peer-reviews/generated), kein `git` |
| `npm run docs:inventories[:check]`, `docs:bump-version[:dry-run]` | npm-Skripte |
| `docs/ci/docs-validate.workflow.yml` + Spiegel `.github/workflows/main.yml` | Schritt „Generierte Inventare aktuell“ (`docs:inventories:check`); Spiegel byte-identisch |
| `tests/docsInventories.test.ts` | Verträge: Drift-Gate, Determinismus, Stand-Optionalität, Warnzeile, Gate für Sichtungsliste, Bump-Erfassung |

**Abweichung vom Lösungsvorschlag:** Die vorgeschlagene eigene `guard-inventory.md` ist in
`route-inventory.md` aufgegangen (eine Quelle statt zwei). Die Guard-Klasse wird über
Helfer und Imports verfolgt (z. B. `guardCredentialEndpoint` → `requirePermission` + CSRF),
Permissions aus Variablen erscheinen als `requirePermission(dynamisch)`.

**Gate statt nur Warnung:** Die Warnzeile allein verhindert keinen Rückfall. Deshalb führt
`REVIEWED_UNGUARDED_WRITES` (in `gen-docs-inventories.ts`) jede schreibende Route ohne
sichtbaren Guard **mit Begründung**. `--check` schlägt fehl bei neuen, ungesichteten Routen
und bei veralteten Einträgen. Stand 2026-10-10: fünf gesichtete Fälle — `POST /api/auth/login`
(Anmeldung selbst), `POST /api/auth/refresh` (CSRF in `renewSession`), drei reine
Rechen-POSTs unter `/api/portfolio/*` (keine Persistenz).

**Analysator-Fix:** Computed-Keys in Objekt-Maps (`[BINANCE_VENUE]: BINANCE_ENABLED_FLAG`)
wurden übersehen; damit galten `BINANCE_ENABLED`, `KRAKEN_ENABLED`, `IBKR_ENABLED`,
`PAPER_ENABLED` fälschlich als „dokumentiert, ohne Read“. Der Fix wirkt in
`docs-validate-checks.ts` und damit auch in L1.

**Verifikation:**

```bash
npm run docs:inventories && cp -r docs/generated /tmp/g1 && npm run docs:inventories
diff -r /tmp/g1 docs/generated && echo IDEMPOTENT          # zweiter Lauf ohne Diff ✔
npm run docs:inventories:check                              # exit 0 ✔
echo "x" >> docs/generated/env-inventory.md
npm run docs:inventories:check                              # exit 1 (Gegenprobe) ✔
npm run docs:inventories                                # Stand wiederherstellen
node --import tsx scripts/bump-docs-version.ts --dry-run    # 0 Änderungen: alle 66 Code-Version-Header stehen auf 0.17.2
node --import tsx --test tests/docsInventories.test.ts      # 13/13 ✔
npm run typecheck && npm run lint && npm run docs:validate  # grün ✔
```

**Befund zur Akzeptanz „dry-run listet genau die DC-04-Code-Version-Zeilen“:** Die 66
Code-Version-Header (3 verifiziert + 63 Bestandsdokumente) stehen bereits auf `0.17.2`, daher
listet der Dry-Run heute 0 Änderungen und zählt 66 „bereits aktuell“. Dass nur diese
Header erfasst werden, prüft der Test mit einer simulierten Zielversion (`9.9.9`): genau die
Mischzeile in `DEVILS_ADVOCATE.md` wandert (Code-Version), `Dokument-Version` bleibt; reine
Dokument-Version-Dateien erscheinen nicht.

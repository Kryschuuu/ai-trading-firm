# PROMPT DC-09 — Generierte Inventare + Release-Doku-Bump

```text
TASK: Baue den dauerhaften Mechanismus, der DC-04/DC-05/DC-07 künftig
verhindert: generierte Mengen-Inventare und ein Versions-Bump für Kopfzeilen.

BEFUND (Audit docs/audits/2026-10-06-docs-code-audit/findings/DC-09-prozess-inventare-und-release-bump.md):
Mengenverzeichnisse (Tabellen, Routen, Env-Flags, Faktoren, Migrationen) werden
per Hand gepflegt und driften (15/67 Tabellen, 4 Flags ohne Read, 41 falsche
Header). Das Repo hat bereits ein Erfolgsmuster: docs/STRATEGY_TEMPLATES.md wird
per scripts/gen-strategy-templates-doc.ts erzeugt und von
tests/strategies.templates.test.ts byteweise geprüft.

DO:
1. scripts/gen-docs-inventories.ts (deterministisch, LF, stabile Sortierung,
   Stand-Datum nur via --stand/Env, sonst diff-instabil):
   - docs/generated/route-inventory.md: Routen aus src/app/api/**/route.ts mit
     HTTP-Methoden und Guard-Klasse (requirePermission(Permission) |
     guardWrite | checkApiToken | CSRF | keiner) — PFLICHT: "keiner" + schreibende
     Methode als Warnzeile am Kopf der Tabelle (Rückfall-Schutz zu DC-01).
   - docs/generated/env-inventory.md: Reads (Idiome aus DC-08-L1) vs.
     .env.example vs. CONFIGURATION.md — drei Spalten "gelesen", "in
     .env.example", "in CONFIGURATION.md", plus Warnzeilen
     "gelesen, aber nirgends dokumentiert" / "dokumentiert, aber kein Read".
   - docs/generated/schema-inventory.md (siehe Prompt DC-07).
   - Kopfzeile jeder Datei: "GENERIERT — nicht editieren (npm run docs:inventories)".
2. package.json: "docs:inventories": Generator, "docs:inventories:check":
   Generator in tmp + diff gegen committed Stand (exit != 0 bei Abweichung).
   Letzteres in docs:validate ODER als eigener Schritt in
   docs/ci/docs-validate.workflow.yml (Spiegel-Sync zu .github/workflows/
   danach per diff prüfen).
3. scripts/bump-docs-version.ts: liest package.json-Version, aktualisiert
   `Code-Version`-Header in docs/**/*.md (ohne archive/audits/peer-reviews/
   generated), lässt "Dokument-Version" unangetastet, --dry-run zeigt die
   Änderungen, --write führt sie aus. Kein git-Befehl im Skript.
4. Konvention in CONTRIBUTING.md festschreiben:
   - "Generierte Dokumente": nie per Hand editieren; Änderungen via npm-Skript +
     Commit des Generats.
   - "Zwei Header-Arten": Code-Version (Modulstand, CI-geprüft) vs.
     Dokument-Version (eigene Vokabular-/Formatversion, nicht CI-geprüft).
   - Release-Ablauf: npm run docs:inventories && node --import tsx
     scripts/bump-docs-version.ts --write vor dem Release-Commit.

AKZEPTANZ:
- `npm run docs:inventories` zweimal => zweiter Lauf ohne Diff.
- `npm run docs:inventories:check` grün und wird bei manueller Änderung einer
  generierten Datei rot (Gegenprobe dokumentieren).
- bump-docs-version --dry-run listet genau die Kopfzeilen, die DC-04 als
  Code-Version klassifiziert hat; "Dokument-Version"-Zeilen stehen nicht darin.
- `npm run typecheck`, `npm run lint`, `npm run docs:validate` grün;
  Workflow-Spiegel byte-identisch.
```

## Hinweise für die ausführende Session

- Das Generat gehört ins Repo (kleines Markdown), **nicht** in `.gitignore` —
  der Sinn ist der Diff-freie Nachweis im PR.
- Keine Zeitstempel/Umgebungsinformationen in generierte Dateien außer dem
  expliziten Stand-Datum.
- Wenn der Generator eine Abweichung findet (z. B. Route ohne Guard), darf er
  nicht rot werden, bevor DC-08-Land gelandet ist: erst als Warnblock am
  Tabellenkopf, die Verschärfung kommt in DC-08.

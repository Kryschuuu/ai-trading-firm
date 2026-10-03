# STX-08-02 — In-App-Doku-Viewer: `docs/architecture/` und `docs/roadmap/` auflösen

- **Phase:** 8 · **Paket:** eigenständig · **Finding:** Altlast 3 aus [`../remediation/TRACKING.md`](../remediation/TRACKING.md#bekannte-code-altlasten-durch-00-03-aufgedeckt-nicht-teil-der-32-prompts) (OP-6)
- **Risiko:** minimal (isolierter Fallback-Pfad, keine Sicherheitsgrenze)

## Zweck

Der Browser-Doku-Viewer findet `STRATEGY_STACK.md`, `PIPELINE_MAP.md`,
`DB_SCHEMA.md`, `INTEGRATION_POINTS.md` und den ADR-Log `DECISIONS.md` nicht —
obwohl genau diese Dateien die Single-Source-of-Truth für die
Template-/Screening-Arbeit sind (ADR-008…010, SSoT-Karte aus 00-02). Wer die
Entscheidungen im UI nachlesen will, muss ins Repo wechseln.

## Kontext

`resolveDoc()` in `src/lib/docsCatalog.ts` arbeitet dreistufig:

1. Katalog-Slug (`DOCS_CATALOG`)
2. Katalog-Dateiname (case-insensitiv)
3. **Existenz-Fallback** über eine feste Unterordner-Liste
   (`src/lib/docsCatalog.ts:376-383`):

```ts
const searchPaths = [
  `docs/${safeBase}`,
  `docs/audits/${safeBase}`,
  `docs/peer-reviews/${safeBase}`,
  `docs/security/${safeBase}`,
  `docs/archive/${safeBase}`,
  safeBase, // Root-Dateien wie CHANGELOG.md, CONFIGURATION.md
];
```

`docs/architecture/` und `docs/roadmap/` fehlen. Beide Ordner existieren:

```
docs/architecture/  DB_SCHEMA.md  INTEGRATION_POINTS.md  PIPELINE_MAP.md  STRATEGY_STACK.md
docs/roadmap/       DECISIONS.md  STATUS.md
```

Der Pfad wird ausschließlich über ein **bereinigtes Basename** konstruiert
(`basename()` + Ablehnung von `/`, `\`, `..`), Path-Traversal ist strukturell
ausgeschlossen. Diese Eigenschaft **muss erhalten bleiben**.

## Auftrag

1. Ergänze in `resolveDoc()` die Suchpfade `docs/architecture/${safeBase}` und
   `docs/roadmap/${safeBase}`. Reihenfolge: nach `docs/security/`, vor
   `docs/archive/` — alphabetisch-neutral und ohne Änderung der bestehenden
   Prioritäten.
2. **Kein** Refactoring der dreistufigen Auflösung, **kein** rekursiver
   `docs/**`-Walk (der Kommentar unter der Schleife lehnt ihn bewusst ab).
3. Prüfe, ob die vier Architektur-Dateien und `DECISIONS.md` zusätzlich als
   Katalogeinträge (`DOCS_CATALOG`) geführt werden sollen. Falls ja: Slug,
   `title`, `subtitle` im Stil der bestehenden Einträge. Falls nein: im
   PR-Text begründen — der Existenz-Fallback reicht dann.
4. Test in der bestehenden UI-/Katalog-Testsuite (Suche über
   `tests/ui/` bzw. vorhandene `docsCatalog`-Tests; gibt es keinen, neu als
   `tests/docsCatalog.test.ts`):
   - `resolveDoc("STRATEGY_STACK.md")` und `resolveDoc("DECISIONS.md")` lösen auf
   - `resolveDoc("../architecture/STRATEGY_STACK.md")` und
     `resolveDoc("architecture/STRATEGY_STACK")` lösen **nicht** auf
     (Traversal-/Pfadabwehr bleibt)
   - bestehende Auflösungen (`audits/README.md`, `security/README.md`,
     `CHANGELOG.md`) unverändert

## Randbedingungen — nicht anfassen

- **Keine** Änderung der Slug-/Katalog-Semantik bestehender Dokumente; kein
  bestehender Slug darf seine `canonicalPath` verlieren.
- **Keine** Aufweichung der Path-Traversal-Abwehr — `basename()` und die
  Trenner-Prüfung bleiben.
- **Keine** neuen Ordner unter `docs/`, keine Datei-Umzüge.
- **Kein** Produktivcode außerhalb `src/lib/docsCatalog.ts` (+ ggf. ein
  Katalog-Eintrag).
- **Kein** LLM-, Rule- oder Broker-Pfad.

## Abnahmekriterien

- [ ] `docs/architecture/*.md` und `docs/roadmap/*.md` sind über `resolveDoc()`
      auffindbar
- [ ] Traversal-Negativtests grün (`..`, `/`, `\` werden weiter abgewiesen)
- [ ] Bestehende Auflösungen unverändert (Regressionstest)
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] `npm run docs:validate` grün
- [ ] Altlast 3 in [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
      als behoben markiert (OP-6 teilweise abgeräumt)

## Tests

```bash
npm test -- tests/docsCatalog.test.ts   # bzw. die bestehende Katalog-Suite
npm run typecheck && npm run lint && npm run docs:validate
```

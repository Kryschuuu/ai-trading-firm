# Remediation-Tracking — Arena-Review-Serie (2026-09-08)

Diese Datei ist die **einzige Wahrheit** für den Status aller Findings dieses
Audits.

| ID | Titel | Severity | Status | Fix-Version | PR / Branch | Assignee | Notizen |
|----|-------|----------|--------|-------------|-------------|----------|---------|
| RESTORE-01 | Restore des Firmenzustands pro Aufrufer (keine Bündelung, kein Versuchsdeckel, kein Index) | MEDIUM | FIXED | v1.36.37 | [PR #123](https://github.com/Kryschuuu/ai-trading-firm/pull/123), Branch `arena/01a080a3-ai-trading-firm` | - | Single-Flight + 5-s-Backoff + Log-Dedup in `src/lib/engine.ts`; partieller Index `positions_open_idx` (`src/db/schema.ts`, `drizzle/2026-09-08_positions_open_idx.sql`); 9 Regressionstests in `tests/engine.stateRestore.test.ts` (vorher rot). Wörtlicher Python-Pfad des Findings: nicht anwendbar, Nachweis in [`../report.md`](../report.md) |

## Legende

- **Status:**
  - OPEN — Gefunden, noch nicht bearbeitet
  - IN_PROGRESS — Fix in Arbeit (Branch angeben)
  - FIXED — Gefixt, mit Version und PR belegt
  - WONTFIX — Bewusst nicht gefixt, mit Begründung
  - FALSE_POSITIVE — Kein echtes Problem, mit Begründung

## Bewertungsschema dieser Serie

Ein Prompt aus der Serie kann sich auf einen anderen Stack beziehen. Deshalb
werden zwei Ebenen getrennt protokolliert:

- **Wortlaut-Ebene:** existieren die genannten Dateien/Symbole hier? Wenn
  nein: `FALSE_POSITIVE` für den Wortlaut, mit Nachweis (kein stilles
  „erledigt“, aber auch kein erzwungener No-op-Fix).
- **Klasse-Ebene:** existiert derselbe Fehlermechanismus im realen Stack? Wenn
  ja: normales Finding mit `FIXED`/`OPEN` wie jedes andere — hier RESTORE-01.

## Verlauf

- 2026-09-08: Audit angelegt (Prompt 13 der Arena-Serie). Wortlaut als
  nicht-anwendbar nachgewiesen (0 Python-Dateien, `trading/` fehlt, keine
  Treffer in Code/Historie); Klasse auf `getBroker()`-Hydration bestätigt.
- 2026-09-08: RESTORE-01 in v1.36.37 behoben; Red-/Green-Nachweis im Finding.
  Tests: 2005 bestehende + 9 neue, 0 Fehler; Typecheck, Lint und
  `docs:validate` grün.

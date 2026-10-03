# STX-20 — Copy-Engine (07-03) ist gemergt, aber nicht im Changelog

- **ID:** STX-20
- **Severity:** LOW
- **Bereich:** Doku / Versionierung
- **Quelle:** eigener Befund im Abgleich [2026-10-03](../remediation/RECONCILE-2026-10-03.md)
- **Status:** OPEN
- **Fix-Version:** — (offen; Release-Entscheidung steht aus)
- **Datei(en):** `CHANGELOG.md`, `package.json`, `drizzle/2026-10-04_copy_engine_gates.sql`

## Beschreibung

Prompt 07-03 (Bitunix-Leader-Adapter + Simulate-only-Follower + Engine + CLI) ist
mit PR #215 (Commit `5f437d8`, 2026-10-03) in `main` gemergt. Die
Repo-Konvention verlangt, dass jede für Nutzer sichtbare Änderung in
`CHANGELOG.md` steht — erst unter `[Unreleased]`, dann im Release
([`../VERSIONING.md`](../VERSIONING.md) §3 Regel 1). Für 07-03 gibt es **keinen**
Eintrag.

Damit ist das Changelog hinter dem Code zurück: Wer die
Änderungshistorie liest, erfährt nichts über einen neuen, ausführbaren
CLI-Pfad (`npm run copy:paper`) und nichts über eine additive Migration.

## Beweis

```
$ awk '/^## \[Unreleased\]/,/^## \[0.10.6\]/' CHANGELOG.md
## [Unreleased]

## [0.10.6] — Copy-Policy-Engine + Order-Links (STX-07-02) (2026-10-03)
```

`[Unreleased]` ist leer; der oberste Eintrag `[0.10.6]` trägt ausdrücklich
`(STX-07-02)` und beschreibt nur Policy-Engine und Order-Links.

```
$ grep -n "copy:paper|run-copy-paper|NO_BASELINE|STX-07-03" CHANGELOG.md
# → 0 Treffer
```

Gleichzeitig ist das Feature im Baum:

- `package.json` → `"copy:paper": "node --import tsx scripts/run-copy-paper.ts"`
- `scripts/run-copy-paper.ts`, `src/copy/engine.ts`, `src/copy/leader/bitunix.ts`,
  `src/copy/follower/simulated.ts` vorhanden
- `drizzle/2026-10-04_copy_engine_gates.sql` (2 467 Byte) legt `NO_BASELINE` als
  Policy-Code und die Spalte `follower_notional` an — ebenfalls ohne
  Changelog-Nennung
- `tests/copy.engine.test.ts` → **20 Tests, 0 Fehler** (lokal ausgeführt)

`package.json` steht weiter auf `0.10.6`; `docs:validate` bleibt grün, weil
sein Versions-Check nur `package.json` gegen den **obersten** `## [x.y.z]`-Eintrag
des Changelogs prüft — ein leerer `[Unreleased]`-Block fällt nicht auf.

## Remediation

Eintrag unter `[Unreleased]` (oder als `v0.10.7`, wenn ein Release gewünscht ist)
mit: Leader-Adapter, Simulate-only-Follower, Engine, CLI `npm run copy:paper`,
Migration `2026-10-04_copy_engine_gates.sql`, Tests. **Kein** Rückdatieren auf
`[0.10.6]` — der Eintrag ist veröffentlicht und beschreibt 07-02.

Die Entscheidung `v0.10.7` vs. `[Unreleased]` ist eine Release-Entscheidung und
gehört nicht in einen Audit-PR. Deshalb eigener Prompt:
[PROMPT-STX-08-01](../prompts/PROMPT-STX-08-01-changelog-nachtrag-copy-engine.md).

## Akzeptanzkriterien

- [ ] `CHANGELOG.md` nennt `npm run copy:paper` und die Migration
      `2026-10-04_copy_engine_gates.sql`
- [ ] Der Eintrag steht unter `[Unreleased]` **oder** in einem neuen
      `## [x.y.z]`-Block mit dann passendem `package.json`-Bump — nicht
      nachträglich in `[0.10.6]`
- [ ] Bei Bump: `VERSION.md`, `README.md`-Status-Header und
      `docs/README.md`-Versionszeile im selben Commit
      ([`../VERSIONING.md`](../VERSIONING.md) §3 Regel 6)
- [ ] `npm run docs:validate` grün (Versions-Konsistenz)

## Versions-Hinweis

Bei `[Unreleased]`-Eintrag: keiner. Bei Bump: Patch/Minor nach Inhalt — das
Feature ist additiv, `SIMULATE_ONLY` bleibt hart.

# STX-20 — Copy-Engine (07-03) ist gemergt, aber nicht im Changelog

- **ID:** STX-20
- **Severity:** LOW
- **Bereich:** Doku / Versionierung
- **Quelle:** eigener Befund im Abgleich [2026-10-03](../remediation/RECONCILE-2026-10-03.md)
- **Status:** FIXED — Prompt 08-01, Form A, Nachtrag am 2026-10-03
- **Fix-Version:** `[Unreleased]` (Projekt-Code-Version `0.10.6`, kein `package.json`-Bump; Audit-Version `v1.2.1`)
- **Fix-Datum:** 2026-10-03
- **Datei(en):** `CHANGELOG.md`, `drizzle/2026-10-04_copy_engine_gates.sql`

## Beschreibung

Prompt 07-03 (Bitunix-Leader-Adapter + Simulate-only-Follower + Engine + CLI) ist
mit PR #215 (Commit `5f437d8`, 2026-10-03) in `main` gemergt. Die
Repo-Konvention verlangt, dass jede für Nutzer sichtbare Änderung in
`CHANGELOG.md` steht — erst unter `[Unreleased]`, dann im Release
([`../VERSIONING.md`](../VERSIONING.md) §3 Regel 1). Für 07-03 gab es zunächst
**keinen** Eintrag.

Damit war das Changelog hinter dem Code zurück: Wer die Änderungshistorie las,
erfuhr nichts über den neuen CLI-Pfad (`npm run copy:paper`) und nichts über
eine additive Migration.

## Beweis (Befund vor der Behebung)

```
$ awk '/^## \[Unreleased\]/,/^## \[0.10.6\]/' CHANGELOG.md
## [Unreleased]

## [0.10.6] — Copy-Policy-Engine + Order-Links (STX-07-02) (2026-10-03)
```

`[Unreleased]` war leer; der oberste Eintrag `[0.10.6]` trägt ausdrücklich
`(STX-07-02)` und beschreibt nur Policy-Engine und Order-Links.

```
$ grep -n "copy:paper|run-copy-paper|NO_BASELINE|STX-07-03" CHANGELOG.md
# → 0 Treffer
```

Gleichzeitig war das Feature bereits im Baum:

- `package.json` → `"copy:paper": "node --import tsx scripts/run-copy-paper.ts"`
- `scripts/run-copy-paper.ts`, `src/copy/engine.ts`, `src/copy/leader/bitunix.ts`,
  `src/copy/follower/simulated.ts` vorhanden
- `drizzle/2026-10-04_copy_engine_gates.sql` legt `NO_BASELINE` als Policy-Code
  fest und fügt die Spalte `follower_notional` hinzu
- `tests/copy.engine.test.ts` → **20 Tests, 0 Fehler** (lokal ausgeführt)

## Behebung (2026-10-03)

Der Nachtrag steht unter `[Unreleased]` in `CHANGELOG.md`; der veröffentlichte
Block `[0.10.6]` blieb unverändert. Gewählt wurde **Form A**: kein Bump von
`package.json`; Projekt-Code-Version, Status-Header, `VERSION.md` und die
Versionszeile in `docs/README.md` bleiben auf `0.10.6`.

Der Eintrag nennt `npm run copy:paper` mit `--dry-run` als Default, `--write`,
`--no-write`, `--replay`, `--leader-account`, `--symbols`, `--duration`,
`--max-events` und `--policy`; die Gates `NO_BASELINE` und
`PAUSED_NO_HEARTBEAT`; sowie die persistente Dedupe über `copy_order_links` im
Schreibmodus. Der Follower arbeitet ausschließlich auf dem Paper-Ledger (kein
`BrokerAdapter`, keine Venue-Order). Die Migration wird mit ihren beiden
Änderungen — `NO_BASELINE` als Policy-Code und Spalte `follower_notional` —
aufgeführt.

`tests/copy.engine.test.ts` deckt 20 Tests ohne Netzwerk mit injizierten Frames
ab. `npm run docs:validate` und `npm run typecheck` sind für diese Doku-Änderung
ausgeführt worden.

## Akzeptanzkriterien

- [x] `CHANGELOG.md` nennt `npm run copy:paper`, `NO_BASELINE` und die Migration
      `2026-10-04_copy_engine_gates.sql`.
- [x] Der Eintrag steht unter `[Unreleased]`, nicht nachträglich in `[0.10.6]`.
- [x] Form A gewählt: kein Projektversions-Bump; die Projekt-Versionsmetadaten
      bleiben auf `0.10.6`.
- [x] `npm run docs:validate` grün (Versions-Konsistenz).
- [x] `npm run typecheck` grün.

## Versions-Hinweis

Form A ist gewählt: Der Changelog-Nachtrag steht unter `[Unreleased]`; ein
Projektversions-Bump entfällt. Das Projekt bleibt Beta, `SIMULATE_ONLY` bleibt
unverändert.

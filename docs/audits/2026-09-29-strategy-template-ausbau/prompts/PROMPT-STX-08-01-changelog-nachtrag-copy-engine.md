# STX-08-01 — Changelog-Nachtrag für die Copy-Engine (07-03)

- **Phase:** 8 · **Paket:** eigenständig (keine Voraussetzung) · **Finding:** [STX-20](../findings/STX-20-changelog-nachtrag-copy-engine.md)
- **Risiko:** minimal (reine Doku, kein Produktivcode)

## Zweck

Prompt 07-03 ist mit PR #215 (`5f437d8`, 2026-10-03) in `main` gemergt, steht aber
nicht im Changelog: `[Unreleased]` ist leer, der oberste Eintrag `[0.10.6]`
beschreibt ausschließlich 07-02. Nutzer sehen damit einen neuen CLI-Pfad
(`npm run copy:paper`) und eine additive Migration, die in der
Änderungshistorie nicht vorkommen.

## Kontext

Repo-Konvention ([`../VERSIONING.md`](../VERSIONING.md) §3 Regel 1): *„Jeder Release
beginnt mit `CHANGELOG.md` unter `[Unreleased]`."* Der Changelog folgt
[Keep a Changelog 1.1.0](https://keepachangelog.com/de/1.1.0/) mit deutschen
Abschnitten `### Added` / `### Changed` / `### Fixed` / `### Tests`.

Was in `main` vorhanden ist und dokumentiert werden muss:

| Artefakt | Beleg |
|---|---|
| `scripts/run-copy-paper.ts` + `package.json`-Script `copy:paper` | `package.json` |
| `src/copy/engine.ts` (Orchestrierung, Dedupe, Leader-Tor) | `src/copy/engine.ts` |
| `src/copy/leader/bitunix.ts` (WS-Order-Frames → `NormalizedLeaderTrade`) | `src/copy/leader/bitunix.ts` |
| `src/copy/follower/simulated.ts` (Simulate-only-Follower auf Paper-Ledger) | `src/copy/follower/simulated.ts` |
| Migration `NO_BASELINE` + `follower_notional` | `drizzle/2026-10-04_copy_engine_gates.sql` |
| 20 Tests, kein Netzwerk, injizierte Frames | `tests/copy.engine.test.ts` (lokal ausgeführt: 20/20 grün) |

Referenztext mit den fachlichen Details: [`../ROADMAP.md`](../ROADMAP.md),
Abschnitt „Ergebnis 07-03".

## Auftrag

1. Entscheide **eine** der beiden Formen und ziehe sie durch:
   - **(A) `[Unreleased]`-Eintrag** — kein `package.json`-Bump. Empfohlen, wenn
     07-03 mit dem nächsten Feature-Release rausgehen soll.
   - **(B) neuer `## [0.10.7]`-Block** — dann `package.json` auf `0.10.7`,
     `CHANGELOG.md`-Status-Header `Code-Version **0.10.7**`, `VERSION.md` und
     die Versionszeile in `docs/README.md` **im selben Commit**
     ([`../VERSIONING.md`](../VERSIONING.md) §3 Regel 6).
2. Schreibe den Eintrag im Stil von `[0.10.6]`: `> **Status: Beta.**`-Blockquote,
   dann `### Added` / `### Tests`.
3. Nenne ausdrücklich: `npm run copy:paper` mit `--dry-run` als Default,
   `--write`/`--no-write`, `--replay`, `--leader-account`, `--symbols`,
   `--duration`, `--max-events`, `--policy`; das Baseline-Gate `NO_BASELINE`;
   die Heartbeat-Pause `PAUSED_NO_HEARTBEAT`; die persistente Dedupe über
   `copy_order_links`; und dass der Follower **ausschließlich** auf dem
   Paper-Ledger arbeitet (kein `BrokerAdapter`, keine Venue-Order).
4. Nenne die Migration `drizzle/2026-10-04_copy_engine_gates.sql` mit ihren zwei
   Änderungen (`NO_BASELINE` als Policy-Code, Spalte `follower_notional`).
5. Markiere den Eintrag als Nachtrag, z. B. einleitender Satz:
   *„Nachtrag zu PR #215 (2026-10-03), im Changelog nachgereicht am <Datum>."*

## Randbedingungen — nicht anfassen

- **Kein** Produktivcode. Keine Datei unter `src/`, `scripts/`, `drizzle/`,
  `tests/`.
- **Kein** nachträgliches Editieren des veröffentlichten Blocks `[0.10.6]` — der
  beschreibt 07-02 und bleibt stehen.
- **Kein** Erfinden von Versionen, Daten oder Metriken: nur was im Baum liegt.
- **Keine** Änderung an `SIMULATE_ONLY`, `RULE_ALLOWED_SIDE`, den Copy-Tabellen
  oder der Policy-Engine.
- **Kein** Beta-Exit-Versprechen: der `> **Status: Beta.**`-Block bleibt
  ([`../../../BETA_STATUS.md`](../../../BETA_STATUS.md)).

## Abnahmekriterien

- [ ] `CHANGELOG.md` nennt `npm run copy:paper`, `NO_BASELINE` und die Migration
      `2026-10-04_copy_engine_gates.sql`
- [ ] Der Eintrag steht unter `[Unreleased]` **oder** in einem neuen
      `## [x.y.z]`-Block — nicht in `[0.10.6]`
- [ ] Bei Form (B): `package.json`, Status-Header, `VERSION.md` und
      `docs/README.md`-Versionszeile stimmen überein
- [ ] `npm run docs:validate` grün (prüft `package.json` ↔ Changelog ↔
      Status-Header ↔ `docs/README.md`)
- [ ] Findings/TRacking nachgezogen: [STX-20](../findings/STX-20-changelog-nachtrag-copy-engine.md)
      auf `FIXED` mit Version/Datum, [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
      und [`../ROADMAP.md`](../ROADMAP.md) konsistent

## Tests

Keine neuen Tests (Doku). Pflicht-Checks:

```bash
npm run docs:validate
npm run typecheck   # muss unverändert grün bleiben
```

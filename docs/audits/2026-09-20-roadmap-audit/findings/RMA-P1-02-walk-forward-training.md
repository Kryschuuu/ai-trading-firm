# RMA-P1-02: 90d/30d Walk-Forward mit Train-Select-Freeze-Test

- **Antwort:** Ja (behoben)
- **Tracking-Status:** `FIXED`
- **Severity:** `CRITICAL`
- **Quick Estimate Restaufwand:** **0 PT** (Remediated in v1.60.0)
- **Umsetzungs-Prompt:** [`PROMPT-P1-02`](../prompts/PROMPT-P1-02-walk-forward-training.md)

## Verifizierte Fundstellen

- `src/backtest/walkforward.ts` — Kandidatenvalidierung, IS-Selektor mit deterministischen Tie-Breaks, Freeze-Artefakt-Erstellung, Leakage-Protection & Holdout-Ausführung.
- `src/backtest/tradeLedger.ts` — Inhalts-Idempotenzschlüssel inklusive Selection- & Freeze-Hashes.
- `src/backtest/runStore.ts` — DB-Persistenz von Candidate Freeze Artifacts & Holdout Summaries in `paramsJson`.
- `scripts/run-backtest.ts` — CLI-Verdrahtung für Kandidatenraum, Selektor-Gates, Holdout-Tage und Renderung von Freeze Tables in Markdown.
- `tests/backtest.trainSelectFreeze.test.ts` — 9/9 bestandene Unit-Tests.

## Bewertung und Abgrenzung

Walk-Forward wurde vollständig um ein echtes Train-Select-Freeze-Test Paradigma erweitert. Kandidaten werden isoliert auf IS bewertet und ausgewählt; ausgewählte Kandidaten werden immutable eingefroren und auf OOS evaluiert; ein finales Holdout-Segment läuft strikt isoliert nach allen Window-Entscheidungen.

## Konkretes Delta (Remediated in v1.60.0)

- [x] Bounded Candidate Contract mit stable ID, strategy/rule version und serialisierbarer Config.
- [x] IS-Selector mit konfigurierbaren Zielmetriken & harten Mindestgates sowie deterministischem Tie-Breaking.
- [x] Immutable Freeze Artifact per Window mit Score-Tabelle, Datenmanifest, Code/Config/Kandidat-Hashes, Seed & Cutoffs.
- [x] OOS-Ausführung ausschließlich mit der eingefrorenen Kandidaten-ID.
- [x] Finaler unberührter Holdout und Point-in-Time safe Leakage Protection (Embargo/Purge) an Fenstergrenzen.

## Akzeptanzkriterien für `FIXED`

- [x] kein OOS-Wert ist dem Selector zugänglich
- [x] jede Auswahl ist mit Score-Tabelle und Tie-Break-Regel reproduzierbar
- [x] mutierte OOS-Daten ändern nicht die IS-Auswahl
- [x] Holdout wird genau einmal nach abgeschlossener Modellentscheidung ausgewertet

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Remediation: Commit-Stand `arena/01a0c63d-ai-trading-firm`, Produktversion `v1.60.0`.
- Tests: `tests/backtest.trainSelectFreeze.test.ts` (9/9 pass) & `tests/backtest*.test.ts` (111/111 pass).
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)


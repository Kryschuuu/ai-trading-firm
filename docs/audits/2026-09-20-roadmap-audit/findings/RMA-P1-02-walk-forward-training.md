# RMA-P1-02: 90d/30d Walk-Forward mit Train-Select-Freeze-Test

- **Antwort:** Behoben
- **Tracking-Status:** `FIXED`
- **Severity:** `CRITICAL`
- **Fix-Version:** `v1.60.0`
- **Fix-PR:** [#157](https://github.com/Kryschuuu/ai-trading-firm/pull/157)
- **Fix-Commit:** `10e83f3` (inkl. `a0e17df` Implementierung)
- **Umsetzungs-Prompt:** [`PROMPT-P1-02`](../prompts/PROMPT-P1-02-walk-forward-training.md)

## Verifizierte Fundstellen

- `src/backtest/walkforward.ts::computeWalkForwardWindows()` — konfigurierbare In-Sample-/Out-of-Sample-Fenster mit 90d/30d-Defaults.
- `src/backtest/walkforward.ts::runWalkForward()` — replayt IS und OOS und aggregiert Fenster.
- `src/backtest/walkforward.ts::hashTrades()` — deterministischer Trade-Hash.
- `scripts/run-backtest.ts` — CLI-Verdrahtung für Walk-Forward-Läufe.

## Bewertung und Abgrenzung

Das Delta ist in v1.60.0 produktiv verdrahtet. Der historische Aufruf ohne
Kandidaten bleibt ausdrücklich Replay-only-kompatibel; ein Kandidatenraum
aktiviert den echten Train-Select-Freeze-Test. Die Auswahl-API akzeptiert nur
IS-Summaries, OOS und Holdout sind strukturell nicht Teil des Selectors.

## Umgesetztes Design

- bounded Kandidatenvertrag mit stabiler ID, Strategieversion und
  serialisierbarer Config (max. 64 Kandidaten, max. 8 Strategien je Kandidat;
  NaN, Duplikate, Secretschlüssel und unbounded Werte werden abgewiesen)
- konfigurierbare IS-Zielmetrik und harte Gates, stabile Tie-Breaks mit
  kanonischer Kandidaten-ID als letzter Ordnung; `null`/unavailable bleibt
  fail-closed
- pro Fenster und für die finale IS-Gesamtentscheidung ein deep-frozen
  `wf-freeze-1`-Artefakt mit Score-Tabelle, Daten-/Code-/Config-/Kandidatenhash,
  Seed, Cutoffs und Leakage-Policy
- OOS mit exakt der eingefrorenen Kandidaten-ID; finaler Holdout erst nach
  Abschluss aller IS-Entscheidungen, mit eigenem Datenmanifest
- Purge/Embargo an Splitgrenzen sowie getrennte event-/availability- und
  computed-Zeiten; delayed availability wird vom aktuellen Eventzeit-Enginevertrag
  abgewiesen statt geleakt
- CLI/API und atomare Persistenz in `backtest_walkforward_freezes` (FK,
  Unique-Keys, Checks, DB-Trigger gegen UPDATE/DELETE)

## Akzeptanzkriterien für `FIXED`

- [x] kein OOS-Wert ist dem Selector zugänglich
- [x] jede Auswahl ist mit Score-Tabelle und Tie-Break-Regel reproduzierbar
- [x] mutierte OOS-Daten ändern nicht die IS-Auswahl; Manifest-/Freeze-Hash zeigt
      die Datenmutation
- [x] Holdout wird erst nach abgeschlossener Modellentscheidung ausgewertet
- [x] Roundtrip-/Idempotenzpfad schreibt Freeze-Artefakte atomar mit dem Run;
      fehlende Migration rollt fail-closed zurück

## Testevidenz

- `tests/backtest.walkforward.training.test.ts`: 5 Tests für IS-only
  Auswahl, OOS-ID-Gleichheit, Eingabereihenfolge/Tie-Break, Hash-Sensitivität,
  Purge/Embargo, Holdout-Reihenfolge und invalide/stale Inputs.
- `tests/backtest.engine.test.ts` + `tests/backtest.tradeLedger.test.ts`: 48
  gezielte Regressionstests bestanden, 11 DB-gegatete Skips ohne PostgreSQL.
- `tests/docsVersioning.test.ts`: 8 bestanden; `npm run typecheck`, `npm run
  lint` (0 Fehler, 6 bestehende Warnungen) und `npm run docs:validate`
  bestanden. `npm test` wurde auf Nutzeranweisung nicht ausgeführt.

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`; dieser Commit ist im
  aktuellen Checkout nicht auflösbar. Umsetzung adaptierte minimal den
  aktuellen Stand `fc8c5ea` / v1.59.0.
- Methode: statische Pfad-/Symbolprüfung, Schema-/Migration- und Testabgleich;
  keine reine Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

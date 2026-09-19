# GAP-01 — Backtesting-Engine mit Walk-Forward-Validierung (ohne Lookahead)

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧🔧🔧
**Kategorie:** Validierung · **Prompt:** [`PROMPT-01`](../prompts/PROMPT-01-backtesting-walk-forward.md)

## Befund (Co-Audit)

Einzige Möglichkeit, Strategien *vor* Paper-Betrieb auf Datenbasis zu bewerten.
Contra: LLM-Agenten sind nicht deterministisch und teuer → es braucht einen
regelbasierten „schnellen Pfad“; Overfitting-Gefahr auf historische News.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/cycle/steps/backtestStep.ts` — „Step 8: Backtest-Verifikation (nach
  Research)“, deterministisch, `llmAllowed: false`, prüft Setups gegen
  historische Kerzen (`HistoricalStore`), Kennzahlen aus `@/portfolio`
  (MaxDD, Profit Factor, Sharpe, Sortino).
- **Anti-Pattern bestätigt:** Bei `<5` Kerzen erzeugt der Step eine
  *synthetische* Serie („Repräsentative Serie aus 20 Trades mit 55 % Winrate“)
  und bewertet darauf — erzeugte statt gemessener Performance, still.
- `rule_backtests`-Tabelle + `POST /api/firm/rules/[id]/backtest` existieren
  (Regel-Backtest im Mikro-Zyklus).
- Kein Walk-Forward (IS/OOS), keine Zeitmasken-Architektur, keine
  gespeicherten/vergleichbaren Backtest-Runs über Strategien hinweg.

## Delta

1. Regelbasierte Backtesting-Engine (replayt Mikro-Zyklus-Regeln gegen
   `HistoricalStore`), strikte Zeitmaske `Daten ≤ t`.
2. Walk-Forward-Fenster (rollierend IS/OOS) + persistierte Runs
   (`backtest_runs` + JSON-Artefakt) + Vergleich.
3. Kostenmodell = derselbe Execution-Simulator wie PaperBroker (GAP-02).
4. Synthetischen Fallback in `backtestStep.ts` entfernen → fail-closed
   (`DATA_UNAVAILABLE`-Verhalten) mit Regressionstest.

## Akzeptanzkriterien (kurz)

Lookahead-Test (später eintreffender Kurs ändert frühere Entscheidung nicht),
IS/OOS-Determinismus, Kostenmodell-Einbindung, Fallback-Entfernung,
`npm run typecheck && npm run lint && npm test` grün, Docs + Changelog.

## Umsetzung (v1.51.0, Branch `arena/01a0ba84-ai-trading-firm`)

- **D1 Engine:** `src/backtest/paperExecution.ts` (neu) — `executionModel:
  "paper"` nutzt DIESELBE `FillSimulator`-Klasse + `snapshotFromLastPrice` +
  `computeFunding`-Formel wie der PaperBroker (Import-Nachweis per Test,
  kein zweiter Kosten-Code-Pfad); SL/TP-Trigger mit Stop-Vorrang;
  Kennzahlen aus `src/portfolio` (bereits in `metrics.ts`, neu auch im
  Aggregator `walkforward.ts`); Architektur-Test verbietet LLM-Importe in
  `src/backtest/**`. Legacy-`src/backtest/simulator.ts` eingefroren
  (Default `legacy`, Byte-kompatibel — bestehende Tests unverändert grün).
- **D2 Walk-Forward:** `src/backtest/walkforward.ts` (neu) — rollierende
  IS/OOS-Fenster, Flags `WF_IS_WINDOW_DAYS`/`WF_OOS_WINDOW_DAYS`/
  `WF_MAX_SPAN_DAYS` (Bounds + Defaults, `.env.example` + CONFIGURATION.md),
  Report je Fenster (Kennzahlen + Trade-Hash) + Aggregate, statische Regeln
  (Evaluations-Fenster, keine Parameter-Optimierung — dokumentiert).
- **D3 Persistenz + Zugriff:** `backtest_runs` (append-only, Migration
  `drizzle/2026-09-19_backtest_runs.sql`, Mapping `src/backtest/runStore.ts`),
  CLI `scripts/run-backtest.ts` (`npm run backtest`, Artefakte nach
  `data/backtest/`), Read-API `GET /api/firm/backtests` +
  `GET /api/firm/backtests/[id]` (`firm.read`, kein POST-Endpunkt).
- **D4 Fallback entfernt:** `src/cycle/steps/backtestStep.ts` meldet bei
  < 5 Kerzen `verified=false` + `DATA_UNAVAILABLE` + neutrale
  Null-Kennzahlen + Grund `data:insufficient-candles:<n>-of-5-minimum` +
  `CYCLE_STEP_SKIPPED`-Audit + WARN-Log (Schema: `status`-Feld,
  Summary-`unavailable`; Step-Tests sinngemäß umgestellt, Red/Green in
  `tests/backtest.step.nosynthetic.test.ts` dokumentiert).
- **Tests:** `tests/backtest.engine.test.ts` (29: Lookahead-Hash,
  Reihenfolge-Mutation, Fenstergrenzen, Determinismus, Kosten-Delta,
  Simulator-/Funding-Identität, Persistenz + API-Auth, Architektur),
  `tests/backtest.step.nosynthetic.test.ts` (4: 0/1/4/5/60-Kerzen,
  Audit, keine synthetischen Konstanten).
- **Abweichungen vom Audit-Ist-Stand (verifiziert, kein Abbruch):**
  PROMPT-02 (Funding) + PROMPT-07 (Qualität/Aggregat) waren bereits in main;
  eine Task-02-Engine-Basis existierte (D1 = Paper-Pfad + Funding statt
  Neubau); der `<5`-Fallback war eine „konservative Mindestbewertung“
  (RRR/sharpe-1.0/…) statt „20 Trades, 55 %“ (gleicher Fail-closed-Fix);
  `backtestStep` nutzt jetzt `PAPER_HISTORY_DIR` (researchStep-Muster,
  prod-neutral); CLI replayt Regel-Logik gegen `--instrument` (Regel-Symbol
  PAPER-kanonisch vs. Store-ID — beide IDs im Report, kein stiller Tausch).
- **Docs:** neu `docs/BACKTESTING.md` (+ Katalog, README-Tabelle),
  CHANGELOG 1.51.0 (Minor: feat + fix), Status-Header + `docs/README.md` +
  Stub synchron.

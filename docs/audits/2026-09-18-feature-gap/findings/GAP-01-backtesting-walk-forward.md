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

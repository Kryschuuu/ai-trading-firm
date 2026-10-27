# BP-06: Einfacher Regel-Backtest ohne Kosten; keine Buy-&-Hold-Referenz

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–4 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-06`](../prompts/PROMPT-BP-06-backtest-kosten-und-benchmark.md)

## Verifizierte Fundstellen

- `src/app/api/firm/rules/[id]/backtest/route.ts:51` — ruft `backtestRule()`
  (Regel-Schnellpfad; Ergebnis wird in `rule_backtests` gespeichert).
- `src/lib/ruleEngine.ts:674-776` — `backtestRule()`: Entry am Kerzenschluss,
  SL/TP über Folgekerzen; **keine** Gebühren, Slippage, Spread oder Funding.
- `src/backtest/metrics.ts` — reichhaltige Kennzahlen (Sharpe, Sortino, PF, MDD,
  Expectancy, Streaks), aber kein Buy-&-Hold-/Referenzvergleich; Zeile 151
  (`annualizedReturn = totalReturnPct * annualizationFactor/len`) ist eine
  reviewwürdige Sonderformel.
- `src/backtest/engine.ts` — Multi-Asset-Engine mit Slippage-/Fee-/Funding-
  Pfad (Funding nur `"paper"`); Default `executionModel: "legacy"` kennt kein
  Funding.

## Bewertung und Abgrenzung

Der am häufigsten erreichbare Backtest (ein Klick auf einer Regel) ist
kostenfrei und zeigt damit systematisch zu optimistische Renditen und
Profit-Factors. Die Kosten-Defaults der Multi-Asset-Engine existieren bereits
und können ohne neue Semantik übernommen werden. Ein Benchmark („schlägt die
Regel passives Halten?“) fehlt in beiden Pfaden.

## Konkretes Delta

- `backtestRule()` mit nutzbaren Fee-/Slippage-Defaults (aus
  `DEFAULT_BACKTEST_CONFIG`) bzw. Delegation an die Multi-Asset-Engine
  (ein Wahrheitspfad); Legacy-Default wahren (keine stillen Verhaltensänderungen).
- `metrics.ts`: Buy-&-Hold-Referenzlinie (Excess Return, relatives MDD) und
  Korrektur/Rückbau der `annualizedReturn`-Formel mit Golden-Test.

## Akzeptanzkriterien für `FIXED`

- [ ] derselbe Trade mit Fee/Slippage liefert exakte, dokumentierte Kostenwerte.
- [ ] Benchmark-Metrik ist je Symbol berechnet und im Payload dokumentiert.
- [ ] Default-Verhalten bestehender Runs (Legacy-Default) unverändert (Tests).
- [ ] Pflichtgates grün; Golden-/Regressions-Tests für Metriken.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: API-Routen- und Formelprüfung.
# Tracking — Verbesserungen-Fahrplan 2026-09-23

SSoT für den Umsetzungsstatus **dieses** Zyklus. Stand: **CLOSED in v0.2.0**.
`VERIFIED` heißt: der Vorschlag war im Code bereits erfüllt. `WONTFIX` hat
keinen Umsetzungs-Prompt. `FIXED` ist in diesem Release gebaut und getestet.

Befunde: [`../findings/README.md`](../findings/README.md).
Prompts nur für FIXED: [`../prompts/README.md`](../prompts/README.md).

| ID | Vorschlag | Status | Fix | Nachweis |
|----|-----------|--------|-----|----------|
| VBF-O1 | Whitelist, Ceilings, `evaluateRule` | VERIFIED | — | `src/lib/ruleEngine.ts` |
| VBF-O2 | Walk-Forward, Ledger, Funding | VERIFIED | — | `src/backtest/walkforward.ts` |
| VBF-O3 | Exits und Fill-Simulator | VERIFIED | — | `src/lib/exits.ts`, `src/backtest/paperExecution.ts` |
| VBF-O4 | MTF als Gate, nicht drei Strategien | VERIFIED | — | `src/confluence/` |
| VBF-O5-kfold | Purged K-Fold | WONTFIX | — | würde Zeitreihen leaken |
| VBF-O5-ulcer | Ulcer-Index | WONTFIX | — | kein Gate-Konsument |
| VBF-O6 | `regime` als Regelfeld | WONTFIX | — | Regime-Gate bleibt die Schicht |
| VBF-P1-01 | Kosten im Regel-Backtest | FIXED | v0.2.0 | `tests/ruleBacktest.test.ts` |
| VBF-P1-02 | Workshop-Schritt 5, nur DRAFT | FIXED | v0.2.0 | `tests/workshop.test.ts` |
| VBF-P2-01 | Trusted RSI/ATR, MACD im Block | FIXED | v0.2.0 | `tests/trustedIndicators.test.ts` |
| VBF-P2-02 | MACD-Felder `macd` / `macdSignal` / `macdHist` | FIXED | v0.2.0 | `tests/ruleEngine.test.ts` |
| VBF-P2-03 | Wilson-Intervall und 2000-Zeichen-Warnung | FIXED | v0.2.0 | `tests/workshop.test.ts` |
| VBF-P3-01 | Parität `detectExit` vs. `detectExitTrigger` | FIXED | v0.2.0 | `tests/exitParity.test.ts` |
| VBF-P3-02 | Warnung ab 75 % des Positionsdeckels | FIXED | v0.2.0 | `tests/workshop.test.ts` |
| VBF-P3-03 | Rohantwort in den Editor, kein Autosave | FIXED | v0.2.0 | `tests/workshop.test.ts` |
| VBF-W2 | Binomial gegen 50 % | WONTFIX | — | Wilson reicht |
| VBF-W4 | Prompt-Historie | WONTFIX | — | kein Lesepfad |
| VBF-D-yahoo | Stilles Yahoo auf dem Paper-Pfad | WONTFIX | — | 422 statt Fallback |
| VBF-D-polygon | Polygon-Adapter | WONTFIX | — | kein Vertrag |
| VBF-D-fred | FRED als Kerzenquelle | WONTFIX | — | kein OHLCV |
| VBF-D-finnhub | Finnhub | WONTFIX | — | Duplikat |
| VBF-D-av | Alpha Vantage | WONTFIX | — | Ratenlimit |
| VBF-P-arena | Prompt-Generator als Feature | WONTFIX | — | Dateien, kein Laufzeitmodul |
| VBF-A-agents | AGENTS.md-Edits | WONTFIX | — | ändert kein Verhalten |
| VBF-engine-default | Engine-Default auf `paper` | WONTFIX | — | bleibt `"legacy"` |
| VBF-live-exit | `detectExit` ersetzen | WONTFIX | — | nur Paritätstest |

Keine neue API-Route. `backtestRule` bleibt der gebührenfreie Referenzpfad.
Paper-Pfad: Store-Schlüssel ist `VENUE:native` (z. B. `BITUNIX:BTCUSDT`), nicht
das PAPER-kanonische Regel-Symbol. Explizites `instrumentId` oder genau eine
passende Reihe; sonst 422, kein Raten.

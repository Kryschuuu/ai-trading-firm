# VBF-P1-01 — Kostenbewusster Regel-Backtest

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P1-01-cost-aware-rule-backtest.md`](../findings/VBF-P1-01-cost-aware-rule-backtest.md)

## Auftrag (historisch)

Die bestehende Route `POST /api/firm/rules/[id]/backtest` soll Gebühren, Spread, Slippage und Funding über den Fill-Simulator buchen. Default ist `paper`. Kerzen kommen nur aus dem Store. Fehlen sie, ist die Antwort 422. `model=reference` bleibt der alte gebührenfreie Pfad.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/ruleBacktest.test.ts`, Handbuch 15.4, API-Tabelle in Handbuch 4.1.

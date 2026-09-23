# VBF-P2-02 — MACD in der Whitelist

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P2-02-macd-fields.md`](../findings/VBF-P2-02-macd-fields.md)

## Auftrag (historisch)

`macd`, `macdSignal` und `macdHist` werden Regel-Felder mit Ceiling. Der Snapshot füllt sie aus denselben Indikatorfunktionen. Unbekannte Felder bleiben verworfen.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/ruleEngine.test.ts`, `tests/indicators.test.ts`.

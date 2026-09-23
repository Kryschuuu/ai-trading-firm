# VBF-P2-01 — Code überschreibt RSI und ATR

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P2-01-trusted-indicators.md`](../findings/VBF-P2-01-trusted-indicators.md)

## Auftrag (historisch)

RSI(14) und ATR(14) im Trusted-Block kommen aus `src/lib/indicators.ts` und überschreiben Modellzahlen. MACD steht im selben Block. Bei ausgeschalteter Konfluenz bleibt die Herkunft `trusted-indicators@1`.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/trustedIndicators.test.ts`, `tests/confluence.cycle.test.ts`.

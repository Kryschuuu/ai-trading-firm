# VBF-P3-01 — Parität der Exit-Detektoren

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P3-01-exit-parity.md`](../findings/VBF-P3-01-exit-parity.md)

## Auftrag (historisch)

Ein Test vergleicht `detectExit` und `detectExitTrigger` auf Stop, Ziel, Gap und Kollision. Die Funktionen werden nicht zusammengelegt.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/exitParity.test.ts`.

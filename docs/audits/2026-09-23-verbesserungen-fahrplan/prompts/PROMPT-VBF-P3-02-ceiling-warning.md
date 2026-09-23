# VBF-P3-02 — Warnung ab 75 % des Positionsdeckels

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P3-02-ceiling-warning.md`](../findings/VBF-P3-02-ceiling-warning.md)

## Auftrag (historisch)

Liegt `maxPositionPct` über 75 % von `LIMIT_CEILINGS.maxPositionPct`, warnt das Formular. Abgelehnt wird nur, was den Deckel selbst verletzt.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/workshop.test.ts`.

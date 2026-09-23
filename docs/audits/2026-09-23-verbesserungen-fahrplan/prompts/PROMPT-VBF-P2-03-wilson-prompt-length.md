# VBF-P2-03 — Wilson-Intervall und Längenwarnung

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P2-03-wilson-prompt-length.md`](../findings/VBF-P2-03-wilson-prompt-length.md)

## Auftrag (historisch)

Die Trefferquote zeigt das 95-%-Wilson-Intervall aus `src/lib/stats.ts`. Ab 2000 Zeichen warnt der Prompt-Editor; der Server speichert bis 8000 weiter. Die doppelte Wilson-Funktion entfällt.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/workshop.test.ts`, Handbuch 6.3 und 6.4.

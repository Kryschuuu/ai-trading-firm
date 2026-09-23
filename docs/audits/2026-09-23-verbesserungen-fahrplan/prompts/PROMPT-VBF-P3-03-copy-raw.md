# VBF-P3-03 — Rohantwort kopieren, nicht speichern

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P3-03-copy-raw.md`](../findings/VBF-P3-03-copy-raw.md)

## Auftrag (historisch)

Schritt 2 kann die Rohantwort in den Editor von Schritt 3 legen. Es gibt keinen automatischen Save.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/workshop.test.ts`, Handbuch 6.2.

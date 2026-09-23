# VBF-P1-02 — Workshop-Schritt 5, nur Entwurf

> **Status:** umgesetzt in v0.2.0. Nicht erneut bauen.
> Befund: [`../findings/VBF-P1-02-workshop-step-5.md`](../findings/VBF-P1-02-workshop-step-5.md)

## Auftrag (historisch)

Ein fünfter Workshop-Schritt prüft eine Regel gegen den Paper-Store und speichert sie nur als DRAFT. `activate` wird nicht gesendet. Die Aktivierung bleibt der administrative Endpunkt.

## Gesperrt

- `backtestRule` bleibt byte-identisch.
- `runMultiAssetBacktest` defaultet weiter auf `"legacy"`.
- Keine neue API-Route.
- Kein stilles Yahoo auf dem Paper-Pfad des Regel-Backtests.
- Kein Ersatz von `detectExit`.

## Nachweis

`tests/workshop.test.ts`, `src/components/workshop/RuleBacktestPanel.tsx`, MISSIONS.md §4. Die Store-ID ist ein eigenes Feld, nicht das Regel-Symbol.

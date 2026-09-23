# VBF-P2-03 — Wilson-Intervall und Prompt-Länge

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P2-03-wilson-prompt-length.md`](../prompts/PROMPT-VBF-P2-03-wilson-prompt-length.md)

## Befund (vor dem Fix)

Die Trefferquote war eine nackte Prozentzahl. Prompts durften lang werden,
ohne dass die Oberfläche warnte. `wilsonInterval` existierte doppelt.

## Fix

Schritt 4 zeigt das 95-%-Wilson-Intervall aus `src/lib/stats.ts`.
Ab 2000 Zeichen warnt Schritt 3; gespeichert wird bis 8000 weiter.
Die lokale Kopie in `forecastScoring.ts` ist gelöscht.

## Nachweis

`tests/workshop.test.ts`.

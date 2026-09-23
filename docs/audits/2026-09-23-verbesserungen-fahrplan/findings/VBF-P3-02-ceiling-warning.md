# VBF-P3-02 — Warnung nahe am Positionsdeckel

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P3-02-ceiling-warning.md`](../prompts/PROMPT-VBF-P3-02-ceiling-warning.md)

## Befund (vor dem Fix)

Werte unter dem Deckel wurden widerspruchslos angenommen, auch wenn sie
75 % des Fensters schon überschritten.

## Fix

`positionCeilingWarning` warnt ab 0,75 × `LIMIT_CEILINGS.maxPositionPct`.
Ablehnen tut weiter nur der Deckel selbst.

## Nachweis

`tests/workshop.test.ts`.

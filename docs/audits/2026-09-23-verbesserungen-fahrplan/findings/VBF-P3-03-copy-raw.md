# VBF-P3-03 — Rohantwort in den Prompt

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P3-03-copy-raw.md`](../prompts/PROMPT-VBF-P3-03-copy-raw.md)

## Befund (vor dem Fix)

Eine brauchbare Modellantwort musste von Hand in den Editor kopiert werden.
Ein Autosave wäre falsch: die Antwort ist Daten, kein Auftrag.

## Fix

Schritt 2 setzt nur den Editor von Schritt 3. Speichern bleibt der
explizite `PUT`.

## Nachweis

`tests/workshop.test.ts` (Editor-Zustand, kein Save).

# VBF-P3-01 — Exit-Parität

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P3-01-exit-parity.md`](../prompts/PROMPT-VBF-P3-01-exit-parity.md)

## Befund (vor dem Fix)

`detectExit` (Live/Paper-Monitor) und `detectExitTrigger` (Backtest) können
dieselbe Kerze verschieden lesen. Das war ungetestet.

## Fix

Ein Paritätstest über Stop, Ziel, Gap und Kollision. Die Funktionen werden
nicht zusammengelegt. Der Live-Detektor bleibt.

## Nachweis

`tests/exitParity.test.ts`.

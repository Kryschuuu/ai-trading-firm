# VBF-P2-01 — Trusted RSI/ATR, MACD im Block

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P2-01-trusted-indicators.md`](../prompts/PROMPT-VBF-P2-01-trusted-indicators.md)

## Befund (vor dem Fix)

Das Modell durfte RSI und ATR selbst nennen. Der Code hat sie nicht
überschrieben. MACD fehlte im Trusted-Block.

## Fix

`readingFromCandles` rechnet RSI(14), ATR(14) und MACD mit
`src/lib/indicators.ts` und setzt diese Felder vor dem JSON des Modells.
Ist die Konfluenz aus, bleibt der Block `trusted-indicators@1`.

## Nachweis

`tests/trustedIndicators.test.ts`, `tests/confluence.cycle.test.ts`.

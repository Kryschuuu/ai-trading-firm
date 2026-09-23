# VBF-P2-02 — MACD in der Regel-Whitelist

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P2-02-macd-fields.md`](../prompts/PROMPT-VBF-P2-02-macd-fields.md)

## Befund (vor dem Fix)

`macd` war kein `RULE_FIELDS`-Eintrag. Eine Bedingung darauf wurde still
verworfen.

## Fix

`macd`, `macdSignal` und `macdHist` sind Whitelist-Felder mit Ceiling.
`buildSnapshotFromCandles` füllt sie aus denselben Indikatorfunktionen.

## Nachweis

`tests/ruleEngine.test.ts`, `tests/indicators.test.ts`.

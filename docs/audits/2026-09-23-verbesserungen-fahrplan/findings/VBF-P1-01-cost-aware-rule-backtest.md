# VBF-P1-01 — Kostenbewusster Regel-Backtest

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P1-01-cost-aware-rule-backtest.md`](../prompts/PROMPT-VBF-P1-01-cost-aware-rule-backtest.md)

## Befund (vor dem Fix)

`POST /api/firm/rules/[id]/backtest` rief nur `backtestRule`: keine Gebühr,
kein Spread, kein Funding, und bei leerer Historie einen Yahoo-Fallback.

## Fix

Dieselbe Route. Default `model=paper` liest den Historical Store und den
Fill-Simulator. Leerer Store ist 422, ohne Yahoo. `model=reference` bleibt
der gebührenfreie Altpfad. `backtestRule` und der Engine-Default `"legacy"`
sind unverändert.

## Nachweis

`tests/ruleBacktest.test.ts`.

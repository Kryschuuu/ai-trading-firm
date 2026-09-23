# VBF-P1-02 — Workshop-Schritt 5

- **Status:** FIXED in v0.2.0
- **Prompt:** [`../prompts/PROMPT-VBF-P1-02-workshop-step-5.md`](../prompts/PROMPT-VBF-P1-02-workshop-step-5.md)

## Befund (vor dem Fix)

Der Workshop endete bei der Trefferquote. Eine Regel ließ sich dort nicht
gegen den Store prüfen, ohne sie zu aktivieren.

## Fix

Schritt „5 · Regel prüfen“ speichert nur `DRAFT` (`activate` wird nicht
gesendet) und startet den Paper-Backtest der bestehenden Route.

## Nachweis

`tests/workshop.test.ts` (`buildDraftRuleBody`), UI in `src/components/workshop/RuleCheck.tsx`.

# H9 — Ungültige Equity-/Leverage-Werte können Guardrails umgehen

- **Severity:** HIGH
- **Bereich:** Handelslogik
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/lib/riskGuard.ts` (`validateOrder` L219‑243)

## Arena-Prompt (kopierbar)

```
TASK: Make risk-guardrail numeric validation fail-closed (unknown => BLOCK).

PROBLEM: validateOrder() does `const equity = Math.max(ctx.equity, 1);` and later
`if (ctx.leverage > RISK_LIMITS.maxLeverage)`. If ctx.equity or ctx.leverage is NaN, comparisons
with NaN are false, so a guardrail can be silently skipped. Negative equity is clamped to 1
instead of hard-blocking an insolvent state.

DO:
1. Add a helper in riskGuard.ts:
     class RiskValidationError extends Error { code = "RISK_VALIDATION"; }
     function requireFinitePositive(value: unknown, field: string): number {
       const n = Number(value);
       if (!Number.isFinite(n) || n <= 0) throw new RiskValidationError(field);
       return n;
     }
2. At the top of validateOrder, replace the loose checks:
     const equity   = requireFinitePositive(ctx.equity, "equity");
     const leverage = requireFinitePositive(ctx.leverage, "leverage");
     const notional = requireFinitePositive(ctx.notional, "notional");
   (keep the existing `if (!Number.isFinite(ctx.notional) || ctx.notional <= 0)` as a fast path
    but route through requireFinitePositive so NaN/<=0 throw.)
3. Remove `Math.max(ctx.equity, 1)`; an insolvent/negative equity must throw, not clamp.
4. Callers (broker.submit, BrokerExecutionEngine.submit) already catch/translate errors to a
   REJECTED fill — ensure RiskValidationError is mapped to a reject reason like "INVALID_EQUITY".

ACCEPTANCE: validateOrder({equity: NaN, leverage: NaN, ...}) throws; equity = -5 throws; only
finite positive values pass. Add unit tests for NaN/negative/Infinity inputs.
```

## Beweis (aktueller Code)

`src/lib/riskGuard.ts` L219‑243:

```ts
const equity = Math.max(ctx.equity, 1);   // negatives/NaN wird auf 1 geklemmt
const positionPct = ctx.notional / equity;
...
if (ctx.leverage > RISK_LIMITS.maxLeverage) { ... }  // NaN > x === false
```

## Fix-Spezifikation

`requireFinitePositive` am Eingang; „unbekannt" bedeutet immer BLOCK, nicht ALLOW (siehe Audit H9).

## Akzeptanzkriterien / Tests

- [ ] `equity=NaN` / `leverage=NaN` → `RiskValidationError` (Order REJECTED).
- [ ] `equity<=0` (insolvent) → hart blockiert, nicht auf 1 geklemmt.
- [ ] `notional` bleibt finite-positive-geprüft.

## Changelog-Blurb

`H9 (HIGH): Guardrails nicht fail-closed gegen ungültige Zahlen — requireFinitePositive am Eingang;
NaN/negativ => BLOCK statt stiller Clamp.`

## Versions-Hinweis

PATCH (`1.36.3`) — Verhaltens-Härtung, keine API-Änderung.

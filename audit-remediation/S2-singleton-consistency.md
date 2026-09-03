# S2 — Mehrere parallele Singleton-/State-Mechanismen erschweren sichere Konsistenz

- **Severity:** MEDIUM
- **Bereich:** Sonstiges
- **Status (validiert):** ✅ **Valide (architektonisch).**
- **Datei(en):** diverse `globalThis`-Singletons: `src/lib/engine.ts` (`__firmHydrated`, `PIPELINE_G.__pipelineBusy`),
  `src/brokers/control-plane/service.ts` (`__controlPlaneStates`, `__controlPlaneServicePromise`),
  `src/lib/riskGuard.ts` (`killSwitch`, `baseLimits`/`currentLimits`), `src/brokers/factory.ts`

## Arena-Prompt (kopierbar)

```
TASK: Consolidate process-wide singletons behind explicit lifecycle owners.

PROBLEM: Multiple independent globalThis singletons and module-level mutable vars (broker hydration
flag, pipeline busy flag, control-plane state map + service promise, in-memory kill switch, runtime
risk limits) make it hard to reason about consistency across restarts/processes. Two of them
(__firmHydrated and __controlPlaneStates) are already known to drift (see H2, C4).

DO (incremental, non-breaking):
1. Create src/lib/stateRegistry.ts exposing typed accessors + a single RESET for tests:
     export const state = {
       firmHydrated: flag(), pipelineBusy: mutex(), controlPlane: map(), ...
     };
   Move the existing globals into it (keep names/behaviour to avoid churn).
2. Document the lifecycle: which state is authoritative in DB (positions, kill-switches, control state,
   proposals) vs which is pure in-memory cache (pipeline busy, current risk limits). Add a header
   comment block enumerating each.
3. Ensure all cross-cutting mutable state is reachable from ONE place so a "reset for tests" cannot
   miss a singleton (currently resetControlPlaneForTests + resetRateLimiterForTests + G.__firmHydrated
   are scattered).
4. Add a single `__resetAllSingletonsForTests()` used by the test harness.

ACCEPTANCE: All process-wide mutable state is registered in stateRegistry; tests reset via one call;
a doc comment lists each singleton's source-of-truth (DB vs memory). No behaviour change in prod.
```

## Beweis (aktueller Code)

Streuung: `src/lib/engine.ts` `const G = globalThis as ... { __firmHydrated? }` und
`const PIPELINE_G = globalThis as ... { __pipelineBusy? }`; `service.ts` `G.__controlPlaneStates`,
`G.__controlPlaneServicePromise`; `riskGuard.ts` `let killSwitchArmed`, `baseLimits`, `currentLimits`.

## Fix-Spezifikation

Singleton-/State-Mechanismen bündeln + Lifecycle dokumentieren; DB als Source-of-Truth für
persistente Zustände (siehe Audit S2; verwandt mit H2/C4).

## Akzeptanzkriterien / Tests

- [ ] Alle prozess-weiten Mutables liegen in `stateRegistry`.
- [ ] Tests resetten über eine einzige Funktion.
- [ ] Doku benennt pro Singleton die Wahrheitsquelle (DB vs. RAM).

## Changelog-Blurb

`S2 (MEDIUM): Parallele Singletons erschweren Konsistenz — zentrale stateRegistry + dokumentierter
Lifecycle; DB als Source-of-Truth (verwandt mit H2/C4).`

## Versions-Hinweis

PATCH (`1.36.3`) — Refactor/Struktur, verhaltensneutral.

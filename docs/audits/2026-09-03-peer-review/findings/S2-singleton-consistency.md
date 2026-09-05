# S2 — Mehrere parallele Singleton-/State-Mechanismen erschweren sichere Konsistenz

- **Severity:** MEDIUM
- **Bereich:** Sonstiges
- **Status (validiert):** ✅ **Gefixt v.1.36.22** — siehe `CHANGELOG.md`, `docs/AUDIT_REMEDIATION_2026-09.md` und
  `tests/stateRegistry.test.ts` (registrierte Slots, EIN Reset über alle Besitzer, lazy/idempotente Accessoren,
  Lifecycle-Doku DB vs. RAM).
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

- [x] Alle prozess-weiten Mutables liegen in `stateRegistry`.
- [x] Tests resetten über eine einzige Funktion.
- [x] Doku benennt pro Singleton die Wahrheitsquelle (DB vs. RAM).

## Umsetzung (v1.36.22)

Neu `src/lib/stateRegistry.ts` (dependency-frei, nur `import type`): EIN
`globalThis`-Namensraum `__AITF_STATE_REGISTRY__` mit Accessoren `flag`/`map`/`ref`
(lazy, `setDefault`) für alle 14 Cross-Cutting-Singletons; Header-Kommentar
dokumentiert je Singleton die Wahrheitsquelle (DB: `positions`,
`kill_switches`, `risk_config`, `venue_control_state`, `proposals` … | RAM:
Pipeline-Mutex, Limits-Projektion, Adapter-Cache, Rate-Limiter …). Umgestellt:
`src/lib/engine.ts` (`state.firmHydrated`/`state.pipelineBusy`),
`src/brokers/control-plane/service.ts` (Cache/Hydration/Warmup/Service/Persist-
Warnung), `src/lib/riskGuard.ts` (Kill-Switch, Basis-/Current-Limits, Adaptiv-
Zustand; Defaults via `setDefault`), `src/brokers/factory.ts` (Adapter-/Ledger-
Cache), `src/lib/apiAuth.ts` (Rate-Limiter-Bucket). Test-Harness resettet über
`__resetAllSingletonsForTests()`; `resetControlPlaneForTests` lebt als
Repo-/DI-Installations-Hook (Memory-Repo) weiter. Verhaltensneutral —
`resetRuntimeLimits` resettet bewusst nur Basis-Limits (Adaptivfaktor überlebt,
dokumentiert und getestet). Tests: `tests/stateRegistry.test.ts` (neu), Harness-
Umbau in `hardening`/`h7`/`adaptiveRisk`(+Integration)/`h10`/`authMode`/`clientIp`.

## Changelog-Blurb

`S2 (MEDIUM): Parallele Singletons erschweren Konsistenz — zentrale stateRegistry + dokumentierter
Lifecycle; DB als Source-of-Truth (verwandt mit H2/C4).`

## Versions-Hinweis

PATCH (`1.36.22`) — Refactor/Struktur, verhaltensneutral.

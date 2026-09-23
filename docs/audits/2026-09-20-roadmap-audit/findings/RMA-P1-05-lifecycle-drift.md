# RMA-P1-05: Backtest↔Paper↔Live-Drift und Strategy-Lifecycle

- **Antwort:** Ja (seit v1.73.0)
- **Tracking-Status:** `FIXED` (v1.73.0, [#171](https://github.com/Kryschuuu/ai-trading-firm/pull/171), Commit `a88b5c5`)
- **Severity:** `CRITICAL`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 8–12 PT)
- **Umsetzungs-Prompt:** [`PROMPT-P1-05`](../prompts/PROMPT-P1-05-lifecycle-drift.md)

## Verifizierte Fundstellen

- `src/lib/ruleService.ts` — immutable Regelversionen mit Aktivierung, Pause, Archivierung und Rollback.
- `src/db/schema.ts::tradeRules` — Regelstatus, Version und Vorgängerreferenz.
- `src/brokers/control-plane/states.ts` — Venue-Zustände; betrifft Brokerfreigabe, nicht Strategieevidenz.
- Repository-Suche nach `strategy_lifecycle`, `BACKTEST_PASSED`, Reality-Gate und automatischer Degradation ergab keinen produktiven Pfad.

## Bewertung und Abgrenzung

Manuelle Regel- und Brokerzustände verhindern unkontrollierte Mutation. Sie messen aber nicht, ob die Strategie ihre in Backtest und Paper erwartete Qualität im Live-Betrieb hält.

## Konkretes Delta

- eigene persistente Lifecycle-State-Machine mit erlaubten Übergängen
- Promotion-Gates aus reproduzierbaren Backtest- und Paper-Evidenzen
- kanonische Backtest↔Paper↔Live-Driftmetriken mit Mindeststichprobe
- automatische Degradation/Halt bei Performance-, Risiko- oder Execution-Drift
- idempotente, auditierte Operator-Overrides und Recovery-Regeln

## Akzeptanzkriterien für `FIXED`

- [x] kein direkter Übergang von DRAFT nach LIVE
- [x] jede Transition referenziert unveränderliche Evidenz und Policy-Version
- [x] Drift-Gates fail-closed bei fehlenden/stalen Daten
- [x] Degradation ist idempotent, auditiert und reduziert Risiko statt es zu erhöhen

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Umsetzung: v1.73.0 (`src/strategyLifecycle/`, `drizzle/2026-09-23_strategy_lifecycle.sql`,
  `docs/STRATEGY_LIFECYCLE.md`, API `/api/firm/lifecycle`).
- Evidenz: PR [#171](https://github.com/Kryschuuu/ai-trading-firm/pull/171), Commit `a88b5c5`; Tests 49/49 (`tests/strategyLifecycle.test.ts` 43 +
  `tests/strategyLifecycle.db.test.ts` 6); typecheck/lint/docs:validate grün;
  `npm test` übersprungen (explizite Nutzeranweisung).
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

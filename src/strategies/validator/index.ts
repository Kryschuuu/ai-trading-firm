/**
 * Validator — deterministische Strategie-Validierung (Phase 6, STX-17) — Barrel.
 *
 * Vier Module, eine Richtung (keine Zyklen, keine IO in Teil 1–2):
 *
 * ```
 *   assumptions.ts ──▶ overfit.ts ──▶ report.ts ──▶ persist.ts
 *          ▲               ▲             ▲              │
 *          └───────────────┴── stress.ts ┘              │
 *                                          (nur hier IO: recordEvidence)
 * ```
 *
 * | Modul | Aufgabe | IO |
 * |---|---|---|
 * | `assumptions.ts` | Annahmen-Audit (06-01): hält der Lauf die Bedingungen ein? `UNKNOWN` statt Scheingenauigkeit. | nein |
 * | `overfit.ts` | Plateau, IS/OOS-Lücke, Multiple Testing, Holdout-Integrität (06-02). | nein |
 * | `stress.ts` | Cost- & Slippage-Stress in-engine + post-hoc (06-03). | nur über injizierte Runner/`runWalkForward` |
 * | `report.ts` | Achtstufige Gate-Kette, Regime-Aggregation, `StrategyValidationReport`, Hash. | nein |
 * | `persist.ts` | Evidenz schreiben — **ausschließlich** über `recordEvidence()`. | DB (Lifecycle-Pfad) |
 *
 * **Der Validator promoviert nie.** Er liefert Evidenz (`result` ⊆
 * `PASS|FAIL|INCONCLUSIVE`); `requestTransition` existiert in keinem Modul
 * dieser Domäne. Wer promovert, ist der Lifecycle.
 *
 * Einstieg für Anwender: `buildValidationReport()` (rein) →
 * `writeValidationEvidence()` (idempotent) — oder die CLI
 * `npm run validate:strategy` (`scripts/run-validate-strategy.ts`).
 */
export * from "./assumptions";
export * from "./overfit";
export * from "./stress";
export * from "./report";
export * from "./persist";

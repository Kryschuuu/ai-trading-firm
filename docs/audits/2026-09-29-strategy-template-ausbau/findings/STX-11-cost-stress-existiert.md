# STX-11 — Cost-/Slippage-Stress existiert bereits (Monte-Carlo + Scanner-Faktor)

- **ID:** STX-11
- **Severity:** MEDIUM
- **Bereich:** Backtest / Validierung
- **Quelle:** Ausbaudokument §3.5
- **Status:** FIXED — STX-06-03 (2026-10-02, `v0.10.2`) — angedockt in `src/strategies/validator/stress.ts` (`COST_STRESS_SCENARIOS`, `runInEngineStress`, `summarizeStressSweep`, `runPostHocStress`, `buildStressReport`); Tests in `tests/strategyValidation.stress.test.ts` (22 Tests), Doku in [`docs/STRATEGY_VALIDATION.md`](../../../STRATEGY_VALIDATION.md) Teil 3 + [`STRATEGY_STACK.md`](../../../architecture/STRATEGY_STACK.md) §1.9
- **Datei(en):** `src/backtest/montecarlo.ts`, `src/scanner/factors/executionCost.ts`, `src/strategies/validator/stress.ts`

## Beschreibung

§3.5 führt `Cost Stress ×1/×2/×3` als neu zu bauende Validierung auf. Die Multiplikatoren
existieren; **anders** ist nur der Ort.

## Beweis

```ts
// src/backtest/montecarlo.ts:171
export interface MonteCarloStressConfig { feeMultiplier: number; slippageMultiplier: number; }
// :93  MC_STRESS_MULTIPLIER_BOUNDS = { min: 1, max: 100 }
// :191 stress?: MonteCarloStressConfig | null;   // null = Basisszenario
```

Zusätzlich: `BacktestEngineConfig.feeModel { makerFee, takerFee }`,
`SlippageModel = "fixed" | "spread_relative" | "none"`, `fixedSlippageBps`,
`spreadSlippageFactor` — und der Scanner-Faktor `executionCost`.

## Der tatsächliche Unterschied

Monte-Carlo-Stress wirkt **post-hoc auf abgeschlossene Trades** (Resampling mit
skalierten Kosten). Das ist *Robustheit gegen Ergebnisrauschen*, **nicht** *P&L unter
realistischen Kosten*. Das Dokument will letzteres: „eine Strategie darf nicht gut aussehen,
weil das Modell zu freundlich ist."

## Remediation

Zwei klar getrennte Schichten, beide vorhanden bzw. dünn:

1. **In-Engine-Stress** (der eigentliche Baustein-Lückenschluss): Walk-Forward-Läufe mit
   `feeModel` × {1,2,3} und `fixedSlippageBps` × {5,10,20}. Das ist **Konfiguration**,
   kein neuer Code — `runWalkForward` nimmt bereits ein `BacktestEngineConfig`.
2. **Post-hoc-MC-Stress**: vorhanden, wiederverwenden.

Kein dritter Stress-Mechanismus.

## Akzeptanzkriterien

- [ ] Kein drittes Kostenmodell
- [ ] Stress-Szenarien sind versioniert + im Report referenziert
- [ ] Baseline-Szenario bleibt bit-identisch

## Versions-Hinweis

Minor.

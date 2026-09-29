# STX-06-03 — Cost- & Slippage-Stress-Runner

- **Phase:** 6 · **Paket:** 06-01 · **Finding:** STX-11
- **Risiko:** mittel (Laufzeitkosten)

## Zweck

Das Ausbaudokument §3.5 will verhindern, dass eine Strategie nur deshalb gut aussieht,
weil das Kostenmodell zu freundlich ist. Der Mechanismus existiert **an zwei Stellen
schon** — dieser Prompt verbindet sie und macht das Ergebnis zum Report.

## Kontext — die Unterscheidung, die das Dokument übersieht

| Ort | Was es misst | Wo |
|---|---|---|
| **In-Engine** | P&L unter realen Kosten | `BacktestEngineConfig.feeModel`, `SlippageModel`, `fixedSlippageBps`, `spreadSlippageFactor` |
| **Post-hoc (MC)** | Ergebnisrauschen unter skalierten Kosten | `MonteCarloStressConfig { feeMultiplier, slippageMultiplier }` |

Das sind **verschiedene Fragen**. Die erste ist wichtiger („ist die Edge nach Kosten
da?"), die zweite ist die Stabilitätsfrage. Beide laufen, beide werden berichtet, sie
werden **nicht** vermischt.

## Auftrag

Lege `src/strategies/validator/stress.ts` an.

1. **`COST_STRESS_SCENARIOS`** (exportiert, versioniert):
   ```ts
   export const COST_STRESS_SCENARIOS = [
     { id: "base",   feeMultiplier: 1, slippageBps: 5,  label: "Basis" },
     { id: "double", feeMultiplier: 2, slippageBps: 10, label: "2× Kosten" },
     { id: "triple", feeMultiplier: 3, slippageBps: 20, label: "3× Kosten" },
   ] as const;
   ```
   *Herkunft der Bps-Werte:* die Szenarien sind **Annahmen**, keine gemessenen Werte.
   Stehe das im Doc-Kommentar, und verweise auf 06-01 (`COST_NONZERO`), wo die
   tatsächlich verwendeten Kosten des Basislaufs geprüft werden.

2. **`runInEngineStress(input): Promise<StressSweepResult>`**
   - Pro Szenario **ein** Walk-Forward-Lauf mit angepasstem
     `BacktestEngineConfig` (`feeModel` skaliert, `slippageModel: "fixed"` mit `fixedSlippageBps`)
   - **Base muss byte-identisch** zum Referenzlauf sein — Test dafür
   - `executionModel` bleibt der des Referenzlaufs (`"legacy" | "paper" | "event_replay"`)
   - Bei `"none"`-Slippage im Referenzlauf ⇒ `{ok:false, errors:[...]}`, **kein** stilles
     Hochrechnen

3. **`summarizeStressSweep(results): StressSummary`**
   ```ts
   {
     scenarios: readonly { id, sharpe, netPnl, maxDrawdownPct, trades }[];
     /** Ratio OOS-Sharpe(base) / OOS-Sharpe(3×). */
     degradationRatio: number | null;
     /** Szenario, ab dem die Strategie ihr Geld verdient: 3–10 (Gebührenrunde). */
     breakevenMultiplier: number | null;
     verdict: "COST_ROBUST" | "COST_SENSITIVE" | "COST_DEPENDENT";
   }
   ```
   `breakevenMultiplier` via **Interpolation** zwischen Szenarien; `null`, wenn
   `triple` noch positiv ⇒ „hält mindestens 3×".

4. **`runPostHocStress(...)`** — dünn: reicht das Trade-Log an
   `runMonteCarloSimulation` mit `stress: { feeMultiplier, slippageMultiplier }` durch.
   **Keine eigene MC-Implementierung.** Berichte das Ergebnis getrennt.

5. **Verdikt-Grenzen** (konfigurierbar, Defaults begründet):
   - `COST_ROBUST`: `degradationRatio >= 0.6` **und** `triple` weiterhin profitabel
   - `COST_SENSITIVE`: `degradationRatio ∈ [0.3, 0.6)`
   - `COST_DEPENDENT`: darunter

## Akzeptanzkriterien

- [ ] **Kein** drittes Kostenmodell — nur bestehende Konfigurationsfelder
- [ ] `base` ist byte-identisch zum Referenzlauf (Test)
- [ ] `slippageModel: "none"` ⇒ `{ok:false}`, kein Hochrechnen
- [ ] In-Engine- und Post-Hoc-Ergebnis stehen **getrennt** im Report
- [ ] `breakevenMultiplier: null` ⇒ „mindestens 3×", dokumentiert
- [ ] `tests/strategyValidation.stress.test.ts` grün (mit injiziertem Runner-Stub)
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Laufzeitkosten (wichtig)

Ein Lauf über Szenarien × Walk-Forward-Fenster × Kandidaten multipliziert die
Backtest-Kosten. Deshalb:
- **max. 3 Szenarien × 3 Fenster × 5 Kandidaten** als Default-Bound
- `maxRuns` als **hartes** Argument; Überschreitung ⇒ Abbruch mit Meldung
- CLI-Flag `--max-runs`, Default 45
- **Laufzeitbudget im Pilot dokumentieren** (Zeit pro Lauf × Runs) — nicht
  ausgereizen

## Gesperrt

- **Keine Änderung** an `montecarlo.ts`, `BacktestEngineConfig`, `FillSimulator`.
- **Kein** neues Kostenmodell.
- **Keine** Änderung des Basislaufs.
- Keine Latenz-/Depth-Stress-Erweiterung (`event_replay` beherrscht das bereits;
  **benutzen**, nicht neu bauen).

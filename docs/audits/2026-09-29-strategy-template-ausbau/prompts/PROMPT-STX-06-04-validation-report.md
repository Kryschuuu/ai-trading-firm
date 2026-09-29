# STX-06-04 — `StrategyValidationReport` + Evidence-Writer + CLI

- **Phase:** 6 · **Paket:** 06-02, 06-03, 04-02 · **Finding:** STX-17 (bestätigend)
- **Risiko:** mittel · **Abschluss der deterministischen Validierung**

## Zweck

Das Ergebnis objektiv, **hashbar** und **in das bestehende Lifecycle-Evidenzmodell
passend** zusammenführen. Das ist der Prompt, in dem sich die gesamte Determinismus-
Arbeit auszahlt — und der einzige, der ein Ergebnis **aufschreibt**.

## Kontext — die Kompatibilität ist bereits hergestellt

`strategy_lifecycle_evidence` hat exakt die Felder, die gebraucht werden:

| Spalte | Verwendung |
|---|---|
| `kind` | `"BACKTEST_RUN"` (erlaubt) |
| **`result`** | **`CHECK (result IN ('PASS','FAIL','INCONCLUSIVE'))`** |
| `backtest_run_id` | FK auf `backtest_runs` |
| `metrics jsonb` | Kennzahlen |
| `detail jsonb` | Robustheit, Overfit, Stress, Regime, Annahmen |
| `content_hash` | `CHECK (~ '^sle1:[0-9a-f]{64}$')` — **UNIQUE** |
| `idempotency_key` | `CHECK (~ '^slei1:[0-9a-f]{64}$')` — **UNIQUE** |
| `policy_version`, `code_version`, `data_version` | Provenienz |
| `sample_size`, `window_start`, `window_end` | Fenster |
| **CHECK** | `available_at >= event_time AND computed_at >= available_at` |

Das Ausbaudokument schlägt `result: "PASS" | "FAIL" | "INCONCLUSIVE"` vor — das ist
**wortgleich** mit dem Constraint. **Kein Schema-Umbau.**

## Auftrag

### 1. `src/strategies/validator/report.ts` (rein)

```ts
export type ValidationResult = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface StrategyValidationReport {
  result: ValidationResult;
  strategyKey: string;
  strategyVersion: number;
  strategyVersionId: string;
  templateId: string;
  templateVersion: number;
  class: StrategyClassKey;

  metrics: {
    sharpe: number | null; sortino: number | null; maxDrawdownPct: number | null;
    winRate: number | null; profitFactor: number | null; expectancy: number | null;
    tradeCount: number; netPnl: number | null;
  };
  robustness: {  parameterSensitivity: number | null; costStress: number | null;
                slippageStress: number | null; regimeStability: number | null; };
  overfitting: { trainOosGap: number | null; parameterFragility: number | null;
                 multipleTestingWarning: boolean; lookaheadWarning: boolean;
                 holdoutIntegrity: "CLEAN" | "CONTAMINATED" | "UNKNOWN"; };
  assumptions: readonly { id: string; status: string; evidence: string }[];
  regimes: readonly { regime: MarketRegimeLabel; trades: number; sharpe: number | null }[];
  /** Freitext nur für menschliche Leser; nie maschinell ausgewertet. */
  notes: readonly string[];
  evidenceHash: string;   // = content_hash
  policyVersion: string; codeVersion: string; dataVersion: string | null;
  eventTime: number; availableAt: number; computedAt: number;
}
```

**`regimes`** nutzt `evaluateRegimeOos` und **das bestehende Vokabular** (ADR-E2).
`UNKNOWN` wird ausgeschlossen, nie als „Regime ohne Edge" gezählt.

### 2. **Entscheidungslogik — deterministisch, in dieser Reihenfolge**

```
1. Annahmen-Audit (06-01): critical VIOLATED/UNKNOWN  → INCONCLUSIVE
2. Holdout-Integrität CONTAMINATED                    → INCONCLUSIVE
3. Datenlage unzureichend (trades < 30, keine OOS)   → INCONCLUSIVE
4. OOS-Metriken unter Policy-Gates                    → FAIL
5. Train/OOS-Lücke > Grenze  ODER Plateau < Grenze     → FAIL
6. Cost-Stress COST_DEPENDENT                         → FAIL
7. Multiple-Testing BLOCKING (06-02)                  → FAIL
8. sonst                                              → PASS
```

**Regeln:**
- `INCONCLUSIVE` schlägt immer `FAIL` — ein unklarer Lauf ist **kein** Beweis gegen
  die Strategie, aber **auch kein** Beleg dafür.
- **Keine** Gewichtung, **kein** Score, **kein** „knapp bestanden". Entweder alle Gates
  oder nicht.
- Schlägt ein Gate hart fehl, werden die übrigen **nicht** ausgewertet (Reihenfolge
  spart Rechenzeit und verhindert, dass ein sauberes Sharpe einen Annahmen-Bruch
  überstimmt).
- Grenzen kommen aus `PROMOTION_POLICY_BOUNDS` (`strategyLifecycle/policies.ts`) —
  **nicht** neu definieren. Falls etwas fehlt: Policy erweitern, nicht duplizieren.

### 3. `src/strategies/validator/persist.ts`

- `writeValidationEvidence(report): Promise<EvidenceRow>` — ruft
  **`recordEvidence` aus `@/strategyLifecycle`** (nicht direkt schreiben)
- `evidenceHash` = `evidenceContentHash(...)`, `idempotencyKey` =
  `evidenceIdempotencyKey(...)` aus `strategyLifecycle/evidence.ts` —
  **keine eigene Hashfunktion**
- `eventTime`/`availableAt`/`computedAt` so setzen, dass der CHECK gilt; **`computedAt`
  ist nie ein Zulässigkeitskriterium**
- **Kein** `requestTransition` in diesem Modul — die Promotion entscheidet der
  Lifecycle, nicht der Validator. Der Validator liefert Evidenz; mehr nicht.

### 4. `scripts/run-validate-strategy.ts` + `npm run validate:strategy`

Flags: `--template`, `--params=<json>`, `--timeframe`, `--from/--to`,
`--strategy-version-id` (bestehende Version prüfen) oder `--create` (neue anlegen),
`--max-runs`, `--out=<pfad>`, `--no-write` (nur Report, keine Evidenz).

### 5. `src/strategies/validator/index.ts` — Barrel-Export mit Modul-Doku.

## Akzeptanzkriterien

- [ ] `result` ⊆ `('PASS','FAIL','INCONCLUSIVE')` — typseitig **und** laufzeitseitig
- [ ] **Kein** Pfad schreibt `PASS` ohne bestandene Gate-Kette
- [ ] **Kein** Pfad schreibt Evidenz direkt (immer über `recordEvidence`)
- [ ] `content_hash`/`idempotency_key` erzeugt mit `strategyLifecycle/evidence.ts`
- [ ] Doppelter Lauf ⇒ **eine** Evidenzzeile (UNIQUE greift)
- [ ] `INCONCLUSIVE` schlägt `FAIL` (Test)
- [ ] Keine `requestTransition`-Aufrufe im Validator
- [ ] `tests/strategyValidation.report.test.ts`: ≥ 8 Gate-Szenarien (1× pro Regel)
- [ ] `tests/strategyValidation.persist.test.ts` (DB, Muster `tests/*Strategy*.db.test.ts`)
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] `docs/STRATEGY_VALIDATION.md` (neu): die 8-stufige Kette + Grenzen

## Gesperrt

- **Keine Änderung** an `src/strategyLifecycle/**` (außer: Policy-Bounds erweitern,
  falls ein Gate fehlt — mit eigener Begründung im Commit).
- **Kein** LLM (06-05).
- **Kein** automatisches Promovieren.
- Keine Gewichtung/Scoring-Logik.

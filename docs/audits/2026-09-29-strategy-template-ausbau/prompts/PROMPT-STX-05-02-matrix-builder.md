# STX-05-02 — Matrix-Builder: Strategie × Instrument × Timeframe

- **Phase:** 5 · **Paket:** 05-01, 01-01 · **Finding:** STX-07
- **Risiko:** mittel

## Zweck

Aus dem Scanner-Ergebnis und dem Template-Katalog die **Candidate Matrix** erzeugen —
die Zelle, die die Analyse als „Strategie × Markt" beschreibt. Deterministisch,
begrenzt, ohne IO in der Kernfunktion.

## Kontext

Vorhanden und **wiederverwendbar** (nicht neu bauen):

- `src/scanner/pipeline.ts` — `ScanPipeline`, `MAX_SCAN_INSTRUMENTS = 250_000`
- `src/scanner/funnel.ts` — `buildFunnel`, `selectDiversified`
- `src/scanner/readiness.ts` + `warmup.ts` — `assessDataReadiness`, `requiredWarmupCandles`
- `src/scanner/ranker.ts` — `scoreFromFactors`, `rankByScore`
- `src/scanner/filters.ts` — `checkEligibility`, `FilterRejection`
- `src/universe/types.ts` — `MarketInstrument`, `AssetClass`
- `src/crossSectional/types.ts` — `CrossSectionalRankContext` (optionaler Faktor)

**Wichtig:** `crossSectionalMomentum` ist ein **optionaler** Scanner-Faktor und
**kein** Scanner-Faktor-Default. Fehlt der Rang ⇒ `unavailable` (Neutralwert **0.5**,
nie 0-Momentum) — bestehende Konvention, nicht neu erfinden.

## Auftrag

Lege `src/screening/matrix.ts` an.

1. **`buildCandidateMatrix(input: MatrixInput): MatrixResult`**

   ```ts
   interface MatrixInput {
     instruments: readonly MarketInstrument[];
     templates: readonly StrategyTemplate[];
     scan?: ScanResult;                    // optional: ohne Scan nur READY/DISCOVERED
     crossSectional?: (id: string) => CrossSectionalRankContext | null;
     dataQuality: (instr: MarketInstrument, tf: SupportedTimeframe) => QualitySample;
     liquidity: (instr: MarketInstrument) => { score: number | null; spreadPct: number | null; bookDepthUsd: number | null };
     freshness: (instr: MarketInstrument, tf: SupportedTimeframe) => number | null;
     correlation: (instr: MarketInstrument) => number | null;   // 0..1
     volatilityOpportunity: (instr: MarketInstrument, tf: SupportedTimeframe) => number | null;
     now: number;                           // injizierte Zeit
     limits: MatrixLimits;                  // harte Bounds, siehe unten
     config?: ScreeningPriorityConfig;
   }
   ```

   **Alle Datenanbindungen sind injizierte Funktionen** — der Builder macht selbst
   **keinen** IO. Muster: `ScanDataProvider` in `scanner/pipeline.ts`.

2. **`MatrixLimits`** (fail-closed, Default + Override):
   ```
   maxInstruments:  500     // MAX_MATRIX_INSTRUMENTS
   maxTemplates:     16
   maxTimeframesPerTemplate: 3
   maxCells:         5_000   // HARTE Obergrenze; darüber ⇒ {ok:false}
   ```
   `maxCells` ist ein **DoS-/Kosten-Guard**, kein Tuning-Knopf. Bei Überschreitung:
   `{ok:false, errors:["matrix too large: N > 5000"]}` — **nicht** still kürzen.

3. **Zeitzustand:** Zelle nur erzeugen, wenn
   `requiredWarmupCandles(tf) ≤ verfügbare Kerzen`. Zu wenig ⇒ `BLOCKED` mit
   `reasons: ["warmup: 29 < 120"]`, **nicht** still überspringen. Das ist die
   eigentliche Mengenbegrenzung in der Praxis (STX-Report, L12).

4. **Timeframe-Filter:** eine Zelle (Template, Instrument, tf) entsteht nur, wenn
   `tf ∈ template.supportedTimeframes`. Das ist der Filter, der 03-03 (kein Intraday)
   und 03-07 (kein `1d`) **überhaupt erst durchsetzbar** macht.

5. **Sortierung:** Ergebnis ist **stabil sortiert**
   (`priority` desc, dann `templateId` asc, dann `instrumentId` asc, dann `timeframe` asc).
   Stabilität ist Pflicht — sie macht 05-03/05-04 idempotent.

6. **`MatrixResult`**: `{ ok, cells, stats: { instruments, templates, timeframes, cells,
   blockedByReason: Record<string, number> }, errors }`

## Akzeptanzkriterien

- [ ] `buildCandidateMatrix` ist pure außer den injizierten Funktionen
- [ ] Zellen-Explosion ⇒ `{ok:false}`, kein stilles Kürzen
- [ ] Sortierung deterministisch bei identischen `priority`-Werten
- [ ] `warmup`-Filter greift; zu wenig ⇒ `BLOCKED` mit Grund
- [ ] `tf ∉ supportedTimeframes` ⇒ **keine** Zelle
- [ ] `tests/screening.matrix.test.ts` grün: 6 Templates × 20 Instrumente × 3 Timeframes
      ⇒ erwartete Zellenzahl, kein `NaN`, keine Duplikate
- [ ] **Skalierungstest:** 500 Instrumente × 6 Templates × 3 Timeframes läuft in < 5 s
      (reine Matrix-Bildung, ohne Backtest)
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Kein** Backtest-Aufruf in diesem Prompt (05-04).
- **Keine** DB, kein Store-Zugriff im Builder.
- **Keine** Änderung an `src/scanner/**` — der Scanner wird **gelesen**, nicht verändert.
- **Keine** Änderung an `MAX_SCAN_INSTRUMENTS`.

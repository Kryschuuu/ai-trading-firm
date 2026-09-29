# STX-05-04 — Screening-CLI + Backtest-Job-Adapter

- **Phase:** 5 · **Paket:** 05-03, **00-01** · **Findings:** STX-07, STX-12
- **Risiko:** mittel (Kosten/Laufzeit) · **Gate zu Phase 6**

## Zweck

Die Matrix wird **zu Jobs**. Dieser Prompt baut den Adapter — aber mit den zwei
Schutzmechanismen, ohne die ein 5.000-Zellen-Lauf gefährlich wird: `--dry-run` als
Default und ein hartes `--max-cells`-Bound.

## Kontext — die Entscheidung aus 00-01

`backtestRule()` ist **O(n²)** (`ruleEngine.ts:787`); `runMultiAssetBacktest()` nutzt
`IndicatorCache` und ist O(n). Je nach Ergebnis von 00-01 gilt:

| Messung | Adapter |
|---|---|
| Multi-Asset ≥ Faktor 10 schneller | **Multi-Asset-Engine** verwenden |
| ähnlich | `backtestRule` verwenden, **mit** dokumentierter Obergrenze |
| Multi-Asset langsamer | **Stopp** — Ergebnis melden, Architekturentscheid neu |

**Triff diese Wahl nicht selbst** — sie steht in
`remediation/BENCH-BASELINE.md`. Wenn 00-01 nicht abgeschlossen ist, **stoppt dieser
Prompt hier.**

## Auftrag

1. **`src/screening/runner.ts`**

   ```ts
   export async function runScreening(input: ScreeningRunInput): Promise<ScreeningRunResult>
   ```

   - `maxCells` **hart** (Default aus 05-02), Abbruch ⇒ `{ok:false}`, kein stilles Kürzen
   - **Bounded Concurrency** für I/O: `pLimit`-Muster, Default 4 (Repo hat bereits
     Concurrency-/Rate-Limit-Muster in `src/marketdata/`)
   - **CPU-Last:** vorerst **sequenziell** im selben Prozess. `worker_threads` kommt
     **erst**, wenn 00-01 gezeigt hat, dass ein Lauf die CPU sättigt — nicht vorher.
     (Parallelescheduling auf O(n²) vervielfacht Speicher, nicht Zeit.)
   - **Wahl des Backtest-Pfads** aus 00-01, als Konstante mit Verweis im Doc-Kommentar
   - **Respektiere** `RULE_BACKTEST_MIN_BARS = 100`, `RULE_BACKTEST_TRADE_CAP = 200`,
     `RULE_BACKTEST_EQUITY_CAP = 120` — ein Lauf darüber ist **nicht vergleichbar**;
     Zelle ⇒ `status: "BLOCKED"` mit Grund `"caps exceeded"`, **nicht** gekapptes Ergebnis
   - Jede Zelle: `createOrGetRun` ⇒ `upsertCells` ⇒ optional Backtest ⇒ `metrics` + `backtest_run_id`
   - **Fortschritt** in `strategy_screening_runs` (`cells_done`), damit ein Abbruch
     den Stand nicht verliert
   - Telemetrie: `screening_cells_total{result}`, **bounded** Labels (keine
     Instrument-IDs in Metrik-Labels — Repo-Regel, siehe `confluence/adapters.ts`)

2. **`scripts/run-screening.ts`** (Muster `scripts/run-scan.ts`)

   | Flag | Default | Bedeutung |
   |---|---|---|
   | `--dry-run` | **an** | nur Matrix bauen + ausgeben, **kein** Backtest |
   | `--templates=a,b` | alle | Teilmenge |
   | `--timeframes=1h,4h` | Template-Default | Teilmenge |
   | `--max-instruments=N` | 500 | harte Grenze |
   | `--max-cells=N` | 5000 | harte Grenze |
   | `--limit-cells=N` | ∞ | **erste N Zellen** — für Pilotläufe |
   | `--concurrency=N` | 4 | nur I/O |
   | `--as-of=ISO` | jetzt (injiziert) | gemeinsamer Cutoff (PIT) |
   | `--run-id=UUID` | neu | vorhandenen Lauf fortsetzen |

   `npm run screening` in `package.json`. Ausgabe: Tabelle mit `priority`, `template`,
   `instrument`, `timeframe`, `status`, `reasons` + Zusammenfassung nach `status`.

3. **Docs**
   - `docs/architecture/STRATEGY_STACK.md` (00-02) um die Screening-Schicht ergänzen
   - `CONFIGURATION.md` / `.env.example`: **keine** neuen Flags nötig (alles CLI) —
     falls doch, mit sicheren Defaults

## Akzeptanzkriterien

- [ ] `--dry-run` ist der **Default**; echte Läufe brauchen explizit `--execute`
- [ ] `--max-cells` wird **nicht** überschritten, Abbruch mit klarer Meldung
- [ ] `tests/screening.runner.test.ts` mit injiziertem Backtest-Stub (kein echter Lauf)
- [ ] **Budget-Test:** 50 Zellen mit Stub ⇒ Wall-Clock < 30 s, Abbruch bei `maxCells: 10`
- [ ] `tests/marketdata`-artiger Concurrency-Test: keine ungebundenen Parallelzugriffe
- [ ] Telemetrie-Labels **bounded** (kein `instrument_id`)
- [ ] Abbruch mitten im Lauf ⇒ `strategy_screening_runs.status = 'ABORTED'`,
      `cells_done` konsistent, mit `--run-id` fortsetzbar
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] `docs:validate` grün

## Pilotlauf (Pflichtteil dieses Prompts)

Nach dem Merge, **vor** Phase 6, ein **manueller** Pilotlauf als Beleg:

```
npm run screening -- --limit-cells=50 --execute
```

Ergebnis nach `remediation/SCREENING-PILOT.md`: Wall-Clock, Zellen/s, Kosten/Ausreißer,
welche Zellen an `maxCells`/Caps gescheitert sind. **Wenn der Pilot > 1 Kernstunde für
50 Zellen braucht, ist 05-04 zurückzuweisen** und STX-12 vorrangig zu bearbeiten.

## Gesperrt

- **Kein** `worker_threads` ohne Pilot-Beleg.
- **Keine** Änderung an `runMultiAssetBacktest`/`backtestRule` (STX-12, eigener Prompt).
- **Kein** Ergebnis-Overwrite: ein zweiter Lauf ist ein **neuer** Run.
- Keine Instrument-IDs in Metrik-Labels.

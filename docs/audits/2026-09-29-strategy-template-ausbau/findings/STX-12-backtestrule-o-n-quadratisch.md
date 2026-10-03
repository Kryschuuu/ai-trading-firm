# STX-12 — `backtestRule()` ist O(n²); der Matrix-Runner würde daran scheitern

- **ID:** STX-12
- **Severity:** MEDIUM
- **Bereich:** Performance
- **Quelle:** Ausbaudokument §4.9 (nicht erkannt)
- **Status:** FIXED — STX-08-04 in `v0.11.0` (`backtestRule()` nutzt den vorhandenen Indicator-Cache; eingefrorene Golden-Hashes und Bar-für-Bar-Parität grün). PR: [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221).
- **Datei(en):** `src/lib/ruleEngine.ts:729-800`, `src/backtest/indicatorCache.ts`

## Abschluss 2026-10-03 — STX-08-04 (`v0.11.0`)

`backtestRule()` erstellt den bestehenden `IndicatorCache` einmal vor der Bar-Schleife und nutzt `snapshotFromCache()` pro Bar. Der Aufrufpfad über `ruleBacktest.ts` und die API bleibt bestehen; `src/screening/**` ist unverändert und verwendet weiter `runMultiAssetBacktest()`.

**Nachweise:**

- `tests/ruleBacktest.cacheGolden.test.ts`: sechs SHA-256-Goldens (3 Symbole × 2 Timeframes), vor der Codeänderung festgeschrieben und unverändert; vollständige Backtest-Rückgaben und Direkt-Snapshots.
- `tests/ruleEngine.indicatorCacheParity.test.ts`: alle `RULE_FIELDS` bar-für-bar exakt (576 Snapshots), Null-/Ungültigsemantik einschließlich Null-ATR, Tages-VWAP, Spread/Buch-Tiefe, Bollinger und Donchian.
- Fokussierte Backtest-/Engine-/Template-Tests: 144 bestanden. `typecheck`, `lint` und `docs:validate` werden für diesen PR separat ausgeführt. **Die vollständige `npm test`-Suite wurde auf ausdrückliche Nutzeranweisung übersprungen** und wird nicht als gelaufen behauptet.
- Ergänzende synthetische 17 520-Bar-Messung: alter Direktpfad 20 253,605 ms vs. Cache 64,489 ms Median (**314,1×**, gleiche Reihe, tiefengleiche Rückgabe). Die Originalreihe des HistoricalStore-Benchmarks fehlt; die offizielle 25 986,2-ms-Baseline bleibt unverändert und wird nicht als gleichartige Messung ausgegeben. Details: [`BENCH-BASELINE.md` §11](../remediation/BENCH-BASELINE.md#11-folgemessung-stx-08-04--einmaliger-indicator-cache-in-backtestrule).
- Release: `v0.11.0`; PR: [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221).

## Erstabgleich 2026-10-03 (vor STX-08-04)

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `◐` **PARTIAL** — Messung und Umweg belegt, Code-Fix offen
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise des Erstabgleichs (vor STX-08-04; historischer Zustand)**

- **Damals weiter quadratisch:** `src/lib/ruleEngine.ts:894` — `buildSnapshotFromCandles(spec.symbol, candles.slice(0, i + 1), …)`; `grep -n "indicatorCache\|snapshotFromCache\|buildIndicatorCache" src/lib/ruleEngine.ts` → **0 Treffer**
- **Umweg belegt:** `src/screening/backtestAdapter.ts:54` importiert `runMultiAssetBacktest` aus `@/backtest/engine`; `SCREENING_BACKTEST_PATH = "multiAsset"`, Begründung mit Messzahlen im Modulkopf (`backtestAdapter.ts:16-20`, `runner.ts:22-25`)
- **Altpfad lebt weiter:** `src/lib/ruleBacktest.ts:385` ruft `backtestRule()`; darüber liegt `src/app/api/firm/rules/[id]/backtest/route.ts`
- Messung unverändert gültig: [`../remediation/BENCH-BASELINE.md`](../remediation/BENCH-BASELINE.md) — Exponent 1,99 vs. 1,01, Faktor 121,7×
- Folge-Prompt mit Paritätsnachweis: [08-04](../prompts/PROMPT-STX-08-04-backtestrule-indicatorcache.md)

## Ursprüngliche Beschreibung (vor Fix)

§4.9 fordert Parallelisierung via `worker_threads` und bounded async concurrency. Bevor
parallelisiert wird, muss der Einzel-Lauf gemessen werden — und der **Single-Rule-Pfad ist
quadratisch**.

## Ursprünglicher Beweis (vor Fix)

```ts
// src/lib/ruleEngine.ts:787  (in backtestRule)
const snap = buildSnapshotFromCandles(spec.symbol, candles.slice(0, i + 1), …);
```

Pro Bar `i` wird (a) ein Array der Länge `i+1` allokiert/kopiert und (b) darin
`closes = candles.map(c => c.close)`, `ema(closes, 9/21/50)`, `rsi(closes)`,
`atrPct`, `adx`, `bollingerBandWidthPct`, `macd`, `sessionVwap` **über die volle Historie**
neu berechnet. Summe über die Kerzen ⇒ **O(n²)**.

Die Multi-Asset-Engine hat das bereits gelöst:

```
// src/backtest/indicatorCache.ts:1-9
Problem: `buildSnapshotFromCandles` rechnet pro Bar alle Indikatoren aus der gesamten
Historie neu … Bei 17 520 Stundenkerzen (2 Jahre) ist das O(n²) und sprengt den 10-s-Deckel
des Performance-Tests.
Lösung: Indikatoren einmal pro Symbol in O(n) vorrechnen, danach O(1)-Lookup je Bar.
```

`buildIndicatorCache` / `snapshotFromCache` werden in `src/backtest/engine.ts:234,238,520`
verwendet — **nicht** in `backtestRule()`.

## Abgeschlossene Remediation

1. 00-01 lieferte die historische Messung; 05-04 beließ das Screening auf `runMultiAssetBacktest()`.
2. STX-08-04 stellte `backtestRule()` auf `buildIndicatorCache()` + `snapshotFromCache()` um, ohne den Regel-/Handelsablauf zu verändern.
3. Vorab eingefrorene Golden-Hashes, vollständige `RULE_FIELDS`-Parität und Nullsemantik decken den Wechsel ab. Es wurde keine Parallelisierung eingeführt.

## Messung (2026-09-29, Prompt 00-01, `v0.6.0`)

Das Benchmark-Protokoll liegt in
[`../remediation/BENCH-BASELINE.md`](../remediation/BENCH-BASELINE.md); gemessen wurde
auf einer echten `BINANCE:BTCUSDT`-1h-Reihe (17 749 Kerzen, 3 Messpunkte × 3 Läufe ×
3 Pfade, Median nach einem ungemessenen Warmlauf).

| Pfad | n = 1 000 | n = 5 000 | n = 17 520 | Exponent |
| --- | ---: | ---: | ---: | ---: |
| `backtestRule` | 85,8 ms | 1 772,0 ms | 25 986,2 ms | **1,99** |
| `runMultiAssetBacktest` | 11,5 ms | 42,5 ms | 213,5 ms | **1,01** |
| `buildIndicatorCache` + `snapshotFromCache` | 3,6 ms | 12,6 ms | 72,2 ms | **1,04** |

- Faktor `backtestRule`/Engine: **121,7×**; `backtestRule`/Cache: **360,1×** (bei 17 520 Kerzen).
- **7 500 Zellen × 1h-Zelle:** `backtestRule` = **54,14 Kernstunden** seriell,
  `runMultiAssetBacktest` = **0,44 Kernstunden**, Cache-Pfad = 0,15 Kernstunden.
- Entscheidung: Screening läuft über `runMultiAssetBacktest()`; `backtestRule()` wird
  **nicht** in die Matrix eingebunden, solange es O(n²) ist. Damit ist dieser Befund
  ein **Patch-Task mit Paritätstest** — kein Roadmap-Blocker.

## Akzeptanzkriterien

- [x] Benchmark-Artefakt für n ∈ {1 000, 5 000, 17 520} × {rule, multiAsset, cache} (00-01, `v0.6.0`); historische Zahlen unverändert
- [x] Vorab eingefrorene Goldens bleiben unverändert: 3 Symbole × 2 Timeframes, Stops/Targets/Cooldown, komplette Trades/Metriken/Snapshots
- [x] Bar-für-Bar-Parität für alle aktuellen `RULE_FIELDS`, 3 Symbole × 2 Timeframes; Null-/Ungültigsemantik geprüft
- [x] `backtestRule()` baut den bestehenden Cache einmal vor der Schleife auf; kein `candles.slice(0, i + 1)` mehr
- [x] Ergänzender Same-Series-Test bei 17 520 synthetischen Bars: 314,1× schneller und tiefengleiche Ergebnisse; Originaldatenreihe nicht verfügbar, daher kein Ersatz der offiziellen Messung
- [x] `ruleBacktest.ts`, API-Pfad, Multi-Asset-Engine und Template-Tests fokussiert geprüft
- [x] Fokussierte Tests (144), `typecheck`, `lint` und `docs:validate` grün; vollständiges `npm test` auf ausdrückliche Nutzeranweisung übersprungen
- [x] STX-12 geschlossen in `v0.11.0`; PR [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221)

## Versions-Hinweis

Die Messung aus 00-01 bleibt unverändert in `v0.6.0`; die Migration ist ein eigener
Release `v0.11.0` (08-04). Screening bleibt weiter über `runMultiAssetBacktest()`.
Paritätsnachweis, synthetische Folgemessung und Caveat stehen in
[`BENCH-BASELINE.md` §11](../remediation/BENCH-BASELINE.md#11-folgemessung-stx-08-04--einmaliger-indicator-cache-in-backtestrule).

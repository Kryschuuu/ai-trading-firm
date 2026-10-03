# STX-12 — `backtestRule()` ist O(n²); der Matrix-Runner würde daran scheitern

- **ID:** STX-12
- **Severity:** MEDIUM
- **Bereich:** Performance
- **Quelle:** Ausbaudokument §4.9 (nicht erkannt)
- **Status:** PARTIAL — Abgleich 2026-10-03: Messung (00-01) und Screening-Umweg (05-04) vorhanden; `backtestRule()` selbst bleibt O(n²)
- **Datei(en):** `src/lib/ruleEngine.ts:729-800`, `src/backtest/indicatorCache.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `◐` **PARTIAL** — Messung und Umweg belegt, Code-Fix offen
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- **Weiter quadratisch:** `src/lib/ruleEngine.ts:894` — `buildSnapshotFromCandles(spec.symbol, candles.slice(0, i + 1), …)`; `grep -n "indicatorCache\|snapshotFromCache\|buildIndicatorCache" src/lib/ruleEngine.ts` → **0 Treffer**
- **Umweg belegt:** `src/screening/backtestAdapter.ts:54` importiert `runMultiAssetBacktest` aus `@/backtest/engine`; `SCREENING_BACKTEST_PATH = "multiAsset"`, Begründung mit Messzahlen im Modulkopf (`backtestAdapter.ts:16-20`, `runner.ts:22-25`)
- **Altpfad lebt weiter:** `src/lib/ruleBacktest.ts:385` ruft `backtestRule()`; darüber liegt `src/app/api/firm/rules/[id]/backtest/route.ts`
- Messung unverändert gültig: [`../remediation/BENCH-BASELINE.md`](../remediation/BENCH-BASELINE.md) — Exponent 1,99 vs. 1,01, Faktor 121,7×
- Folge-Prompt mit Paritätsnachweis: [08-04](../prompts/PROMPT-STX-08-04-backtestrule-indicatorcache.md)

## Beschreibung

§4.9 fordert Parallelisierung via `worker_threads` und bounded async concurrency. Bevor
parallelisiert wird, muss der Einzel-Lauf gemessen werden — und der **Single-Rule-Pfad ist
quadratisch**.

## Beweis

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

## Remediation

1. **Erst messen** (Prompt 00-01): Laufzeit von `backtestRule` vs.
   `runMultiAssetBacktest` bei 5.000 / 17.520 Kerzen.
2. Danach entscheiden: entweder `backtestRule` auf `IndicatorCache` umstellen
   (byte-identische Parität fordern) oder das Screening ausschließlich über die
   Multi-Asset-Engine fahren.
3. `worker_threads` **erst danach** — Parallelisierung auf O(n²) vervielfacht nur den
   Speicher, nicht die Zeit.

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

- [x] Benchmark-Artefakt mit Zahlen für n ∈ {1 000, 5 000, 17 520} × {rule, multiAsset, cache} (00-01, `v0.6.0`)
- [ ] Falls Umstellung: Paritätstest gegen die alte Implementierung
- [ ] Keine Verhaltensänderung des Backtest-Ergebnisses

## Versions-Hinweis

Patch/Minor — Messung in `v0.6.0`, die Umstellung selbst ist ein Folge-Patch (Prompt 03-09/05-04
nutzen den Cache; die Migration von `backtestRule` bleibt separat).

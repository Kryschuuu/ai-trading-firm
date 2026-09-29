# STX-12 — `backtestRule()` ist O(n²); der Matrix-Runner würde daran scheitern

- **ID:** STX-12
- **Severity:** MEDIUM
- **Bereich:** Performance
- **Quelle:** Ausbaudokument §4.9 (nicht erkannt)
- **Status:** OPEN
- **Datei(en):** `src/lib/ruleEngine.ts:729-800`, `src/backtest/indicatorCache.ts`

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

## Akzeptanzkriterien

- [ ] Benchmark-Artefakt mit Zahlen für n ∈ {5 000, 17 520} × {rule, multiAsset}
- [ ] Falls Umstellung: Paritätstest gegen die alte Implementierung
- [ ] Keine Verhaltensänderung des Backtest-Ergebnisses

## Versions-Hinweis

Patch/Minor.

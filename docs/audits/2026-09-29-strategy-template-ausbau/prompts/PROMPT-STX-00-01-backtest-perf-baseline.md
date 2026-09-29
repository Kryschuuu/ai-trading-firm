# STX-00-01 — Backtest-Perfenz-Baseline messen

- **Phase:** 0 · **Paket:** keine Voraussetzung · **Finding:** STX-12
- **Risiko:** keines (kein Produktivcode)

## Zweck

Bevor irgendein Screening-Runner gebaut wird, muss bekannt sein, **was ein
Backtest-Lauf heute kostet** und ob der O(n²)-Pfad in `backtestRule()` die
7.500-Jobs-Matrix trägt oder nicht. Ohne diese Zahlen ist jede
Worker-Parallelisierungs-Entscheidung Spekulation.

## Kontext

`src/lib/ruleEngine.ts:787` (in `backtestRule`):

```ts
const snap = buildSnapshotFromCandles(spec.symbol, candles.slice(0, i + 1), …);
```

Pro Bar wird die **gesamte** Historie kopiert und `ema/rsi/atrPct/adx/bollinger/macd/
sessionVwap` erneut **über die volle Länge** berechnet ⇒ O(n²).

Die Multi-Asset-Engine hat das bereits gelöst (`src/backtest/indicatorCache.ts`,
`engine.ts:234,238,520`) — `backtestRule()` **nicht**.

## Auftrag

1. Lege `scripts/bench-backtest.ts` an (Muster `scripts/run-backtest.ts`:
   `node --import tsx`, injizierte Daten über den `HistoricalStore`, **kein** Netz).
2. Miss für `n ∈ {1_000, 5_000, 17_520}` Kerzen auf **einer** Timeframe:
   - `backtestRule(spec, candles)` — Single-Rule-Pfad
   - `runMultiAssetBacktest(...)` mit **derselben** Regel — Multi-Asset-Pfad
   - reine `buildIndicatorCache` + `snapshotFromCache`-Schleife
3. Wiederhole je Messung 3×, nimm den **Median**, notiere
   `ms/1000 Kerzen` und den **vermuteten Exponenten** (log-log-Fit über die 3 Punkte).
4. Ergänze eine „1 Zelle Matrix" Rechnung: bei 7.500 Zellen × Median-Laufzeit
   `1h` = wie viele **Kernstunden seriell**?
5. Schreibe das Ergebnis nach `docs/audits/2026-09-29-strategy-template-ausbau/
   remediation/BENCH-BASELINE.md` mit den Rohzahlen.

**Feste Regeln für die Bench-Skript-Regeln:**
- Verwende eine echte, aus dem Store gelesene Serie (keine synthetischen Random-Bars) —
  sonst misst du eine andere Verteilung.
- `STARTING_EQUITY` und `DATABASE_URL` wie in `package.json`-Test-Skripten.
- Kein Schreiben in `data/` außer in einem `data/bench/`-Unterordner, der in
  `.gitignore` steht.

## Akzeptanzkriterien

- [ ] `npm run bench:backtest` (Skript in `package.json`) läuft ohne DB
- [ ] Messprotokoll mit 3 Messpunkten × 2 Pfaden, Median + Rohwerte
- [ ] Fit-Exponent ausgewiesen (erwartet: ≈ 2 für `backtestRule`, ≈ 1 für den Cache-Pfad)
- [ ] `backtestRule.ts` / `ruleEngine.ts` / `engine.ts` **unverändert**
- [ ] Eine klare Aussage: „Screening über `runMultiAssetBacktest`" vs. „`backtestRule`
      muss erst O(n) werden"

## Akzeptanz → Empfehlung

| Messung | Konsequenz für die Roadmap |
|---|---|
| Exponent ≈ 2 beim Single-Rule-Pfad | 05-04 **muss** über `runMultiAssetBacktest` fahren |
| 7.500 Zellen > 1 Kernstunde | Screening zuerst nur Top-N-Kandidaten, `RULE_BACKTEST_TRADE_CAP` beachten |
| Cache-Pfad ist Faktor ≥ 10 schneller | 03-09/05-04 nutzt den Cache; STX-12 wird zu einem Patch-Task |

## Gesperrt

- Keine Optimierung von `backtestRule()` in diesem Prompt (nur messen).
- Keine Änderung an `ruleEngine.ts`, `indicatorCache.ts`, `engine.ts`.
- Keine neuen Runtime-Dependencies.

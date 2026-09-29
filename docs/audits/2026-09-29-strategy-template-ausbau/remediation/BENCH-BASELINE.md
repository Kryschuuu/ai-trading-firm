# BENCH-BASELINE — Backtest-Performance vor dem Screening-Runner (Prompt 00-01)

- **Prompt:** [`00-01`](../prompts/PROMPT-STX-00-01-backtest-perf-baseline.md) · **Finding:** [STX-12](../findings/STX-12-backtestrule-o-n-quadratisch.md)
- **Phase:** 0 (Messung, kein Produktivcode) · **Datum:** 2026-09-29 · **Release:** `v0.6.0`
- **Status:** ABGESCHLOSSEN — Entscheidung getroffen, Gate **G5** erfüllt
- **Gemessen auf:** 2 vCPU (Intel Xeon @ 2.60 GHz), 3,9 GB RAM, Linux x64, Node `v22.22.3`
- **Artefakt (Rohdaten):** `data/bench/bench-binance-btcusdt-1h.json` + `.md`
  (Laufzeitartefakt, `/data/bench` ist gitignoriert; neu erzeugbar mit `npm run bench:backtest`)

## Ergebnis in drei Sätzen

1. **Der Single-Rule-Pfad ist quadratisch:** `backtestRule()` wächst mit Exponent
   **1,99** (≈ 2) und braucht bei 17 520 Stundenkerzen **26,0 s je Zelle**.
   Hochgerechnet auf 7 500 Zellen sind das **54,1 Kernstunden** — mehr als zwei
   Arbeitstage auf **einem** Kern und damit unbrauchbar für die Matrix aus 05-04.
2. **Der Multi-Asset-Pfad trägt die Matrix:** `runMultiAssetBacktest()` wächst mit
   Exponent **1,01** (≈ 1), kostet bei gleicher Kerzenzahl **213,5 ms** und
   **121,7×** weniger als der Single-Rule-Pfad; die volle 7 500-Zellen-Matrix sind
   **0,44 Kernstunden** (≈ 26 min) seriell.
3. **Der Screening-Runner MUSS über `runMultiAssetBacktest()` fahren.**
   `backtestRule()` ist erst wieder einsetzbar, wenn es O(n) wird (Indikator-Cache
   statt Historie-Kopie je Bar) — der Cache-Pfad ist **360,1×** schneller und
   liefert dieselben Signale; STX-12 wird damit zu einem **Patch-Task** (Paritätstest
   Pflicht), nicht zu einem Blocker der Roadmap.

## 1. Auftrag und Abgrenzung

Gefordert war eine **Messung**, keine Optimierung: Die Parallelisierungs-Entscheidung
für den Screening-Runner (05-04) und die Frage, ob der O(n²)-Pfad überhaupt ein
Worker-Problem oder ein Komplexitätsproblem ist, sollten auf Zahlen stehen statt auf
Vermutungen.

**Unverändert geblieben sind** (per Auftrag gesperrt, per Diff nachweisbar):
`src/lib/ruleEngine.ts`, `src/backtest/indicatorCache.ts`, `src/backtest/engine.ts`.
Es entstanden ausschließlich Mess- und Zuliefer-Werkzeuge
(`scripts/bench-backtest.ts`, `scripts/import-history-csv.ts`) sowie Doku.

## 2. Messaufbau

### 2.1 Messreihe (echte Daten, kein Generator)

| Feld | Wert |
| --- | --- |
| Instrument / Timeframe | `BINANCE:BTCUSDT` / `1h` |
| Quelle | Klines-Export (CSV) einer öffentlichen Binance-Historie, offline importiert |
| Import-Befehl | `npm run history:import-csv -- --file=<csv> --instrument=BINANCE:BTCUSDT --timeframe=1h --dir=data/bench/history --from=2019-06-01 --to=2021-06-10 --max-bars=25000 --apply` |
| Reihe im Store | `data/bench/history/candles.ndjson` (Schema v2, `feed: csv-import`) |
| Kerzen verfügbar | 17 749 (2019-06-01 00:00 → 2021-06-10 00:00 UTC) |
| Gemessenes Fenster | letzte **17 520** Kerzen (2019-06-10 13:00 → 2021-06-10 00:00 UTC, 2 Jahre 1h) |
| Deduplizierung | 2 649 doppelte Zeitstempel → Store-Regel (`instrumentId+timeframe+ts`, jüngstes `fetchedAt`) |
| Zeitlücken der Reihe | 7 (größte Lücke 3 h) — echte Venue-/Export-Lücken, bewusst nicht geglättet |
| Fingerabdruck | SHA-256 über die gemessene Kerzenfolge, gekürzt `cde3bfbbbe50…` (vollständig im JSON-Artefakt) |

> Die Messreihe ist **echte Marktvolatilität** (keine synthetischen Random-Bars):
> Die Verteilung der Bars entscheidet mit, wie oft der Snapshot-Pfad tatsächlich
> rechnet. Bewusst ist der Fingerabdruck hier gekürzt — der Doku-Secret-Scanner
> wertet nackte 64-Zeichen-Hex-Werte als Fund; der volle Wert steht im Artefakt.

### 2.2 Regel und Messprotokoll

Eine Regel über die Sanitize-Kette (`sanitizeRuleSpec`), dieselbe für beide Pfade:
`BENCH-Baseline (EMA/RSI/ADX/Bollinger)`, Signatur `0iu2v0f`, Bedingungen auf
`rsi14`, `adx14`, `bbwPct`, `macdHist`, `priceVsEma50Pct` — also auf Feldern aus
**allen** Snapshot-Berechnungen (`ema/rsi/atr/adx/bollinger/macd/vwap`).

Protokoll je (Pfad, n): **1 ungemessener Warmlauf** (V8-Tier-Up, GC) + **3 gemessene
Läufe** → berichtet werden alle drei Rohwerte und der **Median**. Ohne Warmlauf
verfälscht der JIT-Sprung den Fit (der Cache-Pfad erschien kalt mit Exponent 0,74
statt ≈ 1). Kein Netz, keine Datenbank, keine Schreibzugriffe außerhalb `data/bench/`.

Gemessene Pfade:

| Pfad | Was läuft |
| --- | --- |
| `rule` | `backtestRule(spec, candles)` — Snapshot je Bar über die **volle** Historie (O(n²)) |
| `multiAsset` | `runMultiAssetBacktest({ candlesBySymbol, strategies, config })` — dieselbe Regel, Execution-Modell `legacy` |
| `cache` | `buildIndicatorCache()` einmal + `snapshotFromCache()` je Bar (Indikator-Pfad ohne Trading-Logik) |

### 2.3 Beleg, dass gerechnet wurde (kein Early-Exit)

| n | `rule` Signale / Trades | `multiAsset` Trades | `cache` Snapshots / Bars |
| ---: | ---: | ---: | ---: |
| 1 000 | 32 / 31 | 32 | 970 / 1 000 |
| 5 000 | 75 / 74 | 75 | 4 970 / 5 000 |
| 17 520 | 272 / 271 | 272 | 17 490 / 17 520 |

Beide Handels-Pfade erzeugen auf derselben Reihe praktisch identische Signalzahlen
(271 vs. 272 Trades) — die Messung vergleicht also gleiche Arbeit, nicht einen
Frühausstieg gegen einen vollen Lauf.

## 3. Rohzahlen

Median über 3 gemessene Läufe nach 1 Warmlauf; `ms/1000` = Median ÷ n × 1000.

| Pfad | n | Rohwerte (ms) | Median (ms) | ms/1000 Kerzen |
| --- | ---: | --- | ---: | ---: |
| `rule` | 1 000 | 85,8 · 82,7 · 96,1 | **85,8** | 85,83 |
| `rule` | 5 000 | 1 772,0 · 1 821,4 · 1 657,0 | **1 772,0** | 354,40 |
| `rule` | 17 520 | 26 295,5 · 25 986,2 · 25 899,0 | **25 986,2** | 1 483,23 |
| `multiAsset` | 1 000 | 11,5 · 8,3 · 18,6 | **11,5** | 11,55 |
| `multiAsset` | 5 000 | 67,7 · 41,1 · 42,5 | **42,5** | 8,51 |
| `multiAsset` | 17 520 | 239,0 · 207,8 · 213,5 | **213,5** | 12,19 |
| `cache` | 1 000 | 3,6 · 3,8 · 3,0 | **3,6** | 3,58 |
| `cache` | 5 000 | 12,5 · 12,6 · 13,7 | **12,6** | 2,52 |
| `cache` | 17 520 | 72,2 · 102,6 · 71,0 | **72,2** | 4,12 |

**Faktoren beim größten Messpunkt (17 520 Kerzen, 2 Jahre 1h):**

| Vergleich | Faktor |
| --- | ---: |
| `rule` / `multiAsset` | **121,7×** schneller |
| `rule` / `cache` | **360,1×** schneller |

## 4. Fit-Exponent (log-log, kleinste Quadrate über die drei Messpunkte)

`log(t) = Exponent · log(n) + c` über die drei Mediane je Pfad:

| Pfad | Erwartung | Gemessen | Bewertung |
| --- | --- | ---: | --- |
| `rule` | ≈ 2 (O(n²)) | **1,99** | bestätigt — quadratisch, wie in STX-12 beschrieben |
| `multiAsset` | ≈ 1 (O(n)) | **1,01** | bestätigt — linear |
| `cache` | ≈ 1 (O(n)) | **1,04** | bestätigt — linear |

Der Unterschied zwischen `rule` und `multiAsset`/`cache` ist damit **strukturell**
und nicht ein Konstanten-/Implementierungsdetail: eine Verdopplung der Historie
kostet im Single-Rule-Pfad **4×**, im Engine-/Cache-Pfad **2×** Zeit.

## 5. „1 Zelle Matrix" — 7 500 Zellen × Median-Laufzeit der 1h-Zelle

Zellkosten = Median-Laufzeit bei **17 520 Kerzen** (2 Jahre Stundenkerzen).
`Kernstunden seriell` = 7 500 × Zellkosten ÷ 3 600 000 ms.

| Pfad | Zelle (ms) | Kernstunden seriell (7 500 Zellen) | Kernstunden (Top-50-Pilot) |
| --- | ---: | ---: | ---: |
| `rule` | 25 986,2 | **54,14 Kernstunden** (≈ 27,1 h auf 2 Kernen) | 0,36 |
| `multiAsset` | 213,5 | **0,44 Kernstunden** (≈ 26 min seriell) | 0,003 (≈ 11 s) |
| `cache` | 72,2 | 0,15 Kernstunden | 0,001 |

**Lesart für die Roadmap:** Die 7 500-Zellen-Matrix ist mit dem **Engine-Pfad**
deutlich unter der 1-Kernstunden-Schwelle — sie ist also **kein**
Parallelisierungsproblem (5 400× weniger Rechenzeit als der Single-Rule-Pfad).
Mit `backtestRule()` wäre dieselbe Matrix > 54 Kernstunden; `worker_threads` würden
daran nichts ändern, nur Speicher vervielfachen (Parallelisierung auf O(n²)
skaliert die Zeit nicht herunter, sie verteilt sie).

## 6. Entscheidung (verbindlich für 03-09 / 05-04 / 06-*)

> **Screening, Template-Compiler-Tests und Validator-Läufe fahren ausschließlich über
> `runMultiAssetBacktest()` (bzw. direkt über `buildIndicatorCache`/`snapshotFromCache`).
> `backtestRule()` bleibt der Referenz-/Einzelpfad für API und UI, wird aber **nicht**
> in die Matrix eingebunden, solange es O(n²) ist.**

Begründung, in der Sprache der Akzeptanztabelle des Prompts:

| Messung | Konsequenz | Belegt durch |
| --- | --- | --- |
| Exponent ≈ 2 im Single-Rule-Pfad | **05-04 fährt über `runMultiAssetBacktest`** | 1,99 vs. 1,01 |
| 7 500 Zellen > 1 Kernstunde | Screening zuerst **Top-N** (Pilot `G6`: 50 Zellen); `RULE_BACKTEST_TRADE_CAP` und `RULE_BACKTEST_MIN_BARS` bleiben die harten Grenzen des Regel-Backtest-Pfads | 54,14 h (rule) vs. 0,44 h (engine) |
| Cache-Pfad ≥ 10× schneller | **03-09/05-04 nutzen den Cache**; STX-12 wird **Patch-Task** (Paritätstest gegen die alte Implementierung, Byte-Gleichheit der Ergebnisse) statt Blocker | 360,1× (Cache), 121,7× (Engine) |

**Kein `worker_threads` in 05-04 als Voraussetzung.** Die volle Matrix läuft
seriell in 0,44 Kernstunden; Parallelisierung ist eine *Option* für Wall-Clock,
keine Voraussetzung für Machbarkeit. Sie wird erst relevant, wenn die Zellenzahl
oder die Zellgröße (Multi-Timeframe je Zelle) steigt.

## 7. Konsequenzen für die Roadmap

- **Gate G5** („00-01 abgeschlossen, Pfad-Entscheidung getroffen") ist mit diesem
  Dokument **erfüllt**; 05-04 kann starten, sobald `G4` (04-02 grün) steht.
- **05-02 (Matrix-Builder)** muss die Zellkosten im Datenmodell führen
  (Zellgröße = Kerzenzahl), damit `G6` („Pilotlauf < 1 Kernstunde/50 Zellen")
  messbar bleibt: bei 50 Zellen × 2 Jahre 1h kostet `multiAsset` **≈ 11 s**.
- **03-09 (Compiler + Sanitize-Nachweis)** darf keinen neuen O(n²)-Pfad einführen;
  die Templates werden gegen den Cache-Pfad getestet, der bereits in
  `engine.ts` verdrahtet ist.
- **STX-12** bleibt als Finding offen (der Code ist unverändert O(n²)), ist aber
  auf „Patch mit Paritätstest" herabgestuft: `backtestRule()` auf
  `buildIndicatorCache`/`snapshotFromCache` umstellen und die Ergebnisgleichheit
  (Signale, Trades, PnL) gegen die heutige Implementierung fixieren.
- **Datenreihe**: 7 Zeitlücken und 2 649 doppelte Zeitstempel im Export zeigen,
  dass Importe *immer* durch den Store dedupliziert und auf Lücken geprüft werden
  müssen — `npm run history:import-csv` zählt beides und meldet es.

## 8. Reproduktion (offline, ohne Datenbank)

```bash
# 1) Messreihe in den Store legen (Dry-Run ist der Default, Exit 2)
npm run history:import-csv -- --file=<klines.csv> --instrument=BINANCE:BTCUSDT \
  --timeframe=1h --dir=data/bench/history --from=2019-06-01 --to=2021-06-10 \
  --max-bars=25000 --apply

# 2) Protokoll messen (3 Messpunkte × 3 Läufe × 3 Pfade, ≈ 2 min auf 2 Kernen)
npm run bench:backtest -- --instrument=BINANCE:BTCUSDT --dir=data/bench/history
```

Beide Befehle brauchen **keine** Datenbank: `bench:backtest` importiert kein
`src/db`-Modul, liest ausschließlich den `HistoricalStore` und schreibt nur nach
`data/bench/` (gitignoriert). Gegen den eigenen Betriebsstand misst man mit
`--dir=data/history` (nach `npm run market-sync`).

Optionen für Wiederholungen: `--sizes=1000,5000,17520`, `--repeat=3`,
`--warmup-runs=0|1`, `--paths=rule,multiAsset,cache`, `--execution-model=legacy|paper`,
`--no-write`. Ergebnis: Tabelle auf stdout + `data/bench/bench-<instrument>-<tf>.{json,md}`.

## 9. Grenzen der Messung

- **Ein Instrument, ein Timeframe, eine Regel.** Der Exponent ist eine Eigenschaft
  der Pfade, die absolute Laufzeit hängt an Maschine, Regel (Zahl der Feld-Bedingungen)
  und Datenverteilung. Andere Kerzenzahlen/Märkte ändern die Konstanten, nicht die
  Ordnung.
- **`legacy`-Ausführungsmodell** (Engine-Default, byte-kompatibel). Der `paper`-Pfad
  legt Fill-Simulator und Funding darüber und liegt höher — gemessen wurde bewusst
  der Vergleich „gleiche Regel, billigster Engine-Pfad" gegen `backtestRule`.
- **Warmlauf enthalten** (1 ungemessener Lauf je Messpunkt): Wer die Kaltkosten
  braucht, misst mit `--warmup-runs=0` — die Zahlen liegen dann höher, der Exponent
  des Cache-Pfads verzerrt sich nach unten (JIT-Sprung, nicht Skalierung).
- **Median aus 3 Läufen** ist robust gegen einzelne Ausreißer (sichtbar in den
  Rohwerten), aber kein Konfidenzintervall; für Regressionsvergleiche über Wochen
  sollten dieselben Rohwerte über das JSON-Artefakt verglichen werden.
- **Messreihe ist ein Export-Dump**, kein Venue-Livefeed: 7 Lücken und doppelte
  Zeitstempel sind dokumentiert; für Paritätsaussagen (STX-12-Patch) ist die Reihe
  ausreichend, für Rendite-Aussagen nicht relevant (es wird nichts gehandelt).

## 10. Referenzen

- Audit-Index: [`../README.md`](../README.md) · Finding: [`STX-12`](../findings/STX-12-backtestrule-o-n-quadratisch.md) · Prompt: [`00-01`](../prompts/PROMPT-STX-00-01-backtest-perf-baseline.md)
- Roadmap & Gates: [`../ROADMAP.md`](../ROADMAP.md) · Tracking: [`TRACKING.md`](TRACKING.md)
- Versionierung dieses Releases: [`../VERSIONING.md`](../VERSIONING.md)
- Werkzeuge: `scripts/bench-backtest.ts`, `scripts/import-history-csv.ts`
- Store-Vertrag (Dedup, Lücken, Schema): [`../../../HISTORY.md`](../../../HISTORY.md)
- Backtest-CLI-Referenz: [`../../../BACKTESTING.md`](../../../BACKTESTING.md)

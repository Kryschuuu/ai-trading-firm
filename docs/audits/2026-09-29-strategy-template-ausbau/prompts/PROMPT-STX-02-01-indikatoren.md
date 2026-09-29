# STX-02-01 — `bollingerBands()` und `donchianChannel()` in `indicators.ts`

- **Phase:** 2 · **Paket:** 00-03 · **Findings:** STX-18, STX-01
- **Risiko:** niedrig (additive, pure Funktionen)

## Zweck

`indicators.ts` bietet bisher nur `bollingerBandWidthPct` — **keine** Band-Level. Und
überhaupt nichts Donchian-artiges (`grep -ri donchian src/` → 0 Treffer). Ohne diese
beiden Funktionen sind die Templates 03-06 (Bollinger Squeeze) und 03-08 (Donchian
Breakout) nicht referenzierbar.

## Kontext

Bestehende Konventionen in `src/lib/indicators.ts`:
- pure Funktionen, keine IO, kein `Date.now()`
- `Candle`-Typ kommt aus `./marketData`; `ruleEngine.ts` nutzt `CandleLike` für
  Import-Freiheit — **folge `indicators.ts`, nicht `ruleEngine.ts`** (dieses Modul ist
  die Import-Freiheit nicht wert)
- nicht berechenbare Werte ⇒ `null`, **nie** 0
- Kommentar-Block im Deutschen, Unit + Formel im Klartext

## Auftrag

### 1. `bollingerBands(closes, period = 20, mult = 2)`

```ts
export interface BollingerReading {
  upper: number;
  middle: number;   // SMA(period)
  lower: number;
  width: number;     // (upper − lower) / middle
  bandwidthPct: number;
}
export function bollingerBands(closes: number[], period = 20, mult = 2): BollingerReading | null;
```

- `null`, wenn `closes.length < period` oder `middle <= 0`
- **`mult` klemmen** auf `[1, 4]`, `period` auf `[5, 200]` (Muster
  `RULE_CEILINGS.volumeWindow`) — die Funktion ist Teil eines Systems, in dem ein
  LLM Parameter vorschlagen darf
- **Deklariere die Parität zu `bollingerBandWidthPct`:** die neue `bandwidthPct` muss für
  identische Eingaben identisch zur bestehenden Funktion sein. Ein Test beweist das
  (siehe Akzeptanz). Falls sie abweicht, **dokumentiere warum** — und ändere
  `bollingerBandWidthPct` **nicht**.

### 2. `donchianChannel(candles, entryPeriod = 20, exitPeriod = 10)`

```ts
export interface DonchianReading {
  upper: number;   // max(high) der VORLETZTEN entryPeriod Kerzen (ohne die aktuelle)
  lower: number;   // min(low)  der VORLETZTEN exitPeriod  Kerzen
  mid: number;
}
export function donchianChannel(candles: Candle[], entryPeriod = 20, exitPeriod = 10): DonchianReading | null;
```

- **Lookahead-Schutz ist hier der springende Punkt:** `upper` darf die **aktuelle** Kerze
  **nicht** enthalten. Ein „highest high including today" ist ein Look-ahead-Bug, weil
  der Breakout erst mit dem Schluss der aktuellen Kerze feststeht. Benutze
  `candles.slice(-(entryPeriod + 1), -1)` und dokumentiere den Grund im Klartext.
- `null`, wenn `candles.length < entryPeriod + 1`
- Perioden klemmen: `entryPeriod ∈ [5, 200]`, `exitPeriod ∈ [3, 100]`, und
  `exitPeriod <= entryPeriod` erzwingen
- **HTF-Regel:** Donchian ist per Definition eine Higher-Timeframe-Logik (Ausbruchs- und
  Trendfolge-Systeme). Dokumentiere das im Modulkopf; 03-08 muss daraus eine
  Mindest-Timeframe-Bedingung ableiten.

## Akzeptanzkriterien

- [ ] `tests/indicators.test.ts`: beide Funktionen, inkl. Randfälle
  (`null` bei zu wenig Daten, `mult`-Klemmung, `exitPeriod > entryPeriod`)
- [ ] **Lookahead-Test:** für ein synthetisches, streng monoton steigendes Series
      gilt `donchianChannel(...).upper < lastClose` — der Ausbruch ist also
      **nicht** in derselben Kerze eingebaut, in der er entsteht
- [ ] **Paritätstest:** `bollingerBands(c).bandwidthPct === bollingerBandWidthPct(c)`
      für 5 Fixture-Serien
- [ ] `bollingerBandWidthPct` **unverändert** (Diff beweist es)
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] Kein Feld in `RULE_FIELDS` geändert (kommt in 02-02/02-03)

## Gesperrt

- **Keine** Änderung an `bollingerBandWidthPct`, `macd`, `adx`, `rsi`, `ema`, `atrPct`,
  `sessionVwap` — bestehende Strategien hängen daran.
- **Kein** `RuleSnapshot`-/`RULE_FIELDS`-Eintrag in diesem Prompt.
- **Kein** Import von `ruleEngine.ts` (Import-Zyklus).
- Keine `IndicatorCache`-Änderung (kommt in 02-02/02-03).

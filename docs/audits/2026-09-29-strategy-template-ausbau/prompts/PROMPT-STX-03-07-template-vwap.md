# STX-03-07 — Template: VWAP-Bias (Snapshot-Variante, **ohne** Pullback-Sequenz)

- **Phase:** 3 · **Paket:** 03-02, 01-01 · **Finding:** STX-18
- **Risiko:** mittel (das Ausbaudokument verlangt hier mehr, als sicher machbar ist)

## Zweck

Fünftes Template. Nutzt `vwapPct` — ein Feld, das im Mikropfad bereits berücksichtigt
wird. **Achtung:** Das Ausbaudokument verlangt hier ausdrücklich eine Sequenz
(`price_below_vwap` → `price_reclaims_vwap`). Das wird in diesem Prompt **nicht**
gebaut — siehe „Was hier bewusst fehlt".

## Kontext

`vwapPct` ist „Kurs gegen den **Session**-VWAP in Prozent"; Tagesanker ist der
**UTC-Kalendertag** der letzten Kerze (`ruleFieldCatalog.ts`, `indicators.ts:151
utcDayAnchorMs`). Zwei Konsequenzen:

1. **Zeitrahmen-Disziplin:** Auf `1d` ist der Anker exakt eine Kerze ⇒ `vwapPct` wird
   nach 01-01 `null`. Dieses Template unterstützt deshalb **nur Intraday**.
2. **UTC statt Börsenzeit:** Der Anker ist der UTC-Tag, nicht der Session-Tag der
   Börse. Für US-Equities ist das ein **Bekannter** Versatz, kein Bug. Steht als
   `DATA`-Annahme im Template — sonst sucht jemand später den Fehler im Code.

## Was hier bewusst fehlt (und warum)

Das Ausbaudokument schlägt vor:

```ts
sequence: ["price_below_vwap", "price_reclaims_vwap"];   // ❌ nicht in diesem Prompt
type RuleTrigger = "SNAPSHOT" | "CROSS" | "RECLAIM" | "BREAKOUT";  // ❌ eigener Audit
```

Der heutige Evaluator ist **zustandslos**: `compileRuleSpec()` erzeugt eine Closure über
einen Snapshot (`ruleEngine.ts`). Ein `RECLAIM` braucht **Speicher über die Zeit**
(„war der Kurs in den letzten N Bars unter dem VWAP?") — das bedeutet Zustand im
`MicroExecutor` mit Regressionsrisiko für Stops, Cooldowns und
`maxExecutionsPerDay`, plus Tests über Executor-Lebensdauer.

**Das ist kein 60-Zeilen-Feld, das ist ein eigener Audit** (STX-18). Der Doc-Kommentar
im Template muss genau das sagen, damit der nächste Leser es nicht für eine
vergessene Funktion hält.

## Auftrag

Lege `src/strategies/templates/vwap-pullback.ts` an.

| Feld | Wert |
|---|---|
| `id` | `vwap-pullback` |
| `class` | `"trend"` (ADR-E1) — die Snapshot-Variante ist ein Trend-Bias |
| `supportedTimeframes` | `["5m", "15m", "1h"]` — **kein** `4h`/`1d` (STX-01, `vwapPct`-Anker) |
| `requiredFields` | `["trend", "vwapPct", "volumeRatio", "priceVsEma21Pct", "atrPct"]` |

**Parameter:**

| key | label | unit | default | min | max | step | mapsTo |
|---|---|---|---|---|---|---|---|
| `vwapMinPct` | Kurs mind. über VWAP | % | `0.10` | `-0.5` | `2.0` | `0.05` | `vwapPct` |
| `ema21BufferPct` | Kurs über EMA 21 | % | `0.1` | `-1` | `3` | `0.1` | `priceVsEma21Pct` |
| `volumeRatioMin` | Volumenverhältnis | ratio | `1.1` | `0.8` | `2.5` | `0.05` | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | `3` | `0.5` | `10` | `0.25` | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | `2` | `1` | `4` | `0.25` | — |

**`buildRule`:** `logic: "all"`, vier Bedingungen — `trend eq "UP"`,
`vwapPct gte vwapMinPct`, `priceVsEma21Pct gte ema21BufferPct`,
`volumeRatio gte volumeRatioMin`.

`window.timeframe: "15m"`, `maxExecutionsPerDay: 3`, `cooldownMinutes: 120`.

**Doc-Kommentar-Pflicht (drei Punkte, alle verpflichtend):**

1. **Was dieses Template *ist*:** ein Tages-Bias-Filter („long, wenn der Tag über dem
   VWAP und im Aufwärtstrend läuft") — **kein** Pullback. Der Name `vwap-pullback` ist
   deshalb irreführend: erwäge `vwap-trend-bias` als ID, oder benenne die
   Einschränkung **so** im Doc-Kommentar, dass der Name nicht übervertreibt.
   *(Triff die Entscheidung bewusst und begründe sie.)*
2. **Warum `4h`/`1d` ausgeschlossen sind** (UTC-Tagesanker, eine Kerze).
3. **Was der echte Pullback bräuchte** (Sequenz-Zustand im Executor) und dass das ein
   eigener Audit ist.

**`assumptions`** (mindestens 4), u. a.:

- `DATA` „`vwapPct` ist UTC-Tag- verankert, nicht Börsen-Session — für US-Equities ein
  bekannter Versatz" — `critical: true`
- `MARKET` „Kurse über dem Session-VWAP handeln im Tagesverlauf häufiger weiter" — `critical: false`
- `EXECUTION` „Der VWAP ist eine **historische** Größe; er sagt nichts über den
  Ausführungskurs aus (Bid/Ask-Spread ist separat über `spreadPct`)" — `critical: true`
- `COST` „Intraday-Handel ⇒ Gebühren-/Slippage-Annahme ist hier die kritischste" — `critical: true`

**`expectedRegimes`**: `["TREND_UP"]`

## Akzeptanzkriterien

- [ ] `validateTemplate(...)` liefert `[]`
- [ ] `supportedTimeframes` enthält **kein** `>= "1h"` ohne `5m`/`15m` — genauer:
      kein `1d`, kein `4h` (Begründung im Doc-Kommentar)
- [ ] `buildRule(defaults)` → `sanitizeRuleSpec()` ohne Klemmschreiben
- [ ] **Test:** Template-`supportedTimeframes` ⊆ Menge der Timeframes, für die
      `vwapPct` belastbar ist — als Konstante im Template-Modul, getestet
- [ ] Ein Eintrag in `STRATEGY_TEMPLATES`
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** `RuleTrigger`-/`CROSS`/`RECLAIM`-Erweiterung.
- **Kein** Zustand im `MicroExecutor`.
- **Keine** Änderung an `sessionVwap`, `utcDayAnchorMs`, `vwapPct`-Berechnung.

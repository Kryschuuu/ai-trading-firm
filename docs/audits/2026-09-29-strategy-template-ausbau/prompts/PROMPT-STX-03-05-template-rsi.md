# STX-03-05 — Template: RSI Mean-Reversion

- **Phase:** 3 · **Paket:** 03-02 · **Finding:** STX-18
- **Risiko:** mittel (die Strategieklasse ist hier **entscheidend**)

## Zweck

Drittes Template. Es ist das erste, das `class: "mean-reversion"` trägt — und damit
das erste, das **beweist**, dass ADR-E1 trägt: das Template wirkt anschließend über
`regimeGateFactor(regime, strategyClass, cfg)` und die Decay-Policy der Klasse.

## Kontext — der entscheidende Punkt

Mean-Reversion und Trendfolge sind **regimegegensätzlich**. Eine
RSI-Mean-Reversion-Regel in `TREND_UP` ist nicht „schwächer", sie ist **verkehrt
herum**: Sie kauft in eine fallende Bewegung, weil der RSI niedrig ist — in einem
aufwärtstrend, in dem der RSI niedrig bleibt.

Die bestehende Infrastruktur weiß das bereits:
`regimeGateFactor(regime, strategyClass, cfg)` **reduziert** das Risikobudget dieser
Klasse in den Regimen, in denen sie nicht gehört (`microExecutor.ts:779-786`).

**Deshalb:** dieses Template ist der Testfall dafür, ob ADR-E1 wirklich durchgeschaltet
wird. Ein Template, das `class` nicht setzt, fällt auf `"unclassified"` und verliert
diesen Schutz **still**.

## Auftrag

Lege `src/strategies/templates/rsi-mean-reversion.ts` an.

| Feld | Wert |
|---|---|
| `id` | `rsi-mean-reversion` |
| `class` | `"mean-reversion"` |
| `supportedTimeframes` | `["15m", "1h", "4h"]` |
| `requiredFields` | `["rsi14", "priceVsEma21Pct", "adx14", "volumeRatio", "atrPct"]` |

**Parameter:**

| key | label | unit | default | min | max | step | mapsTo |
|---|---|---|---|---|---|---|---|
| `rsiOversold` | RSI-Überverkauft-Schwelle | Index | `30` | `15` | `40` | `1` | `rsi14` |
| `ema21GapPct` | Kurs mind. unter EMA 21 | % | `1.0` | `0.3` | `5` | `0.1` | `priceVsEma21Pct` |
| `adxMax` | **maximaler** ADX (Seitwärts-Filter) | Index | `20` | `10` | `30` | `1` | `adx14` |
| `volumeRatioMin` | Volumenverhältnis | ratio | `1.1` | `0.8` | `2.5` | `0.05` | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | `5` | `1` | `15` | `0.5` | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | `1.5` | `1` | `4` | `0.25` | — |

**`buildRule`:** `logic: "all"`, vier Bedingungen — `rsi14 lte rsiOversold`,
`priceVsEma21Pct lte -ema21GapPct`, `adx14 lte adxMax`, `volumeRatio gte volumeRatioMin`.

Beachte die **zwei** richtungsgebenden Filter: der RSI markiert die Überdehnung, der
`adx14 lte`-Filter schließt Trends aus. **Ohne** den ADX-Filter ist das Template kein
Mean-Reversion, sondern ein „Catching the falling knife"-System.

**Doc-Kommentar-Pflicht:**
1. Warum `adx14` **max** und nicht **min** ist (sonst widerspricht die Bedingung der Strategie).
2. Warum `takeProfitRR` hier niedriger ist als in 03-03/03-04: Mean-Reversion hat
   schlechtere Trefferquote und braucht das kleine Chance/Risiko-Verhältnis, um das
   Odds-Ratio zu kompensieren.
3. **Warum `bbZScore` hier fehlt**, obwohl die Analyse es vorschlägt: Der Z-Score ist
   normalisiert und damit besser als RSI, aber er braucht `bollingerBands` — dieses
   Template ist so gebaut, dass es **vor** 02-02 funktioniert. Notiere die Reihenfolge-
   Abhängigkeit im Doc-Kommentar.

**`assumptions`** (mindestens 4), u. a.:

- `REGIME` „Funktioniert in `RANGE`; in `TREND_UP`/`TREND_DOWN` greift nur das Regime-Gate" — `critical: true`
- `MARKET` „Überverkaufte Zustände sind keine Bodenbildung" — `critical: false`
- `COST` „Mean-Reversion hat höhere Turnover-Rate ⇒ Gebühren-/Slippage-Annahme ist hier **besonders** lastend" — `critical: true`
- `DATA` „RSI(14) braucht 15 Schlusskurse" — `critical: true`

**`expectedRegimes`**: `["RANGE"]`

## Akzeptanzkriterien

- [ ] `validateTemplate(...)` liefert `[]`
- [ ] `buildRule(defaults)` → `sanitizeRuleSpec()` ohne Klemmschreiben
- [ ] **Test: `adx14`-Operator ist `lte`, nicht `gte`** — Regression gegen die
      Trend-Vorlage
- [ ] **Test: `class === "mean-reversion"`** und `class !== "unclassified"`
- [ ] Ein Eintrag in `STRATEGY_TEMPLATES`
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** Regime-Gate-Änderung. Dieses Template **nutzt** sie, es verändert sie nicht.
- Keine `SHORT`-Seite (Mean-Reversion wäre short-seitig die natürlichere Variante —
  das ist der Grund für die globale Long-Sperre und ein **eigener Audit**).
- Keine Änderung an `rsi` in `indicators.ts`.

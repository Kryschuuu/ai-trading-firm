# STX-03-03 — Template: EMA/ADX Trend

- **Phase:** 3 · **Paket:** 03-02 · **Finding:** STX-18 (bestätigt: keine Engine-Arbeit)
- **Risiko:** niedrig · **Erster Prompt, der ein sichtbares Ergebnis liefert**

## Zweck

Das erste echte Strategie-Artefakt. Braucht **keine** neuen Felder, keine neuen
Indikatoren, keine Engine-Änderung — ein reines Parameterraster über dem
bestehenden `RuleSpec`-Vertrag. Ideal als Referenz für 03-04…03-08.

## Kontext

Verfügbare Felder (`src/lib/ruleFieldCatalog.ts`): `trend`, `priceVsEma50Pct`,
`priceVsEma21Pct`, `adx14`, `volumeRatio`, `atrPct`, `rsi14`, `price`, `ema9/21/50`.

`trend` ist `"UP" | "DOWN" | "FLAT"` und wird bei `|EMA9−EMA21|/price ≥ 0.001` auf
UP/DOWN gesetzt (`ruleEngine.ts`). Das ist eine **Hysterese von 0.1 %** — die
Breakout-Schwelle des Templates muss darüber liegen, sonst ist der Filter wirkungslos.

## Auftrag

Lege `src/strategies/templates/ema-adx-trend.ts` an.

**Template-Daten:**

| Feld | Wert |
|---|---|
| `id` | `ema-adx-trend` |
| `class` | `"trend"` (ADR-E1) |
| `version` | `1` |
| `scope` | `"SINGLE_SYMBOL"` |
| `supportedTimeframes` | `["1h", "4h"]` — **kein** Intraday: ADX(14) braucht 29 Kerzen, auf `5m` ist das 2.5 h Historie, auf `1m` 29 min. Trendreihenfolge ist auf Intraday strukturell schwach. |
| `requiredFields` | `["trend", "priceVsEma50Pct", "adx14", "volumeRatio", "atrPct"]` |

**Parameter** (mit `step` für die Sensitivitätsanalyse 06-02):

| key | label | unit | default | min | max | step | mapsTo |
|---|---|---|---|---|---|---|---|
| `adxMin` | ADX-Mindestwert | Index | `22` | `15` | `35` | `1` | `adx14` |
| `ema50BufferPct` | Kurs mindestens über EMA 50 | % | `0.2` | `0` | `3` | `0.1` | `priceVsEma50Pct` |
| `volumeRatioMin` | Volumenverhältnis | ratio | `1.0` | `0.8` | `2.0` | `0.05` | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | `4` | `1` | `12` | `0.5` | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | `2` | `1` | `4` | `0.25` | — |

**`buildRule(params)`** erzeugt `RuleSpecInput`:

- `condition.logic = "all"`, vier Bedingungen: `trend eq "UP"`,
  `priceVsEma50Pct gte ema50BufferPct`, `adx14 gte adxMin`, `volumeRatio gte volumeRatioMin`
- `action`: `side "LONG"`, `stopLossPct`, `takeProfitRR`,
  `riskBudgetPct: 0.01`, `maxPositionPct: 0.15`, `positionSizeMode: "risk"`
  *(beide innerhalb `LIMIT_CEILINGS`: `maxRiskPerTrade [0.002, 0.05]`,
  `maxPositionPct [0.01, 0.5]` — **verifiziere** das im Code, nicht aus dem Gedächtnis)*
- `window`: `timeframe: "1h"`, `maxExecutionsPerDay: 2`, `cooldownMinutes: 240`,
  `volumeWindow: 20`
- `sourceRole: "RESEARCH"`, `rationale` (deutsch, 1–2 Sätze), `riskScore: 0.5`
- `missionId: null`, `symbol` ist ein **Pflichtparameter des Aufrufers**, nicht des
  Builders — dokumentiere das

**`assumptions`** (mindestens 4, mit `category` und `critical`):

- `MARKET` „Trendreihen sind auf 1h/4h häufiger als Seitwärtsphasen" — `critical: false`
- `DATA` „ADX(14) braucht 29 Kerzen; kürzere Fenster liefern `null`" — `critical: true`
- `COST` „Die Volumenbedingung reduziert Transaktionen; Gebühren bleiben auf Backtest-Niveau" — `critical: false`
- `REGIME` „Funktioniert in `TREND_UP`; in `RANGE` degradiert die ADX-Bedingung" — `critical: false`

**`expectedRegimes`**: `["TREND_UP"]`

**Doc-Kommentar-Pflicht:** Begründe im Kopf, warum `1m`/`5m` **nicht**
unterstützt werden und warum `ema50BufferPct` über der `trend`-Hysterese (0.1 %)
liegen muss.

## Akzeptanzkriterien

- [ ] `validateTemplate(buildEmaAdxTrend())` liefert `[]`
- [ ] `buildRule(defaults)` durchläuft `sanitizeRuleSpec()` **ohne** Klemmschreiben
- [ ] Ein Aufruf mit `adxMin: 99` (außerhalb `max`) scheitert in `validateTemplate`,
      **nicht** erst in `sanitizeRuleSpec`
- [ ] Test: `buildRule` ist tiefengleich bei zwei Aufrufen (03-02 prüft das generisch)
- [ ] Ein Eintrag in `STRATEGY_TEMPLATES` in `catalog.ts`
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] **Noch kein** Backtest-Lauf in diesem Prompt (kommt in 03-10)

## Gesperrt

- **Keine** Änderung an `ruleEngine.ts`, `RULE_CEILINGS`, `indicators.ts`.
- **Keine** `SHORT`-Seite.
- **Kein** `vwapPct` (auf `1h` ist der Tagesanker nicht belastbar — STX-01).
- **Keine** Sequenz-/Reclaim-Logik.

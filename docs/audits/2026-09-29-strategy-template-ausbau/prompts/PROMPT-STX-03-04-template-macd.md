# STX-03-04 — Template: MACD Momentum

- **Phase:** 3 · **Paket:** 03-02 · **Finding:** STX-18
- **Risiko:** niedrig

## Zweck

Zweites Template, kein Engine-Bedarf. Es ist zugleich das **Referenztemplate für
06-02 (Overfit)**, weil es die wenigsten Parameter und die klarste Ökonomie hat —
wenn es hier schon im In-Sample kollabiert, ist das ein Befund, kein Bug.

## Kontext

`macdHist` ist `macd − signal` in **Preiseinheiten** (`ruleFieldCatalog.ts`) — nicht
in Prozent, nicht normalisiert. Das hat eine harte Folge, die im Doc-Kommentar stehen
**muss**: ein Schwellwert `macdHist > 0` ist **nicht** marktübergreifend. Für BTC
(6-stellig) und für einen 5-stelligen Aktienkurs bedeutet dasselbe `0.5` völlig
verschiedenes. Die Reihenfolge der Analyse sieht genau hier eine Verwechslung von
Momentum und Volatilität.

**Konsequenz für dieses Template:** Verwende `macdHist` **nur** in der
`gt 0`-Bedingung (Vorzeichen ist skalenfrei). Jede **magnitude**-basierte Bedingung
wäre marktabhängig und wird **nicht** eingebaut.

## Auftrag

Lege `src/strategies/templates/macd-momentum.ts` an.

| Feld | Wert |
|---|---|
| `id` | `macd-momentum` |
| `class` | `"trend"` (ADR-E1) |
| `supportedTimeframes` | `["1h", "4h"]` |
| `requiredFields` | `["macdHist", "priceVsEma50Pct", "adx14", "atrPct"]` |

**Parameter:**

| key | label | unit | default | min | max | step | mapsTo |
|---|---|---|---|---|---|---|---|
| `adxMin` | ADX-Mindestwert | Index | `20` | `14` | `35` | `1` | `adx14` |
| `ema50BufferPct` | Kurs über EMA 50 | % | `0.0` | `-1` | `3` | `0.1` | `priceVsEma50Pct` |
| `stopLossPct` | Stop-Loss | % | `4` | `1` | `12` | `0.5` | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | `2` | `1` | `4` | `0.25` | — |

**`buildRule`:**

- `logic: "all"`, drei Bedingungen:
  - `macdHist gt 0`  ← **immer**, load-bearing
  - `priceVsEma50Pct gt ema50BufferPct`
  - `adx14 gte adxMin`
- `action` wie 03-03 (`riskBudgetPct: 0.01`, `maxPositionPct: 0.15`)
- `window`: `timeframe: "1h"`, `maxExecutionsPerDay: 2`, `cooldownMinutes: 240`
- `rationale` deutsch, `sourceRole: "RESEARCH"`, `riskScore: 0.5`

**`assumptions`** (mindestens 4):

- `MARKET` „MACD-Histogramm-Vorzeichen dreht vor dem Trend" — `critical: false`
- `MARKET` „`macdHist` wird **nicht** als Stärke-Metrik verwendet (Preiseinheiten, nicht skalenfrei)" — `critical: true`
- `DATA` „MACD(12/26/9) braucht 35 Schlusskurse; darunter `null`" — `critical: true`
- `COST` „Häufige Histogramm-Wechsel werden durch Cooldown und Tageslimit gedämpft" — `critical: false`

**`expectedRegimes`**: `["TREND_UP"]`

**Doc-Kommentar-Pflicht:** Erkläre ausdrücklich, **warum keine Magnitude-Bedingung**
(`macdHist gt X` mit X > 0) eingebaut wird, und verweise auf
`priceVsEma50Pct` als skalenfreien Ersatz. Das ist die wichtigste Zeile im File.

## Akzeptanzkriterien

- [ ] `validateTemplate(...)` liefert `[]`
- [ ] `buildRule(defaults)` → `sanitizeRuleSpec()` ohne Klemmschreiben
- [ ] **Test: keine Magnitude-Bedingung auf `macdHist`** — grep über den Builder-Output:
      die einzige `macdHist`-Bedingung ist `gt 0`
- [ ] Ein Eintrag in `STRATEGY_TEMPLATES`
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] `stopLossPct`/`takeProfitRR` **innerhalb** `RULE_CEILINGS`

## Gesperrt

- Keine Änderung an `macd`, `macdSignal`, `macdHist` in `indicators.ts`/`ruleEngine.ts`.
- Keine `SHORT`-Seite (ein MACD-Short wäre die **negative** Variante — sie braucht
  einen `side`-Wert, den die Engine nicht kennt).
- Kein `bbZScore` (kommt in 03-06).

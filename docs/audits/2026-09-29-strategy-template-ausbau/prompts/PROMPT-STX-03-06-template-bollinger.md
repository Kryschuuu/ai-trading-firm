# STX-03-06 — Template: Bollinger Squeeze Breakout

- **Phase:** 3 · **Paket:** 03-02, **02-02** · **Finding:** STX-18
- **Risiko:** niedrig (02-02 liefert die Felder)

## Zweck

Viertes Template — das erste, das ein **neues** Feld aus Phase 2 nutzt. Ohne 02-02
(`bbZScore`, `priceVsUpperBbPct`) ist es nicht referenzierbar.

## Kontext

`bbwPct` (Bandbreite in %) existiert bereits. Neu aus 02-02: `bbZScore` (dimensionslos)
und `priceVsUpperBbPct`.

**Wichtig:** Der `bbwPct`-Schwellwert ist **nicht** marktübergreifend. Eine
Bollinger-Bandbreite von 4 % bedeutet für einen Large-Cap-Aktien daily etwas anderes
als für einen Crypto-Paar auf `1h`. Deshalb:

- **`bbwPct` wird als relativer Parameter innerhalb eines Fensters ausgewertet**, nicht
  als absoluter Schwellwert. Zwei zulässige Wege:
  1. als **Parameter mit eigenem Default je Template**, dokumentiert als marktübergreifend
     nur für die unterstützte Timeframe-Klasse, oder
  2. als **Bedingung auf `bbwPct` mit `mapsTo`-Doku**, die klarstellt, dass der Wert
     **zeitraum- und marktabhängig** ist.
- **Empfehlung: (1).** `bbwPct lt 4` ist eine Magic Number ohne Herleitung. Trage
  stattdessen im Doc-Kommentar die **kalibrierte Herleitung** ein (z. B. „Default
  entspricht der 20. Perzentile der Bandbreite über die letzten 200 Kerzen auf `1h`;
  **vor** einem Live-Einsatz gegen den Store zu prüfen"). Der Wert wird in 06-01/06-02
  vermessen, nicht geraten.

## Auftrag

Lege `src/strategies/templates/bollinger-squeeze.ts` an.

| Feld | Wert |
|---|---|
| `id` | `bollinger-squeeze` |
| `class` | `"breakout"` (ADR-E1) |
| `supportedTimeframes` | `["1h", "4h"]` |
| `requiredFields` | `["bbwPct", "bbZScore", "adx14", "volumeRatio", "atrPct"]` |

**Parameter:**

| key | label | unit | default | min | max | step | mapsTo |
|---|---|---|---|---|---|---|---|
| `bbwMaxPct` | maximale Bandbreite (Squeeze) | % | `6` | `2` | `15` | `0.25` | `bbwPct` |
| `bbZScoreMin` | Kurs über oberer Bandkante | σ | `0.5` | `0` | `3` | `0.1` | `bbZScore` |
| `adxMin` | ADX-Bestätigung | Index | `22` | `15` | `35` | `1` | `adx14` |
| `volumeRatioMin` | Volumen beim Ausbruch | ratio | `1.2` | `0.9` | `3` | `0.05` | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | `4` | `1` | `12` | `0.5` | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | `2.5` | `1` | `5` | `0.25` | — |

**`buildRule`:** `logic: "all"`, vier Bedingungen — `bbwPct lte bbwMaxPct`,
`bbZScore gte bbZScoreMin`, `adx14 gte adxMin`, `volumeRatio gte volumeRatioMin`.

**`bbZScoreMin: 0.5` statt `2`:** Der Wert 2 (2 σ) aus dem Ausbaudokument ist
**kein** Ausbruch — bei Bollinger(20,2) ist `close == upper` per Konstruktion `z ≈ 1.4`
(bei normalverteilten Daten), nie 2. `0.5` heißt: **über der mittleren Bandlinie**,
also der Bereich, in dem der Ausbruch beginnt. Dokumentiere diese Rechnung im
Doc-Kommentar — sie ist der Grund, warum der Wert nicht 2 ist.

Alternativ, falls `bbZScore` nicht verfügbar: `priceVsUpperBbPct gte 0` als Ersatz.
**Beide nicht kombinieren** — sie sind dieselbe Aussage, redundant.

**`assumptions`** (mindestens 4), u. a.:

- `MARKET` „Volatilitätskontraktion geht einer Expansion voraus" — `critical: true`
- `DATA` „`bbwPct` ist **nicht** marktübergreifend; die Schwelle ist timeframe- und regime-spezifisch" — `critical: true`
- `EXECUTION` „Der Ausbruch wird am **Schluss** der Kerze erkannt, gehandelt wird zum Schlusskurs — im Live-Pfad ist das eine Latenzannahme" — `critical: true`
- `COST` „Squeeze-Phasen haben niedrige Volatilität ⇒ R:R muss die höhere Trefferzahl ausgleichen" — `critical: false`

**`expectedRegimes`**: `["RANGE", "TREND_UP"]`

## Akzeptanzkriterien

- [ ] `validateTemplate(...)` liefert `[]`
- [ ] `requiredFields` ⊆ `RULE_FIELDS` **nach** 02-02 (also mit `bbZScore`)
- [ ] `buildRule(defaults)` → `sanitizeRuleSpec()` ohne Klemmschreiben
- [ ] **Test: `bbZScoreMin`-Default ist < 2** (verhindert die „2 σ"-Fehlannahme)
- [ ] Doc-Kommentar enthält die σ-Rechnung
- [ ] Ein Eintrag in `STRATEGY_TEMPLATES`
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** Änderung an `bollingerBandWidthPct` (02-01 hat die Parität festgeschrieben).
- Keine Bollinger-**Parameter** in der `RuleSpec` — nur Felder gegen Schwellen.
- Keine Sequenz-/Cross-Trigger (der Squeeze ist streng genommen ein
  „vorher eng, jetzt weit"-Vergleich; die Umsetzung im Snapshot-Dialekt ist eine
  bewusste **Vereinfachung** — dokumentiere sie als Annahme, statt sie zu verstecken).

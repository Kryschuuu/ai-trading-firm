# STX-02-03 — Donchian-Regelfeld (`donchianBreakoutPct`)

- **Phase:** 2 · **Paket:** 02-01, 01-01 · **Finding:** STX-18
- **Risiko:** niedrig (ein Feld, vier Stellen)

## Zweck

Donchian-Breakout ist die einzige der sieben vorgeschlagenen Strategien, die **kein**
existierendes Feld abbilden kann. Der Ausbruchsausdruck
`((close / vorheriges Kanalhoch) − 1) · 100` ist marktunabhängig und passt damit in den
bestehenden „Messwert gegen Schwelle"-Dialekt.

## Kontext

Der springende Punkt ist in 02-01 schon entschieden: `donchianChannel` liefert das Kanalhoch
der **vorletzten** `entryPeriod` Kerzen (ohne die aktuelle). Damit ist `donchianBreakoutPct`
genau der Abstand, den ein Ausbruch **am Folgetag** zurücklegen muss — kein Look-ahead.

## Auftrag

Füge **ein** Feld hinzu:

| Feld | Bedeutung | Einheit |
|---|---|---|
| `donchianBreakoutPct` | `(close / vorheriges 20-Bar-Hoch − 1) · 100` | Prozent; > 0 = über dem Kanal |

1. **`ruleFieldCatalog.ts`:** `RULE_FIELDS` + `RULE_FIELD_LABELS`.
   Das Label muss ausdrücklich sagen, dass sich der Bezug auf die **vorigen** Kerzen
   bezieht — sonst liest es sich wie ein Intraday-Wert.
2. **`RuleSnapshot`:** `donchianBreakoutPct: number | null`. `null`, wenn
   `candles.length < entryPeriod + 1` oder `upper <= 0`.
3. **`buildSnapshotFromCandles`:** aus `donchianChannel(candles)` befüllen,
   Dezimal-Stelle wie `bbwPct` (4).
4. **JSON-Schema** in `ruleEngine.ts:883` ergänzen.
5. **`indicatorCache.ts`:** `donchianUpper` in O(n) vorrechnen (laufendes Maximum über ein
   Fenster — **kein** `Math.max` über ein Slice pro Bar, das wäre wieder O(n²) und würde
   STX-12 in den Backtest-Pfad zurückbringen).

**Default-Parameter:** `entryPeriod = 20` (kanonisch). Die Periode selbst ist **kein**
Regelfeld — sie gehört in das Template (03-08), nicht in den Snapshot. Dokumentiere das.

## Akzeptanzkriterien

- [ ] **Lookahead-Test:** für ein streng monoton steigendes Series ist
      `donchianBreakoutPct > 0` erst ab der Kerze **nach** dem Kanalhoch
- [ ] **Paritätstest** wie in 02-02: Single-Rule vs. Multi-Asset identisch
- [ ] `indicatorCache` bleibt O(n) — ein Test oder ein Code-Review-Kommentar belegt, dass
      kein Fenster-`Math.max` pro Bar läuft
- [ ] `null` bei zu wenig Historie; **nie** 0
- [ ] Bestehende Multi-Asset-Ergebnisse byte-identisch
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- Keine zweite Donchian-Variante (`entryPeriod` bleibt Template-Parameter, kein Feld).
- **Keine** Änderung bestehender Felder.
- Keine Änderung an `buildIndicatorCache`-**Struktur** bestehender Felder.
- Kein Import von `src/strategies/` (existiert noch nicht / 03-01).

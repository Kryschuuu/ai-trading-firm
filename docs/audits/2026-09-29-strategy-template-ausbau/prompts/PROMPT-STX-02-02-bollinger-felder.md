# STX-02-02 — Bollinger-Regelfelder (`bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct`)

- **Phase:** 2 · **Paket:** 02-01, 01-01 · **Finding:** STX-18
- **Risiko:** mittel (drei gekoppelte Stellen + Schema + Cache)

## Zweck

`bbwPct` misst die **Breite** des Bandes, nicht die **Position** des Preises darin. Der
in der Analyse geforderte `bbZScore` existiert nicht. Damit ist „Preis bricht obere
Bandkante" derzeit nicht regelformulierbar. Dieser Prompt schließt genau diese Lücke —
und nur diese.

## Kontext — die vier gekoppelten Stellen

Ein neues `RULE_FIELDS`-Feld muss an **vier** Orten nachgezogen werden. Vergisst man
einen, ist das Feld entweder tot oder (schlimmer) in einem Pfad `undefined`:

1. `src/lib/ruleFieldCatalog.ts` — `RULE_FIELDS` **und** `RULE_FIELD_LABELS`
2. `src/lib/ruleEngine.ts` — `RuleSnapshot`-Interface **und** `buildSnapshotFromCandles`
3. `src/lib/ruleEngine.ts:~883` — JSON-Schema (LLM-Vorschläge)
4. `src/backtest/indicatorCache.ts` — `IndicatorCache` + `buildIndicatorCache` +
   `snapshotFromCache`

Punkt 4 ist der heimliche: die Multi-Asset-Backtest-Engine liest **nicht** aus
`buildSnapshotFromCandles`, sondern aus dem Cache. Wer nur 1–3 pflegt, bekommt im
Multi-Asset-Backtest `null`/`undefined` und ein **anderes** Ergebnis als im
Single-Rule-Backtest.

## Auftrag

Füge **drei** Felder hinzu, alle in Prozent/Standardabweichungen, damit sie
**marktübergreifend** sind (kein absoluter Preisvergleich):

| Feld | Bedeutung | Einheit |
|---|---|---|
| `bbZScore` | `(close − middle) / σ` der Bollinger-Bänder | dimensionslos, typisch ±0…3 |
| `priceVsUpperBbPct` | `(close − upper) / close · 100` | Prozent, ≤ 0 typisch |
| `priceVsLowerBbPct` | `(close − lower) / close · 100` | Prozent, ≥ 0 typisch |

1. **`ruleFieldCatalog.ts`:** in `RULE_FIELDS` als `"number"`, in `RULE_FIELD_LABELS` mit
   **deutschem Label und Unit im Text** (Muster `vwapPct`: „Kurs gegen …, Prozent").
2. **`RuleSnapshot`:** drei `number | null`-Felder, jeweils mit Doc-Kommentar, der das
   `null` begründet (zu wenig Historie, `middle <= 0`, `σ == 0`).
   **`σ == 0` ⇒ `bbZScore: null`.** Eine Division durch eine flache Kerzreihe ist kein
   Messwert, sie ist eine Division durch null mit Glück.
3. **`buildSnapshotFromCandles`:** aus `bollingerBands(closes)` (aus 02-01) befüllen,
   auf dieselbe Dezimal-Stelle wie die Nachbarn (`bbwPct` nutzt 4).
4. **JSON-Schema** in `ruleEngine.ts:883` um die drei Felder ergänzen, mit
   `description` und Beispielwerten.
5. **`indicatorCache.ts`:** `bbMiddle`, `bbSigma` (bzw. direkt die drei Felder) in die
   `IndicatorCache`-Struktur, in `buildIndicatorCache` in O(n) vorrechnen, in
   `snapshotFromCache` ausgeben.

## Akzeptanzkriterien

- [ ] **Paritätstest:** `tests/backtest.multiAsset.test.ts` — dieselbe Regel + dieselben
      Kerzen liefert über `backtestRule` und über `runMultiAssetBacktest` **identische**
      Feldwerte. Bestehende Multi-Asset-Ergebnisse bleiben byte-identisch, wenn kein
      Bollinger-Feld benutzt wird.
- [ ] `tests/ruleEngine.test.ts`: `null`-Fälle (zu wenig Kerzen, `σ == 0`, `middle <= 0`)
- [ ] `sanitizeRuleSpec` akzeptiert die drei Felder, `RULE_CEILINGS`-Klemmung greift
- [ ] Unbekannte Felder weiterhin verworfen
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] Kein bestehender Test angepasst, um grün zu werden

## Dokumentation

`docs/MISSIONS.md` (oder die Doku, die `RULE_FIELD_LABELS` erklärt): die drei Felder mit
Einheit und einem Beispiel-Workflow „Squeeze → Breakout".

## Gesperrt

- **Keine** Änderung der bestehenden Felder,_labels oder Werte.
- **Keine** Feld-gegen-Feld-Ausdrücke (`bbUpper > ema50`). Der Dialekt bleibt
  „Messwert gegen Schwelle" — das ist die gewollte Vereinfachung, kein Mangel.
- **Keine** Sequenz-/Trigger-Erweiterung.
- **Keine** `indicatorCache`-Refaktorierung — nur additive Felder.

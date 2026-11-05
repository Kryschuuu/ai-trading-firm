# BP-01: Regel-Engine kann vorhandene Indikatoren nicht abfragen; MACD fehlt

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-01`](../prompts/PROMPT-BP-01-rule-field-indikatoren.md)

## Verifizierte Fundstellen

- `src/lib/indicators.ts` — implementiert und getestet: `ema()`, `rsi()`,
  `atrPct()`, `adx()` (:109), `bollingerBandWidthPct()` (:54),
  `returnStdDevPct()` (:79). MACD existiert **nicht**.
- `src/lib/ruleEngine.ts:45-59` — `RULE_FIELDS`-Whitelist ohne `adx14`,
  `bbWidthPct`, `macdHist`, `macdSignal`.
- `src/lib/ruleEngine.ts:125-141` — `RuleSnapshot` ohne diese Felder.
- `src/lib/ruleEngine.ts:798-800` — `RULE_LLM_SCHEMA` leitet das Feld-Enum
  automatisch aus `Object.keys(RULE_FIELDS)` ab.
- `src/lib/adaptiveRisk.ts:507-508` und `src/lib/marketRegime.ts:368` — ADX/
  BBW/StdDev werden **nur** für das Firmen-Volatilitätsregime verwendet.

## Bewertung und Abgrenzung

Das System rechnet bereits deterministische Trend-/Volatilitätsindikatoren für
das Firmenregime, kann sie aber nicht als Regel-Bedingungen formulieren. Regeln
wie „Trendstärke-Filter’ (`adx14 > 20`), „Volatility-Squeeze’ (`bbWidthPct`
eng) oder MACD-Konfluenz sind für den Mikro-Executor heute formulierbar
nicht — genau die Filter, die Mean-Reversion- und Momentum-Setups vor
Seitwärtsrauschen schützen würden. Der Fund liegt **nicht** in neuer
Infrastruktur, sondern im Verdrahten berechneter Werte in Whitelist, Snapshot,
Ceilings und LLM-Schema.

## Konkretes Delta

- `macd()` in `indicators.ts` (EMA-Diff, Signal-Linie, Histogramm).
- `RULE_FIELDS`/`RuleSnapshot`/`buildSnapshotFromCandles` um `adx14`,
  `bbWidthPct`, `macdHist`, `macdSignal` erweitern (mit `RULE_CEILINGS`-Bounds).
- `RULE_LLM_SCHEMA`-Unit-Beschreibungen und Makro-Zyklus-Prompt-Zeilen ergänzen.
- Keine DB-Migration: Bedingungen liegen in `trade_rules.condition` (`jsonb`).

## Akzeptanzkriterien für `FIXED`

- [ ] `macd()`-Handrechnungs-Test (bekannte Serie → bekannte Werte) grün.
- [ ] neue Felder sind als `ruleEngine`-Bedingungen kompilier- und evaluierbar
      (einschl. `between`/`in`) und geklemmt.
- [ ] `buildSnapshotFromCandles()` berechnet die neuen Felder look-ahead-frei
      (nur geschlossene Kerzen).
- [ ] `RULE_LLM_SCHEMA` enthält die neuen Felder; Makro-Prompt dokumentiert
      Einheiten und Semantik.
- [ ] bestehende Regressionstests grün; Determinismus-Hash unverändert stabil.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: statische Pfad-/Symbolprüfung und Schemaabgleich.
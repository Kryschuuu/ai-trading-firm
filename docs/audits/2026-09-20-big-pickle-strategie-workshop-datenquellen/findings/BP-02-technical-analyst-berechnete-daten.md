# BP-02: Technical-Analyst-Step lässt das LLM Indikatoren schätzen

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **2–4 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-02`](../prompts/PROMPT-BP-02-technical-analyst-berechnete-daten.md)

## Verifizierte Fundstellen

- `src/cycle/steps/technicalStep.ts:75-102` — Prompt verlangt „RSI and ATR
  estimates“; deterministischer Fallback setzt `rsi: 50`, `trend: "neutral"`,
  `keyLevels: { support: 0, resistance: 0 }`.
- `src/cycle/steps/researchStep.ts:138-139` — der Research-Step konsumiert diese
  Analysen als „Technical context“.
- `src/lib/macroCycle.ts:166-168` — der Makro-Zyklus nutzt dagegen echte
  `snapshot()`/`snapshotLine()`-Werte aus Kerzen.

## Bewertung und Abgrenzung

Der Tageszyklus baut Setup-Vorschläge auf **vom LLM geratenen** Kennzahlen auf,
während derselbe Indikatoren-Bestand deterministisch aus `buildSnapshotFrom
Candles()` verfügbar ist. Das ist eine aktive Halluzinationsquelle und erklärt
Inkonsistenzen zwischen Tages- und Makro-Ergebnissen. Berührungspunkt mit
RMA-P2-03 (Multi-Timeframe-Konfluenz): berechnete Werte sind die Voraussetzung
für echte Confluence; dieses Finding deckt nur die Umstellung des Kontexts ab.

## Konkretes Delta

- Kontext aus `buildSnapshotFromCandles()` je Instrument; Key-Level
  deterministisch (rolling High/Low, ATR-Band) statt geraten; RSI/ATR-Einheiten
  im Prompt explizit markieren.
- Fallback auf real berechnete Neutrallinien statt `{0,0}`.

## Akzeptanzkriterien für `FIXED`

- [ ] gleiche Kerzen über denselben Step liefern byte-stabile Kontext-Snapshots.
- [ ] der Prompt enthält keine Aufforderung zu Schätzungen (`estimates`).
- [ ] Fallback nullfrei: keine leeren Key-Level/RSI-Werte in Artefakten.
- [ ] bestehende Cycle-Tests und GAP-08-Plausibilitätslogik bleiben grün.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: statische Prompt-/Code-Pfadprüfung.
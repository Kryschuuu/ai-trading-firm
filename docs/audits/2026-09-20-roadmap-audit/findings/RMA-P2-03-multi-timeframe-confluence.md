# RMA-P2-03: Deterministische Multi-Timeframe-Konfluenz

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-03`](../prompts/PROMPT-P2-03-multi-timeframe-confluence.md)

## Verifizierte Fundstellen

- `src/lib/analysts.ts::runTechnicalAnalyst()` — fordert Multi-Timeframe-Ausgabe vom Analysten an.
- `src/lib/marketdata/historicalStore.ts::HistoricalStore.query()` — timeframe-spezifische Historie.
- `src/cycle/steps/technicalStep.ts` — strukturierter technischer Tageszyklus.
- `src/lib/seed.ts` — Rolle als Multi-Timeframe-Analyst, aber keine deterministische Scoreformel.

## Bewertung und Abgrenzung

Mehrere Timeframes sind verfügbar und werden sprachlich vom Agenten zusammengeführt. Das Ergebnis hängt jedoch vom LLM ab; ein identischer Candle-Snapshot garantiert keinen identischen, erklärbaren Konfluenzscore.

## Konkretes Delta

- kanonische Features je Timeframe und explizite Gewichtungs-/Vetoformel
- as-of-Ausrichtung ohne Nutzung unvollständiger höherer Kerzen
- Coverage-/Staleness-/Conflict-Felder im Output
- versionierter deterministischer Konfluenzscore als Agenteninput
- Backtest-/Live-Parität und Golden Fixtures

## Akzeptanzkriterien für `FIXED`

- [ ] keine Look-ahead-Nutzung noch offener HTF-Kerzen
- [ ] identische Daten und Config ergeben identischen Score
- [ ] Konflikt zwischen Timeframes bleibt im Output sichtbar
- [ ] Agententhese darf den deterministischen Basisscore erklären, aber nicht still überschreiben

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

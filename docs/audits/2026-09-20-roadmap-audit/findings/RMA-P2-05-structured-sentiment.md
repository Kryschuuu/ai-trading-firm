# RMA-P2-05: Strukturierte Sentiment-Outputs

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–3 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-05`](../prompts/PROMPT-P2-05-structured-sentiment.md)

## Verifizierte Fundstellen

- `src/lib/analysts.ts::runNewsAnalyst()` — JSON mit View, Confidence und These.
- `src/cycle/schemas.ts::InstrumentNewsAnalysis` — normalisierte Richtung und Confidence.
- `src/cycle/steps/newsStep.ts` — News-Analyse im täglichen Zyklus.
- `src/lib/analysts.ts::recordAnalysis()` — persistiert Analyseergebnisse.

## Bewertung und Abgrenzung

Sentiment ist bereits strukturiert, statt nur Freitext zu sein. Richtung, Confidence und These reichen jedoch nicht für robuste Auswertung, Kalibrierung und zeitliche Anwendung.

## Konkretes Delta

- expliziter Forecast-Horizont und Gültigkeitsintervall
- Entity-/Instrument-IDs, Event-Typ und Quellenabdeckung
- Unsicherheit/Abstention getrennt von direktionaler Confidence
- Source-Time, Ingest-Time und stabile Deduplikation
- Outcome-Link zum Forecast-Ledger aus P3.1

## Akzeptanzkriterien für `FIXED`

- [ ] Schema validiert harte Bounds und verwirft unbekannte Felder kontrolliert
- [ ] fehlende Quellen erzeugen sichtbare Coverage statt erfundener Neutralität
- [ ] ein Forecast kann eindeutig und nur einmal einem Outcome zugeordnet werden
- [ ] alte Konsumenten erhalten eine rückwärtskompatible Darstellung

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

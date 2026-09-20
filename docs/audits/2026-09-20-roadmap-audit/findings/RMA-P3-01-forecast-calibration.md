# RMA-P3-01: Brier Score und Forecast-Kalibrierung

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **5–8 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P3-01`](../prompts/PROMPT-P3-01-forecast-calibration.md)

## Verifizierte Fundstellen

- `src/lib/analysts.ts::finiteConfidence()` — normalisiert Confidence.
- `src/db/schema.ts::agentMessages` und Analysepersistenz — Agentenausgaben sind gespeichert.
- `src/lib/journalAnalytics.ts::smoothedWinRate()` — Win-Rate-Feedback, aber kein Proper Scoring Rule.
- Repository-Suche nach Brier, Reliability Diagram und Forecast Resolution ergab keinen produktiven Evaluationspfad.

## Bewertung und Abgrenzung

Confidence und spätere Trade-Outcomes existieren an verschiedenen Stellen. Eine Trade-Win-Rate ist aber kein Forecast-Scoring: Sie bindet weder Eventdefinition, Horizont und Wahrscheinlichkeit noch Nicht-Trades und neutral gebliebene Forecasts ein.

## Konkretes Delta

- append-only Forecast-Ledger mit Target, Wahrscheinlichkeit, Horizont und As-of-Zeit
- idempotenter Outcome-Resolver ohne Look-ahead
- Brier Score/Brier Skill Score und Reliability Bins mit Mindeststichprobe
- Segmentierung nach Agent, Prompt, Asset, Horizont und Regime
- API/Artefakt für kalibrierte Evaluation einschließlich Coverage

## Akzeptanzkriterien für `FIXED`

- [ ] bekannte Fixtures liefern analytisch korrekte Brier Scores
- [ ] ein Forecast wird höchstens einmal aufgelöst
- [ ] unreife Forecasts gehen weder als 0 noch als korrekt in Metriken ein
- [ ] Bins berichten Count, mittlere Prognose, beobachtete Rate und Confidence-Intervall

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

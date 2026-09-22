# RMA-P2-05: Strukturierte Sentiment-Outputs

- **Antwort:** Ja (v1.64.0)
- **Tracking-Status:** `FIXED` (v1.64.0, PR #162)
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–3 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-05`](../prompts/PROMPT-P2-05-structured-sentiment.md)

## Verifizierte Fundstellen

- `src/lib/analysts.ts::runNewsAnalyst()` — JSON mit View, Confidence und These.
- `src/cycle/schemas.ts::InstrumentNewsAnalysis` — normalisierte Richtung und Confidence.
- `src/cycle/steps/newsStep.ts` — News-Analyse im täglichen Zyklus.
- `src/lib/analysts.ts::recordAnalysis()` — persistiert Analyseergebnisse.

## Bewertung und Abgrenzung

Sentiment ist nun vollständig als kalibrierbarer Forecast-Envelope implementiert (`StructuredSentimentForecast`, `sentiment@1`). Richtung, Confidence und These bleiben für bestehende Konsumenten abgeleitet erhalten, während nun strikte Zeithorizonte, probabilistische Bounding, Syndikationsschutz, echte Enthaltung (`ABSTAIN`) und P3.1-Outcome-Verknüpfung gewährleistet sind.

## Konkretes Delta

- expliziter Forecast-Horizont und Gültigkeitsintervall (`validUntil = asOf + horizon`)
- Entity-/Instrument-IDs, Event-Typ und Quellenabdeckung
- Unsicherheit/Abstention getrennt von direktionaler Confidence (`coverage` vs. `probability`)
- Source-Time, Ingest-Time und stabile Syndikations-Deduplikation
- Outcome-Link zum Forecast-Ledger aus P3.1 (ohne Preisspeicherung)

## Akzeptanzkriterien für `FIXED`

- [x] Schema validiert harte Bounds und verwirft unbekannte Felder kontrolliert
- [x] fehlende Quellen erzeugen sichtbare Coverage statt erfundener Neutralität
- [x] ein Forecast kann eindeutig und nur einmal einem Outcome zugeordnet werden
- [x] alte Konsumenten erhalten eine rückwärtskompatible Darstellung

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

## Umsetzung (v1.64.0)

- **Modul `src/sentiment/` (Code-Version `sentiment@1`):**
  - Strikte Envelope-Typen (`StructuredSentimentForecast`, `StructuredSentimentEnvelopeInput`)
    mit kanonischen Instrument-/Entity-IDs (`BINANCE:BTCUSDT`), Richtungen (`BULLISH`, `BEARISH`, `NEUTRAL`, `null`),
    Wahrscheinlichkeit $p \in [0.01, 0.99]$, Horizonten (`4h`, `24h`, `72h`), Event-Typen und
    Coverage/Unsicherheitsmaßen.
  - Fail-closed Trennung: Echte Enthaltung (`status: "ABSTAIN"`) bei fehlenden oder veralteten Quellen mit
    `coverage: 0` und `probability: null` (nie künstliche Neutralität 0.5).
  - Syndikations-Deduplikation (`deduplicateNewsSources`): Bereinigung von Feed-Tags, Content-Fingerprinting
    (SHA-256) und Paraphrasen-Erkennung (Token-Jaccard $\ge 0.80$ im 24h-Fenster). Mehrfachmeldungen
    erhöhen `syndicationCount`, nicht `sourceCount`.
  - Multi-Entity-Isolation: Übergreifende Schlagzeilen werden allen betroffenen Entitäten isoliert
    mit separater `forecastId` zugeordnet.
  - Deterministische Identität: `forecastId` (`sf1:<sha256>`), `sourceDeduplicationHash` (`sd1:<sha256>`)
    und `contentHash` (`sc1:<sha256>`).
  - Outcome-Link zum P3.1-Ledger (`buildP31ForecastPayload`): Speichert weder aktuellen Preis noch
    späteres Marktergebnis; Resolution erfolgt zeitgetrennt im Ledger.
- **Persistenz & Migration:**
  - Idempotente Migration `drizzle/2026-09-22_structured_sentiment.sql` für Tabelle `sentiment_forecasts`.
  - Append-only mit `ON CONFLICT (forecast_id) DO NOTHING`.
  - DB CHECK-Constraints für Wahrscheinlichkeitsgrenzen, Zeit-Invariante (`valid_until > as_of`)
    und Status-Konsistenz (`ABSTAIN` erzwingt `probability IS NULL` und `direction IS NULL`).
- **Zyklus & Analysten-Integration:**
  - `src/cycle/steps/newsStep.ts`: Angereichert um strukturierte Envelope-Generierung und Syndikations-Deduplikation.
  - `src/lib/analysts.ts`: `runNewsAnalyst` und `recordAnalysis` erzeugen strukturierte Forecasts,
    während bestehende Felder (`sentiment`, `confidence`, `summary`, `riskFlags`) rückwärtskompatibel erhalten bleiben.
  - `STRUCTURED_SENTIMENT_ENABLED` Schalter für unterbrechungsfreien Rollback.
- **API:**
  - `GET /api/analysis/sentiment`: Read-only-Zugriff mit Validierung von `entityId`, `status`, `horizon`,
    `from`, `to`, `limit` (max. 200) und `Cache-Control: no-store`.
- **Test-Suite (35 neue Tests):**
  - `tests/sentiment.unit.test.ts` (20 Tests): Deduplikation, Multi-Entity, NEUTRAL vs. ABSTAIN, Wahrscheinlichkeiten,
    PIT-Invarianz, Injection-Schutz, P3.1-Link, Schema-Bounds.
  - `tests/sentiment.db.test.ts` (5 Tests): Embedded Postgres Migration, Roundtrip, Idempotenz, CHECK-Constraints, Filter.
  - `tests/sentiment.cycle.test.ts` (3 Tests): newsStep, Fallback-Envelopes, riskStep Konsum.
  - `tests/sentiment.api.test.ts` (7 Tests): GET-Endpunkt, Statuscodes, Parameter-Validierung, Cache-Control.

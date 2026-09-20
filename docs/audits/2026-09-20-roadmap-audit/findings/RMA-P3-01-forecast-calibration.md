# RMA-P3-01: Brier Score und Forecast-Kalibrierung

- **Antwort:** Nein
- **Tracking-Status:** `FIXED`
- **Fix-Version:** `v1.55.0`
- **PR:** [#152](https://github.com/Kryschuuu/ai-trading-firm/pull/152) · Commit `c7f9c50`
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

- [x] bekannte Fixtures liefern analytisch korrekte Brier Scores —
  `tests/forecastScoring.test.ts` (35 Tests: perfekt ⇒ 0, uninformiert 0.5 ⇒
  0.25, sicher-falsch ⇒ 1, kategorial `[0,2]`, BSS gegen Klimatologie,
  Log Loss ε-Klemmung, Wilson exakt an den Rändern).
- [x] ein Forecast wird höchstens einmal aufgelöst —
  `tests/forecastLedger.db.test.ts` + `tests/forecastResolver.test.ts`
  (Idempotenzschlüssel `fo1:<sha256>`, identischer Outcome-Hash ⇒ no-op,
  abweichend ⇒ neue Version; Cursor rückt nur ohne Truncation vor).
- [x] unreife Forecasts gehen weder als 0 noch als korrekt in Metriken ein —
  `PENDING`/`VOID` sind aus Scores ausgeschlossen, zählen aber in Coverage;
  PIT-Filter `fetchedAt <= availabilityDeadline` in
  `tests/forecastResolver.test.ts` belegt (keine Post-Cutoff-Daten).
- [x] Bins berichten Count, mittlere Prognose, beobachtete Rate und
  Confidence-Intervall — Reliability-Bins mit Wilson-95-Intervall je Bin,
  geprüft u. a. in `tests/forecastScoring.test.ts` und End-to-End im
  Scorebericht (`tests/forecastService.test.ts`).

## Behebung (v1.55.0)

- **Umsetzung:** `src/forecasts/` (Vertrag, Capture-Hook, Ledger, Resolver,
  Scoring, Service), Migration `drizzle/2026-09-20_forecast_ledger.sql`
  (append-only, idempotent), APIs `/api/firm/forecasts*`, Audit-Katalog,
  Telemetrie, `docs/FORECASTS.md`.
- **Abweichung vom Audit-Stand:** Basis `df3163e`/v1.51.1 war im Clone nicht
  auflösbar; Umsetzung erfolgte auf v1.54.0 mit dem etablierten
  Feature-Store-/Perp-Data-Muster (minimale Scope-Abweichung, dokumentiert
  im CHANGELOG-Eintrag v1.55.0 und in `docs/FORECASTS.md`).
- **Testevidenz:** 98 neue Forecast-Tests grün (89 rein + 9 gegen
  eingebettetes Postgres); Gesamtsuite 2803 Tests / 0 fail;
  `npm run typecheck`, `npm run lint` (0 errors), `npm run docs:validate` grün.

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

# GAP-07 — Datenqualitäts-Layer & Multi-Timeframe-Konsistenz

**Nutzen:** ★★★★ · **Aufwand (Co-Audit):** 🔧🔧 · **Aufwand (verifiziert):** 🔧🔧
**Kategorie:** Fundament · **Prompt:** [`PROMPT-07`](../prompts/PROMPT-07-data-quality-multi-timeframe.md)

## Befund (Co-Audit)

„Garbage in, garbage out“ gilt für LLM-Agenten doppelt — eine falsche Candle
produziert eine überzeugend formulierte Fehlentscheidung. Zweite Datenquelle
kostet Rate-Limits; zu aggressive Filter verwerfen echte Flash-Moves.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- MDERR-Fehler-Taxonomie mit strukturierten Logs/Metriken/Fehler-Manifest
  (`src/marketdata/dataErrors.ts`, `docs/OBSERVABILITY.md`); leere Kerzen-
  Antworten zählen seit v1.40.0 als `DATA_UNAVAILABLE` (nicht stiller Erfolg).
- History timeframe-dimensioniert (`instrumentId+timeframe+ts`, MDSYNC-001);
  explizite Stale-Fallback-API (`getCandlesWithFallback`); Sync-CLI mit Gates.
- **Aber:** keine Gap-Detection in Serien, kein Outlier-/Wick-Filter, keine
  deterministische 1h→4h/1d-Aggregation, kein Cross-Check gegen Zweitquelle.

## Delta

1. Qualitätsprüfungen beim Schreiben/Lesen: Gap-Detection, Outlier-Filter
   (Schwelle ATR-orientiert; echte Flash-Moves bleiben erhalten — Schwelle
   dokumentiert), Plausibilität (non-positive OHLC, high<low, Duplikate);
   Befunde klassifiziert ins MDERR-System + Report je Instrument.
2. Stale-Data-Guard pro Instrument/Timeframe mit konfigurierbaren Schwellen.
3. Multi-TF-Aggregation 1h→4h/1d deterministisch (UTC-Anker, unvollständige
   Kerze wird nie aggregiert), Konsistenz-Checks (high/low-Envelope).
4. Zweitquellen-Cross-Check feature-flag-gated, **Default off**
   (Rate-Limits), fail-soft.

## Akzeptanzkriterien (kurz)

Gap-/Outlier-/Plausibilitätstests (inkl. „echter Flash-Crash wird nicht
gefiltert“), Aggregations-Determinismus + unvollständige-Kerze-Test,
Stale-Guard-Test, Flags in CONFIGURATION.md/.env.example.

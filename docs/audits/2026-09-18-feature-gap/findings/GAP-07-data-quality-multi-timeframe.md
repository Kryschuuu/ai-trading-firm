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

## Umsetzung (v1.47.0, 2026-09-19, Branch `arena/01a0b751-ai-trading-firm`)

- **D1 — Qualitätsprüfung** (`src/marketdata/quality.ts`,
  `validateCandleSeries()`): Klassen `GAP` (Befund an der ersten fehlenden
  Position, exakter Intervall-Abstand = kein Befund), `OUTLIER` (Wick/Körper
  **streng** > `MARKETDATA_OUTLIER_ATR_MULT` × leave-one-out-TR-Baseline,
  Default 25, Bounds [5, 200]), `INVALID` (OHLC ≤ 0, `high < low`, close
  außerhalb `[low, high]`), `DUPLICATE` (ts doppelt). Neue MDERR-IDs
  `QUALITY_GAP`/`QUALITY_OUTLIER`/`QUALITY_INVALID`/`QUALITY_DUPLICATE`
  (+ `QUALITY_CROSSCHECK`) in der geschlossenen Taxonomie
  (`src/lib/marketDataErrors.ts`), nie retryable, nie im Fetch-Backoff.
  Befunde: Report je Instrument (`data/marketdata/quality-report.json` via
  `resolveRuntimePath`, atomar 0600) + Log-Zeile (Zähler, keine Symbole) +
  Metrik `market_data_quality_findings_total{class}`. Lesepfad-Modi
  `MARKETDATA_QUALITY_MODE`: `log` (Default, nur sichtbar) | `strict`
  (fail-closed: INVALID ⇒ `DATA_UNAVAILABLE` über die bestehende
  Stale-Fallback-Kette; verdrahtet in `scripts/run-scan.ts` +
  `ScannerService.refresh`). **Historie-Dateien werden nie mutiert**
  (Freeze-Tests); `QUALITY_*` fließt nie ins Fetch-Fehler-Manifest
  (log-Semantik), `degraded`/Exit-Code im log-Modus entkoppelt.
- **D2 — Stale-Guard** je Instrument/Timeframe: Schwellen
  `MARKETDATA_STALE_1H_HOURS` (26, [2,168]) / `_4H_` (104, [8,672]) /
  `_1D_` (624, [48,4032]); Ausweis als **Zähler** im Sync-Status
  (`staleSeries`/`staleByTimeframe`, keine Symbole — Security-Policy).
- **D3 — Aggregation** (`src/marketdata/aggregate.ts`): 1h→4h/1d
  deterministisch, UTC-Anker (4h: 00/04/08/12/16/20, 1d: 00:00 UTC),
  OHLCV-Korrektur, **unvollständige Bucket NIE aggregiert** (partial),
  Zeitmaske (nur abgeschlossene Perioden ≤ now), Konsistenz-Check
  (Envelope/OHLC/Volumen). `MARKET_SYNC_AGGREGATE`/`--aggregate`
  (Default off): Aggregat als **neue** Timeframe-Reihe
  (`feed: "agg:1h"`), 1h-Quelle unangetastet.
- **D4 — Cross-Check** (Interface + Vertrag, **Default off**): optionale
  Methode `getCrosscheckCandles()` am `MarketDataAdapter`
  (Adapter-Registry-Muster), `MARKETDATA_CROSSCHECK` +
  `MARKETDATA_CROSSCHECK_TOLERANCE_PCT` (1, [0.1,10]); Abweichung > Toleranz
  ⇒ `QUALITY_CROSSCHECK`-Befund + Log. **Keine neue Venue-Anbindung** in
  diesem PR — ohne Implementierung no-op (Test: kein Zweitquellen-Request).

**Tests:** `test/marketdata/quality.test.ts` (35: GAP-Grenzen, INVALID,
Flash-Move-Schutz inkl. exaktem Grenzwert, DUPLICATE, Determinismus,
Freeze-Immutabilität, Report-Roundtrip, strict ⇒ DATA_UNAVAILABLE,
Stale-Guard mit Fake-Clock, Cross-Check, Config-Bounds, Metrik,
Sync-Integration log/strict/Cross-Check on/off), `test/marketdata/aggregate.test.ts`
(14: UTC-Anker, OHLCV-Handrechnung, Envelope, Partial, Zeitmaske,
Determinismus, Freeze, Vertrag), `test/marketdata/cli.test.ts`
(`--aggregate`). Pflicht-Checks: typecheck + lint + test + docs:validate
grün (Zahlen im PR).

**Offene Punkte (bewusste Abgrenzung, Scope-Disziplin):**

- Keine echte zweite Venue-Quelle für den Cross-Check angehängt — Interface,
  Flag und Toleranz sind ready; ein zweiter Public-Adapter (z. B. Binance
  Klines) wäre ein eigener Schritt (Rate-Limit-Budget pro Venue).
- Aggregierte 4h/1d-Reihen sind **zusätzliche** Timeframes im Store; der
  Scanner wertet weiterhin nur `1h` aus (Analyse-SSoT) — ein Konsument für
  die aggregierten Reihen (z. B. Backtest auf 4h) ist offen.
- Stale-Guard-Zähler sind pro **Venue** (Zähler, keine Symbole) im
  Sync-Status; eine per-Instrument-Sicht (welche Reihe ist stale?) steht im
  Qualitäts-Report-Kontext bzw. im Store selbst und ist bewusst nicht als
  Symbol-Liste in den Status persistiert (Security-Policy).

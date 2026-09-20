# RMA-P6-01: Point-in-Time Feature Store

- **Antwort:** Ja (seit v1.53.0)
- **Tracking-Status:** `FIXED`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 7–12 PT)
- **Umsetzungs-Prompt:** [`PROMPT-P6-01`](../prompts/PROMPT-P6-01-point-in-time-feature-store.md)
- **Fix:** PR [#150](https://github.com/Kryschuuu/ai-trading-firm/pull/150), Commit `2bf46c8`, Fix-Version **v1.53.0**, Branch `arena/01a0bfb1-ai-trading-firm`

## Verifizierte Fundstellen

- `src/lib/marketdata/historicalStore.ts::HistoricalStore` — Rohkerzen nach Instrument/Timeframe mit Provenance.
- `src/lib/marketdata/historicalStore.ts::HistoricalCandleEntry` — Eventzeit und Fetch-Provenance.
- `src/scanner/artifacts.ts` und `src/cycle/artifacts.ts` — versionierte Ergebnisartefakte.
- Kein Feature-Registry-/Materialisierungs-/As-of-Join-Modul gefunden.

## Bewertung und Abgrenzung

Der Historical Store liefert ein gutes Rohdatenfundament. Er speichert aber keine Featuredefinition, keinen Berechnungszeitpunkt und keine Verfügbarkeitssemantik; dadurch ist eine Look-ahead-sichere Wiederverwendung berechneter Features nicht garantiert.

## Konkretes Delta

- Feature-Registry mit Name, semantischer Version, Schema und Code-/Config-Hash
- Werte mit Entity, `event_time`, `available_at`, `computed_at` und Provenance
- idempotente Batch-/inkrementelle Materialisierung
- Point-in-Time-Join API, die nur `available_at <= as_of` zulässt
- Offline-/Online-Paritätschecks, Retention und Backfill-Manifest

## Akzeptanzkriterien für `FIXED`

- [x] synthetischer verspäteter Datensatz beweist Schutz gegen Look-ahead —
  Test „Point-in-Time / Look-ahead“ (`tests/featureStore.test.ts`): eine
  nachgelieferte Kerze (Ingestion 26 h nach ihrer Eventzeit) ist bei
  `asOf` vor der Ingestion **unsichtbar** und danach sichtbar;
  `targetTime > asOf` ⇒ `INVALID_TARGET`/HTTP 400. Die zusätzliche
  SQL-Vorfilterung `event_time <= target AND available_at <= as_of` ist im
  DB-Test „As-of-Filter greift im SQL-Pfad“ gegen die echte Engine belegt.
- [x] gleicher Feature-Key und gleiche Version sind idempotent —
  Idempotency-Key `fm1:<sha256>` in `materializationRunKey()`
  (`src/features/materialize.ts`); Replay statt Doppelwrite in
  `commitRun()` (`src/features/store.ts`, `onConflictDoUpdate` auf
  `idempotency_key`, Werte via `onConflictDoNothing`) und im Speicherport.
  Tests: „Erneuter Lauf (Replay) schreibt keine Werte“, „Retry mit
  identischem Key ersetzt das Manifest, nicht die Historie“ (DB),
  „Idempotenz: Replay ⇒ 1 Manifest, 90 Werte, gleiche Run-ID“ (DB).
- [x] Definitionen sind immutable; Änderungen erzeugen neue Version —
  `FeatureRegistry.create` wirft `FEATURE_DEFINITION_IMMUTABLE`,
  `DrizzleFeatureStore.registerDefinitions` wirft `definition:immutable`
  (DB-Test mit abgelehnter Semantikänderung, keine Zeile geschrieben);
  Fingerprints `fc1`/`fg1`/`fd1` in `definitionHashOf()`.
- [x] Abfrage ist begrenzt, indexiert und berichtet Missingness explizit —
  `runPitQuery()` (`src/features/pitQuery.ts`): 200 Entities / 25 Features /
  2000 Ergebniszeilen / 20 000 Quellzeilen, `FEATURE_PIT_SOURCE_TRUNCATED`
  statt stiller Kürzung, Status `OK`/`NULL_VALUE`/`MISSING` mit
  `value: null` + Grund und der Invariante `matched + missing = requested`;
  Index `feature_values_pit_idx` (DB-Test prüft Indexexistenz **und** den
  Abfrageplan).

## Umsetzung (v1.53.0)

- Module: `src/features/{types,validate,registry,definitions,compute,materialize,ports,store,pitQuery,parity,service,adapters,sourceQuality,index}.ts`
- Schema/Migration: `src/db/schema.ts` (fünf Tabellen) + `drizzle/2026-09-20_feature_store.sql` (append-only, idempotent)
- APIs: `GET /api/firm/features` (Definitionen, Abdeckung, Läufe, Revisionen), `GET /api/firm/features/values` (PIT)
- Betrieb: `npm run features:materialize|status|parity` (`scripts/feature-materialize.ts`)
- Slice: `scanner.rsi@1`, `scanner.atr@1`, `scanner.atr_band@1`; Formeln geteilt mit `src/scanner/factors/{rsi,atr}.ts`
- Tests: `tests/featureStore.test.ts` (24), `tests/featureStore.db.test.ts` (7, echte PG via embedded-postgres), `tests/helpers/featureStoreMemory.ts`
- Doku: `docs/FEATURE_STORE.md`, `CHANGELOG.md` `[1.53.0]`

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

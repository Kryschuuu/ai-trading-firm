# RMA-P2-02: Perpetual-Daten: Funding, OI und Liquidationen

- **Antwort:** Ja (seit v1.54.0)
- **Tracking-Status:** `FIXED`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 5–8 PT)
- **Fix:** PR [#151](https://github.com/Kryschuuu/ai-trading-firm/pull/151), Commit `985b0a8`, Fix-Version **v1.54.0**, Branch `arena/01a0c032-ai-trading-firm`
- **Umsetzungs-Prompt:** [`PROMPT-P2-02`](../prompts/PROMPT-P2-02-perpetual-data.md)

## Verifizierte Fundstellen

- `src/scanner/types.ts::DerivativeContext` — Funding- und Open-Interest-Felder.
- `src/scanner/factors/funding.ts::fundingFactor` und `src/scanner/factors/openInterest.ts::openInterestFactor` — Faktoren mit neutralem Missing-Fallback.
- `src/lib/funding.ts::FundingAccrualEngine.dueAccruals()` und `runFundingAccrual()` — Funding-Ledgerlogik.
- `src/contracts/broker.ts::BrokerAdapter` — kein normalisierter historischer Perp-Marketdata-Port.

## Bewertung und Abgrenzung

Downstream-Faktoren und Funding-Buchhaltung sind implementiert. Es gibt aber keine verlässliche End-to-End-Ingestion samt historischer Ablage; Liquidationen sind weder im kanonischen Context noch als Zeitreihe modelliert.

## Konkretes Delta

- adapterübergreifender Vertrag für Funding, OI und Liquidationsereignisse
- normalisierte Einheiten, Vorzeichen, Venue/Symbol-Mapping und Event-/Available-Time
- idempotente historische Persistenz, Backfill und inkrementeller Sync
- Staleness-, Gap-, Outlier- und Cross-Venue-Checks für Perp-Daten
- as-of-Abfrage für Scanner, Backtest und Agenten

## Akzeptanzkriterien für `FIXED`

- [x] keine Vermischung von Contract-, Base- und Quote-Einheiten — `unit`
      `fraction_per_interval` je Funding-Zeile, `basis` als autoritative OI-Größe
      mit `converted`-Markierung für Ableitungen (DB-CHECK erzwingt die Kopplung,
      `tests/perpPipeline.db.test.ts`); Umrechnung ohne bekannte Kontraktgröße
      oder ohne Währungscode wird nicht geraten, sondern qualifiziert abgewiesen.
- [x] Backfill plus Live-Sync erzeugt keine Duplikate — `UNIQUE` auf dem
      natürlichen Schlüssel, `ON CONFLICT DO NOTHING`, Lauf-Idempotenz
      (`prk1:<sha256>`, Replay schreibt 0 Zeilen), Zähler
      `stats[*].duplicates`; geprüft gegen echte Postgres inkl.
      Gruppenabfrage „kein Schlüssel doppelt“ und Wasserstand nach
      Prozessneustart.
- [x] Backtest liest ausschließlich Daten, die zum Simulationszeitpunkt
      verfügbar waren — as-of-Pfad filtert `event_time <= asOf` **und**
      `available_at <= asOf` (SQL und defensive Zweitstufe), der
      Funding-Rate-Provider liest bis `toMs`, `replayPositionFunding` zählt
      `hiddenRows` für Sätze, die erst danach bekannt wurden.
- [x] fehlende/stale Perp-Daten werden als unavailable statt Null behandelt —
      `availability` + `reason` je Reihe (`MISSING`/`STALE`/`UNSUPPORTED`/
      `UNAVAILABLE`/`ALL_ROWS_UNATTESTABLE`), API antwortet 503 bei
      Ablageausfall statt 200 mit leerer Liste, Derivatwerte bleiben `null`;
      `perpRowIsAttestable` hindert eine angezweifelte Zahl daran, in Signal,
      Replay oder Artefakt zu werden.

## Umsetzung (v1.54.0)

- Module: `src/perpdata/{types,config,capabilities,normalize,ports,port,errors,store,memoryStore,quality,query,sync,consumers,replay,derivativeCache,registry,service,index}.ts`
- Adapter: `src/perpdata/adapters/bitunix.ts` (nur `BitunixPublicClient`,
  `get_funding_rate_history` + Funding-Snapshot für Raster/Bounds) und
  `src/perpdata/adapters/fixture.ts` (Venue `SIM`, fehlbare Kanten)
- Schema/Migration: `src/db/schema.ts` + `drizzle/2026-09-20_perpetual_data.sql`
  (fünf Tabellen, append-only, idempotent)
- APIs: `GET /api/marketdata/perpetual/series` (as-of), `GET
  /api/marketdata/perpetual/status` (Betriebsbild, Ablagestatus als Teil der Antwort)
- Betrieb: `npm run perp:sync` / `perp:sync:status` / `perp:sync:fixture`
  (`scripts/perp-sync.ts`), Artefakte `data/perpdata/{quality-report,derivatives}.json`
- Konsumenten: `perpDerivativeProvider` (Scanner-Faktoren),
  `createPerpFundingRateProvider` (Backtest + Paper-Funding-Engine),
  `perpAnalystSnapshotLines(FromCache)`, `run-scan`/`run-backtest`-Verdrahtung
- Tests: `tests/perpPipeline.{normalize,sync,db,consumers,security,cli}.test.ts`
  (95 Tests, davon `db` gegen embedded Postgres), Helpers in
  `tests/perpPipeline.helpers.ts`
- Doku: `docs/PERPETUAL_DATA.md`, Verweise in `MARKET_DATA_PIPELINE.md` §15,
  `BITUNIX.md`, `OBSERVABILITY.md` §2.2, `BACKTESTING.md` §3.1,
  `PAPER_TRADING.md` §3.4, `CONFIGURATION.md`, `.env.example`; `CHANGELOG.md` `[1.54.0]`

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`. **Abweichung:**
  `df3163e` ist in diesem Repository nicht auflösbar; Umsetzung und Tests stehen
  auf `83935e9` (v1.53.0) — inklusive des seit v1.53.0 vorhandenen Point-in-Time
  Feature Stores, dessen Zeitachsen-/Idempotenz-/Quality-Muster wiederverwendet
  wurden, statt eine Parallelvariante zu bauen.
- Nicht belegt: Live-Smoke-Test gegen den Bitunix-Endpunkt (die
  Bearbeitungsumgebung hat keinen ausgehenden Netzwerkzugriff); Mapping gegen
  API-Doku und Fixture-/Contract-Tests geprüft, erster Produktivlauf mit
  `--dry-run` nach Merge empfohlen.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

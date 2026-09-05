# Task 04 — Implementierungsplan: Deterministischer Markt-Scanner, Market Score & Trichter

**Umfang:** 14 Faktor-Module · Volatility-Regime · gewichteter Market Score ·
Trichter (10.000 → 2.000 → 500 → 100 → 20–40 Deep) · Weekly-Klassifikation ·
Artefakte · 3 read-only API-Routen · Benchmark · Docs.

## RECON-Ergebnis (Pfadabweichungen, verbindlich)

| Erwartung aus dem Task | Realität im Repo | Konsequenz |
| --- | --- | --- |
| Root `README.md` | existiert **nicht**, Doku unter `docs/README.md` | Doku-Index dort ergänzen |
| `universe/`-Modul | `src/universe/` (Task 01 **gemerged**) — `MarketInstrument` mit 20 Feldern + `id` | **Kein** Duplikat-Contract; Unabhängigkeitsklausel greift **nicht** |
| `marketData`-Modul | zweigleisig: Legacy `src/lib/marketData.ts` **und** Task-03-Schicht `src/lib/marketdata/` (`MarketSnapshot`, `MarketCandle`, `HistoricalStore`) | Scanner nutzt `MarketCandle` aus `src/lib/marketdata/types.ts` |
| `paper`-Modul | `src/brokers/paper.ts` + `src/lib/marketdata/simulator.ts` | nur lesend referenziert, nicht angefasst |
| Task 05 (Portfolio Analytics) | existiert **nicht** | Korrelationsmathematik lokal in `src/scanner/factors/correlation.ts` (Pearson + Spearman), dokumentiert als späterer Umzugskandidat |
| Feldnamen | camelCase (`assetClass`, `volume24h`, `makerFee`) statt snake_case aus der Aufgabenstellung | Repo-Konvention gewinnt (siehe Mapping-Tabelle in `docs/DAILY_WEEKLY_RESEARCH.md`) |

Bestehende Bausteine, die wiederverwendet werden: `createRng`/`normalizeSeed`
(`src/lib/marketdata/prng.ts`, nur für den Benchmark-Generator), NDJSON-/atomare
Schreibmuster aus `src/universe/store.ts`, Fehler-Contract + `publicErrorMessage`,
`clampPage`/`clampPageSize` aus `src/universe/validation.ts`.

## Architektur

Neues Modul **`src/scanner/`** — rein deterministisch, read-only:

```
src/scanner/
  types.ts            Factor-Interface, FactorValue, ScanInput, Breakdown (TSDoc)
  math.ts             gemeinsame Numerik (log returns, EMA, Wilder-RMA, clamp, roundTo)
  config.ts           versionierte Konfiguration + Validierung + Loader
  scanner.config.json Defaults (Gewichte, Trichter, Regime-Schwellen, Filter)
  cache.ts            Faktor-Cache (Instrument × Faktor × Datenversion)
  factors/*.ts        14 Faktor-Module + index.ts (Registry)
  regime.ts           LOW / NORMAL / HIGH / EXTREME
  ranker.ts           gewichteter Market Score + Breakdown
  filters.ts          Liquidity-/Tradability-/Risk-Filter mit Regel-IDs
  funnel.ts           scanned → eligible → interesting → daily → deep (Diversifikation)
  weekly.ts           CORE / ROTATION / DISCOVERY / EXCLUDED + JSON-Validierung
  artifacts.ts        artifacts/YYYY-MM-DD/universe.json (atomar, stabile Key-Reihenfolge)
  pipeline.ts         Orchestrierung (scanUniverse)
  service.ts          Prozess-Singleton für die API (Artefakt-Cache, injizierbar)
  index.ts            öffentliche API
src/app/api/universe/{daily,weekly,score/[instrumentId]}/route.ts
```

**Determinismus:** kein `Math.random`, kein `fetch`, kein `node:http(s)`, kein LLM-Import
(Architektur-Test). Uhr wird injiziert (`asOf`). Alle Ausgabewerte werden auf 10 Dezimalen
gerundet (`roundTo`), damit Score/Breakdown byte-identisch reproduzierbar sind.

**Score-Gewichte (Config-Version 1, Summe = 1.0, per Test erzwungen):**
Liquidity 0.25 · Volatility 0.15 · Trend 0.15 · Momentum 0.10 · Spread 0.10 ·
Volume 0.10 · Correlation 0.05 · News 0.05 · Execution 0.05.
Die übrigen 5 Faktoren (ATR, RSI, Drawdown, Funding, Open Interest) sind
**Diagnose-Faktoren**: sie fließen in Filter, Regime, Stops und Weekly-Klassifikation,
nicht in die 9 Score-Komponenten.

## Umsetzungsschritte (Conventional Commits `(task-04)`, ≥ 5)

1. `feat(scanner): factor-modules` — types/math/config/cache + 14 Faktoren + Regime.
2. `feat(scanner): ranker+weights` — Market Score, Breakdown, Gewichts-Validierung.
3. `feat(scanner): funnel` — Filter, Trichter, Diversifikationsregel, Pipeline + Cache.
4. `feat(scanner): weekly-classification+artifacts` — Weekly-Review, Artefakte, API, Service.
5. `docs(scanner): …` — MARKET_UNIVERSE.md, DAILY_WEEKLY_RESEARCH.md, help-JSON,
   CHANGELOG, SECURITY_AUDIT-Kapitel.

## Tests

`tests/scanner.factors.test.ts` (Golden-Werte je Faktor + Edge Cases: leer, konstant,
NaN, Einzelwert), `scanner.ranker.test.ts` (Gewichtssumme, Breakdown-Konsistenz,
Determinismus, Regime-Schwellen), `scanner.funnel.test.ts` (Reihenfolge, Limits,
Diversifikation, Konfig-Wirkung), `scanner.weekly.test.ts` (Klassen + JSON-Schema +
Artefakte), `scanner.api.test.ts` (Contract, Query-Limits), `scanner.benchmark.test.ts`
(10.000 synthetische Instrumente, Assertion < 15 min + Log),
`scanner.architecture.test.ts` (Import-Scan: kein LLM, kein Netzwerk, kein `Math.random`).
Coverage-Skript: `npm run test:coverage:scanner` (Ziel ≥ 90 % neuer Code).

## Sicherheits-Leitplanken

Read-only (keine Registry-Mutation, keine Order), Query-Limits (`pageSize` ≤ 200,
`instrumentId` regex-validiert, Level-Enum), keine Secrets, Artefakt-Schreiben nur
über explizite Pipeline-Aufrufe in ein konfiguriertes Verzeichnis, Fehlermeldungen
über `publicErrorMessage` redigiert.

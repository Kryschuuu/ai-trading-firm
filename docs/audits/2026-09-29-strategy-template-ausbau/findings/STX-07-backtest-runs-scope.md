# STX-07 — `backtest_runs.instrument_id NOT NULL` blockiert Universe-Runs

- **ID:** STX-07
- **Severity:** MEDIUM
- **Bereich:** Persistenz
- **Quelle:** Ausbaudokument §4.2
- **Status:** FIXED — bestätigt im Abgleich 2026-10-03 (05-03, `211e022` PR #206; Runner/CLI 05-04, `v0.9.0`)
- **Datei(en):** `src/db/schema.ts:226`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — unverändert bestätigt
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/db/schema.ts:3286` `strategyScreeningRuns` und `:3317` `strategyMarketResults`, mit CHECKs `run_kind`, `status`, `counts` und Hash-Format `^ssr1:[0-9a-f]{64}$`
- `src/db/schema.ts:230` — `backtestRuns.instrumentId` ist weiter `text("instrument_id").notNull()`; `backtest_runs` **unverändert**
- `drizzle/2026-10-01_strategy_screening.sql` vorhanden; Runner `src/screening/runner.ts`, Adapter `src/screening/backtestAdapter.ts`
- Tests `screening.{priority,matrix,runner,backtestAdapter,keys}` + `strategyScreening.keys` ausgeführt: **grün**
- **Nicht verifizierbar:** `tests/strategyScreening.db.test.ts` (PostgreSQL fehlt) — DB-Idempotenz unter parallelem Retry laufzeitseitig ungeprüft

## Beschreibung

Die Candidate Matrix erzeugt Läufe über (Strategie × Instrument × Timeframe). Die
persistierbaren Cross-Sectional- und Multi-Asset-Läufe brauchen einen **universen**- oder
**portfolio**-Scope. `backtest_runs` ist single-instrument konstruiert.

## Beweis

```ts
export const backtestRuns = pgTable("backtest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  instrumentId: text("instrument_id").notNull(),   // ← kein universe-scope
  timeframe: text("timeframe").notNull(),
  fromTs: …, toTs: …,
  paramsJson: jsonb, metricsJson: jsonb, windowsJson: jsonb,
  idempotencyKey: text("idempotency_key"),
  …
});
```

Ein synthetisches `instrumentId = "__UNIVERSE__"` würde die CHECK-Semantik, die
Idempotenz-Hashes und alle Consumer (`/api/firm/backtests`, `backtestStep`) verfälschen.

## Remediation

`backtest_runs` **nicht** verbiegen. Stattdessen eine Screening-Ebene darüber:

- `strategy_screening_runs` (Lauf-Metadaten: `candidate_set_hash`, `as_of`, `code_version`,
  `data_version`, `status`, `created_at`)
- `strategy_market_results` (je Zelle: FK auf Screening-Run, `strategy_version_id`,
  `instrument_id`, `timeframe`, `backtest_run_id` (FK, optional), `priority`,
  `status`, `metrics jsonb`, `idempotency_key` UNIQUE)

Ein universe-scoped Lauf wird **nicht** in `backtest_runs` persistiert, sondern in
`strategy_screening_runs`; zellbezogene Metriken liegen in `strategy_market_results.metrics` — konsistent mit der bestehenden Trennung
„instrument-scoped Run" vs. „Aggregat".

## Akzeptanzkriterien

- [x] Keine Änderung an `backtest_runs` oder seinen Indizes
- [x] `strategy_market_results` referenziert pro Zelle optional eine `backtest_runs`-ID
- [x] Wiederholter Screening-Lauf erzeugt keine Duplikate (Idempotenz-Key)

## Implementierungsbeleg (STX-05-03)

Migration `drizzle/2026-10-01_strategy_screening.sql`, deckungsgleiches Schema,
`src/screening/keys.ts`/`store.ts` und `tests/strategyScreening.db.test.ts`:
Run-/Zell-Idempotenz auch bei parallelen Retries, verpflichtender
Strategieversions-FK, optionaler Backtest-Link, vollständige Config,
immutable Prioritäten, monotone Fortschritte und SQL-/Drizzle-Push-Parität.
Kein DELETE-Pfad. Anleitung/Rollback: [STRATEGY_SCREENING.md](../../../STRATEGY_SCREENING.md).

## Versions-Hinweis

Minor (additive Migration).

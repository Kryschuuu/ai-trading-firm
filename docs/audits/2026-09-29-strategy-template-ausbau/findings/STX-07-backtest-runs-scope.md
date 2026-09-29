# STX-07 — `backtest_runs.instrument_id NOT NULL` blockiert Universe-Runs

- **ID:** STX-07
- **Severity:** MEDIUM
- **Bereich:** Persistenz
- **Quelle:** Ausbaudokument §4.2
- **Status:** OPEN
- **Datei(en):** `src/db/schema.ts:226`

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
`strategy_screening_runs` mit `metrics jsonb` — konsistent mit der bestehenden Trennung
„instrument-scoped Run" vs. „Aggregat".

## Akzeptanzkriterien

- [ ] Keine Änderung an `backtest_runs` oder seinen Indizes
- [ ] `strategy_market_results` referenziert pro Zelle optional eine `backtest_runs`-ID
- [ ] Wiederholter Screening-Lauf erzeugt keine Duplikate (Idempotenz-Key)

## Versions-Hinweis

Minor (additive Migration).

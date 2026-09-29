# STX-05-03 — Screening-Persistenz + Idempotenz

- **Phase:** 5 · **Paket:** 05-02, 04-01 · **Finding:** STX-07
- **Risiko:** mittel (Schema) · **Additive Migration**

## Zweck

`backtest_runs` ist single-instrument (`instrument_id NOT NULL`). Die Matrix braucht
eigene Tabellen — für den Lauf, für die Zellen und für den Link zum Backtest-Run.
Außerdem muss ein wiederholter Screening-Lauf **keine** Duplikate erzeugen.

## Kontext

Muster: `drizzle/2026-09-19_backtest_runs.sql`,
`drizzle/2026-09-22_cross_sectional_ranking.sql` (Hash + Idempotenz-Key + Provenienz).
Hash-Präfix-Konvention: `wf1:`, `sle1:`, `slt1:` ⇒ hier `ssr1:` (Run) / `ssm1:` (Zelle).

## Auftrag

1. **`drizzle/2026-09-2X_strategy_screening.sql`** (additiv, idempotent)

   **`strategy_screening_runs`**
   - `id uuid PK`
   - `run_kind text NOT NULL CHECK in ('DISCOVERY','MATRIX','BACKTEST_BATCH')`
   - `as_of timestamptz NOT NULL` — der gemeinsame Cutoff (PIT!)
   - `candidate_set_hash text NOT NULL CHECK (~ '^ssr1:[0-9a-f]{64}$')`
   - `code_version text NOT NULL`, `data_version text`
   - `config_json jsonb NOT NULL` (Gewichte + Limits — sonst ist der Lauf nicht reproduzierbar)
   - `status text NOT NULL CHECK in ('PENDING','RUNNING','DONE','FAILED','ABORTED')`
   - `cells_total integer NOT NULL DEFAULT 0`, `cells_done integer NOT NULL DEFAULT 0`
   - `created_at`, `updated_at`
   - `UNIQUE (candidate_set_hash, code_version)` ⇒ **derselbe** Lauf am selben Code
     liefert den bestehenden Run zurück

   **`strategy_market_results`**
   - `id uuid PK`
   - `run_id uuid NOT NULL REFERENCES strategy_screening_runs(id)`
   - `strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id)` (aus 04-01!)
   - `instrument_id text NOT NULL`, `venue text NOT NULL`, `timeframe text NOT NULL`
   - `template_id text NOT NULL` (denormalisiert für Queries)
   - `priority numeric`, `status text NOT NULL`, `reasons jsonb NOT NULL DEFAULT '[]'`
   - `backtest_run_id uuid REFERENCES backtest_runs(id)` — **optional**: Zelle ohne
     Backtest ist ein legitimer Zustand
   - `metrics jsonb NOT NULL DEFAULT '{}'`
   - `idempotency_key text NOT NULL` mit `UNIQUE`; Präfix `ssm1:`
   - `created_at`, `updated_at`
   - Index auf `(run_id, status)`, `(run_id, priority DESC)`

   *Begründung des `strategy_version_id`-FKs:* ohne ihn ist eine Ergebniszeile eine
   Zahl ohne Strategiebezug — genau der Fehler, den `strategy_lifecycle_states` heute hat.

2. **`src/db/schema.ts`** ergänzen, deckungsgleich zur SQL-Datei.

3. **`src/screening/store.ts`**
   - `createOrGetRun(input): Promise<RunRow>` — `ON CONFLICT DO NOTHING` +
     anschließendes `SELECT`, in **einer** Transaktion (Muster:
     `persistBacktestRun` in `src/backtest/runStore.ts`)
   - `upsertCells(runId, cells): Promise<number>` — batchweise, `ON CONFLICT (idempotency_key) DO NOTHING`
   - `setRunStatus(runId, status, counts)` mit monotonic Fortschritt
   - `listResults(runId, { status?, limit })` — **begrenzt** (Muster `src/lib/paging.ts`)
   - Kein `DELETE` auf `strategy_screening_runs`

4. **Idempotenz-Key herleitung** (`src/screening/keys.ts`):
   ```
   run:     ssr1:sha256(canonicalJson({ cells, asOf, codeVersion, config }))
   zelle:   ssm1:sha256(canonicalJson({ runId, strategyVersionId, instrumentId, venue, timeframe }))
   ```
   Nutze `canonicalJson` aus `@/strategyLifecycle/evidence.ts` (kein eigenes).

## Akzeptanzkriterien

- [ ] Migration idempotent, `drizzle-kit push` ≡ `psql -f`
- [ ] `createOrGetRun` mit gleichem Hash ⇒ **eine** Zeile, kein Duplikat
- [ ] `upsertCells` zweimal ⇒ keine Duplikate (UNIQUE greift)
- [ ] `strategy_market_results` kann **nicht** ohne `strategy_version_id` existieren
- [ ] `strategy_screening_runs` speichert `config_json` ⇒ Lauf ist reproduzierbar
- [ ] `tests/strategyScreening.db.test.ts` grün (Muster `tests/crossSectional.db.test.ts`)
- [ ] **Kein** `DELETE`-Pfad
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine Änderung** an `backtest_runs`, `strategy_versions`, `strategy_lifecycle_*`.
- **Kein** Multi-Asset-/Universe-Ergebnis in `backtest_runs` (STX-07 — dort passt es nicht hinein).
- **Keine** Aktualisierung von `priority` nach dem ersten Schreiben (Unveränderlichkeit
  der Zelle; ein neuer Lauf ⇒ neue Zelle).

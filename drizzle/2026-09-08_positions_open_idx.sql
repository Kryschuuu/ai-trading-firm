-- RESTORE-01 (v1.36.37) — Partieller Index fuer die Zustandswiederherstellung
-- des Paper-Ledgers (additiv, kein Bruch, keine Datenmigration).
--
-- Hintergrund: Der Restore (`getBroker()` in src/lib/engine.ts), der
-- Monitor-Tick (src/lib/monitor.ts), die Ops-Sammlung (src/ops/collect.ts)
-- und der Mikro-Executor (src/lib/microExecutor.ts) fragen alle nach
-- `status = 'OPEN'`. `positions` waechst append-only (geschlossene Trades
-- bleiben stehen), ohne Index war jede dieser Abfragen ein Sequenz-Scan ueber
-- die gesamte Tabelle — bei 20.000+ Zeilen der teuerste Teil jedes
-- Kaltstarts.
--
-- Erklaert mit `npx drizzle-kit push` aus src/db/schema.ts
-- (`positions_open_idx`); diese Datei ist der aequivalente, idempotente
-- SQL-Pfad fuer Umgebungen ohne drizzle-kit (z. B.
-- `psql "$DATABASE_URL" -f drizzle/2026-09-08_positions_open_idx.sql`).
--
-- Semantik: Der Index enthaelt ausschliesslich die offenen Zeilen und ist
-- damit klein und stabil. Abfragen ohne Praedikat (`WHERE status = 'OPEN'`)
-- lesen ihn komplett, Symbol-Lookups (`WHERE status = 'OPEN' AND symbol = …`)
-- suchen darin. Die Geschwindigkeit ist eine Nebenkurswirkung — die
-- Korrektheit der Abfragen aendert sich nicht.
CREATE INDEX IF NOT EXISTS "positions_open_idx"
	ON "positions" USING btree ("symbol")
	WHERE "status" = 'OPEN';

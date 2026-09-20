-- RMA-P2-02 (v1.54.0) — historische Perpetual-Daten (Funding, OI, Liquidationen).
-- Append-only: FÜNF neue Tabellen plus Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Hintergrund: Funding-Raten und Open Interest existierten nur als Momentwert
-- (Ticker/Discovery) und als Buchungslogik im Paper-Ledger; Liquidationen
-- waren gar nicht modelliert. Für Backtest, Research und Post-Mortem gab es
-- damit keine as-of-sichere Wahrheit (Roadmap-Audit 2026-09-20,
-- docs/audits/2026-09-20-roadmap-audit/findings/RMA-P2-02-perpetual-data.md).
--
-- ── Zeit-Semantik (Kern des Fixes) ──────────────────────────────────────────
--   event_time    Ereigniszeit (Settlement, OI-Messpunkt, Liquidation).
--   available_at  ab wann der Satz wahrheitsgemäß bekannt sein durfte.
--   fetched_at    Abrufzeit beim Venue (Transport, nie Entscheidungsgrundlage).
-- Eine Point-in-Time-Abfrage ist zulässig, wenn
--   event_time <= as_of AND available_at <= as_of
-- gilt. `available_at` folgt der Schreibpolitik (`ingested` =
-- max(event_time, fetched_at) als Default, `settlement` = event_time für
-- Replay-Forschung mit vollständiger Historie).
--
-- ── `null` ist nicht `0` ────────────────────────────────────────────────────
-- Jede Größe ist nullable und trägt bei `null` einen `missing_reason`
-- (CHECK erzwingt genau eines von beidem: Wert XOR Grund). Ein Venue ohne
-- öffentlichen Open-Interest-Endpunkt liefert deshalb **keine** Nullzeilen,
-- sondern bleibt in der Capability-Matrix typisiert `UNSUPPORTED`.
--
-- ── Einheiten ─────────────────────────────────────────────────────────────────
--   perp_funding_rates.unit   = 'fraction_per_interval' (0.0001 = 1 bp/Intervall)
--   perp_open_interest.basis  = autoritative Größe der Quelle; weitere Felder
--                               nur mit converted = true (CHECK: >1 Wert nur,
--                               wenn als Ableitung markiert)
--   perp_liquidations.unit    = 'base_units', Preis = quote_per_base
--
-- ── Idempotenz ────────────────────────────────────────────────────────────────
--   perp_funding_rates/perp_open_interest: UNIQUE (venue, instrument_id, event_time)
--   perp_liquidations:                     UNIQUE (venue, instrument_id, event_time,
--                                                  source_event_id)
--   perp_sync_runs:                        UNIQUE (idempotency_key)
-- Alle Writes laufen als `ON CONFLICT DO NOTHING` — ein Retry schreibt 0 Zeilen,
-- kein dritter Eintrag, keine Doppelbuchung.
--
-- Erklärt mit `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`perpFundingRates`, `perpOpenInterest`, `perpLiquidations`, `perpSyncRuns`,
-- `perpSyncCursors`); diese Datei ist der äquivalente, idempotente SQL-Pfad für
-- Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-20_perpetual_data.sql
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- Nur wenn KEIN v1.54.0-Code mehr läuft (der Perp-Datenpfad ist ein
-- zusätzlicher Lesepfad; `PERP_DATA_ENABLED=false` (Default) lässt Scanner,
-- Zyklus, Risiko und Live-Gates unverändert):
--   DROP TABLE IF EXISTS perp_sync_cursors;
--   DROP TABLE IF EXISTS perp_sync_runs;
--   DROP TABLE IF EXISTS perp_liquidations;
--   DROP TABLE IF EXISTS perp_open_interest;
--   DROP TABLE IF EXISTS perp_funding_rates;
-- Rohdaten und alle übrigen Tabellen bleiben unberührt; der Bestand ist aus
-- denselben Quellen reproduzierbar (`npm run perp:sync -- --mode=backfill`).

-- 1) Sync-Manifeste (zuerst: die Datentabellen referenzieren sie) ----------
CREATE TABLE IF NOT EXISTS "perp_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "venue" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "availability_policy" text NOT NULL,
  "from_ts" timestamptz NOT NULL,
  "to_ts" timestamptz NOT NULL,
  "kinds" jsonb NOT NULL,
  "instrument_ids" jsonb NOT NULL,
  "counts_json" jsonb NOT NULL,
  "capabilities_json" jsonb NOT NULL,
  "failures_json" jsonb NOT NULL,
  "code_version" text NOT NULL,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "perp_sync_runs_key_unique"
  ON "perp_sync_runs" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "perp_sync_runs_venue_finished_idx"
  ON "perp_sync_runs" ("venue", "finished_at");

-- 2) Funding-Sätze ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "perp_funding_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid REFERENCES "perp_sync_runs"("id"),
  "venue" text NOT NULL,
  "instrument_id" text NOT NULL,
  "symbol" text NOT NULL,
  "source_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "fetched_at" timestamptz NOT NULL,
  "funding_rate" numeric,
  "interval_hours" numeric,
  "next_funding_time" timestamptz,
  "mark_price" numeric,
  "unit" text NOT NULL DEFAULT 'fraction_per_interval',
  "quality_status" text NOT NULL,
  "missing_reason" text,
  "content_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "perp_funding_rates_key_unique"
  ON "perp_funding_rates" ("venue", "instrument_id", "event_time");
CREATE INDEX IF NOT EXISTS "perp_funding_rates_pit_idx"
  ON "perp_funding_rates" ("instrument_id", "event_time", "available_at");
CREATE INDEX IF NOT EXISTS "perp_funding_rates_venue_event_idx"
  ON "perp_funding_rates" ("venue", "event_time");
CREATE INDEX IF NOT EXISTS "perp_funding_rates_run_idx"
  ON "perp_funding_rates" ("run_id");

-- 3) Open Interest ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "perp_open_interest" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid REFERENCES "perp_sync_runs"("id"),
  "venue" text NOT NULL,
  "instrument_id" text NOT NULL,
  "symbol" text NOT NULL,
  "source_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "fetched_at" timestamptz NOT NULL,
  "contracts" numeric,
  "base_quantity" numeric,
  "quote_value" numeric,
  "basis" text NOT NULL,
  "contract_size" numeric,
  "quote_currency" text,
  "mark_price" numeric,
  "converted" boolean NOT NULL DEFAULT false,
  "unit" text NOT NULL,
  "quality_status" text NOT NULL,
  "missing_reason" text,
  "content_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "perp_open_interest_key_unique"
  ON "perp_open_interest" ("venue", "instrument_id", "event_time");
CREATE INDEX IF NOT EXISTS "perp_open_interest_pit_idx"
  ON "perp_open_interest" ("instrument_id", "event_time", "available_at");
CREATE INDEX IF NOT EXISTS "perp_open_interest_venue_event_idx"
  ON "perp_open_interest" ("venue", "event_time");
CREATE INDEX IF NOT EXISTS "perp_open_interest_run_idx"
  ON "perp_open_interest" ("run_id");

-- 4) Liquidationsereignisse -------------------------------------------------
CREATE TABLE IF NOT EXISTS "perp_liquidations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid REFERENCES "perp_sync_runs"("id"),
  "venue" text NOT NULL,
  "instrument_id" text NOT NULL,
  "symbol" text NOT NULL,
  "source_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "fetched_at" timestamptz NOT NULL,
  "side" text NOT NULL,
  "quantity_base" numeric,
  "price" numeric,
  "notional_quote" numeric,
  "quote_currency" text,
  "source_event_id" text NOT NULL,
  "aggregate_count" integer,
  "unit" text NOT NULL DEFAULT 'base_units',
  "quality_status" text NOT NULL,
  "missing_reason" text,
  "content_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "perp_liquidations_key_unique"
  ON "perp_liquidations" ("venue", "instrument_id", "event_time", "source_event_id");
CREATE INDEX IF NOT EXISTS "perp_liquidations_pit_idx"
  ON "perp_liquidations" ("instrument_id", "event_time", "available_at");
CREATE INDEX IF NOT EXISTS "perp_liquidations_venue_event_idx"
  ON "perp_liquidations" ("venue", "event_time");
CREATE INDEX IF NOT EXISTS "perp_liquidations_run_idx"
  ON "perp_liquidations" ("run_id");

-- 5) Sync-Cursor (Wasserstand je Reihe) -------------------------------------
CREATE TABLE IF NOT EXISTS "perp_sync_cursors" (
  "venue" text NOT NULL,
  "instrument_id" text NOT NULL,
  "kind" text NOT NULL,
  "watermark_event_time" timestamptz NOT NULL,
  "watermark_available_at" timestamptz NOT NULL,
  "last_run_id" uuid REFERENCES "perp_sync_runs"("id"),
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_status" text NOT NULL DEFAULT 'OK',
  "unsupported_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("venue", "instrument_id", "kind")
);

CREATE INDEX IF NOT EXISTS "perp_sync_cursors_venue_kind_idx"
  ON "perp_sync_cursors" ("venue", "kind");

-- ── Constraints (idempotent nachgezogen) ───────────────────────────────────
DO $$
BEGIN
  -- Funding ---------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_event_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_event_check"
      CHECK ("available_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_fetched_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_fetched_check"
      CHECK ("fetched_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_schema_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_schema_check"
      CHECK ("schema_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_unit_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_unit_check"
      CHECK ("unit" = 'fraction_per_interval');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_value_exclusive_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_value_exclusive_check"
      CHECK (("funding_rate" IS NULL AND "missing_reason" IS NOT NULL)
          OR ("funding_rate" IS NOT NULL AND "missing_reason" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_missing_reason_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_missing_reason_check"
      CHECK ("missing_reason" IS NULL OR "missing_reason" IN
        ('NOT_REPORTED','OUT_OF_BOUNDS','SOURCE_ERROR','NOT_APPLICABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_quality_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_quality_check"
      CHECK ("quality_status" IN
        ('OK','GAP','OUTLIER','INVALID','DUPLICATE','CROSSCHECK','STALE','UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_rate_bound_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_rate_bound_check"
      CHECK ("funding_rate" IS NULL OR abs("funding_rate") <= 0.3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_interval_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_interval_check"
      CHECK ("interval_hours" IS NULL OR ("interval_hours" > 0 AND "interval_hours" <= 24));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_hash_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_hash_check"
      CHECK ("content_hash" ~ '^pv1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_venue_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_venue_check"
      CHECK ("venue" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_funding_rates_symbol_check') THEN
    ALTER TABLE "perp_funding_rates" ADD CONSTRAINT "perp_funding_rates_symbol_check"
      CHECK ("symbol" ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$');
  END IF;

  -- Open Interest ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_event_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_event_check"
      CHECK ("available_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_fetched_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_fetched_check"
      CHECK ("fetched_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_schema_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_schema_check"
      CHECK ("schema_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_basis_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_basis_check"
      CHECK (("basis" = 'contracts' AND "contracts" IS NOT NULL)
          OR ("basis" = 'base_units' AND "base_quantity" IS NOT NULL)
          OR ("basis" = 'quote_units' AND "quote_value" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_unit_matches_basis_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_unit_matches_basis_check"
      CHECK ("unit" = "basis");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_conversion_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_conversion_check"
      CHECK ("converted"
          OR ((CASE WHEN "contracts" IS NOT NULL THEN 1 ELSE 0 END)
            + (CASE WHEN "base_quantity" IS NOT NULL THEN 1 ELSE 0 END)
            + (CASE WHEN "quote_value" IS NOT NULL THEN 1 ELSE 0 END)) <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_non_negative_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_non_negative_check"
      CHECK (("contracts" IS NULL OR "contracts" >= 0)
        AND ("base_quantity" IS NULL OR "base_quantity" >= 0)
        AND ("quote_value" IS NULL OR "quote_value" >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_currency_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_currency_check"
      CHECK ("quote_value" IS NULL OR "quote_currency" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_contract_size_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_contract_size_check"
      CHECK ("contract_size" IS NULL OR "contract_size" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_missing_reason_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_missing_reason_check"
      CHECK ("missing_reason" IS NULL OR "missing_reason" IN
        ('NOT_REPORTED','OUT_OF_BOUNDS','SOURCE_ERROR','NOT_APPLICABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_quality_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_quality_check"
      CHECK ("quality_status" IN
        ('OK','GAP','OUTLIER','INVALID','DUPLICATE','CROSSCHECK','STALE','UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_hash_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_hash_check"
      CHECK ("content_hash" ~ '^pv1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_open_interest_currency_format_check') THEN
    ALTER TABLE "perp_open_interest" ADD CONSTRAINT "perp_open_interest_currency_format_check"
      CHECK ("quote_currency" IS NULL OR "quote_currency" ~ '^[A-Z][A-Z0-9]{1,6}$');
  END IF;

  -- Liquidationen ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_event_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_event_check"
      CHECK ("available_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_fetched_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_fetched_check"
      CHECK ("fetched_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_schema_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_schema_check"
      CHECK ("schema_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_side_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_side_check"
      CHECK ("side" IN ('LONG_LIQUIDATED','SHORT_LIQUIDATED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_positive_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_positive_check"
      CHECK (("quantity_base" IS NULL OR "quantity_base" > 0)
        AND ("price" IS NULL OR "price" > 0)
        AND ("notional_quote" IS NULL OR "notional_quote" > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_measure_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_measure_check"
      CHECK ("quantity_base" IS NOT NULL OR "notional_quote" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_currency_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_currency_check"
      CHECK ("notional_quote" IS NULL OR "quote_currency" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_aggregate_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_aggregate_check"
      CHECK ("aggregate_count" IS NULL OR "aggregate_count" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_unit_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_unit_check"
      CHECK ("unit" = 'base_units');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_quality_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_quality_check"
      CHECK ("quality_status" IN
        ('OK','GAP','OUTLIER','INVALID','DUPLICATE','CROSSCHECK','STALE','UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_hash_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_hash_check"
      CHECK ("content_hash" ~ '^pv1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_liquidations_event_id_check') THEN
    ALTER TABLE "perp_liquidations" ADD CONSTRAINT "perp_liquidations_event_id_check"
      CHECK ("source_event_id" ~ '^[A-Za-z0-9:._-]{1,64}$');
  END IF;

  -- Läufe/Cursor ----------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_runs_mode_check') THEN
    ALTER TABLE "perp_sync_runs" ADD CONSTRAINT "perp_sync_runs_mode_check"
      CHECK ("mode" IN ('INCREMENTAL','BACKFILL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_runs_status_check') THEN
    ALTER TABLE "perp_sync_runs" ADD CONSTRAINT "perp_sync_runs_status_check"
      CHECK ("status" IN ('SUCCEEDED','PARTIAL','FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_runs_policy_check') THEN
    ALTER TABLE "perp_sync_runs" ADD CONSTRAINT "perp_sync_runs_policy_check"
      CHECK ("availability_policy" IN ('ingested','settlement'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_runs_window_check') THEN
    ALTER TABLE "perp_sync_runs" ADD CONSTRAINT "perp_sync_runs_window_check"
      CHECK ("to_ts" > "from_ts");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_runs_error_check') THEN
    ALTER TABLE "perp_sync_runs" ADD CONSTRAINT "perp_sync_runs_error_check"
      CHECK (("status" = 'FAILED' AND "error_code" IS NOT NULL)
        OR ("status" <> 'FAILED' AND "error_code" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_cursors_kind_check') THEN
    ALTER TABLE "perp_sync_cursors" ADD CONSTRAINT "perp_sync_cursors_kind_check"
      CHECK ("kind" IN ('funding','openInterest','liquidations'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_cursors_watermark_check') THEN
    ALTER TABLE "perp_sync_cursors" ADD CONSTRAINT "perp_sync_cursors_watermark_check"
      CHECK ("watermark_available_at" >= "watermark_event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_cursors_status_check') THEN
    ALTER TABLE "perp_sync_cursors" ADD CONSTRAINT "perp_sync_cursors_status_check"
      CHECK ("last_status" IN ('OK','PARTIAL','FAILED','UNSUPPORTED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'perp_sync_cursors_failures_check') THEN
    ALTER TABLE "perp_sync_cursors" ADD CONSTRAINT "perp_sync_cursors_failures_check"
      CHECK ("consecutive_failures" >= 0);
  END IF;
END $$;

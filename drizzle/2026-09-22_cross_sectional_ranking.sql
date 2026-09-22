-- RMA-P2-04 (v1.63.0) — Point-in-Time Cross-Sectional Momentum Ranking.
-- EINE append-only Migration: ZWEI neue Tabellen + Indizes/Constraints;
-- keine bestehende Tabelle wird verändert, keine Spalte umgebaut, kein
-- Backfill nötig.
--
-- Hintergrund: Der Scanner rankt Instrumente nach einem instrument-lokalen
-- Multi-Faktor-Score; universumsweite, as-of-sichere Momentum-Perzentile
-- mit gemeinsamer Provenance fehlten (Roadmap-Audit 2026-09-20,
-- docs/audits/2026-09-20-roadmap-audit/findings/RMA-P2-04-cross-sectional-ranking.md).
--
-- ── Semantik ────────────────────────────────────────────────────────────────
-- `cross_sectional_snapshots`
--   EINE Zeile je Snapshot-Lauf (gemeinsamer As-of-Cutoff EINES Universums).
--   `snapshot_id` = `xs1:<sha256>` über
--   Schema|Timeframe|AsOf|UniverseHash|DataHash|ConfigHash|CodeVersion —
--   die DETERMINISTISCHE Snapshot-Identität: gleiche fachliche Eingabe
--   erzeugt dieselbe ID, und `idempotency_key` (derselbe Hex-Hash) macht
--   Retries/Restarts zu sichtbaren No-Ops (ON CONFLICT DO NOTHING).
--   `stability` ist NULL beim allerersten Snapshot; danach gebounded
--   Turnover-Zahlen (Top-K-Overlap, mittlere Rangänderung).
--
-- `cross_sectional_rankings`
--   EINE Zeile je (Snapshot, Instrument): RANKED (Rang/Perzentil/Composite +
--   Rohwerte) oder EXCLUDED (geschlossener Grund — nie still 0). Die
--   `raw_returns`/`z_scores`/`winsorized` jsonb tragen pro Horizont
--   explizite NULLs für nicht berechenbare Werte (fail-closed).
--
-- ── Zeitsemantik ────────────────────────────────────────────────────────────
--   as_of        = gemeinsamer As-of-Cutoff des Snapshots (Ereigniszeit;
--                  alle Kerzen: barEnd ≤ as_of UND — bei Policy `ingested` —
--                  available_at ≤ as_of).
--   computed_at  = Berechnungszeit des Laufs. NIEMALS Filterkriterium für
--                  Zulässigkeit (späte Neuberechnung erzeugt kein neues
--                  Wissen) — dieselbe Regel wie Feature Store/Regime.
--   Point-in-Time-Lesezugriff: die jüngste Zeile mit as_of ≤ Zielzeitpunkt
--   (Index `cross_sectional_snapshots_asof_idx`).
--
-- ── Idempotenz & Integrität ─────────────────────────────────────────────────
--   UNIQUE (snapshot_id) / UNIQUE (idempotency_key) auf der Snapshot-Ebene;
--   UNIQUE (snapshot_id, instrument_id) auf der Mitglieder-Ebene.
--   `value_hash` (SHA-256 der zeilengen Fachinhalte) erlaubt dem
--   Persistenzpfad abweichende Zeilen zu PROTOKOLLIEREN statt zu
--   überschreiben (append-only, fail-closed).
--   FK (snapshot_id) mit ON DELETE CASCADE: ein Snapshot wird immer mit
--   seinen Mitgliedern entfernt (Retention), nie als Waise.
--
-- Erklärt mit `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`crossSectionalSnapshots`, `crossSectionalRankings`); diese Datei ist der
-- äquivalente, idempotente SQL-Pfad für Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_cross_sectional_ranking.sql
--
-- ── Rollback ────────────────────────────────────────────────────────────────
-- Nur wenn KEIN v1.63.0-Code mehr läuft (die Tabellen sind reine Zusatz-
-- lesepfade: Scanner, Zyklus, Risk-Ceilings, Kill-Switches und Live-Gates
-- bleiben ohne sie unverändert; der Scanner-Faktor meldet dann schlicht
-- `unavailable`):
--   DROP TABLE IF EXISTS cross_sectional_rankings;
--   DROP TABLE IF EXISTS cross_sectional_snapshots;
-- Rohdaten (`data/history/candles.ndjson`) und alle übrigen Tabellen bleiben
-- unberührt; Snapshots sind aus denselben Rohdaten + Registry + Config zu
-- jedem Zeitpunkt reproduzierbar (`npm run research:cross-sectional`).

-- 1) Snapshot-Historie -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "cross_sectional_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "snapshot_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "schema_version" integer NOT NULL,
  "code_version" text NOT NULL,
  "config_version" integer NOT NULL,
  "config_hash" text NOT NULL,
  "universe_hash" text NOT NULL,
  "data_hash" text NOT NULL,
  "timeframe" text NOT NULL,
  "availability_policy" text NOT NULL,
  "universe_size" integer NOT NULL,
  "ranked_count" integer NOT NULL,
  "excluded_count" integer NOT NULL,
  "coverage" numeric NOT NULL,
  "exclusion_counts" jsonb NOT NULL,
  "stability" jsonb,
  "survivorship_note" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Idempotenz: gleiche fachliche Identität ⇒ keine zweite Zeile (Retry/Restart).
CREATE UNIQUE INDEX IF NOT EXISTS "cross_sectional_snapshots_idem_unique"
  ON "cross_sectional_snapshots" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "cross_sectional_snapshots_snapshot_id_unique"
  ON "cross_sectional_snapshots" ("snapshot_id");

-- PIT-Lesepfad: jüngster Snapshot ≤ Zielzeitpunkt.
CREATE INDEX IF NOT EXISTS "cross_sectional_snapshots_asof_idx"
  ON "cross_sectional_snapshots" ("as_of");

-- 2) Mitglieder je Snapshot --------------------------------------------------
CREATE TABLE IF NOT EXISTS "cross_sectional_rankings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "snapshot_id" text NOT NULL
    REFERENCES "cross_sectional_snapshots" ("snapshot_id") ON DELETE CASCADE,
  "instrument_id" text NOT NULL,
  "status" text NOT NULL,
  "rank" integer,
  "percentile" numeric,
  "composite" numeric,
  "raw_returns" jsonb NOT NULL,
  "z_scores" jsonb NOT NULL,
  "winsorized" jsonb NOT NULL,
  "horizon_coverage" numeric NOT NULL,
  "last_bar_ts" timestamptz,
  "last_available_at" timestamptz,
  "bars_used" integer NOT NULL DEFAULT 0,
  "exclusion_reason" text,
  "value_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cross_sectional_rankings_snapshot_instrument_unique"
  ON "cross_sectional_rankings" ("snapshot_id", "instrument_id");

-- Ranking-Lesepfad (Top-N am Snapshot).
CREATE INDEX IF NOT EXISTS "cross_sectional_rankings_snapshot_rank_idx"
  ON "cross_sectional_rankings" ("snapshot_id", "rank");

-- 3) Constraints (idempotent nachgezogen) ------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_computed_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_computed_check"
      CHECK ("computed_at" >= "as_of");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_schema_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_schema_check"
      CHECK ("schema_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_counts_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_counts_check"
      CHECK ("universe_size" >= 0 AND "ranked_count" >= 0 AND "excluded_count" >= 0
             AND "ranked_count" <= "universe_size"
             AND "ranked_count" + "excluded_count" = "universe_size");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_coverage_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_coverage_check"
      CHECK ("coverage" >= 0 AND "coverage" <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_snapshot_id_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_snapshot_id_check"
      CHECK ("snapshot_id" ~ '^xs1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_idem_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_idem_check"
      CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_hash_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_hash_check"
      CHECK ("config_hash" ~ '^xc1:[0-9a-f]{64}$'
             AND "universe_hash" ~ '^xu1:[0-9a-f]{64}$'
             AND "data_hash" ~ '^xd1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_timeframe_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_timeframe_check"
      CHECK ("timeframe" IN ('1m','3m','5m','15m','30m','1h','2h','4h','1d','5d'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_snapshots_policy_check') THEN
    ALTER TABLE "cross_sectional_snapshots" ADD CONSTRAINT "cross_sectional_snapshots_policy_check"
      CHECK ("availability_policy" IN ('ingested','bar_close'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_status_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_status_check"
      CHECK ("status" IN ('RANKED','EXCLUDED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_ranked_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_ranked_check"
      CHECK (("status" = 'RANKED') = ("rank" IS NOT NULL)
             AND (("status" = 'EXCLUDED') = ("exclusion_reason" IS NOT NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_percentile_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_percentile_check"
      CHECK ("percentile" IS NULL OR ("percentile" > 0 AND "percentile" <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_coverage_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_coverage_check"
      CHECK ("horizon_coverage" >= 0 AND "horizon_coverage" <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_reason_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_reason_check"
      CHECK ("exclusion_reason" IS NULL OR "exclusion_reason" IN
        ('INACTIVE','NOT_IN_ASSET_CLASSES','NO_LIQUIDITY_DATA','BELOW_MIN_VOLUME',
         'UNIVERSE_CAP','NO_BARS_AT_CUTOFF','STALE_DATA','INSUFFICIENT_HISTORY',
         'INSUFFICIENT_HORIZON_COVERAGE','CROSS_SECTION_DEGENERATE','INVALID_INPUT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_hash_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_hash_check"
      CHECK ("value_hash" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_sectional_rankings_bars_check') THEN
    ALTER TABLE "cross_sectional_rankings" ADD CONSTRAINT "cross_sectional_rankings_bars_check"
      CHECK ("bars_used" >= 0 AND ("last_bar_ts" IS NULL OR "bars_used" > 0));
  END IF;
END $$;

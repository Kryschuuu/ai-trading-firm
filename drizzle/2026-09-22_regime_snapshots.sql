-- RMA-P2-01 (v1.61.0) — multidimensionale, point-in-time-sichere
-- Regime-Erkennung: persistente Snapshots für Stabilitäts-, Transitions-,
-- Coverage- und OOS-Auswertung.
--
-- EINE neue append-only Tabelle; keine bestehende Tabelle/Spalte/Migration
-- wird verändert. Äquivalent zu `npx drizzle-kit push` aus src/db/schema.ts
-- (`regimeSnapshots`) — diese Datei ist der idempotente SQL-Pfad für
-- Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_regime_snapshots.sql
--
-- ── Semantik ────────────────────────────────────────────────────────────────
-- `regime_snapshots`  EINE Zeile je gelaufener Regime-Bewertung
--                      (Symbol × as_of × Roh-/Bestätigtklasse × Coverage ×
--                      Versionen). Der SHA-256-Key darauf ist der
--                      Idempotenz-Schlüssel: Retries/Restarts derselben
--                      Bewertung erzeugen KEINE zweite Zeile; eine spätere
--                      Bewertung (neues as_of) ist eine neue Zeile.
--
-- Zeitsemantik:
--   as_of        = Ereigniszeit/As-of der Bewertung (Point-in-Time-Stand,
--                  zu dem alle Feature-Samples geprüft wurden:
--                  event_time ≤ as_of UND available_at ≤ as_of).
--   computed_at  = reine Berechnungs-/Schreibzeit. NIEMALS Filterkriterium
--                  für Zulässigkeit (späte Neuberechnung erzeugt kein neues
--                  Wissen) — dieselbe Regel wie im Feature Store.
--   confidence   = NULL bei UNKNOWN (nie still 0).
--   coverage     = Anteil OK-Pflichtfamilien des Feature-Vertrags [0,1];
--                  degraded=true markiert den OHLCV-Fallback.
--
-- Constraints: Regime-Vokabular (6 Klassen), Confidence/Coverage
-- [0,1], Gate-/Feature-Modus-Enums, hex-Key; Indizes für (symbol, as_of)
-- und as_of (Eval-Queries laufen über as_of-Fenster mit LIMIT).
--
-- Erwartetes Volumen: gebounded durch Throttle im Schreiber
-- (REGIME_PERSIST_MIN_INTERVAL_MS je Symbol + bei Regime-Wechsel;
-- typisch ~96 Zeilen/Symbol/Tag bei 15-min-Takt, übrigens ohne Wechsel).
-- Retention: `pruneRegimeSnapshots()` (Default 90 Tage) bzw. SQL:
--   DELETE FROM regime_snapshots WHERE as_of < now() - interval '90 days';
--
-- Rollback (nur wenn KEIN v1.61.0-Code mehr läuft — die Tabelle ist ein
-- reiner Zusatzleseschritt für Evaluation/Artefakte; Scanner, Gate, Risk-
-- Ceilings, Kill-Switches und Live-Gates bleiben ohne sie unverändert):
--   DROP TABLE IF EXISTS regime_snapshots;
-- Rohdaten und übrige Tabellen bleiben unberührt; die Historie ist aus den
-- laufenden Bewertungen jederzeit neu erzeugbar (kein Backfill nötig).

-- 1) Append-only Snapshot-Historie ------------------------------------------
CREATE TABLE IF NOT EXISTS "regime_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "symbol" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "raw_regime" text NOT NULL,
  "confirmed_regime" text NOT NULL,
  "confidence" numeric,
  "coverage" numeric NOT NULL,
  "degraded" boolean NOT NULL,
  "gate_mode" text NOT NULL,
  "feature_mode" text NOT NULL,
  "feature_version" text NOT NULL,
  "model_version" text NOT NULL,
  "top_drivers" jsonb NOT NULL,
  "family_status" jsonb NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- 2) Idempotenz + Auswertungsindizes ----------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "regime_snapshots_idem_unique"
  ON "regime_snapshots" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "regime_snapshots_symbol_asof_idx"
  ON "regime_snapshots" ("symbol", "as_of");

CREATE INDEX IF NOT EXISTS "regime_snapshots_asof_idx"
  ON "regime_snapshots" ("as_of");

-- 3) Constraints -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regime_snapshots_regime_check') THEN
    ALTER TABLE "regime_snapshots" ADD CONSTRAINT "regime_snapshots_regime_check"
      CHECK (
        "raw_regime" IN ('TREND_UP','TREND_DOWN','RANGE','HIGH_VOL','CRASH','UNKNOWN')
        AND "confirmed_regime" IN ('TREND_UP','TREND_DOWN','RANGE','HIGH_VOL','CRASH','UNKNOWN')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regime_snapshots_confidence_check') THEN
    ALTER TABLE "regime_snapshots" ADD CONSTRAINT "regime_snapshots_confidence_check"
      CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regime_snapshots_coverage_check') THEN
    ALTER TABLE "regime_snapshots" ADD CONSTRAINT "regime_snapshots_coverage_check"
      CHECK ("coverage" >= 0 AND "coverage" <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regime_snapshots_gate_mode_check') THEN
    ALTER TABLE "regime_snapshots" ADD CONSTRAINT "regime_snapshots_gate_mode_check"
      CHECK ("gate_mode" IN ('off','monitor','enforce'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regime_snapshots_feature_mode_check') THEN
    ALTER TABLE "regime_snapshots" ADD CONSTRAINT "regime_snapshots_feature_mode_check"
      CHECK ("feature_mode" IN ('ohlcv','multidim'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'regime_snapshots_idem_check') THEN
    ALTER TABLE "regime_snapshots" ADD CONSTRAINT "regime_snapshots_idem_check"
      CHECK ("idempotency_key" ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

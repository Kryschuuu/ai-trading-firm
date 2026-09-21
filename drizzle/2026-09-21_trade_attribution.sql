-- RMA-P1-06 (v1.57.0) — deterministische Trade-PnL-Attribution.
--
-- ZWEI neue append-only Tabellen; keine bestehende Tabelle/Spalte/Migration
-- wird verändert. Äquivalent zu `npx drizzle-kit push` aus src/db/schema.ts
-- (`tradeAttributions`, `tradeAttributionEntries`) — diese Datei ist der
-- idempotente SQL-Pfad für Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-21_trade_attribution.sql
--
-- WICHTIG: `drizzle-kit push` legt die Unveränderlichkeits-Trigger (unten)
-- NICHT an — für Produktionssysteme ist diese Datei der kanonische Pfad.
--
-- ── Semantik ────────────────────────────────────────────────────────────────
-- `trade_attributions`      EINE Kopfzeile je geschlossenem Trade ×
--                           Methodenversion. UNIQUE (journal_id,
--                           method_version) ist der Idempotenz-Schlüssel:
--                           Retries/Restarts erzeugen keine zweite
--                           Attribution. Ein Methodenwechsel schreibt NEUE
--                           Zeilen — alte Ergebnisse bleiben unverändert.
-- `trade_attribution_entries` Beitragsposten je Quelle (AGENT | RULE |
--                           COST), UNIQUE (attribution_id, source_type,
--                           source_id).
--
-- Invariante (Code-seitig erzwungen, src/attribution/model.ts):
--   Σ Quellen + Σ Kosten + Residual = Netto-PnL  (± 1e-6)
--   Netto = Brutto (Journal `pnl`) − Gebühren + Funding (Kontosicht).
-- `fees`/`funding` NULL = unbekannt (NIE still 0); unbekannte Komponenten
-- stehen sichtbar in `unknown_costs` (Teilmenge von [FEES, FUNDING]).
--
-- Zeitsemantik: `closed_at` = Ereigniszeit des Closes (Journal-Zeile) und
-- Zeitfilter aller Queries; `computed_at` = reine Berechnungszeit. Alle
-- Eingaben stammen aus dem unveränderlichen Entry-Snapshot bzw. den
-- Close-Fakten — Look-ahead ist konstruktiv ausgeschlossen.
--
-- FK ohne ON DELETE CASCADE (Repo-Konvention, fail-closed gegen stilles
-- Mitlöschen): Journal-Zeilen mit Attribution sind erst nach explizitem
-- Löschen der Attributionen löschbar; es gibt keinen Code-Löschpfad.
--
-- Erwartetes Volumen: eine Kopfzeile + ~2–12 Posten je geschlossenem Trade
-- (Kosten 0–2, Agenten ≤ Rollenzahl, Regel 0–1). Lesepfade: Keyset-/Limit-
-- Paging über (closed_at, id) bzw. (symbol|regime, closed_at); Aggregation
-- über die Composite-Indizes.
--
-- Rollback (nur wenn kein v1.57.0-Code mehr läuft):
--   DROP TABLE trade_attribution_entries; DROP TABLE trade_attributions;
-- Beide Tabellen sind rein additiv — ihr Drop stellt den v1.56.x-Stand her;
-- Journal- und Positionsdaten bleiben unverändert. Umgekehrt gilt: alte
-- Versionen ignorieren die Tabellen einfach (kein Lesepfad).
-- Ein Roll-Zurück-MIGRIEREN historischer Attributionen ist nicht nötig und
-- nicht vorgesehen (append-only).

BEGIN;

CREATE TABLE IF NOT EXISTS "trade_attributions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "journal_id" uuid NOT NULL REFERENCES "trade_journal"("id"),
  "position_id" uuid NOT NULL,
  "method_version" integer NOT NULL,
  "status" text NOT NULL,
  "unattributable_reason" text,
  "snapshot_hash" text NOT NULL,
  "snapshot_schema_version" integer NOT NULL,
  "symbol" text NOT NULL,
  "side" text NOT NULL,
  "regime" text NOT NULL,
  "closed_at" timestamp with time zone NOT NULL,
  "pnl_gross" numeric NOT NULL,
  "fees" numeric,
  "funding" numeric,
  "slippage_memo" numeric,
  "pnl_net" numeric NOT NULL,
  "sources_sum" numeric NOT NULL,
  "costs_sum" numeric NOT NULL,
  "residual" numeric NOT NULL,
  "unknown_costs" text[] NOT NULL DEFAULT '{}'::text[],
  "participants" integer NOT NULL DEFAULT 0,
  "abstentions" integer NOT NULL DEFAULT 0,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trade_attribution_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "attribution_id" uuid NOT NULL REFERENCES "trade_attributions"("id"),
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_version" text NOT NULL,
  "role" text,
  "alignment" integer NOT NULL,
  "weight" numeric,
  "contribution" numeric NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_method_version_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_method_version_check"
      CHECK ("method_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_status_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_status_check"
      CHECK ("status" IN ('ATTRIBUTED', 'UNATTRIBUTABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_reason_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_reason_check"
      CHECK (("status" = 'UNATTRIBUTABLE' AND "unattributable_reason" IN ('SNAPSHOT_MISSING','SNAPSHOT_SCHEMA_V1','SNAPSHOT_INVALID','NO_SOURCES'))
          OR ("status" = 'ATTRIBUTED' AND "unattributable_reason" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_side_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_side_check"
      CHECK ("side" IN ('LONG', 'SHORT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_schema_version_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_schema_version_check"
      CHECK ("snapshot_schema_version" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_participants_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_participants_check"
      CHECK ("participants" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_abstentions_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_abstentions_check"
      CHECK ("abstentions" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_fees_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_fees_check"
      CHECK ("fees" IS NULL OR "fees" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_slippage_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_slippage_check"
      CHECK ("slippage_memo" IS NULL OR "slippage_memo" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attributions_unknown_costs_check') THEN
    ALTER TABLE "trade_attributions" ADD CONSTRAINT "trade_attributions_unknown_costs_check"
      CHECK ("unknown_costs" <@ ARRAY['FEES','FUNDING']::text[]);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attribution_entries_type_check') THEN
    ALTER TABLE "trade_attribution_entries" ADD CONSTRAINT "trade_attribution_entries_type_check"
      CHECK ("source_type" IN ('AGENT', 'RULE', 'COST'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attribution_entries_alignment_check') THEN
    ALTER TABLE "trade_attribution_entries" ADD CONSTRAINT "trade_attribution_entries_alignment_check"
      CHECK ("alignment" IN (-1, 0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attribution_entries_weight_check') THEN
    ALTER TABLE "trade_attribution_entries" ADD CONSTRAINT "trade_attribution_entries_weight_check"
      CHECK ("weight" IS NULL OR ("weight" >= 0 AND "weight" <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_attribution_entries_source_id_check') THEN
    ALTER TABLE "trade_attribution_entries" ADD CONSTRAINT "trade_attribution_entries_source_id_check"
      CHECK (length("source_id") > 0 AND length("source_id") <= 200);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "trade_attributions_journal_method_unique"
  ON "trade_attributions" ("journal_id", "method_version");
CREATE UNIQUE INDEX IF NOT EXISTS "trade_attribution_entries_source_unique"
  ON "trade_attribution_entries" ("attribution_id", "source_type", "source_id");

CREATE INDEX IF NOT EXISTS "trade_attributions_closed_idx" ON "trade_attributions" ("closed_at", "id");
CREATE INDEX IF NOT EXISTS "trade_attributions_symbol_idx" ON "trade_attributions" ("symbol", "closed_at");
CREATE INDEX IF NOT EXISTS "trade_attributions_regime_idx" ON "trade_attributions" ("regime", "closed_at");
CREATE INDEX IF NOT EXISTS "trade_attributions_status_idx" ON "trade_attributions" ("method_version", "status");
CREATE INDEX IF NOT EXISTS "trade_attributions_position_idx" ON "trade_attributions" ("position_id");
CREATE INDEX IF NOT EXISTS "trade_attribution_entries_source_idx" ON "trade_attribution_entries" ("source_type", "source_id");

-- ── Unveränderlichkeit (append-only-Vertrag) ────────────────────────────────
-- Attributionen sind Beweismaterial: UPDATE/DELETE/TRUNCATE werden auf DB-
-- Ebene abgelehnt (Muster execution_quality_immutable). Korrekturen erfolgen
-- als NEUE Zeile mit neuer Methodenversion — nie als Umschreiben.
CREATE OR REPLACE FUNCTION trade_attribution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'trade attribution is append-only'; END $$;

DROP TRIGGER IF EXISTS trade_attributions_immutable ON "trade_attributions";
CREATE TRIGGER trade_attributions_immutable BEFORE UPDATE OR DELETE ON "trade_attributions"
FOR EACH ROW EXECUTE FUNCTION trade_attribution_immutable();
DROP TRIGGER IF EXISTS trade_attributions_no_truncate ON "trade_attributions";
CREATE TRIGGER trade_attributions_no_truncate BEFORE TRUNCATE ON "trade_attributions"
FOR EACH STATEMENT EXECUTE FUNCTION trade_attribution_immutable();

DROP TRIGGER IF EXISTS trade_attribution_entries_immutable ON "trade_attribution_entries";
CREATE TRIGGER trade_attribution_entries_immutable BEFORE UPDATE OR DELETE ON "trade_attribution_entries"
FOR EACH ROW EXECUTE FUNCTION trade_attribution_immutable();
DROP TRIGGER IF EXISTS trade_attribution_entries_no_truncate ON "trade_attribution_entries";
CREATE TRIGGER trade_attribution_entries_no_truncate BEFORE TRUNCATE ON "trade_attribution_entries"
FOR EACH STATEMENT EXECUTE FUNCTION trade_attribution_immutable();

COMMIT;

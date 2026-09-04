-- C4 (v1.36.16) — Control-Plane-Zustand persistieren (additiv, kein Bruch).
--
-- Erzeugt mit `npx drizzle-kit generate` aus src/db/schema.ts (Tabelle
-- `venueControlState`) und auf die eine neue Tabelle reduziert. Das Projekt
-- deployt Schemata regulaer per `npx drizzle-kit push`; diese Datei ist der
-- aequivalente, idempotente SQL-Pfad fuer Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-04_c4_venue_control_state.sql`).
--
-- Inhalt ist status-only (Ebenen, Rechte-NAMEN, Zaehler, Zeitstempel,
-- SAFE-Fehlercodes) — NIE Secret-Inhalt, kein Envelope, kein keyHint.
-- `live_enabled` ist eine informative Momentaufnahme; die Freigabe-Wahrheit
-- bleibt der Live-Gate-Enforcer.
CREATE TABLE IF NOT EXISTS "venue_control_state" (
	"venue" text PRIMARY KEY NOT NULL,
	"configured" boolean DEFAULT false NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"live_enabled" boolean DEFAULT false NOT NULL,
	"last_probe" timestamp with time zone,
	"connection_state" text DEFAULT 'off' NOT NULL,
	"discovery_state" text DEFAULT 'off' NOT NULL,
	"discovery_count" integer DEFAULT 0 NOT NULL,
	"discovery_last_sync" timestamp with time zone,
	"last_error" text,
	"layers" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

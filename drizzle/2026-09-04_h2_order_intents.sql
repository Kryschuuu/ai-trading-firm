-- H2 (v1.36.19) — Order-Intents fuer die atomare Reservierung ueber Prozesse
-- hinweg (additiv, kein Bruch).
--
-- Erzeugt mit `npx drizzle-kit generate` aus src/db/schema.ts (Tabelle
-- `orderIntents`) und auf die eine neue Tabelle reduziert. Das Projekt
-- deployt Schemata regulaer per `npx drizzle-kit push`; diese Datei ist der
-- aequivalente, idempotente SQL-Pfad fuer Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-04_h2_order_intents.sql`).
--
-- Semantik: hoechstens EINE Zeile mit status='RESERVED' pro Symbol — der
-- partielle UNIQUE-Index macht "kein zweiter offener Slot fuer dasselbe
-- Symbol" zu einer DB-Garantie, nicht nur einer In-Memory-Pruefung
-- (src/lib/broker.ts, withAccountLock + submitAtomic).
CREATE TABLE IF NOT EXISTS "order_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account" text DEFAULT 'PAPER' NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"qty" numeric NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_intents_reserved_symbol_unique"
	ON "order_intents" USING btree ("symbol")
	WHERE "status" = 'RESERVED';

CREATE INDEX IF NOT EXISTS "order_intents_account_idx"
	ON "order_intents" USING btree ("account", "created_at");

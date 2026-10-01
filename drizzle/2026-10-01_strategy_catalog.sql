-- Bootstrap: LEER starten. Keine Definitionen/Versionen backfillen.
-- STX-04-01 (Phase 4, Paket 03-09, Finding STX-06) — persistierte
-- Strategie-Definitionen und unveränderliche, versionierte Strategie-Artefakte.
-- Additiv und append-only: nur zwei neue Tabellen, keine bestehenden Tabellen
-- oder Migrationen werden geändert; es gibt keinen Backfill.
--
-- `strategy_definitions.template_id` ist ein FK-Kandidat auf den
-- code-owned Template-Katalog, absichtlich aber kein DB-FK: der Katalog lebt
-- im Anwendungscode.
--
-- `strategy_versions` speichert die kompilierten Parameter und die
-- sanitized RuleSpec (03-09) samt Template-/Code-Version, Fingerprint und
-- Content-Hash. `content_hash` ist UNIQUE, damit Retries/Replays denselben
-- versionierten Inhalt idempotent erkennen und keine Dubletten persistieren;
-- der Hash ersetzt nicht die fachliche `fingerprint`-Identität.
--
-- Anwendung (beide Pfade erzeugen dasselbe Schema; diese SQL-Datei ist
-- idempotent und kann mehrfach ausgeführt werden):
--   psql "$DATABASE_URL" -f drizzle/2026-10-01_strategy_catalog.sql
--   npx drizzle-kit push  (aus `src/db/schema.ts`)
--
-- Rollback (nur auf einer Wegwerf-DB bzw. nach gestoppten Lesern/Schreibern):
--   DROP TABLE IF EXISTS "strategy_versions";
--   DROP TABLE IF EXISTS "strategy_definitions";
-- Der Lifecycle-Risikofaktor ist davon unabhängig: `strategy_lifecycle_*`
-- bleibt bestehen und sein `risk_scale`-Verhalten ändert sich durch diesen
-- Rollback nicht. Die Lifecycle-Tabellen werden hier nicht verändert. Der
-- optionale Lifecycle-FK bleibt wegen des ausdrücklichen Locks ausgeschlossen;
-- eine erneute Prüfung erfordert einen separat abgestimmten Scope.

CREATE TABLE IF NOT EXISTS "strategy_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" text NOT NULL,
  "strategy_class" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "created_by" text NOT NULL DEFAULT 'system',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_definitions_template_name_unique"
  ON "strategy_definitions" ("template_id", "name");

DO $$ BEGIN
  ALTER TABLE "strategy_definitions"
    ADD CONSTRAINT "strategy_definitions_template_id_shape"
    CHECK ("template_id" ~ '^[a-z0-9-]{3,64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_definitions"
    ADD CONSTRAINT "strategy_definitions_strategy_class_check"
    CHECK ("strategy_class" IN ('mean-reversion','trend','breakout'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "strategy_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "definition_id" uuid NOT NULL
    CONSTRAINT "strategy_versions_definition_id_strategy_definitions_id_fk"
    REFERENCES "strategy_definitions"("id"),
  "version" integer NOT NULL,
  "params_json" jsonb NOT NULL,
  "rule_spec_json" jsonb NOT NULL,
  "timeframe" text NOT NULL,
  "fingerprint" text NOT NULL,
  "content_hash" text NOT NULL,
  "code_version" text NOT NULL,
  "template_version" integer NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_versions_definition_version_unique"
  ON "strategy_versions" ("definition_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_versions_fingerprint_unique"
  ON "strategy_versions" ("fingerprint");
-- UNIQUE(content_hash) ist der Retry-/Replay-Idempotenzanker: gleicher
-- Artefaktinhalt darf nicht ein zweites Mal persistiert werden.
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_versions_content_hash_unique"
  ON "strategy_versions" ("content_hash");
CREATE INDEX IF NOT EXISTS "strategy_versions_definition_created_at_idx"
  ON "strategy_versions" ("definition_id", "created_at" DESC NULLS LAST);

DO $$ BEGIN
  ALTER TABLE "strategy_versions"
    ADD CONSTRAINT "strategy_versions_version_check"
    CHECK ("version" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_versions"
    ADD CONSTRAINT "strategy_versions_timeframe_check"
    CHECK ("timeframe" IN ('1m','3m','5m','15m','30m','1h','2h','4h','1d','5d'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_versions"
    ADD CONSTRAINT "strategy_versions_content_hash_check"
    CHECK ("content_hash" ~ '^stv1:[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/**
 * STX-04-01: Strategy-Katalog + immutable Version-Artefakte (Postgres).
 *
 * Prüft die additive Migration zweimal, Constraints/Idempotenz sowie den
 * dokumentierten Rollback auf einer separaten Wegwerf-Datenbank.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import EmbeddedPostgres from "embedded-postgres";
import type { Pool as PoolType } from "pg";
import { Pool } from "pg";

const PG_PORT = 55_452;
const DB_NAME = "strategy_catalog_test";
const ROLLBACK_DB_NAME = "strategy_catalog_rollback_test";
const MIGRATION_FILE = "2026-10-01_strategy_catalog.sql";
const LIFECYCLE_STATE_ID = randomUUID();

type DefinitionInput = {
  templateId?: string;
  strategyClass?: string;
  name?: string;
  description?: string;
};

type VersionInput = {
  definitionId: string;
  version?: number;
  paramsJson?: unknown;
  ruleSpecJson?: unknown;
  timeframe?: string;
  fingerprint?: string;
  contentHash?: string;
  codeVersion?: string;
  templateVersion?: number;
  createdBy?: string;
};

let pg: EmbeddedPostgres | null = null;
let pool: PoolType | null = null;
let rollbackPool: PoolType | null = null;
let startupError: Error | null = null;
let migrationSql = "";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function newFingerprint(): string {
  return `stc1:${sha256(randomUUID())}`;
}

function newContentHash(): string {
  return `stv1:${sha256(randomUUID())}`;
}

function migration(): string {
  return readFileSync(path.join(process.cwd(), "drizzle", MIGRATION_FILE), "utf8");
}

async function insertDefinition(db: PoolType, input: DefinitionInput = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO strategy_definitions
       (id, template_id, strategy_class, name, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      input.templateId ?? "rsi-mean-reversion",
      input.strategyClass ?? "mean-reversion",
      input.name ?? `definition-${randomUUID()}`,
      input.description ?? "Persisted strategy definition for database tests",
    ],
  );
  return id;
}

async function insertVersion(db: PoolType, input: VersionInput): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO strategy_versions
       (id, definition_id, version, params_json, rule_spec_json, timeframe,
        fingerprint, content_hash, code_version, template_version, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      input.definitionId,
      input.version ?? 1,
      JSON.stringify(input.paramsJson ?? { fast: 12, slow: 26 }),
      JSON.stringify(input.ruleSpecJson ?? { window: { timeframe: input.timeframe ?? "1h" } }),
      input.timeframe ?? "1h",
      input.fingerprint ?? newFingerprint(),
      input.contentHash ?? newContentHash(),
      input.codeVersion ?? "0.7.6-test",
      input.templateVersion ?? 1,
      input.createdBy ?? "test-agent",
    ],
  );
  return id;
}

describe("strategy_definitions + strategy_versions (Postgres): STX-04-01", () => {
  before(async () => {
    try {
      migrationSql = migration();
      const instance = new EmbeddedPostgres({
        databaseDir: mkdtempSync(path.join(tmpdir(), "strategy-catalog-pg-")),
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
        onLog: () => {},
        onError: () => {},
      });
      pg = instance;
      await instance.initialise();
      await instance.start();
      await instance.createDatabase(DB_NAME);
      await instance.createDatabase(ROLLBACK_DB_NAME);

      const connect = (database: string) =>
        new Pool({
          host: "127.0.0.1",
          port: PG_PORT,
          user: "postgres",
          password: "postgres",
          database,
          max: 4,
        });
      pool = connect(DB_NAME);
      rollbackPool = connect(ROLLBACK_DB_NAME);

      // Bestehende Lifecycle-Zeile repräsentativ vor der additiven Migration
      // anlegen: der Catalog darf sie weder verändern noch ungültig machen.
      await pool.query(`
        CREATE TABLE strategy_lifecycle_states (
          id uuid PRIMARY KEY,
          strategy_key text NOT NULL,
          strategy_version integer NOT NULL CHECK (strategy_version >= 1),
          state text NOT NULL
        )
      `);
      await pool.query(
        `INSERT INTO strategy_lifecycle_states (id, strategy_key, strategy_version, state)
         VALUES ($1, 'legacy-strategy', 3, 'DRAFT')`,
        [LIFECYCLE_STATE_ID],
      );

      await pool.query(migrationSql);
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error));
    }
  });

  after(async () => {
    await pool?.end().catch(() => undefined);
    await rollbackPool?.end().catch(() => undefined);
    await pg?.stop().catch(() => undefined);
  });

  it("Migration ist idempotent: zweites Anwenden erzeugt keinen Fehler", async (t) => {
    if (!pool) return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);

    await assert.doesNotReject(pool.query(migrationSql));
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('strategy_definitions', 'strategy_versions')
       ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), ["strategy_definitions", "strategy_versions"]);
  });

  it("Definitionen und Versionen roundtrippen vollständig; ein Template erlaubt mehrere Namen", async (t) => {
    if (!pool) return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);

    const templateId = "ema-adx-trend";
    const btcDefinitionId = await insertDefinition(pool, {
      templateId,
      strategyClass: "trend",
      name: "BTC-EMA",
      description: "EMA trend definition for BTC",
    });
    const ethDefinitionId = await insertDefinition(pool, {
      templateId,
      strategyClass: "trend",
      name: "ETH-EMA",
      description: "EMA trend definition for ETH",
    });
    const params = { fastPeriod: 12, slowPeriod: 26 };
    const ruleSpec = { action: { side: "LONG" }, window: { timeframe: "1h" } };
    const fingerprint = newFingerprint();
    const contentHash = newContentHash();
    const versionId = await insertVersion(pool, {
      definitionId: btcDefinitionId,
      version: 1,
      paramsJson: params,
      ruleSpecJson: ruleSpec,
      timeframe: "1h",
      fingerprint,
      contentHash,
      codeVersion: "0.7.6-stx-test",
      templateVersion: 2,
      createdBy: "research-agent",
    });

    const result = await pool.query(
      `SELECT d.template_id, d.strategy_class, d.name, d.description,
              d.created_by AS definition_created_by, d.created_at AS definition_created_at,
              v.version, v.params_json, v.rule_spec_json, v.timeframe, v.fingerprint,
              v.content_hash, v.code_version, v.template_version, v.created_by,
              v.created_at
       FROM strategy_definitions d
       JOIN strategy_versions v ON v.definition_id = d.id
       WHERE d.id = $1 AND v.id = $2`,
      [btcDefinitionId, versionId],
    );
    assert.equal(result.rowCount, 1);
    const row = result.rows[0];
    assert.equal(row.template_id, templateId);
    assert.equal(row.strategy_class, "trend");
    assert.equal(row.name, "BTC-EMA");
    assert.equal(row.description, "EMA trend definition for BTC");
    assert.equal(row.definition_created_by, "system", "Definition nutzt den dokumentierten Default");
    assert.ok(row.definition_created_at instanceof Date);
    assert.equal(Number(row.version), 1);
    assert.deepEqual(row.params_json, params);
    assert.deepEqual(row.rule_spec_json, ruleSpec);
    assert.equal(row.timeframe, "1h");
    assert.equal(row.fingerprint, fingerprint);
    assert.equal(row.content_hash, contentHash);
    assert.equal(row.code_version, "0.7.6-stx-test");
    assert.equal(Number(row.template_version), 2);
    assert.equal(row.created_by, "research-agent");
    assert.ok(row.created_at instanceof Date);

    const sameTemplateDifferentNames = await pool.query(
      `SELECT count(*)::int AS count FROM strategy_definitions
       WHERE template_id = $1 AND id = ANY($2::uuid[])`,
      [templateId, [btcDefinitionId, ethDefinitionId]],
    );
    assert.equal(sameTemplateDifferentNames.rows[0].count, 2);
  });

  it("Lifecycle-Zeilen bleiben unverändert gültig; die Migration fasst lifecycle_* nicht an", async (t) => {
    if (!pool) return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);

    const row = await pool.query(
      `SELECT id, strategy_key, strategy_version, state
       FROM strategy_lifecycle_states WHERE id = $1`,
      [LIFECYCLE_STATE_ID],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].strategy_key, "legacy-strategy");
    assert.equal(row.rows[0].strategy_version, 3);
    assert.equal(row.rows[0].state, "DRAFT");
  });

  it("CHECK-Constraints verwerfen Version 0, unclassified, ungültige Template-IDs, Timeframes und Hashes", async (t) => {
    if (!pool) return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);

    const definitionId = await insertDefinition(pool);
    await assert.rejects(
      insertVersion(pool, { definitionId, version: 0 }),
      /strategy_versions_version_check/,
    );
    await assert.rejects(
      insertDefinition(pool, { strategyClass: "unclassified" }),
      /strategy_definitions_strategy_class_check/,
    );
    await assert.rejects(
      insertDefinition(pool, { templateId: "Bad Id" }),
      /strategy_definitions_template_id_shape/,
    );
    await assert.rejects(
      insertVersion(pool, { definitionId, contentHash: "stv1:BAD" }),
      /strategy_versions_content_hash_check/,
    );
    await assert.rejects(
      insertVersion(pool, { definitionId, timeframe: "1H" }),
      /strategy_versions_timeframe_check/,
    );
  });

  it("UNIQUE(fingerprint) und UNIQUE(definition_id, version) verhindern Doppelpersistenz", async (t) => {
    if (!pool) return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);

    const sharedFingerprint = newFingerprint();
    const firstDefinitionId = await insertDefinition(pool);
    const secondDefinitionId = await insertDefinition(pool);
    await insertVersion(pool, { definitionId: firstDefinitionId, fingerprint: sharedFingerprint });
    await assert.rejects(
      insertVersion(pool, { definitionId: secondDefinitionId, fingerprint: sharedFingerprint }),
      /strategy_versions_fingerprint_unique/,
    );

    const versionedDefinitionId = await insertDefinition(pool);
    await insertVersion(pool, { definitionId: versionedDefinitionId, version: 1 });
    await assert.rejects(
      insertVersion(pool, { definitionId: versionedDefinitionId, version: 1 }),
      /strategy_versions_definition_version_unique/,
    );
  });

  it("UNIQUE(content_hash) macht identische Retry-/Replay-Inhalte idempotent", async (t) => {
    if (!pool) return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);

    const sharedContentHash = newContentHash();
    const firstDefinitionId = await insertDefinition(pool);
    const secondDefinitionId = await insertDefinition(pool);
    await insertVersion(pool, { definitionId: firstDefinitionId, contentHash: sharedContentHash });
    await assert.rejects(
      insertVersion(pool, { definitionId: secondDefinitionId, contentHash: sharedContentHash }),
      /strategy_versions_content_hash_unique/,
    );
  });

  it("Rollback-Kommentarbefehle funktionieren in umgekehrter Reihenfolge auf einer Wegwerf-DB", async (t) => {
    if (!rollbackPool) {
      return t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
    }

    await rollbackPool.query(migrationSql);
    await rollbackPool.query(migrationSql);
    const definitionId = await insertDefinition(rollbackPool, {
      templateId: "rollback-test",
      name: "temporary strategy",
    });
    await insertVersion(rollbackPool, { definitionId });

    const rollbackBlock = migrationSql.match(/-- Rollback[\s\S]*?(?=\n-- Der Lifecycle-Risikofaktor)/)?.[0];
    assert.ok(rollbackBlock, "Rollback-Block im SQL-Kommentar ist dokumentiert");
    const statements = rollbackBlock
      .split("\n")
      .map((line) => line.match(/^\s*--\s*(DROP TABLE IF EXISTS "[^"]+";)\s*$/)?.[1])
      .filter((statement): statement is string => Boolean(statement));
    assert.deepEqual(statements, [
      'DROP TABLE IF EXISTS "strategy_versions";',
      'DROP TABLE IF EXISTS "strategy_definitions";',
    ]);

    await rollbackPool.query(statements.join("\n"));
    const remaining = await rollbackPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('strategy_definitions', 'strategy_versions')`,
    );
    assert.equal(remaining.rowCount, 0, "beide Tabellen sind entfernt; der Katalog-DB-Zustand ist zurückgerollt");
  });
});

/**
 * STX-04-02: Tests für Strategy-Catalog-Service + Lifecycle-Bridging.
 *
 * Akzeptanzkriterien & Tests:
 * 1. Idempotenz: 3x createVersion mit identischen Params => 1 Zeile, gleicher versionId
 * 2. Transaktion: Compile-Error => wirft Error, 0 Zeilen in beiden Tabellen (Rollback)
 * 3. strategyKeyFor gegen normalizeStrategyKey für alle 6 Template-IDs
 * 4. Drift: Katalog-Version manuell erhöhen (oder alte template_version) => TEMPLATE_ADVANCED
 * 5. Versions-Kette: v1 -> v2 erzeugen; v1 bleibt unverändert lesbar
 * 6. strategy_lifecycle_states-Zeile existiert nach createVersion mit Zustand DRAFT
 * 7. Audit-Eintrag + Telemetrie mit bounded Labels
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import EmbeddedPostgres from "embedded-postgres";
import type { Pool as PoolType } from "pg";
import { Pool } from "pg";

import { STRATEGY_TEMPLATES, STRATEGY_TEMPLATE_IDS } from "../src/strategies/catalog";
import { STRATEGY_CLASSES } from "../src/lib/marketRegime";
import { normalizeStrategyKey } from "../src/strategyLifecycle/evidence";
import { resetTelemetryForTests, telemetry } from "../src/lib/telemetry";
import { setAuditTransportForTests } from "../src/lib/auditSink";

const PG_PORT = 55_453;
const DB_NAME = "strategy_catalog_service_test";

let pg: EmbeddedPostgres | null = null;
let pool: PoolType | null = null;
let svc: typeof import("../src/strategies/service");

describe("STX-04-02: Strategy Catalog Service & Lifecycle Bridging", () => {
  before(async () => {
    const instance = new EmbeddedPostgres({
      databaseDir: mkdtempSync(path.join(tmpdir(), "strategy-svc-pg-")),
      user: "postgres",
      password: "postgres",
      port: PG_PORT,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    pg = instance;
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(DB_NAME);

    const connectionString = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
    process.env.DATABASE_URL = connectionString;
    pool = new Pool({ connectionString });

    // backtest_runs (FK Ziel von strategy_lifecycle_evidence)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        instrument_id text NOT NULL,
        timeframe text NOT NULL,
        from_ts timestamptz NOT NULL,
        to_ts timestamptz NOT NULL,
        params_json jsonb NOT NULL,
        metrics_json jsonb NOT NULL,
        windows_json jsonb NOT NULL,
        code_version text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Lifecycle-Tabellen anlegen
    const lifecycleSql = readFileSync(
      path.join(process.cwd(), "drizzle", "2026-09-23_strategy_lifecycle.sql"),
      "utf8"
    );
    await pool.query(lifecycleSql);

    // Catalog-Tabellen anlegen
    const catalogSql = readFileSync(
      path.join(process.cwd(), "drizzle", "2026-10-01_strategy_catalog.sql"),
      "utf8"
    );
    await pool.query(catalogSql);

    // Audit-Log Tabelle
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event text NOT NULL,
        level text NOT NULL,
        detail jsonb NOT NULL,
        mission_id uuid,
        agent_id uuid,
        audit_class text NOT NULL DEFAULT 'telemetry',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Service importieren
    svc = await import("../src/strategies/service");
  });

  after(async () => {
    setAuditTransportForTests(null);
    await pool?.end();
    if (pg) await pg.stop();
  });

  beforeEach(() => {
    resetTelemetryForTests();
  });

  it("strategyKeyFor erzeugt für alle 6 Template-IDs gültige Keys, die normalizeStrategyKey passieren", () => {
    for (const tid of STRATEGY_TEMPLATE_IDS) {
      const key = svc.strategyKeyFor({ templateId: tid, version: 1 });
      assert.equal(key, `${tid}@v1`);
      const normalized = normalizeStrategyKey(key);
      assert.equal(normalized, key);
      assert.ok(normalized !== null);
    }
  });

  it("ensureDefinition legt Zeile an und ist idempotent über (template_id, name)", async () => {
    const d1 = await svc.ensureDefinition({
      templateId: "rsi-mean-reversion",
      name: "BTC RSI Mean Reversion",
      description: "Default BTC mean reversion setup",
      createdBy: "researcher-1",
    });

    assert.ok(d1.id);
    assert.equal(d1.templateId, "rsi-mean-reversion");
    assert.equal(d1.name, "BTC RSI Mean Reversion");
    assert.equal(d1.strategyClass, "mean-reversion");

    const d2 = await svc.ensureDefinition({
      templateId: "rsi-mean-reversion",
      name: "BTC RSI Mean Reversion",
      description: "Andere Beschreibung sollte bestehende Zeile nicht ändern",
    });

    assert.equal(d2.id, d1.id);
    assert.equal(d2.createdAt.toISOString(), d1.createdAt.toISOString());
  });

  it("ensureDefinition akzeptiert alle Klassen aus der gemeinsamen SSoT (ADR-008)", async () => {
    for (const strategyClass of STRATEGY_CLASSES) {
      const template = STRATEGY_TEMPLATES.find((candidate) => candidate.class === strategyClass);
      assert.ok(template, `Katalog braucht ein Template für ${strategyClass}`);
      const row = await svc.ensureDefinition({
        templateId: template.id,
        strategyClass,
        name: `Explicit SSoT class ${strategyClass}`,
      });
      assert.equal(row.strategyClass, strategyClass);
    }
  });

  it("ensureDefinition lehnt unclassified und Fremd-Klassen vor dem DB-Insert ab", async () => {
    for (const strategyClass of ["unclassified", "momentum", "TREND", "__proto__"]) {
      const name = `Rejected class ${strategyClass}`;
      await assert.rejects(
        svc.ensureDefinition({ templateId: "ema-adx-trend", strategyClass, name }),
        /ensureDefinition: Ungültige oder fehlende strategyClass/
      );
      const rows = await pool!.query("SELECT id FROM strategy_definitions WHERE name = $1", [name]);
      assert.equal(rows.rowCount, 0, "ungültige Klasse darf keine Definition erzeugen");
    }
  });

  it("Idempotenz: 3x createVersion mit identischen Params erzeugt genau 1 Version und 1 Lifecycle-Draft", async () => {
    const def = await svc.ensureDefinition({
      templateId: "ema-adx-trend",
      name: "EMA Trend Alpha",
    });

    const v1 = await svc.createVersion({
      definitionId: def.id,
      templateId: "ema-adx-trend",
      symbol: "BTC/USDT",
      timeframe: "1h",
      params: { adxMin: 22, ema50BufferPct: 0.5, volumeRatioMin: 1.1, stopLossPct: 3, takeProfitRR: 2 },
      createdBy: "operator-1",
    });

    assert.equal(v1.created, true);
    assert.equal(v1.version, 1);

    const v2 = await svc.createVersion({
      definitionId: def.id,
      templateId: "ema-adx-trend",
      symbol: "BTC/USDT",
      timeframe: "1h",
      params: { adxMin: 22, ema50BufferPct: 0.5, volumeRatioMin: 1.1, stopLossPct: 3, takeProfitRR: 2 },
      createdBy: "operator-1",
    });

    const v3 = await svc.createVersion({
      definitionId: def.id,
      templateId: "ema-adx-trend",
      symbol: "BTC/USDT",
      timeframe: "1h",
      params: { adxMin: 22, ema50BufferPct: 0.5, volumeRatioMin: 1.1, stopLossPct: 3, takeProfitRR: 2 },
    });

    assert.equal(v2.created, false);
    assert.equal(v3.created, false);
    assert.equal(v2.versionId, v1.versionId);
    assert.equal(v3.versionId, v1.versionId);
    assert.equal(v2.fingerprint, v1.fingerprint);

    // Prüfe Zeilen in der DB
    const versRows = await pool!.query(
      `SELECT * FROM strategy_versions WHERE definition_id = $1`,
      [def.id]
    );
    assert.equal(versRows.rowCount, 1);

    const expectedKey = `ema-adx-trend@v1`;
    const lcRows = await pool!.query(
      `SELECT * FROM strategy_lifecycle_states WHERE strategy_key = $1 AND strategy_version = $2`,
      [expectedKey, 1]
    );
    assert.equal(lcRows.rowCount, 1);
    assert.equal(lcRows.rows[0].state, "DRAFT");

    // Telemetrie prüfen
    assert.equal(telemetry.strategyLifecycle.versions.total(), 3);
    const byDim = telemetry.strategyLifecycle.versions.byDimension("result");
    assert.equal(byDim.created, 1);
    assert.equal(byDim.duplicate, 2);
  });

  it("Transaktion: Compile-Error wirft und erzeugt 0 Zeilen in beiden Tabellen", async () => {
    const def = await svc.ensureDefinition({
      templateId: "macd-momentum",
      name: "MACD Test",
    });

    const versBefore = await pool!.query(`SELECT count(*) FROM strategy_versions`);
    const lcBefore = await pool!.query(`SELECT count(*) FROM strategy_lifecycle_states`);

    await assert.rejects(
      svc.createVersion({
        definitionId: def.id,
        templateId: "macd-momentum",
        symbol: "BTC/USDT",
        // 5m wird von macd-momentum nicht unterstützt (nur 1h, 4h)
        timeframe: "5m" as any,
      }),
      /Template-Kompilierung fehlgeschlagen/
    );

    const versAfter = await pool!.query(`SELECT count(*) FROM strategy_versions`);
    const lcAfter = await pool!.query(`SELECT count(*) FROM strategy_lifecycle_states`);

    assert.equal(versAfter.rows[0].count, versBefore.rows[0].count);
    assert.equal(lcAfter.rows[0].count, lcBefore.rows[0].count);
  });

  it("Versions-Kette: v1 -> v2 erzeugen; v1 bleibt unverändert lesbar", async () => {
    const def = await svc.ensureDefinition({
      templateId: "donchian-breakout",
      name: "Donchian Breakout Chain",
    });

    const v1 = await svc.createVersion({
      definitionId: def.id,
      templateId: "donchian-breakout",
      symbol: "ETH/USDT",
      timeframe: "1h",
      params: { adxMin: 20, breakoutMinPct: 0.5, volumeRatioMin: 1.2, stopLossPct: 4, takeProfitRR: 2 },
    });
    assert.equal(v1.version, 1);

    const v2 = await svc.createVersion({
      definitionId: def.id,
      templateId: "donchian-breakout",
      symbol: "ETH/USDT",
      timeframe: "1h",
      params: { adxMin: 25, breakoutMinPct: 0.8, volumeRatioMin: 1.5, stopLossPct: 4, takeProfitRR: 2.5 },
    });
    assert.equal(v2.version, 2);

    const list = await svc.listVersions(def.id);
    assert.equal(list.length, 2);
    // listVersions sortiert desc nach createdAt
    const loadedV1 = list.find((v) => v.version === 1);
    const loadedV2 = list.find((v) => v.version === 2);
    assert.ok(loadedV1);
    assert.ok(loadedV2);
    assert.deepEqual(loadedV1.paramsJson, { adxMin: 20, breakoutMinPct: 0.5, volumeRatioMin: 1.2, stopLossPct: 4, takeProfitRR: 2 });
    assert.deepEqual(loadedV2.paramsJson, { adxMin: 25, breakoutMinPct: 0.8, volumeRatioMin: 1.5, stopLossPct: 4, takeProfitRR: 2.5 });

    // resolveStrategyKey
    const res1 = await svc.resolveStrategyKey(v1.versionId);
    assert.ok(res1);
    assert.equal(res1.strategyKey, "donchian-breakout@v1");
    assert.equal(res1.strategyVersion, 1);

    const res2 = await svc.resolveStrategyKey(v2.versionId);
    assert.ok(res2);
    assert.equal(res2.strategyKey, "donchian-breakout@v2");
    assert.equal(res2.strategyVersion, 2);
  });

  it("checkTemplateDrift: erkennt CURRENT, TEMPLATE_ADVANCED und CODE_ADVANCED ohne Änderungen", async () => {
    const def = await svc.ensureDefinition({
      templateId: "bollinger-squeeze",
      name: "Bollinger Drift Test",
    });

    const v = await svc.createVersion({
      definitionId: def.id,
      templateId: "bollinger-squeeze",
      symbol: "SOL/USDT",
      timeframe: "4h",
      params: { adxMin: 22, bbwMaxPct: 3.5, bbZScoreMin: 1.5, volumeRatioMin: 1.2, stopLossPct: 3, takeProfitRR: 2 },
    });

    // 1) CURRENT
    const driftCurrent = await svc.checkTemplateDrift(v.versionId);
    assert.equal(driftCurrent.status, "CURRENT");
    assert.equal(driftCurrent.storedTemplateVersion, 1);

    // 2) TEMPLATE_ADVANCED: simuliere eine Version mit älterer templateVersion in der DB
    await pool!.query(
      `UPDATE strategy_versions SET template_version = 0 WHERE id = $1`,
      [v.versionId]
    );
    const driftTmplAdv = await svc.checkTemplateDrift(v.versionId);
    assert.equal(driftTmplAdv.status, "TEMPLATE_ADVANCED");
    assert.equal(driftTmplAdv.storedTemplateVersion, 0);
    assert.equal(driftTmplAdv.currentTemplateVersion, 1);

    // 3) CODE_ADVANCED: template_version wieder aktuell, aber code_version älter
    await pool!.query(
      `UPDATE strategy_versions SET template_version = 1, code_version = '0.0.1' WHERE id = $1`,
      [v.versionId]
    );
    const driftCodeAdv = await svc.checkTemplateDrift(v.versionId);
    assert.equal(driftCodeAdv.status, "CODE_ADVANCED");
    assert.equal(driftCodeAdv.storedCodeVersion, "0.0.1");

    // Sicherstellen, dass nichts in der DB verändert wurde außer den manuellen Tests
    const rowAfter = await svc.getVersionByFingerprint(v.fingerprint);
    assert.ok(rowAfter);
    assert.equal(rowAfter.id, v.versionId);
  });
});

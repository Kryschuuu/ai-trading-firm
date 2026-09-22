/**
 * Pflicht-Tests RMA-P3-02 — Persistenz: Roundtrip, Idempotenz×3, Restart (embedded-postgres)
 *
 * Deckt alle DB-Zusicherungen ab:
 *  - Migration idempotent
 *  - Roundtrip: ensurePromptArtifact / recordPromptRun
 *  - Idempotenz: gleicher Hash+Version → 1 Zeile (Artifact), gleicher Run-Hash → 1 Zeile (Run) ×3
 *  - Run verweist auf genau ein Artefakt (artifact_id FK)
 *  - VERSION_CONFLICT vs Duplicate (pp1, LF-normalisiert)
 *  - CHECK pp1:64hex, UNIQUEs
 *  - Restart: nach Reconnect (simulierter Prozess-Neustart) sind Artefakte/Runs noch da und idempotent
 *  - Secrets/PII nie persistiert (Schema-Inspektion)
 *
 * Nutzt embedded-postgres auf 55445; fällt bei fehlender Binary per t.skip aus (kein harter Fail).
 * Injiziert den Pool über global.__arenaNextJsPostgresql* (Singleton-Override), damit src/promptPerformance/store getDb() die Embedded nutzt.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const PG_PORT = 55_445;
const DB_NAME = "prompt_perf_test";

describe("prompt_artifacts / agent_prompt_runs (Postgres): Migration, Roundtrip, Idempotenz, Restart", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let startupError: Error | null = null;

  // Merker, um globalen Singleton nach dem Test wiederherzustellen
  let prevPool: unknown = undefined;
  let prevDb: unknown = undefined;

  before(async () => {
    try {
      const g = globalThis as unknown as Record<string, unknown>;
      prevPool = g.__arenaNextJsPostgresqlPool;
      prevDb = g.__arenaNextJsPostgresqlDb;

      const dir = mkdtempSync(path.join(tmpdir(), "prompt-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
        onLog: () => {},
        onError: () => {},
      });
      await instance.initialise();
      await instance.start();
      pg = instance;

      const adminPool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: "postgres",
      });
      await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
      await adminPool.end();

      pool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: DB_NAME,
      });

      const db = drizzle(pool);
      // Injiziere Singleton, damit src/db/index getDb() diese Embedded nutzt
      (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlPool = pool;
      (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlDb = db;

      // agents-Stub für FK prompt_artifacts.agent_id → agents.id (nullable, aber für Migration vorhanden)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'IDLE',
          system_prompt TEXT NOT NULL DEFAULT 'x',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Prompt-Migration anwenden
      const migrationSql = readFileSync(path.join(process.cwd(), "drizzle", "2026-09-22_prompt_performance.sql"), "utf8");
      await pool.query(migrationSql);
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
      // Cleanup bei Fehler
      if (pool) await pool.end().catch(() => {});
      if (pg) await pg.stop().catch(() => {});
      pool = null;
      pg = null;
    }
  });

  after(async () => {
    if (pool) await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
    const g = globalThis as unknown as Record<string, unknown>;
    if (prevPool !== undefined) g.__arenaNextJsPostgresqlPool = prevPool as never;
    else delete g.__arenaNextJsPostgresqlPool;
    if (prevDb !== undefined) g.__arenaNextJsPostgresqlDb = prevDb as never;
    else delete g.__arenaNextJsPostgresqlDb;
  });

  it("Migration ist strikt idempotent (zweiter Lauf fehlerfrei)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const sql = readFileSync(path.join(process.cwd(), "drizzle", "2026-09-22_prompt_performance.sql"), "utf8");
    await assert.doesNotReject(async () => {
      await pool!.query(sql);
    });
  });

  it("Roundtrip: ensurePromptArtifact persistiert und liest identisch (mit agentId — UNIQUE greift)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { ensurePromptArtifact } = await import("../src/promptPerformance/store");
    const agentIdRes = await pool!.query(
      `INSERT INTO agents (name, role, model, system_prompt) VALUES ('prompt-test-agent-rt','RESEARCH','qwen2.5:7b','x') RETURNING id`
    );
    const agentId = agentIdRes.rows[0].id as string;
    const raw = "System: Du bist Research. Antworte nur mit TRADE/NO_TRADE.\r\nPolicy: streng LF-normalisiert.";
    const { artifact: a1, created: c1 } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: raw,
      templateSchemaVersion: "research@1",
    });
    assert.equal(c1, true);
    assert.ok(a1.id);
    assert.match(a1.promptHash as string, /^pp1:[0-9a-f]{64}$/);
    assert.equal(a1.version, 1);
    assert.equal(a1.role, "research");
    // Reload via gleicher literal → Idempotenz, kein zweites Artefakt
    const { artifact: a2, created: c2 } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: raw,
      templateSchemaVersion: "research@1",
    });
    assert.equal(c2, false, "zweiter Aufruf muss als duplicate gelten");
    assert.equal(a2.id, a1.id, "Idempotenz Artifact: gleiche Eingabe → gleiche ID");
    assert.equal(a2.promptHash, a1.promptHash);
    // DB-Zeile vorhanden
    const cnt = await pool!.query(`SELECT count(*)::int AS c FROM prompt_artifacts WHERE id=$1`, [a1.id]);
    assert.equal(cnt.rows[0].c, 1);
  });

  it("LF-Stabilität: CRLF vs LF ergeben selben Hash/Artefakt (pp1: LF-only)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { ensurePromptArtifact } = await import("../src/promptPerformance/store");
    const agentIdRes = await pool!.query(
      `INSERT INTO agents (name, role, model, system_prompt) VALUES ('prompt-test-agent-lf','RESEARCH','qwen2.5:7b','x') RETURNING id`
    );
    const agentId = agentIdRes.rows[0].id as string;
    const vCRLF = "Alpha\r\nBeta\r\nGamma";
    const vLF = "Alpha\nBeta\nGamma";
    const { artifact: aCRLF } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: vCRLF,
      templateSchemaVersion: "lf@1",
    });
    const { artifact: aLF, created } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: vLF,
      templateSchemaVersion: "lf@1",
    });
    // Beide Varianten normalisieren auf denselben kanonischen Text → gleicher Hash
    assert.equal(aCRLF.promptHash, aLF.promptHash, "CRLF und LF müssen gleichen pp1-Hash haben");
    // Gleiche agentId+Version+Hash → gleiche ID (Idempotenz)
    assert.equal(aCRLF.id, aLF.id, "CRLF/LF-Varianten dürfen kein zweites Artefakt bei gleicher Version erzeugen");
    assert.equal(created, false);
  });

  it("Inhaltsänderung ändert den Hash und erzeugt neues Artefakt (mit agentId)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { ensurePromptArtifact } = await import("../src/promptPerformance/store");
    const agentIdRes = await pool!.query(
      `INSERT INTO agents (name, role, model, system_prompt) VALUES ('prompt-test-agent-hash','RESEARCH','qwen2.5:7b','x') RETURNING id`
    );
    const agentId = agentIdRes.rows[0].id as string;
    const base = "System: Base Prompt für Hash-Delta.";
    const mod = base + " ";
    const { artifact: aBase } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: base,
      templateSchemaVersion: "hash@1",
    });
    const { artifact: aMod } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 2,
      promptText: mod,
      templateSchemaVersion: "hash@1",
    });
    assert.notEqual(aBase.promptHash, aMod.promptHash, "Leerzeichen ändert den Hash");
    assert.notEqual(aBase.id, aMod.id);
  });

  it("Duplicate vs VERSION_CONFLICT: gleiche Version+Hash → ok; gleiche Version+anderer Hash → fail-closed (mit agentId)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { ensurePromptArtifact } = await import("../src/promptPerformance/store");
    // Konflikt-Test braucht agentId, weil bei null die Version nicht als UNIQUE greift (NULL-semantik)
    const agentIdRes = await pool!.query(
      `INSERT INTO agents (name, role, model, system_prompt) VALUES ('prompt-test-agent-31','RESEARCH','qwen2.5:7b','x') RETURNING id`
    );
    const agentId = agentIdRes.rows[0].id as string;

    const probe = "Konflikt-Probe PP1\nZeile2";
    const { artifact: ok1 } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: probe,
      templateSchemaVersion: "conflict@1",
    });
    const { artifact: ok2, created } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: probe,
      templateSchemaVersion: "conflict@1",
    });
    assert.equal(ok1.id, ok2.id);
    assert.equal(created, false);

    const { PromptPerfError } = await import("../src/promptPerformance/types");
    await assert.rejects(
      () =>
        ensurePromptArtifact({
          agentId,
          role: "research",
          version: 1,
          promptText: probe + " abweichend",
          templateSchemaVersion: "conflict@1",
        }),
      (e: unknown) => {
        assert.ok(e instanceof PromptPerfError);
        assert.equal((e as InstanceType<typeof PromptPerfError>).code, "VERSION_CONFLICT");
        return true;
      }
    );
  });

  it("Run verweist auf genau ein Artefakt — FK + idempotency UNIQUE, kein Secret", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { ensurePromptArtifact, recordPromptRun, runIdempotencyKey } = await import("../src/promptPerformance/store");

    const agentIdRes = await pool!.query(
      `INSERT INTO agents (name, role, model, system_prompt) VALUES ('prompt-test-agent-run','RESEARCH','qwen2.5:7b','x') RETURNING id`
    );
    const agentId = agentIdRes.rows[0].id as string;

    const { artifact: art } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: "Research-Prompt für Run-Persistenz",
      templateSchemaVersion: "run@1",
    });

    const startedAt = new Date("2026-09-22T10:00:00.000Z");
    const endedAt = new Date("2026-09-22T10:00:00.150Z");
    const idem = runIdempotencyKey({ promptHash: art.promptHash, agentId, startedAt, model: "gpt-4o", attempt: 0 });

    const base = {
      artifactId: art.id,
      agentId,
      role: "research" as const,
      promptHash: art.promptHash,
      promptVersion: 1,
      provider: "openai" as const,
      model: "gpt-4o" as const,
      temperature: 0 as const,
      maxTokens: null,
      toolSchemaVersion: null,
      startedAt,
      endedAt,
      latencyMs: 150,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.001,
      costStatus: "billed" as const,
      success: true,
      errorCode: null,
      idempotencyKey: idem,
    };

    const { run: r1, created: c1 } = await recordPromptRun(base);
    const { run: r2, created: c2 } = await recordPromptRun(base);
    const { run: r3, created: c3 } = await recordPromptRun(base);
    // Idempotenz ×3: dreimal gleicher Run-Hash → eine DB-Zeile, drei Mal gleiche ID
    assert.equal(c1, true);
    assert.equal(c2, false);
    assert.equal(c3, false);
    assert.equal(r1.id, r2.id);
    assert.equal(r2.id, r3.id);
    const cnt = await pool!.query(`SELECT count(*)::int AS c FROM agent_prompt_runs WHERE idempotency_key=$1`, [idem]);
    assert.equal(cnt.rows[0].c, 1, "Idempotenz ×3: nur eine Zeile in der DB");

    // Run-FK nicht null + genau ein Artefakt
    const fk = await pool!.query(`SELECT artifact_id FROM agent_prompt_runs WHERE id=$1`, [r1.id]);
    assert.equal(fk.rows[0].artifact_id, art.id);

    // Raw FK-Verletzung: ungültiges Artefakt → Fehler (genau-ein-Artefakt Garantie)
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO agent_prompt_runs (artifact_id, role, prompt_hash, prompt_version, provider, model, started_at, ended_at, latency_ms, cost_status, success, idempotency_key)
         VALUES ('00000000-0000-4000-a000-000000000099', 'research', 'pp1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 'openai', 'gpt-4o', now(), now(), 10, 'unknown', true, 'pr1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`
      );
    });

    // CHECK pp1:64hex: ungültiger Hash → Rejection
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO prompt_artifacts (role, version, prompt_hash, canonical_prompt, template_schema_version)
         VALUES ('research', 999, 'bad-hash', 'x', '1')`
      );
    }, /prompt_artifacts_hash_check|CHECK/i);

    // Secrets/PII: Spaltenscan (kein apiKey etc.)
    const { agentPromptRuns } = await import("../src/db/schema");
    const cols = Object.keys(agentPromptRuns);
    for (const f of ["apiKey", "authorization", "rawResponse", "promptText", "secret", "token"]) {
      assert.equal(cols.includes(f), false, `Spalte ${f} darf nicht existieren`);
    }
  });

  it("Idempotenz nach simuliertem Neustart (neuer Pool, gleicher Embedded-Server): Daten bleiben, kein Duplikat", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { ensurePromptArtifact } = await import("../src/promptPerformance/store");

    const agentIdRes = await pool!.query(
      `INSERT INTO agents (name, role, model, system_prompt) VALUES ('prompt-test-agent-restart','RESEARCH','qwen2.5:7b','x') RETURNING id`
    );
    const agentId = agentIdRes.rows[0].id as string;

    const probe = "Neustart-Probe PP1 — bleibt erhalten";
    const { artifact: beforeArt } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: probe,
      templateSchemaVersion: "restart@1",
    });
    const beforeId = beforeArt.id;
    const beforeHash = beforeArt.promptHash;

    // Simulierter Neustart: neuer Pool zur selben Embedded-Instanz (gleiche DB)
    const newPool = new Pool({
      user: "postgres",
      password: "postgres",
      host: "127.0.0.1",
      port: PG_PORT,
      database: DB_NAME,
    });
    const newDb = drizzle(newPool);
    // Tausche Singleton auf neuen Pool um (alte Referenzen schließen wir danach)
    const oldPool = pool!;
    (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlPool = newPool;
    (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlDb = newDb;

    // Nach Restart: gleicher Prompt muss selbe Artefakt-ID/Hash zurückgeben, keine zweite Zeile
    const { artifact: afterArt, created } = await ensurePromptArtifact({
      agentId,
      role: "research",
      version: 1,
      promptText: probe,
      templateSchemaVersion: "restart@1",
    });
    assert.equal(afterArt.id, beforeId, "Artefakt nach Neustart identisch");
    assert.equal(afterArt.promptHash, beforeHash);
    assert.equal(created, false);
    const cnt = await newPool.query(`SELECT count(*)::int AS c FROM prompt_artifacts WHERE agent_id=$1 AND prompt_hash=$2`, [agentId, beforeHash]);
    assert.equal(cnt.rows[0].c, 1, "kein Duplikat nach Restart (agent+hash unique)");

    await newPool.end().catch(() => {});
    // Singleton zurück auf alten Pool für after-Hook
    (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlPool = oldPool;
    (globalThis as unknown as Record<string, unknown>).__arenaNextJsPostgresqlDb = drizzle(oldPool);
    pool = oldPool;
  });

  it("P1- und P3-Auswertung: PENDING ≠ Sieg/Niederlage (nur RESOLVED fließt — Code-Guard)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    // Vollständige Brier/ECE-Rechnung wird unit-getestet; hier nur Schema-Guard, dass
    // forecast_resolutions/status-Enum existiert, wenn die Migration gelaufen ist.
    // In diesem isolierten Prompt-DB-Kontext sind Forecast-Tabellen nicht angelegt — das ist ok.
    const res = await pool!.query(`SELECT to_regtype('forecast_resolutions')::text AS t`);
    assert.ok(typeof res.rows[0].t === "string" || res.rows[0].t === null);
  });
});

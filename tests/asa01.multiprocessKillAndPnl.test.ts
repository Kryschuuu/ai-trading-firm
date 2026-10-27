/**
 * ASA-01 Regression Suite — Multi-Prozess-Split-Brain:
 *   1. Autoritatives prozessübergreifendes Kill-Switch-Gate (PostgreSQL
 *      `kill_switches` + <= 500 ms TTL-Cache + `LISTEN/NOTIFY firm_control_changed`)
 *   2. Fail-Closed-Blockade bei DB-Ausfall während des Kill-Switch-Checks
 *   3. Cross-Prozess-Rehydration (`syncPaperBrokerWithDb`) & deterministischer
 *      `realizedPnl` (`LONG` & `SHORT`, Gewinn & Verlust, Gebührenparität zu
 *      `PaperBroker.close`, atomarer Doppel-Close-Schutz)
 */
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import { POST as postFirmKill } from "../src/app/api/firm/kill/route";
import { positions, killSwitches, proposals, missions, agents } from "../src/db/schema";
import {
  PaperBroker,
  computePaperClosePnl,
  type PaperExecutionAdapter,
} from "../src/lib/broker";
import {
  ensurePaperBrokerHydrated,
  syncPaperBrokerWithDb,
} from "../src/lib/brokerHydration";
import { executeApprovedProposal, invalidateBrokerCache } from "../src/lib/engine";
import {
  FIRM_CONTROL_CHANNEL,
  FirmControlNotificationListener,
  invalidateAuthoritativeKillSwitchCache,
  notifyFirmControlChanged,
  readAuthoritativeKillSwitch,
  resetKillSwitchDbForTests,
  setKillSwitchDbModeForTests,
  setKillSwitchDbReaderForTests,
} from "../src/lib/killSwitchDb";
import {
  RuleCache,
  createPaperRuleAdapter,
  type CachedRule,
} from "../src/lib/microExecutor";
import { applyExit, tick } from "../src/lib/monitor";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import { buildSnapshotFromCandles, compileRuleSpec, type RuleSpec } from "../src/lib/ruleEngine";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import {
  assertLiveOrderAllowed,
  evaluateLiveOrder,
  getLiveGateRuntime,
  setVenueReadinessProvider,
  writeSuiteStamp,
} from "../src/live-gate";
import { allowEnv, resetLiveGateTestGlobals, seedState } from "./fixtures/liveGateTestUtil";

const PG_PORT = 55_461;
const DB_NAME = "asa01_multiprocess_test";
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthMode = process.env.AUTH_MODE;
const originalAllowLocalOpen = process.env.ALLOW_LOCAL_OPEN;
const originalFetch = globalThis.fetch;

let postgres: EmbeddedPostgres | null = null;
let rawPool: Pool | null = null;
let tempDir = "";
let startupError: Error | null = null;
const pgLogs: string[] = [];

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsPostgresqlDb?: ReturnType<typeof drizzle>;
};

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS public.risk_config (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL UNIQUE,
    value numeric NOT NULL,
    description text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    role text NOT NULL,
    model text NOT NULL,
    status text NOT NULL DEFAULT 'IDLE',
    system_prompt text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.missions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    objective text NOT NULL,
    symbol text,
    scope text NOT NULL DEFAULT 'SINGLE_SYMBOL',
    segment text,
    template_id text,
    risk_budget numeric NOT NULL DEFAULT 0.02,
    max_position_pct numeric NOT NULL DEFAULT 0.25,
    status text NOT NULL DEFAULT 'PENDING',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.trade_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_key uuid NOT NULL,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'DRAFT',
    name text NOT NULL,
    symbol text NOT NULL,
    mission_id uuid REFERENCES public.missions(id),
    condition jsonb NOT NULL,
    action jsonb NOT NULL,
    "window" jsonb NOT NULL,
    signature text NOT NULL,
    rationale text,
    source_role text NOT NULL DEFAULT 'MANUAL',
    source_agent_id uuid REFERENCES public.agents(id),
    source_mode text NOT NULL DEFAULT 'SIGMA',
    previous_version_id uuid,
    superseded_by_id uuid,
    activated_at timestamptz,
    deactivated_at timestamptz,
    risk_score numeric NOT NULL DEFAULT 0.5,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.rule_executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id uuid NOT NULL REFERENCES public.trade_rules(id),
    mission_id uuid REFERENCES public.missions(id),
    symbol text NOT NULL,
    status text NOT NULL,
    trigger_price numeric,
    trigger_volume numeric,
    snapshot jsonb,
    evaluated jsonb,
    fill jsonb,
    order_id text,
    latency_micros integer,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.positions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol text NOT NULL,
    side text NOT NULL,
    qty numeric NOT NULL,
    entry_price numeric NOT NULL,
    current_price numeric,
    stop_loss numeric,
    take_profit numeric,
    exit_price numeric,
    realized_pnl numeric,
    funding_paid numeric NOT NULL DEFAULT 0,
    exit_reason text,
    trailing_stop numeric,
    trailing_armed boolean NOT NULL DEFAULT false,
    entry_signal jsonb,
    entry_signal_hash text,
    signal_decay_streak integer NOT NULL DEFAULT 0,
    signal_decay_last_key text,
    signal_decay_policy_version text,
    strategy_class text,
    broker text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN',
    mission_id uuid REFERENCES public.missions(id),
    rule_id uuid REFERENCES public.trade_rules(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.order_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account text NOT NULL DEFAULT 'PAPER',
    symbol text NOT NULL,
    side text NOT NULL,
    qty numeric NOT NULL,
    status text NOT NULL DEFAULT 'RESERVED',
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS order_intents_reserved_symbol_unique
    ON public.order_intents (symbol)
    WHERE status = 'RESERVED';

  CREATE TABLE IF NOT EXISTS public.kill_switches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reason text NOT NULL DEFAULT 'MANUAL',
    triggered_by text NOT NULL,
    armed boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event text NOT NULL,
    agent_id uuid REFERENCES public.agents(id),
    mission_id uuid REFERENCES public.missions(id),
    level text NOT NULL DEFAULT 'INFO',
    detail jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_id uuid REFERENCES public.missions(id),
    agent_id uuid REFERENCES public.agents(id),
    action text NOT NULL,
    detail jsonb NOT NULL,
    risk_score numeric NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'PENDING',
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz
  );

  CREATE TABLE IF NOT EXISTS public.equity_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts timestamptz NOT NULL DEFAULT now(),
    equity numeric NOT NULL,
    cash numeric NOT NULL,
    open_positions integer NOT NULL DEFAULT 0,
    realized_pnl_today numeric NOT NULL DEFAULT 0,
    trigger text NOT NULL DEFAULT 'TICK'
  );

  CREATE TABLE IF NOT EXISTS public.trade_journal (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    position_id uuid NOT NULL UNIQUE REFERENCES public.positions(id),
    symbol text NOT NULL,
    side text NOT NULL,
    opened_at timestamptz NOT NULL,
    closed_at timestamptz,
    mission_id uuid REFERENCES public.missions(id),
    rule_id uuid REFERENCES public.trade_rules(id),
    decision_snapshot jsonb NOT NULL,
    regime text NOT NULL DEFAULT 'UNKNOWN',
    pnl numeric,
    mae_pct numeric,
    mfe_pct numeric,
    holding_minutes integer,
    exit_reason text,
    quality text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.agent_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid REFERENCES public.agents(id),
    mission_id uuid REFERENCES public.missions(id),
    type text NOT NULL,
    content text NOT NULL,
    meta jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

before(async () => {
  let instance: EmbeddedPostgres | null = null;
  let localPool: Pool | null = null;
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), "asa01-pg-"));
    instance = new EmbeddedPostgres({
      databaseDir: tempDir,
      user: "postgres",
      password: "postgres",
      port: PG_PORT,
      persistent: false,
      onLog: (m) => pgLogs.push(m),
      onError: (m) => pgLogs.push(m instanceof Error ? m.message : String(m)),
    });
    await instance.initialise();
    await instance.start();
    await instance.createDatabase(DB_NAME);

    localPool = new Pool({
      connectionString: DB_URL,
      max: 8,
    });
    await localPool.query(SCHEMA_SQL);

    postgres = instance;
    rawPool = localPool;
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_MODE = "local-open";
    process.env.ALLOW_LOCAL_OPEN = "true";
    globalForDb.__arenaNextJsPostgresqlPool = localPool;
    globalForDb.__arenaNextJsPostgresqlDb = drizzle(localPool);
    globalThis.fetch = (async () => {
      throw new TypeError("offline-test: kein externes Netzwerk in asa01-Tests");
    }) as unknown as typeof fetch;
  } catch (err) {
    if (localPool) await localPool.end().catch(() => undefined);
    if (instance) await instance.stop().catch(() => undefined);
    const tail = pgLogs.slice(-8).join(" | ");
    startupError = new Error(
      `${err instanceof Error ? err.message : String(err)}${tail ? ` :: ${tail}` : ""}`
    );
  }
});

after(async () => {
  globalThis.fetch = originalFetch;
  resetKillSwitchDbForTests();
  __resetAllSingletonsForTests();
  resetLiveGateTestGlobals();

  delete globalForDb.__arenaNextJsPostgresqlDb;
  delete globalForDb.__arenaNextJsPostgresqlPool;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;

  if (originalAllowLocalOpen === undefined) delete process.env.ALLOW_LOCAL_OPEN;
  else process.env.ALLOW_LOCAL_OPEN = originalAllowLocalOpen;

  if (rawPool) await rawPool.end().catch(() => undefined);
  if (postgres) await postgres.stop().catch(() => undefined);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetKillSwitchDbForTests();
  __resetAllSingletonsForTests();
  resetRuntimeLimits();
  invalidateBrokerCache();
  resetLiveGateTestGlobals();

  if (rawPool) {
    process.env.DATABASE_URL = DB_URL;
    globalForDb.__arenaNextJsPostgresqlPool = rawPool;
    globalForDb.__arenaNextJsPostgresqlDb = drizzle(rawPool);
    await rawPool.query(`
      TRUNCATE TABLE
        public.trade_journal,
        public.rule_executions,
        public.trade_rules,
        public.proposals,
        public.order_intents,
        public.positions,
        public.kill_switches,
        public.equity_snapshots,
        public.audit_log,
        public.agent_messages,
        public.missions,
        public.agents,
        public.risk_config
      RESTART IDENTITY CASCADE
    `);
  }
});

afterEach(() => {
  resetKillSwitchDbForTests();
  resetLiveGateTestGlobals();
});

function skipIfNoPg(t: { skip: (msg: string) => void }): boolean {
  if (!rawPool) {
    t.skip(`embedded-postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
    return true;
  }
  return false;
}

function makeSampleRuleContext(symbol = "BTC") {
  const spec: RuleSpec = {
    name: "ASA01-Momentum",
    symbol,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [{ field: "price", op: "gt", value: 100 }],
    },
    action: {
      side: "LONG",
      riskBudgetPct: 0.01,
      stopLossPct: 2,
      takeProfitRR: 2,
      maxPositionPct: 0.1,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "5m",
      validFrom: null,
      validUntil: null,
      cooldownMinutes: 1,
      maxExecutionsPerDay: 5,
      volumeWindow: 20,
    },
    rationale: "ASA-01 Testregel",
    sourceRole: "MANUAL",
    riskScore: 0.3,
  };
  const compiled = compileRuleSpec(spec);
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: 1_700_000_000_000 + i * 300_000,
    open: 50_000 + i * 10,
    high: 50_020 + i * 10,
    low: 49_990 + i * 10,
    close: 50_010 + i * 10,
    volume: 100,
  }));
  const snapshot = buildSnapshotFromCandles(symbol, candles)!;
  return {
    ruleId: "00000000-0000-4000-8000-000000000001",
    name: spec.name,
    spec,
    compiled,
    snapshot,
    missionId: null,
    executionsToday: 0,
    evalMicros: 25,
    strategyClass: null,
  };
}

function prepareLiveAllowedContext(): ReturnType<typeof allowEnv> {
  const env = {
    ...allowEnv(),
    DATABASE_URL: DB_URL,
  };
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, {
    passed: true,
    runId: "asa01-suite",
    sha: null,
    source: "ci",
  });
  setVenueReadinessProvider(() => ({ active: true }));
  return env;
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_500
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Zeitüberschreitung beim Warten auf LISTEN/NOTIFY")),
      timeoutMs
    );
    const poll = () => {
      if (predicate()) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(poll, 10).unref?.();
      }
    };
    poll();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Cross-Prozess Kill-Switch (DB + POST /api/firm/kill + LISTEN/NOTIFY)
// ═══════════════════════════════════════════════════════════════════════════

test("ASA-01 (1a): Prozess A armiert via POST /api/firm/kill → Prozess B (frischer RAM) blockt MicroExecutor-, Engine- und Live-Orders sofort", async (t) => {
  if (skipIfNoPg(t)) return;

  // Prozess A: Operator zieht den Not-Halt über den echten Route-Handler.
  const killReq = new Request("http://localhost:3369/api/firm/kill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      arm: true,
      flatten: false,
      reason: "ASA01_CROSS_PROCESS_DRILL",
    }),
  });
  const killRes = await postFirmKill(killReq);
  assert.equal(killRes.status, 200);
  const killBody = (await killRes.json()) as { ok: boolean; killSwitchArmed: boolean };
  assert.equal(killBody.ok, true);
  assert.equal(killBody.killSwitchArmed, true);

  // Prozess B simulieren: komplett isolierter RAM-Zustand (`killSwitch` lokal AUS!).
  __resetAllSingletonsForTests();
  resetKillSwitchDbForTests();
  assert.equal(
    killSwitch.isArmed(),
    false,
    "Vorbedingung: lokales RAM-Latch in Prozess B startet unscharf"
  );

  // (i) MicroExecutor / createPaperRuleAdapter blockiert sofort gegen PostgreSQL.
  const ruleAdapter = createPaperRuleAdapter();
  const microOutcome = await ruleAdapter.execute(makeSampleRuleContext("BTC"));
  assert.equal(microOutcome.status, "BLOCKED");
  assert.match(microOutcome.reason ?? "", /KILL_SWITCH_ARMED:ASA01_CROSS_PROCESS_DRILL/);
  assert.equal(
    killSwitch.isArmed(),
    true,
    "Lokales killSwitch-Latch in Prozess B wurde mit der DB synchronisiert"
  );

  // (ii) Makro-Engine (`executeApprovedProposal`) mit erneut geleertem RAM-Zustand.
  __resetAllSingletonsForTests();
  resetKillSwitchDbForTests();
  assert.equal(killSwitch.isArmed(), false);

  const db = globalForDb.__arenaNextJsPostgresqlDb!;
  const [mission] = await db
    .insert(missions)
    .values({ title: "ASA-01 Mission", objective: "Test", symbol: "BTC" })
    .returning({ id: missions.id });
  const [agent] = await db
    .insert(agents)
    .values({
      name: "ASA01-Executor",
      role: "EXECUTOR",
      model: "test-model",
      systemPrompt: "executor",
    })
    .returning({ id: agents.id });
  const [proposal] = await db
    .insert(proposals)
    .values({
      missionId: mission.id,
      agentId: agent.id,
      action: "OPEN",
      status: "APPROVED",
      proposedDetail: {
        symbol: "BTC",
        side: "LONG",
        qty: 0.01,
        riskNotional: 500,
        stopLoss: 48_000,
        takeProfit: 55_000,
      },
      reason: "approved test proposal",
    })
    .returning({ id: proposals.id });

  const engineOutcome = await executeApprovedProposal(proposal.id, agent.id);
  assert.equal(engineOutcome.status, "BLOCKED");
  assert.equal(engineOutcome.guardrail, "KILL_SWITCH_ARMED");

  // (iii) Live-Gate (`evaluateLiveOrder` / `assertLiveOrderAllowed`) mit frischem RAM:
  // Sowohl unhydriert (fail-closed wegen fehlender Verifikation) als auch nach
  // DB-Refresh (KILL_SWITCH_ACTIVE wegen `kill_switches.armed = true`).
  __resetAllSingletonsForTests();
  resetKillSwitchDbForTests();
  const liveEnv = prepareLiveAllowedContext();

  const coldDecision = evaluateLiveOrder("BITUNIX", { env: liveEnv, audit: false });
  assert.equal(coldDecision.allowed, false);
  assert.equal(coldDecision.code, "KILL_SWITCH_ACTIVE");

  await readAuthoritativeKillSwitch({ env: liveEnv, forceRefresh: true });
  const warmDecision = evaluateLiveOrder("BITUNIX", { env: liveEnv, audit: false });
  assert.equal(warmDecision.allowed, false);
  assert.equal(warmDecision.code, "KILL_SWITCH_ACTIVE");
  assert.match(warmDecision.reason, /ASA01_CROSS_PROCESS_DRILL/);
  assert.throws(
    () => assertLiveOrderAllowed("BITUNIX", { env: liveEnv }),
    /KILL_SWITCH_ACTIVE/
  );
});

test("ASA-01 (1b): PostgreSQL LISTEN/NOTIFY auf `firm_control_changed` invalidiert warmen TTL-Cache sofort und verhindert Spoof-Disarm", async (t) => {
  if (skipIfNoPg(t)) return;

  const db = globalForDb.__arenaNextJsPostgresqlDb!;
  await db.insert(killSwitches).values({
    reason: "BOOT_CLEAN",
    triggeredBy: "OPERATOR",
    armed: false,
  });

  // Prozess B wärmt seinen TTL-Cache mit `armed = false` vor.
  const initial = await readAuthoritativeKillSwitch({ forceRefresh: true });
  assert.equal(initial.armed, false);
  assert.equal(killSwitch.isArmed(), false);

  let invalidatedCount = 0;
  const listener = new FirmControlNotificationListener(rawPool!, {
    log: () => undefined,
    onInvalidated: () => {
      invalidatedCount += 1;
    },
  });
  await listener.start();

  try {
    // Prozess A schreibt `armed = true` auf einer separaten DB-Connection + NOTIFY.
    const externalClient = await rawPool!.connect();
    try {
      await externalClient.query(
        "INSERT INTO public.kill_switches (reason, triggered_by, armed) VALUES ($1, $2, true)",
        ["NOTIFY_IMMEDIATE_ARM", "PROCESS_A"]
      );
      await externalClient.query("SELECT pg_notify($1, $2)", [
        FIRM_CONTROL_CHANNEL,
        JSON.stringify({ kind: "kill_switch", armed: true, reason: "NOTIFY_IMMEDIATE_ARM" }),
      ]);
    } finally {
      externalClient.release();
    }

    await waitForCondition(() => invalidatedCount >= 1 && killSwitch.isArmed());

    // Ohne auf den 500-ms-Ablauf warten zu müssen, liefert das Gate sofort `armed = true`.
    const afterNotify = await readAuthoritativeKillSwitch();
    assert.equal(afterNotify.armed, true);
    assert.equal(afterNotify.reason, "NOTIFY_IMMEDIATE_ARM");

    // Sicherheitsprobe: Ein gefälschtes NOTIFY `armed: false` ohne DB-Disarm
    // darf den Not-Halt NIEMALS entschärfen (`kill_switches` bleibt autoritativ!).
    const prevCount = invalidatedCount;
    const spoofClient = await rawPool!.connect();
    try {
      await spoofClient.query("SELECT pg_notify($1, $2)", [
        FIRM_CONTROL_CHANNEL,
        JSON.stringify({ kind: "kill_switch", armed: false, reason: "SPOOF" }),
      ]);
    } finally {
      spoofClient.release();
    }
    await waitForCondition(() => invalidatedCount > prevCount);
    const afterSpoof = await readAuthoritativeKillSwitch({ forceRefresh: true });
    assert.equal(afterSpoof.armed, true, "DB-Wahrheit bleibt armed=true trotz Spoof-NOTIFY");
    assert.equal(killSwitch.isArmed(), true);
  } finally {
    await listener.stop();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Fail-Closed bei simuliertem DB-Fehler während der Kill-Switch-Abfrage
// ═══════════════════════════════════════════════════════════════════════════

test("ASA-01 (2): Simulierter DB-Fehler beim Kill-Switch-Read blockiert Paper- und Live-Orders fail-closed (ohne Secret-Leak)", async () => {
  __resetAllSingletonsForTests();
  resetKillSwitchDbForTests();
  setKillSwitchDbModeForTests("db");
  setKillSwitchDbReaderForTests(async () => {
    const err = Object.assign(
      new Error("connect ECONNREFUSED postgresql://user:supersecret@10.0.0.5:5432/prod"),
      { code: "ECONNREFUSED" }
    );
    throw err;
  });

  assert.equal(killSwitch.isArmed(), false, "Vorher lokal nicht gezogen");

  // Paper-Regel-Pfad (`createPaperRuleAdapter`):
  const adapter = createPaperRuleAdapter();
  const paperRes = await adapter.execute(makeSampleRuleContext("BTC"));
  assert.equal(paperRes.status, "BLOCKED");
  assert.match(paperRes.reason ?? "", /KILL_SWITCH_DB_UNAVAILABLE/);
  assert.match(paperRes.reason ?? "", /ECONNREFUSED/);
  assert.doesNotMatch(
    paperRes.reason ?? "",
    /postgresql:|supersecret/i,
    "Keine Connection-Strings oder Passwörter im Ablehnungsgrund"
  );
  assert.equal(killSwitch.isArmed(), true, "Fail-Closed zieht lokales Sicherheits-Latch");

  // Live-Gate-Pfad (`evaluateLiveOrder`):
  __resetAllSingletonsForTests();
  setKillSwitchDbModeForTests("db");
  setKillSwitchDbReaderForTests(async () => {
    throw Object.assign(new Error("database unreachable"), { code: "57P01" });
  });
  const liveEnv = prepareLiveAllowedContext();
  const status = await readAuthoritativeKillSwitch({ env: liveEnv, forceRefresh: true });
  assert.equal(status.armed, true);
  assert.equal(status.source, "db-error");

  const liveDecision = evaluateLiveOrder("BITUNIX", { env: liveEnv, audit: false });
  assert.equal(liveDecision.allowed, false);
  assert.equal(liveDecision.code, "KILL_SWITCH_ACTIVE");
  assert.match(liveDecision.reason, /KILL_SWITCH_DB_UNAVAILABLE|riskGuard\.killSwitch/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cross-Prozess Rehydration & deterministischer realizedPnl (LONG & SHORT)
// ═══════════════════════════════════════════════════════════════════════════

test("ASA-01 (3a): Position fehlt im lokalen PaperBroker-RAM → applyExit bucht für LONG & SHORT (Gewinn & Verlust) exakt denselben realizedPnl wie PaperBroker.close inkl. Gebühren", async (t) => {
  if (skipIfNoPg(t)) return;
  const db = globalForDb.__arenaNextJsPostgresqlDb!;

  const cases: Array<{
    label: string;
    symbol: string;
    side: "LONG" | "SHORT";
    qty: number;
    entryPrice: number;
    exitPrice: number;
    reason: "TAKE_PROFIT" | "STOP_LOSS";
    feeRate: number;
  }> = [
    {
      label: "LONG Gewinn",
      symbol: "ASALONGWIN",
      side: "LONG",
      qty: 2,
      entryPrice: 100,
      exitPrice: 115.5,
      reason: "TAKE_PROFIT",
      feeRate: 0.001, // 2 * 115.5 * 0.001 = 0.231 -> rawNet = 31 - 0.231 = 30.769 -> 30.77
    },
    {
      label: "LONG Verlust",
      symbol: "ASALONGLOSS",
      side: "LONG",
      qty: 3,
      entryPrice: 200,
      exitPrice: 185.25,
      reason: "STOP_LOSS",
      feeRate: 0.001, // rawGross = -44.25, fee = 0.55575 -> -44.81
    },
    {
      label: "SHORT Gewinn",
      symbol: "ASASHORTWIN",
      side: "SHORT",
      qty: 4,
      entryPrice: 150,
      exitPrice: 132.5,
      reason: "TAKE_PROFIT",
      feeRate: 0.001, // rawGross = +70, fee = 0.53 -> +69.47
    },
    {
      label: "SHORT Verlust",
      symbol: "ASASHORTLOSS",
      side: "SHORT",
      qty: 2.5,
      entryPrice: 80,
      exitPrice: 91.2,
      reason: "STOP_LOSS",
      feeRate: 0.001, // rawGross = -28, fee = 0.228 -> -28.23
    },
  ];

  for (const c of cases) {
    const feeAdapter: PaperExecutionAdapter = {
      quoteProvider: () => ({
        bid: c.exitPrice,
        ask: c.exitPrice,
        last: c.exitPrice,
        spread: 0,
        volume24h: 1_000_000,
      }),
      execute: (order) => ({
        filledQty: order.qty,
        fillPrice: c.entryPrice,
        fees: 0,
        status: "FILLED",
      }),
      estimateCloseFee: ({ qty, exitPrice }) => qty * exitPrice * c.feeRate,
    };

    // Referenz 1: Direkter lokaler Close im `PaperBroker` (Position im RAM vorhanden).
    const referenceBroker = new PaperBroker(10_000, feeAdapter);
    referenceBroker.hydrate([
      {
        symbol: c.symbol,
        side: c.side,
        qty: c.qty,
        entryPrice: c.entryPrice,
        stopLoss: c.side === "LONG" ? 50 : 300,
        takeProfit: c.side === "LONG" ? 300 : 20,
      },
    ]);
    const refClose = referenceBroker.close(c.symbol, c.reason, { exitPrice: c.exitPrice });
    assert.ok(refClose, `${c.label}: Referenz-Close muss Fill liefern`);
    assert.notEqual(refClose.realizedPnl, 0, `${c.label}: Referenz-PnL darf nicht 0 sein`);

    // Prüfling: Position existiert NUR in PostgreSQL (`positions`), fehlt aber
    // vollständig im lokalen `PaperBroker`-RAM (simulierter Cross-Prozess-Fall).
    const [inserted] = await db
      .insert(positions)
      .values({
        symbol: c.symbol,
        side: c.side,
        qty: String(c.qty),
        entryPrice: String(c.entryPrice),
        currentPrice: String(c.entryPrice),
        stopLoss: String(c.side === "LONG" ? 50 : 300),
        takeProfit: String(c.side === "LONG" ? 300 : 20),
        broker: "PAPER",
        status: "OPEN",
      })
      .returning({ id: positions.id, createdAt: positions.createdAt });

    const splitBrainBroker = new PaperBroker(10_000, feeAdapter);
    assert.equal(
      splitBrainBroker.getPosition(c.symbol),
      null,
      `${c.label}: Vorbedingung — Position fehlt im lokalen PaperBroker-RAM`
    );

    const exitRes = await applyExit({
      broker: splitBrainBroker,
      positionId: inserted.id,
      symbol: c.symbol,
      side: c.side,
      qty: c.qty,
      entryPrice: c.entryPrice,
      reason: c.reason,
      createdAt: inserted.createdAt,
      now: new Date(),
      triggerPrice: c.exitPrice,
    });

    assert.equal(exitRes.closed, true, `${c.label}: Exit muss Position schließen`);
    assert.ok(exitRes.fill, `${c.label}: Exit muss deterministischen Fill liefern`);
    assert.equal(
      exitRes.fill.realizedPnl,
      refClose.realizedPnl,
      `${c.label}: exakt identischer realizedPnl zu PaperBroker.close`
    );
    assert.equal(
      exitRes.fill.fees,
      refClose.fees,
      `${c.label}: exakt identische Exit-Gebühren`
    );
    assert.ok(
      Math.abs(splitBrainBroker.freeCash - referenceBroker.freeCash) < 1e-9,
      `${c.label}: identischer End-Cash-Stand (${splitBrainBroker.freeCash} vs. ${referenceBroker.freeCash})`
    );

    const [dbRow] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, inserted.id));
    assert.equal(dbRow.status, "CLOSED");
    assert.equal(Number(dbRow.exitPrice), c.exitPrice);
    assert.equal(
      Number(dbRow.realizedPnl),
      refClose.realizedPnl,
      `${c.label}: DB positions.realized_pnl trägt den exakten Nicht-Null-Wert`
    );
  }
});

test("ASA-01 (3b): Monitor tick() rehydriert fremderöffnete DB-Positionen via syncPaperBrokerWithDb und bucht exakten realizedPnl", async (t) => {
  if (skipIfNoPg(t)) return;
  const db = globalForDb.__arenaNextJsPostgresqlDb!;

  // Prozess B (Web/Monitor) startet mit leerer DB — Singleton-Ledger ist hydriert & leer.
  await notifyFirmControlChanged({ armed: false, reason: "TEST_READY" });
  const { paperBrokerLedger } = await import("../src/brokers/factory");
  const webLedger = paperBrokerLedger();
  await ensurePaperBrokerHydrated(webLedger);
  assert.equal(webLedger.openPositions, 0);
  const startCash = webLedger.freeCash;

  // Prozess A (`micro-executor`) schreibt eine LONG- und eine SHORT-Position direkt in PostgreSQL.
  const [longPos] = await db
    .insert(positions)
    .values({
      symbol: "ASATICKLONG",
      side: "LONG",
      qty: "2",
      entryPrice: "100",
      currentPrice: "100",
      stopLoss: "90",
      takeProfit: "120",
      broker: "PAPER",
      status: "OPEN",
    })
    .returning({ id: positions.id });

  const [shortPos] = await db
    .insert(positions)
    .values({
      symbol: "ASATICKSHORT",
      side: "SHORT",
      qty: "5",
      entryPrice: "50",
      currentPrice: "50",
      stopLoss: "58",
      takeProfit: "42",
      broker: "PAPER",
      status: "OPEN",
    })
    .returning({ id: positions.id });

  // Vor dem Tick kennt der lokale RAM-Ledger von Prozess B keine der beiden Positionen.
  assert.equal(webLedger.openPositions, 0);

  // Monitor-Tick in Prozess B mit Kursen:
  //   - ASATICKLONG @ 125 (>= TP 120) -> Gewinn +50.00
  //   - ASATICKSHORT @ 60 (>= SL 58)  -> Verlust -50.00 -> halt, testen wir asymmetrisch: @ 59 -> Verlust -45.00!
  const tickRes = await tick(false, {
    skipScan: true,
    quotes: {
      ASATICKLONG: 125,
      ASATICKSHORT: 59,
    },
  });

  const longTrigger = tickRes.stopsTriggered.find((s) => s.symbol === "ASATICKLONG");
  const shortTrigger = tickRes.stopsTriggered.find((s) => s.symbol === "ASATICKSHORT");
  assert.ok(longTrigger, "LONG-Position durch Monitor geschlossen");
  assert.ok(shortTrigger, "SHORT-Position durch Monitor geschlossen");
  assert.equal(longTrigger.reason, "TAKE_PROFIT");
  assert.equal(longTrigger.pnl, 50);
  assert.equal(shortTrigger.reason, "STOP_LOSS");
  assert.equal(shortTrigger.pnl, -45);

  const [closedLong] = await db.select().from(positions).where(eq(positions.id, longPos.id));
  const [closedShort] = await db.select().from(positions).where(eq(positions.id, shortPos.id));
  assert.equal(closedLong.status, "CLOSED");
  assert.equal(Number(closedLong.realizedPnl), 50);
  assert.equal(closedShort.status, "CLOSED");
  assert.equal(Number(closedShort.realizedPnl), -45);

  assert.equal(webLedger.openPositions, 0);
  assert.ok(
    Math.abs(webLedger.freeCash - (startCash + 50 - 45)) < 1e-6,
    `Cash konsistent nach Cross-Prozess-Exits: erwartet ${startCash + 5}, war ${webLedger.freeCash}`
  );
});

test("ASA-01 (3c): Doppel-Close-Schutz (`WHERE id = pos.id AND status = 'OPEN'`) schreibt Cash & PnL bei konkurrierenden Exits genau einmal", async (t) => {
  if (skipIfNoPg(t)) return;
  const db = globalForDb.__arenaNextJsPostgresqlDb!;

  const [pos] = await db
    .insert(positions)
    .values({
      symbol: "ASARACE",
      side: "SHORT",
      qty: "3",
      entryPrice: "100",
      currentPrice: "100",
      stopLoss: "110",
      takeProfit: "85",
      broker: "PAPER",
      status: "OPEN",
    })
    .returning({ id: positions.id, createdAt: positions.createdAt });

  // Position fehlt im lokalen RAM; zwei parallele Aufrufer versuchen gleichzeitig zu schließen.
  const broker = new PaperBroker(10_000);
  const now = new Date();
  const [r1, r2] = await Promise.all([
    applyExit({
      broker,
      positionId: pos.id,
      symbol: "ASARACE",
      side: "SHORT",
      qty: 3,
      entryPrice: 100,
      reason: "TAKE_PROFIT",
      createdAt: pos.createdAt,
      now,
      triggerPrice: 80, // SHORT Gewinn = 3 * (100 - 80) = +60
    }),
    applyExit({
      broker,
      positionId: pos.id,
      symbol: "ASARACE",
      side: "SHORT",
      qty: 3,
      entryPrice: 100,
      reason: "TAKE_PROFIT",
      createdAt: pos.createdAt,
      now,
      triggerPrice: 80,
    }),
  ]);

  const winners = [r1, r2].filter((r) => r.closed);
  const losers = [r1, r2].filter((r) => !r.closed);
  assert.equal(winners.length, 1, "Genau ein Aufrufer gewinnt den bedingten DB-Claim");
  assert.equal(losers.length, 1, "Zweiter Aufrufer ist sauberer No-Op");
  assert.equal(winners[0].fill?.realizedPnl, 60);
  assert.equal(losers[0].fill, undefined);
  assert.equal(
    broker.freeCash,
    10_060,
    "Cash wurde exakt EINMAL um +60 erhöht (keine Doppelgutschrift)"
  );

  // Und `syncPaperBrokerWithDb` zieht auch extern geschlossene Positionen sauber nach:
  const stalePeerBroker = new PaperBroker(10_000);
  stalePeerBroker.hydrate([
    {
      symbol: "ASARACE",
      side: "SHORT",
      qty: 3,
      entryPrice: 100,
      stopLoss: 110,
      takeProfit: 85,
    },
  ]);
  assert.equal(stalePeerBroker.openPositions, 1);
  assert.equal(stalePeerBroker.freeCash, 9_700);

  const syncDiff = await syncPaperBrokerWithDb(stalePeerBroker);
  assert.equal(syncDiff.synced, true);
  assert.deepEqual(syncDiff.removed, ["ASARACE"]);
  assert.equal(stalePeerBroker.openPositions, 0);
  assert.equal(
    stalePeerBroker.freeCash,
    10_060,
    "Peer-Broker gibt gebundenes Kapital + realisierten DB-Gewinn (+60) exakt frei"
  );
});

test("ASA-01 (3d): MicroExecutor.handleTick blockiert gematchte Regeln über das autoritative DB-Kill-Gate selbst bei benutzerdefiniertem Adapter", async (t) => {
  if (skipIfNoPg(t)) return;
  const db = globalForDb.__arenaNextJsPostgresqlDb!;

  await db.insert(killSwitches).values({
    reason: "DAEMON_HARD_STOP",
    triggeredBy: "OPERATOR",
    armed: true,
  });

  __resetAllSingletonsForTests();
  resetKillSwitchDbForTests();
  invalidateAuthoritativeKillSwitchCache();

  const { MicroExecutor } = await import("../src/lib/microExecutor");
  const sample = makeSampleRuleContext("BTC");
  const cache = new RuleCache(60_000);
  const seededRule: CachedRule = {
    rowId: sample.ruleId,
    ruleKey: "00000000-0000-4000-8000-000000000099",
    version: 1,
    name: sample.name,
    symbol: "BTC",
    missionId: null,
    spec: sample.spec,
    compiled: sample.compiled,
    cooldownMs: 0,
    executionsToday: 0,
    firedAt: 0,
  };
  cache._seedForTest([seededRule]);

  let adapterCalled = 0;
  const exec = new MicroExecutor({
    cache,
    adapter: {
      name: "CUSTOM_PROBE",
      async execute() {
        adapterCalled += 1;
        return {
          status: "TRIGGERED",
          ruleId: sample.ruleId,
          symbol: "BTC",
          at: new Date().toISOString(),
        };
      },
    },
    options: { seedCandles: false },
  });

  // 35 synthetische 5m-Trade-Ticks einspeisen, damit `RollingTimeframeSeries` einen Snapshot baut.
  exec.addSymbol("BTC", "5m");
  (exec as unknown as { running: boolean }).running = true;
  const baseTs = 1_700_000_000_000;
  for (let i = 0; i < 35; i++) {
    (exec as unknown as {
      handleTick: (tick: {
        kind: "trade";
        symbol: string;
        price: number;
        qty: number;
        ts: number;
      }) => void;
    }).handleTick({
      kind: "trade",
      symbol: "BTC",
      price: 50_000 + i * 25,
      qty: 10,
      ts: baseTs + i * 300_000,
    });
  }

  await waitForCondition(() => exec.status().blocked >= 1);
  assert.equal(adapterCalled, 0, "Adapter darf bei aktivem DB-Kill-Switch nie erreicht werden");
  assert.match(exec.status().lastError ?? "", /DAEMON_HARD_STOP/);
});

test("ASA-01 (3e): computePaperClosePnl ist vorzeichen- und gebührenscharf für LONG und SHORT", () => {
  const longZeroFee = computePaperClosePnl({
    side: "LONG",
    qty: 2,
    entryPrice: 100,
    exitPrice: 112.345,
  });
  assert.equal(longZeroFee.realizedPnl, 24.69);
  assert.ok(Math.abs(longZeroFee.cashDelta - 224.69) < 1e-9);

  const shortWithFee = computePaperClosePnl({
    side: "SHORT",
    qty: 5,
    entryPrice: 200,
    exitPrice: 180,
    exitFee: 1.5,
  });
  assert.equal(shortWithFee.realizedPnl, 98.5);
  assert.equal(shortWithFee.cashDelta, 1_098.5);
});

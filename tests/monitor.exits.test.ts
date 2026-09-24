/**
 * GAP-05 (v1.44.0) — Server-seitiges Exit-Management: Trailing-Stop,
 * Time-Stop und OCO-Exklusivität.
 *
 * Deckt die Acceptance-Kriterien aus
 * docs/audits/2026-09-18-feature-gap/findings/GAP-05-server-side-exit-management.md
 * ab:
 *
 *   D1 Trailing-Lifecycle   — nicht bewaffnet → bewaffnet bei Activation →
 *                             Ratchet nur aufwärts → Auslösung TRAILING_STOP.
 *   D1 Restart-Persistenz     — Ledger aus DB rehydrieren → Trailing-Stops
 *                             bleiben aktiv (kein Memory-Only-Zustand).
 *   D2 Time-Stop              — Ablauf → Close + Audit; 0 = inaktiv.
 *   D3 OCO-Race               — zwei parallele Exit-Pfade auf dieselbe
 *                             Position → GENAU ein Close, zweiter no-op,
 *                             konsistenter Ledger; tick() bleibt bei
 *                             Promise.all stabil (Single-Flight + Claim).
 *   D4 Defaults               — alle Flags aus → Verhalten identisch zum
 *                             bisherigen SL/TP-Stand.
 *   Audit                     — jeder Exit erzeugt genau einen Audit-Eintrag
 *                             mit maschinenlesbarem Grund `exit:SYMBOL:grund`.
 *
 * Struktur: reine Logik (decideExit/loadExitConfig) läuft immer — die
 * Tick-/Race-/Persistenz-Tests brauchen ein reachbares PostgreSQL (Konvention
 * des Repos: `npm test` exportiert DATABASE_URL=…0.0.0.0:5432/test). Ist
 * keine DB erreichbar, werden genau diese Tests sauber übersprungen
 * (skip, nicht fail) — wie im Rest der Suite gilt: kein Test zwingt eine DB.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { db } from "../src/db";
import {
  auditLog,
  equitySnapshots,
  killSwitches,
  positions,
  tradeJournal,
} from "../src/db/schema";
import { like, sql } from "drizzle-orm";
import {
  DEFAULT_EXIT_CONFIG,
  EXIT_CONFIG_BOUNDS,
  decideExit,
  loadExitConfig,
  type ExitDecisionInput,
} from "../src/lib/exits";
import { applyExit, tick, type TickOptions } from "../src/lib/monitor";
import { PaperBroker } from "../src/lib/broker";
import { getBroker, invalidateBrokerCache } from "../src/lib/engine";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import { resetMarketDataCachesForTests } from "../src/lib/marketData";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

// ── Determinismus: kein Netzwerk im Test (Fake-Clock + injizierte Quotes) ───

const originalFetch = globalThis.fetch;

/** Kurs ins globale Quote-Cache schreiben (PaperBroker `paperQuote` liest exakt diesen Cache). */
function setQuoteCache(symbol: string, price: number): void {
  const g = globalThis as typeof globalThis & {
    __mktQuoteCache?: Map<string, { price: number; ts: number; source: string }>;
  };
  (g.__mktQuoteCache ??= new Map()).set(symbol, { price, ts: Date.now(), source: "test" });
}

/** Fixe Basiszeit: alle Ticks laufen mit nowMs = T0 + n — keine laufende Uhr. */
const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
const HOUR = 3_600_000;

const exitEnvKeys = [
  "RISK_TRAILING_ENABLED",
  "RISK_TRAILING_ACTIVATION_PCT",
  "RISK_TRAILING_RETURN_PCT",
  "RISK_TIME_STOP_HOURS",
] as const;

function setExitEnv(values: Partial<Record<(typeof exitEnvKeys)[number], string>>): void {
  for (const key of exitEnvKeys) delete process.env[key];
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) process.env[k] = v;
  }
}

before(() => {
  // Alle Marktdaten-/Netzwerkpfade ins Leere laufen lassen: tick() nutzt
  // injizierte Quotes (opts.quotes), adaptive Risiko-/Scan-Pfade scheitern
  // schnell und toleriert. Der Monitor-Tick bleibt damit deterministisch.
  globalThis.fetch = (async () => {
    throw new TypeError("offline-test: kein Netzwerk in tests/monitor.exits.test.ts");
  }) as unknown as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  setExitEnv({});
  resetMarketDataCachesForTests();
  // Testdaten aus der DB entfernen (nur wenn wir sie geschrieben haben).
  if (dbAvailable) {
    try {
      await cleanDb();
    } catch {
      /* DB schon weg — aufräumen ist best-effort */
    }
  }
});

beforeEach(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
  setExitEnv({});
});

// ── DB-Verfügbarkeit (Konvention: echte DB nur wenn erreichbar) ─────────────

let dbAvailable = false;
let dbProbeNote = "";

before(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    dbProbeNote = "DATABASE_URL nicht gesetzt";
    return;
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    const probe = await client.query(
      "select to_regclass('public.positions') is not null as has_positions"
    );
    dbAvailable = probe.rows[0]?.has_positions === true;
    if (!dbAvailable) dbProbeNote = "positions-Tabelle fehlt (npx drizzle-kit push ausführen)";
  } catch (e) {
    dbProbeNote = `DB nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
  } finally {
    try {
      await client.end();
    } catch {
      /* egal */
    }
  }
});

function skipWithoutDb(t: { skip: (msg: string) => void }): boolean {
  if (!dbAvailable) {
    t.skip(`realer DB-Lauf übersprungen — ${dbProbeNote}`);
    return true;
  }
  return false;
}

/** Test-Symbol (kanonische Form wie sie submitAtomic persistiert). */
const SYM = "TESTA";

/** Frischer, isolierter Zustand pro DB-Test: nur UNSER Symbol, keine Altlasten. */
async function cleanDb(): Promise<void> {
  invalidateBrokerCache();
  __resetAllSingletonsForTests();
  const rows = await db.select({ id: positions.id }).from(positions).where(like(positions.symbol, `${SYM}%`));
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    // RMA-P1-06 (v1.57.0): Attribution-Kinder zuerst (FK ohne CASCADE);
    // best-effort — auf nicht migrierten DBs ist das ein No-op.
    try {
      await db.execute(
        sql`DELETE FROM trade_attribution_entries WHERE attribution_id IN
            (SELECT id FROM trade_attributions WHERE position_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)}))`
      );
      await db.execute(
        sql`DELETE FROM trade_attributions WHERE position_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`
      );
    } catch {
      /* Tabellen fehlen (unmigrierte DB) — kein FK, Löschung unnötig. */
    }
    await db.delete(tradeJournal).where(sql`${tradeJournal.positionId} in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`);
    await db.delete(positions).where(sql`${positions.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`);
  }
  await db
    .delete(auditLog)
    .where(sql`(${auditLog.detail} ->> 'code' like ${`exit:${SYM}:%`} or ${auditLog.detail} ->> 'code' = ${`trailing-arm:${SYM}`})`);
  await db.delete(equitySnapshots);
  await db.delete(killSwitches);
}

type SeedOpts = {
  price?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  side?: "LONG" | "SHORT";
  qty?: number;
  createdAtMs?: number;
  trailingStop?: number | null;
  trailingArmed?: boolean;
};

/** Position direkt in die DB setzen (Hydration erfolgt über getBroker/tick). */
async function seedPosition(overrides: SeedOpts = {}): Promise<string> {
  const price = overrides.price ?? 100;
  const [row] = await db
    .insert(positions)
    .values({
      symbol: SYM,
      side: overrides.side ?? "LONG",
      qty: String(overrides.qty ?? 1),
      entryPrice: String(price),
      currentPrice: String(price),
      stopLoss: overrides.stopLoss == null ? null : String(overrides.stopLoss),
      takeProfit: overrides.takeProfit == null ? null : String(overrides.takeProfit),
      trailingStop: overrides.trailingStop == null ? null : String(overrides.trailingStop),
      trailingArmed: overrides.trailingArmed ?? false,
      broker: "PAPER",
      status: "OPEN",
      createdAt: new Date(overrides.createdAtMs ?? T0 - HOUR),
      updatedAt: new Date(overrides.createdAtMs ?? T0 - HOUR),
    })
    .returning({ id: positions.id });
  setQuoteCache(SYM, price);
  return row.id;
}

async function readPosition(id: string) {
  const [row] = await db.select().from(positions).where(sql`${positions.id} = ${id}`);
  return row;
}

/** Zählt Exit-Audits mit maschinenlesbarem Code `exit:SYM:REASON`. */
async function countExitAudits(reason: string): Promise<number> {
  const [res] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(sql`${auditLog.detail} ->> 'code' = ${`exit:${SYM}:${reason}`}`);
  return Number(res?.n ?? 0);
}

/**
 * Ein Tick mit Fake-Clock + injiziertem Kurs. Der Kurs wird ZUVOR ins globale
 * Quote-Cache geschrieben, damit `paperQuote`/`broker.close` denselben Preis
 * sehen wie der Monitor (identische Fill-Basis wie im Produktivpfad, wo
 * refreshQuotes beide speist).
 */
function tickAt(msOffset: number, price: number, extra: Partial<TickOptions> = {}): Promise<unknown> {
  setQuoteCache(SYM, price);
  return tick(false, { now: T0 + msOffset, quotes: { [SYM]: price }, skipScan: true, ...extra });
}

// ═════════════════════════════════════════════════════════════════════════
// A) Reine Logik — Konfiguration (D4)
// ═════════════════════════════════════════════════════════════════════════

test("GAP-05 D4: Defaults sind verhaltensneutral (alles aus) und Bounds klemmen", () => {
  const cfg = loadExitConfig({});
  assert.deepEqual(cfg, DEFAULT_EXIT_CONFIG);
  assert.equal(cfg.trailingEnabled, false, "Trailing per Default AUS — kein Verhaltensbruch");
  assert.equal(cfg.timeStopHours, 0, "Time-Stop per Default 0 = aus");

  // Bounds-Clamp: weit über/unter die Grenzen → geklemmt, nie durchgereicht.
  const clamped = loadExitConfig(
    {},
    { trailingEnabled: true, trailingActivationPct: 999, trailingReturnPct: -5, timeStopHours: 9999 }
  );
  assert.equal(clamped.trailingActivationPct, EXIT_CONFIG_BOUNDS.trailingActivationPct[1]);
  assert.equal(clamped.trailingReturnPct, EXIT_CONFIG_BOUNDS.trailingReturnPct[0]);
  assert.equal(clamped.timeStopHours, EXIT_CONFIG_BOUNDS.timeStopHours[1]);
});

test("GAP-05 D4: Env-Flags werden gelesen (Activation/Return/Time-Stop/Enabled)", () => {
  const cfg = loadExitConfig(
    {
      RISK_TRAILING_ENABLED: "true",
      RISK_TRAILING_ACTIVATION_PCT: "2.5",
      RISK_TRAILING_RETURN_PCT: "1",
      RISK_TIME_STOP_HOURS: "48",
    },
    {}
  );
  assert.equal(cfg.trailingEnabled, true);
  assert.equal(cfg.trailingActivationPct, 2.5);
  assert.equal(cfg.trailingReturnPct, 1);
  assert.equal(cfg.timeStopHours, 48);

  // Unsinnige/müllhafte Werte → sicherer Default (fail-closed, kein NaN).
  const garbage = loadExitConfig(
    {
      RISK_TRAILING_ENABLED: "vielleicht",
      RISK_TRAILING_ACTIVATION_PCT: "abc",
      RISK_TIME_STOP_HOURS: "",
    },
    {}
  );
  assert.equal(garbage.trailingEnabled, false);
  assert.equal(garbage.trailingActivationPct, DEFAULT_EXIT_CONFIG.trailingActivationPct);
  assert.equal(garbage.timeStopHours, 0);
});

// ═════════════════════════════════════════════════════════════════════════
// B) Reine Logik — decideExit (D1/D2/D3, Fake-Clock)
// ═════════════════════════════════════════════════════════════════════════

const baseInput: ExitDecisionInput = {
  side: "LONG",
  entryPrice: 100,
  price: 100,
  stopLoss: 95,
  takeProfit: 110,
  trailingStop: null,
  trailingArmed: false,
  createdAtMs: T0,
  nowMs: T0,
};

const trailingCfg = { trailingEnabled: true, trailingActivationPct: 1, trailingReturnPct: 0.5, timeStopHours: 0 };

test("GAP-05 D1: Trailing-Lifecycle — bewaffnet bei Activation, Ratchet nur aufwärts, Trigger TRAILING_STOP", () => {
  // 1) +0.9 % Gewinn: unter Activation (1 %) → NICHT bewaffnet.
  const t1 = decideExit({ ...baseInput, price: 100.9 }, trailingCfg);
  assert.equal(t1.trailingArmed, false);
  assert.equal(t1.trailingStop, null);
  assert.equal(t1.reason, null);

  // 2) +2 %: über Activation → bewaffnet, Stop = Kurs − Rückgabeweg (0.5 %).
  const t2 = decideExit({ ...baseInput, price: 102 }, trailingCfg);
  assert.equal(t2.trailingArmed, true);
  assert.ok(Math.abs((t2.trailingStop as number) - 102 * 0.995) < 1e-9, `Stop≈101.49, war ${t2.trailingStop}`);
  assert.equal(t2.reason, null);

  // 3) Neuer Hoch 102.1: Kurs über Stop → kein Exit, der Stop hebt sich auf 102.1·0.995.
  const t3 = decideExit(
    { ...baseInput, price: 102.1, trailingArmed: true, trailingStop: t2.trailingStop, nowMs: T0 + 60_000 },
    trailingCfg,
  );
  assert.equal(t3.reason, null);
  assert.equal(t3.trailingStop, Math.max(t2.trailingStop as number, 102.1 * 0.995), "Stop hebt sich bei neuem Hoch");

  // 4) Ratchet: Stop sinkt NIE unter den bisherigen Level, auch bei Rückgang über dem Stop.
  const prevStop = t2.trailingStop as number;
  const t4 = decideExit({ ...baseInput, price: 101.8, trailingArmed: true, trailingStop: prevStop }, trailingCfg);
  assert.equal(t4.reason, null, "101.8 > Stop 101.49 → kein Trigger");
  assert.ok((t4.trailingStop as number) >= prevStop, `Ratchet: Stop darf nicht fallen (${t4.trailingStop} < ${prevStop})`);

  // 5) Kurs ≤ Stop → TRAILING_STOP.
  const t5 = decideExit({ ...baseInput, price: 101.4, trailingArmed: true, trailingStop: prevStop }, trailingCfg);
  assert.equal(t5.reason, "TRAILING_STOP");
});

test("GAP-05 D1: Trailing SHORT gespiegelt — Stop fällt nur (nie steigt er)", () => {
  const cfg = { ...trailingCfg };
  // SHORT-Konstellation: SL über Entry (105), TP unter Entry (90).
  const short = { ...baseInput, side: "SHORT" as const, stopLoss: 105, takeProfit: 90 };
  // Entry 100, Kurs 98 (2 % Gewinn) → bewaffnet, Stop = 98 × 1.005 = 98.49.
  const a = decideExit({ ...short, price: 98 }, cfg);
  assert.equal(a.trailingArmed, true);
  assert.ok(Math.abs((a.trailingStop as number) - 98 * 1.005) < 1e-9);

  // Kurs steigt auf 98.3 (unter Stop) → kein Exit. Der Ratchet erlaubt nur
  // SENKUNGEN (günstigere Stops): 98.3·1.005 = 98.79 > 98.49 → NICHT übernehmen.
  const b = decideExit({ ...short, price: 98.3, trailingArmed: true, trailingStop: a.trailingStop }, cfg);
  assert.equal(b.reason, null);
  assert.equal(b.trailingStop, a.trailingStop, "Stop wird nicht Richtung Kurs angehoben (nur erweitert)");

  // Besserer Stand 97.8 → Stop sinkt auf 97.8·1.005.
  const b2 = decideExit({ ...short, price: 97.8, trailingArmed: true, trailingStop: a.trailingStop }, cfg);
  assert.ok((b2.trailingStop as number) < (a.trailingStop as number), "SHORT-Ratchet: Stop fällt mit dem Kurs");
  assert.equal(b2.reason, null);

  // Kurs ≥ Stop → Auslösung.
  const c = decideExit({ ...short, price: 98.5, trailingArmed: true, trailingStop: a.trailingStop }, cfg);
  assert.equal(c.reason, "TRAILING_STOP");
});

test("GAP-05 D2: Time-Stop — Ablauf schließt, 0 = inaktiv, vor Ablauf bleibt die Position offen", () => {
  const cfg = { ...trailingCfg, trailingEnabled: false, timeStopHours: 24 };
  // 24 h + 1 Minute alten Trade → TIME_STOP (Preis ohne jede Stop-Berührung).
  const hit = decideExit({ ...baseInput, price: 100.5, nowMs: T0 + 24 * HOUR + 60_000 }, cfg);
  assert.equal(hit.reason, "TIME_STOP");

  // 23 h → kein Exit.
  const miss = decideExit({ ...baseInput, price: 100.5, nowMs: T0 + 23 * HOUR }, cfg);
  assert.equal(miss.reason, null);

  // 0 (Default) = komplett inaktiv, auch nach 400 Tagen.
  const off = decideExit({ ...baseInput, price: 100.5, nowMs: T0 + 400 * 24 * HOUR }, { ...cfg, timeStopHours: 0 });
  assert.equal(off.reason, null);
});

test("GAP-05 D3: OCO-Priorität — genau EIN Grund, SL vor TP vor Trailing vor Time", () => {
  // SL und TP gleichzeitig berührt → SL gewinnt, bothHit markiert (wie bisher: Stop zuerst).
  const both = decideExit(
    { ...baseInput, price: 94, stopLoss: 95, takeProfit: 93 }, // TP läge unter SL — beide berührt
    trailingCfg,
  );
  assert.equal(both.reason, "STOP_LOSS");
  assert.equal(both.bothHit, true);

  // Trailing + Time-Stop fällig → preisbasierter Trailing-Stop zuerst.
  const trailingFirst = decideExit(
    { ...baseInput, price: 94.2, stopLoss: null, trailingArmed: true, trailingStop: 94.5, nowMs: T0 + 100 * HOUR },
    { ...trailingCfg, timeStopHours: 24 },
  );
  assert.equal(trailingFirst.reason, "TRAILING_STOP");

  // Nur Time-Stop greift, wenn kein Preis-Trigger da ist.
  const timeOnly = decideExit(
    { ...baseInput, price: 100.5, nowMs: T0 + 30 * HOUR },
    { ...trailingCfg, timeStopHours: 24 },
  );
  assert.equal(timeOnly.reason, "TIME_STOP");
});

test("GAP-05 D4: Flags aus → decideExit verhält sich exakt wie der bisherige SL/TP-Watcher", () => {
  const off = DEFAULT_EXIT_CONFIG; // trailingEnabled false, timeStopHours 0
  // SL unverändert → STOP_LOSS.
  assert.equal(decideExit({ ...baseInput, price: 95 }, off).reason, "STOP_LOSS");
  // TP unverändert → TAKE_PROFIT.
  assert.equal(decideExit({ ...baseInput, price: 110 }, off).reason, "TAKE_PROFIT");
  // Dazwischen → kein Exit, KEIN trailing state change, kein bothHit-Fehlerfall.
  const mid = decideExit({ ...baseInput, price: 105, trailingArmed: true, trailingStop: 103 }, off);
  assert.equal(mid.reason, null);
  assert.equal(mid.trailingChanged, false, "ausgeschaltet → Schreib-Pfad bleibt unberührt (null Drift auf der DB)");
});

// ═════════════════════════════════════════════════════════════════════════
// C) Reine Broker-Semantik: close nur einmal (Ledger-Ebene)
// ═════════════════════════════════════════════════════════════════════════

test("GAP-05 D3: Broker.close ist einmalig — zweiter Close liefert null (kein Doppel-Fill im Ledger)", () => {
  setQuoteCache(SYM, 100);
  const b = new PaperBroker(10_000);
  b.hydrate([{ symbol: SYM, side: "LONG", qty: 10, entryPrice: 100 }], { cashHint: 9_000 });
  const first = b.close(SYM, "STOP_LOSS");
  assert.ok(first, "erster Close füllt");
  assert.equal(first?.realizedPnl, 0);
  const second = b.close(SYM, "TAKE_PROFIT");
  assert.equal(second, null, "zweiter Close auf selbe Position = null (no-op, kein Fehler)");
  assert.equal(b.openPositions, 0);
});

test("GAP-05 D1: hydrate trägt Trailing-Zustand ein (Ledger-Spiegel der DB)", () => {
  const b = new PaperBroker(10_000);
  b.hydrate(
    [
      { symbol: SYM, side: "LONG", qty: 10, entryPrice: 100, trailingStop: 101.5, trailingArmed: true },
      { symbol: `${SYM}B`, side: "SHORT", qty: 10, entryPrice: 100, trailingStop: 101.5, trailingArmed: false },
    ],
    { cashHint: 8_000 },
  );
  const view = b.listPositions();
  const a = view.find((p) => p.symbol === SYM);
  assert.equal(a?.trailingArmed, true);
  assert.equal(a?.trailingStop, 101.5);
  const rest = view.find((p) => p.symbol === `${SYM}B`);
  assert.equal(rest?.trailingArmed, false, "bewaffnet=false bleibt bewaffnet=false");
});

// ═════════════════════════════════════════════════════════════════════════
// D) E2E gegen echte DB (Skip ohne Postgres): tick()-Integration
// ═════════════════════════════════════════════════════════════════════════

test("GAP-05 D1 (DB): Trailing-Lifecycle im tick() — Bewaffnung persists, Ratchet nach oben, Exit TRAILING_STOP", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  setExitEnv({
    RISK_TRAILING_ENABLED: "true",
    RISK_TRAILING_ACTIVATION_PCT: "1",
    RISK_TRAILING_RETURN_PCT: "0.5",
  });
  const id = await seedPosition({ price: 100, stopLoss: 90, takeProfit: null });

  // Tick 1: Kurs +0.5 % — unter Activation → unbewaffnet, Position offen.
  await tickAt(1 * HOUR, 100.5);
  let row = await readPosition(id);
  assert.equal(row.status, "OPEN");
  assert.equal(row.trailingArmed, false);
  assert.equal(row.trailingStop, null);

  // Tick 2: Kurs +2 % — bewaffnet, Stop = 102·0.995 = 101.49 (persistiert!).
  await tickAt(2 * HOUR, 102);
  row = await readPosition(id);
  assert.equal(row.status, "OPEN");
  assert.equal(row.trailingArmed, true);
  assert.ok(Math.abs(Number(row.trailingStop) - 101.49) < 1e-6, `Stop persistiert, war ${row.trailingStop}`);

  // Tick 3: Kurs +3 % → Ratchet auf 103·0.995 = 102.485 (nur aufwärts).
  await tickAt(3 * HOUR, 103);
  row = await readPosition(id);
  assert.ok(Number(row.trailingStop) > 101.49, "Stop hebt mit dem Kurs");
  const stopAfterUp = Number(row.trailingStop);

  // Tick 4: Rückgang auf 102.6 (über Stop) → Stop bleibt, kein Absenken.
  await tickAt(4 * HOUR, 102.6);
  row = await readPosition(id);
  assert.equal(Number(row.trailingStop), stopAfterUp, "Stop wird NIE abgesenkt (Ratchet)");
  assert.equal(row.status, "OPEN");

  // Tick 5: Kurs ≤ Stop → TRAILING_STOP-Exit, genau ein Audit.
  const res = (await tickAt(5 * HOUR, 102.4)) as Awaited<ReturnType<typeof tick>>;
  row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.equal(row.exitReason, "TRAILING_STOP");
  assert.ok(res.stopsTriggered.some((s) => s.symbol === SYM && s.reason === "TRAILING_STOP"), JSON.stringify(res.stopsTriggered));
  assert.equal(await countExitAudits("TRAILING_STOP"), 1, "genau EIN Exit-Audit pro Exit");

  // Bewaffnung wird genau EINMAL auditiert (nicht pro Ratchet-Anhebung).
  const [armed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(sql`${auditLog.event} = 'TRAILING_STOP_ARMED' and ${auditLog.detail} ->> 'code' = ${`trailing-arm:${SYM}`}`);
  assert.equal(Number(armed?.n ?? 0), 1, "genau EIN Bewaffnungs-Audit je Position");
});

test("GAP-05 D1 (DB): Restart-Persistenz — nach invalidateBrokerCache rehydriert der Ledger den bewaffneten Stop aus der DB", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  setExitEnv({
    RISK_TRAILING_ENABLED: "true",
    RISK_TRAILING_ACTIVATION_PCT: "1",
    RISK_TRAILING_RETURN_PCT: "0.5",
  });
  // Position bereits bewaffnet in der DB persistiert (Stop 101.49, armed).
  const id = await seedPosition({ price: 100, stopLoss: 90, trailingStop: 101.49, trailingArmed: true });

  // „Neustart“: Cache verwerfen → der nächste Broker-Zugriff rehydriert aus der DB.
  invalidateBrokerCache();
  const broker = await getBroker();
  const pos = broker.getPosition(SYM);
  assert.ok(pos, "Position aus DB rehydriert");
  assert.equal(pos?.trailingArmed, true, "bewaffneter Zustand überlebt den Neustart (kein Memory-Only)");
  assert.equal(pos?.trailingStop, 101.49);

  // Und der nächste Tick VERWENDET den persistierten Stop: Kurs darunter → Exit.
  const res = (await tickAt(2 * HOUR, 101.4)) as Awaited<ReturnType<typeof tick>>;
  const row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.equal(row.exitReason, "TRAILING_STOP");
  assert.equal(res.stopsTriggered.length, 1);
  assert.equal(await countExitAudits("TRAILING_STOP"), 1);
});

test("GAP-05 D2 (DB): Time-Stop — Ablauf schließt via tick(), 0 lässt die Position unberührt", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  setExitEnv({ RISK_TIME_STOP_HOURS: "24" });
  // 25 h alte Position, Preis ohne Trigger (SL weit weg, kein TP).
  const id = await seedPosition({ price: 100, stopLoss: 50, takeProfit: null, createdAtMs: T0 - 25 * HOUR });
  const res = (await tickAt(0, 100.5)) as Awaited<ReturnType<typeof tick>>;
  const row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.equal(row.exitReason, "TIME_STOP");
  assert.ok(res.stopsTriggered.some((s) => s.reason === "TIME_STOP"));
  assert.equal(await countExitAudits("TIME_STOP"), 1);

  // Default 0 → identische, 25 h alte Position bleibt offen.
  await cleanDb();
  setExitEnv({});
  const id2 = await seedPosition({ price: 100, stopLoss: 50, createdAtMs: T0 - 25 * HOUR });
  await tickAt(0, 100.5);
  assert.equal((await readPosition(id2)).status, "OPEN");
});

test("GAP-05 D3 (DB): OCO-Race — zwei parallele applyExit-Aufrufe (SL/TP) schließen GENAU einmal", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  const id = await seedPosition({ price: 100, stopLoss: 95, takeProfit: 105 });
  await tickAt(1, 100); // stellt die Broker-Hydration sicher (Ledger kennt die Position)

  const broker = await getBroker();
  const common = {
    broker,
    positionId: id,
    symbol: SYM,
    side: "LONG" as const,
    qty: 1,
    entryPrice: 100,
    createdAt: new Date(T0 - HOUR),
    now: new Date(T0),
    triggerPrice: 95,
  };
  // Zwei parallele, UNABHÄNGIGE Exit-Pfade (wie zwei Ticks/Prozesse):
  // einer will wegen SL schließen, der andere wegen TP.
  const results = await Promise.all([
    applyExit({ ...common, reason: "STOP_LOSS" }),
    applyExit({ ...common, reason: "TAKE_PROFIT" }),
  ]);

  const closed = results.filter((r) => r.closed);
  assert.equal(closed.length, 1, `genau EIN Gewinner, beide: ${JSON.stringify(results.map((r) => r.closed))}`);
  const loser = results.find((r) => !r.closed);
  assert.equal(loser?.fill, undefined, "der Verlierer führt KEINEN Fill aus");

  const row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.ok(["STOP_LOSS", "TAKE_PROFIT"].includes(row.exitReason ?? ""));
  assert.equal(broker.openPositions, 0, "Ledger konsistent: Position genau einmal entfernt");
  const audits = (await countExitAudits("STOP_LOSS")) + (await countExitAudits("TAKE_PROFIT"));
  assert.equal(audits, 1, "genau EIN revisionssicherer Audit-Eintrag");
});

test("GAP-05 D3 (DB): zwei parallele tick()-Aufrufe (Promise.all) → ein Exit, zweiter Zyklus no-op", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  const id = await seedPosition({ price: 100, stopLoss: 95, takeProfit: null });

  // SL und TP parallel: tick() ist Single-Flight — Promise.all liefert EINEN
  // Zyklus; der „zweite Tick“ sieht die PositionCLOSED und macht sauber nichts.
  const [a, b] = (await Promise.all([tickAt(2 * HOUR, 94), tickAt(2 * HOUR, 94)])) as [
    Awaited<ReturnType<typeof tick>>,
    Awaited<ReturnType<typeof tick>>,
  ];
  assert.equal(a.stopsTriggered.length, 1, "genau ein Exit im gemeinsamen Zyklus");
  assert.equal(a.stopsTriggered[0].reason, "STOP_LOSS");
  assert.equal(b.stopsTriggered.length, 1, "beide Aufrufer teilen dasselbe Ergebnis (Single-Flight)");

  // Erneuter Tick nach dem Exit: kein zweiter Close, kein symbolbezogener
  // Fehler (der zweite Zyklus behandelt die Position als bereits geschlossen),
  // kein zweites Audit.
  const c = (await tickAt(3 * HOUR, 93)) as Awaited<ReturnType<typeof tick>>;
  assert.equal(c.stopsTriggered.length, 0, "bereits geschlossene Position = no-op");
  assert.ok(!c.errors.some((e) => e.includes(SYM)), `kein Fehler zur geschlossenen Position: ${JSON.stringify(c.errors)}`);
  const row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.equal(await countExitAudits("STOP_LOSS"), 1, "Audit bleibt bei GENAU einem Eintrag");

  // Ledger konsistent: Broker zeigt die Position nicht mehr offen.
  const broker = await getBroker();
  assert.equal(broker.getPosition(SYM), null);
});

test("GAP-05 D3 (DB): Multi-Instanz-Race — zwei echte Postgres-Transaktionen claims, genau ein Exit", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  const id = await seedPosition({ price: 100, stopLoss: 95 });

  // Bedingtes UPDATE … WHERE status='OPEN' zweimal GLEICHZEITIG aus zwei
  // Verbindungen — exakt das Claim-Muster von applyExit, ohne In-Memory-Vorabprüfung.
  const url = process.env.DATABASE_URL as string;
  const [c1, c2] = [new Client({ connectionString: url, connectionTimeoutMillis: 3000 }), new Client({ connectionString: url, connectionTimeoutMillis: 3000 })];
  await c1.connect();
  await c2.connect();
  const claim = (reason: string, client: Client) =>
    client.query(
      `update positions set status='CLOSED', exit_reason=$2, updated_at=now()
        where id=$1 and status='OPEN' returning id`,
      [id, reason]
    );
  const [r1, r2] = await Promise.all([claim("STOP_LOSS", c1), claim("TAKE_PROFIT", c2)]);
  const winners = [r1, r2].filter((r) => r.rows.length === 1);
  assert.equal(winners.length, 1, "genau eine Transaktion bekommt die Zeile");
  await c1.end();
  await c2.end();

  const row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.ok(["STOP_LOSS", "TAKE_PROFIT"].includes(row.exitReason ?? ""));
});

test("GAP-05 D4 (DB): alle Flags aus → nur SL/TP wie bisher, Trailing-Spalten bleiben unangetastet", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  setExitEnv({}); // Default: alles aus
  // Gewinn +2 % (würde bei Trailing-An bewaffnen) und TP/SL daneben.
  const id = await seedPosition({ price: 100, stopLoss: 95, takeProfit: 110 });
  const r1 = (await tickAt(1 * HOUR, 102)) as Awaited<ReturnType<typeof tick>>;
  let row = await readPosition(id);
  assert.equal(row.status, "OPEN");
  assert.equal(row.trailingArmed, false, "Flag aus → keine Bewaffnung, kein DB-Schreibeffekt");
  assert.equal(row.trailingStop, null);

  // TP unverändert wirksam (altes Verhalten): Exit TAKE_PROFIT.
  const r2 = (await tickAt(2 * HOUR, 110)) as Awaited<ReturnType<typeof tick>>;
  row = await readPosition(id);
  assert.equal(row.status, "CLOSED");
  assert.equal(row.exitReason, "TAKE_PROFIT");
  assert.equal(r2.stopsTriggered.length, 1);
  assert.equal(r1.stopsTriggered.length, 0);
});

test("GAP-05 Audit (DB): Journal-Zeile erhält den Exit-Grund (TRAILING_STOP sichtbar)", async (t) => {
  if (skipWithoutDb(t)) return;
  await cleanDb();
  setExitEnv({
    RISK_TRAILING_ENABLED: "true",
    RISK_TRAILING_ACTIVATION_PCT: "1",
    RISK_TRAILING_RETURN_PCT: "0.5",
  });
  const id = await seedPosition({ price: 100, trailingStop: 101.49, trailingArmed: true });
  await tickAt(1, 101.0); // unter dem Stop → Exit mit persistiertem Stop
  const row = await readPosition(id);
  assert.equal(row.exitReason, "TRAILING_STOP");

  const [journalRow] = await db
    .select({ exitReason: tradeJournal.exitReason, positionId: tradeJournal.positionId })
    .from(tradeJournal)
    .where(sql`${tradeJournal.positionId} = ${id}`);
  assert.equal(journalRow?.exitReason, "TRAILING_STOP", "Journal übernimmt die maschinenlesbare Taxonomie");
});

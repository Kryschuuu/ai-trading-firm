/**
 * RESTORE-01 (MEDIUM) — Zustandswiederherstellung des Paper-Ledgers
 * (`getBroker()` in `src/lib/engine.ts`) ist ein Hot-Pfad: er läuft beim
 * ersten Zugriff nach jedem Prozessstart und wird von HTTP-Requests
 * (`/api/firm`), dem 60-s-Monitor-Tick und der Agenten-Pipeline ausgelöst.
 *
 * Der Befund (Arena-Prompt 13, dort für einen Django-Bot formuliert — für
 * diesen Stack übersetzt): eine Zustandswiederherstellung, die bei großen
 * Tabellen unnötige, unkoordinierte Arbeit im Hauptstrang verrichtet.
 *
 * Hier sind die belastbaren Angriffs-/Ausnutzungspunkte:
 *   1. Kein Single-Flight: N parallele Kaltstarts lösen N vollständige
 *      Restores aus (Thundering Herd auf einer indizlosen Sequenz-Scan-Query).
 *   2. Kein Backoff nach Fehlern: jeder einzelne Aufruf wiederholt den
 *      teuren Restore bis ins Unendliche (Verstärker bei DB-Degradation).
 *   3. Kein Index auf `positions(status)`: `WHERE status = 'OPEN'` scannt die
 *     komplette, append-only wachsende Tabelle (20.000+ Zeilen sind normal).
 *
 * Fake-DB: `globalThis.__arenaNextJsPostgresqlDb` ist der etablierte
 * Injektions-Haken aus `src/db/index.ts` (gleiche Technik wie
 * `tests/auditReliability.test.ts` und `tests/sec06.ruleLifecycleAuthz.test.ts`).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test, beforeEach, afterEach } from "node:test";
import {
  equitySnapshots,
  killSwitches,
  positions,
} from "../src/db/schema";
import { __resetAllSingletonsForTests, state } from "../src/lib/stateRegistry";

const G = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlDb?: unknown;
};

let previousDb: unknown = undefined;
let dbWasSet = false;

interface RestoreCounters {
  /** Sequenz-Scan auf `positions` WHERE status = 'OPEN' — der teure Teil. */
  openScans: number;
  equityReads: number;
  killReads: number;
}

const OPEN_ROWS = [
  {
    symbol: "BTC",
    side: "LONG",
    qty: "0.5",
    entryPrice: "20000",
    stopLoss: "19000",
    takeProfit: "24000",
  },
  {
    symbol: "ETH",
    side: "SHORT",
    qty: "2",
    entryPrice: "1500",
    stopLoss: null,
    takeProfit: null,
  },
];

/**
 * Installiert eine zählende (und optional langsam/werfende) Fake-DB.
 *
 * `delayMs` simuliert einen degradierten Datenbank-Endpunkt: die Restore-Arbeit
 * überlappt dann realistisch, wenn mehrere Aufrufer gleichzeitig klopfen.
 */
function installFakeDb(
  counters: RestoreCounters,
  opts: { fail?: boolean; delayMs?: number } = {}
): void {
  const settle = (table: unknown): Promise<unknown[]> => {
    if (table === positions) counters.openScans += 1;
    else if (table === equitySnapshots) counters.equityReads += 1;
    else if (table === killSwitches) counters.killReads += 1;
    const rows =
      table === positions
        ? OPEN_ROWS
        : table === equitySnapshots
          ? [{ cash: "9000" }]
          : [];
    const delay = opts.delayMs ?? 0;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (opts.fail) reject(new Error("forced restore failure (RESTORE-01)"));
        else resolve(rows);
      }, delay);
    });
  };

  /** thenable Query-Builder-Kette: select().from(t).where()/.orderBy().limit() */
  const chainFor = (table: unknown) => {
    const chain: Record<string, unknown> = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (
        onOk: (v: unknown[]) => unknown,
        onErr: (e: unknown) => unknown
      ) => settle(table).then(onOk, onErr),
    };
    return chain;
  };

  G.__arenaNextJsPostgresqlDb = {
    select: () => ({ from: (table: unknown) => chainFor(table) }),
    // Audit-Schreibpfade (best-effort) dürfen im Test nicht scheitern.
    insert: () => ({
      values: () => ({
        onConflict: () => ({ then: (onOk: (v: unknown[]) => unknown) => onOk([]) }),
        then: (onOk: (v: unknown[]) => unknown) => onOk([]),
      }),
    }),
  };
}

beforeEach(() => {
  __resetAllSingletonsForTests();
  previousDb = G.__arenaNextJsPostgresqlDb;
  dbWasSet = previousDb !== undefined;
});

afterEach(() => {
  delete G.__arenaNextJsPostgresqlDb;
  if (dbWasSet) G.__arenaNextJsPostgresqlDb = previousDb;
});

const freshCounters = (): RestoreCounters => ({
  openScans: 0,
  equityReads: 0,
  killReads: 0,
});

// ── 1. Single-Flight: kein Thundering Herd beim Kaltstart ────────────────────

test("RESTORE-01: 10 parallele Kaltstarts lösen genau EINEN Restore der offenen Positionen", async () => {
  const counters = freshCounters();
  installFakeDb(counters, { delayMs: 15 });
  const { getBroker } = await import("../src/lib/engine");

  await Promise.all(Array.from({ length: 10 }, () => getBroker()));

  assert.equal(
    counters.openScans,
    1,
    `Single-Flight erwartet, aber ${counters.openScans} sequenzielle Scans auf positions ausgeführt`
  );
  assert.equal(counters.equityReads, 1, "Equity-Snapshot genau einmal lesen");
  assert.equal(counters.killReads, 1, "Kill-Switch-Zustand genau einmal lesen");
});

test("RESTORE-01: Request-Flut gegen /api/firm vervielfacht die DB-Last nicht (Angriffsvektor)", async () => {
  const counters = freshCounters();
  installFakeDb(counters, { delayMs: 5 });
  const { getBroker } = await import("../src/lib/engine");

  // 200 gleichzeitige Leser (Requests/Ticks) — genau EIN Restore darf laufen.
  const wave = Promise.all(Array.from({ length: 200 }, () => getBroker()));
  await wave;

  assert.equal(
    counters.openScans,
    1,
    `Restore-Arbeit muss gebündelt werden (sonst 200 Scans), war: ${counters.openScans}`
  );
});

// ── 2. Erfolg wird nicht wiederholt ─────────────────────────────────────────

test("RESTORE-01: nach erfolgreichem Restore fragt kein weiterer Aufruf die DB", async () => {
  const counters = freshCounters();
  installFakeDb(counters);
  const { getBroker } = await import("../src/lib/engine");

  await getBroker();
  await getBroker();
  for (let i = 0; i < 25; i++) await getBroker();

  assert.equal(counters.openScans, 1, "Restore ist einmalig (Flag `firmHydrated`)");
  assert.equal(state.firmHydrated.get(), true, "Hydrations-Flag steht nach Erfolg");
});

// ── 3. Fehlerpfad: gedeckelter Versuch statt unbegrenzter Wiederholung ──────

test("RESTORE-01: fehlgeschlagener Restore wird nicht bei jedem Aufruf wiederholt (Backoff)", async () => {
  const counters = freshCounters();
  installFakeDb(counters, { fail: true });
  const { getBroker } = await import("../src/lib/engine");

  for (let i = 0; i < 20; i++) {
    await getBroker(); // Schluckt den Fehler bewusst (App läuft mit leerem Zustand).
  }

  assert.equal(
    counters.openScans,
    1,
    `höchstens EIN Restore-Versuch pro Backoff-Fenster erwartet, bekommen: ${counters.openScans}`
  );
  assert.equal(
    state.firmHydrated.get(),
    false,
    "Fehler darf NICHT als hydratisiert markiert werden (fail-offen für den Cache, nicht für die Wahrheit)"
  );
});

test("RESTORE-01: invalidateBrokerCache() hebt das Backoff-Fenster sofort auf", async () => {
  const counters = freshCounters();
  installFakeDb(counters, { fail: true });
  const { getBroker, invalidateBrokerCache } = await import("../src/lib/engine");

  await getBroker();
  await getBroker();
  assert.equal(counters.openScans, 1, "Backoff greift zwischen den Aufrufen");

  invalidateBrokerCache();
  await getBroker();
  assert.equal(
    counters.openScans,
    2,
    "explizite Invalidierung (z. B. Kill-Switch-Route) erzwingt sofortigen Neustart des Restores"
  );
});

test("RESTORE-01: Restore-Fehler loggt höchstens einmal pro Fenster (kein Log-Amplifier)", async () => {
  const counters = freshCounters();
  installFakeDb(counters, { fail: true });
  const { getBroker } = await import("../src/lib/engine");

  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    for (let i = 0; i < 12; i++) await getBroker();
  } finally {
    console.error = original;
  }

  const restoreLogs = errors.filter((args) =>
    String(args[0] ?? "").includes("[getBroker]")
  );
  assert.equal(
    restoreLogs.length,
    1,
    `Restore-Fehler darf nicht 12x ins Journal schreiben, war: ${restoreLogs.length}`
  );
});

// ── 4. Korrekte Wiederherstellung (Regression: Verhalten bleibt identisch) ──

test("RESTORE-01: offene Positionen, Cash-Hinweis und Schutzebenen werden korrekt hydratisiert", async () => {
  const counters = freshCounters();
  installFakeDb(counters);
  const { getBroker } = await import("../src/lib/engine");

  const broker = await getBroker();

  assert.equal(broker.openPositions, 2, "beide offenen Positionen hydratisiert");
  assert.equal(broker.getPosition("BTC")?.qty, 0.5);
  assert.equal(broker.getPosition("BTC")?.stopLoss, 19000, "SL/TP bleiben erhalten (v1.5.2)");
  assert.equal(broker.accountEquity > 0, true, "Equity ist nach Restore positiv");
  assert.equal(counters.openScans, 1);
});

// ── 5. Schema/Migration: Restore-Query darf keinen Full-Scan brauchen ───────

test("RESTORE-01: positions Tabelle deklariert einen partiellen Index für status='OPEN'", () => {
  const schema = readFileSync(new URL("../src/db/schema.ts", import.meta.url), "utf8");
  const block = schema.slice(
    schema.indexOf("export const positions = pgTable"),
    schema.indexOf("export const agentMessages")
  );
  assert.match(
    block,
    /index\("positions_open_idx"\)/,
    "src/db/schema.ts muss positions_open_idx deklarieren (sonst verschwindet er beim naechsten drizzle-kit push)"
  );
  assert.match(
    block,
    /where\(sql`\$\{t\.status\} = 'OPEN'`\)/,
    "Index muss partiell auf status = 'OPEN' sein — genau die Restore-Prädikat"
  );
});

test("RESTORE-01: idempotente Migration liegt in drizzle/ (SQL-Pfad ohne drizzle-kit)", () => {
  const file = new URL("../drizzle/2026-09-08_positions_open_idx.sql", import.meta.url);
  assert.ok(existsSync(file), "drizzle/2026-09-08_positions_open_idx.sql fehlt");
  const sqlText = readFileSync(file, "utf8");
  assert.match(sqlText, /CREATE INDEX IF NOT EXISTS "positions_open_idx"/);
  assert.match(sqlText, /ON "positions" USING btree \("symbol"\)/);
  assert.match(sqlText, /WHERE "status" = 'OPEN'/);
});

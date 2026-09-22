/**
 * Tests: Volatility-Targeting Engine (LIVE-Orchestrator, RMA-P5-01, v1.67.0).
 *
 * Deckt die Pflicht-Paths mit INJIZIERTEN Dependencies ab (kein echtes DB,
 * kein echter Marktdatenzugriff):
 *   - monitor-Modus (Default): Persistenz ja, Faktorwirkung NEIN
 *   - active-Modus: Faktor wirkt auf die Risk-Guard-Kaskade + Persistenz
 *   - off-Modus: Faktor wird zurückgenommen
 *   - Idempotenz: Retry/Restart in derselben Minute ⇒ keine doppelte Zeile
 *   - No-Exposure ⇒ neutral (1), kein Fallback
 *   - Datenfehler ⇒ fail-closed Fallback (minMultiplier)
 *   - Single-Flight + Min-Interval
 *   - Status-API (synchron) spiegelt den letzten Lauf
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  __resetVolatilityTargetingForTests,
  getVolatilityTargetingStatus,
  updateVolatilityTargeting,
  type OpenPositionRow,
  type VtpDbLike,
  type VolatilityTargetingDeps,
} from "../src/lib/volatilityTargeting";
import type { Candle } from "../src/lib/marketData";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { getVolatilityTargetingState } from "../src/lib/riskGuard";
import { resolveVolatilityTargetingConfig } from "../src/portfolio/volatilityTargeting";

// ─────────────────────────────────────────────────────────────────────────────
// Test-Doppel: strukturelles VtpDbLike
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRow {
  [k: string]: unknown;
}

class FakeVtpDb implements VtpDbLike {
  /** Alle Snapshots (inserts in volatilityTargetingSnapshots). */
  readonly snapshots: FakeRow[] = [];
  /** risk_config-Keys (vtp.activeFactor/vtp.activeAt). */
  readonly riskConfig: Map<string, string> = new Map();
  /** Count der Snapshot-Inserts (inkl. Duplikate). */
  snapshotInserts = 0;
  /** Count der risk_config-Upserts. */
  riskConfigUpserts = 0;
  /** Simulierter Konflikt: wenn `duplicateSnapshotId` gesetzt ist, liefert
   *  onConflictDoNothing().returning() leer. */
  private seenSnapshotIds = new Set<string>();

  select() {
    return {
      async from(_t: unknown): Promise<FakeRow[]> {
        return [];
      },
    };
  }

  insert(_t: unknown) {
    const self = this;
    return {
      values(v: Record<string, unknown>) {
        return {
          onConflictDoNothing() {
            return {
              async returning(_f?: unknown): Promise<FakeRow[]> {
                self.snapshotInserts += 1;
                const id = v.snapshotId as string;
                if (self.seenSnapshotIds.has(id)) return [];
                self.seenSnapshotIds.add(id);
                self.snapshots.push(v);
                return [{ id: self.snapshots.length }];
              },
            };
          },
          async onConflictDoUpdate() {
            self.riskConfigUpserts += 1;
            const key = v.key as string;
            self.riskConfig.set(key, v.value as string);
          },
        };
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kerzen-Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/**
 * Baut `n` geschlossene 1h-Kerzen mit alternierenden Closes (deterministische
 * Volatilität). Die Kerze mit `time` ist geschlossen, wenn `time + HOUR ≤ now`.
 */
function candlesFor(base: number, n: number, start: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = i % 2 === 0 ? base : base * 1.02;
    out.push({
      time: start + i * HOUR,
      open: close * 0.99,
      high: close * 1.01,
      low: close * 0.98,
      close,
      volume: 1000,
    });
  }
  return out;
}

/** Standard-Config: kurze Lookback, keine Smoothing (einfache Prüfung). */
function testConfig(): ReturnType<typeof resolveVolatilityTargetingConfig> {
  return resolveVolatilityTargetingConfig({
    shrinkage: 0,
    minObservations: 4,
    lookbackPeriods: 24,
    smoothingAlpha: 1,
    enabled: true,
  });
}

/**
 * Referenzzeit nahe der Echtzeit (Minute gerundet), damit das Min-Interval
 * (das `Date.now()` nutzt) im Test greift. Kerzen enden 1h vor `now`
 * (geschlossen + frisch).
 */
function makeNow(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

/** Deps-Fabrik: zwei Positionen (TEST + TEST2), Kerzen-Provider, Fake-DB. */
function makeDeps(opts: {
  db?: FakeVtpDb;
  now?: number;
  positions?: OpenPositionRow[];
  candleError?: boolean;
} = {}): { deps: VolatilityTargetingDeps; db: FakeVtpDb } {
  const db = opts.db ?? new FakeVtpDb();
  const now = opts.now ?? makeNow();
  const positions: OpenPositionRow[] =
    opts.positions ?? [
      { symbol: "TEST", side: "LONG", qty: 10, entryPrice: 100, currentPrice: 100 },
      { symbol: "TEST2", side: "LONG", qty: 20, entryPrice: 50, currentPrice: 50 },
    ];
  const start = now - 26 * HOUR;
  const deps: VolatilityTargetingDeps = {
    now: () => now,
    fetchPositions: async () => positions,
    fetchCandles: async (symbol: string) => {
      if (opts.candleError) throw new Error("candle provider down");
      if (symbol === "TEST") return candlesFor(100, 26, start);
      if (symbol === "TEST2") return candlesFor(50, 26, start);
      return [];
    },
    db,
  };
  return { deps, db };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function setMode(mode: string | undefined): void {
  if (mode === undefined) delete process.env.PORTFOLIO_VOL_TARGETING_MODE;
  else process.env.PORTFOLIO_VOL_TARGETING_MODE = mode;
}

beforeEach(() => {
  savedEnv.PORTFOLIO_VOL_TARGETING_MODE = process.env.PORTFOLIO_VOL_TARGETING_MODE;
  savedEnv.AUDIT_SPOOL_DIR = process.env.AUDIT_SPOOL_DIR;
  savedEnv.AUDIT_RETRY_MAX = process.env.AUDIT_RETRY_MAX;
  savedEnv.AUDIT_RETRY_BASE_MS = process.env.AUDIT_RETRY_BASE_MS;
  savedEnv.AUDIT_DB_COOLDOWN_MS = process.env.AUDIT_DB_COOLDOWN_MS;
  process.env.AUDIT_SPOOL_DIR = mkdtempSync(path.join(tmpdir(), "vtp-engine-audit-"));
  process.env.AUDIT_RETRY_MAX = "1";
  process.env.AUDIT_RETRY_BASE_MS = "5";
  process.env.AUDIT_DB_COOLDOWN_MS = "0";
  process.env.PORTFOLIO_VOL_TARGETING_TIMEFRAME = "1h";
  __resetVolatilityTargetingForTests();
  __resetAllSingletonsForTests();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetVolatilityTargetingForTests();
  __resetAllSingletonsForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// Modus-Verhalten
// ─────────────────────────────────────────────────────────────────────────────

describe("Modi (Feature-Flag PORTFOLIO_VOL_TARGETING_MODE)", () => {
  test("monitor (Default): Persistenz ja, KEINE Faktorwirkung, kein activeFactor", async () => {
    setMode(undefined); // Default = monitor
    const { deps, db } = makeDeps();
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });

    assert.equal(status.mode, "monitor");
    assert.equal(status.active, false);
    assert.equal(status.forecast?.status, "OK");
    assert.ok(status.appliedMultiplier > 0 && status.appliedMultiplier <= 1);

    // Snapshot persistiert.
    assert.equal(db.snapshots.length, 1);
    assert.equal(db.snapshots[0].mode, "monitor");
    assert.equal(db.snapshots[0].monitorOnly, true);
    // ABER: kein activeFactor für den Mikro-Executor (monitor-only!).
    assert.equal(db.riskConfig.has("vtp.activeFactor"), false);
    // Und: Risk-Guard-Zustand ist NULL (Kaskade unverändert).
    assert.equal(getVolatilityTargetingState(), null);
  });

  test("active: Faktor wirkt auf Risk-Guard + activeFactor persistiert", async () => {
    setMode("active");
    const { deps, db } = makeDeps();
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });

    assert.equal(status.mode, "active");
    assert.equal(status.active, true);
    const applied = status.appliedMultiplier;

    // Risk-Guard-Zustand gesetzt, Faktor identisch.
    const vtState = getVolatilityTargetingState();
    assert.ok(vtState !== null, "active ⇒ volTargetState gesetzt");
    assert.ok(Math.abs(vtState!.factor - applied) < 1e-12);
    assert.ok(vtState!.factor <= 1 + 1e-15, "Faktor ist hart ≤ 1");

    // activeFactor für den Mikro-Executor persistiert.
    assert.ok(db.riskConfig.has("vtp.activeFactor"), "active ⇒ vtp.activeFactor geschrieben");
    assert.ok(db.riskConfig.has("vtp.activeAt"));
    assert.ok(Math.abs(Number(db.riskConfig.get("vtp.activeFactor")) - applied) < 1e-12);
  });

  test("off: Faktor wird zurückgenommen, keine Daten", async () => {
    setMode("off");
    // Erst im active-Modus einen Faktor setzen.
    setMode("active");
    const { deps, db } = makeDeps();
    await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    assert.ok(getVolatilityTargetingState() !== null);

    // Dann auf off: Faktor muss weg.
    setMode("off");
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    assert.equal(status.mode, "off");
    assert.equal(status.active, false);
    assert.equal(getVolatilityTargetingState(), null, "off ⇒ volTargetState gecleart");
    // off liest gar keine Positionen (früher Return).
    void db;
  });

  test("unbekannter Modus-Wert ⇒ monitor (kein Stillversagen)", async () => {
    setMode("banana");
    const { deps } = makeDeps();
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    assert.equal(status.mode, "monitor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Daten- und Fallback-Paths
// ─────────────────────────────────────────────────────────────────────────────

describe("Daten- und Fallback-Paths", () => {
  test("keine Positionen ⇒ NO_EXPOSURE, Faktor = 1 (neutral)", async () => {
    setMode("active");
    const { deps, db } = makeDeps({ positions: [] });
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });

    assert.equal(status.forecast?.status, "NO_EXPOSURE");
    assert.equal(status.forecast?.reasonCode, "ZERO_EXPOSURE");
    assert.equal(status.appliedMultiplier, 1);
    // Auch im active-Modus: neutraler Faktor, kein Fallback.
    assert.ok(Math.abs(getVolatilityTargetingState()!.factor - 1) < 1e-12);
    // Kein Snapshot (Cash-Portfolio ist kein Risiko-Event).
    assert.equal(db.snapshots.length, 0);
  });

  test("Kerzen-Provider tot ⇒ NO_SERIES-Fallback, Faktor = minMultiplier (fail-closed)", async () => {
    setMode("active");
    const { deps, db } = makeDeps({ candleError: true });
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });

    assert.equal(status.forecast?.status, "FALLBACK");
    assert.equal(status.forecast?.reasonCode, "NO_SERIES");
    assert.equal(status.forecast?.forecastAnnualizedVol, null, "null ≠ 0");
    // Konservativ: minMultiplier.
    assert.ok(Math.abs(status.appliedMultiplier - status.config.minMultiplier) < 1e-12);
    assert.ok(Math.abs(getVolatilityTargetingState()!.factor - status.config.minMultiplier) < 1e-12);
    // Snapshot persistiert (Fallback gehört auditgetrieben dokumentiert).
    assert.equal(db.snapshots.length, 1);
    assert.equal(db.snapshots[0].reasonCode, "NO_SERIES");
    assert.equal(db.snapshots[0].monitorOnly, false);
  });

  test("stale Kerzen (alles zu alt) ⇒ STALE_DATA-Fallback", async () => {
    setMode("active");
    const now = makeNow();
    // Kerzen enden 6h VOR `now` ⇒ letzte Event-Zeit > maxStaleness (2h).
    const start = now - 32 * HOUR; // letzte Kerze schließt bei now - 7h
    const db = new FakeVtpDb();
    const deps: VolatilityTargetingDeps = {
      now: () => now,
      fetchPositions: async () => [
        { symbol: "TEST", side: "LONG", qty: 10, entryPrice: 100, currentPrice: 100 },
      ],
      fetchCandles: async (symbol: string) =>
        symbol === "TEST" ? candlesFor(100, 26, start) : [],
      db,
    };
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    assert.equal(status.forecast?.status, "FALLBACK");
    assert.equal(status.forecast?.reasonCode, "STALE_DATA");
    assert.ok(Math.abs(status.appliedMultiplier - status.config.minMultiplier) < 1e-12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotenz
// ─────────────────────────────────────────────────────────────────────────────

describe("Idempotenz (Retry/Restart)", () => {
  test("zwei Läufe in derselben Minute mit gleicher Eingabe ⇒ 1 Zeile", async () => {
    setMode("monitor");
    const db = new FakeVtpDb();
    // Gleiche `now` ⇒ gleiche Minute ⇒ gleicher Idempotency-Key.
    const now = makeNow();
    const d1 = makeDeps({ db, now }).deps;
    const d2 = makeDeps({ db, now }).deps;

    const s1 = await updateVolatilityTargeting({ deps: d1, config: testConfig(), force: true });
    const s2 = await updateVolatilityTargeting({ deps: d2, config: testConfig(), force: true });

    assert.equal(db.snapshots.length, 1, "doppelte Zeile wäre ein Ledger-Verstoß");
    assert.match(String(db.snapshots[0].snapshotId), /^vt1:[0-9a-f]{64}$/);
    // Beide Läufe bleiben im zulässigen Bereich (Faktor ≤ 1); der Multiplikator
    // folgt bewusst der Max-Step-Kettung (s2 darf sich von s1 unterscheiden).
    assert.ok(s1.appliedMultiplier <= 1 && s2.appliedMultiplier <= 1);
  });

  test("anderer Zeitpunkt (nächste Minute) ⇒ neue Zeile", async () => {
    setMode("monitor");
    const db = new FakeVtpDb();
    const now1 = makeNow();
    const now2 = now1 + 61_000; // nächste Minute
    await updateVolatilityTargeting({
      deps: makeDeps({ db, now: now1 }).deps,
      config: testConfig(),
      force: true,
    });
    await updateVolatilityTargeting({
      deps: makeDeps({ db, now: now2 }).deps,
      config: testConfig(),
      force: true,
    });
    assert.equal(db.snapshots.length, 2, "neue Minute ⇒ neuer Snapshot erlaubt");
    assert.notEqual(db.snapshots[0].snapshotId, db.snapshots[1].snapshotId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-Flight, Min-Interval, Status
// ─────────────────────────────────────────────────────────────────────────────

describe("Single-Flight, Min-Interval, Status", () => {
  test("Min-Interval: zweiter Lauf ohne force wird übersprungen", async () => {
    setMode("monitor");
    const { deps, db } = makeDeps();
    await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    const before = db.snapshots.length;
    // Ohne force + innerhalb des Min-Intervalls: kein neuer Lauf.
    await updateVolatilityTargeting({ deps, config: testConfig() });
    assert.equal(db.snapshots.length, before, "Min-Interval hat den 2. Lauf geblockt");
  });

  test("force umgeht das Min-Interval", async () => {
    setMode("monitor");
    const { deps, db } = makeDeps();
    await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    const before = db.snapshots.length;
    // Force + gleiche Minute ⇒ neuer Versuch, aber idempotent (keine doppelte Zeile).
    await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    assert.equal(db.snapshots.length, before, "Idempotenz hält trotz force");
  });

  test("Status (synchron) spiegelt den letzten Lauf", async () => {
    setMode("monitor");
    const { deps } = makeDeps();
    assert.equal(getVolatilityTargetingStatus(), null, "vor dem ersten Lauf: null");
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    const snap = getVolatilityTargetingStatus();
    assert.ok(snap !== null);
    assert.equal(snap!.mode, status.mode);
    assert.equal(snap!.appliedMultiplier, status.appliedMultiplier);
    assert.equal(snap!.targetError, status.targetError);
    assert.ok(snap!.lastUpdate !== null);
  });

  test("realizedAnnualizedVol + targetError werden im Status gemeldet", async () => {
    setMode("monitor");
    const { deps } = makeDeps();
    const status = await updateVolatilityTargeting({ deps, config: testConfig(), force: true });
    assert.ok(status.realizedAnnualizedVol !== null, "mit Daten ⇒ realized vorhanden");
    assert.ok(status.targetError !== null, "mit realized ⇒ targetError vorhanden");
    assert.ok(Number.isFinite(status.realizedAnnualizedVol!));
    // Target Error = realized − target (30 % p. a.).
    assert.ok(
      Math.abs(status.targetError! - (status.realizedAnnualizedVol! - status.config.targetAnnualizedVolPct / 100)) < 1e-12
    );
  });
});

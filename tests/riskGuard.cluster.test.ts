/**
 * GAP-04 (v1.48.0, D2) — Cluster-Exposure-Guardrail (Schicht 3 des riskGuard):
 * Ablehnung bei Cluster-Überlauf (enforce), monitor-Modell ändert die
 * Entscheidung nicht (nur Audit/Log), stale Korrelation → konservative
 * Ablehnung, Cache-TTL (Fake-Clock), Schwelle-Grenzfälle (0.699 vs 0.7).
 *
 * Die Korrelations-Mathematik kommt aus `src/portfolio` (Import, keine
 * Duplikation) — hier wird sie über injizierte Quellen/Matrizen getestet.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assessClusterExposure,
  checkClusterExposure,
  __resetClusterExposureForTests,
  CLUSTER_LIMITS_BOUNDS,
  loadClusterLimitsConfig,
  type CorrelationSource,
  type ClusterCorrelationData,
} from "../src/lib/clusterExposure";
import {
  resetAuditDurabilityForTests,
  setAuditSleepForTests,
  setAuditTransportForTests,
  type AuditRow,
} from "../src/lib/auditSink";
import type { CorrelationMatrix } from "../src/portfolio";

// ── Test-Hygiene: Audit-Transport fangen, Spool in /tmp, Fake-Clock-sicher ──

const auditWrites: AuditRow[] = [];
let spoolDir: string;

beforeEach(() => {
  auditWrites.length = 0;
  spoolDir = mkdtempSync(path.join(tmpdir(), "aitf-cluster-test-"));
  process.env.AUDIT_SPOOL_DIR = spoolDir;
  setAuditSleepForTests(async () => {});
  setAuditTransportForTests(async (row) => {
    auditWrites.push(row);
  });
  __resetClusterExposureForTests();
});

afterEach(() => {
  setAuditTransportForTests(null);
  setAuditSleepForTests(null);
  resetAuditDurabilityForTests();
  __resetClusterExposureForTests();
  delete process.env.AUDIT_SPOOL_DIR;
});

// ── Helfer ───────────────────────────────────────────────────────────────────

/**
 * Baut eine symmetrische Korrelationsmatrix (Diagonale 1).
 * `corr`-Keys in der Form "A~B".
 */
function makeMatrix(symbols: string[], corr: Record<string, number> = {}): CorrelationMatrix {
  const n = symbols.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) matrix[i][i] = 1;
  for (const [k, v] of Object.entries(corr)) {
    const [a, b] = k.split("~");
    const i = symbols.indexOf(a);
    const j = symbols.indexOf(b);
    assert.ok(i >= 0 && j >= 0, `Symbol in Matrix: ${k}`);
    matrix[i][j] = v;
    matrix[j][i] = v;
  }
  return { method: "pearson", symbols, matrix, observations: 90, degenerate: [] };
}

interface FakeSourceOpts {
  /** null = nicht berechenbar (fail-closed STALE). */
  matrix: CorrelationMatrix | null;
  /** Jüngste Kerze (ms) — Default: frisch (now − 1 Min). */
  lastTs?: number;
  /** Jüngste Kerze relativ (ms) — Default: frisch (now − 1 Min). */
  lastTsOffsetMs?: number;
  /** Fixer Berechnungszeitstempel (Fake-Clock für TTL-Tests). */
  computedAt?: number;
  calls?: number[];
}

function fakeSource(opts: FakeSourceOpts): CorrelationSource {
  let n = 0;
  return async (_symbols: string[], _window: number): Promise<ClusterCorrelationData | null> => {
    n += 1;
    opts.calls?.push(n);
    if (opts.matrix == null) return null;
    const now = Date.now();
    return {
      matrix: opts.matrix,
      observations: opts.matrix.observations,
      lastTs: opts.lastTs ?? (now - (opts.lastTsOffsetMs ?? 60_000)),
      computedAt: opts.computedAt ?? now,
    };
  };
}

// ── 1) Enforce: Ablehnung bei Cluster-Überlauf ───────────────────────────────

test("enforce: Ablehnung bei Cluster-Überlauf (max-per-cluster)", async () => {
  // NEW + A + B in EINEM Cluster (alle paarweise ≥ 0.9); 2 offene + 1 neu =
  // 3 > Limit 2.
  const matrix = makeMatrix(["NEW", "A", "B"], { "NEW~A": 0.9, "NEW~B": 0.9, "A~B": 0.9 });
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A", "B"],
    mode: "enforce",
    cfg: { threshold: 0.7, maxPerCluster: 2, windowCandles: 90, cacheTtlMs: 60_000 },
    source: fakeSource({ matrix }),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, "VIOLATION");
  assert.deepEqual(r.blockedBy, ["cluster-exposure:max-per-cluster:2"]);
  assert.equal(r.clusterOfSymbol?.length, 3);
  assert.equal(r.auditWritten, true);
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].event, "CLUSTER_EXPOSURE_BLOCKED");
  const detail = auditWrites[0].detail as Record<string, unknown>;
  assert.equal(detail.code, "cluster-exposure:max-per-cluster:2");
  assert.equal(detail.wouldBlock, false);
  assert.equal(detail.count, 3);
});

test("enforce: unterhalb des Limits wird gelassen", async () => {
  const matrix = makeMatrix(["NEW", "A"], { "NEW~A": 0.9 });
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A"],
    mode: "enforce",
    cfg: { threshold: 0.7, maxPerCluster: 3, windowCandles: 90, cacheTtlMs: 60_000 },
    source: fakeSource({ matrix }),
  });
  assert.equal(r.allowed, true);
  assert.equal(r.verdict, "OK");
  assert.equal(auditWrites.length, 0, "OK → kein Audit-Eintrag (kein Lärm)");
});

// ── 2) Monitor: Entscheidung unverändert, nur Audit-Notiz + Log ─────────────

test("monitor: ändert die Entscheidung nicht (nur Audit/Log mit Würde-Prüfung)", async () => {
  const matrix = makeMatrix(["NEW", "A", "B"], { "NEW~A": 0.9, "NEW~B": 0.9, "A~B": 0.9 });
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A", "B"],
    mode: "monitor",
    cfg: { threshold: 0.7, maxPerCluster: 2, windowCandles: 90, cacheTtlMs: 60_000 },
    source: fakeSource({ matrix }),
  });
  assert.equal(r.allowed, true, "monitor blockt NIE");
  assert.equal(r.verdict, "VIOLATION", "der Verstoß wird trotzdem ermittelt");
  assert.deepEqual(r.blockedBy, []);
  assert.equal(r.auditWritten, true);
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].event, "CLUSTER_EXPOSURE_MONITOR");
  const detail = auditWrites[0].detail as Record<string, unknown>;
  assert.equal(detail.wouldBlock, true, "protokollierte Würde-Prüfung: WÜRDE blocken");
  assert.equal(detail.code, "cluster-exposure:max-per-cluster:2");
});

// ── 3) Stale Daten → konservative Ablehnung (fail-closed) ───────────────────

test("stale (keine Daten) + enforce → konservative Ablehnung", async () => {
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A"],
    mode: "enforce",
    cfg: { threshold: 0.7, maxPerCluster: 3, windowCandles: 90, cacheTtlMs: 60_000 },
    source: fakeSource({ matrix: null }),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, "STALE");
  assert.deepEqual(r.blockedBy, ["cluster-exposure:correlation-stale"]);
  const detail = auditWrites[0]?.detail as Record<string, unknown>;
  assert.equal(detail?.code, "cluster-exposure:correlation-stale");
});

test("stale (keine Daten) + monitor → Entscheidung unverändert", async () => {
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A"],
    mode: "monitor",
    cfg: { threshold: 0.7, maxPerCluster: 3, windowCandles: 90, cacheTtlMs: 60_000 },
    source: fakeSource({ matrix: null }),
  });
  assert.equal(r.allowed, true);
  assert.equal(r.verdict, "STALE");
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].event, "CLUSTER_EXPOSURE_MONITOR");
});

test("stale (Daten zu alt) → konservative Ablehnung, auch bei frischem Cache-Eintrag", async () => {
  const T0 = 1_750_000_000_000;
  const matrix = makeMatrix(["NEW", "A"], { "NEW~A": 0.9 });
  // Daten 48 h alt (> 24 h-Frische-Grenze), Cache-Eintrag selbst frisch.
  const source = fakeSource({ matrix, lastTs: T0 - 48 * 3_600_000, computedAt: T0 - 1000 });
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A"],
    mode: "enforce",
    cfg: { threshold: 0.7, maxPerCluster: 3, windowCandles: 90, cacheTtlMs: 60_000 },
    source,
    now: T0,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, "STALE");
});

// ── 4) Cache-TTL (Fake-Clock) ────────────────────────────────────────────────

test("Cache-TTL: innerhalb der TTL keine Neuberechnung, danach frische Quelle", async () => {
  const T0 = 1_750_000_000_000;
  const matrix = makeMatrix(["NEW", "A"], { "NEW~A": 0.9 });
  const calls: number[] = [];
  const source = fakeSource({ matrix, computedAt: T0, calls });
  const common = {
    symbol: "NEW",
    openSymbols: ["A"],
    mode: "monitor" as const,
    cfg: { threshold: 0.7, maxPerCluster: 3, windowCandles: 90, cacheTtlMs: 60_000 },
    source,
  };

  // 1. Prüfung: Cache leer → Quelle wird aufgerufen (computedAt = T0).
  const r1 = await checkClusterExposure({ ...common, now: T0 + 1000 });
  assert.equal(r1.allowed, true);
  assert.equal(calls.length, 1);

  // 2. Prüfung innerhalb der TTL (60 s): Cache-Treffer, kein Source-Call.
  const r2 = await checkClusterExposure({ ...common, now: T0 + 30_000 });
  assert.equal(r2.allowed, true);
  assert.equal(calls.length, 1, "innerhalb der TTL darf die Quelle NICHT erneut laufen");

  // 3. Prüfung nach Ablauf der TTL: frische Berechnung.
  const r3 = await checkClusterExposure({ ...common, now: T0 + 61_000 });
  assert.equal(r3.allowed, true);
  assert.equal(calls.length, 2, "nach TTL Ablauf muss neu berechnet werden");
});

test("Cache: andere Symbol-Menge = eigener Cache-Key", async () => {
  const T0 = 1_750_000_000_000;
  const matrix = makeMatrix(["NEW", "A", "B"], { "NEW~A": 0.9, "NEW~B": 0.9, "A~B": 0.9 });
  const calls: number[] = [];
  const source = fakeSource({ matrix, computedAt: T0, calls });
  const common = {
    mode: "monitor" as const,
    cfg: { threshold: 0.7, maxPerCluster: 10, windowCandles: 90, cacheTtlMs: 60_000 },
    source,
  };

  await checkClusterExposure({ ...common, symbol: "NEW", openSymbols: ["A"], now: T0 + 1000 });
  await checkClusterExposure({ ...common, symbol: "NEW", openSymbols: ["A", "B"], now: T0 + 2000 });
  assert.equal(calls.length, 2, "andere Symbol-Menge darf nicht aus dem Cache geliefert werden");
});

// ── 5) Schwelle-Grenzfälle (0.699 vs 0.7) ────────────────────────────────────

test("Schwelle: |ρ| = 0.699 < 0.7 → kein Cluster, 0.7 = Schwelle → Cluster", async () => {
  const open = ["A", "B"];
  const common = {
    symbol: "NEW",
    openSymbols: open,
    mode: "enforce" as const,
    cfg: { threshold: 0.7, maxPerCluster: 2, windowCandles: 90, cacheTtlMs: 60_000 },
  };

  // 0.699: NEW ist NICHT mit A/B verknüpft (eigene Komponente) → Count 1 → OK.
  const below = await checkClusterExposure({
    ...common,
    source: fakeSource({ matrix: makeMatrix(["NEW", "A", "B"], { "NEW~A": 0.699, "NEW~B": 0.699, "A~B": 0.95 }) }),
  });
  assert.equal(below.allowed, true, "0.699 < 0.7: keine Verknüpfung, keine Ablehnung");
  assert.equal(below.verdict, "OK");
  assert.deepEqual(below.clusterOfSymbol, ["NEW"]);

  // Exakt 0.7 (≥ Schwelle): NEW + A + B EIN Cluster → Count 3 > 2 → Ablehnung.
  // (Cache-Reset: dieselbe Symbol-Menge würde sonst den 0.699-Eintrag treffen.)
  __resetClusterExposureForTests();
  const at = await checkClusterExposure({
    ...common,
    source: fakeSource({ matrix: makeMatrix(["NEW", "A", "B"], { "NEW~A": 0.7, "NEW~B": 0.95, "A~B": 0.95 }) }),
  });
  assert.equal(at.allowed, false, "|ρ| = 0.7 genügt (≥ Schwelle) für die Cluster-Union");
  assert.equal(at.verdict, "VIOLATION");
  assert.deepEqual(at.blockedBy, ["cluster-exposure:max-per-cluster:2"]);
  assert.equal(at.clusterOfSymbol?.length, 3);
});

test("Single-Linkage: Kettenunion (NEW–A, A–B; NEW–B schwach)", async () => {
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: ["A", "B"],
    mode: "enforce",
    cfg: { threshold: 0.7, maxPerCluster: 2, windowCandles: 90, cacheTtlMs: 60_000 },
    source: fakeSource({ matrix: makeMatrix(["NEW", "A", "B"], { "NEW~A": 0.8, "NEW~B": 0.1, "A~B": 0.8 }) }),
  });
  assert.equal(r.verdict, "VIOLATION", "über Kette A gehört NEW zum Cluster (Single-Linkage)");
  assert.equal(r.clusterOfSymbol?.length, 3);
});

// ── 6) Trivialfall + reine Beurteilung ───────────────────────────────────────

test("keine offenen Positionen → keine Prüfung, kein Audit, immer erlaubt", async () => {
  const r = await checkClusterExposure({
    symbol: "NEW",
    openSymbols: [],
    mode: "enforce",
    source: fakeSource({ matrix: null }),
  });
  assert.equal(r.allowed, true);
  assert.equal(r.verdict, "OK");
  assert.equal(auditWrites.length, 0);
});

test("assessClusterExposure (rein): null-Matrix / zu altes Datum / fehlendes Symbol → STALE", () => {
  const matrix = makeMatrix(["NEW", "A"], { "NEW~A": 0.9 });
  assert.equal(assessClusterExposure({ symbol: "NEW", openSymbols: ["A"], matrix: null, threshold: 0.7, maxPerCluster: 3 }).status, "STALE");
  assert.equal(
    assessClusterExposure({
      symbol: "NEW", openSymbols: ["A"], matrix, threshold: 0.7, maxPerCluster: 3,
      dataAgeMs: 48 * 3_600_000,
    }).status,
    "STALE"
  );
  assert.equal(
    assessClusterExposure({ symbol: "XX", openSymbols: ["A"], matrix, threshold: 0.7, maxPerCluster: 3 }).status,
    "STALE",
    "Symbol nicht in der Matrix → konservativ statt raten"
  );
});

// ── 7) Konfiguration: Bounds + Modus-Parsing ─────────────────────────────────

test("Config: Bounds-Clamp + Modus-Parsing (unbekannt → monitor)", () => {
  const env = {
    RISK_CORR_THRESHOLD: "0.01",
    RISK_MAX_PER_CLUSTER: "99",
    RISK_CORR_WINDOW_CANDLES: "10",
    RISK_CORR_CACHE_TTL_MS: "10",
    RISK_CLUSTER_LIMITS_MODE: "enforce",
  };
  const cfg = loadClusterLimitsConfig(env);
  assert.equal(cfg.threshold, CLUSTER_LIMITS_BOUNDS.threshold[0]);
  assert.equal(cfg.maxPerCluster, CLUSTER_LIMITS_BOUNDS.maxPerCluster[1]);
  assert.equal(cfg.windowCandles, CLUSTER_LIMITS_BOUNDS.windowCandles[0]);
  assert.equal(cfg.cacheTtlMs, CLUSTER_LIMITS_BOUNDS.cacheTtlMs[0]);
  assert.equal(cfg.mode, "enforce");

  assert.equal(loadClusterLimitsConfig({ RISK_CLUSTER_LIMITS_MODE: "monitor" }).mode, "monitor");
  assert.equal(loadClusterLimitsConfig({}).mode, "monitor", "Default = monitor (Rollout-first)");
  assert.equal(loadClusterLimitsConfig({ RISK_CLUSTER_LIMITS_MODE: "blubb" }).mode, "monitor", "unbekannt → monitor");
});

/**
 * API-Contract-Tests der read-only Portfolio-Endpunkte (Task 05).
 *
 * `POST /api/portfolio/metrics|correlation|optimize` — direkt gegen die
 * Route-Handler, ohne Netzwerk und ohne Datenbank. Geprüft werden Contract,
 * Validierung, Größenlimits (DoS-Schutz), der 422-Pfad der Risk Guard und die
 * optionale Audit-Datei-Senke.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST as metricsPOST, GET as metricsGET } from "../src/app/api/portfolio/metrics/route";
import { POST as correlationPOST, GET as correlationGET } from "../src/app/api/portfolio/correlation/route";
import { POST as optimizePOST, GET as optimizeGET, buildAuditSinks } from "../src/app/api/portfolio/optimize/route";
import { parseSeries, parseSymbol, statusForCode, PORTFOLIO_SYMBOL_RE } from "../src/app/api/portfolio/parse";
import { serializeAuditEvent, AUDIT_FILE_RE } from "../src/portfolio/auditFile";
import { blockReturns, seriesFrom } from "./fixtures/portfolioFixtures";

const BASE = "http://localhost:3369";

/** POST-Helfer mit JSON-Body. */
function post(url: string, body: unknown, raw?: string): Request {
  return new Request(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

/** Drei Serien in **einem** Cluster (voller Rang, |ρ| ≈ 0.98). */
function singleClusterSeries(count = 3, periods = 80) {
  return seriesFrom(blockReturns(1, count, periods, 777), "H")
    .slice(0, count)
    .map((s) => ({ symbol: s.symbol, logReturns: s.logReturns as number[] }));
}

/**
 * Sechs Serien in **drei** Korrelationsclustern (je zwei Assets).
 * Mit den Default-Limits (20 % je Instrument, 50 % je Cluster) investierbar —
 * andernfalls wäre die Anfrage korrekt, aber unerfüllbar.
 */
function payloadSeries(count = 6, periods = 60) {
  return seriesFrom(blockReturns(Math.max(1, Math.round(count / 2)), 2, periods, 4242), "P")
    .slice(0, count)
    .map((s) => ({ symbol: s.symbol, logReturns: s.logReturns as number[] }));
}

afterEach(() => {
  delete process.env.PORTFOLIO_AUDIT_DIR;
  delete process.env.PORTFOLIO_AUDIT;
});

// ── /api/portfolio/metrics ───────────────────────────────────────────────────

test("POST /api/portfolio/metrics liefert Kennzahlen je Serie", async () => {
  const res = await metricsPOST(
    post("/api/portfolio/metrics", {
      series: [
        { symbol: "NVDA", prices: [100, 102, 101, 105, 103, 110, 108, 112, 115, 113] },
        { symbol: "QQQ", returns: [0.01, -0.02, 0.005, 0.03, -0.01] },
      ],
      annualization: 252,
      riskFreeRate: 0.02,
    })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    configVersion: number;
    symbols: string[];
    metrics: { symbol: string; volatility: number; sharpe: number; regime: string; maxDrawdown: { value: number } }[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.configVersion, 1);
  assert.deepEqual(body.symbols, ["NVDA", "QQQ"]);
  assert.equal(body.metrics.length, 2);
  assert.ok(Math.abs(body.metrics[0].volatility - 0.4923966299039518) < 1e-9);
  assert.equal(body.metrics[0].regime, "NORMAL");
  assert.ok(body.metrics[0].maxDrawdown.value > 0);
  // JSON enthält nie NaN/Infinity.
  const text = await new Response(JSON.stringify(body)).text();
  assert.ok(!text.includes("NaN"));
});

test("POST /api/portfolio/metrics: ATR aus Kerzen", async () => {
  const closes = [100, 101, 99, 102, 104, 103, 105, 107, 106, 108, 107, 109, 110, 108, 111, 112];
  const res = await metricsPOST(
    post("/api/portfolio/metrics", {
      series: [
        {
          symbol: "ATR",
          prices: closes,
          candles: closes.map((close) => ({ high: close + 1.5, low: close - 1.5, close })),
        },
      ],
      atrPeriod: 14,
    })
  );
  const body = (await res.json()) as { metrics: { atr: number | null; atrPct: number | null }[] };
  assert.ok(body.metrics[0].atr !== null);
  assert.ok(Math.abs((body.metrics[0].atr ?? 0) - 3.431122448979592) < 1e-9);
});

test("POST /api/portfolio/metrics: Validierungs- und Limit-Fehler", async () => {
  // Keine Serie.
  let res = await metricsPOST(post("/api/portfolio/metrics", { series: [] }));
  assert.equal(res.status, 400);
  // Ungültiges Symbol.
  res = await metricsPOST(post("/api/portfolio/metrics", { series: [{ symbol: "../etc", prices: [1, 2] }] }));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "INVALID_SYMBOL");
  // Infinity (JSON erlaubt 1e999) wird abgelehnt — kein stiller NaN.
  res = await metricsPOST(post("/api/portfolio/metrics", { series: [{ symbol: "A", returns: [1e999] }] }, undefined));
  assert.equal(res.status, 400);
  // Nicht-Zahl im Array.
  res = await metricsPOST(post("/api/portfolio/metrics", { series: [{ symbol: "A", returns: ["0.01", 0.02] }] }));
  assert.equal(res.status, 400);
  // Zu kurze Serie.
  res = await metricsPOST(post("/api/portfolio/metrics", { series: [{ symbol: "A", prices: [100] }] }));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "INSUFFICIENT_DATA");
  // Doppelter Bezeichner.
  res = await metricsPOST(
    post("/api/portfolio/metrics", {
      series: [
        { symbol: "A", returns: [0.01, 0.02] },
        { symbol: "a", returns: [0.01, 0.02] },
      ],
    })
  );
  assert.equal(res.status, 400);
  // Leerer Body / kaputtes JSON.
  res = await metricsPOST(post("/api/portfolio/metrics", {}, ""));
  assert.equal(res.status, 400);
  res = await metricsPOST(post("/api/portfolio/metrics", {}, "{kaputt"));
  assert.equal(res.status, 400);
  // GET ist nicht erlaubt.
  const get = await metricsGET();
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST");
});

test("POST /api/portfolio/metrics: Größenlimits (DoS-Schutz) ⇒ 413", async () => {
  const many = Array.from({ length: 1001 }, (_, i) => ({ symbol: `S${i}`, returns: [0.01, 0.02] }));
  const res = await metricsPOST(post("/api/portfolio/metrics", { series: many }));
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: string }).error, "LIMIT_EXCEEDED");

  const tooLong = { series: [{ symbol: "A", returns: new Array<number>(2001).fill(0.01) }] };
  const res2 = await metricsPOST(post("/api/portfolio/metrics", tooLong));
  assert.equal(res2.status, 413);

  // Content-Length über dem Limit wird vor dem Lesen abgewiesen.
  const big = JSON.stringify({ series: [{ symbol: "A", returns: [0.01, 0.02] }] });
  const req = new Request(`${BASE}/api/portfolio/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(99_999_999) },
    body: big,
  });
  const res3 = await metricsPOST(req);
  assert.equal(res3.status, 413);
});

// ── /api/portfolio/correlation ───────────────────────────────────────────────

test("POST /api/portfolio/correlation liefert Matrix und Cluster", async () => {
  const base = [0.01, -0.02, 0.03, 0.005, -0.01, 0.02, -0.005, 0.015];
  const res = await correlationPOST(
    post("/api/portfolio/correlation", {
      series: [
        { symbol: "A", logReturns: base },
        { symbol: "B", logReturns: base.map((v) => v * 1.1) },
        { symbol: "C", logReturns: base.map((v) => -v) },
      ],
      method: "pearson",
      clusterThreshold: 0.8,
    })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    correlation: { method: string; symbols: string[]; matrix: number[][]; observations: number };
    clusters: { threshold: number; clusters: { id: number; symbols: string[] }[] } | null;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.correlation.symbols, ["A", "B", "C"]);
  assert.equal(body.correlation.matrix[0][0], 1);
  assert.ok(Math.abs(body.correlation.matrix[0][1] - 1) < 1e-9);
  assert.ok(Math.abs(body.correlation.matrix[0][2] + 1) < 1e-9);
  assert.ok(body.clusters);
  // |ρ| ≥ 0.8 verbindet alle drei (auch die negative Korrelation).
  assert.equal(body.clusters?.clusters.length, 1);
});

test("POST /api/portfolio/correlation: ohne Schwelle keine Cluster, Spearman wählbar", async () => {
  const res = await correlationPOST(
    post("/api/portfolio/correlation", {
      series: [
        { symbol: "A", logReturns: [0.01, -0.02, 0.03, 0.005] },
        { symbol: "B", logReturns: [0.02, 0.01, -0.01, 0.03] },
      ],
      method: "spearman",
    })
  );
  const body = (await res.json()) as { correlation: { method: string }; clusters: unknown };
  assert.equal(body.correlation.method, "spearman");
  assert.equal(body.clusters, null);

  const bad = await correlationPOST(
    post("/api/portfolio/correlation", {
      series: [{ symbol: "A", logReturns: [0.01, 0.02] }],
      method: "kendall",
    })
  );
  assert.equal(bad.status, 400);
  assert.equal((await correlationGET()).status, 405);
});

// ── /api/portfolio/optimize ──────────────────────────────────────────────────

test("POST /api/portfolio/optimize liefert Gewichte und vollständigen Guard-Report", async () => {
  const res = await optimizePOST(
    post("/api/portfolio/optimize", {
      series: payloadSeries(6),
      mode: "risk_parity",
      guard: { position: { maxWeightPerInstrument: 0.3 } },
    })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    chain: string[];
    symbols: string[];
    weights: number[];
    mode: string;
    rejected: boolean;
    adjusted: boolean;
    diagnostics: { converged: boolean; riskContributions: number[] };
    guard: { decisions: unknown[]; clusterExposures: unknown[]; caps: { symbol: string; cap: number }[] };
    audit: { event: string }[];
    auditFileEnabled: boolean;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.chain, ["portfolio-optimizer", "risk-guard", "position-limits", "correlation-limits"]);
  assert.equal(body.symbols.length, 6);
  assert.ok(Math.abs(body.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(body.mode, "risk_parity");
  assert.equal(body.rejected, false);
  assert.equal(body.diagnostics.converged, true);
  assert.equal(body.guard.caps.length, 6);
  assert.ok(body.audit.some((e) => e.event === "PORTFOLIO_OPTIMIZATION"));
  assert.ok(body.audit.some((e) => e.event === "RISK_GUARD_SUMMARY"));
  assert.equal(body.auditFileEnabled, false);
});

test("POST /api/portfolio/optimize: Risk-Guard-Verwurf ⇒ 422 mit Gründen", async () => {
  // Ein Cluster aus drei Assets (gemeinsamer Faktor + individuelles Rauschen ⇒
  // vollen Rang, |ρ| ≈ 0.98): 50 % Cluster-Limit ⇒ höchstens 50 % investierbar.
  const res = await optimizePOST(
    post("/api/portfolio/optimize", {
      series: singleClusterSeries(3, 80),
      mode: "min_variance",
      guard: { position: { maxWeightPerInstrument: 1 } },
    })
  );
  assert.equal(res.status, 422);
  const body = (await res.json()) as {
    ok: boolean;
    rejected: boolean;
    weights: unknown[];
    reasons: string[];
    error: string;
    message: string;
    guard: { decisions: unknown[] };
  };
  assert.equal(body.ok, false);
  assert.equal(body.error, "RISK_GUARD_REJECTION");
  assert.equal(body.rejected, true);
  assert.deepEqual(body.weights, []);
  assert.ok(body.reasons.length > 0);
  assert.ok(Array.isArray(body.guard.decisions));
});

test("POST /api/portfolio/optimize: Modi, Bounds, Solver und Kovarianz sind konfigurierbar", async () => {
  const series = payloadSeries(5);
  for (const mode of ["min_variance", "max_sharpe", "risk_parity"]) {
    const res = await optimizePOST(
      post("/api/portfolio/optimize", {
        series,
        mode,
        covariance: { method: "ewma", decay: 0.94 },
        bounds: { minWeight: 0.05, maxWeight: 0.4 },
        solver: { tolerance: 1e-8, maxIterations: 500, singularMatrixPolicy: "ridge" },
        riskFreeRate: 0.02,
        annualization: 252,
        withMetrics: true,
      })
    );
    assert.equal(res.status, 200, mode);
    const body = (await res.json()) as { weights: number[]; metrics: unknown[] | null; covariance: { method: string } };
    assert.ok(Math.abs(body.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9, mode);
    for (const w of body.weights) {
      assert.ok(w >= 0.05 - 1e-9 && w <= 0.4 + 1e-9, `${mode}: ${w}`);
    }
    assert.equal(body.covariance.method, "ewma");
    assert.equal(body.metrics?.length, 5);
  }
});

test("POST /api/portfolio/optimize: Fehler-Contract", async () => {
  // Unbekannter Modus.
  let res = await optimizePOST(post("/api/portfolio/optimize", { series: payloadSeries(5), mode: "yolo" }));
  assert.equal(res.status, 400);
  // expectedReturns mit falscher Länge.
  res = await optimizePOST(
    post("/api/portfolio/optimize", { series: payloadSeries(5), mode: "max_sharpe", expectedReturns: [0.001, 0.002] })
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "LENGTH_MISMATCH");
  // Unerfüllbare Bounds.
  res = await optimizePOST(
    post("/api/portfolio/optimize", { series: payloadSeries(5), mode: "min_variance", bounds: { minWeight: 0.3 } })
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "INFEASIBLE_CONSTRAINTS");
  // Singuläre Kovarianz ohne Policy ⇒ 422 (definierter Zustand, kein 500er).
  const twin = [0.01, -0.02, 0.03, 0.005, -0.01];
  res = await optimizePOST(
    post("/api/portfolio/optimize", {
      series: [
        { symbol: "A", logReturns: twin },
        { symbol: "B", logReturns: twin.map((v) => v * 2) },
      ],
      mode: "min_variance",
      guard: { position: { maxWeightPerInstrument: 1 } },
    })
  );
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: string }).error, "SINGULAR_MATRIX");
  // Dieselbe Anfrage mit Policy `ridge` ⇒ 200.
  res = await optimizePOST(
    post("/api/portfolio/optimize", {
      series: [
        { symbol: "A", logReturns: twin },
        { symbol: "B", logReturns: twin.map((v) => v * 2) },
      ],
      mode: "min_variance",
      solver: { singularMatrixPolicy: "ridge" },
      guard: { position: { maxWeightPerInstrument: 1 }, correlation: { maxClusterExposure: 1 } },
    })
  );
  assert.equal(res.status, 200);
  assert.equal((await optimizeGET()).status, 405);
});

test("POST /api/portfolio/optimize: Audit-Datei-Senke (opt-in, NDJSON)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "portfolio-audit-"));
  try {
    process.env.PORTFOLIO_AUDIT_DIR = dir;
    const res = await optimizePOST(post("/api/portfolio/optimize", { series: payloadSeries(5), mode: "min_variance" }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { auditFileEnabled: boolean; audit: unknown[] };
    assert.equal(body.auditFileEnabled, true);
    const file = path.join(dir, "audit-log.ndjson");
    assert.ok(existsSync(file), "audit-log.ndjson fehlt");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, body.audit.length);
    for (const line of lines) {
      const event = JSON.parse(line) as { actor: string; event: string; timestamp: string };
      assert.equal(event.actor, "system");
      assert.ok(event.event.startsWith("PORTFOLIO_") || event.event.startsWith("RISK_GUARD_"));
      assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Audit-Senke: Dateiname wird gegen Path-Traversal validiert", () => {
  assert.equal(AUDIT_FILE_RE.test("audit-log.ndjson"), true);
  assert.equal(AUDIT_FILE_RE.test("../../evil.ndjson"), false);
  assert.equal(AUDIT_FILE_RE.test("a/b.ndjson"), false);
  const event = {
    event: "RISK_GUARD_DECISION" as const,
    level: "WARN" as const,
    actor: "system" as const,
    source: "test",
    symbols: ["A"],
    reasons: ["Grund"],
    timestamp: "2026-08-27T00:00:00.000Z",
    weights: [Infinity, NaN, 0.5],
  };
  const line = serializeAuditEvent(event);
  assert.ok(line.includes('"event":"RISK_GUARD_DECISION"'));
  // JSON kennt kein NaN/Infinity ⇒ null.
  assert.ok(line.includes("[null,null,0.5]"), line);
  assert.doesNotThrow(() => JSON.parse(line));
  const { sink } = buildAuditSinks();
  assert.equal(sink.name, "memory");
});

test("Determinismus: identische Anfragen ⇒ identische Antworten (ohne Zeitstempel)", async () => {
  const request = { series: payloadSeries(5), mode: "min_variance" };
  const a = await optimizePOST(post("/api/portfolio/optimize", request));
  const b = await optimizePOST(post("/api/portfolio/optimize", request));
  const strip = (body: unknown) =>
    JSON.stringify(body, (key, value) => (key === "timestamp" ? undefined : value));
  assert.equal(strip(await a.json()), strip(await b.json()));
});

test("Parser: Symbol- und Array-Validierung", () => {
  assert.equal(parseSymbol(" nvda "), "NVDA");
  assert.equal(parseSymbol("binance:btcusdt"), "BINANCE:BTCUSDT");
  assert.equal(PORTFOLIO_SYMBOL_RE.test("BTC-USDT"), true);
  assert.throws(() => parseSymbol(""), Error);
  assert.throws(() => parseSymbol("A B"), Error);
  assert.throws(() => parseSymbol(42), Error);
  assert.throws(() => parseSymbol("X".repeat(65)), Error);

  const series = parseSeries([{ symbol: "A", prices: [1, 2, 3], assetClass: " Equity " }]);
  assert.equal(series[0].assetClass, "equity");
  assert.throws(() => parseSeries("keine Liste"), Error);
  assert.throws(() => parseSeries([{ symbol: "A" }]), Error);
  assert.throws(() => parseSeries([{ symbol: "A", candles: [{ high: 1, low: 2, close: 1 }] }]), Error);

  assert.equal(statusForCode("LIMIT_EXCEEDED"), 413);
  assert.equal(statusForCode("RISK_GUARD_REJECTION"), 422);
  assert.equal(statusForCode("SINGULAR_MATRIX"), 422);
  assert.equal(statusForCode("UNBEKANNT"), 500);
});

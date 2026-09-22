/**
 * Unit-Tests der deterministischen MTF-Konfluenz (RMA-P2-03):
 * Features, as-of-Ausrichtung, Aggregation, Config-Validierung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeConfluence, confluenceSnapshotKey } from "../src/confluence/confluence";
import {
  DEFAULT_CONFLUENCE_CONFIG,
  ConfluenceConfigError,
  isConfluenceEnabled,
  requiredWarmupBars,
  resolveConfluenceConfig,
  validateConfluenceConfig,
} from "../src/confluence/config";
import {
  computeTimeframeFeatures,
  timeframeDirection,
} from "../src/confluence/features";
import { CONFLUENCE_CONFIG_VERSION, CONFLUENCE_FORMULA_VERSION } from "../src/confluence/types";
import type { ConfluenceCandle, ConfluenceInput } from "../src/confluence/types";
import { validateTechnicalOutput } from "../src/cycle/schemas";
import { buildAgentPayloadPrompt } from "../src/cycle/ports";
import { ASOF_MS, TF_MS, downBars, flatBars, linearBars, upBars } from "./confluence.helpers";

const CONFIG = DEFAULT_CONFLUENCE_CONFIG;

function inputWith(series: ConfluenceInput["series"]): ConfluenceInput {
  return { instrumentId: "BITUNIX:BTCUSDT", asOfMs: ASOF_MS, series };
}

// ── Features ─────────────────────────────────────────────────────────────────

test("features: starker Aufwärtstrend klemmt Trend/Momentum auf +1 (bounded)", () => {
  const candles = upBars("1h", 30);
  const closes = candles.map((c) => c.close);
  const f = computeTimeframeFeatures(closes, candles, CONFIG.features);
  assert.ok(f);
  assert.equal(f.trend, 1);
  assert.equal(f.momentum, 1);
  assert.ok(f.volatility >= 0 && f.volatility <= 1);
  assert.equal(timeframeDirection(f, CONFIG.features), 1);
});

test("features: starker Abwärtstrend klemmt auf −1, flach ist exakt 0", () => {
  const down = downBars("1h", 30);
  const fd = computeTimeframeFeatures(
    down.map((c) => c.close),
    down,
    CONFIG.features,
  );
  assert.ok(fd);
  assert.equal(fd.trend, -1);
  assert.equal(fd.momentum, -1);

  const flat = flatBars("1h", 30);
  const ff = computeTimeframeFeatures(
    flat.map((c) => c.close),
    flat,
    CONFIG.features,
  );
  assert.ok(ff);
  assert.equal(ff.trend, 0);
  assert.equal(ff.momentum, 0);
  assert.equal(timeframeDirection(ff, CONFIG.features), 0);
});

test("features: Warmup-Bedarf ist 22 und wird durchgesetzt", () => {
  assert.equal(requiredWarmupBars(CONFIG), 22);
  const short = upBars("1h", 10);
  assert.equal(
    computeTimeframeFeatures(short.map((c) => c.close), short, CONFIG.features),
    null,
  );
  assert.equal(
    computeTimeframeFeatures([], [], CONFIG.features),
    null,
  );
});

// ── As-of-Ausrichtung / Look-ahead ───────────────────────────────────────────

test("as-of: die noch offene HTF-Kerze ist ausgeschlossen (barEnd<=asOf)", () => {
  const closed = upBars("4h", 30);
  // Offene Bar (öffnet exakt zu asOf) mit extremem Spike — dürfte das
  // Ergebnis niemals verändern.
  const openBar: ConfluenceCandle = {
    time: ASOF_MS,
    open: 1000,
    high: 2000,
    low: 900,
    close: 1900,
    volume: 999_999,
  };
  const withoutOpen = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: closed },
    ]),
    CONFIG,
  );
  const withOpen = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: [...closed, openBar] },
    ]),
    CONFIG,
  );
  assert.deepEqual(withOpen, withoutOpen);
  const htf = withOpen.contributions.find((c) => c.timeframe === "4h");
  assert.ok(htf);
  // Jüngstes verwendetes Bar-Ende = asOf (die um asOf−4h öffnende Bar).
  assert.equal(htf.barEndMs, ASOF_MS);
  assert.equal(htf.barsUsed, 30);
});

test("as-of: erst nach asOf verfügbare Bars bleiben unsichtbar (PIT-Guard)", () => {
  const base = upBars("1h", 30);
  const futureKnown = upBars("1h", 31).map((c, i, arr) =>
    i === arr.length - 1 ? { ...c, availableAtMs: ASOF_MS + 1 } : c,
  );
  const a = computeConfluence(inputWith([{ timeframe: "1h", candles: base }]), CONFIG);
  const b = computeConfluence(inputWith([{ timeframe: "1h", candles: futureKnown }]), CONFIG);
  // Beide nutzen 30 Bars (die 31. ist zu asOf unbekannt) — identische Richtung.
  assert.deepEqual(
    b.contributions.map((c) => [c.direction, c.barsUsed]),
    a.contributions.map((c) => [c.direction, c.barsUsed]),
  );
});

test("gleichgerichtete Timeframes: OK, BULLISH, hoher Score, kleiner Konflikt", () => {
  const snap = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(snap.status, "OK");
  assert.equal(snap.bias, "BULLISH");
  assert.ok(snap.direction !== null && snap.direction > 0.5);
  assert.ok(snap.strength !== null && snap.strength > 0.5);
  assert.equal(snap.coverage, 1);
  assert.ok(snap.conflict < 0.2);
  assert.ok(snap.confidence > 0.8);
  assert.deepEqual(snap.missing, []);
  assert.equal(snap.formulaVersion, CONFLUENCE_FORMULA_VERSION);
  assert.equal(snap.configVersion, CONFLUENCE_CONFIG_VERSION);
  // Effektive Gewichte summieren sich zu 1.
  const wSum = snap.contributions.reduce((a, c) => a + c.effectiveWeight, 0);
  assert.ok(Math.abs(wSum - 1) < 1e-9);
});

test("gegensätzliche Timeframes: DEGRADED, Konflikt sichtbar, HTF dominiert", () => {
  const snap = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: downBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(snap.status, "DEGRADED");
  assert.ok(snap.reasons.includes("conflict-high"));
  assert.equal(snap.conflict, 1);
  // 0.2×(+1) + 0.3×(+1) + 0.5×(−1) = 0 → NEUTRAL, keine stille Richtung.
  assert.equal(snap.direction, 0);
  assert.equal(snap.bias, "NEUTRAL");
  // Konflikt drückt die Confidence trotz voller Coverage auf 0.
  assert.equal(snap.confidence, 0);
});

test("fehlender Timeframe: DEGRADED mit Re-Normalisierung, Confidence sinkt", () => {
  const full = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  const partial = computeConfluence(
    inputWith([
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(partial.status, "DEGRADED");
  assert.equal(partial.coverage, 0.8);
  assert.equal(partial.missing.length, 1);
  assert.equal(partial.missing[0].timeframe, "15m");
  assert.equal(partial.missing[0].reason, "unavailable");
  assert.ok(partial.reasons.includes("timeframe-missing:15m:unavailable"));
  // Re-normalisierte Gewichte: 0.3/0.8 und 0.5/0.8.
  const w1h = partial.contributions.find((c) => c.timeframe === "1h")?.effectiveWeight;
  assert.equal(w1h, 0.375);
  // Richtung bleibt bullish, aber die Confidence sinkt strikt (Coverage .8).
  assert.ok(partial.direction !== null && partial.direction > 0.5);
  assert.ok(partial.confidence < full.confidence);
});

test("unzureichende Coverage: ABSTAIN mit null-Signal (fail-closed, nicht 0)", () => {
  const snap = computeConfluence(
    inputWith([{ timeframe: "15m", candles: upBars("15m", 30) }]),
    CONFIG,
  );
  assert.equal(snap.status, "ABSTAIN");
  assert.equal(snap.coverage, 0.2);
  assert.equal(snap.direction, null);
  assert.equal(snap.strength, null);
  assert.equal(snap.bias, null);
  assert.equal(snap.confidence, 0);
  assert.ok(snap.reasons.includes("coverage-below-minimum"));
  // Beiträge/Missing bleiben zur Nachvollziehbarkeit erhalten.
  assert.equal(snap.contributions.length, 1);
  assert.equal(snap.missing.length, 2);
});

test("Eingabereihenfolge ändert den Output nicht (Reihen + Kerzen)", () => {
  const series = [
    { timeframe: "15m" as const, candles: upBars("15m", 30) },
    { timeframe: "1h" as const, candles: flatBars("1h", 30) },
    { timeframe: "4h" as const, candles: downBars("4h", 30) },
  ];
  const a = computeConfluence(inputWith(series), CONFIG);
  const shuffled = computeConfluence(
    inputWith(
      [...series].reverse().map((s) => ({ timeframe: s.timeframe, candles: [...s.candles].reverse() })),
    ),
    CONFIG,
  );
  assert.deepEqual(shuffled, a);
  assert.equal(JSON.stringify(shuffled), JSON.stringify(a));
});

test("stale Reihen fehlen mit Grund stale (fail-closed)", () => {
  // Jüngstes 1h-Bar-Ende = asOf − 3h (Schwelle: 2 Perioden).
  const stale = linearBars({ timeframe: "1h", n: 30, driftPerBar: 1, lastOpenMs: ASOF_MS - 4 * TF_MS["1h"] });
  const snap = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: stale },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(snap.status, "DEGRADED");
  const miss = snap.missing.find((m) => m.timeframe === "1h");
  assert.ok(miss);
  assert.equal(miss.reason, "stale");
  assert.ok(miss.detail.includes("Perioden alt"));
});

test("zu wenige Bars melden warmup, invalide Kerzen melden invalid", () => {
  const warmupSnap = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 10) },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(warmupSnap.missing.find((m) => m.timeframe === "15m")?.reason, "warmup");

  const bad = upBars("1h", 30);
  bad[20] = { ...bad[20], high: bad[20].low - 1 }; // high < low
  const invalidSnap = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: upBars("15m", 30) },
      { timeframe: "1h", candles: bad },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(invalidSnap.missing.find((m) => m.timeframe === "1h")?.reason, "invalid");
});

test("gelieferte, aber leere Reihe meldet no-closed-bars", () => {
  const snap = computeConfluence(
    inputWith([
      { timeframe: "15m", candles: [] },
      { timeframe: "1h", candles: upBars("1h", 30) },
      { timeframe: "4h", candles: upBars("4h", 30) },
    ]),
    CONFIG,
  );
  assert.equal(snap.missing.find((m) => m.timeframe === "15m")?.reason, "no-closed-bars");
});

test("leerer asOf und leere Instrument-ID werfen (kein stiller Default)", () => {
  assert.throws(
    () => computeConfluence({ instrumentId: "", asOfMs: ASOF_MS, series: [] }, CONFIG),
    /instrumentId/,
  );
  assert.throws(
    () => computeConfluence({ instrumentId: "X", asOfMs: -1, series: [] }, CONFIG),
    /asOfMs/,
  );
});

// ── Snapshot-Key (Idempotenz) ────────────────────────────────────────────────

test("snapshotKey: stabil, formatiert, reihenfolgenunabhängig, sensitiv", () => {
  const mk = () =>
    confluenceSnapshotKey({
      instrumentId: "BITUNIX:BTCUSDT",
      asOfMs: ASOF_MS,
      barEnds: ["4h:1", "15m:2", "1h:3"],
      configVersion: 1,
    });
  const a = mk();
  assert.match(a, /^mtf1:[0-9a-f]{16}$/);
  assert.equal(mk(), a);
  // Andere Bar-Enden ⇒ anderer Schlüssel (kein versehentliches Dedup).
  const b = confluenceSnapshotKey({
    instrumentId: "BITUNIX:BTCUSDT",
    asOfMs: ASOF_MS,
    barEnds: ["4h:1", "15m:2", "1h:4"],
    configVersion: 1,
  });
  assert.notEqual(b, a);
});

// ── Determinismus / Golden ───────────────────────────────────────────────────

test("deterministisch: zwei Läufe liefern byte-identische Snapshots", () => {
  const series = [
    { timeframe: "15m" as const, candles: upBars("15m", 30) },
    { timeframe: "1h" as const, candles: flatBars("1h", 30) },
    { timeframe: "4h" as const, candles: upBars("4h", 30) },
  ];
  const a = computeConfluence(inputWith(series), CONFIG);
  const b = computeConfluence(inputWith(series), CONFIG);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("golden: Fixture-Snapshot ist byte-identisch", () => {
  const fixturePath = path.join(__dirname, "fixtures", "confluence-golden.json");
  const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  const series = [
    { timeframe: "15m" as const, candles: upBars("15m", 30) },
    { timeframe: "1h" as const, candles: flatBars("1h", 30) },
    { timeframe: "4h" as const, candles: upBars("4h", 30) },
  ];
  const snap = computeConfluence(inputWith(series), CONFIG);
  assert.equal(JSON.stringify(snap), JSON.stringify(expected));
});

// ── Config-Validierung ───────────────────────────────────────────────────────

test("config: Defaults sind valide, Warmup passt ins Fenster", () => {
  const cfg = validateConfluenceConfig({});
  assert.equal(cfg.version, CONFLUENCE_CONFIG_VERSION);
  assert.deepEqual(cfg.timeframes, ["15m", "1h", "4h"]);
});

test("config: ungültige Konfigurationen brechen laut ab", () => {
  // Gewichtssumme ≠ 1.
  assert.throws(
    () => validateConfluenceConfig({ weights: { "15m": 0.2, "1h": 0.3, "4h": 0.4 } }),
    ConfluenceConfigError,
  );
  // Zu viele Timeframes.
  assert.throws(
    () =>
      validateConfluenceConfig({
        timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"],
        weights: { "1m": 0.2, "5m": 0.2, "15m": 0.2, "1h": 0.2, "4h": 0.1, "1d": 0.1 },
      }),
    /maximal 5/,
  );
  // Doppelter Timeframe.
  assert.throws(
    () => validateConfluenceConfig({ timeframes: ["1h", "1h"], weights: { "1h": 1 } }),
    /doppelt/,
  );
  // Unbekannter Timeframe.
  assert.throws(() => validateConfluenceConfig({ timeframes: ["2w"], weights: { "2w": 1 } }), /keiner von/);
  // Überzähliges Gewicht.
  assert.throws(
    () =>
      validateConfluenceConfig({
        timeframes: ["1h"],
        weights: { "1h": 0.5, "4h": 0.5 },
      }),
    /kein konfigurierter Timeframe/,
  );
  // Feature-Gewichte ≠ 1.
  assert.throws(
    () => resolveConfluenceConfig({ features: { trendWeight: 0.7, momentumWeight: 0.7 } as never }),
    /trendWeight \+ momentumWeight/,
  );
  // EMA-Fehlordnung.
  assert.throws(
    () => resolveConfluenceConfig({ features: { emaFastPeriod: 21, emaSlowPeriod: 21 } as never }),
    /emaSlowPeriod/,
  );
  // Warmup übersteigt maxBars.
  assert.throws(
    () =>
      resolveConfluenceConfig({
        maxBars: 30,
        features: { momentumLookbacks: [50], momentumWeights: [1] } as never,
      }),
    /Warmup-Bedarf/,
  );
  // Bounds.
  assert.throws(() => resolveConfluenceConfig({ minCoverage: 0.05 }), /minCoverage/);
  assert.throws(() => resolveConfluenceConfig({ stalePeriods: 11 }), /stalePeriods/);
});

test("config: CONFLUENCE_ENABLED-Parsing (Default an, fail-laut)", () => {
  assert.equal(isConfluenceEnabled({}), true);
  assert.equal(isConfluenceEnabled({ CONFLUENCE_ENABLED: "false" }), false);
  assert.equal(isConfluenceEnabled({ CONFLUENCE_ENABLED: "0" }), false);
  assert.equal(isConfluenceEnabled({ CONFLUENCE_ENABLED: "true" }), true);
  const warnings: string[] = [];
  assert.equal(isConfluenceEnabled({ CONFLUENCE_ENABLED: "vielleicht" }, (w) => warnings.push(w)), true);
  assert.equal(warnings.length, 1);
});

// ── LLM-Override-Schutz ──────────────────────────────────────────────────────

test("LLM-Schema kann den deterministischen Score nicht überschreiben", () => {
  const res = validateTechnicalOutput({
    analyses: [
      {
        instrumentId: "BITUNIX:BTCUSDT",
        bias: "BULLISH",
        technicalScore: 99,
        trend: "moon",
        keyLevels: { support: 1, resistance: 2 },
        thesis: "gefälscht",
        confluence: {
          formulaVersion: "mtf-confluence@1",
          status: "OK",
          direction: 1,
          strength: 1,
          confidence: 1,
          coverage: 1,
          conflict: 0,
        },
      },
    ],
    analyzedCount: 1,
  });
  assert.equal(res.valid, true);
  assert.ok(res.data);
  assert.ok(!("confluence" in res.data.analyses[0]));
});

test("Trusted-Prompt-Block steht getrennt vor den Untrusted-Daten", () => {
  const prompt = buildAgentPayloadPrompt("Frage", { kind: "mtf-confluence" }, { prices: [1] });
  const trustedAt = prompt.indexOf("=== TRUSTED DETERMINISTIC DATA");
  const untrustedAt = prompt.indexOf("=== UNTRUSTED MARKET DATA");
  assert.ok(trustedAt >= 0);
  assert.ok(untrustedAt > trustedAt);
  // Regression: ohne trustedData kein Trusted-Block (Verhalten wie zuvor).
  const legacy = buildAgentPayloadPrompt("Frage", undefined, { prices: [1] });
  assert.ok(!legacy.includes("TRUSTED DETERMINISTIC DATA"));
  assert.ok(legacy.includes("=== UNTRUSTED MARKET DATA"));
});

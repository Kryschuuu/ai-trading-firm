/**
 * CAP-008: Laufzeit-Projektion von liveAvailable (fail-closed).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { adaptersFromCatalog } from "../src/brokers/adapterCatalog";
import { capabilityMatrix } from "../src/capabilities/matrix";
import { resolveInstrumentCapabilities } from "../src/capabilities/resolveCapabilities";
import {
  AVAILABILITY_REASON,
  SEED_LIVE_AVAILABLE_FORBIDDEN_MESSAGE,
  applyAvailabilityProjection,
  assertLiveAvailableImpliesTrading,
  assertSeedRecordHasNoLiveAvailable,
  assertTradingVenuesHaveRealAdapters,
  formatLiveUnavailableBadge,
  projectInstrumentAvailability,
  setProjectionContextForTests,
  type ProjectionContext,
} from "../src/universe/capabilityProjection";
import { SEED_INSTRUMENTS } from "../src/universe/seed";

afterEach(() => {
  setProjectionContextForTests(null);
});

function ctx(overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  return {
    capabilities: capabilityMatrix,
    adapters: adaptersFromCatalog(),
    featureFlags: { isEnabled: () => false },
    evaluateLiveOrder: () => ({ allowed: false }),
    ...overrides,
  };
}

function openCtx(overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  return ctx({
    featureFlags: { isEnabled: () => true },
    evaluateLiveOrder: () => ({ allowed: true }),
    ...overrides,
  });
}

test("liveAvailable ist Konjunktion aller fünf Bedingungen", () => {
  const base = { venue: "BITUNIX", symbol: "BTCUSDT", liveTradable: true, paperAvailable: true };
  const all = projectInstrumentAvailability(base, openCtx());
  assert.equal(all.liveAvailable, true);
  assert.deepEqual(all.reasons, []);
  assert.equal(all.liveTradable, true);

  const noTradable = projectInstrumentAvailability({ ...base, liveTradable: false }, openCtx());
  assert.equal(noTradable.liveAvailable, false);
  assert.ok(noTradable.reasons.includes(AVAILABILITY_REASON.NOT_LIVE_TRADABLE));

  const noFlag = projectInstrumentAvailability(
    base,
    ctx({ featureFlags: { isEnabled: () => false }, evaluateLiveOrder: () => ({ allowed: true }) }),
  );
  assert.equal(noFlag.liveAvailable, false);
  assert.ok(noFlag.reasons.includes(AVAILABILITY_REASON.FEATURE_FLAG_UNSET));

  const gateClosed = projectInstrumentAvailability(
    base,
    ctx({ featureFlags: { isEnabled: () => true }, evaluateLiveOrder: () => ({ allowed: false }) }),
  );
  assert.equal(gateClosed.liveAvailable, false);
  assert.ok(gateClosed.reasons.includes(AVAILABILITY_REASON.LIVE_GATE_CLOSED));
});

test("Stub-Adapter und capabilities.live=false halten liveAvailable=false", () => {
  const projected = projectInstrumentAvailability(
    { venue: "BINANCE", symbol: "BTCUSDT", liveTradable: true },
    openCtx(),
  );
  assert.equal(projected.liveTradable, true);
  assert.equal(projected.liveAvailable, false);
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.ADAPTER_STUB));
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.CAPABILITY_TRADING_FALSE));
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.CAPABILITY_LIVE_FALSE));
});

test("PAPER ist fachlich nicht live-handelbar", () => {
  const projected = projectInstrumentAvailability(
    { venue: "PAPER", symbol: "BTC", liveTradable: false },
    openCtx(),
  );
  assert.equal(projected.liveTradable, false);
  assert.equal(projected.liveAvailable, false);
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.NOT_LIVE_TRADABLE));
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.CAPABILITY_LIVE_FALSE));
});

test("unbekannte Venue ist fail-closed", () => {
  const projected = projectInstrumentAvailability({ venue: "UNKNOWN", liveTradable: true }, openCtx());
  assert.equal(projected.liveAvailable, false);
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.CAPABILITY_MISSING));
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.ADAPTER_MISSING));
});

test("reasons[] enthält nur symbolische Codes, keine Env-Werte", () => {
  const projected = projectInstrumentAvailability(
    { venue: "BITUNIX", liveTradable: true },
    ctx({ featureFlags: { isEnabled: () => false } }),
  );
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.FEATURE_FLAG_UNSET));
  assert.ok(projected.reasons.every((code) => /^[A-Z_]+$/.test(code)));
  assert.ok(!projected.reasons.some((code) => code.includes("=") || code.includes("true")));
});

test("evaluateLiveOrder-Ausnahme ist fail-closed", () => {
  const projected = projectInstrumentAvailability(
    { venue: "BITUNIX", liveTradable: true },
    ctx({
      featureFlags: { isEnabled: () => true },
      evaluateLiveOrder: () => {
        throw new Error("boom");
      },
    }),
  );
  assert.equal(projected.liveAvailable, false);
  assert.ok(projected.reasons.includes(AVAILABILITY_REASON.LIVE_GATE_CLOSED));
});

test("Seed-Schema verbietet liveAvailable", () => {
  assert.throws(
    () => assertSeedRecordHasNoLiveAvailable({ venue: "BITUNIX", liveAvailable: false }),
    (err: Error) => err.message === SEED_LIVE_AVAILABLE_FORBIDDEN_MESSAGE,
  );
  assert.doesNotThrow(() => assertSeedRecordHasNoLiveAvailable({ venue: "BITUNIX", liveTradable: true }));
  for (const record of SEED_INSTRUMENTS) {
    assert.equal(Object.hasOwn(record, "liveAvailable"), false);
    assert.equal(typeof record.liveTradable, "boolean");
  }
});

test("Startup: trading:true Venues haben echte Adapter", () => {
  const result = assertTradingVenuesHaveRealAdapters({ strict: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("Startup strict: Stub mit trading:true wirft", () => {
  assert.throws(
    () =>
      assertTradingVenuesHaveRealAdapters({
        strict: true,
        capabilities: {
          ...capabilityMatrix,
          BINANCE: { ...capabilityMatrix.BINANCE!, trading: true },
        },
      }),
    /BINANCE: capabilities.trading=true, aber Adapter ist ein Stub/,
  );
});

test("Invariante: liveAvailable=true verlangt capabilities.trading", () => {
  assert.doesNotThrow(() =>
    assertLiveAvailableImpliesTrading([{ venue: "BITUNIX", liveAvailable: true }]),
  );
  assert.throws(
    () => assertLiveAvailableImpliesTrading([{ venue: "BINANCE", liveAvailable: true }]),
    /Invariante verletzt/,
  );
});

test("applyAvailabilityProjection überschreibt nur die drei Verfügbarkeitsfelder", () => {
  const out = applyAvailabilityProjection(
    { venue: "KRAKEN", symbol: "BTC/USD", liveTradable: true, paperAvailable: true, extra: 1 },
    openCtx(),
  );
  assert.equal(out.extra, 1);
  assert.equal(out.liveTradable, true);
  assert.equal(out.liveAvailable, false);
});

test("Badge formatiert den ersten Grund ohne Secrets", () => {
  const badge = formatLiveUnavailableBadge([AVAILABILITY_REASON.ADAPTER_STUB], "KRAKEN");
  assert.match(badge, /Stub/);
  assert.ok(!badge.toLowerCase().includes("secret"));
  assert.ok(!badge.includes("process.env"));
});

test("resolveInstrumentCapabilities delegiert fail-closed (Default liveTradable=false)", () => {
  assert.deepEqual(resolveInstrumentCapabilities("BINANCE", capabilityMatrix), {
    liveAvailable: false,
    liveTradable: false,
  });
  assert.deepEqual(resolveInstrumentCapabilities("BITUNIX", capabilityMatrix, true), {
    liveAvailable: false,
    liveTradable: true,
  });
  assert.deepEqual(resolveInstrumentCapabilities("UNKNOWN_VENUE", capabilityMatrix), {
    liveAvailable: false,
    liveTradable: false,
  });
});

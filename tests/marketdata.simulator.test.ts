/**
 * Fill-Simulator-Tests (Task 03).
 *   - Deterministisch: gleicher Seed → identische Fills (100 Fälle).
 *   - Slippage-/Partial-Fill-Grenzfälle.
 *   - Gebühren korrekt aus den Registry-Feldern (maker_fee/taker_fee).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FillSimulator, effectiveFees } from "../src/lib/marketdata/simulator";
import { loadSimulatorConfig, type FillSimulatorConfig } from "../src/lib/marketdata/config";
import type { MarketInstrument } from "../src/universe/types";
import type { MarketSnapshot } from "../src/lib/marketdata/types";

function cfg(over: Partial<FillSimulatorConfig> = {}): FillSimulatorConfig {
  return { ...loadSimulatorConfig({}), seed: 42, ...over };
}

const instrument: MarketInstrument = {
  id: "BINANCE:BTCUSDT",
  venue: "BINANCE",
  symbol: "BTCUSDT",
  base: "BTC",
  quote: "USDT",
  assetClass: "crypto",
  marketType: "spot",
  status: "active",
  minQuantity: 0.00001,
  priceStep: 0.01,
  quantityStep: 0.00001,
  makerFee: 0.0004,
  takerFee: 0.001,
  leverageAvailable: false,
  shortAvailable: false,
  paperAvailable: true,
  liveTradable: false,
  liveAvailable: false,
  volume24h: 2_000_000_000,
  spread: 0.0004,
  volatility: null,
  lastSeen: "2026-08-27T00:00:00.000Z",
};

const snapshot: MarketSnapshot = {
  instrumentId: "BINANCE:BTCUSDT",
  symbol: "BTCUSDT",
  base: "BTC",
  quote: "USDT",
  bid: 67450,
  ask: 67453,
  last: 67451,
  ts: 1_750_000_000_000,
  source: "binance",
  venue: "BINANCE",
  feed: "binance",
  spread: (67453 - 67450) / ((67450 + 67453) / 2),
  volume24h: 2_000_000_000,
};

test("Simulator: gleicher Seed → identische Fills (100 Fälle)", () => {
  const a = new FillSimulator(cfg());
  const b = new FillSimulator(cfg());
  for (let i = 0; i < 100; i++) {
    const order = {
      symbol: "BTCUSDT",
      side: (i % 2 === 0 ? "LONG" : "SHORT") as "LONG" | "SHORT",
      qty: 0.001 + i * 0.0001,
    };
    const fa = a.simulate(order, snapshot, instrument);
    const fb = b.simulate(order, snapshot, instrument);
    assert.deepEqual(fa, fb, `Fall ${i} muss identisch sein`);
    assert.equal(fa.status, "FILLED");
    assert.ok(fa.filledQty > 0);
    assert.ok(fa.fillPrice > 0);
  }
});

test("Simulator: LONG füllt am Ask (+Slippage), SHORT am Bid (−Slippage)", () => {
  const sim = new FillSimulator(cfg({ slippageBpsBase: 0, slippageBpsPerParticipation: 0, slippageJitterBps: 0 }));
  const fLong = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 0.1 }, snapshot, instrument);
  assert.ok(Math.abs(fLong.fillPrice - snapshot.ask) < 1e-9, "LONG ≈ Ask");
  const fShort = sim.simulate({ symbol: "BTCUSDT", side: "SHORT", qty: 0.1 }, snapshot, instrument);
  assert.ok(Math.abs(fShort.fillPrice - snapshot.bid) < 1e-9, "SHORT ≈ Bid");
});

test("Simulator: Slippage wächst linear mit Ordergröße relativ zum 24h-Volumen", () => {
  const sim = new FillSimulator(cfg({ slippageBpsBase: 10, slippageBpsPerParticipation: 1000 }));
  const small = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 0.001 }, snapshot, instrument);
  const big = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 1000 }, snapshot, instrument);
  assert.ok(big.slippageBps > small.slippageBps, "größere Order → mehr Slippage");
  // 1000 BTC ≈ 67M Notional, bei 2G Volumen → Partizipation ~3.4% → deutlicher Sprung.
  assert.ok(big.slippageBps >= small.slippageBps + 10, "Slippage-Sprung ist signifikant");
});

test("Simulator: ohne 24h-Volumen → Fallback-Volumen (kein Crash, Slippage endlich)", () => {
  const sim = new FillSimulator(cfg());
  const snapNoVol = { ...snapshot, volume24h: null };
  const f = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 1000 }, snapNoVol, instrument);
  assert.equal(f.status, "FILLED");
  assert.ok(Number.isFinite(f.slippageBps));
});

test("Simulator: Partial Fills deaktiviert → immer vollständig gefüllt", () => {
  const sim = new FillSimulator(cfg({ partialFillEnabled: false }));
  for (let i = 0; i < 20; i++) {
    const f = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 1 + i }, snapshot, instrument);
    assert.equal(f.status, "FILLED");
    assert.equal(f.filledQty, 1 + i);
  }
});

test("Simulator: Partial Fills aktiv → gefüllte Menge ≤ Cap (Grenzfall)", () => {
  const sim = new FillSimulator(cfg({ partialFillEnabled: true, partialFillMaxFraction: 0.5 }));
  let sawPartial = false;
  for (let i = 0; i < 50; i++) {
    const f = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 10 }, snapshot, instrument);
    assert.ok(f.filledQty <= 10 * 0.5 + 1e-9, "gefüllte Menge darf Cap nicht überschreiten");
    if (f.status === "PARTIALLY_FILLED") sawPartial = true;
  }
  assert.ok(sawPartial, "es kommen mind. ein Partial Fill vor");
});

test("Simulator: Gebühren aus Registry-Feldern (taker_fee)", () => {
  const sim = new FillSimulator(cfg({ slippageBpsBase: 0, slippageJitterBps: 0 }));
  const f = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 1 }, snapshot, instrument);
  const expected = f.fillPrice * f.filledQty * instrument.takerFee;
  assert.ok(Math.abs(f.fees - expected) < 1e-9, "fees = fillPrice × qty × takerFee");
  assert.ok(f.fees > 0, "Gebühren > 0");
});

test("Simulator: effectiveFees bevorzugt Registry-Felder, Fallback sonst", () => {
  const withFees = effectiveFees(instrument, { makerFeeFallback: 0.01, takerFeeFallback: 0.02 });
  assert.equal(withFees.maker, instrument.makerFee);
  assert.equal(withFees.taker, instrument.takerFee);
  const noFees = effectiveFees({ ...instrument, makerFee: 0, takerFee: 0 }, { makerFeeFallback: 0.01, takerFeeFallback: 0.02 });
  assert.equal(noFees.maker, 0.01);
  assert.equal(noFees.taker, 0.02);
});

test("Simulator: ungültige Menge → REJECTED", () => {
  const sim = new FillSimulator(cfg());
  const f = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 0 }, snapshot, instrument);
  assert.equal(f.status, "REJECTED");
  assert.match(f.reason ?? "", /INVALID_QTY/);
});

test("Simulator: Latenz ist konfigurierbar", () => {
  const sim = new FillSimulator(cfg({ latencyMs: 500 }));
  const f = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 0.1 }, snapshot, instrument);
  assert.equal(f.latencyMs, 500);
});

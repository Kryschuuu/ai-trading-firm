/**
 * Vereinheitlichte Paper-Execution (v1.21.0): Der Bitunix-Paper-Ledger nutzt
 * DIESELBE zentrale Fill-Engine (`FillSimulator`) wie die generische
 * Paper-Execution — keine separate, vereinfachte Simulation mehr
 * (früher: LONG → price·1.0001, SHORT → price·0.9999).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BitunixPaperLedger } from "../src/brokers/bitunix/paper";
import { FillSimulator } from "../src/lib/marketdata/simulator";
import { loadSimulatorConfig } from "../src/lib/marketdata/config";
import { snapshotFromLastPrice, fallbackInstrument } from "../src/lib/marketdata/snapshot";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import type { MarketTicker } from "../src/contracts/broker";

const TICKER: MarketTicker = { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 1 };
const REQ = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };

beforeEach(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
});

test("Bitunix-Paper: KEIN fester Faktor 1.0001 mehr — Fill kommt aus dem Simulator", () => {
  const config = loadSimulatorConfig({});
  const ledger = new BitunixPaperLedger(10_000, { simulatorConfig: config });
  const fill = ledger.submit(REQ, TICKER);
  assert.equal(fill.status, "FILLED");

  // Die alte Logik hätte exakt price·1.0001 = 65006.5 geliefert.
  const legacyFactorPrice = 65000 * 1.0001;
  assert.notEqual(
    Number(fill.fillPrice.toFixed(6)),
    Number(legacyFactorPrice.toFixed(6)),
    "Fill darf NICHT mehr der feste 1.0001-Faktor sein"
  );

  // Stattdessen: LONG füllt am Ask (+Slippage) des synthetischen Snapshots.
  const half = config.syntheticSpreadBps / 10_000 / 2;
  const ask = 65000 * (1 + half);
  assert.ok(fill.fillPrice >= ask - 1e-6, "LONG-Fill mindestens am Ask");
});

test("Bitunix-Paper === Generic Simulator: identischer Fill-Preis bei gleichem Seed/Config", () => {
  const config = loadSimulatorConfig({});
  const ledger = new BitunixPaperLedger(10_000, { simulatorConfig: config });
  const ledgerFill = ledger.submit(REQ, TICKER);

  // Referenz: derselbe zentrale Simulator, derselbe Snapshot-Builder.
  const sim = new FillSimulator(config);
  const instrument = fallbackInstrument("BITUNIX", "BTCUSDT");
  const snapshot = snapshotFromLastPrice({
    symbol: "BTCUSDT",
    last: 65000,
    spread: config.syntheticSpreadBps / 10_000,
    volume24h: null,
    venue: "BITUNIX",
    base: instrument.base,
    quote: instrument.quote,
    instrumentId: instrument.id,
    ts: 1,
    source: "broker",
    feed: "bitunix",
  });
  const ref = sim.simulate({ symbol: "BTCUSDT", side: "LONG", qty: 0.01 }, snapshot, instrument);

  assert.equal(ledgerFill.fillPrice, ref.fillPrice, "gleicher Fill-Preis wie Generic-Simulator");
  assert.equal(ledgerFill.qty, ref.filledQty, "gleiche gefüllte Menge");
});

test("Bitunix-Paper: SHORT füllt am Bid (−Slippage) — symmetrisch im zentralen Simulator", () => {
  // Der globale Risk-Guard sperrt SHORT-Trading; die SHORT-Fill-Semantik wird
  // daher am zentralen Simulator geprüft (denselben, den das Ledger nutzt).
  const config = loadSimulatorConfig({});
  const sim = new FillSimulator(config);
  const instrument = fallbackInstrument("BITUNIX", "ETHUSDT");
  const snapshot = snapshotFromLastPrice({
    symbol: "ETHUSDT",
    last: 3000,
    spread: config.syntheticSpreadBps / 10_000,
    venue: "BITUNIX",
    instrumentId: instrument.id,
  });
  const fill = sim.simulate({ symbol: "ETHUSDT", side: "SHORT", qty: 0.1 }, snapshot, instrument);
  assert.equal(fill.status, "FILLED");
  const half = config.syntheticSpreadBps / 10_000 / 2;
  const bid = 3000 * (1 - half);
  assert.ok(fill.fillPrice <= bid + 1e-6, "SHORT-Fill höchstens am Bid");

  const legacyFactorPrice = 3000 * 0.9999;
  assert.notEqual(
    Number(fill.fillPrice.toFixed(6)),
    Number(legacyFactorPrice.toFixed(6)),
    "SHORT-Fill ist NICHT der feste 0.9999-Faktor"
  );
});

test("Bitunix-Paper: Gebühren werden abgezogen (Simulator-Fees, nicht 0)", () => {
  // Fallback-Instrument hat makerFee/takerFee=0 → Simulator nutzt Config-Fallback.
  const config = loadSimulatorConfig({ PAPER_SIM_TAKER_FEE: "0.001" });
  const ledger = new BitunixPaperLedger(10_000, { simulatorConfig: config });
  const before = ledger.getAccount().cash;
  const fill = ledger.submit(REQ, TICKER);
  assert.equal(fill.status, "FILLED");
  const after = ledger.getAccount().cash;
  const notionalOnly = fill.qty * fill.fillPrice;
  // Abzug > reines Notional ⇒ Gebühren wurden berücksichtigt.
  assert.ok(before - after > notionalOnly, "Cash-Abzug enthält Gebühren");
});

test("Bitunix-Paper: Partial Fills aus dem Simulator werden übernommen", () => {
  const config = loadSimulatorConfig({
    PAPER_SIM_PARTIAL_FILL: "true",
    PAPER_SIM_PARTIAL_MAX_FRACTION: "0.5",
  });
  const ledger = new BitunixPaperLedger(1_000_000, { simulatorConfig: config });
  const fill = ledger.submit(
    { symbol: "BTCUSDT", side: "LONG", qty: 1, riskNotional: 65000, stopLoss: 60000 },
    TICKER
  );
  assert.equal(fill.status, "FILLED");
  assert.ok(fill.qty <= 0.5 + 1e-9, "Partial-Fill-Cap greift (≤ 0.5)");
  const pos = ledger.listPositions();
  assert.equal(pos[0].qty, fill.qty, "Position spiegelt die gefüllte Teilmenge");
});

test("Bitunix-Paper: Reject-Pfade unverändert (Kill-Switch, Qty, Quote, Nachkauf, SL)", () => {
  const ledger = new BitunixPaperLedger(10_000);
  killSwitch.pull("test");
  assert.equal(ledger.submit(REQ, TICKER).reason, "KILL_SWITCH_ARMED");
  killSwitch.disarm();
  assert.equal(ledger.submit({ ...REQ, qty: 0 }, TICKER).reason, "INVALID_QTY");
  assert.equal(ledger.submit(REQ, { ...TICKER, price: 0 }).reason, "NO_QUOTE:BTCUSDT");
  assert.equal(ledger.submit({ ...REQ, stopLoss: -1 }, TICKER).reason, "INVALID_STOP_LOSS");
  const ok = ledger.submit(REQ, TICKER);
  assert.equal(ok.status, "FILLED");
  assert.ok(ledger.submit(REQ, TICKER).reason?.startsWith("POSITION_ALREADY_OPEN"));
});

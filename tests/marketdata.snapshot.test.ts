/**
 * Snapshot-Builder (`snapshotFromLastPrice`, `fallbackInstrument`).
 *
 * Wandelt einen reinen Last-Preis-Ticker in einen normalisierten
 * `MarketSnapshot`, damit ticker-basierte Paper-Pfade dieselbe zentrale
 * Fill-Engine nutzen können.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotFromLastPrice, fallbackInstrument } from "../src/lib/marketdata/snapshot";
import { INSTRUMENT_FIELDS } from "../src/universe/types";

test("snapshotFromLastPrice: Bid/Ask symmetrisch um Last (Spread aufgeteilt)", () => {
  const snap = snapshotFromLastPrice({
    symbol: "btcusdt",
    last: 65000,
    spread: 0.0004, // 4 bp
    venue: "bitunix",
  });
  assert.equal(snap.symbol, "BTCUSDT");
  assert.equal(snap.venue, "BITUNIX");
  assert.equal(snap.last, 65000);
  assert.ok(snap.ask > snap.last, "Ask > Last");
  assert.ok(snap.bid < snap.last, "Bid < Last");
  // Symmetrie: (ask - last) ≈ (last - bid)
  assert.ok(Math.abs((snap.ask - snap.last) - (snap.last - snap.bid)) < 1e-6);
  // Relativer Spread ≈ konfigurierter Wert.
  const mid = (snap.bid + snap.ask) / 2;
  assert.ok(Math.abs((snap.ask - snap.bid) / mid - 0.0004) < 1e-6);
});

test("snapshotFromLastPrice: Spread 0 → bid=ask=last (kein NaN)", () => {
  const snap = snapshotFromLastPrice({ symbol: "X", last: 100, spread: 0, venue: "V" });
  assert.equal(snap.bid, 100);
  assert.equal(snap.ask, 100);
  assert.equal(snap.last, 100);
});

test("snapshotFromLastPrice: negativer/ungültiger Spread wird auf 0 geklemmt", () => {
  const snap = snapshotFromLastPrice({ symbol: "X", last: 100, spread: -5, venue: "V" });
  assert.equal(snap.spread, 0);
  assert.equal(snap.bid, 100);
  assert.equal(snap.ask, 100);
});

test("snapshotFromLastPrice: Defaults (instrumentId, source, feed, quote)", () => {
  const snap = snapshotFromLastPrice({ symbol: "ethusdt", last: 3000, spread: 0.0002, venue: "bitunix" });
  assert.equal(snap.instrumentId, "BITUNIX:ETHUSDT");
  assert.equal(snap.source, "broker");
  assert.equal(snap.feed, "broker");
  assert.equal(snap.quote, "USDT");
  assert.equal(snap.volume24h, null);
});

test("fallbackInstrument: erfüllt den vollständigen MarketInstrument-Contract", () => {
  const inst = fallbackInstrument("bitunix", "btcusdt");
  for (const field of INSTRUMENT_FIELDS) {
    assert.ok(field in inst, `Feld ${field} muss vorhanden sein`);
  }
  assert.equal(inst.id, "BITUNIX:BTCUSDT");
  assert.equal(inst.venue, "BITUNIX");
  assert.equal(inst.symbol, "BTCUSDT");
  assert.equal(inst.makerFee, 0);
  assert.equal(inst.takerFee, 0);
});

test("fallbackInstrument: Overrides greifen (z. B. Gebühren)", () => {
  const inst = fallbackInstrument("BITUNIX", "BTCUSDT", { makerFee: 0.0002, takerFee: 0.0006 });
  assert.equal(inst.makerFee, 0.0002);
  assert.equal(inst.takerFee, 0.0006);
});

/**
 * Seed-beschränkte Discovery (`./seeded.ts`) — Tests.
 *
 * Coverage: Mengen je Venue (Preset ∪ Seed, dedupliziert), alle 26 Seeds
 * abgedeckt, Konvertierung (`liveAvailable: false`, Gebühren/Handelbarkeit
 * aus dem Slice, Metriken `null`), Fallbacks für handgebaute Schnitte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  seededInstrumentsForVenue,
  seededToMarketInstrument,
} from "../../../src/marketdata/adapters/seeded";
import { SEED_INSTRUMENTS } from "../../../src/universe/seed";

test("Mengen je Venue: Preset ∪ Seed, dedupliziert", () => {
  assert.equal(seededInstrumentsForVenue("ALPACA").length, 52, "50 Aktien + SPY/QQQ");
  assert.equal(seededInstrumentsForVenue("IBKR").length, 125, "50+50+22 + SPY/QQQ/EUR.USD");
  assert.equal(seededInstrumentsForVenue("PAPER").length, 155, "152 Spiegel + SPY/QQQ/EURUSD=X");
  assert.equal(seededInstrumentsForVenue("alpaca").length, 52, "Venue-Key case-insensitiv");
  assert.equal(seededInstrumentsForVenue("BITUNIX").length, 0, "Live-Discovery-Venues: kein Slice");

  for (const venue of ["ALPACA", "IBKR", "PAPER"]) {
    const symbols = seededInstrumentsForVenue(venue).map((i) => i.symbol);
    assert.equal(new Set(symbols).size, symbols.length, `${venue}: keine Duplikate`);
    assert.ok(
      seededInstrumentsForVenue(venue).every((i) => i.venue === venue),
      `${venue}: nur eigene Zeilen`,
    );
  }
});

test("alle 26 Seeds sind im je-Venue-Slice enthalten", () => {
  assert.equal(SEED_INSTRUMENTS.length, 26);
  for (const seed of SEED_INSTRUMENTS) {
    // BINANCE/KRAKEN entdecken live — ihre Seeds mergen per Upsert-ID.
    if (seed.venue === "BINANCE" || seed.venue === "KRAKEN") continue;
    const slice = seededInstrumentsForVenue(seed.venue);
    assert.ok(
      slice.some((i) => i.symbol === seed.symbol),
      `Seed ${seed.venue}:${seed.symbol} fehlt im Slice`,
    );
  }
});

test("Konvertierung: IDs, Handelbarkeit aus dem Slice, keine erfundenen Metriken", () => {
  const at = new Date("2026-08-29T12:00:00.000Z");
  const slice = seededInstrumentsForVenue("IBKR");
  const eur = slice.find((i) => i.symbol === "EUR.USD")!;
  const instrument = seededToMarketInstrument(eur, at);
  assert.equal(instrument.id, "IBKR:EUR.USD");
  assert.equal(instrument.assetClass, "fx");
  assert.equal(instrument.takerFee, 0.00002, "Gebühr aus dem Seed");
  assert.equal(instrument.liveTradable, true);
  assert.equal(instrument.liveAvailable, false, "Laufzeitprojektion, nie erfunden");
  assert.equal(instrument.volume24h, null);
  assert.equal(instrument.spread, null);
  assert.equal(instrument.volatility, null);
  assert.equal(instrument.lastSeen, "2026-08-29T12:00:00.000Z");

  // Fallbacks für handgebaute Schnitte (niemals undefined/NaN).
  const bare = seededToMarketInstrument({ venue: "PAPER", symbol: "X" }, at);
  assert.equal(bare.id, "PAPER:X");
  assert.equal(bare.status, "active");
  assert.ok(bare.minQuantity > 0 && bare.priceStep > 0 && bare.quantityStep > 0);
});

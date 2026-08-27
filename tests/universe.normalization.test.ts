/**
 * Golden-Tests der Normalisierung (Task 01).
 *
 * Kernaussage: **Symbol ≠ Markt.** `BINANCE:BTCUSDT` (Spot),
 * `KRAKEN:BTC/USD` (Spot) und `BITUNIX:BTCUSDT` (Perpetual) sind drei
 * Instrumente mit einem Asset (BTC) und einem Underlying (BTC).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assetIdOf,
  assetOf,
  inferAssetClass,
  inferMarketType,
  normalizeInstrument,
  normalizeSymbol,
  normalizeVenue,
  parseBaseQuote,
  toInstrumentId,
  underlyingOf,
  withRelations,
} from "../src/universe/normalization";
import { InstrumentRegistry } from "../src/universe/registry";
import { UniverseValidationError } from "../src/universe/validation";
import { CompiledPolicy, DEFAULT_POLICY, validatePolicy } from "../src/universe/policy";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "universe-norm-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("Golden: BTC existiert dreifach — 3 Instrumente, 1 Asset, 1 Underlying", () => {
  const r = new InstrumentRegistry({ dir: freshDir() });
  r.load();
  const res = r.upsertMany(
    [
      { venue: "BINANCE", symbol: "btcusdt", assetClass: "crypto", marketType: "spot" },
      { venue: "kraken", symbol: "BTC/USD", assetClass: "crypto", marketType: "spot" },
      { venue: "BITUNIX", symbol: "BTCUSDT", assetClass: "crypto", marketType: "perpetual", leverageAvailable: true, shortAvailable: true },
    ],
    "golden",
  );

  assert.equal(res.created, 3);
  assert.deepEqual(res.ids, ["BINANCE:BTCUSDT", "BITUNIX:BTCUSDT", "KRAKEN:BTC/USD"]);

  const instruments = r.instrumentsForUnderlying("BTC");
  assert.equal(instruments.length, 3, "drei handelbare Instrumente");
  assert.deepEqual(new Set(instruments.map((i) => assetOf(i).id)), new Set(["BTC"]), "genau ein Asset");
  assert.deepEqual(new Set(instruments.map((i) => underlyingOf(i).id)), new Set(["BTC"]), "genau ein Underlying");
  assert.deepEqual(new Set(instruments.map((i) => i.marketType)), new Set(["spot", "perpetual"]));
  assert.deepEqual(new Set(instruments.map((i) => i.venue)), new Set(["BINANCE", "KRAKEN", "BITUNIX"]));
  assert.deepEqual(r.underlyings().map((u) => u.id), ["BTC"]);
});

test("Golden: base/quote-Zerlegung je Venue-Konvention", () => {
  assert.deepEqual(parseBaseQuote("BTCUSDT"), { base: "BTC", quote: "USDT" });
  assert.deepEqual(parseBaseQuote("BTC/USD"), { base: "BTC", quote: "USD" });
  assert.deepEqual(parseBaseQuote("BTC-USD"), { base: "BTC", quote: "USD" });
  assert.deepEqual(parseBaseQuote("EUR.USD"), { base: "EUR", quote: "USD" });
  assert.deepEqual(parseBaseQuote("EURUSD=X"), { base: "EUR", quote: "USD" });
  assert.deepEqual(parseBaseQuote("ETH-PERP"), { base: "ETH", quote: "USD" });
  assert.deepEqual(parseBaseQuote("SPY"), { base: null, quote: null });
  assert.deepEqual(parseBaseQuote("BRK.B"), { base: null, quote: null });
});

test("Golden: Anlageklasse und Markttyp werden konservativ abgeleitet", () => {
  assert.equal(inferAssetClass("BTCUSDT", "BTC", "USDT"), "crypto");
  assert.equal(inferAssetClass("EURUSD=X", "EUR", "USD"), "fx");
  assert.equal(inferAssetClass("EUR.USD", "EUR", "USD"), "fx");
  assert.equal(inferAssetClass("SPY", null, "USD"), "equity");
  assert.equal(inferMarketType("DYDX", "BTC-USD"), "perpetual");
  assert.equal(inferMarketType("BITUNIX", "BTCUSDT"), "perpetual");
  assert.equal(inferMarketType("BINANCE", "ETH-PERP"), "perpetual");
  assert.equal(inferMarketType("ALPACA", "SPY"), "spot");
});

test("Normalisierung: Venue/Symbol werden getrimmt und in Großbuchstaben kanonisiert", () => {
  assert.equal(normalizeVenue("  binance "), "BINANCE");
  assert.equal(normalizeSymbol(" btc usdt "), "BTCUSDT");
  assert.equal(toInstrumentId("kraken", "btc/usd"), "KRAKEN:BTC/USD");
  assert.throws(() => normalizeVenue("1BAD"), UniverseValidationError);
  assert.throws(() => normalizeSymbol("BTC$USD"), UniverseValidationError);
  assert.throws(() => normalizeSymbol(42 as never), UniverseValidationError);
});

test("Normalisierung: Defaults sind konservativ (kein Hebel, kein Live, Metriken null)", () => {
  const i = normalizeInstrument({ venue: "BINANCE", symbol: "SOLUSDT" }, new Date("2026-08-27T00:00:00.000Z"));
  assert.equal(i.id, "BINANCE:SOLUSDT");
  assert.equal(i.leverageAvailable, false);
  assert.equal(i.shortAvailable, false);
  assert.equal(i.liveAvailable, false);
  assert.equal(i.paperAvailable, true);
  assert.equal(i.status, "active");
  assert.equal(i.volume24h, null);
  assert.equal(i.spread, null);
  assert.equal(i.volatility, null);
  assert.equal(i.lastSeen, "2026-08-27T00:00:00.000Z");
});

test("Normalisierung: withRelations/assetIdOf behandeln FX- und Aktien-Symbole", () => {
  const fx = normalizeInstrument({ venue: "PAPER", symbol: "EURUSD=X" });
  assert.equal(assetIdOf(fx), "EUR");
  const equity = normalizeInstrument({ venue: "ALPACA", symbol: "SPY", assetClass: "etf" });
  assert.equal(assetIdOf(equity), "SPY");
  assert.deepEqual(withRelations(equity).underlyingId, "SPY");
});

test("Policy: Struktur wird validiert, kaputte Muster werden abgelehnt", () => {
  const ok = validatePolicy({ version: 1, rules: [{ id: "x", reason: "r", field: "symbol", pattern: "^A" }] });
  assert.equal(ok.rules.length, 1);
  assert.throws(() => validatePolicy({ rules: [{ id: "x", field: "symbol", pattern: "([" }] }), /Muster/);
  assert.throws(() => validatePolicy({ rules: [{ id: "x", field: "unbekannt", pattern: "^A" }] }), /field/);
  assert.throws(() => validatePolicy("nein"), /Objekt/);
  assert.throws(
    () => validatePolicy({ rules: Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, field: "symbol", pattern: "^A" })) }),
    /Regeln/,
  );
});

test("Policy: Default-Policy schließt gehebelte Token aus, normale Symbole nicht", () => {
  const p = new CompiledPolicy(DEFAULT_POLICY);
  const leveraged = normalizeInstrument({ venue: "BINANCE", symbol: "BTC3LUSDT", assetClass: "crypto" });
  const normal = normalizeInstrument({ venue: "BINANCE", symbol: "BTCUSDT", assetClass: "crypto" });
  assert.equal(p.evaluate(leveraged).excluded, true);
  assert.equal(p.evaluate(leveraged).ruleId, "leveraged-token");
  assert.equal(p.evaluate(normal).excluded, false);
});

test("Policy: maxSymbolLength greift vor den Musterregeln", () => {
  const p = new CompiledPolicy({ ...DEFAULT_POLICY, maxSymbolLength: 4 });
  const i = normalizeInstrument({ venue: "BINANCE", symbol: "BTCUSDT", assetClass: "crypto" });
  assert.deepEqual(p.evaluate(i).ruleId, "max-symbol-length");
});

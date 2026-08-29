/**
 * Unit-Tests `calculateRelativeSpread()` — Orderbook-abgeleiteter Spread.
 *
 * Der Spread kommt NICHT aus der Ticker-API, sondern aus `bestBid`/`bestAsk`
 * (`/depth`). Kern-Invariante: ungültige/fehlende Book-Daten liefern `null`
 * („nicht geladen“) — niemals `NaN`, niemals 0, niemals eine Exception.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateRelativeSpread } from "../spread";

test("market sync calculates spread from best bid/ask", () => {
  const spread = calculateRelativeSpread(100, 100.02);
  assert.ok(spread !== null, "gültiges Book muss einen Spread liefern");
  assert.ok(Math.abs(spread - 0.00019998) < 1e-8, `erwartet ≈0.00019998, war ${spread}`);
});

test("Referenzfall: 99/101 → 2 % relativ zum Mid (100)", () => {
  const spread = calculateRelativeSpread(99, 101);
  assert.ok(spread !== null);
  assert.ok(Math.abs(spread - 0.02) < 1e-12);
});

test("Realistisches BTC-Book: 64999/65001 → ≈0,31 bp", () => {
  const spread = calculateRelativeSpread(64_999, 65_001);
  assert.ok(spread !== null);
  // (65001 − 64999) / 65000 = 3.0769e-5 → 0.31 bp
  assert.ok(Math.abs(spread - 2 / 65_000) < 1e-12);
  assert.ok(spread < 0.0004, "enger Spread bleibt unter dem 4-bp-Referenzwert");
});

test("fehlende Book-Seite → null (kein Crash, kein 0)", () => {
  assert.equal(calculateRelativeSpread(undefined, 100), null);
  assert.equal(calculateRelativeSpread(100, undefined), null);
  assert.equal(calculateRelativeSpread(undefined, undefined), null);
  assert.equal(calculateRelativeSpread(), null);
});

test("invertiertes Book (bid > ask) → null", () => {
  assert.equal(calculateRelativeSpread(100, 99), null);
  assert.equal(calculateRelativeSpread(102, 101), null);
});

test("nicht-positive Preise → null", () => {
  assert.equal(calculateRelativeSpread(0, 0), null);
  assert.equal(calculateRelativeSpread(0, 100), null);
  assert.equal(calculateRelativeSpread(100, 0), null);
  assert.equal(calculateRelativeSpread(-100, -99), null);
  assert.equal(calculateRelativeSpread(-100, 100), null);
});

test("nicht-endliche Werte → null (niemals NaN)", () => {
  assert.equal(calculateRelativeSpread(Number.NaN, 100), null);
  assert.equal(calculateRelativeSpread(100, Number.NaN), null);
  assert.equal(calculateRelativeSpread(Number.POSITIVE_INFINITY, 100), null);
  assert.equal(calculateRelativeSpread(100, Number.NEGATIVE_INFINITY), null);
});

test("JSON-seitig durchgereichtes null → null (`== null`-Semantik)", () => {
  // Depth-JSON kann `null` statt `undefined` liefern; die Funktion darf
  // daraus weder 0 noch eine Exception machen.
  assert.equal(calculateRelativeSpread(null as unknown as undefined, 100), null);
  assert.equal(calculateRelativeSpread(100, null as unknown as undefined), null);
});

test("identische Preise → 0 (bewusst von null unterscheidbar)", () => {
  const spread = calculateRelativeSpread(100, 100);
  assert.equal(spread, 0);
  assert.notEqual(spread, null, "0 (gleiches Level) ≠ null (nicht geladen)");
});

test("wirft nie — auch bei typfremdem Müll nicht", () => {
  const garbage: unknown[] = [
    undefined,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    "100",
    {},
    [],
  ];
  for (const bid of garbage) {
    for (const ask of garbage) {
      let value: number | null = null;
      assert.doesNotThrow(() => {
        value = calculateRelativeSpread(bid as number | undefined, ask as number | undefined);
      });
      // Entweder null oder eine endliche Zahl ≥ 0 — nie NaN.
      assert.ok(
        value === null || (Number.isFinite(value) && value >= 0),
        `bid=${String(bid)} ask=${String(ask)} → ${String(value)}`,
      );
    }
  }
});

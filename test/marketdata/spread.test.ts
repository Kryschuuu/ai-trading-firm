/**
 * `calculateRelativeSpread()` — Unit-Tests (MDSYNC-001 §4).
 *
 * Pflichtfälle laut Ticketstabelle. Der Kern der Semantik: `null` ist ein
 * bekanntermaßen unbekannter Wert (Data-Quality), NICHT „Spread = 0“. Ein
 * 0-Spread wäre ein fachlich verdächtiger, aber messbarer Wert und würde den
 * `max-spread`-Filter täuschen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateRelativeSpread } from "../../src/marketdata/spread";

/** Referenzformel (Mid-basiert), unabhängig implementiert. */
const expected = (bid: number, ask: number): number => (ask - bid) / ((ask + bid) / 2);

test("Normalfall: (100, 100.02) ≈ 0.00019998", () => {
  const spread = calculateRelativeSpread(100, 100.02);
  assert.notEqual(spread, null);
  assert.ok(Math.abs(spread! - 0.00019998) < 1e-8, `erwartet ≈0.00019998, war ${spread}`);
  assert.ok(Math.abs(spread! - expected(100, 100.02)) < 1e-12, "Formel (ask−bid)/mid");
});

test("Bid fehlt → null", () => {
  assert.equal(calculateRelativeSpread(undefined, 100), null);
});

test("Ask fehlt → null", () => {
  assert.equal(calculateRelativeSpread(100, undefined), null);
});

test("Nullpreis (0, 100) → null", () => {
  assert.equal(calculateRelativeSpread(0, 100), null);
  assert.equal(calculateRelativeSpread(100, 0), null);
  assert.equal(calculateRelativeSpread(-1, 100), null);
});

test("Gekreuztes Buch (100.5, 100) → null", () => {
  assert.equal(calculateRelativeSpread(100.5, 100), null);
});

test("Zero-Spread (100, 100) → 0 und unterscheidbar von null", () => {
  const spread = calculateRelativeSpread(100, 100);
  assert.equal(spread, 0);
  assert.notEqual(spread, null);
});

test("Sehr kleine Preise: (0.00001234, 0.00001235) > 0 und endlich", () => {
  const spread = calculateRelativeSpread(0.00001234, 0.00001235);
  assert.notEqual(spread, null);
  assert.ok(spread! > 0, `Spread muss > 0 sein, war ${spread}`);
  assert.ok(Number.isFinite(spread!), "Spread muss endlich sein");
});

test("null/undefined als JSON-Literal (Venue-Antwort) → null, kein Wurf", () => {
  // Ein JSON-Objekt kann `null` liefern, obwohl der Typ `number` sagt — die
  // Guard-Kette muss das abfangen, statt NaN in die Registry zu schreiben.
  const missing = null as unknown as number;
  assert.equal(calculateRelativeSpread(missing, 100), null);
  assert.equal(calculateRelativeSpread(100, missing), null);
  assert.equal(calculateRelativeSpread(Number.NaN, Number.NaN), null);
  assert.equal(calculateRelativeSpread(Number.POSITIVE_INFINITY, 100), null);
  assert.equal(calculateRelativeSpread("100" as unknown as number, 101), null);
});

test("Realistisches BTC-Buch: 64999/65001 → ≈0,31 bp", () => {
  const spread = calculateRelativeSpread(64999, 65001);
  assert.ok(spread !== null);
  assert.ok(Math.abs(spread * 10_000 - 0.3077) < 0.001, `≈0,31 bp erwartet, war ${spread * 10_000} bp`);
});

test(" Niemals negativ, niemals NaN — auch bei Müll-Eingaben nicht", () => {
  for (const [bid, ask] of [
    [Number.NaN, Number.NaN],
    [Infinity, 1],
    [1, Infinity],
    [-5, -1],
    [0, 0],
    [1e-320, 1e-320],
  ] as Array<[number, number]>) {
    const spread = calculateRelativeSpread(bid, ask);
    assert.ok(spread === null || (Number.isFinite(spread) && spread >= 0), `bid=${bid} ask=${ask} → ${spread}`);
  }
});

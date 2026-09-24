/**
 * Tests für `src/lib/bookDepth.ts` (v0.4.0, IAD-T-06).
 *
 * Der Kern des Daytrading-Features: `bookDepthUsd` = min(Bid, Ask)-Tiefe in
 * Quote-Währung, fail-closed (`null`) bei ungültigen/dünnen Büchern. Dazu
 * die Venue-Qualitätsgrenze aus `bookDepthProvenance.ts` (nur `depth`-Venues
 * liefern `VERIFIED`).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  bookSideDepthUsd,
  computeBookDepth,
  sanitizeBookLevels,
} from "../src/lib/bookDepth";
import {
  bookDepthVerdict,
  findBookDepthQuality,
  depthUsableForVenue,
  BOOK_DEPTH_MIN_LEVELS_PER_QUOTE,
} from "../src/lib/bookDepthProvenance";

test("computeBookDepth: min(bid, ask) über der Qualitätsgrenze", () => {
  // 3 Levels je Seite, ordnungsgemäß sortiert.
  const bids = [
    [99.9, 10],
    [99.8, 20],
    [99.7, 30],
  ];
  const asks = [
    [100.1, 5],
    [100.2, 15],
    [100.3, 25],
  ];
  const depth = computeBookDepth(bids, asks, 10);
  const bidDepth = 99.9 * 10 + 99.8 * 20 + 99.7 * 30; // 999 + 1996 + 2991
  const askDepth = 100.1 * 5 + 100.2 * 15 + 100.3 * 25; // 500.5 + 1503 + 2507.5
  assert.equal(depth.bidDepthUsd, bidDepth);
  assert.equal(depth.askDepthUsd, askDepth);
  assert.equal(depth.depthUsd, Math.min(bidDepth, askDepth));
  assert.equal(depth.bidLevels, 3);
  assert.equal(depth.askLevels, 3);
});

test("computeBookDepth: ordnungsunabhängig (unsortierte Rohlevels)", () => {
  // Verstreute Reihenfolge: bids [99.8, 99.9, 99.7], asks [100.3, 100.1, 100.2].
  const bids = [
    [99.8, 20],
    [99.9, 10],
    [99.7, 30],
  ];
  const asks = [
    [100.3, 25],
    [100.1, 5],
    [100.2, 15],
  ];
  const depth = computeBookDepth(bids, asks, 10);
  assert.equal(depth.bestBid, 99.9);
  assert.equal(depth.bestAsk, 100.1);
  // Mid liegt bei (99.9 + 100.1) / 2 — alle Levels gültig.
  assert.ok(depth.depthUsd !== null && depth.depthUsd > 0);
});

test("computeBookDepth: gekreuztes Buch → null (fail-closed)", () => {
  const depth = computeBookDepth([[100.5, 10]], [[100.4, 10]], 10);
  assert.equal(depth.depthUsd, null);
});

test("computeBookDepth: einseitiges Buch → null", () => {
  const depth = computeBookDepth([[99.9, 1]], [], 10);
  assert.equal(depth.depthUsd, null);
});

test("computeBookDepth: nur Null-Mengen → null (kein erfundener Tiefenwert)", () => {
  const depth = computeBookDepth([[99.9, 0]], [[100.1, 0]], 10);
  assert.equal(depth.depthUsd, null);
  assert.equal(depth.bidDepthUsd, 0);
});

test("computeBookDepth: Kappung auf maxLevels", () => {
  const bids = Array.from({ length: 20 }, (_, i) => [100 - i, 1]); // absteigend
  const asks = Array.from({ length: 20 }, (_, i) => [100 + i, 1]); // aufsteigend
  const depth = computeBookDepth(bids, asks, 5);
  assert.equal(depth.bidLevels, 5);
  assert.equal(depth.askLevels, 5);
});

test("computeBookDepth: kaputte Einträge (NaN/String-Grill) werden verworfen", () => {
  const bids = [
    [99.9, 10],
    ["garnicht", "zahl"],
    [99.8, NaN],
    [99.7, -5],
  ] as unknown as [unknown, unknown][];
  const asks = [
    [100.1, 5],
    [100.2, "x"],
  ] as unknown as [unknown, unknown][];
  const depth = computeBookDepth(bids, asks, 10);
  assert.equal(depth.bidLevels, 1);
  assert.equal(depth.askLevels, 1);
  // min(bid=99.9×10, ask=100.1×5) = 500.5
  assert.equal(depth.depthUsd, 500.5);
});

test("computeBookDepth: quer liegende Levels erzeugen gekreuztes Top → null", () => {
  // Ein Bid-Level über dem Ask-Top (oder umgekehrt) macht bestAsk < bestBid —
  // fail-closed, nie wird die falsche Buchseite gezählt.
  const bids = [
    [99.0, 10],
    [100.0, 999], // liegt über dem besten Ask → gekreuzt
  ];
  const asks = [
    [99.5, 5],
    [99.4, 999],
  ];
  const depth = computeBookDepth(bids, asks, 10);
  assert.equal(depth.depthUsd, null);
});

test("bookSideDepthUsd: ohne gültigen Mid keine Summe", () => {
  const res = bookSideDepthUsd([{ price: 100, qty: 1 }], null);
  assert.equal(res.depthUsd, 0);
  assert.equal(res.levels, 0);
});

test("sanitizeBookLevels: Nicht-Arrays und leere Kappe liefern []", () => {
  assert.deepEqual(sanitizeBookLevels(null, 10), []);
  assert.deepEqual(sanitizeBookLevels("x", 10), []);
  assert.deepEqual(sanitizeBookLevels([[1, 2]], 0), []);
});

test("bookDepthProvenance: nur depth-Venues sind belastbar", () => {
  assert.equal(findBookDepthQuality("BINANCE").kind, "depth");
  assert.equal(findBookDepthQuality("BITUNIX").kind, "depth");
  assert.equal(findBookDepthQuality("KRAKEN").kind, "depth");
  assert.equal(findBookDepthQuality("YAHOO").kind, "top");
  assert.equal(findBookDepthQuality("PAPER").kind, "none");
  assert.equal(findBookDepthQuality("").kind, "none");
  assert.equal(findBookDepthQuality("X".repeat(64)).kind, "none");
  assert.equal(findBookDepthQuality(undefined).kind, "none");
});

test("bookDepthVerdict: Levels/Alter gegen die Venue-Grenze", () => {
  const min = BOOK_DEPTH_MIN_LEVELS_PER_QUOTE;
  assert.equal(bookDepthVerdict("BINANCE", { levels: min, maxAgeMs: null }), "VERIFIED");
  assert.equal(bookDepthVerdict("BINANCE", { levels: min - 1, maxAgeMs: null }), "UNQUALIFIED");
  assert.equal(bookDepthVerdict("BINANCE", { levels: min, maxAgeMs: 9999 }), "UNQUALIFIED");
  assert.equal(bookDepthVerdict("YAHOO", { levels: min, maxAgeMs: null }), "UNQUALIFIED");
  assert.equal(bookDepthVerdict("BINANCE", null), "UNQUALIFIED");
});

test("depthUsableForVenue: Capability-Abfrage", () => {
  assert.equal(depthUsableForVenue("BINANCE"), true);
  assert.equal(depthUsableForVenue("YAHOO"), false);
  assert.equal(depthUsableForVenue("PAPER"), false);
});

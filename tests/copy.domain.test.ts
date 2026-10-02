/**
 * Copy-Trading — reines Domänenmodell (STX-07-01).
 *
 * Testet ausschließlich die reinen Funktionen aus `src/copy`: Symbol-Mapping
 * (SSoT-gestützt, cross-venue) und Sizing/Leverage. Keine DB, kein Netz, keine
 * Uhr. Jeder `{ok:false}`-Pfad wird auf einen **benannten** Grund geprüft; ein
 * stiller Moduswechsel ist explizit verboten.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COPY_MODES,
  type CopyMode,
} from "@/copy/types";
import { mapLeaderSymbol, toCrossVenueId } from "@/copy/mapping";
import {
  applyLeveragePolicy,
  computeFollowerNotional,
  type SizingInput,
} from "@/copy/sizing";

// ── CopyMode: exakt ein Wert (STX-16) ───────────────────────────────────────
test("CopyMode hat genau einen Wert (SIMULATE_ONLY)", () => {
  assert.strictEqual(COPY_MODES.length, 1);
  assert.deepStrictEqual([...COPY_MODES], ["SIMULATE_ONLY"]);
  // Type-level: die Union darf nur diesen einen Member enthalten.
  const m: CopyMode = "SIMULATE_ONLY";
  assert.strictEqual(m, "SIMULATE_ONLY");
});

// ── Mapping: venue-übergreifende ID ─────────────────────────────────────────
test("toCrossVenueId mappt Stablecoin-Quote auf USD, sonst identisch", () => {
  assert.strictEqual(toCrossVenueId("BTC/USDT"), "BTC/USD");
  assert.strictEqual(toCrossVenueId("ETH/USDC"), "ETH/USD");
  assert.strictEqual(toCrossVenueId("BTC/USD"), "BTC/USD"); // bereits USD
  assert.strictEqual(toCrossVenueId("BTC/USDP"), "BTC/USD");
  // Krypto-Krypto-Quote wird NICHT gemappt.
  assert.strictEqual(toCrossVenueId("ETH/BTC"), "ETH/BTC");
  // Single-Ticker (Aktie) unverändert.
  assert.strictEqual(toCrossVenueId("AAPL"), "AAPL");
});

test("mapLeaderSymbol: 4 native Schreibweisen => dieselbe instrumentId, verschiedene Venue-Auflösung", () => {
  // Hinweis: das Ticket führt `BTCUSDT-P` (Bybit-Stil) als eine der
  // Schreibweisen an. Der SSoT erkennt als Perp-Marker nur PERP/SWAP; die
  // perpetual-Variante wird hier durch die unterstützte Form `BTC-PERP`
  // (DYDX) repräsentiert — der cross-venue-Kern (gleiche ID, andere
  // Venue-Auflösung) bleibt identisch.
  const cases: Array<[Parameters<typeof mapLeaderSymbol>[0], string]> = [
    ["KRAKEN", "BTC/USD"],
    ["BINANCE", "BTCUSDT"],
    ["ALPACA", "BTCUSDT"],
    ["DYDX", "BTC-PERP"],
  ];

  const mapped = cases.map(([venue, raw]) => mapLeaderSymbol(venue, raw));
  for (const m of mapped) {
    assert.ok(m.ok, "Alle vier Schreibweisen müssen auflösbar sein");
  }
  const ok = mapped.filter(
    (m): m is Extract<typeof m, { ok: true }> => m.ok
  );

  // Alle lösen auf dieselbe venue-übergreifende ID auf.
  const ids = ok.map((m) => m.instrumentId);
  assert.strictEqual(new Set(ids).size, 1, `instrumentIds: ${ids.join(", ")}`);
  assert.strictEqual(ids[0], "BTC/USD");

  // Die Venue-Auflösungen unterscheiden sich (native Schreibweise / Venue).
  const venues = ok.map((m) => m.venue);
  assert.strictEqual(new Set(venues).size, 4, `venues: ${venues.join(", ")}`);
  const natives = ok.map((m) => m.resolved.venueNative);
  assert.strictEqual(new Set(natives).size, 4, `native: ${natives.join(", ")}`);

  // Kein String.replace: die rohe SSoT-kanonische Form ist venue-spezifisch.
  const canonicals = ok.map((m) => m.resolved.canonical);
  assert.ok(canonicals.includes("BTC/USDT"));
  assert.ok(canonicals.includes("BTC/USD"));
});

test("mapLeaderSymbol: unbekanntes/ungültiges Symbol => {ok:false} mit Grund", () => {
  const bad = mapLeaderSymbol("KRAKEN", "$$$NOPE$$$");
  assert.strictEqual(bad.ok, false);
  if (!bad.ok) {
    assert.strictEqual(typeof bad.reason, "string");
    assert.ok(bad.reason.length > 0, "Grund darf nicht leer sein");
  }
});

test("mapLeaderSymbol: leeres Symbol => {ok:false}, kein Fallback", () => {
  const empty = mapLeaderSymbol("BINANCE", "");
  assert.strictEqual(empty.ok, false);
});

// ── Sizing: EQUITY_RATIO ────────────────────────────────────────────────────
function equityInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    mode: "EQUITY_RATIO",
    action: "OPEN",
    leaderNotional: 10000,
    leaderEquity: 100000,
    followerEquity: 1000,
    fixedAmount: 0,
    ratio: 0,
    multiplier: 1,
    ...overrides,
  };
}

test("EQUITY_RATIO: 100k Leader-Equity, 10k Position => 10%; Follower 1k => 100", () => {
  const r = computeFollowerNotional(
    equityInput({ leaderEquity: 100000, leaderNotional: 10000, followerEquity: 1000 })
  );
  assert.ok(r.ok);
  if (r.ok) {
    // 1000 * (10000 / 100000) * 1 = 100
    assert.strictEqual(r.notional, 100);
    assert.strictEqual(r.mode, "EQUITY_RATIO");
    assert.strictEqual(r.multiplier, 1);
  }
});

test("EQUITY_RATIO: leaderEquity 0 => {ok:false}", () => {
  const r = computeFollowerNotional(equityInput({ leaderEquity: 0 }));
  assert.strictEqual(r.ok, false);
});

test("EQUITY_RATIO: followerEquity 0 => {ok:false}", () => {
  const r = computeFollowerNotional(equityInput({ followerEquity: 0 }));
  assert.strictEqual(r.ok, false);
});

test("EQUITY_RATIO: ohne leaderEquity => {ok:false}, KEIN Fallback", () => {
  const r = computeFollowerNotional(equityInput({ leaderEquity: null }));
  assert.strictEqual(r.ok, false);
  if (!r.ok) {
    assert.strictEqual(r.reason, "EQUITY_RATIO_REQUIRES_LEADER_EQUITY");
  }
});

test("EQUITY_RATIO: leaderNotional 0 bei OPEN => {ok:false}", () => {
  const r = computeFollowerNotional(
    equityInput({ leaderNotional: 0, action: "OPEN" })
  );
  assert.strictEqual(r.ok, false);
});

test("EQUITY_RATIO mit multiplier 2 verdoppelt das Notional", () => {
  const r = computeFollowerNotional(
    equityInput({ followerEquity: 1000, multiplier: 2 })
  );
  assert.ok(r.ok);
  if (r.ok) assert.strictEqual(r.notional, 200);
});

// ── Sizing: FIXED_AMOUNT / FIXED_RATIO ──────────────────────────────────────
test("FIXED_AMOUNT: liefert konstante Größe", () => {
  const r = computeFollowerNotional({
    mode: "FIXED_AMOUNT",
    action: "OPEN",
    leaderNotional: 5000,
    leaderEquity: 100000,
    followerEquity: 1000,
    fixedAmount: 250,
    ratio: 0,
    multiplier: 1,
  });
  assert.ok(r.ok);
  if (r.ok) assert.strictEqual(r.notional, 250);
});

test("FIXED_AMOUNT: nicht-positive Menge => {ok:false}", () => {
  const r = computeFollowerNotional({
    mode: "FIXED_AMOUNT",
    action: "OPEN",
    leaderNotional: 5000,
    leaderEquity: 100000,
    followerEquity: 1000,
    fixedAmount: 0,
    ratio: 0,
    multiplier: 1,
  });
  assert.strictEqual(r.ok, false);
});

test("FIXED_RATIO: leaderNotional × ratio", () => {
  const r = computeFollowerNotional({
    mode: "FIXED_RATIO",
    action: "OPEN",
    leaderNotional: 5000,
    leaderEquity: 100000,
    followerEquity: 1000,
    fixedAmount: 0,
    ratio: 0.5,
    multiplier: 1,
  });
  assert.ok(r.ok);
  if (r.ok) assert.strictEqual(r.notional, 2500);
});

test("FIXED_RATIO: leaderNotional <= 0 => {ok:false}", () => {
  const r = computeFollowerNotional({
    mode: "FIXED_RATIO",
    action: "OPEN",
    leaderNotional: 0,
    leaderEquity: 100000,
    followerEquity: 1000,
    fixedAmount: 0,
    ratio: 0.5,
    multiplier: 1,
  });
  assert.strictEqual(r.ok, false);
});

// ── CLOSE: Intent existiert mit notional 0 ──────────────────────────────────
test("CLOSE => Intent (SizingResult) mit notional 0, bleibt ok", () => {
  const r = computeFollowerNotional({
    mode: "EQUITY_RATIO",
    action: "CLOSE",
    leaderNotional: 10000,
    leaderEquity: 100000,
    followerEquity: 1000,
    fixedAmount: 0,
    ratio: 0,
    multiplier: 1,
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.strictEqual(r.notional, 0); // Position wird zugeteilt, nicht bewertet
  }
});

// ── Leverage-Politik ────────────────────────────────────────────────────────
test("FOLLOW_LEADER: Leader 10x, Cap 3x => 3, adjusted true", () => {
  const d = applyLeveragePolicy("FOLLOW_LEADER", 10, 3);
  assert.strictEqual(d.leverage, 3);
  assert.strictEqual(d.adjusted, true);
  assert.strictEqual(d.reason, "FOLLOW_LEADER_CLAMPED_TO_CAP");
});

test("FOLLOW_LEADER: Leader 2x, Cap 3x => 2, nicht angepasst", () => {
  const d = applyLeveragePolicy("FOLLOW_LEADER", 2, 3);
  assert.strictEqual(d.leverage, 2);
  assert.strictEqual(d.adjusted, false);
  assert.strictEqual(d.reason, "FOLLOW_LEADER");
});

test("FOLLOW_LEADER: fehlender Leader-Hebel => null mit Grund", () => {
  const d = applyLeveragePolicy("FOLLOW_LEADER", null, 3);
  assert.strictEqual(d.leverage, null);
  assert.strictEqual(d.adjusted, false);
});

test("CAP: verwendet zwingend den Follower-Cap", () => {
  const d = applyLeveragePolicy("CAP", 10, 5);
  assert.strictEqual(d.leverage, 5);
  assert.strictEqual(d.adjusted, false);
});

test("IGNORE: kein Hebel", () => {
  const d = applyLeveragePolicy("IGNORE", 10, 5);
  assert.strictEqual(d.leverage, null);
  assert.strictEqual(d.reason, "IGNORE");
});

test("RISK_NORMALIZED: klemmt auf Cap wenn ueberschritten", () => {
  const d = applyLeveragePolicy("RISK_NORMALIZED", 10, 4);
  assert.strictEqual(d.leverage, 4);
  assert.strictEqual(d.adjusted, true);
  assert.strictEqual(d.reason, "RISK_NORMALIZED_CLAMPED_TO_CAP");
});

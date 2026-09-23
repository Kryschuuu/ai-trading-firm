/**
 * Venue-Gates der Sync-Registry (`registerAdapters.ts`) für die neuen Venues.
 *
 * Coverage: `<VENUE>_ENABLED` (nur exakt `"true"`), Sync-lokale Capability-
 * Tabelle (falsch ⇒ CAPABILITY_DISABLED), Allowlist/Kill-Switch/Unknown-Key-
 * Verhalten über alle 6 Venues, Fabrik erzeugt je Venue den passenden
 * Adapter (lazy — kein Request bei der Registrierung).
 *
 * BITUNIX-Gates bleiben in `bitunix.test.ts` §3 gepinnt (Broker-Matrix +
 * `BITUNIX_ENABLED`) und werden hier nur auf Nicht-Regression geprüft.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { VENUE_CAPABILITIES } from "../../../src/brokers/capabilities";
import {
  KNOWN_SYNC_VENUES,
  SYNC_VENUE_MARKET_DATA,
  registerAdapters,
} from "../../../src/marketdata";

function allEnabledEnv(): Record<string, string> {
  return {
    BITUNIX_ENABLED: "true",
    BINANCE_ENABLED: "true",
    KRAKEN_ENABLED: "true",
    ALPACA_ENABLED: "true",
    IBKR_ENABLED: "true",
    PAPER_ENABLED: "true",
  };
}

test("KNOWN_SYNC_VENUES: 6 Venues in syncAll-Reihenfolge", () => {
  assert.deepEqual([...KNOWN_SYNC_VENUES], ["BITUNIX", "BINANCE", "KRAKEN", "ALPACA", "IBKR", "PAPER"]);
});

test("alle Flags an ⇒ alle 6 Adapter registriert (lazy, ohne Request)", () => {
  const { adapters, skipped } = registerAdapters({ env: allEnabledEnv() });
  assert.equal(adapters.size, 6);
  assert.deepEqual(skipped, []);
  for (const venue of KNOWN_SYNC_VENUES) {
    assert.equal(adapters.get(venue)?.venue, venue);
  }
});

test("jedes <VENUE>_ENABLED gatet einzeln (nur exakt true)", () => {
  for (const [venue, flag] of [
    ["BINANCE", "BINANCE_ENABLED"],
    ["KRAKEN", "KRAKEN_ENABLED"],
    ["ALPACA", "ALPACA_ENABLED"],
    ["IBKR", "IBKR_ENABLED"],
    ["PAPER", "PAPER_ENABLED"],
  ] as const) {
    for (const value of [undefined, "", "false", "0", "TRUE", " true"]) {
      const env = { ...allEnabledEnv() };
      if (value === undefined) delete env[flag];
      else env[flag] = value;
      const { adapters, skipped } = registerAdapters({ env, venues: [venue] });
      assert.equal(adapters.size, 0, `${flag}=${String(value)}`);
      assert.deepEqual(skipped, [{ venue, reason: "VENUE_DISABLED" }], `${flag}=${String(value)}`);
    }
    const on = registerAdapters({ env: allEnabledEnv(), venues: [venue] });
    assert.equal(on.adapters.size, 1, `${flag}=true`);
  }
});

test("Sync-lokale Capability-Tabelle: false ⇒ CAPABILITY_DISABLED (trotz Flag)", () => {
  const table = SYNC_VENUE_MARKET_DATA as Record<string, boolean>;
  const prev = table.KRAKEN;
  table.KRAKEN = false;
  try {
    const { adapters, skipped } = registerAdapters({ env: allEnabledEnv(), venues: ["KRAKEN"] });
    assert.equal(adapters.size, 0);
    assert.deepEqual(skipped, [{ venue: "KRAKEN", reason: "CAPABILITY_DISABLED" }]);
  } finally {
    table.KRAKEN = prev;
  }
});

test("Kill-Switch listet alle 6 Venues als KILL_SWITCH", () => {
  const { adapters, skipped } = registerAdapters({
    env: { ...allEnabledEnv(), MARKET_SYNC_ENABLED: "false" },
  });
  assert.equal(adapters.size, 0);
  assert.deepEqual(
    skipped.map((s) => s.venue).sort(),
    [...KNOWN_SYNC_VENUES].sort(),
  );
  assert.ok(skipped.every((s) => s.reason === "KILL_SWITCH"));
});

test("Allowlist + Unknown-Key + Tippfehler-Verhalten", () => {
  const { adapters, skipped } = registerAdapters({
    env: { ...allEnabledEnv(), MARKET_SYNC_VENUES: "BINANCE,PAPER" },
  });
  assert.deepEqual([...adapters.keys()].sort(), ["BINANCE", "PAPER"]);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((s) => s.reason === "NOT_IN_ALLOWLIST"));

  const unknown = registerAdapters({ env: allEnabledEnv(), venues: ["BINANCE", "NOPE"] });
  assert.equal(unknown.adapters.size, 1);
  assert.deepEqual(unknown.skipped, [{ venue: "NOPE", reason: "UNKNOWN_VENUE" }]);

  const badKey = registerAdapters({ env: allEnabledEnv(), venues: ["!!!"] });
  assert.equal(badKey.adapters.size, 0);
  assert.equal(badKey.skipped[0]?.reason, "INVALID_VENUE_KEY");
});

test("ignoreEnvGates umgeht Flags, aber nicht die Capability-Tabelle", () => {
  const { adapters } = registerAdapters({ ignoreEnvGates: true });
  assert.equal(adapters.size, 6);

  const table = SYNC_VENUE_MARKET_DATA as Record<string, boolean>;
  const prev = table.IBKR;
  table.IBKR = false;
  try {
    const gated = registerAdapters({ ignoreEnvGates: true, venues: ["IBKR"] });
    assert.equal(gated.adapters.size, 0);
    assert.deepEqual(gated.skipped, [{ venue: "IBKR", reason: "CAPABILITY_DISABLED" }]);
  } finally {
    table.IBKR = prev;
  }
});

test("Nicht-Regression: BITUNIX-Gate bleibt Broker-Matrix + BITUNIX_ENABLED", () => {
  // Flag aus ⇒ VENUE_DISABLED (unabhängig von allen anderen Flags).
  const off = registerAdapters({ env: {}, venues: ["BITUNIX"] });
  assert.deepEqual(off.skipped, [{ venue: "BITUNIX", reason: "VENUE_DISABLED" }]);

  // Matrix aus ⇒ CAPABILITY_DISABLED (trotz Flag) — danach restaurieren.
  const caps = VENUE_CAPABILITIES as unknown as Record<string, { marketData: boolean }>;
  const prev = caps.BITUNIX.marketData;
  caps.BITUNIX.marketData = false;
  try {
    const noCap = registerAdapters({ env: allEnabledEnv(), venues: ["BITUNIX"] });
    assert.deepEqual(noCap.skipped, [{ venue: "BITUNIX", reason: "CAPABILITY_DISABLED" }]);
  } finally {
    caps.BITUNIX.marketData = prev;
  }
});

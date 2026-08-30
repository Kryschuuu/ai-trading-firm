/**
 * Capability-Projektion für Instrumente.
 *
 * Der statische Seed darf keine Laufzeit-Wahrheit für `liveAvailable` oder
 * `liveTradable` enthalten. Diese Flags werden ausschließlich aus der
 * Capability-Matrix abgeleitet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { capabilityMatrix } from "../src/capabilities/matrix";
import { resolveInstrumentCapabilities } from "../src/capabilities/resolveCapabilities";
import { SEED_INSTRUMENTS } from "../src/universe/seed";

const LIVE_FIELDS = ["liveAvailable", "liveTradable"] as const;

test("resolveInstrumentCapabilities: Stub-Venues fallen sicher auf false/false", () => {
  assert.deepEqual(resolveInstrumentCapabilities("BINANCE", capabilityMatrix), {
    liveAvailable: false,
    liveTradable: false,
  });
});

test("resolveInstrumentCapabilities: BITUNIX spiegelt die Capability-Matrix", () => {
  assert.deepEqual(resolveInstrumentCapabilities("BITUNIX", capabilityMatrix), {
    liveAvailable: capabilityMatrix.BITUNIX?.marketData === true,
    liveTradable: capabilityMatrix.BITUNIX?.trading === true,
  });
});

test("resolveInstrumentCapabilities: unbekannte Venue ist fail-closed", () => {
  assert.deepEqual(resolveInstrumentCapabilities("UNKNOWN_VENUE", capabilityMatrix), {
    liveAvailable: false,
    liveTradable: false,
  });
});

test("Seed-Struktur: kein Seed-Eintrag persistiert liveAvailable/liveTradable", () => {
  for (const instrument of SEED_INSTRUMENTS) {
    for (const field of LIVE_FIELDS) {
      assert.equal(Object.hasOwn(instrument, field), false, `${instrument.venue}:${instrument.symbol}.${field}`);
    }
  }
});

test("Seed-Dateien: versionierte NDJSON-Seeds enthalten keine Live-Projektionsfelder", () => {
  for (const rel of ["data/universe/instruments.ndjson", "tests/fixtures/universe-instruments.ndjson"]) {
    const text = readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const [idx, line] of text.split("\n").filter(Boolean).entries()) {
      const instrument = JSON.parse(line) as Record<string, unknown>;
      for (const field of LIVE_FIELDS) {
        assert.equal(Object.hasOwn(instrument, field), false, `${rel}:${idx + 1}.${field}`);
      }
    }
  }
});

test("Regression: reale Stub-Venues im Seed projizieren liveAvailable=false", () => {
  const stubVenues = new Set(["BINANCE", "KRAKEN", "ALPACA", "IBKR"]);
  const checked = new Set<string>();
  for (const instrument of SEED_INSTRUMENTS) {
    if (!stubVenues.has(instrument.venue)) continue;
    checked.add(instrument.venue);
    assert.deepEqual(
      resolveInstrumentCapabilities(instrument.venue, capabilityMatrix),
      { liveAvailable: false, liveTradable: false },
      `${instrument.venue}:${instrument.symbol}`,
    );
  }
  assert.deepEqual([...checked].sort(), [...stubVenues].sort());
});

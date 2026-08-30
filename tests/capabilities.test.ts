/**
 * Capability-Projektion für Instrumente (CAP-008).
 *
 * Der Seed darf liveAvailable nicht enthalten. liveTradable ist die fachliche
 * Stammdaten-Entscheidung. liveAvailable kommt ausschließlich aus
 * projectInstrumentAvailability().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { capabilityMatrix } from "../src/capabilities/matrix";
import { resolveInstrumentCapabilities } from "../src/capabilities/resolveCapabilities";
import { projectInstrumentAvailability } from "../src/universe/capabilityProjection";
import { SEED_INSTRUMENTS } from "../src/universe/seed";

test("resolveInstrumentCapabilities: Stub-Venues fallen sicher auf false/false", () => {
  assert.deepEqual(resolveInstrumentCapabilities("BINANCE", capabilityMatrix), {
    liveAvailable: false,
    liveTradable: false,
  });
});

test("resolveInstrumentCapabilities: BITUNIX bleibt fail-closed ohne Gate/Flag", () => {
  assert.deepEqual(resolveInstrumentCapabilities("BITUNIX", capabilityMatrix, true), {
    liveAvailable: false,
    liveTradable: true,
  });
});

test("resolveInstrumentCapabilities: unbekannte Venue ist fail-closed", () => {
  assert.deepEqual(resolveInstrumentCapabilities("UNKNOWN_VENUE", capabilityMatrix), {
    liveAvailable: false,
    liveTradable: false,
  });
});

test("Seed-Struktur: kein Seed-Eintrag persistiert liveAvailable", () => {
  for (const instrument of SEED_INSTRUMENTS) {
    assert.equal(Object.hasOwn(instrument, "liveAvailable"), false, `${instrument.venue}:${instrument.symbol}.liveAvailable`);
    assert.equal(typeof instrument.liveTradable, "boolean", `${instrument.venue}:${instrument.symbol}.liveTradable`);
    if (instrument.venue === "PAPER") assert.equal(instrument.liveTradable, false);
    else assert.equal(instrument.liveTradable, true);
  }
});

test("Seed-Dateien: versionierte NDJSON-Seeds enthalten kein liveAvailable", () => {
  for (const rel of ["data/universe/instruments.ndjson", "tests/fixtures/universe-instruments.ndjson"]) {
    const text = readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const [idx, line] of text.split("\n").filter(Boolean).entries()) {
      const instrument = JSON.parse(line) as Record<string, unknown>;
      assert.equal(Object.hasOwn(instrument, "liveAvailable"), false, `${rel}:${idx + 1}.liveAvailable`);
      assert.equal(typeof instrument.liveTradable, "boolean", `${rel}:${idx + 1}.liveTradable`);
    }
  }
});

test("Regression: reale Stub-Venues im Seed projizieren liveAvailable=false", () => {
  const stubVenues = new Set(["BINANCE", "KRAKEN", "ALPACA", "IBKR"]);
  const checked = new Set<string>();
  for (const instrument of SEED_INSTRUMENTS) {
    if (!stubVenues.has(instrument.venue)) continue;
    checked.add(instrument.venue);
    const projected = projectInstrumentAvailability(instrument);
    assert.equal(projected.liveAvailable, false, `${instrument.venue}:${instrument.symbol}`);
    assert.equal(projected.liveTradable, true, `${instrument.venue}:${instrument.symbol}`);
  }
  assert.deepEqual([...checked].sort(), [...stubVenues].sort());
});

/**
 * Timeframe-Vokabular (`src/lib/marketdata/timeframes.ts`, STX-01, v0.6.2).
 *
 * Es gibt genau EIN Vokabular. Dieses Modul ist seine Heimat: Der Store
 * re-exportiert es, Regel-Engine, Mikro-Executor und Workshop-UI lesen es. Die
 * Tests sichern die Invarianten, auf denen die Konsumenten aufbauen
 * (aufsteigende Sortierung, positive ganzzahlige Perioden, strenge Allowlist)
 * und dass das Modul client-sicher bleibt (kein `node:fs`, keine Imports).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as store from "../../src/lib/marketdata/historicalStore";
import {
  SUPPORTED_TIMEFRAMES,
  SUPPORTED_TIMEFRAME_MS,
  isSupportedTimeframe,
} from "../../src/lib/marketdata/timeframes";

test("Der Historical Store re-exportiert das Vokabular unverändert (identische Objekte, keine Kopie)", () => {
  assert.equal(store.SUPPORTED_TIMEFRAMES, SUPPORTED_TIMEFRAMES);
  assert.equal(store.SUPPORTED_TIMEFRAME_MS, SUPPORTED_TIMEFRAME_MS);
  assert.equal(store.isSupportedTimeframe, isSupportedTimeframe);
});

test("Allowlist: zehn Timeframes, aufsteigend nach Dauer, jede Periode positiv und ganzzahlig", () => {
  assert.deepEqual([...SUPPORTED_TIMEFRAMES], ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "5d"]);
  assert.deepEqual(Object.keys(SUPPORTED_TIMEFRAME_MS).sort(), [...SUPPORTED_TIMEFRAMES].sort(), "Tabelle deckt die Allowlist exakt");
  const durations = SUPPORTED_TIMEFRAMES.map((timeframe) => SUPPORTED_TIMEFRAME_MS[timeframe]);
  durations.forEach((ms, i) => {
    assert.ok(Number.isInteger(ms) && ms > 0, `${SUPPORTED_TIMEFRAMES[i]}: Periode muss positiv und ganzzahlig sein`);
    if (i > 0) assert.ok(ms > durations[i - 1], `${SUPPORTED_TIMEFRAMES[i]}: Allowlist muss aufsteigend sortiert sein`);
  });
  // Die Minutengrenze, auf der Rolling-Serien aggregieren: jede Periode ist ein Vielfaches von 1m.
  for (const ms of durations) assert.equal(ms % 60_000, 0);
});

test("isSupportedTimeframe ist streng: Schreibweise, Leerraum und Nicht-Strings werden abgewiesen", () => {
  for (const timeframe of SUPPORTED_TIMEFRAMES) assert.equal(isSupportedTimeframe(timeframe), true, timeframe);
  for (const raw of ["1H", "4D", " 1h", "1h ", "2m", "7d", "1w", "", null, undefined, 60, {}, ["1h"]]) {
    assert.equal(isSupportedTimeframe(raw), false, JSON.stringify(raw));
  }
});

test("Client-Sicherheit: das Vokabular-Modul hat keine Imports — kein node:fs im Client-Bundle der Workshop-UI", () => {
  const source = readFileSync(resolve(process.cwd(), "src/lib/marketdata/timeframes.ts"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "reine Daten: kein import");
  assert.doesNotMatch(source, /^\s*export\s[^;]*\sfrom\s/m, "kein Re-Export aus einem anderen Modul");
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/, "kein dynamischer Import");
});

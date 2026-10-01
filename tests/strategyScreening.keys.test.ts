/** STX-05-03: reine Hash-/Bounds-Tests, auch ohne PostgreSQL ausführbar. */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalJson } from "../src/strategyLifecycle/evidence";
import { screeningAsOf, screeningCellKey, screeningRunHash } from "../src/screening/keys";
import { screeningResultsLimit } from "../src/screening/store";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../src/lib/paging";

const run = {
  cells: [{ strategyVersionId: "12345678-1234-1234-1234-123456789abc", instrumentId: "PAPER:BTCUSD", venue: "PAPER", timeframe: "1h" }],
  asOf: "2026-10-01T12:00:00.000Z",
  codeVersion: "0.8.0",
  config: { weights: { liquidity: 0.25, dataQuality: 0.3 }, limits: { maxCells: 5_000 } },
};
const cell = {
  runId: "abcdef01-1234-1234-1234-123456789abc",
  ...run.cells[0],
};
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

test("Run-Key folgt exakt ssr1:sha256(canonicalJson({ cells, asOf, codeVersion, config }))", () => {
  assert.equal(screeningRunHash(run), `ssr1:${hash(run)}`);
  assert.match(screeningRunHash(run), /^ssr1:[0-9a-f]{64}$/);
  assert.equal(screeningRunHash(run), screeningRunHash({
    config: { limits: { maxCells: 5_000 }, weights: { dataQuality: 0.3, liquidity: 0.25 } },
    codeVersion: run.codeVersion,
    asOf: new Date(run.asOf),
    cells: [{ timeframe: "1h", venue: "PAPER", instrumentId: "PAPER:BTCUSD", strategyVersionId: run.cells[0].strategyVersionId }],
  }), "Objektschlüssel-Reihenfolge verändert die Identität nicht");
  for (const asOf of [new Date(run.asOf), Date.parse(run.asOf), "2026-10-01T14:00:00+02:00"]) {
    assert.equal(screeningRunHash({ ...run, asOf }), screeningRunHash(run), "gleicher UTC-Cutoff");
  }
});

test("Run-Identität bindet jede Zelle, Cutoff, Code-Version und die vollständige Config", () => {
  for (const changed of [
    { ...run, cells: [] },
    { ...run, cells: [{ ...run.cells[0], instrumentId: "PAPER:ETHUSD" }] },
    { ...run, asOf: "2026-10-01T12:00:00.001Z" },
    { ...run, codeVersion: "0.8.1" },
    { ...run, config: { ...run.config, limits: { maxCells: 4_000 } } },
    { ...run, config: { ...run.config, weights: { liquidity: 0.2, dataQuality: 0.3 } } },
  ]) assert.notEqual(screeningRunHash(changed), screeningRunHash(run));
  const cells = [...run.cells, { ...run.cells[0], instrumentId: "PAPER:ETHUSD" }];
  assert.notEqual(screeningRunHash({ ...run, cells }), screeningRunHash({ ...run, cells: cells.toReversed() }), "Array-Reihenfolge kommt aus dem stabilen Matrix-Builder");
});

test("Zell-Key bindet genau Run, Strategieversion, Instrument, Venue und Timeframe", () => {
  assert.equal(screeningCellKey(cell), `ssm1:${hash(cell)}`);
  assert.match(screeningCellKey(cell), /^ssm1:[0-9a-f]{64}$/);
  const withPayload = { ...cell, priority: 0.9, status: "BLOCKED", reasons: ["warmup"], metrics: { sharpe: null }, templateId: "ema-adx-trend" };
  assert.equal(screeningCellKey(withPayload), screeningCellKey(cell), "Payload verändert den Retry-Key nicht");
  for (const changed of [
    { ...cell, runId: "abcdef02-1234-1234-1234-123456789abc" },
    { ...cell, strategyVersionId: "12345679-1234-1234-1234-123456789abc" },
    { ...cell, instrumentId: "PAPER:ETHUSD" },
    { ...cell, venue: "ALPACA" },
    { ...cell, timeframe: "4h" },
  ]) assert.notEqual(screeningCellKey(changed), screeningCellKey(cell));
  assert.equal(screeningCellKey({ ...cell, runId: cell.runId.toUpperCase(), strategyVersionId: ` ${cell.strategyVersionId.toUpperCase()} ` }), screeningCellKey(cell), "Postgres-UUIDs sind unabhängig von der Schreibweise");
});

test("Fehlende Identitäten, Config, Code und invalide/lokale Cutoffs werden abgelehnt", () => {
  for (const asOf of [new Date(NaN), NaN, Infinity, "invalidZ", "2026-10-01T12:00:00", "2026-10-01"]) {
    assert.throws(() => screeningAsOf(asOf), /asOf/);
  }
  assert.throws(() => screeningRunHash({ ...run, codeVersion: " " }), /codeVersion/);
  assert.throws(() => screeningRunHash({ ...run, config: null as unknown as typeof run.config }), /config/);
  assert.throws(() => screeningRunHash({ ...run, cells: null as unknown as [] }), /cells/);
  for (const field of ["runId", "strategyVersionId", "instrumentId", "venue", "timeframe"] as const) {
    assert.throws(() => screeningCellKey({ ...cell, [field]: "" }));
  }
});

test("List-Limit ist durch die gemeinsame Paging-SSoT gedeckelt", () => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, 1.5, "200"]) {
    assert.equal(screeningResultsLimit(value), DEFAULT_PAGE_SIZE);
  }
  for (const value of [1, 2, 50, MAX_PAGE_SIZE]) assert.equal(screeningResultsLimit(value), value);
  assert.equal(screeningResultsLimit(1_000_000), MAX_PAGE_SIZE);
});

test("Store hat keinen DELETE-, Zell-UPDATE- oder Conflict-Overwrite-Pfad", () => {
  const source = readFileSync("src/screening/store.ts", "utf8");
  assert.doesNotMatch(source, /\.delete\s*\(|\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(source, /\.update\s*\(\s*strategyMarketResults\s*\)/);
  assert.doesNotMatch(source, /onConflictDoUpdate/);
  const migration = readFileSync("drizzle/2026-10-01_strategy_screening.sql", "utf8").replace(/^--.*$/gm, "");
  assert.deepEqual([...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]).filter((name) => !["strategy_screening_runs", "strategy_market_results"].includes(name)), []);
  assert.doesNotMatch(migration, /\bDELETE\b|\bUPDATE\b|\bDROP\b/i);
});

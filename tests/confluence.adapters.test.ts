/**
 * Adapter-Tests der MTF-Konfluenz (RMA-P2-03):
 * Store-Batch vs. Kerzen-Adapter (Backtest-/Live-Parität), Idempotenz,
 * Telemetrie, Audit-Events, Roundtrip.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  confluenceBatchFromStore,
  confluenceFromLibCandles,
  confluenceFromMarketCandles,
  confluenceFromStore,
} from "../src/confluence/adapters";
import { DEFAULT_CONFLUENCE_CONFIG } from "../src/confluence/config";
import type { SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import type { MarketCandle as LibMarketCandle } from "../src/lib/marketdata/types";
import { setStructuredLogSinkForTests, type StructuredLogEntry } from "../src/lib/logger";
import { resetTelemetryForTests, telemetry } from "../src/lib/telemetry";
import type { MarketCandle } from "../src/marketdata/types";
import { ASOF_MS, TF_MS, downBars, upBars } from "./confluence.helpers";

const CONFIG = DEFAULT_CONFLUENCE_CONFIG;
const PROV = { venue: "BITUNIX", feed: "BITUNIX:rest" };
const ID_A = "BITUNIX:BTCUSDT";
const ID_B = "BITUNIX:ETHUSDT";

let dir: string;
let logEntries: StructuredLogEntry[];

function toMarketCandles(tf: keyof typeof TF_MS, drift: 1 | -1): MarketCandle[] {
  const bars = drift === 1 ? upBars(tf, 30) : downBars(tf, 30);
  return bars.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

function seedStore(store: HistoricalStore, now: Date): void {
  const groups = [ID_A, ID_B].flatMap((id) =>
    (["15m", "1h", "4h"] as const).map((tf) => ({
      candles: toMarketCandles(tf, id === ID_A ? 1 : -1),
      instrumentId: id,
      provenance: PROV,
      timeframe: tf as SupportedTimeframe,
    })),
  );
  store.appendSeries(groups, now);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "confluence-store-"));
  logEntries = [];
  setStructuredLogSinkForTests((entry) => {
    logEntries.push(entry);
  });
  resetTelemetryForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setStructuredLogSinkForTests(null);
});

test("Store-Adapter: Batch liest einmal und liefert OK-Snapshots je Instrument", () => {
  const store = new HistoricalStore(dir);
  // fetchedAt VOR asOf (realistischer Sync-Stand).
  seedStore(store, new Date(ASOF_MS - 60_000));

  const out = confluenceBatchFromStore(store, [ID_A, ID_B], ASOF_MS, CONFIG, { quiet: true });
  assert.equal(out.size, 2);
  const a = out.get(ID_A)!;
  const b = out.get(ID_B)!;
  assert.equal(a.status, "OK");
  assert.equal(a.bias, "BULLISH");
  assert.ok(a.direction !== null && a.direction > 0.5);
  assert.equal(b.status, "OK");
  assert.equal(b.bias, "BEARISH");
  // Stabile Idempotency-Schlüssel, je Instrument verschieden.
  assert.match(a.snapshotKey, /^mtf1:[0-9a-f]{16}$/);
  assert.notEqual(a.snapshotKey, b.snapshotKey);
});

test("Backtest-/Live-Parität: Store- und Kerzen-Adapter sind identisch", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));

  const fromStore = confluenceFromStore(store, ID_A, ASOF_MS, CONFIG, {
    quiet: true,
    computedAtMs: ASOF_MS,
  });
  const series = new Map<string, readonly MarketCandle[]>([
    ["15m", toMarketCandles("15m", 1)],
    ["1h", toMarketCandles("1h", 1)],
    ["4h", toMarketCandles("4h", 1)],
  ]);
  const fromCandles = confluenceFromMarketCandles(ID_A, ASOF_MS, series, CONFIG, {
    quiet: true,
    computedAtMs: ASOF_MS,
  });
  assert.deepEqual(fromCandles, fromStore);
  assert.equal(JSON.stringify(fromCandles), JSON.stringify(fromStore));
});

test("Analyst-Adapter (getCandles-Zeilen) stimmt mit dem Kerzen-Adapter überein", () => {
  const libSeries = new Map<string, readonly LibMarketCandle[]>([
    ["15m", upBars("15m", 30)],
    ["1h", upBars("1h", 30)],
    ["4h", upBars("4h", 30)],
  ]);
  const viaLib = confluenceFromLibCandles(ID_A, ASOF_MS, libSeries, CONFIG, {
    quiet: true,
    computedAtMs: ASOF_MS,
  });
  const mdSeries = new Map<string, readonly MarketCandle[]>([
    ["15m", toMarketCandles("15m", 1)],
    ["1h", toMarketCandles("1h", 1)],
    ["4h", toMarketCandles("4h", 1)],
  ]);
  const viaMarket = confluenceFromMarketCandles(ID_A, ASOF_MS, mdSeries, CONFIG, {
    quiet: true,
    computedAtMs: ASOF_MS,
  });
  assert.deepEqual(viaLib, viaMarket);
});

test("unbekanntes Instrument: ehrlicher ABSTAIN statt Exception (Batch läuft weiter)", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));
  const out = confluenceBatchFromStore(store, [ID_A, "BITUNIX:UNKNOWN"], ASOF_MS, CONFIG, {
    quiet: true,
  });
  assert.equal(out.get(ID_A)?.status, "OK");
  const unknown = out.get("BITUNIX:UNKNOWN")!;
  assert.equal(unknown.status, "ABSTAIN");
  assert.equal(unknown.direction, null);
  assert.equal(unknown.confidence, 0);
  assert.ok(unknown.missing.every((m) => m.reason === "unavailable"));
});

test("fetchedAt nach asOf: später Backfill bleibt as-of-unsichtbar (PIT)", () => {
  const store = new HistoricalStore(dir);
  // Sync-Stand NACH dem Entscheidungszeitpunkt (später Backfill).
  seedStore(store, new Date(ASOF_MS + 3600_000));
  const snap = confluenceFromStore(store, ID_A, ASOF_MS, CONFIG, { quiet: true });
  assert.equal(snap.status, "ABSTAIN");
  assert.ok(snap.missing.every((m) => m.reason === "no-closed-bars"));
  assert.equal(snap.direction, null);
});

test("Retry/Restart: derselbe Stand erzeugt denselben Schlüssel (Idempotenz)", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));
  const first = confluenceFromStore(store, ID_A, ASOF_MS, CONFIG, { quiet: true });
  // Retry: Store erneut gelesen (ggf. nach Restart), identischer Stand.
  const second = confluenceFromStore(new HistoricalStore(dir), ID_A, ASOF_MS, CONFIG, {
    quiet: true,
  });
  assert.equal(second.snapshotKey, first.snapshotKey);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("Telemetrie: bounded Labels (result/source), keine Instrument-IDs", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));
  confluenceBatchFromStore(store, [ID_A, "BITUNIX:UNKNOWN"], ASOF_MS, CONFIG, { quiet: true });
  assert.equal(telemetry.confluence.runs.total(), 2);
  assert.deepEqual(telemetry.confluence.runs.byDimension("result"), { ok: 1, abstain: 1 });
  assert.deepEqual(telemetry.confluence.runs.byDimension("source"), { cycle: 2 });
  // Keine Instrument-ID darf je als Label auftauchen.
  const labels = JSON.stringify(telemetry.confluence.runs.byLabel());
  assert.ok(!labels.includes("BTCUSDT"));
  assert.ok(!labels.includes("UNKNOWN"));
});

test("Audit-Event confluence_computed: strukturiert, ohne Secrets/Payloads", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));
  confluenceBatchFromStore(store, [ID_A, "BITUNIX:UNKNOWN"], ASOF_MS, CONFIG);
  const events = logEntries.filter((e) => e.event === "confluence_computed");
  assert.equal(events.length, 2);
  const okEvent = events.find((e) => e.fields["status"] === "OK")!;
  assert.equal(okEvent.level, "info");
  assert.equal(okEvent.fields["instrumentId"], ID_A);
  assert.equal(okEvent.fields["formulaVersion"], "mtf-confluence@1");
  assert.ok(typeof okEvent.fields["snapshotKey"] === "string");
  const abstainEvent = events.find((e) => e.fields["status"] === "ABSTAIN")!;
  assert.equal(abstainEvent.level, "warn");
  // Keine Roh-Payloads, keine Secrets im Event (nur Zahlen, Codes, IDs).
  for (const e of events) {
    const blob = JSON.stringify(e.fields);
    assert.ok(!/sk-|bearer|token|secret|password/i.test(blob));
    assert.ok(blob.length < 2000);
  }
});

test("Roundtrip: Snapshot überlebt JSON-Serialisierung verlustfrei", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));
  const snap = confluenceFromStore(store, ID_A, ASOF_MS, CONFIG, { quiet: true });
  const roundtripped = JSON.parse(JSON.stringify(snap)) as typeof snap;
  assert.deepEqual(roundtripped, snap);
});

test("offene Bar im Store wird ausgeschlossen (HTF-Look-ahead-Guard, Store-Pfad)", () => {
  const store = new HistoricalStore(dir);
  seedStore(store, new Date(ASOF_MS - 60_000));
  // Offene 4h-Bar (öffnet zu asOf) mit Spike direkt in den Store.
  store.append(
    [
      {
        time: ASOF_MS,
        open: 5000,
        high: 6000,
        low: 4900,
        close: 5900,
        volume: 1,
      },
    ],
    ID_A,
    PROV,
    "4h",
    new Date(ASOF_MS - 1000),
  );
  const snap = confluenceFromStore(store, ID_A, ASOF_MS, CONFIG, { quiet: true });
  assert.equal(snap.status, "OK");
  const htf = snap.contributions.find((c) => c.timeframe === "4h")!;
  assert.equal(htf.barEndMs, ASOF_MS);
  assert.equal(htf.barsUsed, 30);
  assert.ok(snap.direction !== null && snap.direction > 0.5);
});

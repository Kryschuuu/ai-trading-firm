/**
 * Tests der Weekly-Klassifikation und der Artefakte (Task 04).
 *
 * Geprüft werden CORE/ROTATION/DISCOVERY/EXCLUDED, die Änderungssignale
 * (Neulisting, Delisting, Liquidität, Gebühren, Broker, Regime, Cluster),
 * das validierte JSON-Schema und die versionierten Tages-Snapshots.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_SCANNER_CONFIG, resolveScannerConfig } from "../src/scanner/config";
import { scanUniverse, type ScanDataProvider } from "../src/scanner/pipeline";
import {
  MAX_REASONS,
  UNIVERSE_CLASSES,
  WeeklyValidationError,
  classifyWeekly,
  validateWeeklyEntry,
  validateWeeklyReview,
  type WeeklyReview,
} from "../src/scanner/weekly";
import {
  ARTIFACT_DATE_RE,
  artifactDateOf,
  artifactMatchesConfig,
  buildDailyArtifact,
  latestArtifactDate,
  listArtifactDates,
  readDailyArtifact,
  readWeeklyArtifact,
  writeDailyArtifact,
  writeWeeklyArtifact,
} from "../src/scanner/artifacts";
import { AS_OF, candlesFromCloses, growthSeries, healthyCandles, instrument } from "./fixtures/scannerFixtures";
import type { MarketInstrument } from "../src/universe/types";

const config = DEFAULT_SCANNER_CONFIG;
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scanner-artifacts-"));
  dirs.push(dir);
  return dir;
}

const provider: ScanDataProvider = { candles: () => healthyCandles(90) };

function scanOf(instruments: MarketInstrument[], data: ScanDataProvider = provider) {
  return scanUniverse({ instruments, data, asOf: AS_OF, config });
}

/** Ein Instrument, das mühelos CORE-Kriterien erfüllt. */
function strong(symbol: string, overrides: Partial<MarketInstrument> = {}): MarketInstrument {
  return instrument({ symbol, volume24h: 5_000_000_000, spread: 0.0001, takerFee: 0.0002, ...overrides });
}

// ── Klassifikation ───────────────────────────────────────────────────────────

test("Weekly: Neuzugang wird DISCOVERY, etabliertes Instrument kann CORE werden", () => {
  const instruments = [strong("BTCUSDT")];
  const first = classifyWeekly({ scan: scanOf(instruments), instruments });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].class, "DISCOVERY");
  assert.ok(first.changes.newListings.includes("BINANCE:BTCUSDT"));
  assert.equal(first.context.persistence["BINANCE:BTCUSDT"], 1);

  const second = classifyWeekly({
    scan: scanOf(instruments),
    instruments,
    previous: first,
    previousInstruments: instruments,
  });
  assert.equal(second.entries[0].class, "CORE");
  assert.equal(second.context.persistence["BINANCE:BTCUSDT"], 2);
  assert.ok(second.entries[0].reasons.some((r) => r.startsWith("CORE:")));
});

test("Weekly: mittlerer Score ⇒ ROTATION, schwacher Score ⇒ EXCLUDED", () => {
  const instruments = [strong("BTCUSDT")];
  const previous = classifyWeekly({ scan: scanOf(instruments), instruments });

  const rotationCfg = resolveScannerConfig({ weekly: { coreMinScore: 99, rotationMinScore: 10, discoveryMinScore: 5 } });
  const rotation = classifyWeekly({
    scan: scanOf(instruments),
    instruments,
    previous,
    previousInstruments: instruments,
    config: rotationCfg,
  });
  assert.equal(rotation.entries[0].class, "ROTATION");

  const strictCfg = resolveScannerConfig({ weekly: { coreMinScore: 99, rotationMinScore: 99, discoveryMinScore: 99 } });
  const excluded = classifyWeekly({
    scan: scanOf(instruments),
    instruments,
    previous,
    previousInstruments: instruments,
    config: strictCfg,
  });
  assert.equal(excluded.entries[0].class, "EXCLUDED");
  assert.ok(excluded.entries[0].reasons[0].includes("Discovery-Schwelle"));
});

test("Weekly: durchgefallener Eignungsfilter ⇒ EXCLUDED mit Regel-Begründung", () => {
  const instruments = [instrument({ symbol: "JUNKUSDT", volume24h: 100 })];
  const review = classifyWeekly({ scan: scanOf(instruments), instruments });
  assert.equal(review.entries[0].class, "EXCLUDED");
  assert.match(review.entries[0].reasons[0], /Eignungsfilter min-volume/);
});

test("Weekly: Delisting, Broker-Verlust, Liquiditätsrückgang und Gebührenerhöhung werden erkannt", () => {
  const before = [
    strong("BTCUSDT"),
    strong("ETHUSDT"),
    strong("SOLUSDT"),
    strong("XRPUSDT"),
  ];
  const previous = classifyWeekly({ scan: scanOf(before), instruments: before });

  const after = [
    strong("BTCUSDT", { status: "delisted" }),
    strong("ETHUSDT", { paperAvailable: false }),
    strong("SOLUSDT", { volume24h: 100_000_000 }), // −98 % gegenüber 5 Mrd.
    strong("XRPUSDT", { takerFee: 0.0006 }), // +200 % gegenüber 2 bp
  ];
  const review = classifyWeekly({
    scan: scanOf(after),
    instruments: after,
    previous,
    previousInstruments: before,
  });

  assert.deepEqual(review.changes.delistings, ["BINANCE:BTCUSDT"]);
  assert.deepEqual(review.changes.brokerUnavailable, ["BINANCE:ETHUSDT"]);
  assert.deepEqual(review.changes.liquidityDrops, ["BINANCE:SOLUSDT"]);
  assert.deepEqual(review.changes.feeIncreases, ["BINANCE:XRPUSDT"]);
  const byId = new Map(review.entries.map((e) => [e.instrumentId, e]));
  assert.equal(byId.get("BINANCE:BTCUSDT")?.class, "EXCLUDED");
  assert.equal(byId.get("BINANCE:ETHUSDT")?.class, "EXCLUDED");
  // Liquiditätsrückgang/Gebührenerhöhung verhindern CORE, das Instrument bleibt aber handelbar.
  assert.notEqual(byId.get("BINANCE:SOLUSDT")?.class, "CORE");
  assert.notEqual(byId.get("BINANCE:XRPUSDT")?.class, "CORE");
});

test("Weekly: verschwundene Instrumente erscheinen als EXCLUDED-Delisting", () => {
  const before = [strong("BTCUSDT"), strong("ETHUSDT")];
  const previous = classifyWeekly({ scan: scanOf(before), instruments: before });
  const after = [strong("BTCUSDT")];
  const review = classifyWeekly({ scan: scanOf(after), instruments: after, previous, previousInstruments: before });
  const gone = review.entries.find((e) => e.instrumentId === "BINANCE:ETHUSDT");
  assert.equal(gone?.class, "EXCLUDED");
  assert.match(gone?.reasons[0] ?? "", /nicht mehr vorhanden/);
  assert.ok(review.changes.delistings.includes("BINANCE:ETHUSDT"));
});

test("Weekly: Regimewechsel und Korrelationscluster werden protokolliert", () => {
  const instruments = [strong("BTCUSDT")];
  const calm = candlesFromCloses(growthSeries(100, 1.0002, 90));
  const previous = classifyWeekly({
    scan: scanOf(instruments, { candles: () => calm }),
    instruments,
  });
  assert.equal(previous.context.regimeByInstrument["BINANCE:BTCUSDT"], "LOW");

  const active = healthyCandles(90);
  const review = classifyWeekly({
    scan: scanOf(instruments, { candles: () => active, benchmarkCandles: () => active }),
    instruments,
    previous,
    previousInstruments: instruments,
  });
  assert.ok(review.changes.regimeShifts.includes("BINANCE:BTCUSDT"));
  assert.ok(review.changes.correlationClusters.includes("BINANCE:BTCUSDT"));
  assert.ok(review.entries[0].reasons.some((r) => r.includes("Regimewechsel")));
  assert.ok(review.entries[0].reasons.some((r) => r.includes("Korrelationscluster")));
});

test("Weekly: Zusammenfassung zählt jede Klasse, Einträge sind stabil sortiert", () => {
  const instruments = [strong("ZZZUSDT"), strong("AAAUSDT"), instrument({ symbol: "JUNKUSDT", volume24h: 5 })];
  const review = classifyWeekly({ scan: scanOf(instruments), instruments });
  assert.deepEqual(
    review.entries.map((e) => e.instrumentId),
    ["BINANCE:AAAUSDT", "BINANCE:JUNKUSDT", "BINANCE:ZZZUSDT"]
  );
  const total = UNIVERSE_CLASSES.reduce((a, c) => a + review.summary[c], 0);
  assert.equal(total, review.entries.length);
});

// ── JSON-Validierung ─────────────────────────────────────────────────────────

test("Weekly: jeder erzeugte Eintrag hält den validierten JSON-Contract ein", () => {
  const instruments = [strong("BTCUSDT"), instrument({ symbol: "JUNKUSDT", volume24h: 5 })];
  const review = classifyWeekly({ scan: scanOf(instruments), instruments });
  for (const entry of review.entries) {
    const validated = validateWeeklyEntry(JSON.parse(JSON.stringify(entry)));
    assert.deepEqual(validated, entry);
    assert.deepEqual(Object.keys(entry).sort(), ["asOf", "class", "instrumentId", "reasons", "score"]);
    assert.ok(entry.reasons.length <= MAX_REASONS);
  }
  const roundTrip = validateWeeklyReview(JSON.parse(JSON.stringify(review)));
  assert.deepEqual(roundTrip.summary, review.summary);
});

test("Weekly: kaputte Einträge werden abgelehnt, nicht repariert", () => {
  const valid = { instrumentId: "BINANCE:BTCUSDT", class: "CORE", reasons: ["ok"], score: 50, asOf: AS_OF };
  assert.doesNotThrow(() => validateWeeklyEntry(valid));
  assert.throws(() => validateWeeklyEntry({ ...valid, instrumentId: "kaputt" }), WeeklyValidationError);
  assert.throws(() => validateWeeklyEntry({ ...valid, class: "VIP" }), /class/);
  assert.throws(() => validateWeeklyEntry({ ...valid, reasons: [] }), /reasons/);
  assert.throws(() => validateWeeklyEntry({ ...valid, reasons: [123] }), /reasons\[0\]/);
  assert.throws(() => validateWeeklyEntry({ ...valid, score: 101 }), /score/);
  assert.throws(() => validateWeeklyEntry({ ...valid, score: Number.NaN }), /score/);
  assert.throws(() => validateWeeklyEntry({ ...valid, asOf: "irgendwann" }), /asOf/);
  assert.throws(() => validateWeeklyEntry({ ...valid, extra: true }), /unbekanntes Feld/);
  assert.throws(() => validateWeeklyEntry(null), /kein Objekt/);
  assert.throws(() => validateWeeklyReview({ entries: "nein" }), /entries/);
});

// ── Artefakte ────────────────────────────────────────────────────────────────

test("Artefakte: Tages-Snapshot landet in artifacts/YYYY-MM-DD/universe.json", () => {
  const dir = tempDir();
  const instruments = [strong("BTCUSDT"), strong("ETHUSDT")];
  const scan = scanOf(instruments);
  const { path: file, artifact } = writeDailyArtifact(scan, { dir });

  assert.ok(file.endsWith(path.join("2026-08-27", "universe.json")));
  assert.ok(existsSync(file));
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.configVersion, config.version);
  assert.deepEqual(artifact.weights, config.weights);
  assert.equal(artifact.funnel.scanned, 2);
  assert.equal(artifact.levels.daily.length, 2);
  assert.ok(artifact.levels.daily[0].breakdown, "Daily-Ebene enthält Score-Breakdowns");
  assert.equal(artifact.levels.interesting[0].breakdown, undefined);
  assert.deepEqual(artifact.levels.eligible, ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"].sort());
  assert.ok(ARTIFACT_DATE_RE.test(artifactDateOf(scan.asOf)));
  assert.ok(artifactMatchesConfig(artifact, config));
});

test("Artefakte: zweimal schreiben ⇒ byte-identische Datei (Determinismus)", () => {
  const dir = tempDir();
  const instruments = [strong("BTCUSDT"), strong("ETHUSDT"), strong("SOLUSDT")];
  const a = writeDailyArtifact(scanOf(instruments), { dir });
  const first = readFileSync(a.path, "utf8");
  const b = writeDailyArtifact(scanOf(instruments), { dir });
  assert.equal(readFileSync(b.path, "utf8"), first);
  assert.deepEqual(buildDailyArtifact(scanOf(instruments)), a.artifact);
});

test("Artefakte: Weekly-Review wird geschrieben, gelesen und validiert", () => {
  const dir = tempDir();
  const instruments = [strong("BTCUSDT")];
  const review = classifyWeekly({ scan: scanOf(instruments), instruments });
  const { path: file } = writeWeeklyArtifact(review, { dir });
  assert.ok(file.endsWith(path.join("2026-08-27", "weekly.json")));

  const loaded = readWeeklyArtifact("2026-08-27", dir) as WeeklyReview;
  assert.deepEqual(loaded.entries, review.entries);
  assert.deepEqual(listArtifactDates(dir), ["2026-08-27"]);
  assert.equal(latestArtifactDate(dir), "2026-08-27");
  assert.equal(readDailyArtifact("2026-08-27", dir), null);
  assert.equal(readWeeklyArtifact("2020-01-01", dir), null);
});

test("Artefakte: Pfadangriffe über das Datum werden abgewiesen", () => {
  const dir = tempDir();
  const scan = scanOf([strong("BTCUSDT")]);
  assert.throws(() => writeDailyArtifact(scan, { dir, date: "../../etc" }), /Artefakt-Datum ungültig/);
  assert.throws(() => readDailyArtifact("..", dir), /Artefakt-Datum ungültig/);
  assert.throws(() => artifactDateOf("kein-datum"), /ungültiger Zeitstempel/);
  assert.deepEqual(listArtifactDates(path.join(dir, "gibtesnicht")), []);
  assert.equal(latestArtifactDate(path.join(dir, "gibtesnicht")), null);
});

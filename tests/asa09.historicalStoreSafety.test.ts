/**
 * ASA-09 — Safety-Regressionen für den partitionierten Historical Store.
 *
 * Der Befund (docs/audits/2026-10-27-arch-security-audit/findings/
 * ASA-09-historical-store-oom-utf8-lost-update.md) beschreibt vier Defekte:
 *
 *   1. UTF-8-Zeichenspaltung an 1-MiB-Chunk-Grenzen in `readLinesSync`.
 *   2. V8-`RangeError: Invalid string length` durch Gesamtstring-Konkatenation
 *      in der Schreibroutine (+ Temp-File-Kollisionen).
 *   3. Cross-Prozess-Lost-Updates: Read-Modify-Write ohne Dateisperre.
 *   4. Monolithischer Voll-Scan `candles.ndjson` bei jedem `query()`/`ingest()`.
 *
 * Diese Suite nagt die Remediation fest:
 *   - StringDecoder-Rekonstruktion über beliebige Chunk-Grenzen (auch 17 Byte),
 *   - partitionierte Serien-Dateien mit bijektiver, traversal-freier Kodierung,
 *   - verlustfreie automatische Legacy-Migration unter Lock,
 *   - Cross-Instanz-/Cross-Prozess-Schreibschutz (.store.lock) ohne Lost Updates,
 *   - kollisionsfreie Temp-Namen mit Fehler-Cleanup.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HistoricalStore,
  HistoricalStoreError,
  HISTORY_SCHEMA_VERSION,
  READ_CHUNK_BYTES,
  SERIES_DIR_NAME,
  readLinesSync,
  seriesFileName,
  parseSeriesFileName,
} from "../src/lib/marketdata/historicalStore";
import type { MarketCandle } from "../src/lib/marketdata/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "asa09-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(opts: { maxBarsPerSeries?: number; lockTimeoutMs?: number } = {}): HistoricalStore {
  return new HistoricalStore(dir, opts);
}

function candle(time: number, close = 100): MarketCandle {
  return { time, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1000 };
}

const NOW = new Date("2026-10-29T00:00:00.000Z");
const PROV = { venue: "BITUNIX", feed: "BITUNIX:rest" };

function listFilesRecursively(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// ── 1. UTF-8-Chunk-Grenzen (StringDecoder) ──────────────────────────────────

test("ASA-09: readLinesSync rekonstruiert Multi-Byte-UTF-8 an 17-Byte-Grenzen verlustfrei", () => {
  const file = path.join(dir, "utf8-small-chunks.ndjson");
  // 2-Byte (é), 3-Byte (€, ₿) und 4-Byte-Zeichen (𝕏, 😀) dicht gepackt —
  // mit 17-Byte-Blöcken fallen die Grenzen mit Sicherheit IN die Sequenzen.
  const lines = [
    '{"venue":"Kräutsche-€","feed":"feed:₿-𝕏"}',
    '{"venue":"😀déjà-€𝕏","feed":"münchen-₿"}',
    '{"venue":"Ω-消息-🙂","feed":"ok"}',
  ];
  const body = lines.join("\n") + "\n";
  writeFileSync(file, body, "utf8");

  const got = readLinesSync(file, 17);
  assert.equal(got.length, lines.length, "Zeilenanzahl unverändert");
  assert.equal(got.join("\n") + "\n", body, "100 % byte-identischer Roundtrip");
  assert.equal(got.join("").includes("\uFFFD"), false, "kein einziges U+FFFD-Ersetzungszeichen");

  // Auch mit absichtlich unsinnigen Mini-Chunks (1/2/3 Bytes) bleibt der
  // Inhalt exakt — der Decoder puffert Teil-Sequenzen zwischen den Blöcken.
  for (const chunkSize of [1, 2, 3, 5, 16]) {
    const again = readLinesSync(file, chunkSize);
    assert.equal(again.join("\n") + "\n", body, `Roundtrip mit chunkSizeBytes=${chunkSize}`);
    assert.equal(again.join("").includes("\uFFFD"), false, `kein U+FFFD mit chunkSizeBytes=${chunkSize}`);
  }
});

test("ASA-09: ein Multi-Byte-Zeichen exakt auf der 1-MiB-Grenze wird nicht zerschnitten", () => {
  const file = path.join(dir, "utf8-mib-boundary.ndjson");
  // Der 4-Byte-Emoji beginnt 2 Bytes VOR der Chunk-Grenze: Chunk 0 endet
  // mitten im Zeichen (der frühere isolierte `toString("utf8")` erzeugte an
  // dieser Stelle ein U+FFFD und einen verschobenen Rest).
  const head = Buffer.alloc(READ_CHUNK_BYTES - 2, 0x61); // "a" …
  const splitChar = Buffer.from("𝕏", "utf8"); // F0 9D 95 8F (4 Bytes)
  const tail = Buffer.from("ende\n", "utf8");
  writeFileSync(file, Buffer.concat([head, splitChar, tail]));

  const lines = readLinesSync(file); // Default-Chunk = READ_CHUNK_BYTES (1 MiB)
  assert.equal(lines.length, 1);
  const expected = "a".repeat(READ_CHUNK_BYTES - 2) + "𝕏ende";
  assert.equal(lines[0], expected, "Zeichen über der 1-MiB-Grenze exakt rekonstruiert");
  assert.equal(lines[0].includes("\uFFFD"), false, "kein U+FFFD an der echten Chunk-Grenze");
});

test("ASA-09: Store-Roundtrip erhält Multi-Byte-Provenienz-Felder zeichengenau", () => {
  const store = makeStore();
  const venue = "Kräutsche-€𝕏";
  const feed = "feed:₿-消息-😀";
  store.append([candle(1_700_000_000_000, 42)], "TEST:PAÏRE₿", { venue, feed }, "1h", NOW);
  const [entry] = store.query({ instrumentId: "TEST:PAÏRE₿", timeframe: "1h" });
  assert.equal(entry.venue, venue);
  assert.equal(entry.feed, feed);
  assert.equal(entry.close, 42);
});

// ── 2. Partitionierung: ein Query berührt nur seine Serie ───────────────────

test("ASA-09: query() bei 20 Serien liest ausschließlich die angefragte Partition", () => {
  const store = makeStore();
  const target = { instrumentId: "BINANCE:BTCUSDT", timeframe: "1m" as const };
  const targetCandles = Array.from({ length: 50 }, (_, i) => candle(1_700_000_000_000 + i * 60_000, 100 + i));
  store.append(targetCandles, target.instrumentId, PROV, target.timeframe, NOW);

  // 19 weitere Serien, inklusive Sonderzeichen-IDs (Bijektion/Kodierung).
  const others: Array<[string, "5m" | "15m" | "1h"]> = [
    ["KRAKEN:BTC/USD", "1h"],
    ["IBKR:EUR.USD", "5m"],
    ["TEST:Ünïcode₿", "15m"],
    ["PAPER:A__B", "1h"],
    ["VENUE:SY-01", "5m"],
  ];
  let made = 5;
  for (let i = 0; made < 19; i++) {
    others.push([`SYNTH:SYMBOL${i}`, i % 2 === 0 ? "1h" : "5m"]);
    made++;
  }
  for (const [instrumentId, timeframe] of others) {
    store.append([candle(1_700_000_000_000, 7)], instrumentId, PROV, timeframe, NOW);
  }
  assert.equal(store.listSeries().length, 20, "20 partitionierte Serien");

  // Andere Partitionen vergiften: ungültiges JSON + ungültiges UTF-8. Jeder
  // versehentliche Lese-/Parse-Zugriff würde console.warn auslösen.
  for (const [instrumentId, timeframe] of others) {
    appendFileSync(store.seriesFilePath(instrumentId, timeframe), Buffer.concat([Buffer.from([0xff]), Buffer.from(" {KAPUTT\n")]));
  }

  const before = store.query({ instrumentId: target.instrumentId, timeframe: target.timeframe });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: unknown) => warnings.push(String(m));
  let after: ReturnType<HistoricalStore["query"]>;
  try {
    after = store.query({ instrumentId: target.instrumentId, timeframe: target.timeframe });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0, `query() darf andere Partitionen nicht lesen (warnte ${warnings.length}×)`);
  assert.deepEqual(
    after.map((e) => [e.ts, e.close]),
    before.map((e) => [e.ts, e.close]),
    "identisches Ergebnis wie vor der Vergiftung",
  );
  assert.equal(after.length, 50);

  // Gegenprobe: readAll() liest bewusst alle Serien → die Vergiftung fällt auf.
  const readAllWarnings: string[] = [];
  console.warn = (m: unknown) => readAllWarnings.push(String(m));
  try {
    assert.equal(store.readAll().length, 50 + 19);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(readAllWarnings.length >= 19, "readAll() liest (erwartungsgemäß) alle Partitionen");

  // Genau eine Datei je Serie, kanonisch kodiert, traversal-frei.
  const files = readdirSync(path.join(dir, SERIES_DIR_NAME)).sort();
  assert.equal(files.length, 20);
  assert.equal(files.includes("BINANCE%3ABTCUSDT__1m.ndjson"), true, 'Doppelpunkt wird zu %3A');
  for (const f of files) {
    assert.match(f, /^[A-Za-z0-9._%_-]+__\d*[mhd]\.ndjson$/, `Dateiname ${f} ist kodiert und traversal-frei`);
    assert.equal(f.includes("/"), false);
  }
});

test("ASA-09: Serien-Dateinamen sind bijektiv und traversal-frei (inkl. Sonderfälle)", () => {
  const cases = [
    "BITUNIX:BTCUSDT",
    "KRAKEN:BTC/USD",
    "IBKR:EUR.USD",
    "A__B", // Doppel-Underscore im Namen
    "100%",
    "Ünïcode₿-消息",
    "..",
    "a-b.c_d",
    "TRAILING_",
    "space name",
  ];
  for (const id of cases) {
    const name = seriesFileName(id, "1h");
    assert.doesNotMatch(name, /[/:\\]/, `kein Pfad-Trenner in ${name}`);
    assert.equal(name.endsWith("__1h.ndjson"), true);
    const parsed = parseSeriesFileName(name);
    assert.deepEqual(parsed, { instrumentId: id, timeframe: "1h" }, `Bijektion für ${id}`);
  }
  // Fremde/nicht-kanonische Dateien werden erkannt und übersprungen.
  assert.equal(parseSeriesFileName("README.md"), null);
  assert.equal(parseSeriesFileName("%5F%5F__1h.ndjson"), null, "nicht-kanonische Kodierung wird abgewiesen");
  assert.equal(parseSeriesFileName("9x__99x.ndjson"), null, "unbekannter Timeframe wird abgewiesen");
  assert.deepEqual(parseSeriesFileName("9x__1h.ndjson"), { instrumentId: "9x", timeframe: "1h" });
});

// ── 3. Legacy-Migration: verlustfrei, unter Lock, einmalig ──────────────────

function legacyFixture(): { body: string; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [
    {
      v: HISTORY_SCHEMA_VERSION,
      instrumentId: "BITUNIX:BTCUSDT",
      venue: "BITUNIX",
      feed: "BITUNIX:rest",
      timeframe: "1h",
      ts: 1_700_000_000_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1,
      fetchedAt: "2026-08-29T00:00:00.000Z",
    },
    {
      v: HISTORY_SCHEMA_VERSION,
      instrumentId: "BITUNIX:BTCUSDT",
      venue: "BITUNIX",
      feed: "BITUNIX:rest",
      timeframe: "5m",
      ts: 1_700_000_000_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.25,
      volume: 2,
      fetchedAt: "2026-08-29T00:00:00.000Z",
    },
    {
      v: HISTORY_SCHEMA_VERSION,
      instrumentId: "KRAKEN:BTC/USD",
      venue: "KRAKEN",
      feed: "KRAKEN:ws",
      timeframe: "1h",
      ts: 1_700_000_000_000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 3,
      fetchedAt: "2026-08-29T00:00:00.000Z",
    },
    {
      // v1-Legacy-Zeile ohne timeframe — bleibt im Backup erhalten.
      instrumentId: "BITUNIX:OLDSYMBOL",
      venue: "BITUNIX",
      feed: "old",
      ts: 1_700_000_000_000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 9,
      fetchedAt: "2025-01-01T00:00:00.000Z",
    },
  ];
  return { body: rows.map((r) => JSON.stringify(r)).join("\n") + "\n", rows };
}

test("ASA-09: vorhandene candles.ndjson wird vollständig, verlustfrei und einmalig migriert", () => {
  const { body, rows } = legacyFixture();
  mkdirSync(dir, { recursive: true });
  // Der alte Store schrieb candles.ndjson mit Modus 0600 — das Backup (rename)
  // erhält diesen Modus.
  writeFileSync(path.join(dir, "candles.ndjson"), body, { encoding: "utf8", mode: 0o600 });

  const store = makeStore();
  // Erster Zugriff: query liefert ALLE v2-Zeilen verlustfrei unter ihrer Serie.
  const btc1h = store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" });
  assert.equal(btc1h.length, 1);
  assert.equal(btc1h[0].close, 100.5);
  assert.equal(btc1h[0].fetchedAt, "2026-08-29T00:00:00.000Z");
  assert.equal(store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "5m" }).length, 1);
  assert.equal(store.query({ instrumentId: "KRAKEN:BTC/USD", timeframe: "1h" }).length, 1);
  assert.equal(store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "15m" }).length, 0);

  // Verlustfrei: die v2-Zeilen liegen in den Partitionen, ALLE Original-Bytes
  // (inkl. der Legacy-Zeile) in dem umbenannten Backup.
  assert.equal(existsSync(path.join(dir, "candles.ndjson")), false, "Legacy-Datei ist migriert/umbenannt");
  const dirEntries = readdirSync(dir);
  const backups = dirEntries.filter((f) => f.startsWith("candles.ndjson.migrated-"));
  assert.equal(backups.length, 1, "genau ein Backup");
  assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), body, "Backup ist byte-identisch zum Original");
  const backupMode = statSync(path.join(dir, backups[0])).mode & 0o777;
  assert.ok(backupMode <= 0o600, `Backup bleibt restriktiv (${backupMode.toString(8)})`);

  // Legacy-Zeile wird nie als Bar ausgeliefert.
  assert.equal(store.readAll().some((e) => e.instrumentId === "BITUNIX:OLDSYMBOL"), false);
  assert.equal(store.listSeries().length, 3);

  // Idempotenz: zweite Instanz migriert NICHT erneut, Daten unverändert.
  const second = new HistoricalStore(dir);
  assert.equal(second.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" }).length, 1);
  assert.equal(second.stats().series, 3);
  assert.equal(
    readdirSync(dir).filter((f) => f.startsWith("candles.ndjson.migrated-")).length,
    1,
    "keine erneute Migration",
  );
  assert.equal(rows.length, 4, "Fixture unverändert (Sanity)");
});

test("ASA-09: Migration dedupliziert deterministisch gegen bestehende Partitionen", () => {
  const { body } = legacyFixture();
  mkdirSync(dir, { recursive: true });
  // Erster Lauf: Store existiert bereits mit einer Serie (frischere fetchedAt).
  const store = makeStore();
  store.append(
    [candle(1_700_000_000_000, 555)],
    "BITUNIX:BTCUSDT",
    PROV,
    "1h",
    new Date("2026-09-15T00:00:00.000Z"), // jünger als die Legacy-fetchedAt
  );
  // Danach taucht die Legacy-Datei auf (z. B. Restore aus Backup).
  writeFileSync(path.join(dir, "candles.ndjson"), body, "utf8");

  const got = store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" });
  assert.equal(got.length, 1, "Duplikat-Schlüssel (instrument+tf+ts) bleibt singular");
  assert.equal(got[0].close, 555, "jüngeres fetchedAt gewinnt");
  assert.equal(store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "5m" }).length, 1);
  assert.equal(store.query({ instrumentId: "KRAKEN:BTC/USD", timeframe: "1h" }).length, 1);
});

// ── 4. Zwei Store-Instanzen, verschachtelte Ingests, keine Lost Updates ─────

test("ASA-09: verschachtelte ingest()-Aufrufe zweier Instanzen auf einem Verzeichnis verlieren keine Kerzen", () => {
  const storeA = makeStore();
  const storeB = new HistoricalStore(dir);

  // (a) dieselbe Serie, interleaved: gerade ts via A, ungerade via B.
  for (let i = 0; i < 20; i++) {
    const store = i % 2 === 0 ? storeA : storeB;
    const written = store.append([candle(1_700_000_000_000 + i * 3_600_000, 100 + i)], "BITUNIX:BTCUSDT", PROV, "1h", NOW);
    assert.equal(written.written, 1, `Bar ${i} von Instanz ${i % 2 === 0 ? "A" : "B"} geschrieben`);
  }
  const merged = storeA.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" });
  assert.equal(merged.length, 20, "keine Kerze verloren (kein Lost Update)");
  assert.deepEqual(
    merged.map((e) => e.close),
    Array.from({ length: 20 }, (_, i) => 100 + i),
    "beide Instanzen tragen dieselbe Serie konsistent zusammen",
  );

  // (b) verschiedene Serien im selben Takt (wie Sync-CLI vs. Web-Server).
  const rA = storeA.appendSeries(
    [{ candles: [candle(1_700_010_000_000, 101)], instrumentId: "A:SERIE", provenance: PROV, timeframe: "1h" }],
    NOW,
  );
  const rB = storeB.appendSeries(
    [
      { candles: [candle(1_700_020_000_000, 102)], instrumentId: "B:SERIE", provenance: PROV, timeframe: "1h" },
      { candles: [candle(1_700_021_000_000, 103)], instrumentId: "B:SERIE", provenance: PROV, timeframe: "1h" },
    ],
    NOW,
  );
  assert.equal(rA.written, 1);
  assert.equal(rB.written, 2);
  assert.equal(storeB.query({ instrumentId: "A:SERIE", timeframe: "1h" }).length, 1);
  assert.equal(storeA.query({ instrumentId: "B:SERIE", timeframe: "1h" }).length, 2);

  // (c) Duplikat-Kollision über Instanzgrenzen: jüngstes fetchedAt gewinnt.
  storeA.append([candle(1_700_030_000_000, 111)], "BITUNIX:ETHUSDT", PROV, "1h", new Date("2026-10-01T00:00:00.000Z"));
  storeB.append([candle(1_700_030_000_000, 222)], "BITUNIX:ETHUSDT", PROV, "1h", new Date("2026-10-20T00:00:00.000Z"));
  const [eth] = storeA.query({ instrumentId: "BITUNIX:ETHUSDT", timeframe: "1h" });
  assert.equal(eth.close, 222, "Deduplizierung über Instanzgrenzen: jüngere Version siegt");
  assert.equal(storeA.count("BITUNIX:ETHUSDT", "1h"), 1);
});

test("ASA-09: belegte Sperre führt zu LOCK_TIMEOUT (kein stilles Overwrite), stale Sperren werden aufgeräumt", () => {
  const store = makeStore({ lockTimeoutMs: 150 });

  // (a) Lebende fremde "Sperre" (eigene PID = lebend) → fail-closed.
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, ".store.lock"),
    JSON.stringify({ pid: process.pid, heldAtMs: Date.now() }) + "\n",
    "utf8",
  );
  assert.throws(
    () => store.append([candle(1, 1)], "BITUNIX:BTCUSDT", PROV, "1h", NOW),
    (e: unknown) => e instanceof HistoricalStoreError && (e as HistoricalStoreError).code === "LOCK_TIMEOUT",
    "belegte Sperre darf nicht still übergangen werden",
  );
  rmSync(path.join(dir, ".store.lock"), { force: true });

  // (b) Stale Sperre eines toten Prozesses → automatisch aufgeräumt.
  const dead = spawnSync("true");
  const deadPid = dead.pid ?? -1;
  writeFileSync(
    path.join(dir, ".store.lock"),
    JSON.stringify({ pid: deadPid, heldAtMs: Date.now() }) + "\n",
    "utf8",
  );
  const written = store.append([candle(1_700_000_000_000, 9)], "BITUNIX:BTCUSDT", PROV, "1h", NOW);
  assert.equal(written.written, 1, "tote Sperre wird übernommen");
  assert.equal(existsSync(path.join(dir, ".store.lock")), false, "Sperre nach dem Schreiben freigegeben");

  // (c) Stale Sperre allein über Alter (mtime 20 s zurück) → aufgeräumt.
  const lockPath = path.join(dir, ".store.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heldAtMs: Date.now() - 20_000 }) + "\n", "utf8");
  utimesSync(lockPath, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  const again = store.append([candle(1_700_003_600_000, 10)], "BITUNIX:BTCUSDT", PROV, "1h", NOW);
  assert.equal(again.written, 1, "abgelaufene Sperre wird übernommen");
  assert.equal(store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" }).length, 2);
});

// ── 5. Temp-Datei-Hygiene & atomares Schreiben ──────────────────────────────

test("ASA-09: keine .tmp-Reste nach normalen Läufen; Fehlerfall räumt die Temp-Datei weg", () => {
  const store = makeStore();
  store.appendSeries(
    [
      { candles: Array.from({ length: 300 }, (_, i) => candle(1_700_000_000_000 + i * 60_000, 1 + i)), instrumentId: "BINANCE:BTCUSDT", provenance: PROV, timeframe: "1m" },
      { candles: [candle(1_700_000_000_000, 5)], instrumentId: "KRAKEN:BTC/USD", provenance: PROV, timeframe: "1h" },
    ],
    NOW,
  );
  const leftovers = listFilesRecursively(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "keine Temp-Dateien nach erfolgreichem Schreiben");

  // Fehlerfall: Partitions-Ziel ist ein Verzeichnis → rename schlägt fehl,
  // die erzeugte Temp-Datei wird im catch entfernt.
  const blocked = path.join(dir, SERIES_DIR_NAME, seriesFileName("BLOCK:SERIE", "1h"));
  mkdirSync(blocked, { recursive: true });
  assert.throws(() => {
    store.append([candle(1_700_000_000_000, 3)], "BLOCK:SERIE", PROV, "1h", NOW);
  }, /EISDIR|ENOTEMPTY|ENOTDIR/);
  const afterError = listFilesRecursively(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(afterError, [], "Fehlerfall entfernt die Temp-Datei (kein Müll, keine Kollisionen)");

  // Temp-Namen sind kollisionsfrei: zwei aufeinanderfolgende Writes auf
  // dieselbe Serie erzeugen nacheinander jeweils genau eine Datei.
  store.append([candle(1_700_003_600_000, 7)], "BLOCK-FREE:SERIE", PROV, "1h", NOW);
  store.append([candle(1_700_007_200_000, 8)], "BLOCK-FREE:SERIE", PROV, "1h", NOW);
  assert.equal(store.query({ instrumentId: "BLOCK-FREE:SERIE", timeframe: "1h" }).length, 2);
});

test("ASA-09: Schreiben bleibt auch bei großen Batches gebündelt (kein Gesamtstring)", () => {
  const store = makeStore();
  const big = Array.from({ length: 20_000 }, (_, i) => candle(1_700_000_000_000 + i * 60_000, 100 + (i % 97)));
  const r = store.append(big, "BENCH:BIGSERIES", PROV, "1m", NOW);
  assert.equal(r.written, 20_000);
  const file = store.seriesFilePath("BENCH:BIGSERIES", "1m");
  const lines = readLinesSync(file);
  assert.equal(lines.length, 20_000, "alle Bars persistiert");
  assert.equal(lines[0].startsWith(`{"v":${HISTORY_SCHEMA_VERSION},`), true, "v2-Zeilenformat");
  // Datei ist aufsteigend nach ts sortiert (Vertrag der Partition).
  const first = JSON.parse(lines[0]) as { ts: number };
  const last = JSON.parse(lines[lines.length - 1]) as { ts: number };
  assert.ok(first.ts < last.ts);
  assert.equal(store.query({ instrumentId: "BENCH:BIGSERIES", timeframe: "1m", limit: 5 }).length, 5);
});

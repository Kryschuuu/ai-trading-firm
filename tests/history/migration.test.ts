/**
 * Tests der Historien-Migration v1 → v2 (Timeframe-Dimension).
 *
 * Deckt ab: timeframe wird zugewiesen, Idempotenz, Pflicht-Flag
 * `--assume-timeframe`, Backup vor dem Schreiben, --dry-run ohne
 * Dateiänderung (Hash), und die Verlust-Invariante
 *   gelesen == geschrieben + dedupliziert + verworfen.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateHistoryFile, formatMigrationReport } from "../../src/history/migration";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "history-migrate-"));
  file = path.join(dir, "candles.ndjson");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Eine v1-Zeile (ohne timeframe / v). */
function v1Line(instrumentId: string, ts: number, fetchedAt: string, close = 100): string {
  return JSON.stringify({
    instrumentId,
    venue: "BITUNIX",
    feed: "BITUNIX:rest",
    ts,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
    fetchedAt,
  });
}

function sha256(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

test("migration adds timeframe to legacy rows", () => {
  const body = [v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z"), v1Line("BITUNIX:ETHUSDT", 1_700_003_600_000, "2026-08-01T00:00:00.000Z")].join("\n") + "\n";
  writeFileSync(file, body, "utf8");

  const report = migrateHistoryFile({ file, assumeTimeframe: "15m" });
  assert.equal(report.migrated, 2);
  assert.equal(report.read, 2);
  assert.equal(report.written, 2);

  const store = new HistoricalStore(dir);
  // Nach der Migration sind die Bars unter dem angenommenen Timeframe lesbar.
  assert.equal(store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "15m" }).length, 1);
  assert.equal(store.query({ instrumentId: "BITUNIX:ETHUSDT", timeframe: "15m" }).length, 1);
  // Und es gibt keine Legacy-Warnung mehr (alle Zeilen v2).
  assert.equal(store.loadAll().stats.legacy, 0);
});

test("migration is idempotent: second run changes nothing", () => {
  writeFileSync(file, v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z") + "\n", "utf8");

  const first = migrateHistoryFile({ file, assumeTimeframe: "15m" });
  assert.equal(first.migrated, 1);
  const hashAfterFirst = sha256(file);

  const second = migrateHistoryFile({ file, assumeTimeframe: "15m" });
  assert.equal(second.migrated, 0, "keine Zeile mehr zu migrieren");
  assert.equal(second.alreadyVersioned, 1);
  assert.equal(second.deduplicated, 0);
  assert.equal(sha256(file), hashAfterFirst, "Dateiinhalt nach zweitem Lauf identisch");
});

test("migration refuses to run without --assume-timeframe when legacy rows exist", () => {
  writeFileSync(file, v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z") + "\n", "utf8");
  const before = sha256(file);

  assert.throws(
    () => migrateHistoryFile({ file }),
    /--assume-timeframe fehlt/,
  );
  // Original bleibt unverändert.
  assert.equal(sha256(file), before);
});

test("migration creates a backup before writing", () => {
  writeFileSync(file, v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z") + "\n", "utf8");
  const originalContent = readFileSync(file, "utf8");

  const report = migrateHistoryFile({ file, assumeTimeframe: "15m" });
  assert.ok(report.backupPath, "Backup-Pfad gemeldet");
  assert.ok(report.backupPath && report.backupPath.includes("candles.ndjson.bak-"));
  // Backup enthält den Originalinhalt.
  assert.equal(readFileSync(report.backupPath!, "utf8"), originalContent);
  // Backup restriktive Rechte (0600).
  const mode = statSync(report.backupPath!).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("migration --dry-run does not modify the file (hash stable) and creates no backup", () => {
  writeFileSync(file, v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z") + "\n", "utf8");
  const hashBefore = sha256(file);

  const report = migrateHistoryFile({ file, assumeTimeframe: "15m", dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.read, 1);
  assert.equal(report.migrated, 1);
  assert.equal(report.backupPath, null);
  assert.equal(sha256(file), hashBefore, "dry-run verändert die Datei nicht");
  const backups = readdirSync(dir).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 0, "kein Backup im dry-run");
});

test("no bar is lost: input count == output count + deduplicated + rejected", () => {
  const lines = [
    v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z"),
    v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-02T00:00:00.000Z"), // Duplikat-Schlüssel, neuer fetchedAt
    v1Line("BITUNIX:ETHUSDT", 1_700_003_600_000, "2026-08-01T00:00:00.000Z"),
    "{ kaputte zeile ",
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");

  const report = migrateHistoryFile({ file, assumeTimeframe: "15m" });
  assert.equal(report.read, 4);
  assert.equal(report.deduplicated, 1, "ein Duplikat entfernt");
  assert.equal(report.rejected.length, 1, "eine kaputte Zeile verworfen");
  assert.equal(report.written, 2, "zwei eindeutige Bars geschrieben");
  assert.equal(report.written + report.deduplicated + report.rejected.length, report.read);
});

test("migration deduplicates newest fetchedAt wins and sorts deterministically", () => {
  const lines = [
    v1Line("BITUNIX:ETHUSDT", 1_700_003_600_000, "2026-08-01T00:00:00.000Z", 200),
    v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z", 100),
    v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-20T00:00:00.000Z", 999), // gewinnt
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");

  migrateHistoryFile({ file, assumeTimeframe: "1h" });
  const store = new HistoricalStore(dir);
  const btc = store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" });
  assert.equal(btc.length, 1);
  assert.equal(btc[0].close, 999, "jüngstes fetchedAt gewinnt");

  // Sortierung instrumentId, timeframe, ts in der geschriebenen Datei.
  const raw = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(raw[0].instrumentId <= raw[1].instrumentId, "sortiert nach instrumentId");
});

test("already-versioned rows pass through and mixed files migrate only legacy rows", () => {
  const store = new HistoricalStore(dir);
  store.append(
    [{ time: 1_700_000_000_000, open: 50, high: 51, low: 49, close: 50.5, volume: 5 }],
    "BITUNIX:BTCUSDT",
    { venue: "BITUNIX", feed: "rest" },
    "5m",
    new Date("2026-08-21T00:00:00.000Z"),
  );
  // Legacy-Zeile dazuschreiben.
  appendFileSync(file, v1Line("BITUNIX:ETHUSDT", 1_700_003_600_000, "2026-08-01T00:00:00.000Z") + "\n", "utf8");

  const report = migrateHistoryFile({ file, assumeTimeframe: "15m" });
  assert.equal(report.alreadyVersioned, 1);
  assert.equal(report.migrated, 1);

  const after = new HistoricalStore(dir);
  assert.equal(after.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "5m" }).length, 1);
  assert.equal(after.query({ instrumentId: "BITUNIX:ETHUSDT", timeframe: "15m" }).length, 1);
});

test("report formatting includes counters and backup path", () => {
  writeFileSync(file, v1Line("BITUNIX:BTCUSDT", 1_700_000_000_000, "2026-08-01T00:00:00.000Z") + "\n", "utf8");
  const report = migrateHistoryFile({ file, assumeTimeframe: "15m", dryRun: true });
  const lines = formatMigrationReport(report);
  assert.ok(lines.some((l) => l.includes("gelesen:      1")));
  assert.ok(lines.some((l) => l.includes("DRY-RUN")));
});

test("missing file yields an empty report without throwing", () => {
  const report = migrateHistoryFile({ file: path.join(dir, "gibt-es-nicht.ndjson"), assumeTimeframe: "15m" });
  assert.equal(report.read, 0);
  assert.equal(report.written, 0);
});

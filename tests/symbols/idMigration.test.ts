/**
 * Tests der Instrument-ID-Normalisierung (SYM-007 §3.4).
 *
 * Bewiesene Eigenschaften:
 *  - Konsistente Bestände (wie der aktuelle Seed) → 0 Umbenennungen.
 *  - Strukturelle Korruption (Venue-Case, id ≠ venue:symbol) wird repariert —
 *    NUR unter --apply, mit Backup; Dry-Run schreibt nichts.
 *  - Legale Alt-Notationen werden gemeldet (Advisory), nicht verändert.
 *  - Unparsebare Zeilen werden übersprungen, nie repariert.
 *  - Zielkollisionen blockieren die Umbenennung (kein stilles Serien-Merging).
 *  - Byte-identische Dubletten werden unter --apply entfernt.
 *  - Idempotenz: ein zweiter Lauf ändert nichts mehr.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatNormalizeIdsReport,
  normalizeIdFile,
  preferredStorageSymbol,
  type NormalizeIdsReport,
} from "../../src/symbols/idMigration";
import { normalizeVenueSymbol, tryNormalizeVenueSymbol } from "../../src/symbols/normalize";
import { DEFAULT_PROFILE, getVenueProfile } from "../../src/symbols/venueProfiles";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sym-idmig-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function writeFixture(dir: string, name: string, rows: (string | Record<string, unknown>)[]): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"
  );
  return file;
}

function readRows(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const registryRow = (id: string, venue: string, symbol: string): Record<string, unknown> => ({
  id,
  venue,
  symbol,
  base: null,
  quote: "USD",
  assetClass: "crypto",
  marketType: "spot",
  status: "active",
});

const historyRow = (instrumentId: string, venue: string, ts = 1_700_000_000_000): Record<string, unknown> => ({
  v: 2,
  instrumentId,
  venue,
  feed: "test",
  timeframe: "15m",
  ts,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
  fetchedAt: "2026-08-30T00:00:00.000Z",
});

// ── Bevorzugte Speicherform ─────────────────────────────────────────────────

test("preferredStorageSymbol: venue-nativ, KRAKEN in Slash-Notation", () => {
  assert.equal(preferredStorageSymbol(getVenueProfile("BITUNIX")!, "BTC/USDT"), "BTCUSDT");
  assert.equal(preferredStorageSymbol(getVenueProfile("IBKR")!, "EUR/USD"), "EUR.USD");
  assert.equal(preferredStorageSymbol(getVenueProfile("DYDX")!, "BTC/USD"), "BTC-USD");
  assert.equal(preferredStorageSymbol(getVenueProfile("KRAKEN")!, "BTC/USD"), "BTC/USD");
  assert.equal(preferredStorageSymbol(DEFAULT_PROFILE, "BTC/USD"), "BTC/USD");
});

// ── Registry ────────────────────────────────────────────────────────────────

test("Registry: konsistenter Bestand → 0 Umbenennungen, FX-Legacy als Advisory", () => {
  const dir = freshDir();
  const file = writeFixture(dir, "instruments.ndjson", [
    registryRow("BINANCE:BTCUSDT", "BINANCE", "BTCUSDT"),
    registryRow("KRAKEN:BTC/USD", "KRAKEN", "BTC/USD"),
    registryRow("IBKR:EUR.USD", "IBKR", "EUR.USD"),
    registryRow("ALPACA:AAPL", "ALPACA", "AAPL"),
    registryRow("PAPER:EURUSD=X", "PAPER", "EURUSD=X"),
  ]);
  const r = normalizeIdFile({ file, kind: "registry", dryRun: true });
  assert.equal(r.read, 5);
  assert.equal(r.renamed.length, 0);
  assert.equal(r.skipped.length, 0);
  assert.deepEqual(
    r.advisories.map((a) => a.id),
    ["PAPER:EURUSD=X"]
  );
  assert.equal(r.advisories[0].suggested, "PAPER:EUR/USD");
  // Dry-Run: Datei byte-identisch, kein Backup.
  const r2 = normalizeIdFile({ file, kind: "registry", dryRun: false });
  assert.equal(r2.renamed.length, 0);
  assert.equal(r2.backupPath, null);
  assert.equal(readRows(file).length, 5);
  assert.equal(readRows(file)[4].symbol, "EURUSD=X", "Advisory ändert die Notation NICHT");
});

test("Registry: strukturelle Korruption wird unter --apply repariert (mit Backup, Feldreihenfolge stabil)", () => {
  const dir = freshDir();
  const file = writeFixture(dir, "instruments.ndjson", [
    registryRow("kraken:BTC/USD", "kraken", "BTC/USD"), // Venue-Kleinschreibung
    registryRow("KRAKEN:BTC-USD", "KRAKEN", "BTC-USD"), // konsistent, aber Alt-Notation
    registryRow("WRONG:ID", "BINANCE", "ETHUSDT"), // id ≠ venue:symbol
  ]);
  const dry: NormalizeIdsReport = normalizeIdFile({ file, kind: "registry", dryRun: true });
  assert.equal(dry.renamed.length, 2);
  assert.equal(dry.advisories.length, 1);
  assert.equal(dry.advisories[0].id, "KRAKEN:BTC-USD");
  // Dry-Run hat nichts geschrieben.
  assert.equal(readRows(file)[0].venue, "kraken");
  assert.ok(!existsSync(`${file}.bak-x`));

  const applied = normalizeIdFile({ file, kind: "registry", dryRun: false });
  assert.equal(applied.renamed.length, 2);
  assert.ok(applied.backupPath !== null && existsSync(applied.backupPath));
  const rows = readRows(file);
  assert.equal(rows[0].id, "KRAKEN:BTC/USD");
  assert.equal(rows[0].venue, "KRAKEN");
  assert.equal(rows[0].symbol, "BTC/USD");
  assert.equal(rows[1].id, "KRAKEN:BTC-USD", "Advisory bleibt unverändert");
  assert.equal(rows[2].id, "BINANCE:ETHUSDT");
  assert.equal(rows[2].symbol, "ETHUSDT");
  // Idempotenz: zweiter Lauf ändert nichts (kein neues Backup).
  const again = normalizeIdFile({ file, kind: "registry", dryRun: false });
  assert.equal(again.renamed.length, 0);
  assert.equal(again.backupPath, null);
});

// ── History ─────────────────────────────────────────────────────────────────

test("History: korrupte ID-Präfixe werden repariert; Venue-Feld ist die Autorität", () => {
  const dir = freshDir();
  const file = writeFixture(dir, "candles.ndjson", [
    historyRow("kraken:BTC/USD", "KRAKEN"), // ID-Präfix klein, Venue ok → reparieren
    historyRow("BITUNIX:BTCUSDT", "BITUNIX"), // konsistent → unverändert
    historyRow("IBKR:EUR.USD", "IBKR"), // konsistent (Speicherform) → unverändert
  ]);
  const r = normalizeIdFile({ file, kind: "history", dryRun: false });
  assert.equal(r.renamed.length, 1);
  assert.equal(r.renamed[0].from, "kraken:BTC/USD");
  assert.equal(r.renamed[0].to, "KRAKEN:BTC/USD");
  const rows = readRows(file);
  assert.equal(rows[0].instrumentId, "KRAKEN:BTC/USD");
  assert.equal(rows[1].instrumentId, "BITUNIX:BTCUSDT");
  assert.equal(rows[2].instrumentId, "IBKR:EUR.USD");
});

test("History: Alt-Notation (KRAKEN:BTC-USD) wird als Advisory gemeldet, nicht geändert", () => {
  const dir = freshDir();
  const file = writeFixture(dir, "candles.ndjson", [historyRow("KRAKEN:BTC-USD", "KRAKEN")]);
  const r = normalizeIdFile({ file, kind: "history", dryRun: false });
  assert.equal(r.renamed.length, 0);
  assert.equal(r.advisories.length, 1);
  assert.equal(r.advisories[0].suggested, "KRAKEN:BTC/USD");
  assert.equal(readRows(file)[0].instrumentId, "KRAKEN:BTC-USD");
  assert.equal(r.backupPath, null, "keine Änderung → kein Backup");
});

test("Zielkollision: zwei verschiedene Quell-IDs auf dasselbe Ziel → keine Umbenennung", () => {
  const dir = freshDir();
  // Beide korrupt (kleine Venue), beide würden auf KRAKEN:BTC/USD münden.
  const file = writeFixture(dir, "candles.ndjson", [
    historyRow("kraken:BTC/USD", "kraken", 1_700_000_000_000),
    historyRow("kraken:BTC-USD", "kraken", 1_700_000_060_000),
  ]);
  const r = normalizeIdFile({ file, kind: "history", dryRun: false });
  // Erste mündet nach KRAKEN:BTC/USD, zweite (Advisory-Niveau) strukturell →
  // zweite würde ebenfalls repariert → Kollision → beide zurückgenommen? Nein:
  // die zweite Zeile ist konsistent (venue=symbol-Quelle klein) — strukturell
  // korrupt (Venue-Case) → Reparaturziel KRAKEN:BTC/USD → KOLLISION.
  assert.equal(r.renamed.length, 0, "kein stilles Serien-Merging");
  assert.equal(r.collisions, 2);
  const rows = readRows(file);
  assert.equal(rows[0].instrumentId, "kraken:BTC/USD");
  assert.equal(rows[1].instrumentId, "kraken:BTC-USD");
});

test("Übersprungene Zeilen: kaputtes JSON, ungültige Venue, unparsebares Symbol — nie repariert", () => {
  const dir = freshDir();
  const file = writeFixture(dir, "instruments.ndjson", [
    "{kaputtes json",
    registryRow("KRAKEN:BTC;DROP", "KRAKEN", "BTC;DROP"),
    registryRow("1BAD:BTC", "1BAD", "BTC"),
    registryRow("KRAKEN:BTC/USD", "KRAKEN", "BTC/USD"),
  ]);
  const r = normalizeIdFile({ file, kind: "registry", dryRun: false });
  assert.equal(r.skipped.length, 3);
  assert.equal(r.unchanged, 1);
  assert.equal(r.renamed.length, 0);
  assert.match(
    formatNormalizeIdsReport(r).join("\n"),
    /SKIP/
  );
  // Übersprungene Zeilen bleiben byte-identisch in der Datei.
  const rawTxt = readFileSync(file, "utf8");
  assert.ok(rawTxt.includes("{kaputtes json"));
  assert.ok(rawTxt.includes("BTC;DROP"));
});

test("Byte-identische Dubletten werden unter --apply entfernt (erste gewinnt)", () => {
  const dir = freshDir();
  const a = registryRow("KRAKEN:BTC/USD", "KRAKEN", "BTC/USD");
  const file = writeFixture(dir, "instruments.ndjson", [a, a, registryRow("BINANCE:BTCUSDT", "BINANCE", "BTCUSDT")]);
  const dry = normalizeIdFile({ file, kind: "registry", dryRun: true });
  assert.equal(dry.duplicates, 1);
  assert.equal(readRows(file).length, 3, "Dry-Run entfernt nichts");
  const applied = normalizeIdFile({ file, kind: "registry", dryRun: false });
  assert.equal(applied.duplicates, 1);
  assert.equal(readRows(file).length, 2);
  assert.ok(applied.backupPath !== null);
});

// ── Vertrag der Normalisierung, die das Skript benutzt ─────────────────────

test("Skript-Semantik stützt sich auf die SSoT (Kanon = normalizeVenueSymbol)", () => {
  const c = normalizeVenueSymbol("KRAKEN", "BTC-USD");
  assert.equal(c.instrumentId, "KRAKEN:BTC/USD");
  assert.equal(tryNormalizeVenueSymbol("KRAKEN", "BTC;DROP").ok, false);
});

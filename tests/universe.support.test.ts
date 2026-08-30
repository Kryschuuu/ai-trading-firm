/**
 * Ergänzende Unit-Tests für Hilfsfunktionen des Universe-Moduls:
 * Validierungs-Helfer, Audit-Bausteine, Store-Serialisierung und Singleton.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clampPage,
  clampPageSize,
  isIsoTimestamp,
  isValidInstrumentId,
  isValidSymbol,
  isValidVenue,
  safeRef,
  splitInstrumentId,
} from "../src/universe/validation";
import { buildAuditEntry, sanitizeSource, writeDbAudit } from "../src/universe/audit";
import { NdjsonStore, PERSISTED_INSTRUMENT_FIELDS, resolveDataDir, serializeInstrument } from "../src/universe/store";
import { normalizeInstrument } from "../src/universe/normalization";
import { loadPolicy, DEFAULT_POLICY } from "../src/universe/policy";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "universe-support-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  delete process.env.UNIVERSE_DATA_DIR;
});

test("Validierung: Muster-Helfer akzeptieren nur erlaubte Formate", () => {
  assert.equal(isValidVenue("BINANCE"), true);
  assert.equal(isValidVenue("binance"), false);
  assert.equal(isValidVenue("A"), false);
  assert.equal(isValidVenue(7), false);
  assert.equal(isValidSymbol("BTC/USD"), true);
  assert.equal(isValidSymbol("EURUSD=X"), true);
  assert.equal(isValidSymbol("BTC USD"), false);
  assert.equal(isValidSymbol("X".repeat(40)), false);
  assert.equal(isValidInstrumentId("BINANCE:BTCUSDT"), true);
  assert.equal(isValidInstrumentId("BINANCE-BTCUSDT"), false);
  assert.equal(isValidInstrumentId(null), false);
  assert.deepEqual(splitInstrumentId("KRAKEN:BTC/USD"), { venue: "KRAKEN", symbol: "BTC/USD" });
  assert.equal(splitInstrumentId("kaputt"), null);
});

test("Validierung: Zeitstempel- und Pagination-Helfer", () => {
  assert.equal(isIsoTimestamp("2026-08-27T00:00:00.000Z"), true);
  assert.equal(isIsoTimestamp("27.08.2026"), false);
  assert.equal(isIsoTimestamp(123), false);
  assert.equal(clampPageSize(1000), 500);
  assert.equal(clampPageSize(0), 1);
  assert.equal(clampPageSize("abc"), 100);
  assert.equal(clampPage("abc"), 1);
  assert.equal(clampPage(3.7), 3);
});

test("Validierung: safeRef kürzt und entschärft Fremdeingaben", () => {
  assert.equal(safeRef("BTC"), "BTC");
  assert.equal(safeRef("A".repeat(80)).length, 40);
  assert.equal(safeRef(""), "<leer>");
  assert.equal(safeRef({ a: 1 }), '{"a":1}');
});

test("Audit: sanitizeSource entfernt Sonderzeichen und begrenzt die Länge", () => {
  assert.equal(sanitizeSource("Discovery:Binance"), "discovery:binance");
  assert.equal(sanitizeSource("../../etc/passwd"), "....etcpasswd");
  assert.equal(sanitizeSource(""), "unknown");
  assert.equal(sanitizeSource(42), "unknown");
  assert.equal(sanitizeSource("x".repeat(100)).length, 40);
});

test("Audit: buildAuditEntry summiert changed und klemmt die ID-Liste", () => {
  const entry = buildAuditEntry({
    source: "api",
    action: "BATCH_UPSERT",
    created: 2,
    updated: 3,
    removed: 1,
    rejected: 4,
    ids: Array.from({ length: 40 }, (_, i) => `V:S${i}`),
    now: new Date("2026-08-27T12:00:00.000Z"),
  });
  assert.equal(entry.actor, "system");
  assert.equal(entry.changed, 6);
  assert.equal(entry.rejected, 4);
  assert.equal(entry.ids.length, 25);
  assert.equal(entry.timestamp, "2026-08-27T12:00:00.000Z");
});

test("Audit: DB-Senke bleibt ohne UNIVERSE_AUDIT_DB=1 inaktiv (kein DB-Zugriff)", async () => {
  delete process.env.UNIVERSE_AUDIT_DB;
  await writeDbAudit(buildAuditEntry({ source: "test", action: "UPSERT", created: 1 }));
});

test("Store: Serialisierung persistiert nur statische Felder", () => {
  const i = normalizeInstrument({ venue: "BINANCE", symbol: "BTCUSDT" }, new Date("2026-08-27T00:00:00.000Z"));
  const parsed = JSON.parse(serializeInstrument(i)) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...PERSISTED_INSTRUMENT_FIELDS]);
  assert.equal("liveTradable" in parsed, true);
  assert.equal(parsed.liveTradable, false);
  assert.equal("liveAvailable" in parsed, false);
});

test("Store: leeres Verzeichnis liefert existed=false, Audit-Log ist zunächst leer", () => {
  const store = new NdjsonStore(freshDir());
  const res = store.load();
  assert.equal(res.existed, false);
  assert.equal(res.instruments.length, 0);
  assert.deepEqual(store.readAudit(), []);
  store.appendAudit({ hallo: "welt" });
  assert.deepEqual(store.readAudit(), [{ hallo: "welt" }]);
});

test("Store: leeres Universum schreibt eine leere Datei ohne Zeilenumbruch-Müll", () => {
  const store = new NdjsonStore(freshDir());
  store.save([]);
  assert.deepEqual(store.load().instruments, []);
});

test("Store: resolveDataDir respektiert absolute Pfade und UNIVERSE_DATA_DIR", () => {
  assert.equal(resolveDataDir("/tmp/abs"), "/tmp/abs");
  process.env.UNIVERSE_DATA_DIR = "relativ/pfad";
  assert.equal(resolveDataDir(), path.join(process.cwd(), "relativ/pfad"));
  delete process.env.UNIVERSE_DATA_DIR;
  assert.equal(resolveDataDir(), path.join(process.cwd(), "data/universe"));
});

test("Policy: loadPolicy ohne Override liefert die eingebaute Default-Policy", () => {
  assert.equal(loadPolicy(undefined), DEFAULT_POLICY);
  assert.throws(() => loadPolicy("/nicht/vorhanden/policy.json"), /ENOENT/);
});

test("Singleton: getRegistry seedet ein leeres Datenverzeichnis genau einmal", async () => {
  const dir = freshDir();
  process.env.UNIVERSE_DATA_DIR = dir;
  const { getRegistry, resetRegistryForTests } = await import("../src/universe/index");
  resetRegistryForTests();
  const first = getRegistry();
  assert.equal(first.size, 26, "Bootstrap-Seed importiert die migrierte Watchlist");
  assert.equal(getRegistry(), first, "zweiter Aufruf liefert dieselbe Instanz");
  resetRegistryForTests();
  const second = getRegistry();
  assert.notEqual(second, first);
  assert.equal(second.size, 26, "vorhandene Datei wird geladen, nicht erneut geseedet");
  resetRegistryForTests();
  delete process.env.UNIVERSE_DATA_DIR;
});

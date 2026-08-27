/**
 * Unit-Tests der Instrument-Registry (Task 01).
 *
 * Deckt CRUD, Upsert-Konfliktverhalten, alle Filter, Pagination-Grenzen,
 * stabile Sortierung, Policy-Ausschluss und Audit-Log ab.
 * Kein Netzwerk, keine Datenbank — reine Datei-/Speicheroperationen.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InstrumentRegistry } from "../src/universe/registry";
import { NdjsonStore } from "../src/universe/store";
import { MAX_BATCH_SIZE, MAX_PAGE_SIZE, UniverseValidationError, validateInstrument } from "../src/universe/validation";
import { SEED_INSTRUMENTS, SEED_TIMESTAMP, LEGACY_WATCHLIST } from "../src/universe/seed";
import { UI_WATCHLIST_PREFERENCE, WATCHLIST_DISPLAY_SYMBOLS } from "../src/universe/watchlist";
import type { InstrumentInput } from "../src/universe/types";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "universe-"));
  dirs.push(dir);
  return dir;
}

function freshRegistry(): InstrumentRegistry {
  const registry = new InstrumentRegistry({ dir: freshDir(), now: () => new Date("2026-08-27T10:00:00.000Z") });
  registry.load();
  return registry;
}

function seeded(): InstrumentRegistry {
  const registry = freshRegistry();
  registry.upsertMany([...SEED_INSTRUMENTS], "seed:test", "SEED");
  return registry;
}

function input(overrides: Partial<InstrumentInput> = {}): InstrumentInput {
  return { venue: "BINANCE", symbol: "BTCUSDT", ...overrides };
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  /* jeder Test bekommt sein eigenes Verzeichnis */
});

// ── 1–5: CRUD ────────────────────────────────────────────────────────────────

test("Registry: leere Registry hat Größe 0 und lastSync null", () => {
  const r = freshRegistry();
  assert.equal(r.size, 0);
  assert.equal(r.lastSync, null);
});

test("Registry: upsert legt ein Instrument mit kanonischer ID an", () => {
  const r = freshRegistry();
  const res = r.upsert(input(), "test");
  assert.equal(res.created, 1);
  assert.deepEqual(res.ids, ["BINANCE:BTCUSDT"]);
  assert.equal(r.get("BINANCE:BTCUSDT")?.symbol, "BTCUSDT");
});

test("Registry: get/find liefern dasselbe Instrument, unbekanntes gibt null", () => {
  const r = freshRegistry();
  r.upsert(input({ venue: "KRAKEN", symbol: "BTC/USD" }), "test");
  assert.equal(r.find("kraken", "btc/usd")?.id, "KRAKEN:BTC/USD");
  assert.equal(r.get("KRAKEN:BTC/USD")?.id, "KRAKEN:BTC/USD");
  assert.equal(r.get("KRAKEN:NOPE"), null);
  assert.equal(r.find("KRAKEN", "!!!"), null);
});

test("Registry: remove löscht und meldet false beim zweiten Versuch", () => {
  const r = freshRegistry();
  r.upsert(input(), "test");
  assert.equal(r.remove("BINANCE:BTCUSDT", "test"), true);
  assert.equal(r.remove("BINANCE:BTCUSDT", "test"), false);
  assert.equal(r.size, 0);
});

test("Registry: getWithRelations liefert assetId und underlyingId", () => {
  const r = freshRegistry();
  r.upsert(input(), "test");
  const withRel = r.getWithRelations("BINANCE:BTCUSDT");
  assert.equal(withRel?.assetId, "BTC");
  assert.equal(withRel?.underlyingId, "BTC");
  assert.equal(r.getWithRelations("X:Y"), null);
});

// ── 6–10: Upsert-Konfliktverhalten ───────────────────────────────────────────

test("Upsert: zweiter identischer Satz zählt als unchanged, nicht als update", () => {
  const r = freshRegistry();
  r.upsert(input({ lastSeen: SEED_TIMESTAMP }), "test");
  const res = r.upsert(input({ lastSeen: SEED_TIMESTAMP }), "test");
  assert.equal(res.created, 0);
  assert.equal(res.updated, 0);
  assert.equal(res.unchanged, 1);
});

test("Upsert: geänderte Felder erzeugen ein Update, Bestand bleibt sonst erhalten", () => {
  const r = freshRegistry();
  r.upsert(input({ takerFee: 0.001, minQuantity: 0.01 }), "test");
  const res = r.upsert(input({ status: "halted" }), "test");
  assert.equal(res.updated, 1);
  const after = r.get("BINANCE:BTCUSDT");
  assert.equal(after?.status, "halted");
  assert.equal(after?.takerFee, 0.001, "nicht angegebene Felder dürfen nicht auf Default zurückfallen");
  assert.equal(after?.minQuantity, 0.01);
});

test("Upsert: null bei Metriken lässt den Bestandswert stehen", () => {
  const r = freshRegistry();
  r.upsert(input({ volume24h: 1_000_000, spread: 0.0002, volatility: 0.5 }), "test");
  r.upsert(input({ volume24h: null, spread: null, volatility: null }), "test");
  const after = r.get("BINANCE:BTCUSDT");
  assert.equal(after?.volume24h, 1_000_000);
  assert.equal(after?.spread, 0.0002);
  assert.equal(after?.volatility, 0.5);
});

test("Upsert: expliziter Zahlenwert überschreibt eine Metrik", () => {
  const r = freshRegistry();
  r.upsert(input({ volume24h: 10 }), "test");
  r.upsert(input({ volume24h: 20 }), "test");
  assert.equal(r.get("BINANCE:BTCUSDT")?.volume24h, 20);
});

test("Upsert: Batch akzeptiert gute Sätze und weist kaputte einzeln ab", () => {
  const r = freshRegistry();
  const res = r.upsertMany(
    [input(), input({ symbol: "ETH USDT!" }), input({ venue: "kraken", symbol: "ETH/USD" })],
    "test",
  );
  assert.equal(res.created, 2);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].code, "VALIDATION_ERROR");
});

// ── 11–13: Validierung ───────────────────────────────────────────────────────

test("Validierung: Venue/Symbol-Muster blocken Injection-Versuche", () => {
  const r = freshRegistry();
  const res = r.upsertMany(
    [
      input({ symbol: 'BTC"; DROP TABLE positions; --' }),
      input({ symbol: "BTC&foo=bar" }),
      input({ venue: "../../etc" }),
      input({ symbol: "A".repeat(40) }),
    ],
    "test",
  );
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 4);
});

test("Validierung: unsinnige Handelsbedingungen werden abgelehnt", () => {
  const r = freshRegistry();
  const res = r.upsertMany(
    [
      input({ minQuantity: 0 }),
      input({ symbol: "ETHUSDT", priceStep: -1 }),
      input({ symbol: "SOLUSDT", takerFee: 5 }),
      input({ symbol: "XRPUSDT", status: "unbekannt" as never }),
      input({ symbol: "ADAUSDT", lastSeen: "gestern" }),
    ],
    "test",
  );
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 5);
  assert.ok(res.rejected.every((x) => x.code === "VALIDATION_ERROR"));
});

test("Validierung: validateInstrument verwirft Fremdfelder und erzwingt die ID", () => {
  const clean = validateInstrument({
    ...SEED_INSTRUMENTS[0],
    id: "PAPER:BTC",
    boeseFeld: "<script>",
  });
  assert.equal("boeseFeld" in clean, false);
  assert.throws(
    () => validateInstrument({ ...SEED_INSTRUMENTS[0], id: "FALSCH:ID" }),
    UniverseValidationError,
  );
});

// ── 14–16: Policy ────────────────────────────────────────────────────────────

test("Policy: gehebelte Token werden ausgeschlossen", () => {
  const r = freshRegistry();
  const res = r.upsertMany([input({ symbol: "BTC3LUSDT" }), input({ symbol: "ETHUP" })], "test");
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 2);
  assert.equal(res.rejected[0].code, "POLICY_EXCLUDED");
  assert.match(res.rejected[0].message, /leveraged-token/);
});

test("Policy: Test-Symbole werden ausgeschlossen", () => {
  const r = freshRegistry();
  const res = r.upsert(input({ symbol: "TESTUSDT" }), "test");
  assert.equal(res.created, 0);
  assert.match(res.rejected[0].message, /test-symbol/);
});

test("Policy: gesperrte Venue und Quote greifen", () => {
  const r = new InstrumentRegistry({
    dir: freshDir(),
    policy: {
      version: 1,
      description: "test",
      maxSymbolLength: 32,
      rules: [],
      excludeVenues: ["DYDX"],
      excludeQuotes: ["BUSD"],
    },
  });
  r.load();
  const res = r.upsertMany([input({ venue: "DYDX", symbol: "BTC-USD" }), input({ symbol: "BTCBUSD" })], "test");
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 2);
});

// ── 17–24: Filter ────────────────────────────────────────────────────────────

test("Filter: venue (einzeln und Liste)", () => {
  const r = seeded();
  assert.equal(r.query({ venue: "BINANCE" }).total, 3);
  assert.equal(r.query({ venue: ["BINANCE", "KRAKEN"] }).total, 6);
  assert.equal(r.query({ venue: "GIBTESNICHT" }).total, 0);
});

test("Filter: assetClass und marketType", () => {
  const r = seeded();
  assert.equal(r.query({ assetClass: "fx" }).total, 2);
  assert.equal(r.query({ assetClass: ["etf", "equity"] }).total, 15);
  assert.equal(r.query({ marketType: "spot" }).total, 26);
  assert.equal(r.query({ marketType: "perpetual" }).total, 0);
});

test("Filter: status", () => {
  const r = seeded();
  assert.equal(r.query({ status: "active" }).total, 26);
  r.upsert({ venue: "BINANCE", symbol: "BTCUSDT", status: "halted" }, "test");
  assert.equal(r.query({ status: "halted" }).total, 1);
  assert.equal(r.query({ status: ["active", "halted"] }).total, 26);
});

test("Filter: paperAvailable und liveAvailable", () => {
  const r = seeded();
  assert.equal(r.query({ paperAvailable: true }).total, 26);
  assert.equal(r.query({ liveAvailable: true }).total, 17);
  assert.equal(r.query({ liveAvailable: false }).total, 9);
});

test("Filter: leverageAvailable und shortAvailable", () => {
  const r = seeded();
  assert.equal(r.query({ leverageAvailable: true }).total, 1);
  assert.equal(r.query({ shortAvailable: true }).total, 11);
});

test("Filter: base, quote und underlying", () => {
  const r = seeded();
  assert.equal(r.query({ base: "BTC" }).total, 3);
  assert.equal(r.query({ quote: "USDT" }).total, 3);
  assert.equal(r.query({ underlying: "BTC" }).total, 3);
});

test("Filter: minVolume24h/maxSpread/maxVolatility schließen null-Metriken aus", () => {
  const r = seeded();
  assert.equal(r.query({ minVolume24h: 1 }).total, 0, "null-Volumen darf keinen Filter passieren");
  r.upsert({ venue: "BINANCE", symbol: "BTCUSDT", volume24h: 5_000_000, spread: 0.0001, volatility: 0.4 }, "test");
  assert.equal(r.query({ minVolume24h: 1_000_000 }).total, 1);
  assert.equal(r.query({ minVolume24h: 9_000_000 }).total, 0);
  assert.equal(r.query({ maxSpread: 0.0002 }).total, 1);
  assert.equal(r.query({ maxVolatility: 0.1 }).total, 0);
});

test("Filter: search greift auf die ID, kombinierte Filter sind UND-verknüpft", () => {
  const r = seeded();
  assert.equal(r.query({ search: "btc" }).total, 3);
  assert.equal(r.query({ search: "BTC", venue: "KRAKEN" }).total, 1);
  assert.equal(r.query({ venue: "PAPER", assetClass: "crypto", liveAvailable: true }).total, 0);
});

// ── 25–28: Pagination und Sortierung ────────────────────────────────────────

test("Pagination: Seitengröße wird auf 500 geklemmt", () => {
  const r = seeded();
  const res = r.query({ pageSize: 10_000 });
  assert.equal(res.pageSize, MAX_PAGE_SIZE);
});

test("Pagination: Seiten sind disjunkt, vollständig und melden hasMore korrekt", () => {
  const r = seeded();
  const p1 = r.query({ pageSize: 10, page: 1 });
  const p2 = r.query({ pageSize: 10, page: 2 });
  const p3 = r.query({ pageSize: 10, page: 3 });
  assert.equal(p1.items.length, 10);
  assert.equal(p1.hasMore, true);
  assert.equal(p3.items.length, 6);
  assert.equal(p3.hasMore, false);
  const ids = new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.id));
  assert.equal(ids.size, 26);
});

test("Pagination: ungültige Werte fallen auf Defaults zurück, Seite jenseits des Endes ist leer", () => {
  const r = seeded();
  const res = r.query({ page: -5 as number, pageSize: Number.NaN });
  assert.equal(res.page, 1);
  assert.equal(res.pageSize, 100);
  assert.equal(r.query({ page: 99 }).items.length, 0);
});

test("Sortierung: Ergebnis ist stabil nach id sortiert — unabhängig von der Einfügereihenfolge", () => {
  const a = freshRegistry();
  const b = freshRegistry();
  a.upsertMany([...SEED_INSTRUMENTS], "test");
  b.upsertMany([...SEED_INSTRUMENTS].reverse(), "test");
  const idsA = a.query({ pageSize: 500 }).items.map((i) => i.id);
  const idsB = b.query({ pageSize: 500 }).items.map((i) => i.id);
  assert.deepEqual(idsA, idsB);
  assert.deepEqual(idsA, [...idsA].sort());
});

// ── 29–32: Gruppierung, Audit, Grenzen, Migration ────────────────────────────

test("Gruppierung: groupByVenue liefert alphabetische Venues mit korrekten Zählern", () => {
  const r = seeded();
  const groups = r.groupByVenue(r.query({ pageSize: 500 }).items);
  assert.deepEqual(groups.map((g) => g.venue), ["ALPACA", "BINANCE", "IBKR", "KRAKEN", "PAPER"]);
  assert.deepEqual(groups.map((g) => g.count), [5, 3, 6, 3, 9]);
  assert.deepEqual(r.countByVenue(), { ALPACA: 5, BINANCE: 3, IBKR: 6, KRAKEN: 3, PAPER: 9 });
});

test("Audit: jede Mutation schreibt genau einen Eintrag mit actor/source/count", () => {
  const dir = freshDir();
  const r = new InstrumentRegistry({ dir });
  r.load();
  r.upsert(input(), "discovery:binance");
  r.remove("BINANCE:BTCUSDT", "api");
  const entries = new NdjsonStore(dir).readAudit() as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].actor, "system");
  assert.equal(entries[0].source, "discovery:binance");
  assert.equal(entries[0].action, "UPSERT");
  assert.equal(entries[0].changed, 1);
  assert.equal(entries[1].action, "REMOVE");
  assert.ok(typeof entries[0].timestamp === "string" && entries[0].timestamp.endsWith("Z"));
});

test("Grenzen: Batch über MAX_BATCH_SIZE und Nicht-Array werfen", () => {
  const r = freshRegistry();
  const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => input());
  assert.throws(() => r.upsertMany(tooMany, "test"), UniverseValidationError);
  assert.throws(() => r.upsertMany("nope" as never, "test"), UniverseValidationError);
});

test("Migration: 9 Watchlist-Symbole existieren als PAPER-Instrumente", () => {
  const r = seeded();
  assert.deepEqual([...WATCHLIST_DISPLAY_SYMBOLS], [...LEGACY_WATCHLIST]);
  for (const entry of UI_WATCHLIST_PREFERENCE) {
    assert.ok(r.get(entry.instrumentId), `${entry.instrumentId} fehlt im Universum`);
  }
  assert.equal(r.query({ venue: "PAPER" }).total, 9);
  assert.equal(r.lastSync, SEED_TIMESTAMP);
});

test("Persistenz: save schreibt eine Datei, load stellt denselben Stand her", () => {
  const dir = freshDir();
  const a = new InstrumentRegistry({ dir });
  a.load();
  a.upsertMany([...SEED_INSTRUMENTS], "seed:test", "SEED");
  assert.ok(existsSync(path.join(dir, "instruments.ndjson")));

  const b = new InstrumentRegistry({ dir });
  b.load();
  assert.equal(b.size, a.size);
  assert.deepEqual(b.query({ pageSize: 500 }).items, a.query({ pageSize: 500 }).items);
});

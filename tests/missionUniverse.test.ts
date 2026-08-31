/**
 * Missions-Universum: Segment → Kandidaten (v1.35.0).
 *
 * Drei Ebenen, alle ohne Netzwerk und ohne Datenbank:
 *
 *   1. **Reine Funktionen** — `rankCandidateSymbols`, `focusSymbolFor`,
 *      `isSymbolInMissionScope` mit Hand-Fixtures.
 *   2. **Segment-Filter gegen eine echte Registry** — temporäres
 *      Datenverzeichnis (`UNIVERSE_DATA_DIR`), Instrumente per `upsert`.
 *      Damit ist bewiesen, dass „nur Indizes“, „nur Penny Stocks“,
 *      „nur hochvolatil“ und „nur liquide“ wirklich die richtigen Instrumente
 *      liefern — nicht nur die richtige Query im Katalog steht.
 *   3. **Kontext-Auflösung** — `missionUniverseContext()` für Einzel-Symbol,
 *      Markt-Scan, Legacy-Mission ohne Symbol und unbekanntes Segment.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InstrumentRegistry } from "../src/universe/registry";
import { resetRegistryForTests } from "../src/universe";
import type { InstrumentInput, MarketInstrument } from "../src/universe/types";
import {
  DEFAULT_FOCUS_SYMBOL,
  focusSymbolFor,
  isSymbolInMissionScope,
  missionFocusSymbol,
  missionUniverseContext,
  rankCandidateSymbols,
  resolveSegmentInstruments,
  segmentCandidateCounts,
} from "../src/lib/missionUniverse";
import { findMissionSegment } from "../src/lib/missionTemplates";

// ── Fixtures ────────────────────────────────────────────────────────────────

const dirs: string[] = [];

function freshRegistry(): InstrumentRegistry {
  const dir = mkdtempSync(path.join(tmpdir(), "mission-universe-"));
  dirs.push(dir);
  const registry = new InstrumentRegistry({ dir, now: () => new Date("2026-08-31T10:00:00.000Z") });
  registry.load();
  return registry;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  resetRegistryForTests();
});

/** Vollständiges Instrument für die reinen Funktionen. */
function instrument(overrides: Partial<MarketInstrument> & { symbol: string }): MarketInstrument {
  return {
    id: `PAPER:${overrides.symbol}`,
    venue: "PAPER",
    base: null,
    quote: "USD",
    assetClass: "equity",
    marketType: "spot",
    status: "active",
    minQuantity: 1,
    priceStep: 0.01,
    quantityStep: 1,
    makerFee: 0,
    takerFee: 0,
    leverageAvailable: false,
    shortAvailable: true,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: true,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: "2026-08-31T00:00:00.000Z",
    ...overrides,
  } as MarketInstrument;
}

/** Ein Test-Universum mit allen Segment-Repräsentanten. */
function seedTestUniverse(registry: InstrumentRegistry): void {
  const rows: InstrumentInput[] = [
    // Krypto (Live-Venue + PAPER-Spiegel → muss zu einem Kandidaten werden)
    { venue: "BINANCE", symbol: "BTCUSDT", assetClass: "crypto", marketType: "spot", volume24h: 900_000_000 },
    { venue: "PAPER", symbol: "BTC", assetClass: "crypto", marketType: "spot", volume24h: 900_000_000 },
    { venue: "PAPER", symbol: "ETH", assetClass: "crypto", marketType: "spot", volume24h: 400_000_000 },
    // Aktien (Liquidität hoch/niedrig)
    { venue: "ALPACA", symbol: "AAPL", assetClass: "equity", marketType: "spot", volume24h: 60_000_000 },
    { venue: "PAPER", symbol: "AAPL", assetClass: "equity", marketType: "spot", volume24h: 60_000_000 },
    { venue: "ALPACA", symbol: "TINY", assetClass: "equity", marketType: "spot", volume24h: 250_000, volatility: 1.4 },
    { venue: "PAPER", symbol: "TINY", assetClass: "equity", marketType: "spot", volume24h: 250_000, volatility: 1.4 },
    // ETFs und Index-CFD
    { venue: "PAPER", symbol: "SPY", assetClass: "etf", marketType: "spot", volume24h: 30_000_000_000 },
    { venue: "IBKR", symbol: "SPX", assetClass: "index", marketType: "cfd", volume24h: 5_000_000_000 },
    // Rohstoff-Future
    { venue: "IBKR", symbol: "GC", assetClass: "commodity", marketType: "future", volume24h: 12_000_000_000 },
    // Devisen
    { venue: "PAPER", symbol: "EURUSD=X", assetClass: "fx", marketType: "spot", volume24h: 20_000_000_000 },
    // Nicht handelbar → darf in keinem Segment auftauchen
    { venue: "PAPER", symbol: "HALT", assetClass: "equity", marketType: "spot", status: "halted" },
    { venue: "PAPER", symbol: "NOLIVE", assetClass: "equity", marketType: "spot", paperAvailable: false },
  ];
  registry.upsertMany(rows, "test:mission-universe", "SEED");
}

// ── 1) Reine Funktionen ──────────────────────────────────────────────────────

test("rankCandidateSymbols: fasst Venues zusammen und bevorzugt den PAPER-Spiegel", () => {
  const ranked = rankCandidateSymbols(
    [
      instrument({ symbol: "BTCUSDT", venue: "BINANCE", volume24h: 100 }),
      instrument({ symbol: "BTC", venue: "PAPER", volume24h: 100 }),
    ],
    10
  );
  // BTCUSDT und BTC kanonisieren unterschiedlich (BTC/USDT vs. BTC) — der
  // PAPER-Spiegel gewinnt bei gleicher kanonischer Form:
  const paperOnly = rankCandidateSymbols(
    [
      instrument({ symbol: "AAPL", venue: "ALPACA", volume24h: 10 }),
      instrument({ symbol: "AAPL", venue: "PAPER", volume24h: 5 }),
    ],
    10
  );
  assert.deepEqual(paperOnly.symbols, ["AAPL"], "zwei Venues, ein Kandidat");
  assert.equal(paperOnly.total, 1);
  assert.ok(ranked.symbols.includes("BTC"), "PAPER:BTC muss Kandidat sein");
});

test("rankCandidateSymbols: sortiert nach 24h-Volumen, unbekannte Metrik zuletzt", () => {
  const ranked = rankCandidateSymbols(
    [
      instrument({ symbol: "LOW", volume24h: 1_000 }),
      instrument({ symbol: "UNKNOWN", volume24h: null }),
      instrument({ symbol: "HIGH", volume24h: 9_000_000 }),
      instrument({ symbol: "MID", volume24h: 500_000 }),
    ],
    10
  );
  assert.deepEqual(ranked.symbols, ["HIGH", "MID", "LOW", "UNKNOWN"]);
  assert.equal(ranked.total, 4);
});

test("rankCandidateSymbols: kürzt auf das Limit und verwirft nicht normalisierbare Symbole", () => {
  const ranked = rankCandidateSymbols(
    [
      instrument({ symbol: "A", volume24h: 3 }),
      instrument({ symbol: "B", volume24h: 2 }),
      instrument({ symbol: "C", volume24h: 1 }),
      instrument({ symbol: 'INJECT"; DROP', volume24h: 99 }),
    ],
    2
  );
  assert.deepEqual(ranked.symbols, ["A", "B"], "nur die zwei liquidesten");
  assert.equal(ranked.total, 3, "Injection-Symbol zählt nicht mit");

  const zero = rankCandidateSymbols([instrument({ symbol: "A" })], 0);
  assert.deepEqual(zero.symbols, []);
});

test("focusSymbolFor: erster Kandidat, sonst Fallback", () => {
  assert.equal(focusSymbolFor(["BTC", "ETH"], "SPY"), "BTC");
  assert.equal(focusSymbolFor([], "SPY"), "SPY");
  assert.equal(focusSymbolFor(["  "], "SPY"), "SPY");
  assert.equal(DEFAULT_FOCUS_SYMBOL, "SPY");
});

test("isSymbolInMissionScope: Einzel-Symbol, Scan, leere Liste und Legacy", () => {
  const single = {
    scope: "SINGLE_SYMBOL" as const,
    candidates: ["BTC"],
    enforceScope: true,
  } as never;
  assert.equal(isSymbolInMissionScope(single, "BTC"), true);
  assert.equal(isSymbolInMissionScope(single, "btc"), true, "Vergleich ist case-insensitiv");
  assert.equal(isSymbolInMissionScope(single, "BTCUSDT"), false);
  assert.equal(isSymbolInMissionScope(single, null), false);

  const scan = {
    scope: "SCAN_UNIVERSE" as const,
    candidates: ["SPY", "QQQ"],
    enforceScope: true,
  } as never;
  assert.equal(isSymbolInMissionScope(scan, "SPY"), true);
  assert.equal(isSymbolInMissionScope(scan, "BTC"), false, "Fremdsymbol verletzt das Mandat");

  const empty = { scope: "SCAN_UNIVERSE" as const, candidates: [], enforceScope: true } as never;
  assert.equal(isSymbolInMissionScope(empty, "SPY"), false, "leeres Segment → fail-closed");

  const legacy = { scope: "SINGLE_SYMBOL" as const, candidates: [], enforceScope: false } as never;
  assert.equal(isSymbolInMissionScope(legacy, "IRGENDWAS"), true, "Alt-Mission ohne Symbol blockt nicht");
});

// ── 2) Segment-Filter gegen eine echte Registry ──────────────────────────────

test("resolveSegmentInstruments: Segmente liefern genau ihre Anlageklassen", () => {
  const registry = freshRegistry();
  seedTestUniverse(registry);
  const symbolsOf = (segmentId: string) =>
    resolveSegmentInstruments(registry, findMissionSegment(segmentId)!).map((i) => i.symbol);

  const all = symbolsOf("ALL");
  assert.ok(all.includes("BTC"), "ALL enthält Krypto");
  assert.ok(all.includes("SPY"), "ALL enthält ETFs");
  assert.ok(all.includes("SPX"), "ALL enthält Indizes");
  assert.ok(!all.includes("HALT"), "status=halted ist kein Kandidat");
  assert.ok(!all.includes("NOLIVE"), "paperAvailable=false ist kein Kandidat");

  const indices = symbolsOf("INDICES");
  assert.deepEqual(indices.sort(), ["SPX", "SPY"], "INDICES = Index-CFD + ETF");

  const crypto = symbolsOf("CRYPTO");
  assert.deepEqual(crypto.sort(), ["BTC", "BTCUSDT", "ETH"]);

  const equities = symbolsOf("EQUITIES");
  assert.ok(equities.includes("AAPL") && equities.includes("TINY"));
  assert.ok(!equities.includes("SPY"), "ETFs gehören nicht zu EQUITIES");

  assert.deepEqual(symbolsOf("FX"), ["EURUSD=X"]);
  assert.deepEqual(symbolsOf("COMMODITIES"), ["GC"]);
});

test("resolveSegmentInstruments: PENNY, VOLATILE und LIQUID filtern wie dokumentiert", () => {
  const registry = freshRegistry();
  seedTestUniverse(registry);
  const symbolsOf = (segmentId: string) =>
    resolveSegmentInstruments(registry, findMissionSegment(segmentId)!).map((i) => i.symbol);
  /** Eindeutige Symbole — resolveSegmentInstruments liefert Instrumente
   *  (Venue-granular), die Verdichtung auf Kandidaten macht erst
   *  rankCandidateSymbols(). */
  const uniqueSymbolsOf = (segmentId: string) => [...new Set(symbolsOf(segmentId))];

  // PENNY: Aktien-Spot, ohne IBKR-Futures (Preisgrenze prüft der Screener).
  const penny = uniqueSymbolsOf("PENNY");
  assert.ok(penny.includes("TINY"), "illiquider Smallcap gehört ins Penny-Segment");
  assert.ok(!penny.includes("SPY"), "ETF ist kein Penny-Kandidat");
  assert.ok(!penny.includes("GC"), "Future ist kein Penny-Kandidat");

  // VOLATILE: nur mit Metrik ≥ 0,60.
  assert.deepEqual(uniqueSymbolsOf("VOLATILE"), ["TINY"], "nur TINY hat volatility 1,4");

  // LIQUID: volume24h ≥ 10 Mio.
  const liquid = uniqueSymbolsOf("LIQUID");
  assert.ok(liquid.includes("SPY") && liquid.includes("BTC"));
  assert.ok(!liquid.includes("TINY"), "250k Volumen ist nicht liquide genug");
});

test("resolveSegmentInstruments: leere Registry ergibt leere Liste (kein Crash)", () => {
  const registry = freshRegistry();
  for (const segmentId of ["ALL", "INDICES", "PENNY", "VOLATILE"]) {
    assert.deepEqual(resolveSegmentInstruments(registry, findMissionSegment(segmentId)!), []);
  }
});

// ── 3) Kontext-Auflösung ─────────────────────────────────────────────────────

test("missionUniverseContext: Einzel-Symbol verhält sich wie vor v1.35.0", async () => {
  const ctx = await missionUniverseContext({ symbol: "BTC", scope: "SINGLE_SYMBOL", segment: null });
  assert.equal(ctx.scope, "SINGLE_SYMBOL");
  assert.equal(ctx.focusSymbol, "BTC");
  assert.deepEqual(ctx.candidates, ["BTC"]);
  assert.equal(ctx.warning, null);
  assert.equal(ctx.enforceScope, true);
  assert.deepEqual(ctx.promptLines, [], "Einzel-Symbol braucht keine Universums-Zeilen");

  // Fehlendes Symbol → Fallback + Legacy-Toleranz (keine Blockade).
  const legacy = await missionUniverseContext({ symbol: null, scope: "SINGLE_SYMBOL", segment: null });
  assert.equal(legacy.focusSymbol, DEFAULT_FOCUS_SYMBOL);
  assert.equal(legacy.enforceScope, false);
  assert.match(legacy.warning ?? "", /Legacy-Verhalten/);

  // Ohne scope-Feld (Alt-Zeile) gilt ebenfalls SINGLE_SYMBOL:
  const implicit = await missionUniverseContext({ symbol: "ETH" });
  assert.equal(implicit.scope, "SINGLE_SYMBOL");
  assert.equal(implicit.focusSymbol, "ETH");
});

test("missionUniverseContext: Markt-Scan liefert Kandidaten, Regel und Prompt-Zeilen", async () => {
  // Eigenes Universum für den Singleton der Registry:
  const dir = mkdtempSync(path.join(tmpdir(), "mission-universe-singleton-"));
  dirs.push(dir);
  process.env.UNIVERSE_DATA_DIR = dir;
  resetRegistryForTests();
  seedTestUniverse(new InstrumentRegistry({ dir }));

  const ctx = await missionUniverseContext({ symbol: null, scope: "SCAN_UNIVERSE", segment: "INDICES" });
  assert.equal(ctx.scope, "SCAN_UNIVERSE");
  assert.equal(ctx.segmentId, "INDICES");
  assert.equal(ctx.segmentLabel, "Indizes & ETFs");
  assert.equal(ctx.enforceScope, true);
  assert.equal(ctx.warning, null);
  assert.deepEqual([...ctx.candidates].sort(), ["SPX", "SPY"]);
  assert.equal(ctx.focusSymbol, "SPY", "Fokus = liquidester Kandidat");
  assert.ok(isSymbolInMissionScope(ctx, "SPY"));
  assert.equal(isSymbolInMissionScope(ctx, "BTC"), false);

  const prompt = ctx.promptLines.join("\n");
  assert.match(prompt, /UNIVERSUM: Indizes & ETFs/);
  assert.match(prompt, /SEGMENT-REGEL: assetClass/);
  assert.match(prompt, /KANDIDATEN: /);
  assert.match(prompt, /blockiert/, "der Prompt muss die Mandatsregel nennen");
});

test("missionUniverseContext: unbekanntes oder leeres Segment blockt (fail-closed)", async () => {
  const unknown = await missionUniverseContext({ symbol: null, scope: "SCAN_UNIVERSE", segment: "GIBT_ES_NICHT" });
  assert.deepEqual(unknown.candidates, []);
  assert.equal(unknown.enforceScope, true);
  assert.match(unknown.warning ?? "", /Segment fehlt oder ist unbekannt/);
  assert.equal(isSymbolInMissionScope(unknown, "SPY"), false);

  const dir = mkdtempSync(path.join(tmpdir(), "mission-universe-empty-"));
  dirs.push(dir);
  process.env.UNIVERSE_DATA_DIR = dir;
  resetRegistryForTests();
  new InstrumentRegistry({ dir }).load();

  const empty = await missionUniverseContext({ symbol: null, scope: "SCAN_UNIVERSE", segment: "COMMODITIES" });
  assert.deepEqual(empty.candidates, []);
  assert.match(empty.warning ?? "", /0 Kandidaten/);
  assert.match(empty.warning ?? "", /universe:seed:markets/, "die Warnung muss die Abhilfe nennen");
  assert.equal(isSymbolInMissionScope(empty, "GC"), false);
});

test("missionFocusSymbol: Scan-Mission nutzt den liquidesten Kandidaten", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mission-universe-focus-"));
  dirs.push(dir);
  process.env.UNIVERSE_DATA_DIR = dir;
  resetRegistryForTests();
  seedTestUniverse(new InstrumentRegistry({ dir }));

  assert.equal(await missionFocusSymbol({ scope: "SCAN_UNIVERSE", segment: "INDICES", symbol: null }, "BTC"), "SPY");
  assert.equal(await missionFocusSymbol({ scope: "SCAN_UNIVERSE", segment: "COMMODITIES", symbol: null }, "BTC"), "GC");
  assert.equal(await missionFocusSymbol({ scope: "SINGLE_SYMBOL", symbol: "ETH", segment: null }, "BTC"), "ETH");
  // Unauflösbares Segment → Fallback, damit Indikatoren nie ohne Symbol laufen:
  assert.equal(await missionFocusSymbol({ scope: "SCAN_UNIVERSE", segment: "GIBT_ES_NICHT", symbol: null }, "BTC"), "BTC");
});

// ── 4) Kandidaten-Zählung für die UI ─────────────────────────────────────────

test("segmentCandidateCounts: zählt eindeutige Symbole statt Venue-Zeilen", () => {
  // SPY liegt auf drei Venues (ALPACA, IBKR, PAPER) — das Mandat kennt SPY
  // trotzdem nur einmal. Ohne Deduplikation würde die Segment-Auswahl „3
  // Instrumente“ versprechen und die Mission hätte zwei Kandidaten.
  const dir = mkdtempSync(path.join(tmpdir(), "mission-universe-counts-"));
  dirs.push(dir);
  process.env.UNIVERSE_DATA_DIR = dir;
  resetRegistryForTests();
  new InstrumentRegistry({ dir }).upsertMany(
    [
      { venue: "ALPACA", symbol: "SPY", assetClass: "etf", marketType: "spot", volume24h: 30_000_000_000 },
      { venue: "IBKR", symbol: "SPY", assetClass: "etf", marketType: "spot", volume24h: 25_000_000_000 },
      { venue: "PAPER", symbol: "SPY", assetClass: "etf", marketType: "spot", volume24h: 20_000_000_000 },
      { venue: "PAPER", symbol: "BTC", assetClass: "crypto", marketType: "spot", volume24h: 900_000_000 },
    ],
    "test:mission-universe",
    "SEED"
  );

  const counts = segmentCandidateCounts();
  assert.equal(counts.INDICES, 1, "drei Venue-Zeilen, ein Symbol");
  assert.equal(counts.CRYPTO, 1);
  assert.equal(typeof counts.ALL, "number");
});

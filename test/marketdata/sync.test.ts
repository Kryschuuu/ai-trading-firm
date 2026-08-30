/**
 * `MarketDataSyncService` — Unit-Tests (MDSYNC-001 §4).
 *
 * Die zehn Pflichtfälle des Tickets, plus der Zusatzfälle, die das Design
 * trägt: Determinismus der Kappung, Bulk-Ticker-Budget, degraded vs. strict,
 * Idempotenz und JSON-Serialiserbarkeit des `SyncResult`.
 *
 * Mock-Adapter nur — kein HTTP, kein PrivateClient, keine Credentials.
 * Die Engine-Suite mit Venue-Mock-HTTP liegt bewusst separat:
 * `src/marketdata/__tests__/sync.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../src/universe/registry";
import {
  formatDegradedLog,
  formatSyncLog,
  InsufficientCandleLimitError,
  MarketDataSyncService,
  rankInstruments,
  resolveSyncOptions,
  SyncPartialFailureError,
  UnsupportedVenueError,
  type SyncResult,
} from "../../src/marketdata";
import { syncErrorsToDataErrors } from "../../src/marketdata/dataErrors";
import {
  barsOf,
  instrumentOf,
  mockMarketDataAdapter,
  symbols,
  syncHarness,
  tempDir,
  trendingCandles,
} from "./fixtures";
import path from "node:path";

// ── 1 ───────────────────────────────────────────────────────────────────────
test("sync upserts discovered instruments into registry", async () => {
  const { adapter } = mockMarketDataAdapter({ instruments: [instrumentOf("BTCUSDT"), instrumentOf("ETHUSDT")] });
  const { service, registry } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.ok(registry.size > 0, "Registry muss nach dem Sync Instrumente enthalten");
  assert.equal(registry.size, 2);
  assert.equal(result.discovered, 2);
  assert.equal(result.synced, 2);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.failures, []);
  // Quelle des Upserts ist der Sync, nicht der Seed — Auditierbarkeit.
  assert.ok(registry.get("BITUNIX:BTCUSDT"));
  assert.ok(registry.get("BITUNIX:ETHUSDT"));
});

// ── 2 ───────────────────────────────────────────────────────────────────────
test("market sync enriches 24h volume", async () => {
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    quoteVolOf: () => 42_500_000,
  });
  const { service, registry } = syncHarness(adapter);

  await service.syncVenue("BITUNIX");

  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc);
  assert.ok(btc!.volume24h !== null && btc!.volume24h > 0, `volume24h > 0 erwartet, war ${btc!.volume24h}`);
  assert.equal(btc!.volume24h, 42_500_000, "volume24h kommt aus ticker.quoteVol");
  assert.equal(btc!.lastSeen, "2026-08-29T00:00:00.000Z", "lastSeen wird beim Sync gestempelt");
});

// ── 3 ───────────────────────────────────────────────────────────────────────
test("market sync calculates spread from best bid/ask", async () => {
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    bookFor: () => ({ bid: 100, ask: 100.02 }),
  });
  const { service, registry } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc);
  assert.ok(btc!.spread !== null, "Spread muss aus dem Orderbook gefüllt sein");
  assert.ok(Math.abs(btc!.spread! - 0.00019998) < 1e-8, `≈2 bp erwartet, war ${btc!.spread}`);
  assert.equal(result.spreadsUnknown, 0);

  // Und umgekehrt: leeres Buch ⇒ null (unbekannt), kein 0 und kein Fehler.
  const empty = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    bookFor: () => ({ bid: Number.NaN, ask: Number.NaN }),
  });
  const emptyHarness = syncHarness(empty.adapter);
  const emptyResult = await emptyHarness.service.syncVenue("BITUNIX");
  assert.equal(emptyHarness.registry.get("BITUNIX:BTCUSDT")!.spread, null);
  assert.equal(emptyResult.spreadsUnknown, 1, "ein Instrument mit unbekanntem Spread");
  assert.equal(emptyResult.degraded, false, "bekannter Spread-missing ist Data-Quality, kein Fehler");
});

// ── 4 ───────────────────────────────────────────────────────────────────────
test("sync persists candles per timeframe", async () => {
  const { adapter } = mockMarketDataAdapter({ instruments: [instrumentOf("BTCUSDT")] });
  const { service, history } = syncHarness(adapter, "BITUNIX", {
    timeframes: ["5m", "15m", "30m", "1h"],
    candleLimit: 150,
  });

  const result = await service.syncVenue("BITUNIX");

  assert.equal(barsOf(history, "BITUNIX:BTCUSDT", "5m"), 150);
  assert.equal(barsOf(history, "BITUNIX:BTCUSDT", "1h"), 150);
  assert.equal(result.candlesByTimeframe["5m"]?.bars, 150);
  assert.equal(result.candlesByTimeframe["5m"]?.instruments, 1);
  // Jede Zeile trägt Provenienz und den Timeframe — sonst wären die Reihen
  // des Stores nicht trennbar (HIST-TF-005).
  const rows = history.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "5m" });
  assert.equal(rows[0].venue, "BITUNIX");
  assert.equal(rows[0].feed, "BITUNIX:rest");
  assert.ok(rows.every((r) => r.timeframe === "5m"));
  assert.ok(rows.every((r, i) => i === 0 || r.ts > rows[i - 1].ts), "Bars müssen ts-aufsteigend sein");
});

// ── 5 ───────────────────────────────────────────────────────────────────────
test("sync uses one bulk ticker call, not one per instrument", async () => {
  const instruments = symbols(6).map((s) => instrumentOf(s));
  const { adapter, calls } = mockMarketDataAdapter({ instruments });
  const { service } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.equal(calls.tickerBatches.length, 1, "genau EIN Bulk-Ticker-Call für 6 Instrumente");
  assert.equal(calls.orderBook.length, 6, "N × depth (Spread geht nur aus dem Orderbook)");
  assert.deepEqual(calls.ticker, [], "kein per-Symbol-getTicker bei vollständigem Bulk");
  assert.equal(calls.candles.length, 6 * 4, "N × M × kline (M = 4 Timeframes)");
  assert.equal(calls.discover, 1, "1 × trading_pairs");
  assert.equal(result.tickersEnriched, 6);
  assert.equal(result.orderbooksEnriched, 6);
});

test("ohne Bulk-Endpoint fällt der Service auf per-Symbol-Ticker zurück", async () => {
  const { adapter, calls } = mockMarketDataAdapter({
    instruments: symbols(3).map((s) => instrumentOf(s)),
    noBulkTickers: true,
  });
  const { service } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.equal(calls.tickerBatches.length, 0);
  assert.equal(calls.ticker.length, 3);
  assert.equal(result.tickersEnriched, 3);
});

// ── 6 ───────────────────────────────────────────────────────────────────────
test("unsupported venue throws UnsupportedVenueError", async () => {
  const { adapter, calls } = mockMarketDataAdapter({});
  const { service } = syncHarness(adapter);

  await assert.rejects(
    () => service.syncVenue("NIRVANA"),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedVenueError);
      assert.equal(error.code, "UNSUPPORTED_VENUE");
      assert.match(error.message, /NIRVANA/);
      return true;
    },
    "unbekannte Venue muss vor jedem Request abbrechen"
  );
  assert.equal(calls.discover, 0, "kein Request vor der Venue-Prüfung");
});

// ── 7 ───────────────────────────────────────────────────────────────────────
test("adapter failure on single symbol does not abort sync (continueOnError)", async () => {
  const failing = "SYM002USDT";
  const { adapter, calls } = mockMarketDataAdapter({
    instruments: symbols(5).map((s) => instrumentOf(s)),
    failOrderBookFor: [failing],
  });
  const { service, registry, history } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.equal(result.degraded, true, "Lauf ist degradiert, nicht fehlgeschlagen");
  assert.equal(result.failures.length, 1, `genau 1 isolierter Fehler, war ${result.failures.length}`);
  assert.equal(result.failures[0].stage, "orderbook");
  assert.equal(result.failures[0].symbol, failing);
  assert.ok(result.failures[0].message.length > 0);
  // Restliche Instrumente sind vollständig persistiert.
  assert.equal(registry.size, 5, "alle 5 Instrumente bleiben in der Registry");
  assert.equal(result.synced, 5);
  assert.equal(barsOf(history, `BITUNIX:${failing}`, "1h"), 150, "Candle-Backfill läuft trotz Depth-Fehler");
  assert.ok(calls.candles.length >= 5 * 4);
  // MDERR-006: der Fehler ist als Datenfehler des Instruments klassifiziert.
  assert.equal(typeof result.failures[0].reason, "string");
  assert.ok(syncErrorsToDataErrors(result.failures).size <= 1);
  // Und die Warnung für den Betreiber existiert.
  assert.match(formatDegradedLog(result) as string, /DEGRADED/);
});

test("continueOnError=false bricht mit SyncPartialFailureError ab", async () => {
  const { adapter, calls } = mockMarketDataAdapter({
    instruments: symbols(4).map((s) => instrumentOf(s)),
    failCandlesFor: ["SYM000USDT"],
  });
  const { service } = syncHarness(adapter, "BITUNIX", { continueOnError: false });

  await assert.rejects(() => service.syncVenue("BITUNIX"), (error: unknown) => {
    assert.ok(error instanceof SyncPartialFailureError);
    assert.equal(error.code, "SYNC_PARTIAL_FAILURE");
    assert.equal(error.venue, "BITUNIX");
    assert.ok(error.failureCount >= 4, `mind. 4 Timeframe-Fehler, war ${error.failureCount}`);
    assert.ok(error.failures.length >= 1 && error.failures.length <= 10, "Fehlerliste ist gekürzt, aber nicht leer");
    return true;
  });
  assert.equal(calls.discover, 1);
});

// ── 8 ───────────────────────────────────────────────────────────────────────
test("maxInstruments cap is deterministic and respected", async () => {
  const instruments = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"].map((symbol) => instrumentOf(symbol));
  // Volumen gegen den Alphabet: die Kappung NACH Volumen darf nicht mit der
  // symbolalphabetischen Kappung verwechselt werden.
  const volume: Record<string, number> = {
    AAAUSDT: 1_000,
    BBBUSDT: 900_000_000,
    CCCUSDT: 50_000,
    DDDUSDT: 800_000_000,
    EEEUSDT: 10_000,
  };
  const { adapter } = mockMarketDataAdapter({ instruments, quoteVolOf: (symbol) => volume[symbol] ?? 0 });
  const { service, registry } = syncHarness(adapter, "BITUNIX", { maxInstruments: 2 });

  const first = await service.syncVenue("BITUNIX");
  const ids = registry.query({ pageSize: 500 }).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["BITUNIX:BBBUSDT", "BITUNIX:DDDUSDT"], "die zwei liquidesten Instrumente bleiben");
  assert.equal(first.discovered, 5);
  assert.equal(first.synced, 2);
  assert.equal(first.skipped, 3);

  // Determinismus: identische Eingabe ⇒ identische Auswahl, zweiter Lauf
  // schreibt 0 neue Bars (Dedup) statt die Auswahl zu verändern.
  const second = await service.syncVenue("BITUNIX");
  assert.equal(second.synced, first.synced);
  assert.deepEqual(
    second.failures.map((f) => f.symbol),
    first.failures.map((f) => f.symbol)
  );
});

test("ohne Ticker wird alphabetisch nach Symbol gekappt", () => {
  const instruments = ["ZZZUSDT", "MMMUSDT", "AAAUSDT", "BBBUSDT"].map((symbol) => instrumentOf(symbol));
  const ranked = rankInstruments(instruments, new Map());
  assert.deepEqual(
    ranked.map((i) => i.symbol),
    ["AAAUSDT", "BBBUSDT", "MMMUSDT", "ZZZUSDT"],
    "alphabetisch, wenn kein Volumen bekannt ist"
  );
});

// ── 9 ───────────────────────────────────────────────────────────────────────
test("candleLimit below requiredWarmupCandles is rejected with actionable error", () => {
  assert.throws(
    () => resolveSyncOptions({ candleLimit: 30 }, 61),
    (error: unknown) => {
      assert.ok(error instanceof InsufficientCandleLimitError);
      assert.equal(error.code, "CANDLE_LIMIT_TOO_SMALL");
      assert.match(error.message, /candleLimit=30 ist zu klein/);
      assert.match(error.message, /mindestens 61 Kerzen/);
      assert.match(error.message, /Momentum-Lookback 60 \+ 1/);
      assert.match(error.message, /Der Scanner würde alle Instrumente mit min-candles ablehnen/);
      assert.match(error.message, /--candle-limit=61/);
      return true;
    },
    "zu kleines Limit muss laut abbrechen — sonst entsteht der leere Trichter"
  );

  // Konstruiert über den Service (Default-Auflösung ohne Injektion): derselbe
  // Fehler, bevor der erste Request abgeht.
  const registry = new InstrumentRegistry({ dir: tempDir(), autoSave: false });
  const history = new HistoricalStore(path.join(tempDir(), "history"));
  assert.throws(
    () => new MarketDataSyncService(registry, history, new Map(), { candleLimit: 5 }),
    InsufficientCandleLimitError
  );

  // Grenzwert-exakt erlaubt: required == limit.
  assert.equal(resolveSyncOptions({ candleLimit: 61 }, 61).candleLimit, 61);
  // Default = max(150, required).
  assert.equal(resolveSyncOptions({}, 61).candleLimit, 150);
  assert.equal(resolveSyncOptions({}, 400).candleLimit, 400);
});

// ── 10 ──────────────────────────────────────────────────────────────────────
test("sync is idempotent: second run does not duplicate bars", async () => {
  const { adapter } = mockMarketDataAdapter({ instruments: [instrumentOf("BTCUSDT")] });
  const { service, history } = syncHarness(adapter);

  const first = await service.syncVenue("BITUNIX");
  const barsBefore = history.count();
  const second = await service.syncVenue("BITUNIX");
  const barsAfter = history.count();

  assert.equal(barsAfter, barsBefore, `Bars dürfen nicht akkumulieren (${barsBefore} → ${barsAfter})`);
  assert.equal(second.candlesByTimeframe["1h"]?.bars, 0, "zweiter Lauf schreibt 0 neue Bars");
  assert.ok(first.candlesByTimeframe["1h"]!.bars > 0, "erster Lauf schreibt Bars");
  assert.deepEqual(
    history.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" }).length,
    history.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" }).length
  );
});

// ── Zusatzfälle, die das Design tragen ───────────────────────────────────────

test("syncAll() läuft über alle registrierten Venues, sequentiell und sortiert", async () => {
  const dir = tempDir();
  const registry = new InstrumentRegistry({ dir, autoSave: false });
  const history = new HistoricalStore(path.join(dir, "history"));
  const alpha = mockMarketDataAdapter({ instruments: [instrumentOf("BTCUSDT", "ALPHA")], venue: "ALPHA" });
  const beta = mockMarketDataAdapter({ instruments: [instrumentOf("ETHUSDT", "BETA")], venue: "BETA" });
  const service = new MarketDataSyncService(
    registry,
    history,
    new Map([
      ["BETA", beta.adapter],
      ["ALPHA", alpha.adapter],
    ]),
    { clock: () => new Date("2026-08-29T00:00:00.000Z"), requiredWarmupCandles: 61 }
  );

  const results = await service.syncAll();

  assert.deepEqual(results.map((r) => r.venue), ["ALPHA", "BETA"], "sortierte Venue-Reihenfolge (deterministisch)");
  assert.equal(results.reduce((sum, r) => sum + r.synced, 0), 2);
  assert.deepEqual(registry.query({ pageSize: 10 }).items.map((i) => i.id).sort(), [
    "ALPHA:BTCUSDT",
    "BETA:ETHUSDT",
  ]);
});

test("SyncResult ist vollständig JSON-serialisierbar (roundtrip-stabil)", async () => {
  const { adapter } = mockMarketDataAdapter({ instruments: symbols(3).map((s) => instrumentOf(s)) });
  const { service } = syncHarness(adapter, "BITUNIX", { maxInstruments: 2 });
  const result = await service.syncVenue("BITUNIX");

  const clone = JSON.parse(JSON.stringify(result)) as SyncResult;
  assert.deepEqual(clone, result, "JSON-Roundtrip darf keine Felder verlieren");
  // Keine nicht-serialisierbaren Werte im Contract (Map/Set/function): ein
  // `undefined` nach Roundtrip wäre ein verlorener Zähler.
  assert.equal(Object.keys(clone).length, Object.keys(result).length);
  const record = clone as unknown as Record<string, unknown>;
  for (const key of ["venue", "startedAt", "finishedAt"]) assert.equal(typeof record[key], "string", `${key} ist ein String`);
  for (const key of ["discovered", "synced", "skipped", "tickersEnriched", "orderbooksEnriched", "spreadsUnknown"]) {
    assert.equal(typeof record[key], "number", `${key} muss eine Zahl sein`);
  }
  assert.equal(result.degraded, false, "Kappung ist kein Fehler — nur failures degradieren");
  assert.equal(result.skipped, 1);
});

test("Logformat: discovery/tickers/orderbooks/candles-Zeilen mit Zählern", async () => {
  const lines: string[] = [];
  const { adapter } = mockMarketDataAdapter({ instruments: symbols(4).map((s) => instrumentOf(s)) });
  const { service } = syncHarness(adapter, "BITUNIX", {
    logger: (_level, line) => {
      lines.push(line);
    },
  });
  const result = await service.syncVenue("BITUNIX");

  assert.ok(lines.includes("[market-sync] BITUNIX discovery: 4 instruments"), lines.join("\n"));
  assert.ok(lines.includes("[market-sync] tickers enriched: 4"));
  assert.ok(lines.includes("[market-sync] orderbooks enriched: 4"));
  assert.ok(
    lines.some((l) => /^\[market-sync\] 5m candles: 4\/4 \(600\/600 bars\)$/.test(l)),
    `5m-candles-Zeile im Format "instruments/total (bars/expected)" erwartet:\n${lines.join("\n")}`
  );
  assert.ok(lines.some((l) => l.startsWith("[market-sync] duration:")));
  // Keine Symbole in den Log-Zählern (Symbolnamen wären personen-/marktbezug,
  // in diesem Format aber bewusst nicht enthalten).
  assert.equal(lines.some((l) => l.includes("SYM000USDT")), false, "Logs nennen keine Symbole");
  assert.equal(formatSyncLog(result).length, lines.length);
});

test("symbolAllowlist begrenzt die Synchronisation auf die genannten Symbole", async () => {
  const { adapter, calls } = mockMarketDataAdapter({ instruments: symbols(5).map((s) => instrumentOf(s)) });
  const { service, registry } = syncHarness(adapter, "BITUNIX", {
    symbolAllowlist: ["SYM001USDT", "SYM003USDT"],
  });

  const result = await service.syncVenue("BITUNIX");

  assert.equal(result.discovered, 5);
  assert.equal(result.synced, 2);
  assert.equal(result.skipped, 3);
  assert.equal(registry.size, 2);
  assert.deepEqual(
    registry.query({ pageSize: 10 }).items.map((i) => i.symbol).sort(),
    ["SYM001USDT", "SYM003USDT"]
  );
  assert.equal(calls.orderBook.length, 2, "Depth nur für die Allowlist-Symbole");
});

test("ungültige Discovery-Symbole werden abgelehnt, bevor sie in eine URL gelangen", async () => {
  const hostile = {
    ...instrumentOf("BTCUSDT"),
    // Path-Injection + Query-Separator: darf weder Pfad noch Query erreichen.
    symbol: "../../admin?debug=1",
  };
  const { adapter } = mockMarketDataAdapter({ instruments: [hostile, instrumentOf("ETHUSDT")] });
  const { service, registry } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.equal(registry.size, 1, "nur das saubere Symbol wird registriert");
  assert.equal(result.discovered, 2, "discovered zählt die Venue-Zeilen, nicht die brauchbaren");
  assert.equal(result.synced, 1);
  assert.equal(result.skipped, 1, "die abgelehnte Zeile ist als skipped sichtbar");
  assert.ok(
    result.failures.some((f) => f.stage === "discovery" && f.reason === "INVALID_SYMBOL"),
    `INVALID_SYMBOL erwartet, war ${JSON.stringify(result.failures)}`
  );
  // Die Meldung nennt den Grund, aber nicht die Roheingabe (Log-Injection).
  assert.equal(JSON.stringify(result.failures).includes("..%2Fadmin"), false);
  assert.equal(JSON.stringify(result.failures).includes("debug=1"), false);
});

test("Kerzen-Cap: ein Response mit 10k Kerzen wird auf das Sync-Limit gekappt", async () => {
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    candlesFor: () => trendingCandles(0, 10_000),
  });
  const { service, history } = syncHarness(adapter, "BITUNIX", {
    timeframes: ["1h"],
    candleLimit: 150,
  });

  const result = await service.syncVenue("BITUNIX");

  assert.ok(result.candlesByTimeframe["1h"]!.bars <= 2_000, "maxCandlesPerResponse greift");
  assert.equal(history.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" }).length, result.candlesByTimeframe["1h"]!.bars);
  assert.ok(
    result.failures.some((f) => f.message.includes("gekappt")),
    "Kappung muss im Ergebnis sichtbar sein"
  );
});

test("Timeframe-Validierung: gemischte Reihen werden vor dem ersten Request abgelehnt", () => {
  assert.throws(
    () => resolveSyncOptions({ timeframes: ["5m", "15min"] as never }, 61),
    /ist nicht in der Allowlist/
  );
  assert.throws(() => resolveSyncOptions({ timeframes: [] }, 61), /darf nicht leer sein/);
  assert.throws(() => resolveSyncOptions({ timeframes: ["5m", "5m"] }, 61), /doppelt/);
  assert.throws(() => resolveSyncOptions({ maxInstruments: 0 }, 61), /maxInstruments muss eine positive Ganzzahl/);
  assert.throws(() => resolveSyncOptions({ symbolAllowlist: ["BTC USDT?"] }, 61), /Symbol-Allowlist/);
});

test("HistoricalStore-Schlüssel == Registry-Schlüssel (der Kern des Fehlers)", async () => {
  // Der Defekt war: der Store wurde mit einer ID befüllt, die die Registry
  // nie vergibt. Der Scanner findet dann 0 Kerzen, obwohl Daten da sind.
  const { adapter } = mockMarketDataAdapter({ instruments: [{ ...instrumentOf("BTCUSDT"), id: "bitunix:btcusdt" }] });
  const { service, registry, history } = syncHarness(adapter);

  await service.syncVenue("bitunix");

  const stored = [...registry.query({ pageSize: 10 }).items];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "BITUNIX:BTCUSDT", "Venue/Symbol werden kanonisch gehoben");
  assert.equal(
    history.query({ instrumentId: stored[0].id, timeframe: "1h" }).length,
    150,
    "Kerzen liegen unter genau der ID, die der Scanner benutzt"
  );
});

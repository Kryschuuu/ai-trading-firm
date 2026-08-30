/**
 * CLI-Schicht des Market-Data-Syncs (MDSYNC-001 §3.7/§3.8).
 *
 * Geprüft werden das reine Parsing (ohne Side-Effecte), Hilfe-, Gate- und
 * Warmup-Meldungen samt Exit-Codes sowie die Redaction der Fehlermeldung.
 * Der Auto-Run-Guard in `scripts/market-sync.ts` hält den Import schadfrei.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  buildHelpText,
  describeSyncError,
  parseSyncArgs,
  runMarketSyncCli,
  runMarketSyncStatus,
} from "../../scripts/market-sync";
import { MarketDataSyncService } from "../../src/marketdata";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../src/universe/registry";
import type { MarketDataAdapter } from "../../src/marketdata";
import { instrumentOf, tempDir, trendingCandles } from "./fixtures";

function fakeAdapter(): MarketDataAdapter {
  const instruments = [instrumentOf("CLIUSDT", "FAKE"), instrumentOf("CLIVUSDT", "FAKE")];
  return {
    venue: "FAKE",
    async discoverInstruments() {
      return instruments;
    },
    async getTicker(symbol) {
      return { symbol, price: 100, source: "fake", ts: 0, quoteVol: 40_000_000 };
    },
    async getOrderBook(symbol) {
      return { symbol, bids: [{ price: 99.99, qty: 1 }], asks: [{ price: 100.01, qty: 1 }], ts: 0 };
    },
    async getCandles(symbol, _timeframe, limit) {
      const index = instruments.findIndex((i) => i.symbol === symbol);
      return trendingCandles(index, Math.min(61, limit));
    },
  };
}
import { gateMessage } from "../../scripts/lib/market-sync";
import { defaultRequiredWarmupCandles } from "../../src/marketdata";

const HISTORY_FILE = path.join(process.cwd(), "data", "history", "candles.ndjson");

test("parseSyncArgs: nur genannte Flags landen im Optionsobjekt", () => {
  const empty = parseSyncArgs([]);
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.equal(empty.parsed.options.venue, "BITUNIX", "Venue-Default");
  assert.equal(empty.parsed.options.timeframes, undefined, "Timeframe-Default liegt im Service");
  assert.equal(empty.parsed.options.candleLimit, undefined, "Limit-Default liegt im Service");
  assert.equal(empty.parsed.dryRun, false);
  assert.equal(empty.parsed.json, false);
  assert.equal(empty.parsed.manifest, true, "Manifest ist an, --no-manifest schaltet ab");

  const full = parseSyncArgs([
    "--venue=BINANCE",
    "--timeframes=5m,1h",
    "--symbols=btcusdt, ETHUSDT",
    "--candle-limit=200",
    "--max-instruments=50",
    "--concurrency=6",
    "--strict",
    "--dry-run",
    "--json",
    "--no-manifest",
  ]);
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.deepEqual(full.parsed.options, {
    venue: "BINANCE",
    timeframes: ["5m", "1h"],
    symbols: ["BTCUSDT", "ETHUSDT"],
    candleLimit: 200,
    maxInstruments: 50,
    concurrency: 6,
    strict: true,
  });
  assert.equal(full.parsed.dryRun, true);
  assert.equal(full.parsed.json, true);
  assert.equal(full.parsed.manifest, false);
});

test("parseSyncArgs: Bedienfehler werden abgelehnt, bevor ein Request möglich ist", () => {
  const cases: [string[], RegExp][] = [
    [["positionale"], /Erwartet --option=value/],
    [["--verbose"], /Unbekannte Option "--verbose"/],
    [["--venue"], /verletzt das Format/],
    [["--venue=BTC USDT"], /verletzt das Format/],
    [["--timeframes=2m"], /ungültige\(r\) "2m"/],
    [["--timeframes=5m,5m"], /Duplikate/],
    [["--timeframes=,"], /mindestens einen Wert/],
    [["--candle-limit=abc"], /positive Ganzzahl/],
    [["--candle-limit=0"], /positive Ganzzahl/],
    [["--candle-limit=2001"], /harte Obergrenze 2000/],
    [["--max-instruments=-1"], /positive Ganzzahl/],
    [["--max-instruments=1001"], /harte Obergrenze 1000/],
    [["--concurrency=9"], /harte Grenze 8/],
    [["--symbols="], /kommagetrennte Liste/],
    [["--symbols=../../etc/passwd"], /verletzt die Symbol-Allowlist/],
    [["--json=vielleicht"], /--json akzeptiert nur true\/false/],
    [["--dry-run=1x"], /--dry-run akzeptiert nur true\/false/],
    [["--strict=ja"], /--strict akzeptiert nur true\/false/],
  ];
  for (const [argv, pattern] of cases) {
    const parsed = parseSyncArgs(argv);
    assert.equal(parsed.ok, false, `${argv.join(" ")} muss ablehnen`);
    if (parsed.ok) continue;
    assert.match(parsed.error, pattern, `Meldung für ${argv.join(" ")}`);
  }
});

test("parseSyncArgs: 4h/1d sind gültige Timeframes, --help kurzschließt vor jeder Validierung", () => {
  const ok = parseSyncArgs(["--timeframes=4h,1d"]);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.parsed.options.timeframes, ["4h", "1d"]);

  for (const argv of [["--help"], ["-h"], ["--help", "--timeframes=2m"], ["-h", "Quatsch"]]) {
    const parsed = parseSyncArgs(argv);
    assert.equal(parsed.ok, false, `${argv.join(" ")} führt keinen Sync aus`);
    if (parsed.ok) return;
    assert.equal(parsed.help, true, "--help ist die Hilfe, kein Bedienfehler");
  }

  // Boolean-Flags dulden nur true/false — und `--strict` erreicht den Service.
  assert.equal(parseSyncArgs(["--strict=true"]).ok, true);
  if (parseSyncArgs(["--strict=true"]).ok) {
    const parsed = parseSyncArgs(["--strict=false", "--dry-run=0", "--no-manifest=false", "--json=1"]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.parsed.options.strict, undefined, "--strict=false ist der Default");
    assert.equal(parsed.parsed.dryRun, false);
    assert.equal(parsed.parsed.json, true);
    assert.equal(parsed.parsed.manifest, true, "--no-manifest=false lässt das Manifest an");
  }
});

test("buildHelpText erklärt jede Option, die Gates und die Exit-Codes", () => {
  const help = buildHelpText();
  for (const needle of [
    "--venue=",
    "--timeframes=",
    "--symbols=",
    "--candle-limit=",
    "--max-instruments=",
    "--concurrency=",
    "--strict",
    "--dry-run",
    "--json",
    "--no-manifest",
    "--help",
    "BITUNIX_ENABLED=true",
    "8 req/s",
    "requiredWarmupCandles",
    "Exit-Codes:",
    "sauberer Lauf",
    "degradierter Lauf",
    "Bedienfehler",
  ]) {
    assert.ok(help.includes(needle), `Hilfe enthält „${needle}“ nicht`);
  }
  // Der Warmup-Bedarf wird nicht hartcodiert, sondern aus der Config geholt.
  assert.ok(help.includes(String(defaultRequiredWarmupCandles())), "aktueller requiredWarmupCandles-Wert");
});

test("runMarketSyncCli: --help liefert Exit 0, ein Bedienfehler Exit 2 mit Hilfe", async () => {
  const help = await runMarketSyncCli(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.lines[0], /^market-sync —/);
  assert.equal(help.result, null, "Hilfe führt keinen Sync aus");

  const bad = await runMarketSyncCli(["--venue=BITUNIX", "--timeframes=7s"]);
  assert.equal(bad.exitCode, 2);
  assert.match(bad.lines[0], /ungültige\(r\) "7s"/);
  assert.ok(bad.lines.some((line) => line.includes("Verwendung:")), "Hilfe-Verweis nach dem Fehler");
});

test("runMarketSyncCli: nicht freigeschaltete Venues brechen mit Exit 2 und Behebung ab", async () => {
  const before = existsSync(HISTORY_FILE);

  const off = await runMarketSyncCli(["--venue=BITUNIX"], { env: {} });
  assert.equal(off.exitCode, 2);
  const offText = off.lines.join("\n");
  assert.match(offText, /nicht freigeschaltet \(Grund: VENUE_DISABLED\)/);
  assert.match(offText, /BITUNIX_ENABLED=true setzen/);

  const killed = await runMarketSyncCli(["--venue=BITUNIX"], {
    env: { BITUNIX_ENABLED: "true", MARKET_SYNC_ENABLED: "false" },
  });
  assert.equal(killed.exitCode, 2);
  assert.match(killed.lines.join("\n"), /MARKET_SYNC_ENABLED/);

  const unknown = await runMarketSyncCli(["--venue=EXCHANGE_X"], { env: {} });
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.lines.join("\n"), /UNKNOWN_VENUE/);

  // Gate-Antwort vor dem ersten Request: es entsteht keine Historie.
  assert.equal(existsSync(HISTORY_FILE), before, "nichts geschrieben");
});

test("runMarketSyncCli: --candle-limit unter dem Warmup-Bedarf ist ein Bedienfehler (Exit 2)", async () => {
  const run = await runMarketSyncCli(["--venue=BITUNIX", "--candle-limit=60"], { env: { BITUNIX_ENABLED: "true" } });
  assert.equal(run.exitCode, 2);
  const text = run.lines.join("\n");
  assert.match(text, /mindestens \d+ Kerzen/, "Der Bedarf wird beziffert, Text: " + text);
  assert.match(text, /requiredWarmupCandles/);
});

test("gateMessage: jeder Grund hat einen Behebungshinweis ohne Pfade oder URLs", () => {
  const reasons = ["KILL_SWITCH", "NOT_IN_ALLOWLIST", "VENUE_DISABLED", "UNKNOWN_VENUE", "INVALID_VENUE_KEY"] as const;
  for (const reason of reasons) {
    const venue = reason === "UNKNOWN_VENUE" ? "EXCHANGE_X" : "BITUNIX";
    const message = gateMessage(venue, [{ venue, reason }]);
    assert.ok(message.includes(`Grund: ${reason}`), message);
    assert.ok(message.includes("Behebung: "), message);
    assert.doesNotMatch(message, /https?:\/\//i);
    assert.doesNotMatch(message, /\.\.\//);
  }
  // Fehlender Skip-Eintrag fällt auf UNKNOWN_VENUE zurück.
  assert.ok(gateMessage("BITUNIX", []).includes("UNKNOWN_VENUE"));
});

test("parseSyncArgs: --status ist read-only und duldet keine Sync-Optionen", () => {
  const ok = parseSyncArgs(["--status", "--json"]);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.parsed.status, true);
  assert.equal(ok.parsed.json, true);

  const mixed = parseSyncArgs(["--status", "--venue=BITUNIX", "--timeframes=5m"]);
  assert.equal(mixed.ok, false);
  if (mixed.ok) return;
  assert.match(mixed.error, /--status kombiniert keine Sync-Optionen/);
  assert.match(mixed.error, /--venue, --timeframes/);

  const help = buildHelpText();
  assert.ok(help.includes("--status"), "Hilfe erklärt den Status-Modus");
});

test("runMarketSyncStatus: leerer Bestand ⇒ Exit 1 mit Behebung, bereit ⇒ Exit 0", () => {
  const dir = tempDir("mdsync-status-");
  const registry = new InstrumentRegistry({ dir: path.join(dir, "universe"), autoSave: true });
  const history = new HistoricalStore(path.join(dir, "history"));
  const lines: string[] = [];

  const cold = runMarketSyncStatus({ registry, history, logger: (line) => lines.push(line) });
  assert.equal(cold.exitCode, 1, lines.join("\n"));
  assert.equal(cold.report?.registryCount, 0);
  assert.equal(cold.report?.scannerReady, false);
  assert.match(lines.join("\n"), /Scanner bereit: nein/);
  assert.match(lines.join("\n"), /npm run universe:seed/);

  // Warmup schreiben (Sync in dieselben Senken) → Status dreht auf bereit.
  const service = new MarketDataSyncService(registry, history, new Map([["FAKE", fakeAdapter()]]), {
    logger: () => {},
    timeframes: ["1h"],
    candleLimit: 61,
  });
  return service.syncVenue("FAKE").then(() => {
    const warm = runMarketSyncStatus({ registry, history, json: true });
    assert.equal(warm.exitCode, 0, JSON.stringify(warm.report));
    assert.equal(warm.report?.registryCount, 2);
    assert.equal(warm.report?.dataReadyCount, 2, "Kerzen + Ticker + Spread vollständig");
    assert.equal(warm.report?.candlesRequired, defaultRequiredWarmupCandles());
    assert.match(warm.lines[0], /^\{"/, "--json: eine Zeile, maschinenlesbar");
    assert.doesNotMatch(warm.lines[0], /FAKE:|data\//, "kein Rohpfad, kein Symbol im Report");
  });
});

test("runMarketSyncCli: --status führt keinen Sync aus (kein Request, kein Write)", async () => {
  const before = existsSync(HISTORY_FILE);
  const run = await runMarketSyncCli(["--status", "--venue=BITUNIX"]);
  assert.equal(run.exitCode, 2, "Kombination ist ein Bedienfehler, kein stilles Ignorieren");
  assert.match(run.lines[0], /--status kombiniert keine Sync-Optionen/);
  assert.equal(existsSync(HISTORY_FILE), before);
});

test("describeSyncError: URLs und Kontrollzeichen überleben die Meldung nicht", () => {
  const hostile =
    "Depth fehlgeschlagen https://api.bitunix.com/x?api-key=S3CRET\n" +
    "zweite Zeile\n\u001b[31mANSI\u001b[0m " +
    "A".repeat(400);
  const message = describeSyncError(new Error(hostile));
  assert.doesNotMatch(message, /api-key/i);
  assert.doesNotMatch(message, /https?:\/\//i);
  assert.match(message, /\[url\]/);
  assert.doesNotMatch(message, /[\u0000-\u001f\u007f]/);
  assert.ok(message.length <= 300, `auf 300 Zeichen gekürzt, war ${message.length}`);
});

/**
 * End-to-End des Sync-CLI über die realen Schichten (MDSYNC-001 §3.6/§4).
 *
 * `runMarketSyncCli` → Feature-Gates → `registerAdapters()` →
 * `BitunixBrokerAdapter` → `BitunixPublicClient` → `BitunixHttp`
 * (Token-Bucket, Payload-Kappe) gegen den lokalen Fixture-Server, Persistenz
 * in ein temporäres Verzeichnis (`--dry-run`). Damit wird die Kette geprüft,
 * die ein Unit-Test nur stückweise sieht — inklusive der Zähler im Log.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { runMarketSyncCli } from "../../scripts/market-sync";
import { BitunixFixtureServer } from "../../tests/fixtures/bitunixFixtureServer";

const server = new BitunixFixtureServer();
after(() => server.stop());

test("CLI gegen Fixture-Server: Public-only, Zähler im Log, degradiert bei Lücken", async () => {
  const base = await server.start();
  const printed: string[] = [];
  const log = console.log;
  console.log = (msg?: unknown) => printed.push(String(msg));
  let exitCode = -1;
  let result: Awaited<ReturnType<typeof runMarketSyncCli>>["result"] = null;
  let lines: string[] = [];
  try {
    const run = await runMarketSyncCli(
      ["--venue=BITUNIX", "--dry-run", "--json", "--timeframes=1h", "--candle-limit=61"],
      {
        env: {
          BITUNIX_ENABLED: "true",
          BITUNIX_BASE_URL: base,
          // Nur der Fixture-Server ist http — production erzwingt TLS.
          BITUNIX_ALLOW_INSECURE_HTTP: "true",
        },
      }
    );
    exitCode = run.exitCode;
    result = run.result;
    lines = run.lines;
  } finally {
    console.log = log;
  }

  // Die Fixture liefert 2 nutzbare Paare (BTC/ETH) + eine kaputte Zeile (??),
  // die der Venue-Mapper verworfen hat — der Sync meldet nur die nutzbaren.
  // Ihr /tickers-Array enthält NUR BTCUSDT; der Fallback auf den Einzel-Ticker
  // antwortet für ETHUSDT mit einem fremden Symbol, was der Symbol-Guard
  // ablehnt. Genau dafür ist er da — der Lauf ist deshalb „degradiert“.
  assert.equal(exitCode, 1, printed.join("\n"));
  assert.ok(result, "SyncResult wurde geliefert");
  assert.equal(result!.venue, "BITUNIX");
  assert.equal(result!.discovered, 2);
  assert.equal(result!.synced, 2, "Ein fehlender Ticker überspringt das Instrument nicht");
  assert.equal(result!.tickersEnriched, 1);
  assert.equal(result!.degraded, true);
  assert.equal(result!.failures.length, 1, JSON.stringify(result!.failures));
  assert.equal(result!.failures[0].stage, "ticker");
  assert.equal(result!.failures[0].symbol, "ETHUSDT");
  assert.match(result!.failures[0].message, /anderes Symbol/);
  assert.equal(result!.orderbooksEnriched, 2, "Spread aus /depth");
  assert.equal(result!.candlesByTimeframe["1h"]?.instruments, 2);
  assert.equal(result!.candlesByTimeframe["1h"]?.bars, 4, "2 Kerzen je Instrument aus der Fixture");

  // Zählerzeilen (im Log des Services), keine Symbole/URLs.
  const text = lines.join("\n");
  assert.match(text, /\[market-sync\] BITUNIX discovery: 2 instruments/);
  assert.match(text, /DEGRADED: 1 isolierte\(r\) Fehler/);
  assert.match(text, /\[market-sync\] orderbooks enriched: 2/);
  // 4 von 122 erwarteten Bars: die Zeile beziffert die Lücke (Limit 61 × 2
  // Instrumente), statt sie als „fertig“ auszugeben.
  assert.match(text, /\[market-sync\] 1h candles: 2\/2 \(4\/122 bars\)/);
  assert.match(text, /DRY-RUN: 2 Instrumente geplant, 4 Bars — nichts in data\/ geschrieben\./);
  assert.doesNotMatch(text, /https?:\/\//i);

  // --json unterdrückt die Zählerzeilen auf stdout, die JSON-Ausgabe bleibt
  // die einzige Zeile — Automatisierung parst stdout, ohne es zu filtern.
  const stdout = printed.join("\n");
  assert.doesNotMatch(stdout, /discovery:/, "kein Zähler-Log bei --json");
  assert.equal(printed.filter((l) => l.startsWith("{")).length, 1, "genau eine JSON-Zeile");

  // Public-only: jede Route ist ein /market/-Endpunkt, keine Signatur, keine
  // Credential-Header — auch nicht über den realen HTTP-Layer.
  const paths = server.requests.map((r) => r.path);
  assert.ok(
    paths.every((p) => p.startsWith("/api/v1/futures/market/")),
    `nur Public-Pfade erwartet, war ${paths.join(", ")}`
  );
  assert.equal(server.privateCalls, 0);
  assert.deepEqual(server.requests.find((r) => r.credentialHeaders.length > 0) ?? null, null);
  // Budget: 1 trading_pairs + 1 tickers (bulk) + 1 tickers (Lücken-Fallback
  // für ETHUSDT, das im bulk fehlt) + 2 depth + 2 kline.
  assert.deepEqual(
    [...paths].sort(),
    [
      "/api/v1/futures/market/depth",
      "/api/v1/futures/market/depth",
      "/api/v1/futures/market/kline",
      "/api/v1/futures/market/kline",
      "/api/v1/futures/market/tickers",
      "/api/v1/futures/market/tickers",
      "/api/v1/futures/market/trading_pairs",
    ]
  );
});

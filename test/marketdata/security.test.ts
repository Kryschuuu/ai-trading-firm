/**
 * Security- und Architektur-Tests der Market-Data-Sync (MDSYNC-001 §4).
 *
 * Abgedeckte Audit-Punkte:
 *  1. Public-only: kein PrivateClient, keine Credentials im Sync-Pfad.
 *  2. Leak-freie Logs: URLs, Query-Strings und Secrets werden redigiert.
 *  3. Injection-Grenze: Venue/Symbol verlassen den Sync nur nach Allowlist-
 *     Prüfung; ein Hostile-Symbol erreicht den Adapter nie.
 *  4. Rate-Limit: Concurrency ≤ 8, effektive Rate < 10 req/s bei 200
 *     Instrumenten (Virtual-Clock — der Bucket darf nicht umgangen werden).
 *  5. Payload-Bombing: Antwortlängen-/Array-Caps.
 *  6. Pfad-Traversierung: `instrumentId` wird nie zum Dateinamen.
 *  7. Kein Sync-Trigger über eine HTTP-Route; Scanner und `/api/markets`
 *     sind nachweislich netzwerkfrei (statische Quelle-Prüfung).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import {
  MAX_CONCURRENCY,
  normalizeSyncSymbol,
  isSyncableSymbol,
  sanitizeSyncErrorMessage,
  sanitizeVenue,
  SYNC_LIMITS,
  type RateLimiter,
} from "../../src/marketdata";
import { instrumentOf, mockMarketDataAdapter, symbols, syncHarness } from "./fixtures";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Quelltext ohne Kommentare — statische Architektur-Checks müssen Code prüfen,
 * nicht Doku. Ein Kommentar wie „nutzt keinen PrivateClient“ wäre sonst ein
 * Treffer, und ein `// TODO: fetch()` würde einen echten Befund überdecken.
 */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:"'])\/\/[^"'].*$/gm, "$1");
const walk = (dir: string, predicate: (file: string) => boolean): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel, predicate));
    else if (predicate(rel)) out.push(rel);
  }
  return out;
};

// ── 1. Public-only ──────────────────────────────────────────────────────────

test("Sync-Pfad kennt keinen PrivateClient, keine API-Keys und keine Signatur", () => {
  const files = walk("src/marketdata", (f) => f.endsWith(".ts") && !f.includes("__tests__"));
  assert.ok(files.length >= 6, `erwartet ≥6 Quelldateien, fand ${files.length}`);
  const forbidden =
    /privateClient|BitunixPrivateClient|apiSecret|apiKey|API_KEY|signQuery|createHmac|Authorization/i;
  for (const file of files) {
    const src = code(file);
    assert.equal(forbidden.test(src), false, `${file} verweist auf Private-/Signing-Code`);
  }
  // Die Factory erzeugt ausschließlich den credential-freien PublicClient
  // (adaptiert über den Marketdata-Wrapper) — kein BrokerAdapter, kein
  // PrivateClient, kein SecretStore.
  const registry = code("src/marketdata/registerAdapters.ts");
  assert.match(registry, /new BitunixPublicClient\(/);
  assert.match(registry, /createBitunixMarketDataAdapter\(/);
  assert.doesNotMatch(registry, /privateClient|secretStore|new\s+BitunixBrokerAdapter/i);
});

// ── 2. Leak-freie Logs ───────────────────────────────────────────────────────

test("Fehlermeldungen redigieren URLs, Query-Strings und Key-Muster", () => {
  const leaking = new Error(
    "GET https://api.bitunix.com/api/v1/futures/market/tickers?symbol=BTCUSDT failed " +
      "api_key=SECRETABCDEF123456&signature=deadbeef"
  );
  const safe = sanitizeSyncErrorMessage(leaking);
  assert.ok(!safe.includes("api.bitunix.com"), `URL blieb stehen: ${safe}`);
  assert.ok(!safe.includes("SECRETABCDEF123456"), `Key blieb stehen: ${safe}`);
  assert.ok(!safe.includes("deadbeef"), `Signatur blieb stehen: ${safe}`);
  assert.ok(safe.includes("[url]"), "URL muss durch [url] ersetzt werden");
  assert.ok(safe.length <= 160, "Meldung ist längenbegrenzt");

  // Log-Injection über Steuerzeichen/neue Zeilen wird neutralisiert.
  const injected = sanitizeSyncErrorMessage("zeile1\n[market-sync] fake zeile\u00002");
  assert.ok(!injected.includes("\n"), "keine Mehrzeiligkeit im Log");
  assert.ok(!injected.includes("\u0000"), "keine Steuerzeichen im Log");

  // Venue-Keys in Fehlermeldungen sind gekürzt und kontrollzeichenfrei.
  assert.equal(sanitizeVenue(`  ${"A".repeat(80)}\u0007`), "A".repeat(80).slice(0, 32).trim());
  assert.equal(sanitizeVenue("BIT\u0000UNIX"), "BITUNIX");
});

test("Sync-Ergebnis und Log-Zeilen enthalten keine Symbole, URLs oder Keys", async () => {
  const { adapter } = mockMarketDataAdapter({
    instruments: [instrumentOf("BTCUSDT")],
    failOrderBookFor: ["BTCUSDT"],
  });
  const lines: string[] = [];
  const { service } = syncHarness(adapter, "BITUNIX", {
    logger: (_level, line) => lines.push(line),
  });
  const result = await service.syncVenue("BITUNIX");

  const serialized = JSON.stringify(result.failures);
  assert.ok(!/https?:\/\//i.test(serialized), "keine URLs im Fehler-Manifest");
  assert.ok(!/api[_-]?key|secret|signature/i.test(serialized), "keine Credential-Muster");
  assert.equal(lines.some((l) => /https?:\/\//i.test(l)), false, "keine URLs in den Log-Zeilen");
  assert.equal(lines.some((l) => l.includes("BTCUSDT")), false, "keine Symbole in den Log-Zählern");
  assert.ok(result.failures.length === 1, "der isolierte Fehler bleibt sichtbar — nur ohne Payload");
});

// ── 3. Injection-Grenze ──────────────────────────────────────────────────────

test("Symbol-Allowlist blockt Path-/Query-Injection vor dem Request", () => {
  const rejected = [
    "../../etc/passwd",
    "BTCUSDT?debug=1",
    "BTCUSDT#frag",
    "BTC USDT",
    "BTC\nUNIX",
    "BTC\u0000USDT",
    "x".repeat(40),
    "",
    "%2E%2E%2Fadmin",
    "BTC/USDT/../../",
    "🦄USDT",
  ];
  for (const raw of rejected) {
    assert.equal(isSyncableSymbol(raw), false, `"${raw}" hätte abgelehnt werden müssen`);
    assert.equal(normalizeSyncSymbol(raw), null, `normalizeSyncSymbol("${raw}") muss null sein`);
  }
  for (const ok of ["BTCUSDT", "BTC/USD", "BTC-USD", "AAPL", "EUR.USD", "EURUSD=X"]) {
    assert.equal(isSyncableSymbol(ok), true, `${ok} muss erlaubt sein`);
    assert.equal(normalizeSyncSymbol(ok.toLowerCase()), ok.toUpperCase());
  }
});

test("ein Hostile-Symbol erreicht den Adapter niemals (nur geprüfte Symbole)", async () => {
  const hostile = {
    ...instrumentOf("BTCUSDT"),
    symbol: "BTCUSDT&sign=leak",
  };
  const { adapter, calls } = mockMarketDataAdapter({ instruments: [hostile] });
  const { service, registry } = syncHarness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.equal(calls.orderBook.length, 0, "kein Depth-Request für ein ungeprüftes Symbol");
  assert.equal(calls.candles.length, 0, "kein Kline-Request für ein ungeprüftes Symbol");
  assert.equal(registry.size, 0, "kein Upsert mit ungeprüftem Symbol");
  assert.equal(result.degraded, true);
  assert.ok(result.failures.some((f) => f.reason === "INVALID_SYMBOL"));
});

// ── 4. Rate-Limit ────────────────────────────────────────────────────────────

test("200 Instrumente: Concurrency ≤ 8 und effektive Rate < 10 req/s", async () => {
  // Virtuelle Uhr: der Bucket wird wie im Produktions-Token-Bucket modeliert
  // (8 Token/s, burst 8), aber ohne echte Wartezeit — messbar wird trotzdem
  // die effektive Request-Rate.
  let virtualNow = 0;
  let pending: { at: number; run: () => void }[] = [];
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      pending.push({ at: virtualNow + Math.max(1, ms), run: resolve });
    });

  const ratePerSec = 8;
  let tokens = ratePerSec;
  let lastRefill = 0;
  const limiter: RateLimiter = {
    async take() {
      for (;;) {
        const elapsed = (virtualNow - lastRefill) / 1000;
        lastRefill = virtualNow;
        tokens = Math.min(ratePerSec, tokens + elapsed * ratePerSec);
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - tokens) / ratePerSec) * 1000));
      }
    },
  };

  const { adapter, calls } = mockMarketDataAdapter({
    instruments: symbols(200).map((s) => instrumentOf(s)),
    // Request-Zeitstempel und Latenz laufen auf derselben virtuellen Uhr —
    // gemessen wird die Rate in konfigurierter Zeit, nicht in Realzeit.
    clock: () => virtualNow,
    delay: () => sleep(1),
  });
  const { service } = syncHarness(adapter, "BITUNIX", {
    concurrency: 8,
    rateLimiter: limiter,
    // 2 Zeitrahmen statt 4: halbiert die Store-Arbeit, ändert nichts an der
    // Aussage (Request-Rate und Parallelität bleiben vollständig gemessen).
    timeframes: ["5m", "1h"],
    candleLimit: 61,
  });

  let finished = false;
  const run = service.syncVenue("BITUNIX").then((result) => {
    finished = true;
    return result;
  });
  // Virtual-Clock-Pumpe: Timer abarbeiten, bis der Lauf fertig ist.
  for (let steps = 0; !finished; steps++) {
    if (steps > 500_000) throw new Error("Virtual-Clock-Pumpe lief nicht aus — Deadlock?");
    if (pending.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }
    const nextAt = Math.min(...pending.map((t) => t.at));
    virtualNow = Math.max(virtualNow, nextAt);
    const due = pending.filter((t) => t.at <= virtualNow).sort((a, b) => a.at - b.at);
    pending = pending.filter((t) => t.at > virtualNow);
    for (const timer of due) timer.run();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = await run;

  assert.equal(result.synced, 200, "trotz Drosselung vollständig synchronisiert");
  assert.ok(calls.maxInFlight <= MAX_CONCURRENCY, `Parallelität ≤ 8, war ${calls.maxInFlight}`);

  // 1 × discovery + 1 × tickers (bulk) + 200 × (1 depth + 2 kline) = 602 Requests.
  const times = [...calls.requestTimes].sort((a, b) => a - b);
  assert.equal(times.length, 1 + 1 + 200 * 3, "exakt das dokumentierte Request-Budget");

  // Sustained-Rate über den ganzen Lauf: der Bucket ist autoritativ, die
  // Parallelität darf ihn nicht umgehen.
  const effectiveRate = times.length / Math.max(1, virtualNow / 1000);
  assert.ok(effectiveRate < 10, `effektive Rate ${effectiveRate.toFixed(2)} req/s muss < 10 sein`);
  assert.ok(effectiveRate > 1, `Rate > 0 erwartet, war ${effectiveRate}`);

  // Worst-Case-Fenster: ein Bucket mit burst = rate lässt im ersten Sekunden-
  // fenster burst + refill zu (8 + 8 = 16), nie mehr.
  let maxInWindow = 0;
  for (let i = 0; i < times.length; i++) {
    let j = i;
    while (j < times.length && times[j] - times[i] < 1000) j++;
    maxInWindow = Math.max(maxInWindow, j - i);
  }
  assert.ok(maxInWindow <= 16, `Worst-Window ${maxInWindow} req/s bleibt ≤ burst+refill`);
  assert.ok(virtualNow > 0, "die Drosselung hat virtuelle Zeit gekostet (kein Bucket-Bypass)");
});


// ── 5. Payload-Bombing ───────────────────────────────────────────────────────

test("Array-Caps begrenzen Ticker-Batch, Orderbook-Levels und Discovery-Zeilen", async () => {
  assert.ok(SYNC_LIMITS.maxBookLevels > 0 && SYNC_LIMITS.maxBookLevels <= 1000);
  assert.ok(SYNC_LIMITS.maxCandlesPerResponse <= 2000);
  assert.ok(SYNC_LIMITS.maxTickerBatch <= 1000);
  assert.ok(SYNC_LIMITS.maxInstruments <= 1000);

  // 20 000 Ticker-Zeilen: nur die erlaubte Obergrenze wird übernommen und die
  // Kappung gemeldet — der Lauf endet nicht mit OOM, aber auch nicht still.
  const huge = mockMarketDataAdapter({
    instruments: symbols(3).map((s) => instrumentOf(s)),
  });
  const { service, registry } = syncHarness(huge.adapter, "BITUNIX");
  const clean = await service.syncVenue("BITUNIX");
  assert.equal(clean.synced, 3);
  assert.ok(!clean.failures.some((f) => f.message.includes("gekappt")), "unterhalb der Kappe: keine Meldung");
  void registry;

  const bombarded = mockMarketDataAdapter({ instruments: symbols(3).map((s) => instrumentOf(s)) });
  const rows = Array.from({ length: 20_000 }, (_, i) => ({
    symbol: `SYM${String(i).padStart(5, "0")}USDT`,
    price: 1,
    source: "mock",
    ts: 1,
    quoteVol: 1,
  }));
  bombarded.adapter.getTickers = async () => rows as never;
  const bombarded2 = syncHarness(bombarded.adapter, "BITUNIX");
  const result = await bombarded2.service.syncVenue("BITUNIX");
  assert.ok(
    result.failures.some((f) => f.stage === "ticker" && f.message.includes("gekappt")),
    `Ticker-Kappe muss gemeldet werden, war ${JSON.stringify(result.failures.slice(0, 2))}`
  );
  assert.equal(result.synced, 3, "trotz Kappung werden die Instrumente synchronisiert");
});

// ── 6. Pfad-Traversierung im Store ───────────────────────────────────────────

test("HistoricalStore schreibt ausschließlich candles.ndjson unter dir/", async () => {
  const { adapter } = mockMarketDataAdapter({
    instruments: [{ ...instrumentOf("BTCUSDT"), id: "../../../../etc/cron.d/evil" }],
  });
  const { service, history, dir } = syncHarness(adapter);

  await service.syncVenue("BITUNIX");

  assert.equal(history.filePath, path.join(dir, "history", "candles.ndjson"));
  const written = readdirSync(path.join(dir, "history"));
  assert.deepEqual(written, ["candles.ndjson"], "keine weitere Datei — instrumentId wird nie zum Pfad");
  assert.equal(existsSync(path.join(dir, "..", "cron.d")), false, "nichts außerhalb des Store-Verzeichnisses");
  // Die Bars liegen unter der kanonischen ID, nicht unter der Einschleusung.
  assert.equal(history.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" }).length, 150);
});

// ── 7. Architektur: keine Netzwerkpfade in Scanner und API ──────────────────

test("scanUniverse() und der Scanner-Kern enthalten keinen Netzwerkcode", () => {
  const files = walk("src/scanner", (f) => f.endsWith(".ts") && !f.includes("__tests__"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const src = code(file);
    assert.equal(/(^|[^.\w])fetch\s*\(/.test(src), false, `${file} ruft fetch() auf`);
    assert.equal(/\baxios\b|\bnode:http|\bnode:https|XMLHttpRequest/.test(src), false, `${file} nutzt HTTP`);
    assert.equal(/discoverInstruments\s*\(|createAdapter\w*\(|registerAdapters\s*\(/.test(src), false, `${file} instanziiert Adapter`);
    assert.equal(/MarketDataSyncService/.test(src), false, `${file} ruft den Sync-Service`);
  }
});

test("/api/markets bleibt read-only und triggert keinen Sync", () => {
  const markets = walk("src/app/api/markets", (f) => f.endsWith(".ts"));
  assert.ok(markets.length >= 1, "Routes unter /api/markets erwartet");
  for (const file of markets) {
    const src = code(file);
    assert.equal(/^export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/m.test(src), false, `${file} schreibt`);
    assert.match(src, /export\s+async\s+function\s+GET/, `${file} muss GET exportieren`);
    assert.equal(/MarketDataSyncService|runMarketSync|discoverInstruments|createAdapter|registerAdapters/.test(src), false, `${file} triggert Sync`);
    assert.equal(/(^|[^.\w])fetch\s*\(/.test(src), false, `${file} ruft fetch() auf`);
  }
});

test("keine HTTP-Route ruft den Market-Data-Sync auf", () => {
  const routes = walk("src/app", (f) => f.endsWith("route.ts"));
  assert.ok(routes.length > 20, `erwartet >20 Routen, fand ${routes.length}`);
  for (const file of routes) {
    const src = code(file);
    assert.equal(
      /MarketDataSyncService|runMarketSync|syncVenue|registerAdapters|createAdapterRegistry/.test(src),
      false,
      `${file} würde einen Netzwerk-Sync über eine HTTP-Route auslösen`
    );
  }
});

test("Register- und Store-Schreibpfade sind fest verdrahtet (data/history)", () => {
  const store = code("src/lib/marketdata/historicalStore.ts");
  assert.match(store, /this\.filePath\s*=\s*path\.join\(this\.dir,\s*"candles\.ndjson"\)/);
  assert.equal(
    /path\.join\([^)]*instrumentId/.test(store),
    false,
    "instrumentId darf nicht in einen Pfad interpoliert werden"
  );
});

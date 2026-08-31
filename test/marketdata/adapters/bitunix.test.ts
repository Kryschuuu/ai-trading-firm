/**
 * Bitunix-Market-Data-Wrapper + Registrierung (P0-Verdrahtung, §4 QA).
 *
 * Deckt die neun Pflicht-Tests des Tickets plus Security-Audit ab:
 *
 *  1. „bitunix discovery upserts discovered instruments“ (Broker-Adapter,
 *     Ticket-Snippet) — der Broker-Pfad bleibt erhalten.
 *  2. „market data adapter never instantiates private client“ — statischer
 *     Quell-Scan (kein PrivateClient/Signing/Nonce in src/marketdata/**)
 *     PLUS Laufzeit-Beweis über die echte Registrierung: ein vollständiger
 *     `syncVenue()` gegen den Fixture-Server erzeugt ausschließlich Requests
 *     auf die vier Public-Endpunkte und trägt KEINE Credential-Header.
 *     (Ein Konstruktor-Spy auf `BitunixPrivateClient` ist im ESM-Binding
 *     nicht patchbar — `mock.module` gilt als experimentell und ist im
 *     Test-Runner nicht aktiviert; der statische Scan ist der stärkere
 *     Beweis: die Registrierung referenziert die Klasse gar nicht erst.)
 *  3. „adapter is not registered when BITUNIX_ENABLED is unset“ (+ Hilfetext
 *     des UnsupportedVenueError, + Capability-Gate).
 *  4. „timeframe mapping covers every SupportedTimeframe“ (exhaustiv).
 *  5. „unknown timeframe throws UnsupportedTimeframeError“ (inkl. 3m/5d-Lücke).
 *  6. „symbol normalization is applied to every discovered instrument id“.
 *  7. „HALTED symbols are discovered but flagged, not silently dropped“.
 *  8. „run-scan without --sync performs zero network calls“ (Subprozess
 *     gegen einen Guard-Server, der jeden Request als Fehler zählt).
 *  9. HTTP-Layer-Regression: 401/403 → Auth/Permission ohne Retry,
 *     429/5xx → Retry mit Backoff, endliches Retry-Budget.
 *
 * Security-Audit: Endpoint-Allowlist, Env-Proxy (BITUNIX_API_KEY/_SECRET
 * werden im Sync-Pfad nicht gelesen), Redaction, Rate-Limit-Autorität des
 * geteilten Token-Buckets.
 *
 * Fixtures: echte, am 2026-08-31 gezogene Responses der öffentlichen
 * Bitunix-API (test/fixtures/bitunix/*.json, Provenanz siehe README.md dort)
 * plus eine schema-idente Edge-Status-Datei (STOP/CANCEL_ONLY/isApiSupported
 * false/DELISTED) für die nicht handelbaren Symbole.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { BitunixBrokerAdapter } from "../../../src/brokers/bitunix/adapter";
import { VENUE_CAPABILITIES } from "../../../src/brokers/capabilities";
import { BITUNIX_PATHS, loadBitunixConfig } from "../../../src/brokers/bitunix/config";
import { BitunixApiError } from "../../../src/brokers/bitunix/errors";
import { TokenBucket } from "../../../src/brokers/bitunix/http";
import { BitunixPublicClient } from "../../../src/brokers/bitunix/publicClient";
import { HistoricalStore, SUPPORTED_TIMEFRAMES, type SupportedTimeframe } from "../../../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../../src/universe/registry";
import {
  BITUNIX_SUPPORTED_INTERVALS,
  BITUNIX_TIMEFRAME_MAP,
  createBitunixMarketDataAdapter,
  toBitunixInterval,
} from "../../../src/marketdata/adapters/bitunix";
import {
  MarketDataSyncService,
  UnsupportedTimeframeError,
  UnsupportedVenueError,
  registerAdapters,
  registerMarketDataAdapters,
  type MarketDataAdapter,
} from "../../../src/marketdata";
import { normalizeVenueSymbol } from "../../../src/symbols/normalize";
import { mockBitunixPublicClient } from "../../../tests/fixtures/bitunixMockClient";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "bitunix");

/** Echte Fixture-Responses (siehe test/fixtures/bitunix/README.md). */
function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as T;
}

const TRADING_PAIRS = loadFixture<{ code: number; data: unknown[] }>("trading_pairs.json");
const TRADING_PAIRS_EDGE = loadFixture<{ code: number; data: unknown[] }>("trading_pairs_edge_statuses.json");
const TICKERS = loadFixture<{ code: number; data: Array<{ symbol: string }> }>("tickers.json");
const DEPTH = loadFixture<{ code: number; data: unknown }>("depth.json");
const KLINE = loadFixture<{ code: number; data: unknown[] }>("kline.json");

/** Die vier öffentlichen Market-Data-Pfade — Allowlist für den Endpoint-Audit. */
const PUBLIC_PATHS = [
  BITUNIX_PATHS.tradingPairs,
  BITUNIX_PATHS.tickers,
  BITUNIX_PATHS.kline,
  BITUNIX_PATHS.depth,
] as const;

/** Header, die ein Public-Request niemals tragen darf. */
const CREDENTIAL_HEADERS = ["sign", "api-key", "apikey", "nonce", "timestamp", "authorization", "x-api-key"] as const;

// ── Temp-Verzeichnisse ──────────────────────────────────────────────────────

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ── Fixture-Transporte ──────────────────────────────────────────────────────

interface RecordedRequest {
  path: string;
  query: Record<string, string>;
  credentialHeaders: string[];
}

/**
 * Lokaler HTTP-Fixture-Server: bedient die vier Public-Endpunkte mit den
 * echten Fixture-Responses (semantikgetreu: `symbols`-Filter auf trading_pairs
 * und tickers) und zeichnet JEDE Anfrage auf — inklusive Credential-Header.
 * Requests auf private/order Endpunkte antwortet er 404 und wird ebenso
 * aufgezeichnet; beides lässt Tests hart fehlschlagen.
 */
class BitunixFixtureApi {
  private server: http.Server | null = null;
  readonly requests: RecordedRequest[] = [];
  /** `edge` bedient trading_pairs aus der Edge-Status-Fixture. */
  constructor(private readonly tradingPairs: "base" | "edge" = "base") {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const credentialHeaders = CREDENTIAL_HEADERS.filter((h) => req.headers[h] !== undefined);
      const query = Object.fromEntries(url.searchParams);
      this.requests.push({ path: url.pathname, query, credentialHeaders });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const symbols = (url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (url.pathname === BITUNIX_PATHS.tradingPairs) {
        const rows = this.tradingPairs === "edge" ? TRADING_PAIRS_EDGE.data : TRADING_PAIRS.data;
        const data = symbols.length
          ? rows.filter((r) => symbols.includes(String((r as { symbol?: unknown }).symbol).toUpperCase()))
          : rows;
        json(200, { code: 0, data, msg: "Success" });
        return;
      }
      if (url.pathname === BITUNIX_PATHS.tickers) {
        const data = symbols.length
          ? TICKERS.data.filter((t) => symbols.includes(t.symbol.toUpperCase()))
          : TICKERS.data;
        json(200, { code: 0, data, msg: "Success" });
        return;
      }
      if (url.pathname === BITUNIX_PATHS.depth) {
        json(200, DEPTH);
        return;
      }
      if (url.pathname === BITUNIX_PATHS.kline) {
        json(200, KLINE);
        return;
      }
      json(404, { code: 1, msg: "not found (fixture allowlist)", data: null });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  get hits(): number {
    return this.requests.length;
  }
}

interface FixtureFetchOptions {
  /** trading_pairs-Fixture (Default: echte Basis-Response). */
  tradingPairs?: "base" | "edge";
  /** Erzwungener HTTP-Status auf `/depth` für die ersten `depthFailTimes` Calls. */
  depthStatus?: number;
  depthFailTimes?: number;
  /** Erzwungener HTTP-Status auf `/kline` für ALLE Calls. */
  klineStatus?: number;
}

/** In-Memory-fetch gegen die Fixture-Dateien (0 Netzwerk, zählt jeden Call). */
function fixtureFetch(opts: FixtureFetchOptions = {}): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const respond = (status: number, data: unknown): Response =>
    new Response(JSON.stringify({ code: status === 200 ? 0 : status, msg: status === 200 ? "Success" : "forced", data }), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = { accept: "application/json", language: "en-US" };
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), credentialHeaders: [] });
    const symbols = (url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

    if (url.pathname === BITUNIX_PATHS.tradingPairs) {
      const rows = (opts.tradingPairs ?? "base") === "edge" ? TRADING_PAIRS_EDGE.data : TRADING_PAIRS.data;
      const data = symbols.length
        ? rows.filter((r) => symbols.includes(String((r as { symbol?: unknown }).symbol).toUpperCase()))
        : rows;
      return respond(200, data);
    }
    if (url.pathname === BITUNIX_PATHS.tickers) {
      const data = symbols.length ? TICKERS.data.filter((t) => symbols.includes(t.symbol.toUpperCase())) : TICKERS.data;
      return respond(200, data);
    }
    if (url.pathname === BITUNIX_PATHS.depth) {
      const depthCalls = calls.filter((c) => c.path === BITUNIX_PATHS.depth).length;
      if (opts.depthStatus !== undefined && depthCalls <= (opts.depthFailTimes ?? 0)) {
        return respond(opts.depthStatus, null);
      }
      return respond(200, DEPTH.data);
    }
    if (url.pathname === BITUNIX_PATHS.kline) {
      if (opts.klineStatus !== undefined) return respond(opts.klineStatus, null);
      return respond(200, KLINE.data);
    }
    return respond(404, null);
  };
  return { fetchImpl, calls };
}

/** Wrapper um einen In-Memory-Public-Client (Produktion-Config, kein Netz). */
function wrapperFromFetch(
  opts: FixtureFetchOptions & { retryMax?: number } = {},
  symbolNormalizer: typeof normalizeVenueSymbol = normalizeVenueSymbol
): { adapter: MarketDataAdapter; calls: RecordedRequest[] } {
  const { fetchImpl, calls } = fixtureFetch(opts);
  const adapter = createBitunixMarketDataAdapter({
    publicClient: mockBitunixPublicClient({ fetchImpl, retryMax: opts.retryMax }),
    symbolNormalizer,
  });
  return { adapter, calls };
}

/** Registry + Store auf Temp-Basis (autoSave aus, deterministisch). */
function tmpRegistry(): InstrumentRegistry {
  return new InstrumentRegistry({ dir: tmp("mda-uni-"), autoSave: false });
}
function tmpHistory(): HistoricalStore {
  return new HistoricalStore(path.join(tmp("mda-hist-"), "history"));
}

/** Env für die Registrierung gegen den Fixture-Server (Public-only). */
function syncEnv(baseUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    BITUNIX_ENABLED: "true",
    BITUNIX_BASE_URL: baseUrl,
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
    BITUNIX_TIMEOUT_MS: "2000",
    BITUNIX_RETRY_MAX: "2",
    ...extra,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Discovery — Broker-Pfad (Ticket-Snippet, unverändert erhalten)
// ════════════════════════════════════════════════════════════════════════════

test("bitunix discovery upserts discovered instruments", async () => {
  const registry = tmpRegistry();
  const adapter = new BitunixBrokerAdapter("paper", {
    env: { BITUNIX_ENABLED: "true" },
    publicClient: mockBitunixPublicClient(),
    registry,
  });

  const instruments = await adapter.discoverInstruments();

  assert.ok(instruments.length > 0);
  assert.ok(registry.size > 0);
  assert.ok(registry.get("BITUNIX:BTCUSDT"));
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Kein PrivateClient im Market-Data-Pfad
// ════════════════════════════════════════════════════════════════════════════

/** Quelle ohne Kommentare — statische Checks prüfen Code, nicht Doku. */
function codeWithoutComments(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

test("market data adapter never instantiates private client (statisch + Laufzeit)", async () => {
  // (a) Statisch: src/marketdata/** referenziert weder PrivateClient noch
  //     Signing/Nonce — die Registrierung kann die Klasse gar nicht bauen.
  const marketdataFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, entry);
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith(".ts") && !rel.includes("__tests__")) marketdataFiles.push(rel);
    }
  };
  walk(path.join("src", "marketdata"));
  assert.ok(marketdataFiles.length >= 7, `src/marketdata sollte ≥7 Dateien haben, fand ${marketdataFiles.length}`);
  for (const file of marketdataFiles) {
    const src = codeWithoutComments(file);
    assert.equal(
      /privateClient|BitunixPrivateClient|createHmac|signQuery|loadBitunixCredentials|new\s+BitunixBrokerAdapter/.test(src),
      false,
      `${file} darf keinen Private-/Broker-Adapter-Code referenzieren`
    );
  }

  // (b) Laufzeit: die reale Registrierung (mit im Env liegenden Keys!) läuft
  //     einen vollständigen Sync — ohne einen einzigen Credential-Header und
  //     ausschließlich gegen die vier Public-Endpunkte.
  const api = new BitunixFixtureApi();
  const baseUrl = await api.start();
  try {
    const env = syncEnv(baseUrl, { BITUNIX_API_KEY: "test-key-present-but-must-not-be-read", BITUNIX_API_SECRET: "test-secret-present" });
    const adapters = registerMarketDataAdapters(env);
    assert.equal(adapters.size, 1, "BITUNIX ist registriert");
    const registry = tmpRegistry();
    const history = tmpHistory();
    const service = new MarketDataSyncService(registry, history, adapters, {
      timeframes: ["1h"],
      candleLimit: 100,
      concurrency: 1,
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      logger: () => {},
    });
    const result = await service.syncVenue("BITUNIX");

    assert.ok(result.synced > 0, "Sync hat Instrumente synchronisiert");
    assert.ok(api.hits > 0, "Requests sind gegangen");
    for (const request of api.requests) {
      assert.ok(
        (PUBLIC_PATHS as readonly string[]).includes(request.path),
        `Endpoint-Allowlist verletzt: ${request.path}`
      );
      assert.deepEqual(request.credentialHeaders, [], `${request.path} trägt Credential-Header`);
    }
  } finally {
    await api.stop();
  }
});

test("endpoint allowlist: Order-/Position-/Account-Pfade sind im Sync unerreichbar", async () => {
  const privatePaths = [BITUNIX_PATHS.account, BITUNIX_PATHS.positions, BITUNIX_PATHS.placeOrder];
  for (const privatePath of privatePaths) {
    // Der Allowlist-Fetch beantwortet sie mit 404 — aber schon der VERSUCH
    // wäre der Befund. Deshalb hier der statische Beweis: Der Wrapper ruft
    // ausschließlich die vier Public-Methoden des PublicClient.
    assert.ok(!PUBLIC_PATHS.includes(privatePath as (typeof PUBLIC_PATHS)[number]));
  }
  const wrapperSrc = codeWithoutComments(path.join("src", "marketdata", "adapters", "bitunix.ts"));
  for (const call of ["fetchTradingPairsRaw", "fetchTicker", "fetchTickers", "fetchDepth", "fetchKlines"]) {
    assert.ok(wrapperSrc.includes(call), `Wrapper nutzt ${call}`);
  }
  assert.equal(/fetchAccount|fetchPositions|placeOrder|placeSerializedOrder/.test(wrapperSrc), false, "Wrapper kennt keine Order-/Account-Zugriffe");
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Registrierungs-Gates (Env-Flag + Capability-Matrix)
// ════════════════════════════════════════════════════════════════════════════

test("adapter is not registered when BITUNIX_ENABLED is unset", async () => {
  const adapters = registerMarketDataAdapters({});
  assert.equal(adapters.size, 0);
  assert.equal(adapters.get("BITUNIX"), undefined);

  // Und der Aufruf erklärt die Ursache + Behebung (Hilfetext §3.5).
  const service = new MarketDataSyncService(tmpRegistry(), tmpHistory(), adapters, { logger: () => {} });
  await assert.rejects(
    () => service.syncVenue("BITUNIX"),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedVenueError);
      assert.equal(error.code, "UNSUPPORTED_VENUE");
      assert.equal(error.venue, "BITUNIX");
      const message = error.message;
      assert.ok(message.includes("BITUNIX_ENABLED"), "nennt das fehlende Flag");
      assert.ok(message.includes("KEINE API-Credentials"), "sagt explizit: keine Credentials nötig");
      assert.ok(message.includes("Live-Gate"), "beruhigt bzgl. Live-Trading");
      assert.ok(message.includes("capabilities.BITUNIX.marketData=false"), "nennt die Capability-Ursache");
      return true;
    }
  );

  // Gate-Report: Grund VENUE_DISABLED statt stillschweigend.
  const gated = registerAdapters({ env: {} });
  assert.deepEqual(gated.skipped, [{ venue: "BITUNIX", reason: "VENUE_DISABLED" }]);
});

test("adapter is not registered when capabilities.BITUNIX.marketData=false", () => {
  const caps = VENUE_CAPABILITIES.BITUNIX;
  const original = caps.marketData;
  // Die Capability-Table ist die SSoT — hier temporär auf false gedreht.
  (caps as { marketData: boolean }).marketData = false;
  try {
    const adapters = registerMarketDataAdapters({ BITUNIX_ENABLED: "true" });
    assert.equal(adapters.size, 0, "Flag allein reicht nicht — Capability ist Pflicht");
    const gated = registerAdapters({ env: { BITUNIX_ENABLED: "true" } });
    assert.deepEqual(gated.skipped, [{ venue: "BITUNIX", reason: "CAPABILITY_DISABLED" }]);
  } finally {
    (caps as { marketData: boolean }).marketData = original;
  }
});

test("registerMarketDataAdapters liefert bei aktivem Gate den Public-only-Adapter", async () => {
  const api = new BitunixFixtureApi();
  const baseUrl = await api.start();
  try {
    const adapters = registerMarketDataAdapters(syncEnv(baseUrl));
    const adapter = adapters.get("BITUNIX");
    assert.ok(adapter, "Adapter registriert");
    assert.equal(adapter!.venue, "BITUNIX");
    // Der Adapter ist KEIN BrokerAdapter: kein Modus, keine Order-Methoden.
    assert.equal("mode" in adapter!, false, "Wrapper trägt keinen Ausführungsmodus");
    assert.equal("placeOrder" in adapter!, false, "Wrapper hat keine Order-Methode");
    const instruments = await adapter!.discoverInstruments();
    assert.equal(instruments.length, 4, "echte Fixture: 4 Instrumente");
  } finally {
    await api.stop();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4./5. Timeframe-Mapping (exhaustiv + Fehlerfall)
// ════════════════════════════════════════════════════════════════════════════

test("timeframe mapping covers every SupportedTimeframe", () => {
  assert.equal(BITUNIX_TIMEFRAME_MAP["1m"], "1m");
  assert.equal(BITUNIX_TIMEFRAME_MAP["5m"], "5m");
  assert.equal(BITUNIX_TIMEFRAME_MAP["15m"], "15m");
  assert.equal(BITUNIX_TIMEFRAME_MAP["30m"], "30m");
  assert.equal(BITUNIX_TIMEFRAME_MAP["1h"], "1h");
  assert.equal(BITUNIX_TIMEFRAME_MAP["2h"], "2h");
  assert.equal(BITUNIX_TIMEFRAME_MAP["4h"], "4h");
  assert.equal(BITUNIX_TIMEFRAME_MAP["1d"], "1d");
  // Dokumentierte Venue-Lücken — explizit null, nicht weggelassen:
  assert.equal(BITUNIX_TIMEFRAME_MAP["3m"], null, "Bitunix hat kein 3m-Intervall");
  assert.equal(BITUNIX_TIMEFRAME_MAP["5d"], null, "Bitunix hat kein 5d-Intervall");

  // Exhaustiver Table-Test: JEDES Store-Timeframe hat einen Eintrag (string|null)
  // und jeder nicht-null Wert ist ein dokumentiertes Bitunix-Intervall.
  const documented = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"];
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const mapped = BITUNIX_TIMEFRAME_MAP[timeframe];
    assert.notEqual(mapped, undefined, `${timeframe} fehlt in der Map — nicht exhaustiv`);
    if (mapped !== null) {
      assert.ok(documented.includes(mapped), `${timeframe} → ${mapped} ist kein Bitunix-Intervall`);
    }
    // Roundtrip: toBitunixInterval liefert den Eintrag oder wirft.
    if (mapped === null) {
      assert.throws(() => toBitunixInterval(timeframe), UnsupportedTimeframeError);
    } else {
      assert.equal(toBitunixInterval(timeframe), mapped);
    }
  }
  // Die abgeleitete Intervall-Liste enthält keine Lücken-Placeholder.
  assert.equal(BITUNIX_SUPPORTED_INTERVALS.includes("3m"), false);
  assert.equal(BITUNIX_SUPPORTED_INTERVALS.includes("5d"), false);
});

test("unknown timeframe throws UnsupportedTimeframeError", async () => {
  const { adapter, calls } = wrapperFromFetch();

  // (a) Ganz außerhalb der Store-Allowlist:
  await assert.rejects(
    () => adapter.getCandles("BTCUSDT", "7m" as SupportedTimeframe, 100),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedTimeframeError);
      assert.equal(error.code, "UNSUPPORTED_TIMEFRAME");
      assert.equal(error.venue, "BITUNIX");
      assert.equal(error.timeframe, "7m");
      assert.ok(error.message.includes("mischen"), "begründet den Abbruch (Reihen nicht mischen)");
      return true;
    }
  );
  // (b) In der Allowlist, aber von der Venue nicht bedient (3m/5d-Lücke):
  for (const gap of ["3m", "5d"] as const) {
    await assert.rejects(
      () => adapter.getCandles("BTCUSDT", gap, 100),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedTimeframeError, `${gap} muss UnsupportedTimeframeError werfen`);
        return true;
      }
    );
  }
  // (c) Der Fehler passiert VOR dem Request — kein Call, kein Partial-Fetch.
  assert.equal(calls.filter((c) => c.path === BITUNIX_PATHS.kline).length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Symbol-Normalisierung auf JEDE entdeckte Instrument-ID
// ════════════════════════════════════════════════════════════════════════════

test("symbol normalization is applied to every discovered instrument id", async () => {
  const seen: Array<{ input: string; instrumentId: string; venueNative: string }> = [];
  const spyNormalizer: typeof normalizeVenueSymbol = (venue, rawSymbol, opts) => {
    const canonical = normalizeVenueSymbol(venue, rawSymbol, opts);
    seen.push({ input: rawSymbol, instrumentId: canonical.instrumentId, venueNative: canonical.venueNative });
    return canonical;
  };
  const { adapter } = wrapperFromFetch({}, spyNormalizer);

  const instruments = await adapter.discoverInstruments();

  assert.ok(instruments.length >= 4);
  assert.equal(seen.length, instruments.length, "Normalizer wurde für JEDE Zeile aufgerufen");
  for (const instrument of instruments) {
    // Die ID ist die venue-native SPEICHERFORM (BITUNIX:BTCUSDT — nicht die
    // kanonische Anfrageform BITUNIX:BTC/USDT; docs/SYMBOLS.md §4).
    assert.match(instrument.id, /^BITUNIX:[A-Z0-9]{2,20}$/);
    const record = seen.find((s) => s.venueNative === instrument.symbol);
    assert.ok(record, `Symbol ${instrument.symbol} ging durch den Normalizer`);
    assert.equal(instrument.id, `BITUNIX:${record.venueNative}`);
    assert.notEqual(instrument.id, record.instrumentId, "Speicherform, nicht Kanon-Form");
    assert.equal(instrument.venue, "BITUNIX");
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Nicht handelbare Symbole: entdecken + flaggen, NICHT verwerfen
// ════════════════════════════════════════════════════════════════════════════

test("HALTED symbols are discovered but flagged, not silently dropped", async () => {
  const { adapter } = wrapperFromFetch({ tradingPairs: "edge" });
  const instruments = await adapter.discoverInstruments();

  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  // Alle fünf Edge-Zeilen (inkl. DELISTED und isApiSupported=false) sind da:
  assert.equal(instruments.length, 5, `erwartet 5 Edge-Instrumente, fand ${instruments.length}: ${instruments.map((i) => i.symbol).join(",")}`);
  assert.equal(bySymbol.get("PAUSEUSDT")?.status, "halted", "STOP → halted");
  assert.equal(bySymbol.get("CXLUSDT")?.status, "halted", "CANCEL_ONLY → halted");
  assert.equal(bySymbol.get("NOAPIUSDT")?.status, "halted", "isApiSupported=false → halted (nicht verworfen)");
  assert.equal(bySymbol.get("GONEUSDT")?.status, "delisted", "DELISTED → delisted (nicht verworfen)");
  assert.equal(bySymbol.get("BAREUSDT")?.status, "active", "OPEN ohne base/quote → Inferenz + active");

  // DTO-Mapping-Regeln (Beispielzeile PAUSEUSDT aus der Edge-Fixture):
  const pause = bySymbol.get("PAUSEUSDT")!;
  assert.equal(pause.id, "BITUNIX:PAUSEUSDT");
  assert.equal(pause.base, "PAUSE");
  assert.equal(pause.quote, "USDT");
  assert.equal(pause.minQuantity, 1, "minTradeVolume 1 → minQuantity 1");
  assert.equal(pause.priceStep, 0.001, "quotePrecision 3 → priceStep 10^-3");
  assert.equal(pause.quantityStep, 0.01, "basePrecision 2 → quantityStep 10^-2");
  assert.equal(pause.leverageAvailable, true, "maxLeverage 50 > 1");

  // …und der Weg in die Registry bleibt offen (Scanner entscheidet fachlich
  // über den Status-Filter, nicht die Discovery durch Wegwerfen):
  const registry = tmpRegistry();
  const upserted = registry.upsertMany(instruments, "discovery:bitunix");
  assert.equal(upserted.created, 5, "alle Status-Werte werden persistiert");
  assert.equal(registry.get("BITUNIX:NOAPIUSDT")?.status, "halted");
});

// ════════════════════════════════════════════════════════════════════════════
// 8. run-scan ohne --sync: null Netzwerk
// ════════════════════════════════════════════════════════════════════════════

test("run-scan without --sync performs zero network calls", async () => {
  // Guard-Server: JEDER Request wäre ein Befund. Er antwortet bewusst
  // 418/404 — der Scan darf ihn nie fragen.
  const guard = http.createServer((_req, res) => {
    res.writeHead(418, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 1, msg: "network access without --sync", data: null }));
  });
  await new Promise<void>((resolve) => guard.listen(0, "127.0.0.1", resolve));
  const guardAddress = guard.address();
  assert.ok(guardAddress && typeof guardAddress === "object");
  const guardHits = { count: 0 };
  guard.on("request", () => {
    guardHits.count += 1;
  });
  const guardUrl = `http://127.0.0.1:${guardAddress.port}`;

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-scan.ts"), "--dry"],
      {
        cwd: ROOT,
        timeout: 90_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          BITUNIX_ENABLED: "true",
          BITUNIX_BASE_URL: guardUrl,
          BITUNIX_WS_URL: guardUrl,
          BITUNIX_ALLOW_INSECURE_HTTP: "true",
          BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
          UNIVERSE_DATA_DIR: tmp("rs-uni-"),
          SCANNER_ARTIFACTS_DIR: tmp("rs-art-"),
          DATABASE_URL: "postgresql://test:test@0.0.0.0:5432/test",
          STARTING_EQUITY: "10000",
        },
      }
    );
    assert.ok(stdout.includes("[scanner]"), `Scan lief: ${stdout.slice(0, 200)}`);
    assert.equal(guardHits.count, 0, `run-scan ohne --sync machte ${guardHits.count} Netzwerk-Request(s): ${stderr.slice(0, 200)}`);
  } finally {
    await new Promise<void>((resolve) => guard.close(() => resolve()));
  }

  // Statischer Gegenschutz: Netzwerk nur unter --sync (runMarketSync ist der
  // einzige Netzwerkknoten des Skripts und liegt hinter dem Flag).
  const runScanSource = codeWithoutComments(path.join("scripts", "run-scan.ts"));
  assert.match(runScanSource, /const syncFirst = args.includes\("--sync"\) \|\| args.includes\("--sync-first"\)/);
  assert.match(runScanSource, /if \(syncFirst\) \{/);
});

// ════════════════════════════════════════════════════════════════════════════
// 9. HTTP-Layer-Regression: 401/403, 429/5xx, endliches Retry-Budget
// ════════════════════════════════════════════════════════════════════════════

test("HTTP-Regression: 401/403 → AuthError (kein Retry, genau 1 Call)", async () => {
  for (const [status, kind] of [[401, "auth"], [403, "permission"]] as const) {
    const { adapter, calls } = wrapperFromFetch({ depthStatus: status, depthFailTimes: 10_000, retryMax: 3 });
    await assert.rejects(
      () => adapter.getOrderBook("BTCUSDT"),
      (error: unknown) => {
        assert.ok(error instanceof BitunixApiError, `${status}: BitunixApiError erwartet`);
        assert.equal((error as BitunixApiError).kind, kind);
        assert.equal((error as BitunixApiError).httpStatus, status);
        return true;
      }
    );
    const depthCalls = calls.filter((c) => c.path === BITUNIX_PATHS.depth);
    assert.equal(depthCalls.length, 1, `${status} wird nie wiederholt (fail fast, kein Loop)`);
  }
});

test("HTTP-Regression: 429 → Retry mit Backoff, dann Erfolg", async () => {
  const { adapter, calls } = wrapperFromFetch({ depthStatus: 429, depthFailTimes: 2, retryMax: 3 });

  const startedAt = Date.now();
  const book = await adapter.getOrderBook("BTCUSDT");
  const elapsed = Date.now() - startedAt;

  assert.equal(calls.filter((c) => c.path === BITUNIX_PATHS.depth).length, 3, "2×429 + 1×200");
  assert.ok(book.bids.length >= 2 && book.asks.length >= 2, "nach Retry liefert der Call Daten");
  // Backoff 200 ms + 400 ms (exponentiell) — der Client muss wirklich warten.
  assert.ok(elapsed >= 400, `Backoff fehlt (nur ${elapsed} ms)`);
});

test("HTTP-Regression: 5xx → Retry, endliches Budget (kein Endlos-Loop)", async () => {
  const { adapter, calls } = wrapperFromFetch({ depthStatus: 503, depthFailTimes: 10_000, retryMax: 3 });

  await assert.rejects(
    () => adapter.getOrderBook("BTCUSDT"),
    (error: unknown) => {
      assert.ok(error instanceof BitunixApiError);
      assert.equal((error as BitunixApiError).kind, "maintenance");
      assert.equal((error as BitunixApiError).httpStatus, 503);
      return true;
    }
  );
  // Genau retryMax Versuche — das Budget ist endlich, kein Endlos-Loop.
  assert.equal(calls.filter((c) => c.path === BITUNIX_PATHS.depth).length, 3);
});

test("HTTP-Regression: 429 persistiert über Budget → BitunixApiError(rate-limit)", async () => {
  const { adapter } = wrapperFromFetch({ depthStatus: 429, depthFailTimes: 10_000, retryMax: 2 });
  await assert.rejects(
    () => adapter.getOrderBook("BTCUSDT"),
    (error: unknown) => {
      assert.ok(error instanceof BitunixApiError);
      assert.equal((error as BitunixApiError).kind, "rate-limit");
      return true;
    }
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Security-Audit: Env-Proxy, Redaction, Rate-Limit-Autorität
// ════════════════════════════════════════════════════════════════════════════

test("BITUNIX_API_KEY/_SECRET werden im Sync-Pfad nicht gelesen (Env-Proxy)", async () => {
  const api = new BitunixFixtureApi();
  const baseUrl = await api.start();
  try {
    const secretTouches: string[] = [];
    const guardedEnv: Record<string, string | undefined> = new Proxy(
      { ...syncEnv(baseUrl) },
      {
        get(target, key) {
          if (key === "BITUNIX_API_KEY" || key === "BITUNIX_API_SECRET") {
            secretTouches.push(String(key));
          }
          return target[String(key)];
        },
      }
    );
    const adapters = registerMarketDataAdapters(guardedEnv);
    const service = new MarketDataSyncService(tmpRegistry(), tmpHistory(), adapters, {
      timeframes: ["1h"],
      candleLimit: 100,
      concurrency: 1,
      logger: () => {},
    });
    const result = await service.syncVenue("BITUNIX");
    assert.ok(result.synced > 0);
    assert.deepEqual(secretTouches, [], "Der Sync-Pfad liest BITUNIX_API_KEY/_SECRET nie");
  } finally {
    await api.stop();
  }
});

test("Fehler- und Log-Ausgaben enthalten keine Header/Secrets (Redaction)", async () => {
  const { adapter } = wrapperFromFetch({ depthStatus: 500, depthFailTimes: 10_000, retryMax: 1 });
  const registry = tmpRegistry();
  const history = tmpHistory();
  const instruments = await wrapperFromFetch().adapter.discoverInstruments();
  const instrument = instruments.find((i) => i.symbol === "BTCUSDT")!;
  const service = new MarketDataSyncService(registry, history, new Map([["BITUNIX", adapter]]), {
    timeframes: ["1h"],
    candleLimit: 100,
    concurrency: 1,
    logger: () => {},
  });
  // Depth fällt hart auf 500 → SyncFailure; die Meldung darf weder URL noch
  // Credential-Muster enthalten (Taxonomie-Meldungen sind fix, kein Payload-Echo).
  const result = await service.syncVenue("BITUNIX");
  assert.ok(result.failures.length > 0, "Fehler bleibt sichtbar");
  const serialized = JSON.stringify(result.failures);
  assert.equal(/https?:\/\//i.test(serialized), false, "keine URLs im Fehler-Manifest");
  assert.equal(/api[_-]?key|secret|signature|authorization/i.test(serialized), false, "keine Credential-Muster");
  for (const failure of result.failures) {
    assert.ok(failure.message.length <= 200, "Meldung ist längenbegrenzt");
  }
});

test("Rate-Limit: 8 req/s bleiben autoritativ, auch mit mehreren Adaptern (geteilter Bucket)", async () => {
  const { fetchImpl } = fixtureFetch();
  const config = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: "http://127.0.0.1:9",
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
    BITUNIX_RETRY_MAX: "1",
    BITUNIX_TIMEOUT_MS: "1000",
  });
  // EIN Token-Bucket für BEIDE Adapter — genau so registriert
  // registerAdapters() die Venues eines Laufs (Budget gilt pro IP).
  const sharedBucket = new TokenBucket(config.publicRatePerSec, config.publicRatePerSec);
  const clientA = new BitunixPublicClient({ config, bucket: sharedBucket, fetchImpl });
  const clientB = new BitunixPublicClient({ config, bucket: sharedBucket, fetchImpl });
  const adapterA = createBitunixMarketDataAdapter({ publicClient: clientA, symbolNormalizer: normalizeVenueSymbol });
  const adapterB = createBitunixMarketDataAdapter({ publicClient: clientB, symbolNormalizer: normalizeVenueSymbol });

  const startedAt = Date.now();
  for (let i = 0; i < 6; i += 1) await adapterA.getOrderBook("BTCUSDT");
  for (let i = 0; i < 6; i += 1) await adapterB.getOrderBook("BTCUSDT");
  const elapsed = Date.now() - startedAt;

  // 12 Calls gegen einen 8er-Burst/8-pro-s-Bucket: 8 sofort, 4 × ~125 ms
  // ⇒ ≥ 500 ms. Zwei unabhängige Buckets wären in ~0 ms durch.
  assert.ok(elapsed >= 400, `geteilter Bucket drosselt nicht (12 Calls in ${elapsed} ms)`);

  // Die Produktions-Registrierung drosselt mit dem dokumentierten Limit …
  assert.equal(config.publicRatePerSec, 8, "BITUNIX_PUBLIC_RATE_PER_SEC = 8 (dokumentiert 10, konservativ 8)");
  // … und buildt den Bucket zentral pro Lauf (statischer Nachweis):
  const registerSrc = codeWithoutComments(path.join("src", "marketdata", "registerAdapters.ts"));
  assert.match(registerSrc, /new TokenBucket\(BITUNIX_PUBLIC_RATE_PER_SEC, BITUNIX_PUBLIC_RATE_PER_SEC\)/);
});

// ════════════════════════════════════════════════════════════════════════════
// Integration: voller Sync über die Registrierung (echte Fixture-Daten)
// ════════════════════════════════════════════════════════════════════════════

test("voller Sync über registerMarketDataAdapters füllt Registry und HistoricalStore", async () => {
  const api = new BitunixFixtureApi();
  const baseUrl = await api.start();
  try {
    const registry = tmpRegistry();
    const history = tmpHistory();
    const service = new MarketDataSyncService(registry, history, registerMarketDataAdapters(syncEnv(baseUrl)), {
      timeframes: ["1h"],
      candleLimit: 100,
      concurrency: 1,
      now: () => new Date("2026-08-31T12:00:00.000Z"),
      logger: () => {},
    });

    const result = await service.syncVenue("BITUNIX");

    // Echte Fixture: 4 Instrumente; Ticker nur für BTC/ETH → 2 Lücken-Fehler.
    assert.equal(result.discovered, 4);
    assert.equal(result.synced, 4);
    assert.equal(result.tickersEnriched, 2);
    assert.equal(result.orderbooksEnriched, 4, "depth für alle 4 (Spread aus dem Orderbuch)");
    assert.equal(result.spreadsUnknown, 0);
    assert.equal(result.failures.length, 2, JSON.stringify(result.failures));
    assert.equal(result.failures.filter((f) => f.stage === "ticker").length, 2);

    // Registry: angereicherter Satz (Volumen aus tickers, Spread aus depth).
    const btc = registry.get("BITUNIX:BTCUSDT");
    assert.ok(btc, "BTCUSDT in der Registry");
    assert.equal(btc!.status, "active");
    assert.equal(btc!.volume24h, 2_019_875_040.71302, "quoteVol der echten Fixture");
    assert.ok(btc!.spread !== null && btc!.spread > 0 && btc!.spread < 0.001, "Spread berechnet (bp-Bereich)");

    // HistoricalStore: 4 Instrumente × 3 echte Kerzen (1h).
    assert.equal(result.candlesByTimeframe["1h"]?.instruments, 4);
    assert.equal(result.candlesByTimeframe["1h"]?.bars, 12);
    assert.ok(history.count() >= 12);
  } finally {
    await api.stop();
  }
});

test("Bulk-Ticker: getTickers fragt ALLE Symbole in EINEM Request (kein N+1)", async () => {
  const { adapter, calls } = wrapperFromFetch();
  const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT"];
  const tickers = await adapter.getTickers!(symbols);

  assert.equal(tickers.length, 2, "Fixture-Ticker für BTC/ETH");
  assert.ok(tickers.every((t) => t.price > 0 && t.quoteVol !== undefined));
  const tickerCalls = calls.filter((c) => c.path === BITUNIX_PATHS.tickers);
  assert.equal(tickerCalls.length, 1, "genau EIN tickers-Request");
  assert.equal(tickerCalls[0].query.symbols, symbols.join(","), "Symbol-Filter als kommaseparierte Liste");
});

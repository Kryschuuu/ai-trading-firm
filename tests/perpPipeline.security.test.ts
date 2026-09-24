/**
 * Security- und Architektur-Tests der Perp-Daten (RMA-P2-02).
 *
 * Abgedeckte Audit-Punkte:
 *  1. Public-only: kein PrivateClient, keine Credentials, keine Signaturen im
 *     Perp-Pfad (die einzige Key-Erwähnung ist das Redaktionsmuster selbst).
 *  2. Leak-freie Ablage: Adapter-Ausnahmen erreichen Manifest und Log nur
 *     redigiert, längenbegrenzt, einzeilig.
 *  3. Keine Roh-Payloads: Persistenz kennt ausschließlich kanonische Spalten.
 *  4. Injection-Grenze: Instrument-IDs laufen durch eine Allowlist, bevor sie
 *     Requests, Dateinamen oder Metrik-Labels werden.
 *  5. Begrenzte Labels: `instrumentId`/`symbol` sind keine Label-Dimensionen.
 *  6. Read-only-API: die Routen lösen keinen Sync aus und rufen kein Netzwerk.
 *  7. harte Caps: eine 50 000-Zeilen-Antwort endet begrenzt, nicht als OOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { perpRedactMessage, PerpQueryError } from "../src/perpdata/errors";
import { loadPerpConfig } from "../src/perpdata/config";
import { syncPerpVenue } from "../src/perpdata/sync";
import { queryPerpSeries, validateAsOfRequest } from "../src/perpdata/query";
import { InMemoryPerpStore } from "../src/perpdata/memoryStore";
import { fundingToInsert, liquidationToInsert, openInterestToInsert } from "../src/perpdata/store";
import { PERP_QUALITY_REPORT_FILE } from "../src/perpdata/quality";
import { PERP_DERIVATIVE_CACHE_FILE } from "../src/perpdata/derivativeCache";
import { normalizeFundingRow, normalizeLiquidationRow, normalizeOpenInterestRow } from "../src/perpdata/normalize";
import { perpCapabilitiesFor } from "../src/perpdata/capabilities";
import { isPerpInstrumentId, PERP_LIMITS, type PerpFetchResult, type RawFundingRow } from "../src/perpdata/types";
import type { PerpDataAdapter } from "../src/perpdata/port";
import type { MarketInstrument } from "../src/universe/types";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Quelltext ohne Kommentare — geprüft wird Code, nicht Doku. */
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

const NOW = new Date("2026-09-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const INTERVAL = 8 * 3_600_000;
const T0 = NOW_MS - 4 * INTERVAL;

const ENV = {
  PERP_DATA_ENABLED: "true",
  PERP_DATA_SYNC_ENABLED: "true",
  PERP_DATA_VENUES: "SIM",
  PERP_DATA_SAFETY_LAG_MS: "0",
  PERP_DATA_BACKFILL_DAYS: "1",
} as const;

const BTC: MarketInstrument = {
  id: "SIM:BTCUSDT",
  venue: "SIM",
  symbol: "BTCUSDT",
  base: "BTC",
  quote: "USDT",
  assetClass: "crypto",
  marketType: "perpetual",
  status: "active",
  minQuantity: 0.001,
  priceStep: 0.1,
  quantityStep: 0.001,
  makerFee: 0.0002,
  takerFee: 0.0006,
  leverageAvailable: true,
  shortAvailable: true,
  paperAvailable: true,
  liveTradable: false,
  liveAvailable: false,
  volume24h: null,
  spread: null,
  bookDepthUsd: null,
  volatility: null,
  lastSeen: NOW.toISOString(),
};

function normalizeCtx() {
  return {
    venue: "SIM",
    instrumentId: BTC.id,
    symbol: BTC.symbol,
    sourceId: "sim:v1",
    fetchedAt: NOW,
    availabilityPolicy: "ingested" as const,
    maxAbsFundingRate: 0.0075,
  };
}

/** Adapter aus dem Sync-Test-Bett, aber mit konfigurierbarer Rohantwort. */
function scriptedAdapter(behavior: (request: { limit: number }) => PerpFetchResult<RawFundingRow>): PerpDataAdapter {
  const capabilities = perpCapabilitiesFor("SIM");
  return {
    venue: "SIM",
    capabilities,
    fetchFunding: async (request) => behavior(request as never),
    fetchOpenInterest: async () => ({ availability: "UNSUPPORTED", reason: "NO_PUBLIC_ENDPOINT", note: "fixture: keine OI-Reihe" }),
    fetchLiquidations: async () => ({ availability: "UNSUPPORTED", reason: "NO_PUBLIC_ENDPOINT", note: "fixture: keine Liquidationen" }),
  };
}

// ── 1. Public-only ───────────────────────────────────────────────────────────

test("Perp-Schicht kennt keinen PrivateClient, keine API-Keys, keine Signaturen", () => {
  const files = walk("src/perpdata", (f) => f.endsWith(".ts"));
  assert.ok(files.length >= 15, `erwartet ≥15 Quelldateien, fand ${files.length}`);
  const forbidden = /privateClient|apiSecret|apiKey|API_KEY|signQuery|createHmac|Authorization/i;
  for (const file of files) {
    const offenders = code(file)
      .split("\n")
      .map((line, index) => ({ line, index }))
      // Die Redaktion muss Credential-Muster *kennen*, um sie zu tilgen —
      // erlaubt ist deshalb nur die Maskierung selbst (Aufruf nach `replace`,
      // oder ein nacktes Regex-Literal als Datenmuster), nie eine Verwendung.
      .filter(
        (entry) =>
          forbidden.test(entry.line) &&
          !/redact|replace\(|mask/i.test(entry.line) &&
          !/^\s*\/.*\/[a-z]*,?$/.test(entry.line)
      );
    assert.deepEqual(offenders, [], `${file} verweist auf Private-/Signing-Code (Zeile ${offenders.map((o) => o.index + 1).join(",")})`);
  }
  // Der Transport ist ausschließlich der credential-freie Public-Client.
  const registry = code("src/perpdata/registry.ts");
  assert.match(registry, /new BitunixPublicClient\(/);
  assert.doesNotMatch(registry, /privateClient|secretStore|BitunixBrokerAdapter|readSecret/i);
});

// ── 2. Leak-freie Meldungen ──────────────────────────────────────────────────

test("perpRedactMessage tilgt URLs, Query-Strings und Credential-Muster", () => {
  const leaking =
    "GET https://fapi.bitunix.com/api/v1/futures/market/get_funding_rate_history?symbol=BTCUSDT&api_key=SECRETABCDEF123456&signature=deadbeef failed (500)";
  const safe = perpRedactMessage(new Error(leaking));
  assert.ok(!safe.includes("fapi.bitunix.com"), `URL blieb stehen: ${safe}`);
  assert.ok(!safe.includes("SECRETABCDEF123456"), `Key blieb stehen: ${safe}`);
  assert.ok(!safe.includes("deadbeef"), `Signatur blieb stehen: ${safe}`);
  assert.ok(safe.includes("[url]"), "URL muss durch [url] ersetzt werden");
  assert.ok(safe.length <= 200, "Meldung ist längenbegrenzt");

  // Log-Injection (neue Zeilen, Steuerzeichen) wird neutralisiert.
  const injected = perpRedactMessage("zeile1\n[perp] gefälschte zeile\u00002");
  assert.ok(!injected.includes("\n"), "keine Mehrzeiligkeit im Log");
  assert.ok(!injected.includes("\u0000"), "keine Steuerzeichen im Log");
  // Fremd-Eingaben werden nie zu einem Wurf und nie mehrzeilig.
  for (const odd of [null, undefined, 42, { code: 42 }, ["a\nb"], Symbol.iterator as unknown as object]) {
    const out = perpRedactMessage(odd);
    assert.equal(typeof out, "string");
    assert.ok(!out.includes("\n"), `Mehrzeiligkeit bei ${String(odd)}`);
  }
  // Leere Meldung bleibt leer (Platzhalter erfindet der Aufrufer, nicht der Redaktor).
  assert.equal(perpRedactMessage(""), "");
  assert.equal(perpRedactMessage("   \n\t "), "");
});

test("Adapter-Ausnahme erreicht Manifest, Ergebnis und Log nur redigiert", async () => {
  const store = new InMemoryPerpStore();
  const lines: string[] = [];
  const adapter = scriptedAdapter(() => {
    throw new Error(
      "connect ECONNREFUSED https://fapi.bitunix.com/api/v1/futures/market/get_funding_rate_history?symbol=BTCUSDT&api_key=SECRET_ABC_123&signature=deadbeefdeadbeef"
    );
  });
  const results = await syncPerpVenue({
    venue: "SIM",
    adapter,
    store,
    config: loadPerpConfig(ENV),
    instruments: [BTC],
    mode: "BACKFILL",
    now: () => NOW,
    sleep: async () => undefined,
    writeQualityArtifact: false,
    logger: (_level, line) => lines.push(line),
  });

  const persisted = await store.recentRuns(10);
  assert.ok(persisted.length > 0, "der fehlgeschlagene Lauf bleibt als Manifest erhalten");
  const serialized = JSON.stringify({ persisted, results });
  assert.ok(!/https?:\/\//i.test(serialized), "keine URLs im Fehler-Manifest");
  assert.ok(!/api[_-]?key|secret|signature|token/i.test(serialized), "keine Credential-Muster im Manifest");
  assert.ok(!/SECRET_ABC_123|deadbeef/.test(serialized), "keine Secret-Werte im Manifest");
  assert.ok(!/[\r\n]/.test(serialized), "Manifest bleibt einzeilig (keine Log-Injection)");
  assert.ok(serialized.length < 4_000, "Manifest ist längenbegrenzt");
  assert.equal(lines.some((line) => /https?:\/\//i.test(line)), false, "keine URLs in den Log-Zeilen");
  assert.equal(lines.some((line) => /SECRET_ABC_123|deadbeef/i.test(line)), false, "keine Secrets im Log");
  assert.ok(
    results.some((result) => result.failures.some((failure) => failure.stage === "fetch")),
    "der Fehler ist klassifiziert sichtbar — nicht still"
  );
});

// ── 3. Keine Roh-Payloads ────────────────────────────────────────────────────

test("Persistenz kennt nur kanonische Spalten (kein Provider-Payload)", () => {
  for (const file of [...walk("src/perpdata", (f) => f.endsWith(".ts")), "src/db/schema.ts", "drizzle/2026-09-20_perpetual_data.sql"]) {
    const src = read(file);
    assert.equal(/raw_payload|rawPayload|providerPayload|rawResponse|payloadJson/.test(src), false, `${file} speichert Provider-Payloads`);
  }
  // Die Insert-Maps sind der einzige Schreibpfad — ihre Schlüssel sind die Erlaubnisliste.
  const ctx = normalizeCtx();
  const funding = fundingToInsert(
    normalizeFundingRow({ eventTime: T0, fundingRate: 0.0001, intervalHours: 8, extra: "payload" } as unknown as RawFundingRow, 0, ctx).row!,
    "run"
  );
  const oi = openInterestToInsert(
    normalizeOpenInterestRow({ eventTime: T0, contracts: 1000, basis: "contracts", raw: { any: 1 } } as never, 0, ctx).row!,
    "run"
  );
  const liq = liquidationToInsert(
    normalizeLiquidationRow({ eventTime: T0, side: "LONG", quantityBase: 1, price: 66000, debugBlob: "x" } as never, 0, ctx).row!,
    "run"
  );
  const allowed = new Set([
    "id", "runId", "venue", "instrumentId", "symbol", "sourceId", "schemaVersion", "eventTime", "availableAt", "fetchedAt",
    "fundingRate", "intervalHours", "nextFundingTime", "markPrice", "unit", "qualityStatus", "missingReason", "contentHash",
    "contracts", "baseQuantity", "quoteValue", "basis", "contractSize", "quoteCurrency", "converted",
    "side", "quantityBase", "price", "notionalQuote", "sourceEventId", "aggregateCount",
  ]);
  for (const [name, map] of [["funding", funding], ["openInterest", oi], ["liquidations", liq]] as const) {
    const foreign = Object.keys(map).filter((key) => !allowed.has(key));
    assert.deepEqual(foreign, [], `${name}: unbekannte Insert-Schlüssel ${foreign.join(",")}`);
  }
  assert.ok(!JSON.stringify([funding, oi, liq]).includes("payload"), "Rohwert-Felder erreichen die Ablage nicht");
});

// ── 4. Injection-Grenze ──────────────────────────────────────────────────────

test("Instrument-ID-Allowlist blockt Pfad-, Query- und Header-Injection", () => {
  const rejected = [
    "",
    "SIM:BTCUSDT?debug=1",
    "SIM:BTCUSDT#frag",
    "../../etc/passwd",
    "SIM:BTC USDT",
    "SIM:BTC\nUSDT",
    "SIM:BTC\u0000USDT",
    "sim:BTCUSDT",
    "SIM:",
    ":BTCUSDT",
    "SIM:BTCUSDT:EXTRA",
    "SIM:🦄USDT",
    `SIM:${"X".repeat(64)}`,
    "SIM/..%2fBTCUSDT",
  ];
  for (const raw of rejected) {
    assert.equal(isPerpInstrumentId(raw), false, `"${raw}" hätte abgelehnt werden müssen`);
  }
  for (const ok of ["SIM:BTCUSDT", "BITUNIX:BTC/USDT", "BITUNIX:BTC-USD", "SIM:XBTUSDT.P", "SIM:BTC_USDT", "A:B"]) {
    assert.equal(isPerpInstrumentId(ok), true, `${ok} muss erlaubt sein`);
  }
});

test("as-of-Abfrage lehnt ungeprüfte IDs ab, bevor sie die Ablage erreichen", () => {
  const config = loadPerpConfig(ENV);
  for (const hostile of ["../../etc/passwd", "SIM:BTCUSDT?admin=1", "SIM:BTC\u0000USDT"]) {
    assert.throws(
      () => validateAsOfRequest({ instruments: [hostile], fromMs: null, toMs: null, asOfMs: NOW_MS }, config, NOW_MS),
      (error: unknown) =>
        error instanceof PerpQueryError &&
        (error as PerpQueryError).code === "query:invalid_instrument" &&
        // Der Echo-Feldwert ist gekürzt und einzeilig — keine Injektion ins Log.
        !String((error as PerpQueryError).detail?.instrumentId ?? "").includes("\u0000"),
      `${hostile} muss als Anfrage ablehnbar sein`
    );
  }
});

test("eine Abfrage liest nur, was as-of verfügbar ist — und nie mehr als das Limit", async () => {
  const store = new InMemoryPerpStore();
  const ctx = normalizeCtx();
  const freshMs = NOW_MS - 90 * 60_000;
  const futureMs = NOW_MS + 60_000;
  const rows = [
    normalizeFundingRow({ eventTime: freshMs, fundingRate: 0.0001, intervalHours: 8 }, 0, ctx).row!,
    normalizeFundingRow({ eventTime: futureMs, fundingRate: 0.0002, intervalHours: 8 }, 1, ctx).row!,
  ];
  await store.commitRun({
    run: {
      id: "run-1",
      idempotencyKey: "prk1:security",
      venue: "SIM",
      mode: "BACKFILL",
      status: "SUCCEEDED",
      availabilityPolicy: "ingested",
      fromTs: new Date(T0),
      toTs: new Date(NOW_MS),
      kinds: ["funding"],
      instrumentIds: [BTC.id],
      counts: {},
      capabilities: perpCapabilitiesFor("SIM"),
      failures: [],
      codeVersion: "test",
      errorCode: null,
      startedAt: NOW,
      finishedAt: NOW,
    },
    batch: { funding: rows, openInterest: [], liquidations: [] },
    cursors: [],
  });

  const response = await queryPerpSeries(store, { instruments: [BTC.id], venue: "SIM" }, { config: loadPerpConfig(ENV), nowMs: NOW_MS });
  const funding = response.series.find((serie) => serie.kind === "funding")!;
  assert.equal(funding.rows.length, 1, "Satz aus der Zukunft darf nicht erscheinen");
  assert.equal(funding.rows[0]?.eventTime.getTime(), freshMs);
  assert.equal(funding.availability, "AVAILABLE", "frische Reihe ist verfügbar (kein STALE bei 90 min)");
  assert.equal(response.asOf, NOW.toISOString());
});

// ── 5. Begrenzte Metrik-Labels ───────────────────────────────────────────────

test("Metrik-Labels tragen keine Instrument-IDs (Kardinalitäts-Cap)", () => {
  const files = [...walk("src/perpdata", (f) => f.endsWith(".ts")), "src/app/api/marketdata/perpetual/series/route.ts"];
  let labelSites = 0;
  for (const file of files) {
    const src = code(file);
    for (const match of src.matchAll(/\.inc\(\s*\{([^}]*)\}/g)) {
      labelSites += 1;
      const labels = match[1] ?? "";
      const keys = [...labels.matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((entry) => entry[1]);
      assert.ok(keys.length > 0 && keys.length <= 3, `${file}: ${keys.length} Label-Dimensionen (max 3)`);
      const foreign = keys.filter((key) => !["kind", "result", "class", "mode", "stage"].includes(key));
      assert.deepEqual(foreign, [], `${file}: Label-Schlüssel außerhalb der Allowlist: ${foreign.join(",")}`);
      assert.equal(/\$\{|instrumentId|symbol|\bvenue\b/.test(labels), false, `${file}: dynamisches/unbegrenztes Label „${labels.trim()}“`);
    }
  }
  assert.ok(labelSites >= 4, `erwartet ≥4 Messstellen, fand ${labelSites} — Test würde sonst nichts prüfen`);
});

// ── 6. Read-only-API ─────────────────────────────────────────────────────────

test("Perp-Routen lösen keinen Sync aus und rufen kein Netzwerk", () => {
  const routes = walk("src/app/api/marketdata/perpetual", (f) => f.endsWith("route.ts"));
  assert.equal(routes.length, 2, `erwartet series + status, fand ${routes.join(",")}`);
  for (const route of routes) {
    const src = code(route);
    assert.doesNotMatch(src, /syncPerpVenue|runPerpSync|PerpDataService\.sync|createPerpAdapters|registerPerpAdapters/, `${route} triggert einen Sync`);
    assert.equal(/(^|[^.\w])fetch\s*\(/.test(src), false, `${route} ruft fetch() auf`);
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(src), false, `${route} ist nicht read-only`);
    assert.match(src, /export async function GET/, `${route} fehlt GET`);
  }
  // Verbraucher (Scanner, Analysten, Cache) sind reine Leser der Ablage.
  for (const file of ["src/perpdata/consumers.ts", "src/perpdata/derivativeCache.ts", "src/perpdata/query.ts", "src/perpdata/replay.ts"]) {
    const src = code(file);
    assert.equal(/(^|[^.\w])fetch\s*\(/.test(src), false, `${file} ruft fetch() auf`);
    assert.doesNotMatch(src, /createPerpAdapter\w*\(|registerPerpAdapters\(|new BitunixPublicClient/, `${file} baut Adapter selbst`);
  }
});

test("Artefakt-Pfade sind fix, Instrument-IDs werden nie zu Dateinamen", () => {
  assert.equal(PERP_QUALITY_REPORT_FILE, path.join("data", "perpdata", "quality-report.json"));
  assert.equal(PERP_DERIVATIVE_CACHE_FILE, path.join("data", "perpdata", "derivatives.json"));
  for (const file of walk("src/perpdata", (f) => f.endsWith(".ts"))) {
    const src = code(file);
    const offenders = src.split("\n").filter((line) => /path\.join|writeFileSync|mkdirSync/.test(line) && /instrumentId|symbol\b|\bsym\b/.test(line));
    assert.deepEqual(offenders, [], `${file}: Pfad aus Instrument-/Symbolwert abgeleitet`);
  }
});

// ── 7. Harte Caps ───────────────────────────────────────────────────────────

test("Antwortbombing endet begrenzt: Requests und Zeilen sind gekappt", async () => {
  assert.equal(PERP_LIMITS.syncInstruments, 250);
  assert.ok(PERP_LIMITS.rowsPerRequest === 500 && PERP_LIMITS.requestsPerSeries === 20, "dokumentierte Caps");
  assert.ok(PERP_LIMITS.queryRowsPerSeries <= 2_000 && PERP_LIMITS.querySourceRows <= 20_000);
  assert.ok(PERP_LIMITS.insertChunkRows <= 250 && PERP_LIMITS.findingsPerSeries <= 200);

  const store = new InMemoryPerpStore();
  let requests = 0;
  const askedLimits: number[] = [];
  const huge = Array.from({ length: 50_000 }, (_, index) => ({
    eventTime: T0 + index * 1_000,
    fundingRate: 0.0001,
    intervalHours: 8,
  }));
  const adapter = scriptedAdapter((request) => {
    requests += 1;
    askedLimits.push(request.limit);
    return { availability: "AVAILABLE", series: { sourceId: "sim:bomb", rows: huge, truncated: true, fetchedAt: NOW } };
  });
  const results = await syncPerpVenue({
    venue: "SIM",
    adapter,
    store,
    config: loadPerpConfig(ENV),
    instruments: [BTC],
    mode: "BACKFILL",
    now: () => NOW,
    sleep: async () => undefined,
    rateLimiter: async () => undefined,
    writeQualityArtifact: false,
  });

  assert.ok(requests > 0, "die Venue wurde befragt");
  assert.ok(
    requests <= PERP_LIMITS.requestsPerSeries * 2,
    `Request-Zahl muss durch requestsPerSeries gedeckelt sein, war ${requests}`
  );
  assert.ok(store.size <= PERP_LIMITS.batchRows, `Bestand ≤ batchRows, war ${store.size}`);
  assert.ok(askedLimits.every((limit) => limit === PERP_LIMITS.rowsPerRequest), `Venue wird um ≤ rowsPerRequest gebeten, war ${askedLimits.join(",")}`);
  assert.ok(results[0].stats.funding.fetched <= PERP_LIMITS.batchRows * requests, "gelesene Zeilen bleiben im dokumentierten Budget");
  assert.ok(results[0].requests > 0 && results[0].requests <= PERP_LIMITS.requestsPerSeries * 6, "Request-Zähler im Manifest");
});

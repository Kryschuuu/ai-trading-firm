/**
 * Integrationstests: API-Contract von `/api/markets` und Persistenz-Reload.
 *
 * Kein echter Netzwerkverkehr — die Route-Handler werden direkt mit
 * `Request`-Objekten aufgerufen; die Registry arbeitet auf einem temporären
 * Datenverzeichnis bzw. auf der committeten Fixture.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE = path.join(process.cwd(), "tests/fixtures/universe-instruments.ndjson");

let dir: string;
let GET: (req: Request) => Promise<Response>;
let GET_ONE: (req: Request, ctx: { params: Promise<{ venue: string; symbol: string }> }) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "universe-api-"));
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, path.join(dir, "instruments.ndjson"));
  process.env.UNIVERSE_DATA_DIR = dir;

  ({ GET } = await import("../src/app/api/markets/route"));
  ({ GET: GET_ONE } = await import("../src/app/api/markets/[venue]/[symbol]/route"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UNIVERSE_DATA_DIR;
});

function call(query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/markets${query}`));
}

async function json(res: Response): Promise<Record<string, never>> {
  return (await res.json()) as Record<string, never>;
}

test("API: GET /api/markets liefert venue, count, lastSync, instruments[]", async () => {
  const res = await call();
  assert.equal(res.status, 200);
  const body = (await json(res)) as unknown as {
    ok: boolean;
    venue: string;
    count: number;
    lastSync: string;
    instruments: { id: string }[];
    groups: { venue: string; count: number }[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.venue, "ALL");
  assert.equal(body.count, 26);
  assert.equal(body.lastSync, "2026-08-27T00:00:00.000Z");
  assert.equal(body.instruments.length, 26);
  assert.deepEqual(body.groups.map((g) => g.venue), ["ALPACA", "BINANCE", "IBKR", "KRAKEN", "PAPER"]);
});

test("API: Venue-Filter gruppiert und beschriftet den Ausschnitt", async () => {
  const body = (await json(await call("?venue=binance"))) as unknown as { venue: string; count: number; groups: unknown[] };
  assert.equal(body.venue, "BINANCE");
  assert.equal(body.count, 3);
  assert.equal(body.groups.length, 1);

  const multi = (await json(await call("?venue=BINANCE,KRAKEN"))) as unknown as { venue: string; count: number };
  assert.equal(multi.venue, "BINANCE,KRAKEN");
  assert.equal(multi.count, 6);
});

test("API: Filterkombination und Pagination-Metadaten", async () => {
  const body = (await json(
    await call("?assetClass=crypto&paperAvailable=true&pageSize=2&page=2"),
  )) as unknown as { count: number; total: number; page: number; pageSize: number; hasMore: boolean };
  assert.equal(body.total, 9);
  assert.equal(body.page, 2);
  assert.equal(body.pageSize, 2);
  assert.equal(body.count, 2);
  assert.equal(body.hasMore, true);
});

test("API: pageSize wird auf 500 geklemmt statt abgelehnt", async () => {
  const body = (await json(await call("?pageSize=100000"))) as unknown as { pageSize: number };
  assert.equal(body.pageSize, 500);
});

test("API: ungültige Filter liefern 400 mit Fehler-JSON-Contract", async () => {
  for (const q of ["?assetClass=quatsch", "?venue=..%2Fetc", "?paperAvailable=vielleicht", "?minVolume24h=-5", "?base=BTC$", "?status="]) {
    const res = await call(q);
    assert.equal(res.status, 400, `erwartet 400 für ${q}`);
    const body = (await json(res)) as unknown as { ok: boolean; error: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "VALIDATION_ERROR");
    assert.ok(body.message.length > 0);
  }
});

test("API: überlange Parameter werden abgewiesen (Log-/DoS-Schutz)", async () => {
  const res = await call(`?venue=${"A".repeat(300)}`);
  assert.equal(res.status, 400);
});

test("API: Detail-Route liefert Instrument samt Relationen", async () => {
  const res = await GET_ONE(new Request("http://localhost/api/markets/BINANCE/BTCUSDT"), {
    params: Promise.resolve({ venue: "BINANCE", symbol: "BTCUSDT" }),
  });
  assert.equal(res.status, 200);
  const body = (await json(res)) as unknown as {
    ok: boolean;
    instrument: { id: string; assetId: string; underlyingId: string };
    related: string[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.instrument.id, "BINANCE:BTCUSDT");
  assert.equal(body.instrument.assetId, "BTC");
  assert.equal(body.instrument.underlyingId, "BTC");
  assert.deepEqual(body.related.sort(), ["KRAKEN:BTC/USD", "PAPER:BTC"]);
});

test("API: Detail-Route akzeptiert kodierte und ~-Schrägstriche", async () => {
  for (const symbol of ["BTC%2FUSD", "BTC~USD"]) {
    const res = await GET_ONE(new Request(`http://localhost/api/markets/KRAKEN/${symbol}`), {
      params: Promise.resolve({ venue: "KRAKEN", symbol }),
    });
    assert.equal(res.status, 200, `erwartet 200 für ${symbol}`);
  }
});

test("API: Detail-Route liefert 404 und 400 mit Fehler-Contract", async () => {
  const notFound = await GET_ONE(new Request("http://localhost/api/markets/BINANCE/DOGEUSDT"), {
    params: Promise.resolve({ venue: "BINANCE", symbol: "DOGEUSDT" }),
  });
  assert.equal(notFound.status, 404);
  assert.equal(((await json(notFound)) as unknown as { error: string }).error, "NOT_FOUND");

  const badVenue = await GET_ONE(new Request("http://localhost/api/markets/x/y"), {
    params: Promise.resolve({ venue: "1", symbol: "BTCUSDT" }),
  });
  assert.equal(badVenue.status, 400);

  const badSymbol = await GET_ONE(new Request("http://localhost/api/markets/BINANCE/x"), {
    params: Promise.resolve({ venue: "BINANCE", symbol: "BTC USDT!" }),
  });
  assert.equal(badSymbol.status, 400);
  assert.equal(((await json(badSymbol)) as unknown as { error: string }).error, "VALIDATION_ERROR");
});

test("Persistenz: Prozessneustart verliert kein Feld", async () => {
  const { InstrumentRegistry } = await import("../src/universe/registry");
  const { INSTRUMENT_FIELDS } = await import("../src/universe/types");

  const tmp = mkdtempSync(path.join(tmpdir(), "universe-reload-"));
  try {
    const first = new InstrumentRegistry({ dir: tmp });
    first.load();
    first.upsert(
      {
        venue: "BITUNIX",
        symbol: "BTCUSDT",
        base: "BTC",
        quote: "USDT",
        assetClass: "crypto",
        marketType: "perpetual",
        status: "preview",
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
        volume24h: 123456.78,
        spread: 0.00012,
        volatility: 0.6543,
        lastSeen: "2026-08-27T09:30:00.000Z",
      },
      "test",
    );
    const before = first.get("BITUNIX:BTCUSDT");

    // „Neustart“: zweite Instanz liest ausschließlich von der Platte.
    const second = new InstrumentRegistry({ dir: tmp });
    second.load();
    const after2 = second.get("BITUNIX:BTCUSDT");

    assert.deepEqual(after2, before);
    for (const field of INSTRUMENT_FIELDS) {
      assert.ok(after2 && field in after2, `Feld ${field} fehlt nach dem Reload`);
    }
    assert.equal(second.lastSync, "2026-08-27T09:30:00.000Z");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Persistenz: kaputte Zeilen werden übersprungen, nicht geworfen", async () => {
  const { InstrumentRegistry } = await import("../src/universe/registry");
  const tmp = mkdtempSync(path.join(tmpdir(), "universe-broken-"));
  try {
    const good = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean).slice(0, 2).join("\n");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(tmp, "instruments.ndjson"), `${good}\nkein-json\n{"venue":"X"}\n# Kommentar\n`);
    const r = new InstrumentRegistry({ dir: tmp });
    r.load();
    assert.equal(r.size, 2);
    assert.equal(r.skippedLines, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Persistenz: die committete Seed-Fixture entspricht dem Seed-Generator", async () => {
  const { InstrumentRegistry } = await import("../src/universe/registry");
  const { SEED_INSTRUMENTS } = await import("../src/universe/seed");
  const tmp = mkdtempSync(path.join(tmpdir(), "universe-seedcmp-"));
  try {
    const r = new InstrumentRegistry({ dir: tmp });
    r.load();
    r.upsertMany([...SEED_INSTRUMENTS], "seed:test", "SEED");
    const generated = readFileSync(path.join(tmp, "instruments.ndjson"), "utf8");
    assert.equal(generated, readFileSync(FIXTURE, "utf8"));
    assert.equal(generated, readFileSync(path.join(process.cwd(), "data/universe/instruments.ndjson"), "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

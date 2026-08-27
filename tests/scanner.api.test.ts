/**
 * API-Contract-Tests der read-only Scanner-Endpunkte (Task 04).
 *
 * `GET /api/universe/daily`, `/weekly`, `/score/{instrumentId}` —
 * gegen einen injizierten Scanner-Service, ohne Netzwerk und ohne Datenbank.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { GET as dailyGET, parseDailyQuery } from "../src/app/api/universe/daily/route";
import { GET as weeklyGET, parseWeeklyQuery } from "../src/app/api/universe/weekly/route";
import { GET as scoreGET, parseInstrumentId } from "../src/app/api/universe/score/[instrumentId]/route";
import { ScannerService, setScannerServiceForTests } from "../src/scanner/service";
import { DEFAULT_SCANNER_CONFIG, resolveScannerConfig } from "../src/scanner/config";
import { AS_OF, healthyCandles, instrument } from "./fixtures/scannerFixtures";
import type { MarketInstrument } from "../src/universe/types";

const BASE = "http://localhost:3369";

const instruments: MarketInstrument[] = [
  instrument({ symbol: "BTCUSDT", volume24h: 5_000_000_000, spread: 0.0001 }),
  instrument({ symbol: "ETHUSDT", volume24h: 3_000_000_000, spread: 0.00015 }),
  instrument({ venue: "ALPACA", symbol: "SPY", assetClass: "etf", base: null, quote: "USD", volume24h: 2_000_000_000, spread: 0.0002 }),
  instrument({ symbol: "JUNKUSDT", volume24h: 100 }),
  instrument({ symbol: "DEADUSDT", status: "delisted" }),
];

function service(config = DEFAULT_SCANNER_CONFIG): ScannerService {
  return new ScannerService({
    config,
    now: () => new Date(AS_OF),
    instruments: () => instruments,
    data: { candles: () => healthyCandles(90) },
  });
}

beforeEach(() => {
  setScannerServiceForTests(service());
});

after(() => {
  setScannerServiceForTests(null);
});

// ── /api/universe/daily ──────────────────────────────────────────────────────

test("GET /api/universe/daily liefert Trichter-Ebenen inklusive Breakdown", async () => {
  const res = await dailyGET(new Request(`${BASE}/api/universe/daily`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    level: string;
    asOf: string;
    configVersion: number;
    funnel: { scanned: number; eligible: number; daily: number; deep: number };
    weights: Record<string, number>;
    items: { rank: number; instrumentId: string; score: number; breakdown?: unknown[] }[];
    total: number;
    hasMore: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(body.level, "daily");
  assert.equal(body.asOf, AS_OF);
  assert.equal(body.configVersion, 1);
  assert.equal(body.funnel.scanned, 5);
  assert.equal(body.funnel.eligible, 3);
  assert.equal(body.items[0].rank, 1);
  assert.ok(Array.isArray(body.items[0].breakdown));
  assert.equal(body.items[0].breakdown?.length, 9);
  assert.equal(body.weights.liquidity, 0.25);
  assert.equal(body.hasMore, false);
  // Ranking absteigend
  const scores = body.items.map((i) => i.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("GET /api/universe/daily: Ebenen deep/interesting/eligible sind wählbar", async () => {
  for (const level of ["deep", "interesting", "eligible"]) {
    const res = await dailyGET(new Request(`${BASE}/api/universe/daily?level=${level}`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { level: string; items: { breakdown?: unknown }[] };
    assert.equal(body.level, level);
    if (level !== "deep") {
      assert.equal(body.items[0]?.breakdown, undefined, `${level} darf keinen Breakdown liefern`);
    }
  }
});

test("GET /api/universe/daily: Pagination und harte Größenlimits", async () => {
  const page1 = await dailyGET(new Request(`${BASE}/api/universe/daily?pageSize=1&page=1`));
  const body1 = (await page1.json()) as { items: { rank: number }[]; hasMore: boolean; total: number };
  assert.equal(body1.items.length, 1);
  assert.equal(body1.items[0].rank, 1);
  assert.equal(body1.hasMore, true);

  const page2 = await dailyGET(new Request(`${BASE}/api/universe/daily?pageSize=1&page=2`));
  const body2 = (await page2.json()) as { items: { rank: number }[] };
  assert.equal(body2.items[0].rank, 2);

  const tooLarge = await dailyGET(new Request(`${BASE}/api/universe/daily?pageSize=5000`));
  assert.equal(tooLarge.status, 400);
  const err = (await tooLarge.json()) as { ok: boolean; error: string; message: string };
  assert.equal(err.ok, false);
  assert.equal(err.error, "VALIDATION_ERROR");
  assert.match(err.message, /pageSize/);
});

test("GET /api/universe/daily: unsinnige Parameter ⇒ 400 statt 500", async () => {
  for (const query of ["level=alles", "page=0", "page=abc", "pageSize=0", "pageSize=-3", "breakdown=vielleicht"]) {
    const res = await dailyGET(new Request(`${BASE}/api/universe/daily?${query}`));
    assert.equal(res.status, 400, `erwartete 400 für ?${query}`);
  }
});

test("parseDailyQuery: Defaults und Breakdown-Regeln", () => {
  const defaults = parseDailyQuery(new URL(`${BASE}/api/universe/daily`));
  assert.deepEqual(defaults, { level: "daily", page: 1, pageSize: 50, breakdown: true });
  assert.equal(parseDailyQuery(new URL(`${BASE}/x?level=eligible`)).breakdown, false);
  assert.equal(parseDailyQuery(new URL(`${BASE}/x?breakdown=false`)).breakdown, false);
  assert.equal(parseDailyQuery(new URL(`${BASE}/x?level=interesting&breakdown=true`)).breakdown, false);
});

// ── /api/universe/weekly ─────────────────────────────────────────────────────

test("GET /api/universe/weekly liefert Klassifikation und Zusammenfassung", async () => {
  const res = await weeklyGET(new Request(`${BASE}/api/universe/weekly`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    summary: Record<string, number>;
    changes: { newListings: string[] };
    items: { instrumentId: string; class: string; reasons: string[]; score: number; asOf: string }[];
    total: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.total, instruments.length);
  assert.equal(body.items.length, instruments.length);
  for (const item of body.items) {
    assert.deepEqual(Object.keys(item).sort(), ["asOf", "class", "instrumentId", "reasons", "score"]);
    assert.ok(["CORE", "ROTATION", "DISCOVERY", "EXCLUDED"].includes(item.class));
  }
  assert.equal(
    Object.values(body.summary).reduce((a, b) => a + b, 0),
    instruments.length
  );
  assert.ok(body.changes.newListings.length > 0);
});

test("GET /api/universe/weekly: Klassenfilter und Validierung", async () => {
  const res = await weeklyGET(new Request(`${BASE}/api/universe/weekly?class=EXCLUDED`));
  const body = (await res.json()) as { items: { class: string }[] };
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((i) => i.class === "EXCLUDED"));

  const multi = await weeklyGET(new Request(`${BASE}/api/universe/weekly?class=EXCLUDED,DISCOVERY`));
  assert.equal(multi.status, 200);

  for (const query of ["class=VIP", "class=", "page=0", "pageSize=999"]) {
    const bad = await weeklyGET(new Request(`${BASE}/api/universe/weekly?${query}`));
    assert.equal(bad.status, 400, `erwartete 400 für ?${query}`);
  }
  assert.deepEqual(parseWeeklyQuery(new URL(`${BASE}/x`)), { classes: null, page: 1, pageSize: 50 });
});

// ── /api/universe/score/{instrumentId} ───────────────────────────────────────

test("GET /api/universe/score/{id} liefert vollständigen Breakdown", async () => {
  const res = await scoreGET(new Request(`${BASE}/api/universe/score/BINANCE:BTCUSDT`), {
    params: Promise.resolve({ instrumentId: "BINANCE%3ABTCUSDT" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    score: { instrumentId: string; score: number; regime: string; breakdown: { component: string; contribution: number }[]; factors: Record<string, unknown> };
    levels: Record<string, boolean>;
    rejection: unknown;
  };
  assert.equal(body.ok, true);
  assert.equal(body.score.instrumentId, "BINANCE:BTCUSDT");
  assert.equal(body.score.breakdown.length, 9);
  assert.equal(Object.keys(body.score.factors).length, 14);
  const sum = body.score.breakdown.reduce((a, e) => a + e.contribution, 0);
  assert.ok(Math.abs(sum - body.score.score) < 1e-9);
  assert.equal(body.levels.eligible, true);
  assert.equal(body.rejection, null);
});

test("GET /api/universe/score/{id}: abgelehntes Instrument zeigt die Filterregel", async () => {
  const res = await scoreGET(new Request(`${BASE}/api/universe/score/BINANCE:JUNKUSDT`), {
    params: Promise.resolve({ instrumentId: "BINANCE:JUNKUSDT" }),
  });
  const body = (await res.json()) as { levels: Record<string, boolean>; rejection: { ruleId: string } | null };
  assert.equal(body.levels.eligible, false);
  assert.equal(body.rejection?.ruleId, "min-volume");
});

test("GET /api/universe/score/{id}: unbekannt ⇒ 404, kaputte ID ⇒ 400", async () => {
  const notFound = await scoreGET(new Request(`${BASE}/api/universe/score/BINANCE:NOSUCH`), {
    params: Promise.resolve({ instrumentId: "BINANCE:NOSUCH" }),
  });
  assert.equal(notFound.status, 404);
  assert.equal(((await notFound.json()) as { error: string }).error, "NOT_FOUND");

  for (const raw of ["kaputt", "binance", ":BTC", "BINANCE:BTC USDT", "A".repeat(80)]) {
    const res = await scoreGET(new Request(`${BASE}/api/universe/score/x`), {
      params: Promise.resolve({ instrumentId: raw }),
    });
    assert.equal(res.status, 400, `erwartete 400 für "${raw.slice(0, 20)}"`);
  }
});

test("parseInstrumentId: normalisiert Groß-/Kleinschreibung und ~-Alias", () => {
  assert.equal(parseInstrumentId("binance:btcusdt"), "BINANCE:BTCUSDT");
  assert.equal(parseInstrumentId("KRAKEN:BTC~USD"), "KRAKEN:BTC/USD");
  assert.equal(parseInstrumentId("KRAKEN%3ABTC%2FUSD"), "KRAKEN:BTC/USD");
  assert.throws(() => parseInstrumentId(""), /Länge/);
  assert.throws(() => parseInstrumentId("NOCOLON"), /VENUE:SYMBOL/);
});

// ── Service ──────────────────────────────────────────────────────────────────

test("Service: refresh() rechnet neu, Weekly folgt dem aktuellen Scan", () => {
  const svc = service();
  const first = svc.getScan();
  const weekly = svc.getWeekly();
  assert.equal(svc.getScan(), first, "zweiter Zugriff nutzt das gecachte Ergebnis");
  assert.equal(svc.getWeekly(), weekly);
  const refreshed = svc.refresh();
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.asOf, first.asOf);
  assert.equal(svc.scoreFor("BINANCE:BTCUSDT")?.instrumentId, "BINANCE:BTCUSDT");
  assert.equal(svc.scoreFor("BINANCE:UNBEKANNT"), null);
});

test("Service: eine engere Konfiguration verkleinert die Ebenen sichtbar", async () => {
  setScannerServiceForTests(service(resolveScannerConfig({ funnel: { dailyMax: 1, deepMax: 1, deepMin: 1 } })));
  const res = await dailyGET(new Request(`${BASE}/api/universe/daily`));
  const body = (await res.json()) as { funnel: { daily: number; deep: number }; total: number };
  assert.equal(body.funnel.daily, 1);
  assert.equal(body.funnel.deep, 1);
  assert.equal(body.total, 1);
});

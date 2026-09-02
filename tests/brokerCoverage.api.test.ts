/**
 * API-Test `GET /api/brokers/coverage` — Operations-Center-Coverage.
 *
 * Read-only (kein Token), keine Secrets im Body, stabiler Contract.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";
import { BROKER_VENUE_IDS } from "../src/contracts/broker";

let GET_COVERAGE: () => Promise<Response>;

before(async () => {
  ({ GET: GET_COVERAGE } = await import("../src/app/api/brokers/coverage/route"));
});

test("API: GET /api/brokers/coverage liefert Headline + Metriken + Rows", async () => {
  const res = await GET_COVERAGE();
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    ok: boolean;
    registeredVenues: number;
    internalVenues: number;
    externalVenues: number;
    fullDiscoveryVenues: number;
    paperMarketDataVenues: number;
    liveEnabledVenues: number;
    metrics: Array<{ id: string; label: string; covered: number; total: number; venues: string[] }>;
    rows: Array<{ venue: string; internal: boolean; liveEnabled: boolean }>;
  };

  assert.equal(body.ok, true);
  assert.equal(body.registeredVenues, BROKER_VENUE_IDS.length);
  assert.equal(body.internalVenues, 1);
  assert.equal(body.externalVenues, BROKER_VENUE_IDS.length - 1);

  // Geforderte Headline: 2 volle Discovery, 2 Paper-Market-Data, 0 Live
  // (BITUNIX + ALPACA als reale externe Venues mit voller Coverage, Task 12).
  assert.equal(body.fullDiscoveryVenues, 2);
  assert.equal(body.paperMarketDataVenues, 2);
  assert.equal(body.liveEnabledVenues, 0);

  assert.deepEqual(
    body.metrics.map((m) => m.id),
    ["discovery", "marketData", "paperExecution", "testnetExecution", "liveExecution"]
  );
  assert.equal(body.rows.length, BROKER_VENUE_IDS.length);

  // Keine Secrets im Body (Security-Regel).
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("API: Coverage-Metriken sind konsistent (covered == venues.length ≤ total)", async () => {
  const res = await GET_COVERAGE();
  const body = (await res.json()) as {
    metrics: Array<{ covered: number; total: number; venues: string[] }>;
  };
  for (const m of body.metrics) {
    assert.equal(m.covered, m.venues.length);
    assert.ok(m.covered <= m.total);
    assert.equal(m.total, BROKER_VENUE_IDS.length);
  }
});

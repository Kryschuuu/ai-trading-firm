/** End-to-end public Bitunix funding path through client and PerpDataAdapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BitunixFixtureServer } from "./fixtures/bitunixFixtureServer";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import { BitunixPublicClient } from "../src/brokers/bitunix/publicClient";
import { BitunixPerpAdapter } from "../src/perpdata/adapters/bitunix";

const FROM_MS = 1_700_000_000_000;
const TO_MS = FROM_MS + 60_000;

test("Bitunix Funding-Historie + Snapshot laufen über den credential-freien Public-Client", async () => {
  const fixture = new BitunixFixtureServer();
  const base = await fixture.start();
  try {
    const client = new BitunixPublicClient({
      config: loadBitunixConfig({
        BITUNIX_ENABLED: "true",
        BITUNIX_ALLOW_INSECURE_HTTP: "true",
        BITUNIX_BASE_URL: base,
        BITUNIX_RETRY_MAX: "1",
      }),
    });
    const adapter = new BitunixPerpAdapter({
      publicClient: client,
      now: () => new Date("2026-10-05T12:00:00.000Z"),
    });

    const history = await adapter.fetchFunding({
      symbol: "BTCUSDT",
      fromMs: FROM_MS,
      toMs: TO_MS,
      limit: 400,
    });
    assert.equal(history.availability, "AVAILABLE");
    if (history.availability !== "AVAILABLE") throw new Error("expected funding history");
    assert.equal(history.series.rows.length, 1, "the adapter enforces the requested half-open time window");
    assert.equal(history.series.rows[0].fundingRate, "0.0004");
    assert.equal(history.series.truncated, true, "out-of-window rows remain visible as a limited window");

    const intervals = await adapter.readFundingIntervals(["BTCUSDT"]);
    assert.equal(intervals.get("BTCUSDT")?.intervalHours, 8);
    assert.equal(intervals.get("BTCUSDT")?.maxAbsFundingRate, 0.05, "asymmetric venue bounds use the widest absolute limit");

    const historyRequest = fixture.requests.find((request) => request.path.endsWith("get_funding_rate_history"));
    assert.ok(historyRequest);
    assert.deepEqual(historyRequest.query, {
      symbol: "BTCUSDT",
      limit: "200",
      starTime: String(FROM_MS),
      endTime: String(TO_MS),
    });
    const snapshotRequest = fixture.requests.find((request) => request.path.endsWith("/funding_rate"));
    assert.ok(snapshotRequest);
    assert.deepEqual(snapshotRequest.query, {});
    assert.ok(fixture.requests.every((request) => !request.signed && request.credentialHeaders.length === 0));

    const callsBeforeUnsupported = fixture.publicCalls;
    assert.equal((await adapter.fetchOpenInterest()).availability, "UNSUPPORTED");
    assert.equal((await adapter.fetchLiquidations()).availability, "UNSUPPORTED");
    assert.equal(fixture.publicCalls, callsBeforeUnsupported, "unsupported capabilities do not issue requests");
  } finally {
    await fixture.stop();
  }
});

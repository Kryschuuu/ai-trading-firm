import { loadSimulatorConfig } from "../src/lib/marketdata/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaperExecutionRuntime } from "../src/backtest/paperExecution";
import { scopeReplay } from "../src/executionQuality/backtest";
import { newIntent } from "../src/executionQuality/capture";
import { evidenceEvents } from "../src/executionQuality/reconcile";
import { digest, parseBatch, summarize } from "../src/executionQuality/model";

test("backtest capture is deterministic, modeled and uses the completed candle boundary", () => {
  const saved = process.env.EXECUTION_QUALITY_ENABLED;
  process.env.EXECUTION_QUALITY_ENABLED = "true";
  try {
    const run = () => {
      const runtime = createPaperExecutionRuntime(
        { simulator: { ...loadSimulatorConfig({}), seed: 17 } },
        undefined,
        3600000,
      );
      const f = runtime.fillEntry(
        "BITUNIX:BTCUSDT",
        "LONG",
        1000,
        100,
        10000000,
        "trend-v1",
      );
      assert.ok(f);
      runtime.fillExit(
        "BITUNIX:BTCUSDT",
        "SHORT",
        f.filledQty,
        102,
        13600000,
        "trend-v1",
      );
      return runtime.qualityBatches.map((b) =>
        scopeReplay(b, "stable-run-input-hash", 20000000),
      );
    };
    const a = run(),
      b = run();
    assert.deepEqual(a, b);
    assert.equal(
      digest(a),
      "40573013c0c461cdf11f952ff72dad8f3bc73a2646973ab06bbd7d3cec11035c",
      "pinned execution-evidence golden",
    );
    assert.equal(a.length, 2);
    assert.equal(a[0].intent.submitAt, 13600000);
    assert.equal(a[1].intent.side, "sell");
    assert.equal(
      summarize(a[0].intent, a[0].events, 13599999).filledQuantity,
      0,
    );
    for (const batch of a) {
      parseBatch(batch);
      assert.ok(
        batch.events
          .filter((e) => e.kind === "fill")
          .every((e) => e.quality === "modeled"),
      );
      assert.equal(
        summarize(batch.intent, batch.events, 20000000).provenance.arrival,
        "modeled",
      );
    }
  } finally {
    if (saved === undefined) delete process.env.EXECUTION_QUALITY_ENABLED;
    else process.env.EXECUTION_QUALITY_ENABLED = saved;
  }
});
test("missing/stale decision provenance is not a zero-cost signal; stable intent key is required", () => {
  const req = {
    symbol: "AAPL",
    side: "LONG" as const,
    qty: 1,
    riskNotional: 100,
    orderIntentId: "order-1",
  };
  const missing = newIntent(req, "ALPACA", "live", "account-scope", 10000);
  assert.equal(missing.intent.decisionAt, null);
  assert.equal(missing.intent.decisionId, null);
  const stale = newIntent(
    {
      ...req,
      executionQuality: {
        id: "decision",
        at: 10000,
        strategy: "trend",
        quoteCurrency: "USD",
        price: {
          value: 100,
          eventTime: 1,
          availableAt: 1,
          inputHash: "a".repeat(64),
        },
      },
    },
    "ALPACA",
    "live",
    "account-scope",
    11000,
  );
  assert.ok(
    stale.events.some(
      (e) =>
        e.kind === "benchmark" &&
        e.name === "decision" &&
        e.price === null &&
        e.reason === "STALE",
    ),
  );
  assert.throws(
    () =>
      newIntent(
        { ...req, orderIntentId: undefined },
        "ALPACA",
        "live",
        "account-scope",
        11000,
      ),
    /STABLE_INTENT_ID/,
  );
});
test("venue fills deduplicate exact IDs and reject conflicting/truncated evidence", () => {
  const b = newIntent(
    {
      symbol: "BTCUSDT",
      side: "LONG",
      qty: 10,
      riskNotional: 1000,
      orderIntentId: "live-1",
    },
    "BITUNIX",
    "live",
    "test",
    1000,
  );
  const f = { id: "fill-1", quantity: 4, price: 101, feeQuote: null, at: 2000 };
  const e = evidenceEvents(
    b,
    {
      orderId: "order-1",
      filledQuantity: 4,
      feeQuoteTotal: null,
      fills: [f, f],
    },
    3000,
  );
  assert.equal(e.filter((e) => e.kind === "fill").length, 1);
  assert.ok(
    e.some(
      (e) =>
        e.kind === "fill" && e.feeQuote === null && e.feeReason === "MISSING",
    ),
  );
  assert.throws(
    () =>
      evidenceEvents(
        b,
        {
          orderId: "order-1",
          filledQuantity: 1e-12,
          feeQuoteTotal: null,
          fills: [],
        },
        3000,
      ),
    /INCOMPLETE_VENUE_FILLS/,
  );
  assert.throws(
    () =>
      evidenceEvents(
        b,
        {
          orderId: "order-1",
          filledQuantity: 4,
          feeQuoteTotal: null,
          fills: [f, { ...f, price: 102 }],
        },
        3000,
      ),
    /CONFLICT/,
  );
});

test("Alpaca testnet adapter reads real HTTP fill activities and L1 quote, not order averages", async () => {
  const { AlpacaFixtureServer } = await import(
    "./fixtures/alpacaFixtureServer"
  );
  const { AlpacaBrokerAdapter } = await import("../src/brokers/alpaca/adapter");
  const { EnvSecretStore } = await import("../src/brokers/alpaca/secrets");
  const { loadAlpacaPublicConfig, loadAlpacaTradeConfig } = await import(
    "../src/brokers/alpaca/config"
  );
  const fixture = new AlpacaFixtureServer(),
    base = await fixture.start();
  const env = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: base,
    ALPACA_DATA_BASE_URL: base,
    ALPACA_API_KEY: fixture.apiKey,
    ALPACA_API_SECRET: fixture.apiSecret,
    ALPACA_RETRY_MAX: "0",
  };
  try {
    const adapter = new AlpacaBrokerAdapter("testnet", {
      env,
      secretStore: new EnvSecretStore(env),
      publicConfig: loadAlpacaPublicConfig(env),
      tradeConfig: loadAlpacaTradeConfig(env),
    });
    const evidence = await adapter.getExecutionEvidence(
      "client-1",
      "AAPL",
      Date.parse("2024-01-01T00:00:00Z"),
    );
    assert.ok(evidence);
    assert.equal(evidence.fills.length, 2);
    assert.deepEqual(
      evidence.fills.map((f) => f.quantity),
      [0.4, 0.6],
    );
    assert.ok(evidence.fills.every((f) => f.feeQuote === null));
    const quote = await adapter.getExecutionQuote("AAPL");
    assert.equal(quote.bids[0].price, 195.4);
    assert.ok(
      fixture.requests.every((r) => r.method === "GET"),
      "Recovery sends no orders",
    );
  } finally {
    await fixture.stop();
  }
});

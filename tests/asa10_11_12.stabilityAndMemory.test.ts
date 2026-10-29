import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackReason } from "../src/lib/ollama";
import { checkEquityAlerts } from "../src/lib/monitor";
import { issueSession, revokeSession, verifySessionToken } from "../src/lib/authSession";
import { resolveAuth } from "../src/auth/resolve";
import { state } from "../src/lib/stateRegistry";
import { checkRateLimit, resetRateLimiterForTests } from "../src/lib/apiAuth";
import { checkCredentialRateLimit, resetCredentialRateLimiterForTests } from "../src/brokers/control-plane/guard";
import { BrokerExecutionEngine } from "../src/brokers/bitunix/execution";
import type { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";

test("LLM failure holds and rejects, except explicit emergency kill", () => {
  for (const role of ["CEO", "RESEARCH", "RISK_MANAGER", "APPROVER", "EXECUTOR"]) {
    const result = JSON.parse(fallbackReason(role, "SYMBOL=BTC"));
    assert.equal(result.action, "HOLD"); assert.equal(result.verdict, "REJECT");
    assert.equal(result.signal, "NEUTRAL"); assert.notEqual(result.type, "TRADE");
    assert.match(result.reason, /LLM unavailable/);
  }
  assert.equal(JSON.parse(fallbackReason("CEO", "[[REQUEST_KILL]]")).type, "KILL");
});

test("drawdown fractions and high watermark", async () => {
  const sent: string[] = [];
  const emit = (async (alert: { code: string }) => { sent.push(alert.code); }) as unknown as NonNullable<Parameters<typeof checkEquityAlerts>[0]["emit"]>;
  const state = { peak: 100, threshold: 0 };
  for (const dd of [0.06, 0.11, 0.21]) await checkEquityAlerts({ equity: 100 * (1 - dd), drawdownPct: dd, state, emit });
  assert.deepEqual(sent, ["equity:drawdown-5", "equity:drawdown-10", "equity:drawdown-20"]);
  await checkEquityAlerts({ equity: 110, drawdownPct: 0, state, emit });
  await checkEquityAlerts({ equity: 110, drawdownPct: 0, state, emit });
  assert.equal(sent.filter(x => x === "equity:new-high").length, 1);
});

test("revocations survive cache reset and expired records are pruned on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "asa12-"));
  const old = process.env.FIRM_SESSION_REVOCATION_FILE;
  process.env.FIRM_SESSION_REVOCATION_FILE = join(dir, "revocations.json");
  try {
    const env = { AUTH_MODE: "token-required", FIRM_ADMIN_TOKEN: "admin-token-for-testing-long-enough", FIRM_SESSION_SECRET: "session-secret-for-testing-long-enough-123456" };
    const req = new Request("https://localhost/", { headers: { "x-firm-token": env.FIRM_ADMIN_TOKEN } });
    const actor = resolveAuth(req, env); assert.ok(actor.ok);
    const session = issueSession(req, actor.actor, env); assert.ok(session.ok && !session.open);
    const now = Date.now();
    assert.ok(revokeSession(session.sessionToken, now));
    const entries = JSON.parse(readFileSync(process.env.FIRM_SESSION_REVOCATION_FILE!, "utf8"));
    entries.push(["expired", now - 1]);
    writeFileSync(process.env.FIRM_SESSION_REVOCATION_FILE!, JSON.stringify(entries));
    state.revokedSessions.clear();
    assert.equal(verifySessionToken(session.sessionToken, env.FIRM_SESSION_SECRET, now), null);
    assert.equal(state.revokedSessions.get().has("expired"), false);
    assert.equal(state.revokedSessions.get().has(session.csrf), true);
  } finally {
    if (old === undefined) delete process.env.FIRM_SESSION_REVOCATION_FILE; else process.env.FIRM_SESSION_REVOCATION_FILE = old;
    state.revokedSessions.clear(); rmSync(dir, { recursive: true, force: true });
  }
});

test("rate-limit saturation rejects new identities without evicting active buckets", () => {
  resetRateLimiterForTests(); resetCredentialRateLimiterForTests();
  const req = new Request("http://localhost/");
  for (let i = 0; i < 10_002; i++) {
    const peerIp = `10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`;
    const a = checkRateLimit(req, { peerIp, now: 100_000, max: 1 });
    const b = checkCredentialRateLimit(req, { peerIp, now: 100_000, max: 1 });
    if (i < 10_000) { assert.equal(a, null); assert.equal(b, null); }
    else { assert.equal(a?.status, 429); assert.equal(b?.status, 429); }
  }
  assert.equal(state.rateLimiterHits.get().size, 10_000);
  // At window expiry, new clients can enter without discarding live hits.
  assert.equal(checkCredentialRateLimit(req, { peerIp: "11.0.0.1", now: 160_001, max: 1 }), null);
  assert.equal(checkRateLimit(req, { peerIp: "11.0.0.1", now: 160_001, max: 1 }), null);
  resetRateLimiterForTests(); resetCredentialRateLimiterForTests();
});

test("Bitunix reconciles terminal orders and retains failures on partial cancel-all", async () => {
  let status = "FILLED";
  let failures: string[] = ["b"];
  const client = {
    getOrder: async () => ({ symbol: "BTCUSDT", side: "LONG", qty: 1, filledQty: 1, avgPrice: 100, status }),
    getExecutions: async (_symbol: string, id: string) => [{ orderId: id, qty: 1, price: 100 }],
    cancelAllOrders: async () => ({ successList: ["a"], failureList: failures }),
  } as unknown as BitunixPrivateClient;
  const engine = new BrokerExecutionEngine(client);
  const orders = (engine as unknown as { openOrders: Map<string, unknown> }).openOrders;
  for (const id of ["filled", "canceled", "rejected", "a", "b"]) orders.set(id, { symbol: "BTCUSDT", side: "LONG", qty: 1, stopLoss: null, takeProfit: null });
  await engine.reconcile("filled"); status = "CANCELED"; await engine.reconcile("canceled"); status = "REJECTED"; await engine.reconcile("rejected");
  assert.deepEqual([...orders.keys()], ["a", "b"]);
  await engine.cancelAllOpenOrders(); assert.deepEqual([...orders.keys()], ["b"]);
  failures = []; await engine.cancelAllOpenOrders(); assert.equal(orders.size, 0);
});

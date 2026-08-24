import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRuntimeLimits,
  getLimits,
  resetRuntimeLimits,
  RISK_LIMITS,
  validateOrder,
} from "../src/lib/riskGuard";

test("Ceilings: über dem Code-Maximum wird geklemmt", () => {
  const before = getLimits().maxPositionPct;
  applyRuntimeLimits({ maxPositionPct: 0.9 });
  assert.equal(getLimits().maxPositionPct, 0.5, "0.9 muss auf 0.5 geklemmt werden");
  applyRuntimeLimits({ maxPositionPct: before });
});

test("Ceilings: unter dem Code-Minimum wird angehoben", () => {
  applyRuntimeLimits({ maxRiskPerTrade: 0.0001 });
  assert.equal(getLimits().maxRiskPerTrade, 0.002);
  applyRuntimeLimits({ maxRiskPerTrade: 0.02 });
});

test("requireStopLoss ist nicht abschaltbar", () => {
  applyRuntimeLimits({ requireStopLoss: false } as any);
  assert.equal(getLimits().requireStopLoss, true);
});

test("RISK_LIMITS-Proxy liest die aktuellen Laufzeitwerte", () => {
  const before = getLimits().maxConcurrentPositions;
  applyRuntimeLimits({ maxConcurrentPositions: 2 });
  assert.equal(RISK_LIMITS.maxConcurrentPositions, 2);
  applyRuntimeLimits({ maxConcurrentPositions: before });
});

test("validateOrder blockt Positionsgröße über Limit", () => {
  resetRuntimeLimits();
  const r = validateOrder({
    notional: 5000, equity: 10000, openPositions: 0,
    side: "LONG", leverage: 1, hasStopLoss: true, symbol: "BTC",
  });
  assert.equal(r.allowed, false);
  assert.ok(r.blockedBy.some((b) => b.startsWith("position-size")));
});

test("validateOrder lässt saubere Order durch und blockt fehlenden Stop", () => {
  resetRuntimeLimits();
  const ok = validateOrder({
    notional: 2000, equity: 10000, openPositions: 0,
    side: "LONG", leverage: 1, hasStopLoss: true, symbol: "BTC",
  });
  assert.equal(ok.allowed, true);

  const noStop = validateOrder({
    notional: 2000, equity: 10000, openPositions: 0,
    side: "LONG", leverage: 1, hasStopLoss: false, symbol: "BTC",
  });
  assert.equal(noStop.allowed, false);
  assert.ok(noStop.blockedBy.includes("stop-loss:mandatory"));
});

test("allowShort=false blockt Shorts; freigeschaltet laufen sie durch", () => {
  resetRuntimeLimits();
  const short = validateOrder({
    notional: 1000, equity: 10000, openPositions: 0,
    side: "SHORT", leverage: 1, hasStopLoss: true, symbol: "ETH",
  });
  assert.equal(short.allowed, false);

  applyRuntimeLimits({ allowShort: true });
  const shortOk = validateOrder({
    notional: 1000, equity: 10000, openPositions: 0,
    side: "SHORT", leverage: 1, hasStopLoss: true, symbol: "ETH",
  });
  assert.equal(shortOk.allowed, true);
  applyRuntimeLimits({ allowShort: false });
});

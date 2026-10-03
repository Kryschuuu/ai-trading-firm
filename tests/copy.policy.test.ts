/** Copy policy engine: pure fail-closed gates and versioned risk ceilings. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LIMIT_CEILINGS } from "../src/lib/riskGuard";
import {
  COPY_POLICY_BOUNDS,
  DEFAULT_COPY_POLICY_CONFIG,
  DEFAULT_COPY_POLICY_VERSION,
  CopyPolicyConfigError,
  loadCopyPolicyConfig,
  resolveCopyPolicy,
} from "../src/copy/config";
import {
  evaluatePolicy,
  type CopyPolicy,
  type CopyPolicyContext,
} from "../src/copy/policy";
import type { FollowerOrderIntent } from "../src/copy/types";

const INTENT: FollowerOrderIntent = {
  sourceEventId: "leader-event-1",
  symbol: "BTC/USD",
  side: "LONG",
  action: "OPEN",
  quantity: 0.01,
  notional: 100,
  sizing: {
    mode: "FIXED_AMOUNT",
    leaderNotional: null,
    leaderEquity: null,
    followerEquity: null,
    multiplier: 1,
    leverageApplied: 1,
  },
  createdAt: 1_790_000_000_000,
};

function context(overrides: Partial<CopyPolicyContext> = {}): CopyPolicyContext {
  return {
    followerInstrumentId: "BTC/USD",
    dayNotional: 500,
    openPositions: 1,
    equityAtDayStart: 10_000,
    currentEquity: 9_900,
    effectiveLeverage: 1,
    ruleSnapshot: { spreadPct: 0.05 }, // 5 bp
    ...overrides,
  };
}

test("copy policy config is content-versioned and rejects stale or malformed versions", () => {
  assert.match(DEFAULT_COPY_POLICY_VERSION, /^cpl1:[0-9a-f]{64}$/);
  assert.equal(DEFAULT_COPY_POLICY_CONFIG.policyVersion, DEFAULT_COPY_POLICY_VERSION);
  assert.equal(
    loadCopyPolicyConfig({ ...DEFAULT_COPY_POLICY_CONFIG.policy }, DEFAULT_COPY_POLICY_VERSION)
      .policyVersion,
    DEFAULT_COPY_POLICY_VERSION,
  );
  assert.throws(
    () => loadCopyPolicyConfig({ ...DEFAULT_COPY_POLICY_CONFIG.policy }, "cpl1:" + "0".repeat(64)),
    CopyPolicyConfigError,
  );
  assert.throws(
    () => loadCopyPolicyConfig({ ...DEFAULT_COPY_POLICY_CONFIG.policy, futureLimit: 1 }),
    CopyPolicyConfigError,
  );
  assert.notEqual(
    resolveCopyPolicy({ maxNotionalPerEvent: 900 }).policyVersion,
    DEFAULT_COPY_POLICY_VERSION,
  );
});

test("copy policy caps never exceed LIMIT_CEILINGS and tighter values are accepted", () => {
  assert.ok(COPY_POLICY_BOUNDS.maxNotionalPerEvent[1] <= LIMIT_CEILINGS.maxNotionalPerOrder[1]);
  assert.ok(COPY_POLICY_BOUNDS.maxNotionalPerDay[1] <= LIMIT_CEILINGS.maxNotionalPerOrder[1]);
  assert.ok(COPY_POLICY_BOUNDS.maxOpenPositions[1] <= LIMIT_CEILINGS.maxConcurrentPositions[1]);
  assert.ok(COPY_POLICY_BOUNDS.maxLossPerDayPct[1] <= LIMIT_CEILINGS.dailyLossLimitPct[1]);
  assert.ok(COPY_POLICY_BOUNDS.maxLeverage[1] <= LIMIT_CEILINGS.maxLeverage[1]);
  assert.equal(resolveCopyPolicy({ maxNotionalPerEvent: 250 }).policy.maxNotionalPerEvent, 250);

  for (const invalid of [
    { maxNotionalPerEvent: LIMIT_CEILINGS.maxNotionalPerOrder[1] + 1 },
    { maxOpenPositions: LIMIT_CEILINGS.maxConcurrentPositions[1] + 1 },
    { maxLossPerDayPct: LIMIT_CEILINGS.dailyLossLimitPct[1] + 0.01 },
    { maxLeverage: LIMIT_CEILINGS.maxLeverage[1] + 1 },
    { maxSlippageBps: COPY_POLICY_BOUNDS.maxSlippageBps[1] + 1 },
    { maxNotionalPerDay: 50, maxNotionalPerEvent: 51 },
  ]) {
    assert.throws(() => resolveCopyPolicy(invalid), CopyPolicyConfigError);
  }
});

test("valid intent is allowed and expected spreadPct/scanner spread use their source units", () => {
  assert.deepEqual(evaluatePolicy(INTENT, DEFAULT_COPY_POLICY_CONFIG.policy, context()), { allowed: true });
  // RuleSnapshot: 0.1 percent = 10 bp, exactly the default threshold.
  assert.deepEqual(
    evaluatePolicy(INTENT, DEFAULT_COPY_POLICY_CONFIG.policy, context({ ruleSnapshot: { spreadPct: 0.1 } })),
    { allowed: true },
  );
  // Scanner raw relative spread: 0.001 = 10 bp.
  assert.deepEqual(
    evaluatePolicy(
      INTENT,
      DEFAULT_COPY_POLICY_CONFIG.policy,
      context({ ruleSnapshot: null, scannerSpread: 0.001 }),
    ),
    { allowed: true },
  );
  // If both are present, the higher expected spread is used.
  assert.equal(
    evaluatePolicy(
      INTENT,
      DEFAULT_COPY_POLICY_CONFIG.policy,
      context({ ruleSnapshot: { spreadPct: 0.01 }, scannerSpread: 0.002 }),
    ).allowed,
    false,
  );
});

test("all declared policy decisions block the right condition", () => {
  const policy = DEFAULT_COPY_POLICY_CONFIG.policy;
  const cases: Array<[string, ReturnType<typeof evaluatePolicy>, string]> = [
    [
      "event notional",
      evaluatePolicy({ ...INTENT, notional: policy.maxNotionalPerEvent + 1 }, policy, context()),
      "MAX_EVENT_NOTIONAL",
    ],
    [
      "cumulative day notional",
      evaluatePolicy(INTENT, policy, context({ dayNotional: policy.maxNotionalPerDay - 50 })),
      "MAX_DAY_NOTIONAL",
    ],
    [
      "expected spread above threshold",
      evaluatePolicy(INTENT, policy, context({ ruleSnapshot: { spreadPct: 0.11 } })),
      "MAX_SLIPPAGE",
    ],
    [
      "missing expected spread",
      evaluatePolicy(INTENT, policy, context({ ruleSnapshot: { spreadPct: null } })),
      "MAX_SLIPPAGE",
    ],
    [
      "open-position cap",
      evaluatePolicy(INTENT, policy, context({ openPositions: policy.maxOpenPositions })),
      "MAX_POSITIONS",
    ],
    [
      "loss relative to start-of-day equity",
      evaluatePolicy(INTENT, policy, context({ currentEquity: 9_799 })),
      "MAX_DAILY_LOSS",
    ],
    [
      "leverage cap",
      evaluatePolicy(INTENT, policy, context({ effectiveLeverage: policy.maxLeverage + 0.1 })),
      "MAX_LEVERAGE",
    ],
    [
      "unmapped follower instrument",
      evaluatePolicy(INTENT, policy, context({ followerInstrumentId: null })),
      "NO_MAPPING",
    ],
  ];

  for (const [name, decision, code] of cases) {
    assert.equal(decision.allowed, false, name);
    if (!decision.allowed) assert.equal(decision.code, code, name);
  }
});

test("kill switch is independent; malformed policy and evaluator exceptions fail closed", () => {
  const halted = { ...DEFAULT_COPY_POLICY_CONFIG.policy, halted: true };
  const d = evaluatePolicy(INTENT, halted, context({ followerInstrumentId: null }));
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.code, "HALTED");

  const invalidPolicy = { ...DEFAULT_COPY_POLICY_CONFIG.policy, maxLeverage: 99 } as CopyPolicy;
  const invalid = evaluatePolicy(INTENT, invalidPolicy, context());
  assert.equal(invalid.allowed, false);
  if (!invalid.allowed) assert.equal(invalid.code, "HALTED");

  const throwingPolicy = new Proxy(DEFAULT_COPY_POLICY_CONFIG.policy, {
    get(target, property, receiver) {
      if (property === "maxLeverage") throw new Error("injected policy failure");
      return Reflect.get(target, property, receiver);
    },
  });
  const thrown = evaluatePolicy(INTENT, throwingPolicy, context());
  assert.equal(thrown.allowed, false);
  if (!thrown.allowed) assert.equal(thrown.code, "HALTED");
});

test("malformed runtime context is rejected instead of treated as zero", () => {
  for (const bad of [
    context({ dayNotional: Number.NaN }),
    context({ openPositions: 0.5 }),
    context({ equityAtDayStart: 0 }),
    context({ effectiveLeverage: null }),
    context({ ruleSnapshot: { spreadPct: Number.NaN } }),
  ]) {
    const decision = evaluatePolicy(INTENT, DEFAULT_COPY_POLICY_CONFIG.policy, bad);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.ok(["HALTED", "MAX_SLIPPAGE"].includes(decision.code));
  }
});

/**
 * Versioned Copy-Policy configuration (STX-07-02).
 *
 * The persisted `policy_json` and `policy_version` pair must be loaded through
 * `loadCopyPolicyConfig()`: the version is derived from the validated policy
 * body, and a mismatch fails closed. Bounds are tied to `LIMIT_CEILINGS`; the
 * copy layer may only impose equal or tighter limits than the broker guard.
 */
import { createHash } from "node:crypto";

import { LIMIT_CEILINGS } from "@/lib/riskGuard";
import type { CopyPolicy } from "./policy";

export const COPY_POLICY_VERSION_TAG = "cpl1" as const;

const MAX_NOTIONAL_PER_ORDER = LIMIT_CEILINGS.maxNotionalPerOrder[1];

/**
 * Copy-only bounds. Daily notional is capped at the maximum single-order
 * ceiling (stricter than allowing that ceiling repeatedly); positions, daily
 * loss and leverage directly inherit the corresponding hard ceilings.
 *
 * `riskGuard` has no slippage-bps ceiling. Copy therefore uses an explicit,
 * conservative 20 bp upper bound; it is an additional pre-submit restriction,
 * never a replacement for broker execution gates.
 */
export const COPY_POLICY_BOUNDS = Object.freeze({
  maxNotionalPerEvent: [0, MAX_NOTIONAL_PER_ORDER] as const,
  maxNotionalPerDay: [
    0,
    Math.min(
      MAX_NOTIONAL_PER_ORDER,
      MAX_NOTIONAL_PER_ORDER * LIMIT_CEILINGS.maxConcurrentPositions[1],
    ),
  ] as const,
  maxSlippageBps: [0, 20] as const,
  maxOpenPositions: [0, LIMIT_CEILINGS.maxConcurrentPositions[1]] as const,
  maxLossPerDayPct: [0, LIMIT_CEILINGS.dailyLossLimitPct[1]] as const,
  maxLeverage: [LIMIT_CEILINGS.maxLeverage[0], LIMIT_CEILINGS.maxLeverage[1]] as const,
});

/** A policy body plus its reproducible content version. */
export interface CopyPolicyConfig {
  readonly policy: Readonly<CopyPolicy>;
  readonly policyVersion: string;
}

export class CopyPolicyConfigError extends Error {
  readonly code = "COPY_POLICY_INVALID" as const;

  constructor(readonly field: string, reason: string) {
    super(`COPY_POLICY_INVALID: ${field}: ${reason}`);
    this.name = "CopyPolicyConfigError";
  }
}

const POLICY_FIELDS = [
  "maxNotionalPerEvent",
  "maxNotionalPerDay",
  "maxSlippageBps",
  "maxOpenPositions",
  "maxLossPerDayPct",
  "maxLeverage",
  "halted",
] as const satisfies readonly (keyof CopyPolicy)[];

/** Versioned source configuration. Changes to a field change `policyVersion`. */
const DEFAULT_POLICY_BODY: CopyPolicy = Object.freeze({
  maxNotionalPerEvent: 1_000,
  maxNotionalPerDay: 5_000,
  maxSlippageBps: 10,
  maxOpenPositions: 3,
  maxLossPerDayPct: 0.02,
  maxLeverage: 1,
  halted: false,
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalPolicy(policy: CopyPolicy): string {
  return JSON.stringify(POLICY_FIELDS.map((field) => [field, policy[field]]));
}

function versionFor(policy: CopyPolicy): string {
  const digest = createHash("sha256").update(canonicalPolicy(policy), "utf8").digest("hex");
  return `${COPY_POLICY_VERSION_TAG}:${digest}`;
}

function boundedNumber(value: unknown, field: keyof typeof COPY_POLICY_BOUNDS): number {
  const bounds = COPY_POLICY_BOUNDS[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CopyPolicyConfigError(field, "muss eine endliche Zahl sein");
  }
  if (value < bounds[0] || value > bounds[1]) {
    throw new CopyPolicyConfigError(
      field,
      `muss innerhalb des Copy-/Risk-Guard-Rahmens [${bounds[0]}, ${bounds[1]}] liegen`,
    );
  }
  if (field === "maxOpenPositions" && !Number.isInteger(value)) {
    throw new CopyPolicyConfigError(field, "muss eine ganze Zahl sein");
  }
  return value;
}

/**
 * Validate and load a stored policy body. If `expectedVersion` is supplied,
 * it must match the content-derived version stored beside `policy_json`.
 */
export function loadCopyPolicyConfig(
  raw: unknown = DEFAULT_POLICY_BODY,
  expectedVersion?: string,
): CopyPolicyConfig {
  if (!isPlainRecord(raw)) {
    throw new CopyPolicyConfigError("policy", "muss ein JSON-Objekt sein");
  }
  const provided = Object.keys(raw).sort();
  const expected = [...POLICY_FIELDS].sort();
  if (provided.length !== expected.length || provided.some((key, index) => key !== expected[index])) {
    throw new CopyPolicyConfigError("policy", "Felder fehlen oder sind unbekannt");
  }
  if (typeof raw.halted !== "boolean") {
    throw new CopyPolicyConfigError("halted", "muss ein Boolean sein");
  }

  const policy: CopyPolicy = {
    maxNotionalPerEvent: boundedNumber(raw.maxNotionalPerEvent, "maxNotionalPerEvent"),
    maxNotionalPerDay: boundedNumber(raw.maxNotionalPerDay, "maxNotionalPerDay"),
    maxSlippageBps: boundedNumber(raw.maxSlippageBps, "maxSlippageBps"),
    maxOpenPositions: boundedNumber(raw.maxOpenPositions, "maxOpenPositions"),
    maxLossPerDayPct: boundedNumber(raw.maxLossPerDayPct, "maxLossPerDayPct"),
    maxLeverage: boundedNumber(raw.maxLeverage, "maxLeverage"),
    halted: raw.halted,
  };
  if (policy.maxNotionalPerEvent > policy.maxNotionalPerDay) {
    throw new CopyPolicyConfigError(
      "maxNotionalPerDay",
      "darf nicht kleiner als maxNotionalPerEvent sein",
    );
  }

  const policyVersion = versionFor(policy);
  if (expectedVersion !== undefined && expectedVersion !== policyVersion) {
    throw new CopyPolicyConfigError("policyVersion", "passt nicht zum versionierten policy_json");
  }

  return Object.freeze({
    policy: Object.freeze(policy),
    policyVersion,
  });
}

/** Resolve an optional strict override against the versioned source defaults. */
export function resolveCopyPolicy(
  overrides: Partial<CopyPolicy> = {},
): CopyPolicyConfig {
  return loadCopyPolicyConfig({ ...DEFAULT_POLICY_BODY, ...overrides });
}

export const DEFAULT_COPY_POLICY_CONFIG = loadCopyPolicyConfig(DEFAULT_POLICY_BODY);
export const DEFAULT_COPY_POLICY = DEFAULT_COPY_POLICY_CONFIG.policy;
export const DEFAULT_COPY_POLICY_VERSION = DEFAULT_COPY_POLICY_CONFIG.policyVersion;

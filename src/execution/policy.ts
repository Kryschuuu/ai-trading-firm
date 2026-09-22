/**
 * Versionierte Execution-Policy für Post-Only-/Limit-/Market-Fallback (RMA-P4-02).
 *
 * Ein `ExecutionPolicy`-Objekt ist die VOLLSTÄNDIGE, validierte Beschreibung eines
 * Maker-Versuchs: Post-Only-Anforderung, TTL, Repricing-Budget, Preis-Offset,
 * Market-Fallback-Opt-in und die harten Schranken (Spread, Slippage, Notional,
 * Quote-Alter, Cancel-Bestätigung). Jede Workflow-Zeile speichert Policy UND
 * `policyVersion`; jeder Audit-/Event-Eintrag nennt die Version — ein Replay mit
 * anderer Policy ist damit strukturell erkennbar.
 *
 * Versionierung: `eop1:<sha256>` über die kanonischen Policy-Felder (stabile
 * Key-Reihenfolge, Zahlen in kanonischer Form). Eine Feldänderung ergibt eine
 * NEUE Version; es gibt kein stilles Nachjustieren.
 *
 * Einheiten:
 *   - ttlMs / maxQuoteAgeMs / cancelConfirmTimeoutMs: Millisekunden
 *   - priceOffsetBps / maxSpreadBps / maxSlippageBps: Basispunkte (1 bp = 0,01 %)
 *   - maxNotional: Kontowährung (0 = keine zusätzliche Policy-Schranke; die
 *     Risk-Guard-Ceilings gelten IMMER zusätzlich)
 *   - maxReprices / maxCancelAttempts: Zähler (ganzzahlig, ≥ 0 bzw. ≥ 1)
 *
 * Fail-closed: ungültige, fehlende oder außerhalb der Bounds liegende Werte
 * werfen `ExecutionPolicyError`. Es wird NIE still geklemmt — ein falsch
 * konfigurierter Maker-Versuch darf nicht als „etwas anderer“ Versuch laufen.
 */
import { createHash } from "node:crypto";

export const EXECUTION_POLICY_TAG = "eop1" as const;

export const EXECUTION_POLICY_BOUNDS = {
  /** Maker-Versuchsdauer je Limit-Attempt (1 s … 1 h). */
  ttlMs: { min: 1_000, max: 3_600_000 },
  /** Repricing-Versuche nach Maker-Reject/Timeout (0 … 10). */
  maxReprices: { min: 0, max: 10 },
  /** Limit-Offset vom Mid Richtung Maker-Seite (0 … 500 bp). */
  priceOffsetBps: { min: 0, max: 500 },
  /** Maximaler relativer Spread für Submit/Reprice/Fallback (1 … 5000 bp). */
  maxSpreadBps: { min: 1, max: 5000 },
  /** Maximale Fallback-Slippage-Schätzung (1 … 5000 bp). */
  maxSlippageBps: { min: 1, max: 5000 },
  /** Zusätzliche Policy-Notional-Schranke (0 = nur Risk-Guard). */
  maxNotional: { min: 0, max: 1_000_000 },
  /** Maximales Quote-Alter (100 ms … 60 s). */
  maxQuoteAgeMs: { min: 100, max: 60_000 },
  /** Maximale Wartezeit auf eine Cancel-Bestätigung (1 s … 120 s). */
  cancelConfirmTimeoutMs: { min: 1_000, max: 120_000 },
  /** Cancel-/Verify-Wiederholungen (1 … 5). */
  maxCancelAttempts: { min: 1, max: 5 },
} as const;

/** Art der sicheren Alternative, wenn das Venue kein Post-Only kann. */
export type PostOnlyFallback = "fail" | "limit";

export const POST_ONLY_FALLBACKS: readonly PostOnlyFallback[] = ["fail", "limit"];

export interface ExecutionPolicyInput {
  postOnly: boolean;
  postOnlyFallback: PostOnlyFallback;
  ttlMs: number;
  maxReprices: number;
  priceOffsetBps: number;
  fallbackAllowed: boolean;
  maxSpreadBps: number;
  maxSlippageBps: number;
  maxNotional: number;
  maxQuoteAgeMs: number;
  cancelConfirmTimeoutMs: number;
  maxCancelAttempts: number;
}

/** Validierte, eingefrorene Policy inkl. Version. */
export interface ExecutionPolicy extends ExecutionPolicyInput {
  readonly policyVersion: string;
}

export class ExecutionPolicyError extends Error {
  readonly code = "EXECUTION_POLICY_INVALID";
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`EXECUTION_POLICY_INVALID: ${field}: ${detail}`);
    this.name = "ExecutionPolicyError";
    this.field = field;
  }
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ExecutionPolicyError(field, "muss ein Boolean sein");
  }
  return value;
}

function requireBoundedInt(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ExecutionPolicyError(field, "muss eine endliche ganze Zahl sein");
  }
  if (value < min || value > max) {
    throw new ExecutionPolicyError(field, `muss in [${min}, ${max}] liegen (got ${value})`);
  }
  return value;
}

function requireBoundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ExecutionPolicyError(field, "muss eine endliche Zahl sein");
  }
  if (value < min || value > max) {
    throw new ExecutionPolicyError(field, `muss in [${min}, ${max}] liegen (got ${value})`);
  }
  return value;
}

function canonicalPolicyJson(p: ExecutionPolicyInput): string {
  // Stabile Key-Reihenfolge — die Version ist über Prozesse/Plattformen stabil.
  return JSON.stringify({
    tag: EXECUTION_POLICY_TAG,
    postOnly: p.postOnly,
    postOnlyFallback: p.postOnlyFallback,
    ttlMs: p.ttlMs,
    maxReprices: p.maxReprices,
    priceOffsetBps: p.priceOffsetBps,
    fallbackAllowed: p.fallbackAllowed,
    maxSpreadBps: p.maxSpreadBps,
    maxSlippageBps: p.maxSlippageBps,
    maxNotional: p.maxNotional,
    maxQuoteAgeMs: p.maxQuoteAgeMs,
    cancelConfirmTimeoutMs: p.cancelConfirmTimeoutMs,
    maxCancelAttempts: p.maxCancelAttempts,
  });
}

export function executionPolicyVersion(p: ExecutionPolicyInput): string {
  const digest = createHash("sha256").update(canonicalPolicyJson(p), "utf8").digest("hex");
  return `${EXECUTION_POLICY_TAG}:${digest}`;
}

/**
 * Validiert eine Roh-Policy fail-closed und versieht sie mit ihrer Version.
 * Unbekannte Zusatzfelder werden IGNORIERT (additive Robustheit), fehlende oder
 * invalide Pflichtfelder werfen.
 */
export function parseExecutionPolicy(raw: unknown): ExecutionPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ExecutionPolicyError("policy", "muss ein Objekt sein");
  }
  const r = raw as Record<string, unknown>;
  const postOnly = requireBoolean(r.postOnly, "postOnly");
  const fallbackRaw = r.postOnlyFallback;
  if (fallbackRaw !== "fail" && fallbackRaw !== "limit") {
    throw new ExecutionPolicyError("postOnlyFallback", 'muss "fail" oder "limit" sein');
  }
  const input: ExecutionPolicyInput = {
    postOnly,
    postOnlyFallback: fallbackRaw,
    ttlMs: requireBoundedInt(r.ttlMs, "ttlMs", EXECUTION_POLICY_BOUNDS.ttlMs.min, EXECUTION_POLICY_BOUNDS.ttlMs.max),
    maxReprices: requireBoundedInt(
      r.maxReprices,
      "maxReprices",
      EXECUTION_POLICY_BOUNDS.maxReprices.min,
      EXECUTION_POLICY_BOUNDS.maxReprices.max
    ),
    priceOffsetBps: requireBoundedNumber(
      r.priceOffsetBps,
      "priceOffsetBps",
      EXECUTION_POLICY_BOUNDS.priceOffsetBps.min,
      EXECUTION_POLICY_BOUNDS.priceOffsetBps.max
    ),
    fallbackAllowed: requireBoolean(r.fallbackAllowed, "fallbackAllowed"),
    maxSpreadBps: requireBoundedNumber(
      r.maxSpreadBps,
      "maxSpreadBps",
      EXECUTION_POLICY_BOUNDS.maxSpreadBps.min,
      EXECUTION_POLICY_BOUNDS.maxSpreadBps.max
    ),
    maxSlippageBps: requireBoundedNumber(
      r.maxSlippageBps,
      "maxSlippageBps",
      EXECUTION_POLICY_BOUNDS.maxSlippageBps.min,
      EXECUTION_POLICY_BOUNDS.maxSlippageBps.max
    ),
    maxNotional: requireBoundedNumber(
      r.maxNotional,
      "maxNotional",
      EXECUTION_POLICY_BOUNDS.maxNotional.min,
      EXECUTION_POLICY_BOUNDS.maxNotional.max
    ),
    maxQuoteAgeMs: requireBoundedInt(
      r.maxQuoteAgeMs,
      "maxQuoteAgeMs",
      EXECUTION_POLICY_BOUNDS.maxQuoteAgeMs.min,
      EXECUTION_POLICY_BOUNDS.maxQuoteAgeMs.max
    ),
    cancelConfirmTimeoutMs: requireBoundedInt(
      r.cancelConfirmTimeoutMs,
      "cancelConfirmTimeoutMs",
      EXECUTION_POLICY_BOUNDS.cancelConfirmTimeoutMs.min,
      EXECUTION_POLICY_BOUNDS.cancelConfirmTimeoutMs.max
    ),
    maxCancelAttempts: requireBoundedInt(
      r.maxCancelAttempts,
      "maxCancelAttempts",
      EXECUTION_POLICY_BOUNDS.maxCancelAttempts.min,
      EXECUTION_POLICY_BOUNDS.maxCancelAttempts.max
    ),
  };
  return Object.freeze({ ...input, policyVersion: executionPolicyVersion(input) });
}

/**
 * Konservativer Default: Post-Only AN (mit hartem Fail bei fehlender Venue-
 * Fähigkeit), KEIN Market-Fallback (opt-in), 30 s TTL, 2 Reprices, enge
 * Spread-/Slippage-Schranken. Paper-/Backtest-Defaults bleiben unverändert,
 * weil der Controller nur läuft, wenn er explizit aufgerufen wird.
 */
export const DEFAULT_EXECUTION_POLICY_INPUT: ExecutionPolicyInput = {
  postOnly: true,
  postOnlyFallback: "fail",
  ttlMs: 30_000,
  maxReprices: 2,
  priceOffsetBps: 5,
  fallbackAllowed: false,
  maxSpreadBps: 50,
  maxSlippageBps: 30,
  maxNotional: 0,
  maxQuoteAgeMs: 5_000,
  cancelConfirmTimeoutMs: 10_000,
  maxCancelAttempts: 3,
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = parseExecutionPolicy(
  DEFAULT_EXECUTION_POLICY_INPUT
);

/** True, wenn zwei Policies dieselbe Version tragen (feldweise Gleichheit). */
export function samePolicyVersion(a: ExecutionPolicy, b: ExecutionPolicy): boolean {
  return a.policyVersion === b.policyVersion;
}

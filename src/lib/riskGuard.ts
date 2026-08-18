/**
 * HARD-CODED RISK GUARDRAILS.
 *
 * These limits live in code and are the FINAL line of defense. They can never be
 * overridden by an agent's instructions, a prompt injection, or a hallucinating
 * model. Agents operate inside this sandbox; the guardrail refuses anything outside it.
 *
 * Think of this file as the physical firewall between the AI and the broker.
 */

export const RISK_LIMITS = {
  /** Max fraction of total account equity a single position may consume. */
  maxPositionPct: 0.25,
  /** Max fraction of total account equity at risk on a single trade. */
  maxRiskPerTrade: 0.02,
  /** Absolute notional cap (in quote currency) per order. 0 = disabled, use % only. */
  maxNotionalPerOrder: 0,
  /** Maximum number of concurrent open positions. */
  maxConcurrentPositions: 5,
  /** Short positions forbidden unless explicit flag. */
  allowShort: false,
  /** Leverage cap. 1 = no leverage. */
  maxLeverage: 1,
  /** Stop-loss requirement: an order is refused if no stop-loss is attached. */
  requireStopLoss: true,
  /** Default stop-loss distance in %, enforced if proposal omits one. */
  defaultStopLossPct: 0.05,
  /** Kill-switch hysteresis: panics if equity drawdown exceeds this %. */
  maxEquityDrawdownPct: 0.15,
} as const;

export type ValidateContext = {
  notional: number;
  equity: number;
  openPositions: number;
  side: "LONG" | "SHORT";
  leverage: number;
  hasStopLoss: boolean;
  symbol: string;
};

export type GuardrailResult = {
  allowed: boolean;
  reason: string;
  blockedBy: string[]; // which guardrail(s) fired
};

export function validateOrder(ctx: ValidateContext): GuardrailResult {
  const blockedBy: string[] = [];

  if (!Number.isFinite(ctx.notional) || ctx.notional <= 0) {
    blockedBy.push("notional:order-not-valid");
  }

  const equity = Math.max(ctx.equity, 1);
  const positionPct = ctx.notional / equity;

  if (positionPct > RISK_LIMITS.maxPositionPct) {
    blockedBy.push(
      `position-size:max-${(RISK_LIMITS.maxPositionPct * 100).toFixed(0)}%-of-equity`
    );
  }

  if (
    RISK_LIMITS.maxNotionalPerOrder > 0 &&
    ctx.notional > RISK_LIMITS.maxNotionalPerOrder
  ) {
    blockedBy.push(`notional:hard-cap-${RISK_LIMITS.maxNotionalPerOrder}`);
  }

  if (ctx.side === "SHORT" && !RISK_LIMITS.allowShort) {
    blockedBy.push("side:short-trading-disabled");
  }

  if (ctx.leverage > RISK_LIMITS.maxLeverage) {
    blockedBy.push(`leverage:max-${RISK_LIMITS.maxLeverage}x`);
  }

  if (RISK_LIMITS.requireStopLoss && !ctx.hasStopLoss) {
    blockedBy.push("stop-loss:mandatory");
  }

  if (ctx.openPositions >= RISK_LIMITS.maxConcurrentPositions) {
    blockedBy.push(
      `concurrency:max-${RISK_LIMITS.maxConcurrentPositions}-positions`
    );
  }

  const allowed = blockedBy.length === 0;
  return {
    allowed,
    reason: allowed
      ? `Order passed all guardrails. Position ${(positionPct * 100).toFixed(2)}% of equity.`
      : `BLOCKED by guardrail(s): ${blockedBy.join(" | ")}`,
    blockedBy,
  };
}

/** Position sizing calculator used BEFORE any order hits the broker. */
export function riskAdjustedSize(
  equity: number,
  stopDistPct: number,
  riskBudgetPct: number = RISK_LIMITS.maxRiskPerTrade
): number {
  // Standard "1% rule": risk fraction / distance-to-stop.
  const riskPerUnit = Math.max(stopDistPct, 0.001); // avoid div-by-zero
  const size = (equity * riskBudgetPct) / riskPerUnit;
  const sizeCap = equity * RISK_LIMITS.maxPositionPct;
  return Math.min(size, sizeCap);
}

/** True if the global kill switch is armed (in-memory circuit breaker). */
let killSwitchArmed = false;
export const killSwitch = {
  isArmed: () => killSwitchArmed,
  pull: (reason: string) => {
    killSwitchArmed = true;
    console.error(`[KILL-SWITCH] PULLED: ${reason}`);
    return killSwitchArmed;
  },
  disarm: () => {
    killSwitchArmed = false;
    return killSwitchArmed;
  },
};

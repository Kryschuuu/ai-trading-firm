/**
 * HARD-CODED RISK GUARDRAILS.
 *
 * These limits live in code and are the FINAL line of defense. They can never be
 * overridden by an agent's instructions, a prompt injection, or a hallucinating
 * model. Agents operate inside this sandbox; the guardrail refuses anything outside it.
 *
 * RUNTIME-TUNING MIT DECKELN: Werte dürfen zur Laufzeit aus der DB (risk_config,
 * änderbar übers Dashboard) geladen werden — ABER nur innerhalb der absoluten
 * Code-Grenzen (LIMIT_CEILINGS). Selbst eine kompromittierte Datenbank kann die
 * Grenzen nicht über das Code-Maximum hinaus aufweichen.
 */

export type RiskLimits = {
  maxPositionPct: number;
  maxRiskPerTrade: number;
  maxNotionalPerOrder: number;
  maxConcurrentPositions: number;
  allowShort: boolean;
  maxLeverage: number;
  requireStopLoss: boolean;
  defaultStopLossPct: number;
  maxEquityDrawdownPct: number;
  /** Neu: max. Tagesverlust in % des Startkapitals — danach Auto-Kill für den Tag. */
  dailyLossLimitPct: number;
  /** Neun: Take-Profit als Vielfaches des Stop-Abstands (Reward:Risk). */
  takeProfitRR: number;
  /** Neu: Stop-Loss = ATR × diesem Faktor, wenn der Agent keinen Stop nennt. */
  atrStopMultiplier: number;
};

/** Werks-/Standardwerte = zugleich Untergrenzen der Vernunft. */
export const DEFAULT_LIMITS: RiskLimits = {
  maxPositionPct: 0.25,
  maxRiskPerTrade: 0.02,
  maxNotionalPerOrder: 0,
  maxConcurrentPositions: 5,
  allowShort: false,
  maxLeverage: 1,
  requireStopLoss: true,
  defaultStopLossPct: 0.05,
  maxEquityDrawdownPct: 0.15,
  dailyLossLimitPct: 0.05,
  takeProfitRR: 1.5,
  atrStopMultiplier: 2,
} as const;

/**
 * ABSOLUTE CODE-CEILINGS. Ein DB-Wert außerhalb dieses Fensters wird geklemmt.
 * Diese Tabelle ist bewusst NICHT zur Laufzeit änderbar — sie definiert den
 * Sandbox-Rahmen, in dem sich das System selbst konfigurieren darf.
 */
export const LIMIT_CEILINGS: Record<keyof RiskLimits, [min: number, max: number]> = {
  maxPositionPct: [0.01, 0.5],
  maxRiskPerTrade: [0.002, 0.05],
  maxNotionalPerOrder: [0, 1_000_000],
  maxConcurrentPositions: [1, 10],
  allowShort: [0, 1],
  maxLeverage: [1, 3],
  requireStopLoss: [1, 1], // Pflicht bleibt Pflicht — nicht abschaltbar.
  defaultStopLossPct: [0.005, 0.2],
  maxEquityDrawdownPct: [0.03, 0.5],
  dailyLossLimitPct: [0.01, 0.25],
  takeProfitRR: [0.5, 5],
  atrStopMultiplier: [0.5, 6],
};

/** Die aktuell wirksamen Limits (Start: DEFAULT, dann DB-Overlay, immer geklemmt). */
let currentLimits: RiskLimits = { ...DEFAULT_LIMITS };

export function getLimits(): Readonly<RiskLimits> {
  return currentLimits;
}

/**
 * Setzt Laufzeit-Limits. Jeder Wert wird gegen LIMIT_CEILINGS geklemmt —
 * genau hier liegt die "Code entscheidet"-Garantie des Runtime-Tunings.
 */
export function applyRuntimeLimits(raw: Partial<RiskLimits>) {
  const next: RiskLimits = { ...currentLimits };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof RiskLimits)[]) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof DEFAULT_LIMITS[key] === "boolean") {
      const val = typeof v === "boolean" ? v : Number(v) >= 0.5;
      // requireStopLoss ist absichtlich unveränderlich — der Boolean-Zweig
      // umgeht die numerischen Ceilings nicht.
      (next[key] as boolean) = key === "requireStopLoss" ? true : val;
      continue;
    }
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    const [min, max] = LIMIT_CEILINGS[key];
    (next[key] as number) = Math.min(Math.max(num, min), max);
  }
  currentLimits = next;
  return currentLimits;
}

/** Zurück auf Werkseinstellung. */
export function resetRuntimeLimits() {
  currentLimits = { ...DEFAULT_LIMITS };
  return currentLimits;
}

// Rückwärtskompatibel: bisheriger Zugriffspunkt im Code.
export const RISK_LIMITS = new Proxy({} as RiskLimits, {
  get(_t, prop: string) {
    return (currentLimits as unknown as Record<string, unknown>)[prop];
  },
});

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

/**
 * KORRIGIERT (v1.5.3): Positionsgröße unter Berücksichtigung des
 * MISSIONSSPEZIFISCHEN Positions-Caps.
 *
 * Vorher wurde nur `riskAdjustedSize()` (globales Code-Maximum) verwendet —
 * `missions.maxPositionPct` stand lediglich im Prompt. Eine Mission, die
 * „max 5 %“ fordert (PENNY-DESK), konnte so real 25 % des Kapitals binden.
 *
 * Sandbox-Prinzip: Die Mission darf NIE über das globale Code-Ceiling hinaus —
 * effektive Obergrenze = min(Missions-Cap, globales Maximum). Ein fehlender/
 * ungültiger Missionswert fällt auf das globale Maximum zurück.
 */
export function missionSizedNotional(
  equity: number,
  stopDistPct: number,
  riskBudgetPct: number,
  missionMaxPositionPct: number | null | undefined,
  globalMaxPositionPct: number = RISK_LIMITS.maxPositionPct
): number {
  const riskSized = riskAdjustedSize(equity, stopDistPct, riskBudgetPct);
  const mission = Number(missionMaxPositionPct);
  const effectiveCapPct =
    Number.isFinite(mission) && mission > 0
      ? Math.min(mission, globalMaxPositionPct)
      : globalMaxPositionPct;
  return Math.min(riskSized, equity * effectiveCapPct);
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

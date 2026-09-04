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
 *
 * ADAPTIVER ÜBERLAGERUNGSSCHICHT (v1.7.0): maxRiskPerTrade ist zusätzlich
 * volatilitätsgetrieben anpassbar — src/lib/adaptiveRisk.ts multipliziert das
 * konfigurierte BASIS-Limit mit einem Faktor ∈ (0, 1] (can only lower, never
 * raise). Die dreistufige Kaskade bleibt die Sandbox:
 *   Code-Ceilings → Basis-Limit (DB/Dashboard) → adaptiver Marktfaktor.
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

/**
 * ADAPTIVE-RISK-ÜBERLAGERUNG (v1.7.0)
 *
 * Das wirksame maxRiskPerTrade = Basis-Limit × adaptiver Faktor.
 * - BASIS-LIMIT: DEFAULT → DB/Dashboard (applyRuntimeLimits), immer geklemmt.
 *   Der Wert 0.02 ist damit nur noch STARTWERT, keine harte Code-Grenze.
 * - ADAPTIVER FAKTOR: von src/lib/adaptiveRisk.ts gesetzt (Volatilitäts-
 *   Regime). Darf NUR senken (Faktor ∈ (0, 1]) — das Risiko kann durch
 *   Marktzustand nie über das konfigurierte Basis-Limit steigen.
 *
 * Die Trennung in baseLimits/currentLimits verhindert Kumulation:
 * Jede DB-Neuladung rechnet die Reduktion aus dem FRESCHEN Basiswert,
 * nie aus dem bereits reduzierten Wert.
 */
export type AdaptiveRegime = "NORMAL" | "ELEVATED" | "EXTREME" | "PERSISTED" | "UNKNOWN";

/**
 * `PERSISTED` = Zustand aus der DB übernommen (Mikro-Executor-Prozess ohne
 * eigenen Marktzugriff). Für die Berechnung zählt dort nur der Faktor.
 * `UNKNOWN` (H10, v1.36.21) = Bewertung fehlgeschlagen/fehlend/veraltet —
 * konservativer Boden (fail-closed), keine neuen Positionen.
 */
export type AdaptiveRiskState = {
  regime: AdaptiveRegime;
  /** 0 < factor ≤ 1 — Multiplikator auf das Basis-Limit maxRiskPerTrade. */
  factor: number;
  reason: string;
  at: string;
  indicators: Record<string, number | null>;
};

/** Max. Alter eines persistierten adaptiven Faktors (Micro-Prozess-Sicht). */
export const ADAPTIVE_STATE_MAX_AGE_MS = 15 * 60_000;

let baseLimits: RiskLimits = { ...DEFAULT_LIMITS };
let currentLimits: RiskLimits = { ...DEFAULT_LIMITS };
let adaptiveState: AdaptiveRiskState | null = null;

/** maxRiskPerTrade nach Anwendung des adaptiven Faktors (Boden = Code-Minimum). */
function applyFactorToRisk(limits: RiskLimits, factor: number): RiskLimits {
  const floor = LIMIT_CEILINGS.maxRiskPerTrade[0];
  // Faktor > 1 wäre risikosteigernd — das System darf per Marktzustand
  // nie über das konfigurierte Basis-Limit hinaus wirken.
  const f = Number.isFinite(factor) ? Math.min(Math.max(factor, 0), 1) : 1;
  return { ...limits, maxRiskPerTrade: Math.max(limits.maxRiskPerTrade * f, floor) };
}

/** currentLimits = baseLimits + (ggf.) aktive adaptive Reduktion. */
function recomputeCurrent(): RiskLimits {
  currentLimits = adaptiveState
    ? applyFactorToRisk(baseLimits, adaptiveState.factor)
    : { ...baseLimits };
  return currentLimits;
}

/** Die konfigurierten Basis-Limits (ohne adaptive Marktreduktion). */
export function getBaseLimits(): Readonly<RiskLimits> {
  return baseLimits;
}

/**
 * Die aktuell wirksamen Limits (Basis + adaptive Reduktion). Alle
 * Order-Pfade (Engine, Mikro-Executor, Guardrails, Sizing) lesen von hier.
 */
export function getLimits(): Readonly<RiskLimits> {
  return currentLimits;
}

/**
 * Wendet den aktiven Volatilitäts-Faktor an (von adaptiveRisk.ts aufgerufen).
 * `null` hebt die Reduktion auf. Boden bleibt das absolute Code-Minimum
 * aus LIMIT_CEILINGS. Liefert die wirksamen Limits.
 */
export function applyAdaptiveRisk(state: AdaptiveRiskState | null): RiskLimits {
  adaptiveState =
    state != null && Number.isFinite(state.factor) && state.factor > 0
      ? { ...state, factor: Math.min(state.factor, 1) }
      : null;
  return recomputeCurrent();
}

/** Aktive adaptive Reduktion (oder null), z. B. für Observability. */
export function getAdaptiveRiskState(): Readonly<AdaptiveRiskState> | null {
  return adaptiveState ? { ...adaptiveState } : null;
}

/**
 * Setzt Laufzeit-Limits. Jeder Wert wird gegen LIMIT_CEILINGS geklemmt —
 * genau hier liegt die "Code entscheidet"-Garantie des Runtime-Tunings.
 */
export function applyRuntimeLimits(raw: Partial<RiskLimits>) {
  const next: RiskLimits = { ...baseLimits };
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
  baseLimits = next;
  return recomputeCurrent();
}

/**
 * Zurück auf Werkseinstellung (Basis). Die aktive adaptive Marktreduktion
 * bleibt bewusst erhalten — sie beschreibt den Marktzustand, keine
 * Operator-Einstellung.
 */
export function resetRuntimeLimits() {
  baseLimits = { ...DEFAULT_LIMITS };
  return recomputeCurrent();
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

/**
 * H9 FIX (HIGH 2026-09-03): Fail-closed Numerik-Validierung.
 *
 * Vergleiche mit NaN sind IMMER false (`NaN > x === false`) und eine
 * Division durch NaN/0 ergibt NaN/Infinity — ein guardrail, der auf einem
 * ungültigen Zahlenwert rechnet, kann damit still übergangen werden.
 * Ein insolventes Konto (equity ≤ 0) wurde früher via `Math.max(equity, 1)`
 * auf 1 geklemmt statt hart blockiert.
 *
 * Prinzip: „unbekannt“ bedeutet BLOCK, nicht ALLOW. Jede numerische
 * Guardrail-Eingabe muss ein endlicher, positiver Wert sein; sonst wird
 * eine `RiskValidationError` geworfen, die die Caller (PaperBroker.submit,
 * BrokerExecutionEngine.submit, Micro-Executor) in einen REJECTED-Fill
 * übersetzen (siehe `riskValidationReason`).
 */
export class RiskValidationError extends Error {
  readonly code = "RISK_VALIDATION";
  /** Feldname, der die Validierung verletzt hat (z. B. "equity"). */
  readonly field: string;

  constructor(field: string) {
    super(`RISK_VALIDATION: ${field} muss eine endliche, positive Zahl sein`);
    this.name = "RiskValidationError";
    this.field = field;
  }
}

/**
 * Wandelt einen beliebigen Eingabewert in eine endliche, positive Zahl um.
 * Wirft `RiskValidationError` bei NaN, ±Infinity, nicht-numerischen Werten
 * oder Werten ≤ 0 (fail-closed).
 */
export function requireFinitePositive(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RiskValidationError(field);
  }
  return n;
}

/**
 * Übersetzt eine geworfene `RiskValidationError` in den stabilen
 * REJECTED-Reason-Code, den die Broker-Schicht verwendet:
 *   equity    → INVALID_EQUITY
 *   leverage  → INVALID_LEVERAGE
 *   notional  → INVALID_NOTIONAL
 *   sonstige  → RISK_VALIDATION:<field>
 */
export function riskValidationReason(e: unknown): string {
  if (e instanceof RiskValidationError) {
    switch (e.field) {
      case "equity":
        return "INVALID_EQUITY";
      case "leverage":
        return "INVALID_LEVERAGE";
      case "notional":
        return "INVALID_NOTIONAL";
      default:
        return `RISK_VALIDATION:${e.field}`;
    }
  }
  return e instanceof Error ? e.message.slice(0, 60) : "RISK_VALIDATION";
}

export function validateOrder(ctx: ValidateContext): GuardrailResult {
  const blockedBy: string[] = [];

  // H9 FIX: Alle numerischen Guardrail-Eingaben werden fail-closed geprüft.
  // NaN/Infinity/≤0 wirft — Vergleiche gegen NaN sind immer false und würden
  // die Schranke sonst still umgehen; negatives Equity (insolvent) wird nie
  // mehr auf 1 geklemmt, sondern blockiert. Der frühere notional-Fast-Path
  // (`!Number.isFinite(notional) || notional <= 0`) bleibt als erster Check
  // erhalten, routet aber über requireFinitePositive, sodass NaN/≤0 hier
  // einheitlich werfen statt nur in die blockedBy-Liste zu laufen.
  if (!Number.isFinite(ctx.notional) || ctx.notional <= 0) {
    requireFinitePositive(ctx.notional, "notional"); // wirft immer (Fast-Path)
  }
  const equity = requireFinitePositive(ctx.equity, "equity");
  const leverage = requireFinitePositive(ctx.leverage, "leverage");
  const notional = requireFinitePositive(ctx.notional, "notional");

  const positionPct = notional / equity;

  if (positionPct > RISK_LIMITS.maxPositionPct) {
    blockedBy.push(
      `position-size:max-${(RISK_LIMITS.maxPositionPct * 100).toFixed(0)}%-of-equity`
    );
  }

  if (
    RISK_LIMITS.maxNotionalPerOrder > 0 &&
    notional > RISK_LIMITS.maxNotionalPerOrder
  ) {
    blockedBy.push(`notional:hard-cap-${RISK_LIMITS.maxNotionalPerOrder}`);
  }

  if (ctx.side === "SHORT" && !RISK_LIMITS.allowShort) {
    blockedBy.push("side:short-trading-disabled");
  }

  if (leverage > RISK_LIMITS.maxLeverage) {
    blockedBy.push(`leverage:max-${RISK_LIMITS.maxLeverage}x`);
  }

  if (RISK_LIMITS.requireStopLoss && !ctx.hasStopLoss) {
    blockedBy.push("stop-loss:mandatory");
  }

  // H9: Auch der Positionszähler wird fail-closed gelesen — ein unbekannter
  // Wert (NaN/nicht endlich/negativ) darf die Nebenläufigkeits-Schranke nicht
  // still umgehen (NaN >= x ist false). Unbekannt => BLOCK.
  const openPositions = Number(ctx.openPositions);
  const concurrencyReached =
    Number.isFinite(openPositions) && openPositions >= 0
      ? openPositions >= RISK_LIMITS.maxConcurrentPositions
      : true;
  if (concurrencyReached) {
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

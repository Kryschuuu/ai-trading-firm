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
 * raise).
 *
 * VOLATILITY-TARGETING-ÜBERLAGERUNG (RMA-P5-01, v1.67.0): src/lib/
 * volatilityTargeting.ts fügt einen ZWEITEN, kontinuierlichen Faktor hinzu
 * (Portfolio-Volatilitätsforecast gegen konfiguriertes Ziel). Beide Faktoren
 * sind unabhängig und werden MULTIPLIKATIV komponiert (jeweils ≤ 1, das
 * Produkt damit ≤ 1). Die Kaskade bleibt die Sandbox:
 *   Code-Ceilings → Basis-Limit (DB/Dashboard)
 *     → Regime-Faktor (diskret) × VolTarget-Faktor (kontinuierlich)
 *     → Code-Boden.
 *
 * DRAWDOWN-SCALING-ÜBERLAGERUNG (RMA-P5-04, v1.68.0): src/lib/drawdownScaling.ts
 * fügt einen DRITTEN Faktor aus dem laufenden High-Water-Mark-Drawdown hinzu
 * (hysteretisch, mit Cooldown). Er wird exakt wie die anderen beiden
 * multiplikativ komponiert (jeweils ≤ 1 ⇒ Produkt ≤ 1) und kann zusätzlich in
 * der Stufe `PAUSE` NEUE EINSTIEGE blockieren (`validateOrder`-Guardrail
 * `drawdown-pause`). Die Authority Chain lautet damit:
 *   Code-Ceilings → Basis-Limit
 *     → Regime-Faktor × VolTarget-Faktor × Drawdown-Faktor
 *     → Code-Boden;  PAUSE (Drawdown oder Strategy-Lifecycle) blockiert neue Einstiege.
 * Keine Stufe kann eine spätere aufweiten: jeder Faktor ist ≤ 1 und der
 * PAUSE-Block ist ein Veto (kein Multiplikator).
 *
 * STRATEGY-LIFECYCLE (RMA-P1-05, v1.73.0): src/strategyLifecycle/ speist einen
 * VIERTEN, nur senkenden Faktor ein (Drift-Degradation) und ein PAUSE-/REJECTED-
 * Veto für neue Einstiege (`strategy-lifecycle-pause`).
 */

import type { DrawdownStage } from "@/portfolio/drawdownScaling";

import { state } from "./stateRegistry";

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

/**
 * RMA-P5-01 (v1.67.0): Volatility-Targeting-Überschlag.
 *
 * Der Faktor ist der ANGEWENDETE Multiplikator des kontinuierlichen
 * Portfolio-Volatility-Targetings (Kern: `src/portfolio/volatilityTargeting.ts`).
 * Er wirkt exakt wie der adaptive Regime-Faktor — multiplikativ auf
 * `maxRiskPerTrade`, nur senkend (Faktor ∈ (0, 1]). Die Kaskade lautet:
 *
 *   Code-Ceilings (LIMIT_CEILINGS)
 *     └─ Basis-Limit (risk_config / Dashboard)
 *          └─ × Regime-Faktor (diskret, adaptiveRisk.ts)
 *               └─ × VolTarget-Faktor (kontinuierlich, volatilityTargeting.ts)
 *                    └─ Code-Boden (LIMIT_CEILINGS.maxRiskPerTrade[0])
 *
 * Multiplikative Komposition: beide Faktoren ≤ 1 ⇒ ihr Produkt ≤ jeder
 * Faktor ≤ 1 ⇒ das Ergebnis kann das konfigurierte Basis-Limit niemals
 * überschreiten. Die beiden Faktoren sind unabhängig (Regime = Markt-Furcht,
 * VolTarget = Portfolio-Volatilitätsziel) und stacken daher.
 *
 * `mode` dokumentiert die Herkunft:
 *   - `active`    — vom Live-Orchestrator gesetzt (Monitor-only ist null).
 *   - `persisted` — aus `risk_config` übernommen (Mikro-Executor-Prozess).
 */
export type VolatilityTargetingState = {
  /** 0 < factor ≤ 1 — Multiplikator auf das Basis-Limit maxRiskPerTrade. */
  factor: number;
  at: string;
  /** As-of-Zeitstempel des Forecasts (ISO), null wenn nicht anwendbar. */
  asOf: string | null;
  reason: string;
  mode: "active" | "persisted";
};

/**
 * RMA-P5-04 (v1.68.0): Hysteretisches Drawdown-Risk-Scaling.
 *
 * Der Faktor stammt aus dem laufenden Drawdown gegenüber dem persisteden
 * High-Water-Mark (`src/portfolio/drawdownScaling.ts`, pure Policy) und ist
 * monoton nicht-steigend in Drawdown, hart ∈ [minFactor, 1]. Er wirkt exakt
 * wie die anderen Marktfaktoren: multiplikativ auf `maxRiskPerTrade`, nur
 * senkend. Zusätzlich blockiert die Stufe `PAUSE` (optional, konfigurierbar)
 * NEUE Einstiege — ein Veto, das keine spätere Stufe aufheben kann.
 */
/**
 * RMA-P1-05 (v1.73.0): Strategy-Lifecycle-Risikofaktor.
 *
 * Factor ∈ (0,1] — multiplikativ, nur senkend. `paused=true` wenn die
 * Strategy-Version PAUSED/REJECTED ist (Veto auf neue Einstiege). Die
 * persistente Wahrheit steht in `strategy_lifecycle_states`; dieser
 * Prozesszustand ist die RAM-Projektion für die Authority Chain.
 */
export type LifecycleRiskState = {
  factor: number;
  paused: boolean;
  at: string;
  reason: string;
  mode: "active" | "monitor";
  policyVersion: string;
  /** Letzter bekannter Lifecycle-Zustand (Anzeige/Audit, kein Zähler-Label). */
  state: string;
};

export type DrawdownRiskState = {
  /** 0 < factor ≤ 1 — Multiplikator auf das Basis-Limit maxRiskPerTrade. */
  factor: number;
  /** Stufe der Policy: NORMAL | SOFT | DEEP | PAUSE. */
  stage: DrawdownStage;
  /** true = neue Einstiege blockiert (nur wirksam im Modus `active`). */
  paused: boolean;
  /** Drawdown ∈ [0,1] oder null (unbekannt — nie still 0). */
  drawdownPct: number | null;
  /** Cashflow-bereinigter High-Water-Mark oder null. */
  hwm: number | null;
  at: string;
  asOf: string | null;
  reason: string;
  mode: "active" | "persisted";
  /** Policyversion `ddp1:<sha256>` (Policyänderung ⇒ neue Version). */
  policyVersion: string;
};

// S2 (v1.36.22): baseLimits/currentLimits/adaptiveState liegen jetzt in der
// zentralen State-Registry (Wahrheit von `baseLimits` = risk_config/Default;
// `currentLimits` = Basis + kombinierter Marktfaktor). Defaults werden hier
// registriert, damit `__resetAllSingletonsForTests()` deterministisch in den
// Ausgangszustand zuruecksetzt.
state.baseLimits.setDefault(() => ({ ...DEFAULT_LIMITS }));
state.currentLimits.setDefault(() => ({ ...DEFAULT_LIMITS }));
state.adaptiveState.setDefault(() => null);
state.volTargetState.setDefault(() => null);
state.drawdownState.setDefault(() => null);
state.strategyLifecycleState.setDefault(() => null);

/** maxRiskPerTrade nach Anwendung des kombinierten Marktfaktors (Boden = Code-Minimum). */
function applyFactorToRisk(limits: RiskLimits, factor: number): RiskLimits {
  const floor = LIMIT_CEILINGS.maxRiskPerTrade[0];
  // Faktor > 1 wäre risikosteigernd — das System darf per Marktzustand
  // nie über das konfigurierte Basis-Limit hinaus wirken.
  const f = Number.isFinite(factor) ? Math.min(Math.max(factor, 0), 1) : 1;
  return { ...limits, maxRiskPerTrade: Math.max(limits.maxRiskPerTrade * f, floor) };
}

/**
 * Kombiniert die Marktfaktoren (RMA-P5-01, RMA-P5-04, RMA-P1-05):
 * Regime × VolTarget × Drawdown × Strategy-Lifecycle, jeweils hart auf (0, 1]
 * geklemmt. Ohne einen Faktor = 1 (neutral). Das Produkt ist damit immer ≤ 1 —
 * das Ergebnis kann das Basis-Limit nie überschreiten, und keine spätere Stufe
 * kann eine frühere aufweiten (Authority Chain).
 */
function combinedMarketFactor(): number {
  const adaptive = state.adaptiveState.get();
  const volTarget = state.volTargetState.get();
  const drawdown = state.drawdownState.get();
  const lifecycle = state.strategyLifecycleState.get();
  let f = 1;
  if (adaptive != null && Number.isFinite(adaptive.factor) && adaptive.factor > 0) {
    f *= Math.min(adaptive.factor, 1);
  }
  if (volTarget != null && Number.isFinite(volTarget.factor) && volTarget.factor > 0) {
    f *= Math.min(volTarget.factor, 1);
  }
  if (drawdown != null && Number.isFinite(drawdown.factor) && drawdown.factor > 0) {
    f *= Math.min(drawdown.factor, 1);
  }
  if (lifecycle != null && Number.isFinite(lifecycle.factor) && lifecycle.factor > 0) {
    f *= Math.min(lifecycle.factor, 1);
  }
  return f;
}

/**
 * currentLimits = baseLimits × kombinierter Marktfaktor
 * (Regime × VolTarget × Drawdown × Strategy-Lifecycle, alle ≤ 1).
 */
function recomputeCurrent(): RiskLimits {
  const base = state.baseLimits.get()!;
  const factor = combinedMarketFactor();
  state.currentLimits.set(factor < 1 ? applyFactorToRisk(base, factor) : { ...base });
  return state.currentLimits.get()!;
}

/** Die konfigurierten Basis-Limits (ohne adaptive Marktreduktion). */
export function getBaseLimits(): Readonly<RiskLimits> {
  return state.baseLimits.get()!;
}

/**
 * Die aktuell wirksamen Limits (Basis + adaptive Reduktion). Alle
 * Order-Pfade (Engine, Mikro-Executor, Guardrails, Sizing) lesen von hier.
 */
export function getLimits(): Readonly<RiskLimits> {
  return state.currentLimits.get()!;
}

/**
 * Wendet den aktiven Volatilitäts-Faktor an (von adaptiveRisk.ts aufgerufen).
 * `null` hebt die Reduktion auf. Boden bleibt das absolute Code-Minimum
 * aus LIMIT_CEILINGS. Liefert die wirksamen Limits.
 */
export function applyAdaptiveRisk(snapshot: AdaptiveRiskState | null): RiskLimits {
  state.adaptiveState.set(
    snapshot != null && Number.isFinite(snapshot.factor) && snapshot.factor > 0
      ? { ...snapshot, factor: Math.min(snapshot.factor, 1) }
      : null
  );
  return recomputeCurrent();
}

/** Aktive adaptive Reduktion (oder null), z. B. für Observability. */
export function getAdaptiveRiskState(): Readonly<AdaptiveRiskState> | null {
  const current = state.adaptiveState.get();
  return current ? { ...current } : null;
}

/**
 * RMA-P5-01 (v1.67.0): Wendet den Volatility-Targeting-Faktor an.
 *
 * `null` hebt die Reduktion auf (Rollback- und Monitor-Pfad). Der Faktor
 * wird hart auf (0, 1] geklemmt — eine Konfigurations- oder Übermittlungs-
 * fehler kann das Basis-Limit niemals überschreiten. Wie `applyAdaptiveRisk`
 * rechnet `recomputeCurrent()` aus dem FRESCHEN Basiswert (keine Kumulation
 * bei DB-Neuladungen).
 */
export function applyVolatilityTargeting(snapshot: VolatilityTargetingState | null): RiskLimits {
  state.volTargetState.set(
    snapshot != null && Number.isFinite(snapshot.factor) && snapshot.factor > 0
      ? { ...snapshot, factor: Math.min(snapshot.factor, 1) }
      : null
  );
  return recomputeCurrent();
}

/** Aktive Volatility-Targeting-Reduktion (oder null), z. B. für Observability. */
export function getVolatilityTargetingState(): Readonly<VolatilityTargetingState> | null {
  const current = state.volTargetState.get();
  return current ? { ...current } : null;
}

/**
 * RMA-P5-04 (v1.68.0): Wendet den Drawdown-Scaling-Faktor an.
 *
 * `null` hebt die Reduktion UND einen etwaigen PAUSE-Block auf (Rollback- und
 * Monitor-Pfad). Der Faktor wird hart auf (0, 1] geklemmt — ein
 * Konfigurations- oder Übermittlungsfehler kann das Basis-Limit niemals
 * überschreiten (der Boden bleibt `LIMIT_CEILINGS.maxRiskPerTrade[0]`).
 * Wie die anderen `apply*`-Funktionen rechnet `recomputeCurrent()` aus dem
 * FRISCHEN Basiswert (keine Kumulation bei DB-Neuladungen).
 */
export function applyDrawdownScaling(snapshot: DrawdownRiskState | null): RiskLimits {
  state.drawdownState.set(
    snapshot != null && Number.isFinite(snapshot.factor) && snapshot.factor > 0
      ? {
          ...snapshot,
          factor: Math.min(snapshot.factor, 1),
          // PAUSE ist nur in der PAUSE-Stufe gültig — ein inkonsistenter
          // Zustand (paused ohne Stufe) würde sonst still blockieren.
          paused: snapshot.paused === true && snapshot.stage === "PAUSE",
        }
      : null
  );
  return recomputeCurrent();
}

/** Aktive Drawdown-Reduktion (oder null), z. B. für Observability. */
export function getDrawdownScalingState(): Readonly<DrawdownRiskState> | null {
  const current = state.drawdownState.get();
  return current ? { ...current } : null;
}

/**
 * Veto-Auskunft für neue Einstiege (RMA-P5-04, v1.68.0).
 *
 * `blocked = true` genau dann, wenn der aktive Drawdown-Zustand die Stufe
 * `PAUSE` trägt. Der Block ist bewusst KEIN Multiplikator: ein Faktor > 0
 * könnte eine Order nur verkleinern, PAUSE verhindert sie ganz. Der
 * Kill-Switch (`killSwitch.isArmed()`) bleibt davon unberührt und gilt
 * weiterhin zusätzlich.
 */
export function drawdownPauseState(): { blocked: boolean; stage: DrawdownStage | null; reason: string | null } {
  const current = state.drawdownState.get();
  if (current != null && current.paused === true && current.stage === "PAUSE") {
    return { blocked: true, stage: current.stage, reason: current.reason };
  }
  return { blocked: false, stage: current?.stage ?? null, reason: current?.reason ?? null };
}

/**
 * RMA-P1-05 (v1.73.0): Wendet den Strategy-Lifecycle-Risikofaktor an.
 *
 * `null` hebt Reduktion UND PAUSE-Block auf (Monitor-/Rollback-Pfad). Der
 * Faktor wird hart auf (0, 1] geklemmt — eine Degradation kann das Basis-Limit
 * nur senken, nie steigern. `paused=true` (Zustand PAUSED/REJECTED) blockiert
 * zusätzliche NEUE Einstiege als Veto in `validateOrder`.
 */
export function applyStrategyLifecycleScale(snapshot: LifecycleRiskState | null): RiskLimits {
  state.strategyLifecycleState.set(
    snapshot != null && Number.isFinite(snapshot.factor) && snapshot.factor > 0
      ? { ...snapshot, factor: Math.min(snapshot.factor, 1), paused: snapshot.paused === true }
      : null
  );
  return recomputeCurrent();
}

/** Aktiver Strategy-Lifecycle-Zustand (oder null), z. B. für Observability. */
export function getStrategyLifecycleState(): Readonly<LifecycleRiskState> | null {
  const current = state.strategyLifecycleState.get();
  return current ? { ...current } : null;
}

/**
 * Veto-Auskunft für neue Einstiege der Strategy-Lifecycle (RMA-P1-05).
 * `blocked = true` genau dann, wenn der aktive Lifecycle-Zustand pausiert/
 * abgelehnt ist. Kill-Switch und Drawdown-PAUSE bleiben unberührt und gelten
 * zusätzlich.
 */
export function strategyLifecyclePauseState(): {
  blocked: boolean;
  reason: string | null;
  state: string | null;
} {
  const current = state.strategyLifecycleState.get();
  if (current != null && current.paused === true) {
    return { blocked: true, reason: current.reason, state: current.state };
  }
  return {
    blocked: false,
    reason: current?.reason ?? null,
    state: current?.state ?? null,
  };
}

/**
 * Setzt Laufzeit-Limits. Jeder Wert wird gegen LIMIT_CEILINGS geklemmt —
 * genau hier liegt die "Code entscheidet"-Garantie des Runtime-Tunings.
 */
export function applyRuntimeLimits(raw: Partial<RiskLimits>) {
  const next: RiskLimits = { ...state.baseLimits.get()! };
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
  state.baseLimits.set(next);
  return recomputeCurrent();
}

/**
 * Zurück auf Werkseinstellung (Basis). Die aktive adaptive Marktreduktion
 * bleibt bewusst erhalten — sie beschreibt den Marktzustand, keine
 * Operator-Einstellung.
 */
export function resetRuntimeLimits() {
  state.baseLimits.set({ ...DEFAULT_LIMITS });
  return recomputeCurrent();
}

// Rückwärtskompatibel: bisheriger Zugriffspunkt im Code.
export const RISK_LIMITS = new Proxy({} as RiskLimits, {
  get(_t, prop: string) {
    return (state.currentLimits.get()! as unknown as Record<string, unknown>)[prop];
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

  // RMA-P5-04 (v1.68.0): Drawdown-PAUSE blockiert NEUE EINSTIEGE vollständig.
  // `submit()`-Pfade sind Einstiegspfade (Exits laufen über die Schließ-Logik
  // des Brokers/Monitors), daher ist dieser Guardrail das zentrale Veto der
  // Drawdown-Policy. Der Block gilt nur, wenn der Zustand im Modus `active`
  // gesetzt wurde (`applyDrawdownScaling(null)` nimmt ihn zurück).
  const pause = drawdownPauseState();
  if (pause.blocked) {
    blockedBy.push("drawdown-pause:new-entries-blocked");
  }

  // RMA-P1-05 (v1.73.0): Strategy-Lifecycle-PAUSE/REJECTED vetot neue
  // Einstiege derselben Authority Chain — unabhängig vom Drawdown-Pfad.
  const lifecyclePause = strategyLifecyclePauseState();
  if (lifecyclePause.blocked) {
    blockedBy.push("strategy-lifecycle-pause:new-entries-blocked");
  }

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
export const killSwitch = {
  isArmed: () => state.killSwitchArmed.get(),
  pull: (reason: string) => {
    state.killSwitchArmed.set(true);
    console.error(`[KILL-SWITCH] PULLED: ${reason}`);
    return state.killSwitchArmed.get();
  },
  disarm: () => state.killSwitchArmed.set(false),
};

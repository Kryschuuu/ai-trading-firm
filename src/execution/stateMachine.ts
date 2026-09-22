/**
 * Zentrale State-Machine des Execution-Policy-Controllers (RMA-P4-02).
 *
 * Zustände (Lebenszyklus EINES Maker-Versuchs inkl. optionalem Fallback):
 *
 *   NEW ──► SUBMITTED ──► ACK ──► PARTIAL ──► DONE
 *               │           │         │          ▲
 *               │           │         ▼          │
 *               │           │   CANCEL_PENDING ──┘ (später Fill komplettiert)
 *               │           │         │
 *               │           │         ▼
 *               │           │     CANCELLED ──► FALLBACK_SUBMITTED ──► DONE
 *               │           │         │                │
 *               ▼           ▼         ▼                ▼
 *            REJECTED    FAILED    FAILED            FAILED
 *               │
 *               └──► SUBMITTED (bounded Reprice nach Maker-Reject)
 *
 * Regeln:
 *   - Jeder Übergang ist explizit in ALLOWED_TRANSITIONS gelistet; alles andere
 *     wirft `ExecutionTransitionError` (fail-closed, kein stiller Sprung).
 *   - Jeder Übergang inkrementiert die optimistische `version` (concurrency).
 *   - Fills ändern den Zustand nur an den Kanten PARTIAL→DONE,
 *     CANCEL_PENDING→DONE und FALLBACK_SUBMITTED→DONE; Teilfills innerhalb von
 *     PARTIAL/CANCEL_PENDING/FALLBACK_SUBMITTED sind mengenrelevante Ereignisse
 *     ohne Zustandswechsel (Version steigt trotzdem — siehe Store).
 *   - DONE/FAILED sind terminal (keine ausgehenden Kanten).
 *   - REJECTED ist NUR für einen bounded Reprice (→ SUBMITTED) oder den
 *     terminalen Abschluss (→ FAILED) verlassbar; ein Market-Fallback aus
 *     REJECTED ist VERBOTEN (keine offene Restmenge ohne Cancel-Bestätigung —
 *     der Reject bedeutet „nichts am Markt“, ein Reprice ist ein NEUER Versuch).
 */
export type ExecutionWorkflowState =
  | "NEW"
  | "SUBMITTED"
  | "ACK"
  | "PARTIAL"
  | "CANCEL_PENDING"
  | "CANCELLED"
  | "FALLBACK_SUBMITTED"
  | "DONE"
  | "REJECTED"
  | "FAILED";

export const EXECUTION_WORKFLOW_STATES: readonly ExecutionWorkflowState[] = [
  "NEW",
  "SUBMITTED",
  "ACK",
  "PARTIAL",
  "CANCEL_PENDING",
  "CANCELLED",
  "FALLBACK_SUBMITTED",
  "DONE",
  "REJECTED",
  "FAILED",
];

export const TERMINAL_EXECUTION_STATES: readonly ExecutionWorkflowState[] = [
  "DONE",
  "FAILED",
  "REJECTED",
];

/**
 * REJECTED ist terminal, AUSSER der Controller hat Reprice-Budget: dann ist
 * genau EINE Kante (→ SUBMITTED) erlaubt. `isTerminalState` meldet die
 * strukturelle Terminalität; `canTransition` die dynamische Kante.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionWorkflowState, readonly ExecutionWorkflowState[]>> = {
  NEW: ["SUBMITTED", "REJECTED", "FAILED"],
  SUBMITTED: ["ACK", "PARTIAL", "CANCEL_PENDING", "REJECTED", "FAILED", "DONE"],
  ACK: ["PARTIAL", "DONE", "CANCEL_PENDING", "FAILED"],
  PARTIAL: ["DONE", "CANCEL_PENDING", "FAILED"],
  CANCEL_PENDING: ["CANCELLED", "DONE", "PARTIAL", "FAILED"],
  CANCELLED: ["FALLBACK_SUBMITTED", "DONE", "FAILED", "SUBMITTED"],
  FALLBACK_SUBMITTED: ["DONE", "FAILED"],
  DONE: [],
  REJECTED: ["SUBMITTED", "FAILED"],
  FAILED: [],
};

export class ExecutionTransitionError extends Error {
  readonly code = "EXECUTION_TRANSITION_INVALID";
  readonly from: ExecutionWorkflowState;
  readonly to: ExecutionWorkflowState;
  constructor(from: ExecutionWorkflowState, to: ExecutionWorkflowState) {
    super(`EXECUTION_TRANSITION_INVALID: ${from} → ${to} ist keine erlaubte Kante`);
    this.name = "ExecutionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isExecutionState(value: unknown): value is ExecutionWorkflowState {
  return (
    typeof value === "string" &&
    (EXECUTION_WORKFLOW_STATES as readonly string[]).includes(value)
  );
}

/** Strukturell terminal (kein normaler Fortschritt mehr möglich). */
export function isTerminalState(state: ExecutionWorkflowState): boolean {
  return (TERMINAL_EXECUTION_STATES as readonly string[]).includes(state);
}

/** True, wenn die Kante from → to erlaubt ist (inkl. Reprice-Sonderkanten). */
export function canTransition(
  from: ExecutionWorkflowState,
  to: ExecutionWorkflowState
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Wirft `ExecutionTransitionError`, wenn die Kante verboten ist. */
export function assertTransition(
  from: ExecutionWorkflowState,
  to: ExecutionWorkflowState
): void {
  if (!canTransition(from, to)) {
    throw new ExecutionTransitionError(from, to);
  }
}

/**
 * Nächste optimistische Version. Die Version steigt bei JEDEM persistierten
 * Schritt (Zustandswechsel UND Fill-/Reprice-Ereignisse); der Store vergleicht
 * sie atomar (`UPDATE … WHERE version = $expected`).
 */
export function nextVersion(current: number): number {
  if (!Number.isInteger(current) || current < 1) {
    throw new ExecutionTransitionError("NEW", "NEW");
  }
  return current + 1;
}

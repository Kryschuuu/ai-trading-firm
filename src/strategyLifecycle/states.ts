/**
 * Strategy-Lifecycle-State-Machine (RMA-P1-05, v1.73.0) — reine Domäne.
 *
 * Trennung zur bestehenden Rule-Lifecycle (`trade_rules.status`) und zur
 * Broker-/Live-Gate-Control-Plane: Diese Maschine beantwortet die Frage, ob
 * EINE konkrete Strategieversion evidenzbasiert von Backtest über Paper nach
 * Live promoviert werden darf und ob sie bei Drift degradiert werden muss.
 *
 * Zustände:
 *   DRAFT ──► BACKTEST_PENDING ──► BACKTEST_PASSED ──► PAPER ──► LIVE_LIMITED ──► LIVE
 *      │              │                    │              │            │           │
 *      │              ▼                    ▼              ▼            ▼           ▼
 *      └────────► REJECTED ◄───────────────┴──────────────┴──── DEGRADED ◄─────────┤
 *                                             PAUSED ◄── DEGRADED / LIVE / PAPER    │
 *                                             (Recovery nur mit Cooldown +          │
 *                                              neuer Evidenz + Audit)               │
 *
 * Regeln:
 *   - Jede Kante ist explizit in ALLOWED_TRANSITIONS gelistet; alles andere
 *     wird abgelehnt (fail-closed, kein stiller Sprung DRAFT → LIVE).
 *   - Jede Kante hat eine Rollen-Precondition und optionale Evidenzpflicht.
 *   - Idempotente Transition Keys (`slt1:<sha256>`) deduplizieren Retries:
 *     derselbe Key ⇒ genau ein Zustand, genau ein Audit-Ereignis.
 *   - Degradation ist NIEMALS risikosteigernd; Recovery ist nie automatisch.
 */

export const STRATEGY_LIFECYCLE_STATES = [
  "DRAFT",
  "BACKTEST_PENDING",
  "BACKTEST_PASSED",
  "PAPER",
  "LIVE_LIMITED",
  "LIVE",
  "DEGRADED",
  "PAUSED",
  "REJECTED",
] as const;

export type StrategyLifecycleState = (typeof STRATEGY_LIFECYCLE_STATES)[number];

/** Rollen, die eine Kante auslösen darf (kompatibel zur bestehenden Rollenmatrix). */
export const LIFECYCLE_ROLES = ["viewer", "operator", "admin", "system"] as const;
export type LifecycleRole = (typeof LIFECYCLE_ROLES)[number];

/** Auslöser der Kante — bounded, metrikfähig. */
export type LifecycleTrigger =
  | "operator"
  | "system"
  | "backtest"
  | "drift"
  | "recovery"
  | "override";

/**
 * Evidenzarten, die eine Kante stützen MÜSSEN, wenn `requiresEvidence`.
 * `DRIFT` kann Degradation auslösen; `BACKTEST_RUN`/`PAPER_WINDOW` stützen
 * Promotion; `RECOVERY` stützt Wieder-Promotion nach Cooldown.
 */
export const LIFECYCLE_EVIDENCE_KINDS = [
  "BACKTEST_RUN",
  "PAPER_WINDOW",
  "RECONCILIATION",
  "EXECUTION_QUALITY",
  "DRIFT",
  "RECOVERY",
  "OVERRIDE",
  "DATA_QUALITY",
] as const;
export type LifecycleEvidenceKind = (typeof LIFECYCLE_EVIDENCE_KINDS)[number];

export type LifecycleErrorCode =
  | "TRANSITION_UNKNOWN"
  | "TRANSITION_FORBIDDEN"
  | "ROLE_NOT_ALLOWED"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_KIND_MISMATCH"
  | "EVIDENCE_STALE"
  | "COOLDOWN_ACTIVE"
  | "STATE_NOT_FOUND"
  | "SEQ_CONFLICT"
  | "IDEMPOTENT_REPLAY";

export class LifecycleTransitionError extends Error {
  readonly code: LifecycleErrorCode;
  readonly from: StrategyLifecycleState | null;
  readonly to: StrategyLifecycleState | null;

  constructor(
    code: LifecycleErrorCode,
    message: string,
    from: StrategyLifecycleState | null = null,
    to: StrategyLifecycleState | null = null
  ) {
    super(`STRATEGY_LIFECYCLE_${code}: ${message}`);
    this.name = "LifecycleTransitionError";
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

export interface LifecycleTransitionDef {
  from: StrategyLifecycleState;
  to: StrategyLifecycleState;
  /** Mindestrolle des auslösenden Akteurs. */
  roles: readonly LifecycleRole[];
  trigger: readonly LifecycleTrigger[];
  /** true = ohne frische, passende Evidenz nicht erlaubt. */
  requiresEvidence: boolean;
  /** Evidenzarten, die diese Kante stützen darf (leer = jede Art). */
  evidenceKinds: readonly LifecycleEvidenceKind[];
  /** true = setzt Cooldown (Recovery-Sperre) auf die Ziel-Zeile. */
  setsCooldown: boolean;
  /** Risikofaktor der Ziel-Zeile (nur senkend; 1 = neutral). */
  targetRiskScale: number;
  /** Beschreibung für Audit/API. */
  description: string;
}

/**
 * Kanonische Transitions-Tabelle — EIN Ort für Kanten, Rollen, Evidenz und
 * Risikoskala. TestsEnumerieren alle Kanten und prüfen jeden erlaubten und
 * verbotenen Übergang gegen diese Map.
 */
export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransitionDef[] = [
  // ── Vorwärts: Evidenzkette Backtest → Paper → Live ──────────────────────
  {
    from: "DRAFT",
    to: "BACKTEST_PENDING",
    roles: ["operator", "admin", "system"],
    trigger: ["operator", "system", "backtest"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Backtest anstoßen — Version bleibt inaktiv.",
  },
  {
    from: "BACKTEST_PENDING",
    to: "BACKTEST_PASSED",
    roles: ["system", "operator", "admin"],
    trigger: ["system", "backtest", "operator"],
    requiresEvidence: true,
    evidenceKinds: ["BACKTEST_RUN"],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "OOS-Backtest-Gates bestanden (Evidenz: Walk-Forward-Run).",
  },
  {
    from: "BACKTEST_PENDING",
    to: "REJECTED",
    roles: ["system", "operator", "admin"],
    trigger: ["system", "backtest", "operator"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Backtest-Gates verfehlt — Version abgelehnt.",
  },
  {
    from: "BACKTEST_PASSED",
    to: "PAPER",
    roles: ["operator", "admin"],
    trigger: ["operator", "system"],
    requiresEvidence: true,
    evidenceKinds: ["BACKTEST_RUN"],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Paper-Fenster starten — Evidenz aus dem bestandenen Backtest.",
  },
  {
    from: "BACKTEST_PASSED",
    to: "REJECTED",
    roles: ["operator", "admin", "system"],
    trigger: ["operator", "system"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Backtest-Evidenz widerrufen/veraltet — Version abgelehnt.",
  },
  {
    from: "PAPER",
    to: "LIVE_LIMITED",
    roles: ["admin"],
    trigger: ["operator", "system", "drift"],
    requiresEvidence: true,
    evidenceKinds: ["BACKTEST_RUN", "PAPER_WINDOW"],
    setsCooldown: false,
    targetRiskScale: 0.5,
    description:
      "Promotion auf begrenztes Live (erfordert frisches Backtest- UND Paper-Fenster).",
  },
  {
    from: "PAPER",
    to: "REJECTED",
    roles: ["operator", "admin", "system"],
    trigger: ["operator", "system", "drift"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Paper-Gates verfehlt — Version abgelehnt.",
  },
  {
    from: "PAPER",
    to: "DEGRADED",
    roles: ["system", "admin", "operator"],
    trigger: ["system", "drift", "operator"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Drift während Paper — Risiko senken, kein Live-Zugewinn.",
  },
  {
    from: "PAPER",
    to: "PAUSED",
    roles: ["system", "admin", "operator"],
    trigger: ["system", "drift", "operator", "override"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Paper pausieren (Operator/Drift).",
  },
  {
    from: "LIVE_LIMITED",
    to: "LIVE",
    roles: ["admin"],
    trigger: ["operator", "system"],
    requiresEvidence: true,
    evidenceKinds: ["PAPER_WINDOW", "DRIFT"],
    setsCooldown: false,
    targetRiskScale: 1,
    description:
      "Volle Live-Freigabe — frisches Paper-Fenster + bestandener Drift-Check.",
  },
  {
    from: "LIVE_LIMITED",
    to: "DEGRADED",
    roles: ["system", "admin"],
    trigger: ["system", "drift", "operator"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Drift im begrenzten Live — Risiko weiter senken.",
  },
  {
    from: "LIVE_LIMITED",
    to: "PAUSED",
    roles: ["system", "admin"],
    trigger: ["system", "drift", "operator", "override"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Begrenztes Live pausieren.",
  },
  {
    from: "LIVE_LIMITED",
    to: "PAPER",
    roles: ["admin", "operator"],
    trigger: ["operator", "override"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Operator-Rollback in den Paper-Betrieb.",
  },
  {
    from: "LIVE",
    to: "LIVE_LIMITED",
    roles: ["system", "admin"],
    trigger: ["system", "drift", "operator", "override"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Risiko-Scale-down ohne vollständigen Stopp (soft degradation).",
  },
  {
    from: "LIVE",
    to: "DEGRADED",
    roles: ["system", "admin"],
    trigger: ["system", "drift", "operator"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Drift-Alarm im Live — Zustand DEGRADED, Risiko gesenkt.",
  },
  {
    from: "LIVE",
    to: "PAUSED",
    roles: ["system", "admin"],
    trigger: ["system", "drift", "operator", "override"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Live pausieren (harter Halt neuer Einstiege dieser Version).",
  },
  {
    from: "DEGRADED",
    to: "PAUSED",
    roles: ["system", "admin"],
    trigger: ["system", "drift", "operator"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: true,
    targetRiskScale: 0.5,
    description: "Anhaltender Drift — Pause nach abgestufter Degradation.",
  },
  {
    from: "DEGRADED",
    to: "PAPER",
    roles: ["admin", "operator"],
    trigger: ["operator", "override"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Operator-Rollback: degradierte Version zurück nach Paper.",
  },
  {
    from: "DEGRADED",
    to: "LIVE_LIMITED",
    roles: ["admin"],
    trigger: ["recovery", "operator"],
    requiresEvidence: true,
    evidenceKinds: ["RECOVERY", "DRIFT", "PAPER_WINDOW"],
    setsCooldown: false,
    targetRiskScale: 0.5,
    description:
      "Recovery auf begrenztes Live — Cooldown + neue Evidenz + Audit; nie automatisch.",
  },
  {
    from: "DEGRADED",
    to: "REJECTED",
    roles: ["admin", "operator"],
    trigger: ["operator", "system"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Version nach Drift dauerhaft abgelehnt.",
  },
  {
    from: "PAUSED",
    to: "PAPER",
    roles: ["admin", "operator"],
    trigger: ["recovery", "operator", "override"],
    requiresEvidence: true,
    evidenceKinds: ["RECOVERY", "PAPER_WINDOW", "DRIFT"],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Recovery in den Paper-Betrieb — Cooldown + neue Evidenz.",
  },
  {
    from: "PAUSED",
    to: "LIVE_LIMITED",
    roles: ["admin"],
    trigger: ["recovery", "operator"],
    requiresEvidence: true,
    evidenceKinds: ["RECOVERY", "DRIFT", "PAPER_WINDOW"],
    setsCooldown: false,
    targetRiskScale: 0.5,
    description: "Recovery direkt auf begrenztes Live — nur mit neuer Evidenz.",
  },
  {
    from: "PAUSED",
    to: "REJECTED",
    roles: ["admin", "operator"],
    trigger: ["operator", "system"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Pausierte Version dauerhaft abgelehnt.",
  },
  {
    from: "REJECTED",
    to: "DRAFT",
    roles: ["operator", "admin"],
    trigger: ["operator"],
    requiresEvidence: false,
    evidenceKinds: [],
    setsCooldown: false,
    targetRiskScale: 1,
    description: "Neuer Entwurf nach Ablehnung (Rework) — frische Evidenzkette.",
  },
  // Terminaler Default: jede … → sich selbst ist idempotent (Retry-Schutz).
  ...STRATEGY_LIFECYCLE_STATES.map(
    (s): LifecycleTransitionDef => ({
      from: s,
      to: s,
      roles: ["viewer", "operator", "admin", "system"],
      trigger: ["operator", "system", "backtest", "drift", "recovery", "override"],
      requiresEvidence: false,
      evidenceKinds: [],
      setsCooldown: false,
      targetRiskScale: s === "LIVE" || s === "BACKTEST_PASSED" || s === "BACKTEST_PENDING" || s === "DRAFT" ? 1 : s === "PAPER" ? 1 : 0.5,
      description: "Idempotenter No-Op (Retry desselben Übergangs).",
    })
  ),
];

const TRANSITION_INDEX = new Map<string, LifecycleTransitionDef>(
  LIFECYCLE_TRANSITIONS.map((t) => [`${t.from}->${t.to}`, t])
);

export function isStrategyLifecycleState(value: unknown): value is StrategyLifecycleState {
  return (
    typeof value === "string" &&
    (STRATEGY_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

export function transitionDef(
  from: StrategyLifecycleState,
  to: StrategyLifecycleState
): LifecycleTransitionDef | null {
  return TRANSITION_INDEX.get(`${from}->${to}`) ?? null;
}

/** Strukturell erlaubte Kante (ohne Rollen-/Evidenzprüfung). */
export function canTransition(
  from: StrategyLifecycleState,
  to: StrategyLifecycleState
): boolean {
  return TRANSITION_INDEX.has(`${from}->${to}`);
}

/** Alle strukturell erlaubten Ziele aus einem Zustand (ohne sich selbst). */
export function allowedTargets(from: StrategyLifecycleState): StrategyLifecycleState[] {
  return LIFECYCLE_TRANSITIONS.filter((t) => t.from === from && t.to !== from).map(
    (t) => t.to
  );
}

/** Zustände, die neue Einstiege einer Strategieversion erlauben. */
export const LIVE_CAPABLE_STATES: readonly StrategyLifecycleState[] = [
  "LIVE_LIMITED",
  "LIVE",
];

/** Zustände, in denen die Version Risiko gar nicht ausführen darf. */
export const BLOCKED_ORDER_STATES: readonly StrategyLifecycleState[] = [
  "DRAFT",
  "BACKTEST_PENDING",
  "BACKTEST_PASSED",
  "PAPER",
  "DEGRADED",
  "PAUSED",
  "REJECTED",
];

/**
 * Rollen-MINDESTprüfung: `system` und `admin` erfüllen jede Kante;
 * `operator` nur, wenn gelistet; `viewer` nie (reine Leserolle).
 */
export function roleAllowed(
  def: LifecycleTransitionDef,
  role: LifecycleRole
): boolean {
  if (role === "admin" || role === "system") return true;
  return def.roles.includes(role);
}

export function triggerAllowed(
  def: LifecycleTransitionDef,
  trigger: LifecycleTrigger
): boolean {
  return def.trigger.includes(trigger);
}

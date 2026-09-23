/**
 * Strategy-Lifecycle-Service (RMA-P1-05) — persistente State Machine mit
 * Evidenz, Promotion-Gates, Drift-Degradation und Order-Gate-Lesepfad.
 *
 * Persistenz (append-only Migration `drizzle/2026-09-23_strategy_lifecycle.sql`):
 *   - `strategy_lifecycle_states`      aktueller Zustand je Version (Optimistic Lock `state_seq`)
 *   - `strategy_lifecycle_evidence`    immutable Evidence (FK + Hash + Idempotency)
 *   - `strategy_lifecycle_transitions` append-only Transitions (unique `transition_key`)
 *
 * Atomarität: jede Transition läuft in EINER Transaktion mit
 * `SELECT … FOR UPDATE` auf der State-Zeile — parallele Transitions erzeugen
 * genau EINEN Zustand und genau EIN Audit-Eintrag (Idempotenz über
 * `transition_key`).
 */
import { db } from "@/db";
import {
  strategyLifecycleStates,
  strategyLifecycleEvidence,
  strategyLifecycleTransitions,
} from "@/db/schema";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { writeAuditRecord, type AuditWriteOutcome } from "@/lib/auditSink";
import { APP_VERSION } from "@/lib/version";
import { telemetry } from "@/lib/telemetry";
import {
  applyStrategyLifecycleScale,
  strategyLifecyclePauseState,
  type LifecycleRiskState,
} from "@/lib/riskGuard";
import {
  BLOCKED_ORDER_STATES,
  LIVE_CAPABLE_STATES,
  LifecycleTransitionError,
  canTransition,
  isStrategyLifecycleState,
  roleAllowed,
  triggerAllowed,
  transitionDef,
  type LifecycleEvidenceKind,
  type LifecycleRole,
  type LifecycleTrigger,
  type StrategyLifecycleState,
} from "./states";
import {
  DEFAULT_PROMOTION_POLICY,
  evaluateBacktestGate,
  evaluatePaperGate,
  type GateEvaluation,
  type PromotionPolicy,
} from "./policies";
import {
  DEFAULT_DRIFT_POLICY,
  evaluateDrift,
  type DriftEvaluation,
  type DriftPolicy,
  type MetricPair,
} from "./drift";
import {
  evidenceContentHash,
  evidenceIdempotencyKey,
  normalizeStrategyKey,
  normalizeStrategyVersion,
  transitionKey,
  type EvidenceInput,
} from "./evidence";
import {
  lifecycleEnforce,
  lifecycleGatesActive,
  strategyLifecycleConfig,
  type StrategyLifecycleConfig,
  type StrategyLifecycleMode,
} from "./config";
import {
  evaluateLifecycleOrderGate,
  type LifecycleGateDecision,
} from "./orderGate";

// Re-export für Importe, die den Drift-Policy-Default brauchen.
export { DEFAULT_DRIFT_POLICY };

export type LifecycleDbLike = typeof db;
export type LifecycleTx = Parameters<Parameters<LifecycleDbLike["transaction"]>[0]>[0];

export type StateRow = typeof strategyLifecycleStates.$inferSelect;
export type EvidenceRow = typeof strategyLifecycleEvidence.$inferSelect;
export type TransitionRow = typeof strategyLifecycleTransitions.$inferSelect;

export interface LifecycleActor {
  readonly actor: string;
  readonly role: LifecycleRole;
}

export interface TransitionRequest {
  readonly strategyKey: string;
  readonly strategyVersion: number;
  readonly to: StrategyLifecycleState;
  readonly actor: LifecycleActor;
  readonly trigger: LifecycleTrigger;
  readonly reason: string;
  /** Expliziter Idempotency-Key; sonst deterministisch aus Inhalt abgeleitet. */
  readonly transitionKey?: string;
  /** Evidence-ID, die diese Kante stützt (Pflicht wenn requiresEvidence). */
  readonly evidenceId?: string | null;
  readonly nowMs?: number;
  readonly env?: Record<string, string | undefined>;
}

export type TransitionOutcome =
  | {
      readonly ok: true;
      readonly idempotent: boolean;
      readonly state: StateRow;
      readonly transition: TransitionRow | null;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error: string;
      readonly state: StateRow | null;
    };

export interface RecordEvidenceRequest extends EvidenceInput {
  readonly id?: string;
}

function lifecycleAudit(
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: Record<string, unknown>
): Promise<AuditWriteOutcome> {
  return writeAuditRecord({ event, level, detail, auditClass: "security" });
}

function failClosedTelemetry(result: string, code: string): void {
  telemetry.strategyLifecycle.gateDecisions.inc({
    result,
    code: code.slice(0, 48),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lesen
// ─────────────────────────────────────────────────────────────────────────────

export async function getLifecycleState(
  strategyKey: string,
  strategyVersion: number,
  client: LifecycleDbLike | LifecycleTx = db
): Promise<StateRow | null> {
  const rows = await client
    .select()
    .from(strategyLifecycleStates)
    .where(
      and(
        eq(strategyLifecycleStates.strategyKey, strategyKey),
        eq(strategyLifecycleStates.strategyVersion, strategyVersion)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listLifecycleStates(limit = 100): Promise<StateRow[]> {
  return db
    .select()
    .from(strategyLifecycleStates)
    .orderBy(desc(strategyLifecycleStates.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function listEvidence(
  strategyKey: string,
  strategyVersion: number,
  limit = 50
): Promise<EvidenceRow[]> {
  return db
    .select()
    .from(strategyLifecycleEvidence)
    .where(
      and(
        eq(strategyLifecycleEvidence.strategyKey, strategyKey),
        eq(strategyLifecycleEvidence.strategyVersion, strategyVersion)
      )
    )
    .orderBy(desc(strategyLifecycleEvidence.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function listTransitions(
  strategyKey: string,
  strategyVersion: number,
  limit = 100
): Promise<TransitionRow[]> {
  return db
    .select()
    .from(strategyLifecycleTransitions)
    .where(
      and(
        eq(strategyLifecycleTransitions.strategyKey, strategyKey),
        eq(strategyLifecycleTransitions.strategyVersion, strategyVersion)
      )
    )
    .orderBy(desc(strategyLifecycleTransitions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/**
 * Bootstrap/Backfill: legt eine DRAFT-Zeile an, wenn sie fehlt (idempotent).
 * Bestehende Zeilen werden nie überschrieben.
 */
export async function ensureLifecycleDraft(
  strategyKey: string,
  strategyVersion: number,
  actor: LifecycleActor = { actor: "system", role: "system" }
): Promise<StateRow> {
  const key = normalizeStrategyKey(strategyKey);
  const ver = normalizeStrategyVersion(strategyVersion);
  if (!key || ver === null) {
    throw new LifecycleTransitionError(
      "TRANSITION_UNKNOWN",
      "Ungültige Strategie-Identität.",
      null,
      null
    );
  }
  const existing = await getLifecycleState(key, ver);
  if (existing) return existing;

  const [row] = await db
    .insert(strategyLifecycleStates)
    .values({
      strategyKey: key,
      strategyVersion: ver,
      state: "DRAFT",
      stateSeq: 0,
      policyVersion: DEFAULT_PROMOTION_POLICY.version,
      riskScale: "1",
      cooldownUntil: null,
      lastEvidenceId: null,
      ruleKey: null,
      updatedBy: actor.actor,
    })
    .onConflictDoNothing({
      target: [strategyLifecycleStates.strategyKey, strategyLifecycleStates.strategyVersion],
    })
    .returning();

  if (row) {
    await lifecycleAudit("STRATEGY_LIFECYCLE_BOOTSTRAPPED", "INFO", {
      strategyKey: key,
      strategyVersion: ver,
      state: "DRAFT",
      actor: actor.actor,
      role: actor.role,
      policyVersion: DEFAULT_PROMOTION_POLICY.version,
      codeVersion: APP_VERSION,
    });
    return row;
  }
  const raced = await getLifecycleState(key, ver);
  if (!raced) {
    throw new LifecycleTransitionError("STATE_NOT_FOUND", "Bootstrap fehlgeschlagen.", null, null);
  }
  return raced;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schreibt immutable Evidence (idempotent über Content-Hash). Retries/Restarts
 * mit identischem Inhalt liefern die bestehende Zeile zurück.
 */
export async function recordEvidence(
  input: RecordEvidenceRequest
): Promise<{ evidence: EvidenceRow; created: boolean }> {
  const contentHash = evidenceContentHash(input);
  const idemKey = evidenceIdempotencyKey(contentHash);

  const existing = await db
    .select()
    .from(strategyLifecycleEvidence)
    .where(eq(strategyLifecycleEvidence.idempotencyKey, idemKey))
    .limit(1);
  if (existing[0]) return { evidence: existing[0], created: false };

  try {
    const [row] = await db
      .insert(strategyLifecycleEvidence)
      .values({
        strategyKey: input.strategyKey,
        strategyVersion: input.strategyVersion,
        kind: input.kind,
        result: input.result,
        backtestRunId: input.backtestRunId ?? null,
        promptVersion: input.promptVersion ?? null,
        codeVersion: input.codeVersion,
        dataVersion: input.dataVersion ?? null,
        ruleKey: input.ruleKey ?? null,
        policyVersion: input.policyVersion,
        sampleSize: input.snapshot.sampleSize,
        windowStart:
          input.snapshot.windowStartMs !== null
            ? new Date(input.snapshot.windowStartMs)
            : null,
        windowEnd:
          input.snapshot.windowEndMs !== null ? new Date(input.snapshot.windowEndMs) : null,
        metrics: { ...input.snapshot.metrics },
        eventTime: new Date(input.eventTimeMs),
        availableAt: new Date(input.availableAtMs),
        computedAt: new Date(input.computedAtMs),
        contentHash,
        idempotencyKey: idemKey,
        detail: input.detail ? { ...input.detail } : {},
      })
      .returning();

    telemetry.strategyLifecycle.evidence.inc({ kind: input.kind, result: input.result });
    await lifecycleAudit("STRATEGY_LIFECYCLE_EVIDENCE_RECORDED", "INFO", {
      strategyKey: input.strategyKey,
      strategyVersion: input.strategyVersion,
      kind: input.kind,
      result: input.result,
      contentHash,
      sampleSize: input.snapshot.sampleSize,
      policyVersion: input.policyVersion,
      backtestRunId: input.backtestRunId ?? null,
      eventTime: new Date(input.eventTimeMs).toISOString(),
      availableAt: new Date(input.availableAtMs).toISOString(),
      computedAt: new Date(input.computedAtMs).toISOString(),
    });
    return { evidence: row, created: true };
  } catch (e) {
    // Paralleler identischer Write (unique idempotency_key) → vorhandene Zeile.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
      const again = await db
        .select()
        .from(strategyLifecycleEvidence)
        .where(eq(strategyLifecycleEvidence.idempotencyKey, idemKey))
        .limit(1);
      if (again[0]) return { evidence: again[0], created: false };
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotion-Gates (Evaluation gegen Evidence)
// ─────────────────────────────────────────────────────────────────────────────

export interface PromotionGateInput {
  readonly strategyKey: string;
  readonly strategyVersion: number;
  readonly target: StrategyLifecycleState;
  readonly policy?: PromotionPolicy;
  readonly nowMs?: number;
}

export interface PromotionGateResult {
  readonly ok: boolean;
  readonly policyVersion: string;
  readonly evaluations: readonly GateEvaluation[];
  readonly missingEvidence: readonly LifecycleEvidenceKind[];
  readonly detail: string;
}

/**
 * Bewertet die für `target` erforderlichen Evidence-Arten. Fehlende/stale/
 * unzureichende Evidenz ⇒ ok=false (fail-closed).
 */
export async function evaluatePromotionGate(
  input: PromotionGateInput
): Promise<PromotionGateResult> {
  const policy = input.policy ?? DEFAULT_PROMOTION_POLICY;
  const nowMs = input.nowMs ?? Date.now();
  const def = transitionDef(
    input.target === "LIVE_LIMITED" ? "PAPER" : input.target === "LIVE" ? "LIVE_LIMITED" : input.target === "BACKTEST_PASSED" ? "BACKTEST_PENDING" : input.target,
    input.target
  );
  // Erforderliche Kanten-Evidenz aus der Transitions-Tabelle ableiten
  const requiredKinds: LifecycleEvidenceKind[] = [];
  if (input.target === "BACKTEST_PASSED") requiredKinds.push("BACKTEST_RUN");
  if (input.target === "PAPER") requiredKinds.push("BACKTEST_RUN");
  if (input.target === "LIVE_LIMITED") requiredKinds.push("BACKTEST_RUN", "PAPER_WINDOW");
  if (input.target === "LIVE") requiredKinds.push("PAPER_WINDOW", "DRIFT");

  const rows = await listEvidence(input.strategyKey, input.strategyVersion, 200);
  const evaluations: GateEvaluation[] = [];
  const missing: LifecycleEvidenceKind[] = [];

  for (const kind of requiredKinds) {
    const candidates = rows.filter((r) => r.kind === kind);
    const freshest = candidates.sort(
      (a, b) => b.availableAt.getTime() - a.availableAt.getTime()
    )[0];
    if (!freshest) {
      missing.push(kind);
      evaluations.push({
        ok: false,
        policyVersion: policy.version,
        checks: [
          {
            id: `evidence.${kind}`,
            status: "MISSING",
            message: `Keine ${kind}-Evidenz persistiert.`,
            observed: null,
            required: null,
          },
        ],
      });
      continue;
    }

    const metrics = (freshest.metrics ?? {}) as Record<string, unknown>;
    const num = (k: string): number | null => {
      const v = metrics[k];
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    if (kind === "BACKTEST_RUN") {
      const gate = evaluateBacktestGate(
        {
          windowStartMs: freshest.windowStart ? freshest.windowStart.getTime() : null,
          windowEndMs: freshest.windowEnd ? freshest.windowEnd.getTime() : null,
          availableAtMs: freshest.availableAt.getTime(),
          trades: freshest.sampleSize,
          winRate: num("winRate"),
          profitFactor: num("profitFactor"),
          maxDrawdownPct: num("maxDrawdownPct"),
          dataQualityScore: num("dataQualityScore"),
        },
        policy,
        nowMs
      );
      evaluations.push(gate);
      if (!gate.ok) missing.push(kind);
    } else if (kind === "PAPER_WINDOW") {
      const reconCleanRaw = metrics.reconClean;
      const gate = evaluatePaperGate(
        {
          windowStartMs: freshest.windowStart ? freshest.windowStart.getTime() : null,
          windowEndMs: freshest.windowEnd ? freshest.windowEnd.getTime() : null,
          availableAtMs: freshest.availableAt.getTime(),
          trades: freshest.sampleSize,
          reconClean:
            reconCleanRaw === null || reconCleanRaw === undefined
              ? null
              : reconCleanRaw === true || Number(reconCleanRaw) === 1,
          reconAtMs: num("reconAtMs"),
          avgSlippageBps: num("avgSlippageBps"),
        },
        policy,
        nowMs
      );
      evaluations.push(gate);
      if (!gate.ok) missing.push(kind);
    } else {
      // DRIFT: Evidence muss PASS und frisch sein
      const ageOk =
        nowMs - freshest.availableAt.getTime() <= policy.paperEvidenceMaxAgeMs &&
        freshest.result === "PASS";
      evaluations.push({
        ok: ageOk,
        policyVersion: policy.version,
        checks: [
          {
            id: `evidence.${kind}`,
            status: ageOk ? "PASS" : freshest.result === "FAIL" ? "FAIL" : "STALE",
            message: ageOk
              ? `${kind}-Evidenz PASS und frisch.`
              : `${kind}-Evidenz result=${freshest.result} oder stale.`,
            observed: 1,
            required: 1,
          },
        ],
      });
      if (!ageOk) missing.push(kind);
    }
  }

  const ok = evaluations.length > 0 && evaluations.every((e) => e.ok) && missing.length === 0;
  void def;
  return {
    ok,
    policyVersion: policy.version,
    evaluations,
    missingEvidence: missing,
    detail: ok
      ? `Promotion-Gate bestanden (Policy ${policy.version}).`
      : `Promotion-Gate blockiert: ${[...new Set(missing)].join(",") || "Evaluation fehlgeschlagen"}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions (atomar, idempotent)
// ─────────────────────────────────────────────────────────────────────────────

const LIFECYCLE_TARGET_SCALE: Record<StrategyLifecycleState, number> = {
  DRAFT: 1,
  BACKTEST_PENDING: 1,
  BACKTEST_PASSED: 1,
  PAPER: 1,
  LIVE_LIMITED: 0.5,
  LIVE: 1,
  DEGRADED: 0.5,
  PAUSED: 0.5,
  REJECTED: 1,
};

/** Risikofaktor der Ziel-Zeile: Degradation senkt nie unter minFactor, nie über 1. */
export function targetRiskScaleFor(
  to: StrategyLifecycleState,
  cfg: StrategyLifecycleConfig
): number {
  const raw = LIFECYCLE_TARGET_SCALE[to] ?? 1;
  return Math.min(Math.max(raw, cfg.minRiskFactor), 1);
}

/**
 * Führt eine Transition atomar aus.
 *
 * - Ermittl Kante + Rolle + Trigger + Evidenzpflicht.
 * - Prüft Recovery-Cooldown (nur Recovery-Kanten).
 * - Prüft Promotion-Gates (Ziele BACKTEST_PASSED/PAPER/LIVE_LIMITED/LIVE).
 * - SELECT … FOR UPDATE → idempotenter Key → Update + Transition-Zeile.
 * - Wendet den Risikofaktor über riskGuard an (nur senkend außer Recovery).
 */
export async function requestTransition(req: TransitionRequest): Promise<TransitionOutcome> {
  const cfg = strategyLifecycleConfig(req.env);
  const nowMs = req.nowMs ?? Date.now();
  const key = normalizeStrategyKey(req.strategyKey);
  const ver = normalizeStrategyVersion(req.strategyVersion);
  if (!key || ver === null) {
    return {
      ok: false,
      code: "TRANSITION_UNKNOWN",
      error: "Ungültige Strategie-Identität (key/version).",
      state: null,
    };
  }
  if (!isStrategyLifecycleState(req.to)) {
    return {
      ok: false,
      code: "TRANSITION_UNKNOWN",
      error: `Unbekannter Zielzustand ${String(req.to).slice(0, 32)}.`,
      state: null,
    };
  }

  const nonceRaw = `${req.trigger}|${req.reason}|${req.evidenceId ?? ""}`;
  const tKey =
    req.transitionKey ??
    transitionKey({
      strategyKey: key,
      strategyVersion: ver,
      from: "*",
      to: req.to,
      nonce: nonceRaw,
    });

  // Schnellpfad: identischer Key bereits ausgeführt?
  const replay = await db
    .select()
    .from(strategyLifecycleTransitions)
    .where(eq(strategyLifecycleTransitions.transitionKey, tKey))
    .limit(1);
  if (replay[0]) {
    const st = await getLifecycleState(key, ver);
    telemetry.strategyLifecycle.transitions.inc({ result: "idempotent", to: req.to });
    if (st) {
      return {
        ok: true,
        idempotent: true,
        state: st,
        transition: replay[0],
        detail: "IDEMPOTENT: Transition bereits ausgeführt.",
      };
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(strategyLifecycleStates)
        .where(
          and(
            eq(strategyLifecycleStates.strategyKey, key),
            eq(strategyLifecycleStates.strategyVersion, ver)
          )
        )
        .for("update")
        .limit(1);
      const current = rows[0];
      if (!current) {
        return {
          ok: false as const,
          code: "STATE_NOT_FOUND",
          error: `Kein Lifecycle-Zustand für ${key}@v${ver}.`,
          state: null as StateRow | null,
        };
      }

      // Erneuter Idempotenz-Check innerhalb der Transaktion
      const replayInTx = await tx
        .select()
        .from(strategyLifecycleTransitions)
        .where(eq(strategyLifecycleTransitions.transitionKey, tKey))
        .limit(1);
      if (replayInTx[0]) {
        return {
          ok: true as const,
          idempotent: true as const,
          state: current,
          transition: replayInTx[0],
          detail: "IDEMPOTENT: paralleler Retry bereits committed.",
        };
      }

      const from = current.state;
      if (from === req.to && !canTransition(from, req.to)) {
        // unreachable: Self-Edges existieren, aber Vorsicht
      }
      if (from === req.to) {
        // Self-Transition: als idempotenten No-Op zurückgeben, KEINE neue Zeile.
        return {
          ok: true as const,
          idempotent: true as const,
          state: current,
          transition: null,
          detail: `IDEMPOTENT: bereits in ${from}.`,
        };
      }

      const def = transitionDef(from as StrategyLifecycleState, req.to);
      if (!def || !canTransition(from as StrategyLifecycleState, req.to)) {
        telemetry.strategyLifecycle.transitions.inc({ result: "forbidden", to: req.to });
        return {
          ok: false as const,
          code: "TRANSITION_FORBIDDEN",
          error: `Übergang ${from} → ${req.to} ist nicht erlaubt.`,
          state: current,
        };
      }

      if (!roleAllowed(def, req.actor.role)) {
        telemetry.strategyLifecycle.transitions.inc({ result: "role", to: req.to });
        return {
          ok: false as const,
          code: "ROLE_NOT_ALLOWED",
          error: `Rolle ${req.actor.role} darf ${from} → ${req.to} nicht auslösen.`,
          state: current,
        };
      }

      if (!triggerAllowed(def, req.trigger)) {
        telemetry.strategyLifecycle.transitions.inc({ result: "trigger", to: req.to });
        return {
          ok: false as const,
          code: "TRANSITION_FORBIDDEN",
          error: `Trigger ${req.trigger} ist für ${from} → ${req.to} nicht erlaubt.`,
          state: current,
        };
      }

      // Recovery-Cooldown prüfen
      const isRecovery = req.trigger === "recovery" || def.trigger.includes("recovery");
      const promoting =
        req.to === "BACKTEST_PASSED" ||
        req.to === "PAPER" ||
        req.to === "LIVE_LIMITED" ||
        req.to === "LIVE";
      if (
        promoting &&
        current.cooldownUntil !== null &&
        current.cooldownUntil.getTime() > nowMs &&
        (isRecovery || req.to === "LIVE_LIMITED" || req.to === "LIVE")
      ) {
        // Cooldown gilt für Live-Promotion und Recovery; frische Operator-
        // Demotion nach PAPER darf nicht blockiert werden (kein promoting to live).
        if (req.to === "LIVE_LIMITED" || req.to === "LIVE" || isRecovery) {
          telemetry.strategyLifecycle.transitions.inc({ result: "cooldown", to: req.to });
          return {
            ok: false as const,
            code: "COOLDOWN_ACTIVE",
            error: `Recovery-Cooldown aktiv bis ${current.cooldownUntil.toISOString()}.`,
            state: current,
          };
        }
      }

      // Evidenzpflicht
      let evidenceRow: EvidenceRow | null = null;
      if (def.requiresEvidence) {
        if (!req.evidenceId) {
          // Promotion-Gate gegen persistierte Evidence prüfen
          if (
            req.to === "BACKTEST_PASSED" ||
            req.to === "PAPER" ||
            req.to === "LIVE_LIMITED" ||
            req.to === "LIVE"
          ) {
            const gate = await evaluatePromotionGate({
              strategyKey: key,
              strategyVersion: ver,
              target: req.to,
              nowMs,
            });
            if (!gate.ok) {
              telemetry.strategyLifecycle.transitions.inc({ result: "gate", to: req.to });
              await lifecycleAudit("STRATEGY_LIFECYCLE_PROMOTION_BLOCKED", "WARN", {
                strategyKey: key,
                strategyVersion: ver,
                from,
                to: req.to,
                reason: gate.detail,
                missingEvidence: gate.missingEvidence,
                policyVersion: gate.policyVersion,
                actor: req.actor.actor,
                role: req.actor.role,
                codeVersion: APP_VERSION,
              });
              return {
                ok: false as const,
                code: "EVIDENCE_REQUIRED",
                error: gate.detail,
                state: current,
              };
            }
          } else {
            return {
              ok: false as const,
              code: "EVIDENCE_REQUIRED",
              error: `Kante ${from} → ${req.to} erfordert eine Evidence-ID.`,
              state: current,
            };
          }
        } else {
          const evRows = await tx
            .select()
            .from(strategyLifecycleEvidence)
            .where(eq(strategyLifecycleEvidence.id, req.evidenceId))
            .limit(1);
          evidenceRow = evRows[0] ?? null;
          if (!evidenceRow) {
            return {
              ok: false as const,
              code: "EVIDENCE_REQUIRED",
              error: `Evidence ${req.evidenceId} nicht gefunden.`,
              state: current,
            };
          }
          if (
            evidenceRow.strategyKey !== key ||
            evidenceRow.strategyVersion !== ver
          ) {
            return {
              ok: false as const,
              code: "EVIDENCE_KIND_MISMATCH",
              error: "Evidence gehört zu einer anderen Strategieversion.",
              state: current,
            };
          }
          if (
            def.evidenceKinds.length > 0 &&
            !def.evidenceKinds.includes(evidenceRow.kind as LifecycleEvidenceKind)
          ) {
            return {
              ok: false as const,
              code: "EVIDENCE_KIND_MISMATCH",
              error: `Evidence-Art ${evidenceRow.kind} stützt diese Kante nicht.`,
              state: current,
            };
          }
          // Frische der explizit übergebenen Evidence
          const maxAge = DEFAULT_PROMOTION_POLICY.backtestEvidenceMaxAgeMs;
          if (nowMs - evidenceRow.availableAt.getTime() > maxAge) {
            return {
              ok: false as const,
              code: "EVIDENCE_STALE",
              error: "Evidence ist stale — Promotion fail-closed blockiert.",
              state: current,
            };
          }
        }
      }

      // Risikofaktor: Degradation senkt; Recovery/Kanten mit target 1 heben nur
      // in ausdrücklich erlaubten Recovery-/Vorwärtskanten an und nie über 1.
      const defScale = LIFECYCLE_TARGET_SCALE[req.to] ?? 1;
      let nextScale: number;
      if (defScale >= 1) {
        nextScale = 1;
      } else {
        const prev = Number(current.riskScale ?? "1");
        const capped = Math.min(Math.max(defScale, cfg.minRiskFactor), 1);
        // Senken erlaubt; Anheben nur wenn vorher bereits niedriger (nie risikoerhöhend
        // außer explizite Recovery-Kanten, die ohnehin target 1 haben).
        nextScale = Math.min(capped, Number.isFinite(prev) && prev > 0 ? Math.max(capped, Math.min(prev, 1)) : capped);
        nextScale = Math.min(Math.max(nextScale, cfg.minRiskFactor), 1);
        if (Number.isFinite(prev) && prev > 0 && prev < nextScale && !promoting) {
          nextScale = prev; // Degradation/Seitwärts: niemals anheben
        }
      }

      const cooldownUntil = def.setsCooldown
        ? new Date(nowMs + cfg.recoveryCooldownMs)
        : current.cooldownUntil;

      const [updated] = await tx
        .update(strategyLifecycleStates)
        .set({
          state: req.to,
          stateSeq: current.stateSeq + 1,
          policyVersion: DEFAULT_PROMOTION_POLICY.version,
          riskScale: String(nextScale),
          cooldownUntil,
          lastEvidenceId: evidenceRow?.id ?? current.lastEvidenceId,
          updatedBy: req.actor.actor,
          updatedAt: new Date(nowMs),
        })
        .where(
          and(
            eq(strategyLifecycleStates.id, current.id),
            eq(strategyLifecycleStates.stateSeq, current.stateSeq)
          )
        )
        .returning();

      if (!updated) {
        return {
          ok: false as const,
          code: "SEQ_CONFLICT",
          error: "Optimistic Lock verletzt — parallele Transition gewann.",
          state: current,
        };
      }

      const [trans] = await tx
        .insert(strategyLifecycleTransitions)
        .values({
          stateId: updated.id,
          strategyKey: key,
          strategyVersion: ver,
          fromState: from,
          toState: req.to,
          transitionKey: tKey,
          trigger: req.trigger,
          actor: req.actor.actor,
          actorRole: req.actor.role,
          reason: req.reason.slice(0, 500),
          evidenceId: evidenceRow?.id ?? req.evidenceId ?? null,
          policyVersion: DEFAULT_PROMOTION_POLICY.version,
          riskScale: String(nextScale),
          seqBefore: current.stateSeq,
          seqAfter: updated.stateSeq,
        })
        .returning();

      return {
        ok: true as const,
        idempotent: false as const,
        state: updated,
        transition: trans,
        detail: `${from} → ${req.to} (seq ${updated.stateSeq}, riskScale ${nextScale}).`,
      };
    });

    if (!result.ok) {
      await lifecycleAudit("STRATEGY_LIFECYCLE_TRANSITION_DENIED", "WARN", {
        strategyKey: key,
        strategyVersion: ver,
        to: req.to,
        code: result.code,
        error: result.error,
        actor: req.actor.actor,
        role: req.actor.role,
        trigger: req.trigger,
        reason: req.reason.slice(0, 200),
        codeVersion: APP_VERSION,
      });
      failClosedTelemetry("denied", result.code);
      return { ...result, state: result.state };
    }

    // Risikofaktor + Pause-Veto in die Authority Chain einspeisen
    applyLifecycleFromState(result.state, cfg);

    telemetry.strategyLifecycle.transitions.inc({
      result: result.idempotent ? "idempotent" : "applied",
      to: req.to,
    });

    if (!result.idempotent && result.transition) {
      await lifecycleAudit(
        result.state.state === "LIVE" || result.state.state === "LIVE_LIMITED"
          ? "STRATEGY_LIFECYCLE_PROMOTED"
          : result.state.state === "DEGRADED" || result.state.state === "PAUSED"
            ? "STRATEGY_LIFECYCLE_DEGRADED"
            : "STRATEGY_LIFECYCLE_TRANSITION",
        result.state.state === "DEGRADED" || result.state.state === "PAUSED"
          ? "WARN"
          : result.state.state === "REJECTED"
            ? "WARN"
            : "INFO",
        {
          strategyKey: key,
          strategyVersion: ver,
          from: result.transition.fromState,
          to: result.state.state,
          transitionKey: result.transition.transitionKey,
          trigger: req.trigger,
          actor: req.actor.actor,
          role: req.actor.role,
          reason: req.reason.slice(0, 300),
          evidenceId: result.transition.evidenceId,
          policyVersion: result.transition.policyVersion,
          riskScale: result.transition.riskScale,
          codeVersion: APP_VERSION,
        }
      );
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
      const again = await db
        .select()
        .from(strategyLifecycleTransitions)
        .where(eq(strategyLifecycleTransitions.transitionKey, tKey))
        .limit(1);
      const st = await getLifecycleState(key, ver);
      if (again[0] && st) {
        telemetry.strategyLifecycle.transitions.inc({ result: "idempotent", to: req.to });
        return {
          ok: true,
          idempotent: true,
          state: st,
          transition: again[0],
          detail: "IDEMPOTENT: unique-Key-Konflikt zeigt bereits ausgeführte Transition.",
        };
      }
    }
    console.error("[strategy-lifecycle] Transition fehlgeschlagen:", msg);
    failClosedTelemetry("error", "LIFECYCLE_ERROR");
    return {
      ok: false,
      code: "LIFECYCLE_ERROR",
      error: msg.slice(0, 300),
      state: null,
    };
  }
}

function applyLifecycleFromState(row: StateRow, cfg: StrategyLifecycleConfig): void {
  const scale = Number(row.riskScale);
  const paused =
    row.state === "PAUSED" ||
    row.state === "DEGRADED" ||
    row.state === "REJECTED" ||
    BLOCKED_ORDER_STATES.includes(row.state as StrategyLifecycleState) &&
      (row.state === "PAUSED" || row.state === "DEGRADED" || row.state === "REJECTED");
  const snapshot: LifecycleRiskState = {
    factor: Number.isFinite(scale) && scale > 0 ? Math.min(Math.max(scale, cfg.minRiskFactor), 1) : cfg.minRiskFactor,
    paused: row.state === "PAUSED" || row.state === "REJECTED",
    at: row.updatedAt.toISOString(),
    reason: `lifecycle:${row.state}`,
    mode: lifecycleGatesActive(cfg.mode) && cfg.mode !== "off" ? "active" : "monitor",
    policyVersion: row.policyVersion,
    state: row.state,
  };
  void paused;
  applyStrategyLifecycleScale(snapshot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift-Bewertung + automatische Degradation
// ─────────────────────────────────────────────────────────────────────────────

export interface DriftCheckRequest {
  readonly strategyKey: string;
  readonly strategyVersion: number;
  readonly pairs: readonly MetricPair[];
  readonly actor?: LifecycleActor;
  readonly nowMs?: number;
  readonly policy?: DriftPolicy;
  readonly env?: Record<string, string | undefined>;
}

export interface DriftCheckResult {
  readonly evaluation: DriftEvaluation;
  readonly transition: TransitionOutcome | null;
  readonly appliedAction: "NONE" | "SCALE_DOWN" | "DEGRADE" | "PAUSE" | "SKIPPED";
}

/**
 * Bewertet Drift und wendet die abgestufte Reaktion an:
 *   SCALE_DOWN → LIVE→LIVE_LIMITED (bzw. Verbleib mit gesenktem Faktor)
 *   DEGRADE    → …→DEGRADED
 *   PAUSE      → …→PAUSED
 * Idempotent: bereits im Zielzustand ⇒ kein zweites Audit/kein zweiter Zustand.
 * `monitor`/`off` bewerten nur (keine Zustandsänderung), außer `enforce`.
 */
export async function checkAndDegrade(
  req: DriftCheckRequest
): Promise<DriftCheckResult> {
  const cfg = strategyLifecycleConfig(req.env);
  const nowMs = req.nowMs ?? Date.now();
  const policy = req.policy ?? DEFAULT_DRIFT_POLICY;
  const evaluation = evaluateDrift(req.pairs, {
    ...policy,
    minSample: Math.max(policy.minSample, DEFAULT_PROMOTION_POLICY.driftMinSample),
  }, nowMs);

  const actor = req.actor ?? { actor: "system:drift", role: "system" as const };
  const st = await getLifecycleState(req.strategyKey, req.strategyVersion);
  if (!st || !isStrategyLifecycleState(st.state)) {
    return { evaluation, transition: null, appliedAction: "SKIPPED" };
  }

  telemetry.strategyLifecycle.driftChecks.inc({
    verdict: evaluation.verdict,
    action: evaluation.recommendedAction,
  });

  // Kein Eingriff außerhalb von Live/Paper-Zuständen (Draft-Pfade unberührt).
  const liveLike: StrategyLifecycleState[] = ["LIVE", "LIVE_LIMITED", "PAPER", "DEGRADED"];
  if (!liveLike.includes(st.state as StrategyLifecycleState)) {
    return { evaluation, transition: null, appliedAction: "SKIPPED" };
  }
  if (evaluation.recommendedAction === "NONE") {
    return { evaluation, transition: null, appliedAction: "NONE" };
  }
  if (cfg.mode !== "enforce") {
    // monitor/off: Audit ohne Zustandswechsel
    await lifecycleAudit("STRATEGY_LIFECYCLE_DRIFT_OBSERVED", "WARN", {
      strategyKey: req.strategyKey,
      strategyVersion: req.strategyVersion,
      state: st.state,
      verdict: evaluation.verdict,
      recommendedAction: evaluation.recommendedAction,
      confidence: evaluation.confidence,
      policyVersion: evaluation.policyVersion,
      mode: cfg.mode,
      segments: evaluation.segments.map((s) => ({
        segment: s.segment,
        verdict: s.verdict,
        breached: s.breachedKeys,
        inconclusive: s.inconclusiveKeys,
      })),
      codeVersion: APP_VERSION,
      applied: false,
    });
    return { evaluation, transition: null, appliedAction: "SKIPPED" };
  }

  const action = evaluation.recommendedAction;
  let target: StrategyLifecycleState | null = null;
  if (action === "PAUSE") target = "PAUSED";
  else if (action === "DEGRADE") target = st.state === "DEGRADED" ? null : "DEGRADED";
  else if (action === "SCALE_DOWN") {
    if (st.state === "LIVE") target = "LIVE_LIMITED";
    else if (st.state === "PAPER" || st.state === "DEGRADED") target = st.state === "DEGRADED" ? "DEGRADED" : "DEGRADED";
    else target = null; // bereits LIVE_LIMITED — Faktor bleibt
  }

  if (target === null || target === st.state) {
    // Idempotent: Zustand passt bereits — Audit einmal pro Aufruf, kein Zustandswechsel.
    await lifecycleAudit("STRATEGY_LIFECYCLE_DRIFT_OBSERVED", "WARN", {
      strategyKey: req.strategyKey,
      strategyVersion: req.strategyVersion,
      state: st.state,
      verdict: evaluation.verdict,
      recommendedAction: action,
      confidence: evaluation.confidence,
      policyVersion: evaluation.policyVersion,
      mode: cfg.mode,
      codeVersion: APP_VERSION,
      applied: false,
      reason: "already-in-target-state",
    });
    return { evaluation, transition: null, appliedAction: action };
  }

  const nonce = `drift|${evaluation.verdict}|${action}|${evaluation.evaluatedAtMs}`;
  const tKey = transitionKey({
    strategyKey: req.strategyKey,
    strategyVersion: req.strategyVersion,
    from: st.state,
    to: target,
    nonce,
  });

  const transition = await requestTransition({
    strategyKey: req.strategyKey,
    strategyVersion: req.strategyVersion,
    to: target,
    actor,
    trigger: "drift",
    reason: `Drift ${evaluation.verdict} → ${action} (Confidence ${evaluation.confidence.toFixed(2)}).`,
    transitionKey: tKey,
    nowMs,
    env: req.env,
  });

  return {
    evaluation,
    transition,
    appliedAction: transition.ok ? (transition.idempotent ? "SKIPPED" : action) : "SKIPPED",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-Gate (DB-Lesepfad)
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthorizeLiveOrderRequest {
  readonly strategyKey: string | null;
  readonly strategyVersion: number | null;
  readonly nowMs?: number;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Liest den Lifecycle-Zustand und bewertet den Order-Gate pure.
 * Bei `enforce` + Deny wird zusätzlich ein Audit-Ereignis geschrieben.
 */
export async function authorizeLiveOrder(
  req: AuthorizeLiveOrderRequest
): Promise<LifecycleGateDecision> {
  const cfg = strategyLifecycleConfig(req.env);
  const nowMs = req.nowMs ?? Date.now();
  const key = req.strategyKey !== null ? normalizeStrategyKey(req.strategyKey) : null;
  const ver =
    req.strategyVersion !== null ? normalizeStrategyVersion(req.strategyVersion) : null;

  let state: {
    state: string;
    riskScale: number | null;
    cooldownUntilMs: number | null;
    lastEvidenceAvailableAtMs: number | null;
    stateSeq: number;
  } | null = null;

  // `off` = kein DB-Lesepfad nötig (Default, vollständig rückwärtskompatibel).
  if (key && ver !== null && lifecycleGatesActive(cfg.mode)) {
    try {
      const row = await getLifecycleState(key, ver);
      if (row) {
        state = {
          state: row.state,
          riskScale: Number(row.riskScale),
          cooldownUntilMs: row.cooldownUntil ? row.cooldownUntil.getTime() : null,
          lastEvidenceAvailableAtMs: row.lastEvidenceId
            ? await evidenceAvailableAt(row.lastEvidenceId)
            : null,
          stateSeq: row.stateSeq,
        };
      }
    } catch (e) {
      console.error(
        "[strategy-lifecycle] Order-Gate-Lesefehler:",
        e instanceof Error ? e.message : e
      );
      const deny = lifecycleEnforce(cfg.mode);
      const decision = evaluateLifecycleOrderGate({
        mode: cfg.mode,
        strategyKey: key,
        strategyVersion: ver,
        state: null,
        nowMs,
      });
      failClosedTelemetry(deny ? "error_deny" : "error", "LIFECYCLE_ERROR");
      return {
        ...decision,
        allowed: !deny,
        blocked: deny,
        code: deny ? "LIFECYCLE_ERROR" : decision.code,
        reason: deny
          ? "LIFECYCLE_ERROR: Zustand nicht lesbar — fail-closed."
          : decision.reason,
      };
    }
  }

  const decision = evaluateLifecycleOrderGate({
    mode: cfg.mode,
    strategyKey: key,
    strategyVersion: ver,
    state,
    nowMs,
  });

  failClosedTelemetry(
    decision.allowed ? "allow" : "deny",
    decision.code
  );

  if (lifecycleGatesActive(cfg.mode) && !decision.allowed && decision.blocked) {
    await lifecycleAudit("STRATEGY_LIFECYCLE_ORDER_DENIED", "WARN", {
      strategyKey: key,
      strategyVersion: ver,
      lifecycleState: decision.lifecycleState,
      code: decision.code,
      reason: decision.reason.slice(0, 300),
      mode: cfg.mode,
      riskScale: decision.riskScale,
      policyVersion: decision.policyVersion,
      codeVersion: APP_VERSION,
    });
  }

  return decision;
}

async function evidenceAvailableAt(id: string): Promise<number | null> {
  const rows = await db
    .select({ availableAt: strategyLifecycleEvidence.availableAt })
    .from(strategyLifecycleEvidence)
    .where(eq(strategyLifecycleEvidence.id, id))
    .limit(1);
  return rows[0]?.availableAt.getTime() ?? null;
}

/** Risiko-Pause der Version in die riskGuard-Authority-Chain spiegeln. */
export function refreshLifecycleRiskFromStates(
  states: readonly StateRow[],
  cfg: StrategyLifecycleConfig = strategyLifecycleConfig()
): void {
  if (states.length === 0) {
    applyStrategyLifecycleScale(null);
    return;
  }
  // Aggregation: der schärfste (kleinste) Faktor gewinnt — Risiko steigt nie.
  let factor = 1;
  let paused = false;
  let reason = "lifecycle:aggregate";
  let stateName = "DRAFT";
  for (const row of states) {
    const f = Number(row.riskScale);
    if (Number.isFinite(f) && f > 0) factor = Math.min(factor, f);
    if (row.state === "PAUSED" || row.state === "REJECTED") paused = true;
    if (
      row.state === "DEGRADED" ||
      row.state === "PAUSED" ||
      row.state === "LIVE" ||
      row.state === "LIVE_LIMITED"
    ) {
      stateName = row.state;
      reason = `lifecycle:${row.state}`;
    }
  }
  applyStrategyLifecycleScale({
    factor: Math.min(Math.max(factor, cfg.minRiskFactor), 1),
    paused,
    at: new Date().toISOString(),
    reason,
    mode: cfg.mode === "enforce" ? "active" : "monitor",
    policyVersion: DEFAULT_PROMOTION_POLICY.version,
    state: stateName,
  });
}

/** Status-Projektion für Read-API. */
export interface LifecycleStatusDto {
  readonly strategyKey: string;
  readonly strategyVersion: number;
  readonly state: StrategyLifecycleState;
  readonly stateSeq: number;
  readonly riskScale: number;
  readonly cooldownUntil: string | null;
  readonly policyVersion: string;
  readonly liveAuthorized: boolean;
  readonly pauseBlocked: boolean;
  readonly updatedAt: string;
  readonly lastEvidence: {
    readonly id: string;
    readonly kind: string;
    readonly result: string;
    readonly availableAt: string;
  } | null;
}

export async function getLifecycleStatus(
  strategyKey: string,
  strategyVersion: number
): Promise<LifecycleStatusDto | null> {
  const row = await getLifecycleState(strategyKey, strategyVersion);
  if (!row) return null;
  const nowMs = Date.now();
  let lastEvidence: LifecycleStatusDto["lastEvidence"] = null;
  if (row.lastEvidenceId) {
    const ev = await db
      .select()
      .from(strategyLifecycleEvidence)
      .where(eq(strategyLifecycleEvidence.id, row.lastEvidenceId))
      .limit(1);
    if (ev[0]) {
      lastEvidence = {
        id: ev[0].id,
        kind: ev[0].kind,
        result: ev[0].result,
        availableAt: ev[0].availableAt.toISOString(),
      };
    }
  }
  const cfg = strategyLifecycleConfig();
  const gate = evaluateLifecycleOrderGate({
    mode: cfg.mode === "off" ? "enforce" : cfg.mode, // Status zeigt strukturelle Fähigkeit
    strategyKey,
    strategyVersion,
    state: {
      state: row.state,
      riskScale: Number(row.riskScale),
      cooldownUntilMs: row.cooldownUntil ? row.cooldownUntil.getTime() : null,
      lastEvidenceAvailableAtMs: lastEvidence ? Date.parse(lastEvidence.availableAt) : null,
      stateSeq: row.stateSeq,
    },
    nowMs,
  });

  return {
    strategyKey: row.strategyKey,
    strategyVersion: row.strategyVersion,
    state: row.state as StrategyLifecycleState,
    stateSeq: row.stateSeq,
    riskScale: Number(row.riskScale),
    cooldownUntil: row.cooldownUntil ? row.cooldownUntil.toISOString() : null,
    policyVersion: row.policyVersion,
    liveAuthorized: LIVE_CAPABLE_STATES.includes(row.state as StrategyLifecycleState) && gate.allowed,
    pauseBlocked: strategyLifecyclePauseState().blocked || row.state === "PAUSED",
    updatedAt: row.updatedAt.toISOString(),
    lastEvidence,
  };
}

export type { StrategyLifecycleMode, PromotionPolicy, DriftPolicy };

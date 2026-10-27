/**
 * Strategy-Lifecycle API (RMA-P1-05, v1.73.0; gehärtet ASA-02).
 *
 * GET  /api/firm/lifecycle?strategy=<key>&version=<n>  — Status + Evidence/Transitions
 * GET  /api/firm/lifecycle                            — alle Zustände (limitiert)
 * POST /api/firm/lifecycle                            — ensure | evidence | transition
 *                                                       | propose | approve
 *
 * ASA-02 — Autorisierung (ausschließlich serverseitig verifiziert):
 *   - `resolveAuth(req)` ist die EINZIGE Quelle für Rolle und Identität.
 *     `auth.principal.role === "admin"` ⇒ admin, sonst operator. Der frühere
 *     `x-admin-token`-Header-Existenzcheck (Rollen-Spoofing) ist restlos
 *     entfernt; `actorAuditId(auth.principal)` liefert den Audit-Akteur.
 *   - `requirePermission(req, "firm.write")` (mindestens) + CSRF + Rate-Limit.
 *     Admin-Kanten (`LIVE_LIMITED`, `LIVE`) werden zusätzlich vor dem Service
 *     mit 403 für Nicht-Administratoren abgewiesen.
 *   - Vier-Augen-pflichtige Live-Promotions laufen über ZWEI Requests zweier
 *     getrennter, authentifizierter Principals (`propose` → `approve`), siehe
 *     `src/lib/fourEyesApproval.ts`. Freitextnamen (`approvedBy`) autorisieren
 *     nichts mehr. local-open ist fail-closed.
 */
import { NextResponse } from "next/server";
import {
  actorAuditId,
  denialResponse,
  requirePermission,
  resolveAuth,
} from "@/auth";
import type { AuthSuccess, Principal } from "@/auth";
import { checkCsrfGuard } from "@/brokers/control-plane/guard";
import { checkRateLimit } from "@/lib/apiAuth";
import {
  consumeFourEyes,
  fourEyesHint,
  fourEyesIntent,
  fourEyesScope,
  proposeFourEyes,
  type FourEyesDenyReason,
} from "@/lib/fourEyesApproval";
import {
  ensureLifecycleDraft,
  getLifecycleStatus,
  listEvidence,
  listLifecycleStates,
  listTransitions,
  recordEvidence,
  requestTransition,
} from "@/strategyLifecycle/service";
import {
  LIFECYCLE_TRANSITIONS,
  isStrategyLifecycleState,
  type LifecycleEvidenceKind,
  type LifecycleTrigger,
} from "@/strategyLifecycle/states";
import {
  normalizeStrategyKey,
  normalizeStrategyVersion,
} from "@/strategyLifecycle/evidence";
import { strategyLifecycleConfig } from "@/strategyLifecycle/config";
import { telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const EVIDENCE_KINDS = new Set<string>([
  "BACKTEST_RUN",
  "PAPER_WINDOW",
  "RECONCILIATION",
  "EXECUTION_QUALITY",
  "DRIFT",
  "RECOVERY",
  "OVERRIDE",
  "DATA_QUALITY",
]);

const TRIGGERS = new Set<string>([
  "operator",
  "system",
  "backtest",
  "drift",
  "recovery",
  "override",
]);

/**
 * Zielzustände, für die der Lifecycle-Service `roles: ["admin"]` verlangt.
 * Aus der kanonischen Tabelle abgeleitet (kein zweites Rollenset in der Route).
 */
const ADMIN_ONLY_TARGETS = new Set<string>(
  LIFECYCLE_TRANSITIONS.filter(
    (def) => def.from !== def.to && def.roles.length === 1 && def.roles[0] === "admin"
  ).map((def) => def.to)
);

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string, hint?: string): NextResponse {
  return NextResponse.json(
    hint ? { ok: false, error, hint } : { ok: false, error },
    { status, headers: NO_STORE }
  );
}

/** Rolle NUR aus der verifizierten Auth-Auflösung — nie aus Headern/Body. */
function actorRoleFromAuth(auth: AuthSuccess): "admin" | "operator" {
  return auth.principal.role === "admin" ? "admin" : "operator";
}

/** Vier-Augen-Pflicht: Live-Promotion oder Override. */
function requiresFourEyes(to: string, action: string): boolean {
  return action === "override" || ADMIN_ONLY_TARGETS.has(to) || to === "LIVE_LIMITED" || to === "LIVE";
}

function lifecycleScope(strategyKey: string, strategyVersion: number, to: string): string {
  return fourEyesScope("lifecycle", [strategyKey, String(strategyVersion), to]);
}

function lifecycleIntent(
  strategyKey: string,
  strategyVersion: number,
  to: string,
  action: string,
  trigger: LifecycleTrigger,
  evidenceId: string | null
): string {
  return fourEyesIntent([strategyKey, strategyVersion, to, action, trigger, evidenceId ?? ""]);
}

/** Einheitliche 403-Antwort für jede verletzte Vier-Augen-Bedingung. */
function fourEyesDenied(reason: FourEyesDenyReason): NextResponse {
  return fail(
    403,
    reason === "PRINCIPALS_REQUIRED" ? "FOUR_EYES_PRINCIPALS_REQUIRED" : `FOUR_EYES_${reason}`,
    fourEyesHint(reason)
  );
}

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const strategy = url.searchParams.get("strategy");
  const versionRaw = url.searchParams.get("version");

  try {
    const cfg = strategyLifecycleConfig();

    if (strategy === null || strategy === "") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const states = await listLifecycleStates(limit);
      telemetry.strategyLifecycle.gateDecisions.inc({ result: "ok", code: "api_list" });
      return NextResponse.json(
        {
          ok: true,
          mode: cfg.mode,
          states,
          count: states.length,
        },
        { headers: NO_STORE }
      );
    }

    if (versionRaw === null || versionRaw === "") return fail(400, "VERSION_REQUIRED");
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) return fail(400, "INVALID_VERSION");

    const status = await getLifecycleStatus(strategy, version);
    if (!status) {
      telemetry.strategyLifecycle.gateDecisions.inc({ result: "miss", code: "api_status" });
      return NextResponse.json(
        {
          ok: false,
          error: "LIFECYCLE_NOT_FOUND",
          strategyKey: strategy,
          strategyVersion: version,
        },
        { status: 404, headers: NO_STORE }
      );
    }

    const [evidence, transitions] = await Promise.all([
      listEvidence(strategy, version, 25),
      listTransitions(strategy, version, 50),
    ]);

    telemetry.strategyLifecycle.gateDecisions.inc({ result: "ok", code: "api_status" });
    return NextResponse.json(
      {
        ok: true,
        mode: cfg.mode,
        status,
        evidence,
        transitions,
        recoveryCooldownMs: cfg.recoveryCooldownMs,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    telemetry.strategyLifecycle.gateDecisions.inc({ result: "error", code: "api_error" });
    return NextResponse.json(
      {
        ok: false,
        error: "LIFECYCLE_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "Migration drizzle/2026-09-23_strategy_lifecycle.sql ausführen.",
      },
      { status: 503, headers: NO_STORE }
    );
  }
}

export async function POST(req: Request) {
  // ASA-02: Auth zuerst. `requirePermission` (firm.write) weist viewer mit 403
  // ab und ist zugleich der Guard, den das Routen-Inventar ausweist. Danach
  // CSRF + Schreib-Rate-Limit. Die verifizierte Auflösung (nicht der Header-
  // Name) liefert Rolle, Audit-ID und Principal-Fingerprint.
  const auth = resolveAuth(req);
  if (!auth.ok) return denialResponse(auth);
  const deniedBase = requirePermission(req, "firm.write");
  if (deniedBase) return deniedBase;
  const csrf = checkCsrfGuard(req);
  if (csrf) return csrf;
  if (checkRateLimit(req)) return fail(429, "RATE_LIMITED");

  const principal: Principal = auth.principal;
  const role = actorRoleFromAuth(auth);
  const actorId = actorAuditId(principal);
  const auditActor = `api:${actorId}`;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(400, "INVALID_BODY");
  }
  const body = parsed as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  const strategyKey = normalizeStrategyKey(body.strategyKey);
  const strategyVersion = normalizeStrategyVersion(body.strategyVersion);
  if (!strategyKey || strategyVersion === null) {
    return fail(400, "INVALID_STRATEGY_ID");
  }

  try {
    if (action === "ensure") {
      const denied = requirePermission(req, "strategy.rules.write");
      if (denied) return denied;
      const state = await ensureLifecycleDraft(strategyKey, strategyVersion, {
        actor: auditActor,
        role,
      });
      return NextResponse.json({ ok: true, state }, { headers: NO_STORE });
    }

    if (action === "evidence") {
      const denied = requirePermission(req, "strategy.rules.write");
      if (denied) return denied;
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (!EVIDENCE_KINDS.has(kind)) return fail(400, "INVALID_EVIDENCE_KIND");
      const result = body.result;
      if (result !== "PASS" && result !== "FAIL" && result !== "INCONCLUSIVE") {
        return fail(400, "INVALID_EVIDENCE_RESULT");
      }
      const metrics =
        typeof body.metrics === "object" && body.metrics !== null && !Array.isArray(body.metrics)
          ? (body.metrics as Record<string, unknown>)
          : null;
      if (!metrics) return fail(400, "METRICS_REQUIRED");
      const cleanMetrics: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(metrics)) {
        if (v === null) {
          cleanMetrics[k] = null;
          continue;
        }
        if (typeof v !== "number" || !Number.isFinite(v)) return fail(400, `INVALID_METRIC:${k}`);
        cleanMetrics[k] = v;
      }
      const sampleSize =
        body.sampleSize === null || body.sampleSize === undefined
          ? null
          : Number(body.sampleSize);
      if (sampleSize !== null && (!Number.isInteger(sampleSize) || sampleSize < 0)) {
        return fail(400, "INVALID_SAMPLE_SIZE");
      }
      const now = Date.now();
      const eventTime = Number(body.eventTimeMs ?? now);
      const availableAt = Number(body.availableAtMs ?? now);
      const computedAt = Number(body.computedAtMs ?? now);
      if (
        !Number.isFinite(eventTime) ||
        !Number.isFinite(availableAt) ||
        !Number.isFinite(computedAt)
      ) {
        return fail(400, "INVALID_TIMESTAMPS");
      }
      if (availableAt < eventTime || computedAt < availableAt) {
        return fail(400, "INVALID_TIME_SEMANTICS", "eventTime <= availableAt <= computedAt");
      }
      const windowStartMs =
        body.windowStartMs === undefined || body.windowStartMs === null
          ? null
          : Number(body.windowStartMs);
      const windowEndMs =
        body.windowEndMs === undefined || body.windowEndMs === null
          ? null
          : Number(body.windowEndMs);
      if (windowStartMs !== null && !Number.isFinite(windowStartMs)) {
        return fail(400, "INVALID_WINDOW");
      }
      if (windowEndMs !== null && !Number.isFinite(windowEndMs)) return fail(400, "INVALID_WINDOW");

      const { evidence, created } = await recordEvidence({
        strategyKey,
        strategyVersion,
        kind: kind as LifecycleEvidenceKind,
        result,
        codeVersion:
          typeof body.codeVersion === "string" && body.codeVersion.length <= 64
            ? body.codeVersion
            : "api",
        policyVersion:
          typeof body.policyVersion === "string" && body.policyVersion.length <= 128
            ? body.policyVersion
            : "slp1:api",
        promptVersion:
          typeof body.promptVersion === "string" ? body.promptVersion.slice(0, 128) : null,
        dataVersion:
          typeof body.dataVersion === "string" ? body.dataVersion.slice(0, 128) : null,
        backtestRunId:
          typeof body.backtestRunId === "string" && body.backtestRunId.length === 36
            ? body.backtestRunId
            : null,
        snapshot: {
          metrics: cleanMetrics,
          sampleSize,
          windowStartMs,
          windowEndMs,
        },
        eventTimeMs: eventTime,
        availableAtMs: availableAt,
        computedAtMs: computedAt,
      });
      return NextResponse.json({ ok: true, created, evidence }, { headers: NO_STORE });
    }

    // ── ASA-02: 2-Schritt-Vier-Augen-Flow (propose → approve) ───────────────
    if (action === "propose" || action === "approve") {
      const to = typeof body.to === "string" ? body.to : "";
      if (!isStrategyLifecycleState(to)) return fail(400, "INVALID_TARGET_STATE");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < 3 || reason.length > 500) return fail(400, "INVALID_REASON");
      const actionKind = typeof body.actionKind === "string" && body.actionKind === "override"
        ? "override"
        : "transition";
      if (!requiresFourEyes(to, actionKind)) {
        return fail(400, "FOUR_EYES_NOT_REQUIRED", "Direkter Übergang genügt (action: transition).");
      }
      // Override ist immer ein Override-Trigger: kein Body-Feld darf die
      // Audit-Semantik der Gegenzeichnung verschieben.
      let trigger: LifecycleTrigger = actionKind === "override" ? "override" : "operator";
      if (actionKind !== "override" && typeof body.trigger === "string" && TRIGGERS.has(body.trigger)) {
        trigger = body.trigger as LifecycleTrigger;
      }
      const evidenceId =
        typeof body.evidenceId === "string" && body.evidenceId.length === 36
          ? body.evidenceId
          : null;
      const scope = lifecycleScope(strategyKey, strategyVersion, to);
      const intent = lifecycleIntent(strategyKey, strategyVersion, to, actionKind, trigger, evidenceId);

      // Schritt 1: Erstfreigabe durch Principal A (nur Operator-Recht nötig —
      // es findet noch KEINE Zustandsänderung statt).
      if (action === "propose") {
        const denied = requirePermission(req, "strategy.rules.write");
        if (denied) return denied;
        const label =
          typeof body.approvedBy === "string" ? body.approvedBy.trim().slice(0, 64) : "";
        const proposal = proposeFourEyes({ scope, intent, principal, approvedBy: label });
        if (!proposal.ok) return fourEyesDenied(proposal.reason);
        telemetry.strategyLifecycle.gateDecisions.inc({ result: "ok", code: "four_eyes_propose" });
        return NextResponse.json(
          {
            ok: true,
            phase: "PENDING",
            approvalId: proposal.pending.approvalId,
            expiresAt: proposal.pending.expiresAt,
            proposer: actorId,
            hint: "Schritt 2: action=approve mit dieser approvalId durch einen ANDEREN authentifizierten Principal.",
          },
          { status: 202, headers: NO_STORE }
        );
      }

      // Schritt 2: Gegenzeichnung durch Principal B. Erst NACH erfolgreichem
      // Vier-Augen-Check darf der Service die Transition ausführen.
      const denied =
        requirePermission(req, "strategy.rules.activate") ??
        (actionKind === "override" ? requirePermission(req, "live.gate") : null);
      if (denied) return denied;
      if (role !== "admin" && (ADMIN_ONLY_TARGETS.has(to) || actionKind === "override")) {
        return fail(
          403,
          "ADMIN_ROLE_REQUIRED",
          "Admin-Lifecycle-Transitionen verlangen auth.principal.role === 'admin'. Header wie x-admin-token vergeben keine Rollen."
        );
      }
      const approvalId = typeof body.approvalId === "string" ? body.approvalId.trim() : "";
      const decision = consumeFourEyes({ scope, intent, approver: principal, approvalId });
      if (!decision.ok) {
        telemetry.strategyLifecycle.transitions.inc({ result: "four_eyes_denied", to });
        return fourEyesDenied(decision.reason);
      }
      const pending = decision.pending;
      const fourEyesReason =
        `${reason} [four-eyes: proposer=${pending.proposerAuditId} approver=${actorId} approvalId=${pending.approvalId}]`;
      return await runTransition({
        strategyKey,
        strategyVersion,
        to,
        actor: { actor: auditActor, role },
        trigger,
        reason: fourEyesReason,
        evidenceId,
      });
    }

    if (action === "transition" || action === "override") {
      const denied =
        requirePermission(req, "strategy.rules.activate") ??
        (action === "override" ? requirePermission(req, "live.gate") : null);
      if (denied) return denied;

      const to = typeof body.to === "string" ? body.to : "";
      if (!isStrategyLifecycleState(to)) return fail(400, "INVALID_TARGET_STATE");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < 3 || reason.length > 500) return fail(400, "INVALID_REASON");

      let trigger: LifecycleTrigger = action === "override" ? "override" : "operator";
      if (typeof body.trigger === "string" && TRIGGERS.has(body.trigger)) {
        trigger = body.trigger as LifecycleTrigger;
      }

      // ASA-02: Der alte Ein-Request-`approvedBy`-Vergleich ist ersatzlos
      // entfernt. Vier-Augen-Pflicht ⇒ zwingend propose → approve.
      if (requiresFourEyes(to, action)) {
        return fail(
          403,
          "FOUR_EYES_REQUIRED",
          "Live-Promotions/Overrides verlangen zwei getrennte Requests zweier unterschiedlicher authentifizierter Principals: zuerst action=propose, danach action=approve mit approvalId."
        );
      }
      if (role !== "admin" && ADMIN_ONLY_TARGETS.has(to)) {
        return fail(
          403,
          "ADMIN_ROLE_REQUIRED",
          "Admin-Lifecycle-Transitionen verlangen auth.principal.role === 'admin'."
        );
      }

      return await runTransition({
        strategyKey,
        strategyVersion,
        to,
        actor: { actor: auditActor, role },
        trigger,
        reason,
        evidenceId:
          typeof body.evidenceId === "string" && body.evidenceId.length === 36
            ? body.evidenceId
            : null,
      });
    }

    return fail(
      400,
      "UNKNOWN_ACTION",
      "ensure | evidence | transition | propose | approve (override nur via propose/approve)"
    );
  } catch (e) {
    telemetry.strategyLifecycle.transitions.inc({ result: "api_error", to: "none" });
    return NextResponse.json(
      {
        ok: false,
        error: "LIFECYCLE_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "Migration drizzle/2026-09-23_strategy_lifecycle.sql ausführen.",
      },
      { status: 503, headers: NO_STORE }
    );
  }
}

/** Gemeinsamer Service-Aufruf + Fehler-Mapping für Transition und Approve. */
async function runTransition(input: Parameters<typeof requestTransition>[0]): Promise<NextResponse> {
  const outcome = await requestTransition(input);
  if (!outcome.ok) {
    telemetry.strategyLifecycle.transitions.inc({ result: "api_denied", to: input.to });
    const status =
      outcome.code === "STATE_NOT_FOUND"
        ? 404
        : [
            "TRANSITION_FORBIDDEN",
            "ROLE_NOT_ALLOWED",
            "EVIDENCE_REQUIRED",
            "COOLDOWN_ACTIVE",
            "EVIDENCE_KIND_MISMATCH",
            "EVIDENCE_STALE",
          ].includes(outcome.code)
          ? 422
          : outcome.code === "LIFECYCLE_ERROR"
            ? 503
            : 400;
    return fail(status, outcome.code, outcome.error);
  }
  return NextResponse.json(
    {
      ok: true,
      idempotent: outcome.idempotent,
      state: outcome.state,
      transition: outcome.transition,
      detail: outcome.detail,
    },
    { headers: NO_STORE }
  );
}

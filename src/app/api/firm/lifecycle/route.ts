/**
 * Strategy-Lifecycle API (RMA-P1-05, v1.73.0).
 *
 * GET  /api/firm/lifecycle?strategy=<key>&version=<n>  — Status + Evidence/Transitions
 * GET  /api/firm/lifecycle                            — alle Zustände (limitiert)
 * POST /api/firm/lifecycle                            — ensure | evidence | transition | override
 *
 * SEC-02: Lesen `firm.read`, Schreiben jeweils eigene Permission
 * (`strategy.rules.write` / `.activate` / `live.gate` für Override +
 * Vier-Augen `approvedBy`). CSRF über `x-csrf-token` (checkCsrfGuard).
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { checkCsrfGuard } from "@/brokers/control-plane/guard";
import { checkRateLimit } from "@/lib/apiAuth";
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

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string, hint?: string): NextResponse {
  return NextResponse.json(
    hint ? { ok: false, error, hint } : { ok: false, error },
    { status, headers: NO_STORE }
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
  const csrf = checkCsrfGuard(req);
  if (csrf) return csrf;
  if (checkRateLimit(req)) return fail(429, "RATE_LIMITED");

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

  const isAdmin = Boolean(req.headers.get("x-admin-token"));
  const role = isAdmin ? "admin" : "operator";
  const actorId = isAdmin ? "admin" : "operator";

  try {
    if (action === "ensure") {
      const denied = requirePermission(req, "strategy.rules.write");
      if (denied) return denied;
      const state = await ensureLifecycleDraft(strategyKey, strategyVersion, {
        actor: `api:${actorId}`,
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

      if (action === "override") {
        const approvedBy = typeof body.approvedBy === "string" ? body.approvedBy.trim() : "";
        if (approvedBy.length < 3) {
          return fail(400, "APPROVER_REQUIRED", "Override benötigt approvedBy (Vier-Augen).");
        }
        const selfIds = [`api:${actorId}`, actorId].map((s) => s.toLowerCase());
        if (selfIds.includes(approvedBy.toLowerCase())) {
          return fail(
            403,
            "FOUR_EYES_REQUIRED",
            "approvedBy muss vom anfragenden Akteur abweichen."
          );
        }
        if (!Number.isInteger(Number(body.ttlMs ?? NaN)) && body.ttlMs !== undefined) {
          return fail(400, "INVALID_TTL");
        }
      }

      const outcome = await requestTransition({
        strategyKey,
        strategyVersion,
        to,
        actor: {
          actor: `api:${actorId}`,
          role: role === "admin" ? "admin" : "operator",
        },
        trigger,
        reason:
          action === "override"
            ? `${reason} (approver=${String(body.approvedBy ?? "").slice(0, 64)})`
            : reason,
        evidenceId:
          typeof body.evidenceId === "string" && body.evidenceId.length === 36
            ? body.evidenceId
            : null,
      });

      if (!outcome.ok) {
        telemetry.strategyLifecycle.transitions.inc({ result: "api_denied", to });
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

    return fail(400, "UNKNOWN_ACTION", "ensure | evidence | transition | override");
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

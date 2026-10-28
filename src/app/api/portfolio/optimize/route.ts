import { checkRateLimit, privateNoStore } from "@/lib/apiAuth";
import { checkCsrfGuard } from "@/lib/csrfGuard";
import { requirePermission } from "@/auth";
/**
 * `POST /api/portfolio/optimize` — Gewichte **inklusive** Risk-Guard-Report.
 *
 * **Autoritätskette (fest, in Code erzwungen):**
 * `Portfolio Optimizer → Risk Guard → Position Limits → Correlation Limits`.
 * Diese Route ruft ausschließlich {@link optimizeWithGuard} auf — der rohe
 * Optimizer ist hier nicht erreichbar. Ein Optimizer-Ergebnis gilt nie
 * ungeprüft: Jede Kappung und jeder Verwurf stehen mit Grund in
 * `reasons[]` und als strukturiertes Ereignis in `audit[]`.
 *
 * Antwort `200`:
 * ```json
 * { "ok": true, "configVersion": 1,
 *   "chain": ["portfolio-optimizer", "risk-guard", "position-limits", "correlation-limits"],
 *   "symbols": ["NVDA", "QQQ", "SPY", "GLD", "TLT"],
 *   "weights": [0.2, 0.2, 0.2, 0.2, 0.2],
 *   "mode": "min_variance", "rejected": false, "adjusted": true,
 *   "reasons": ["position-limits/POSITION_LIMIT_CAPPED: …"],
 *   "diagnostics": { "converged": true, "iterations": 42, "variance": 0.00021, "riskContributions": […] },
 *   "guard": { "decisions": […], "clusterExposures": […], "caps": […] },
 *   "audit": [ { "event": "RISK_GUARD_DECISION", "code": "POSITION_LIMIT_CAPPED", … } ] }
 * ```
 *
 * `422` wenn die Risk Guard das Ergebnis verwirft (`RISK_GUARD_REJECTION`) oder
 * die Kovarianz singulär ist; `400` bei ungültiger Anfrage; `413` bei zu großen
 * Eingaben. `GET` liefert `405`.
 *
 * **Audit:** Standard ist die Memory-Senke — die Ereignisse stehen in der
 * Antwort (`audit`). Mit `PORTFOLIO_AUDIT_DIR` (oder `PORTFOLIO_AUDIT=1`) wird
 * zusätzlich append-only nach `data/portfolio/audit-log.ndjson` geschrieben
 * (`// vgl. task-01/06` für die zentrale `audit_log`-Integration).
 */

import { createAuditLogger, memoryAuditSink, compositeAuditSink, type AuditSink } from "@/portfolio/audit";
import { fileAuditSink } from "@/portfolio/auditFile";
import { PORTFOLIO_API_LIMITS, PORTFOLIO_CONFIG_VERSION, isSingularMatrixPolicy } from "@/portfolio/config";
import { PortfolioError, requireFinite } from "@/portfolio/errors";
import { optimizeWithGuard } from "@/portfolio/pipeline";
import type { RiskGuardConfig } from "@/portfolio/types";
import {
  asObject,
  errorResponse,
  methodNotAllowed,
  parseCorrelationMethod,
  parseMode,
  parseNumber,
  parseOptionalNumber,
  parseSeries,
  parseSingularMatrixPolicy,
  parseSymbolMap,
  readJsonBody,
} from "../parse";

export const dynamic = "force-dynamic";

/** Baut die Audit-Senke dieser Route (Memory immer, Datei nur bei Konfiguration). */
export function buildAuditSinks(): { sink: AuditSink; fileEnabled: boolean } {
  const memory = memoryAuditSink();
  const fileEnabled = process.env.PORTFOLIO_AUDIT === "1" || Boolean(process.env.PORTFOLIO_AUDIT_DIR);
  if (!fileEnabled) return { sink: memory, fileEnabled };
  return { sink: compositeAuditSink([memory, fileAuditSink()]), fileEnabled };
}

/** `GET` ist nicht erlaubt — dieser Endpunkt ist eine POST-Abfrage. */
export function GET(req: Request = new Request("http://localhost/api")): Response {
  return privateNoStore((() => {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  return methodNotAllowed();

  })());
}

/**
 * Handler für `POST /api/portfolio/optimize`.
 *
 * **Guard (ASA-06):** `firm.write` + CSRF + Rate-Limit. Die Route ist nicht
 * rein rechnend — sie kann Audit-Ereignisse auf Disk persistieren
 * (`PORTFOLIO_AUDIT_DIR`/`PORTFOLIO_AUDIT=1`) und ist der teuerste Endpunkt
 * des Moduls; deshalb strengeres Limit (10 Requests / 60 s je Client) und
 * Schreibrecht statt Leserecht.
 */
export async function POST(req: Request): Promise<Response> {
  const denied =
    requirePermission(req, "firm.write") ??
    checkCsrfGuard(req) ??
    checkRateLimit(req, { max: 10, windowMs: 60_000 });
  if (denied) return denied;
  const { sink, fileEnabled } = buildAuditSinks();
  try {
    const body = asObject(await readJsonBody(req));
    const series = parseSeries(body.series);
    const mode = parseMode(body.mode);
    const audit = createAuditLogger({ sink, now: () => new Date(), source: "portfolio:optimize" });

    const boundsRaw = body.bounds === undefined ? undefined : asObject(body.bounds, "bounds");
    const guardRaw = body.guard === undefined ? undefined : asObject(body.guard, "guard");
    const solverRaw = body.solver === undefined ? undefined : asObject(body.solver, "solver");
    const covarianceRaw = body.covariance === undefined ? undefined : asObject(body.covariance, "covariance");

    const positionRaw = guardRaw?.position === undefined ? undefined : asObject(guardRaw.position, "guard.position");
    const correlationRaw =
      guardRaw?.correlation === undefined ? undefined : asObject(guardRaw.correlation, "guard.correlation");

    const guard: RiskGuardConfig & { allowCashResidual?: boolean } = {
      position: {
        maxWeightPerInstrument: parseOptionalNumber(positionRaw?.maxWeightPerInstrument, "guard.position.maxWeightPerInstrument", {
          min: 0,
          max: 1,
        }),
        perSymbol: parseSymbolMap(positionRaw?.perSymbol, "guard.position.perSymbol"),
        maxPositions: parseOptionalNumber(positionRaw?.maxPositions, "guard.position.maxPositions", {
          min: 1,
          max: 1000,
          integer: true,
        }),
        minWeight: parseOptionalNumber(positionRaw?.minWeight, "guard.position.minWeight", { min: 0, max: 1 }),
      },
      correlation: {
        threshold: parseOptionalNumber(correlationRaw?.threshold, "guard.correlation.threshold", { min: 0, max: 1 }),
        maxClusterExposure: parseOptionalNumber(correlationRaw?.maxClusterExposure, "guard.correlation.maxClusterExposure", {
          min: 0,
          max: 1,
        }),
        method: parseCorrelationMethod(correlationRaw?.method, "guard.correlation.method"),
      },
      // ASA-06: HTTP-Aufrufe dürfen höchstens PORTFOLIO_API_LIMITS.maxAdjustmentRounds
      // Korrekturrunden anfordern (jede Runde rechnet die Optimierung erneut).
      // Der API-Default ist identisch mit der Obergrenze — sonst wäre das
      // Weglassen des Feldes (Bibliotheks-Default 50) mächtiger als das
      // explizite Setzen eines erlaubten Wertes.
      maxAdjustmentRounds:
        parseOptionalNumber(guardRaw?.maxAdjustmentRounds, "guard.maxAdjustmentRounds", {
          min: 1,
          max: PORTFOLIO_API_LIMITS.maxAdjustmentRounds,
          integer: true,
        }) ?? PORTFOLIO_API_LIMITS.maxAdjustmentRounds,
      epsilon: parseOptionalNumber(guardRaw?.epsilon, "guard.epsilon", { min: 0, max: 1 }),
      allowCashResidual: guardRaw?.allowCashResidual === true,
    };

    const result = optimizeWithGuard(
      {
        series,
        mode,
        riskFreeRate: parseOptionalNumber(body.riskFreeRate, "riskFreeRate", { min: -1, max: 1 }),
        expectedReturns:
          body.expectedReturns === undefined ? undefined : parseBoundedArray(body.expectedReturns, series.length),
        covariance: {
          method: covarianceRaw?.method === "ewma" ? "ewma" : covarianceRaw?.method === "sample" ? "sample" : undefined,
          decay: parseOptionalNumber(covarianceRaw?.decay, "covariance.decay", { min: 0, max: 1 }),
          ddof: parseOptionalNumber(covarianceRaw?.ddof, "covariance.ddof", { min: 0, max: 1, integer: true }),
        },
        bounds: boundsRaw
          ? {
              minWeight: parseOptionalNumber(boundsRaw.minWeight, "bounds.minWeight", { min: -1, max: 1 }),
              maxWeight: parseOptionalNumber(boundsRaw.maxWeight, "bounds.maxWeight", { min: 0, max: 1 }),
              lower: boundsRaw.lower === undefined ? undefined : parseBoundedArray(boundsRaw.lower, series.length, "bounds.lower"),
              upper: boundsRaw.upper === undefined ? undefined : parseBoundedArray(boundsRaw.upper, series.length, "bounds.upper"),
            }
          : undefined,
        longOnly: body.longOnly === undefined ? undefined : body.longOnly === true,
        guard,
        solver: solverRaw
          ? {
              tolerance: parseOptionalNumber(solverRaw.tolerance, "solver.tolerance", { min: 1e-15, max: 1 }),
              // ASA-06: harte Obergrenze statt 1.000.000 — ein einzelner
              // Request darf den Event-Loop nicht für Sekunden blockieren.
              // Default bewusst 400 (Bibliotheks-Default bleibt 2.000).
              maxIterations:
                parseOptionalNumber(solverRaw.maxIterations, "solver.maxIterations", {
                  min: 1,
                  max: PORTFOLIO_API_LIMITS.maxIterations,
                  integer: true,
                }) ?? PORTFOLIO_API_LIMITS.defaultMaxIterations,
              singularMatrixPolicy: parseSingularMatrixPolicy(solverRaw.singularMatrixPolicy),
              ridgeFactor: parseOptionalNumber(solverRaw.ridgeFactor, "solver.ridgeFactor", { min: 0, max: 1 }),
              rcond: parseOptionalNumber(solverRaw.rcond, "solver.rcond", { min: 0, max: 1 }),
            }
          : undefined,
        annualization: parseOptionalNumber(body.annualization, "annualization", { min: 1, max: 100_000 }),
        withMetrics: body.withMetrics === true,
      },
      { audit }
    );

    const payload = {
      ok: !result.rejected,
      configVersion: PORTFOLIO_CONFIG_VERSION,
      chain: result.chain,
      symbols: result.symbols,
      weights: result.weights,
      mode: result.mode,
      rejected: result.rejected,
      adjusted: result.adjusted,
      reasons: result.reasons,
      diagnostics: result.diagnostics,
      guard: {
        rejected: result.guard.rejected,
        adjusted: result.guard.adjusted,
        decisions: result.guard.decisions,
        caps: result.guard.caps,
        clusterExposures: result.guard.clusterExposures,
      },
      clusters: result.clusters,
      covariance: result.covariance,
      correlation: result.correlation,
      metrics: result.metrics,
      annualization: result.annualization,
      audit: result.auditEvents,
      auditFileEnabled: fileEnabled,
      error: result.rejected ? ("RISK_GUARD_REJECTION" as const) : undefined,
      message: result.rejected ? "die Risk Guard hat das Optimizer-Ergebnis verworfen" : undefined,
    };
    return Response.json(payload, { status: result.rejected ? 422 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Parst ein Zahlenarray fester Länge (`expectedReturns`, `bounds.lower/upper`). */
function parseBoundedArray(raw: unknown, length: number, field = "expectedReturns"): number[] {
  if (!Array.isArray(raw)) {
    throw new PortfolioError("INVALID_INPUT", `${field} muss ein Array sein`, { field });
  }
  if (raw.length !== length) {
    throw new PortfolioError("LENGTH_MISMATCH", `${field} hat ${raw.length} Einträge, erwartet ${length}`, { field });
  }
  return raw.map((v, i) => requireFinite(v, `${field}[${i}]`));
}

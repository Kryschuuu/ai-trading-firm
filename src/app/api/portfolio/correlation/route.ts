/**
 * `POST /api/portfolio/correlation` — Korrelationsmatrix und Cluster (read-only).
 *
 * Antwort `200`:
 * ```json
 * { "ok": true, "configVersion": 1,
 *   "correlation": { "method": "pearson", "symbols": ["NVDA", "QQQ"],
 *                    "matrix": [[1, 0.91], [0.91, 1]], "observations": 250,
 *                    "degenerate": [] },
 *   "clusters": { "threshold": 0.8, "method": "pearson", "symbols": ["NVDA", "QQQ"],
 *                 "clusters": [ { "id": 0, "symbols": ["NVDA", "QQQ"], "maxAbsCorrelation": 0.91 } ] } }
 * ```
 *
 * `clusters` ist `null`, wenn kein `clusterThreshold` übergeben wurde.
 * Die Matrix ist symmetrisch, die Diagonale ist 1; eine Korrelation mit
 * Nullvarianz ist `0` (nicht `1`) und das Symbol steht in `degenerate`.
 */

import { PORTFOLIO_CONFIG_VERSION } from "@/portfolio/config";
import { computeCorrelation } from "@/portfolio/pipeline";
import {
  asObject,
  errorResponse,
  methodNotAllowed,
  parseCorrelationMethod,
  parseOptionalNumber,
  parseSeries,
  readJsonBody,
} from "../parse";

export const dynamic = "force-dynamic";

/** `GET` ist nicht erlaubt — dieser Endpunkt ist eine POST-Abfrage. */
export function GET(): Response {
  return methodNotAllowed();
}

/** Handler für `POST /api/portfolio/correlation`. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = asObject(await readJsonBody(req));
    const series = parseSeries(body.series);
    const method = parseCorrelationMethod(body.method);
    const clusterThreshold = parseOptionalNumber(body.clusterThreshold, "clusterThreshold", { min: 0, max: 1 });
    const { correlation, clusters } = computeCorrelation(series, { method, clusterThreshold });
    return Response.json({
      ok: true,
      configVersion: PORTFOLIO_CONFIG_VERSION,
      correlation,
      clusters,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

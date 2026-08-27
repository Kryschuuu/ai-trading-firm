/**
 * `POST /api/portfolio/metrics` — Kennzahlen aus Renditezeitreihen (read-only).
 *
 * **Read-only:** Es wird kein Zustand verändert, keine Order erzeugt, nichts
 * persistiert. `POST` wird ausschließlich wegen der Payload-Größe verwendet
 * (Zeitserien passen in keine Query) — semantisch ist der Endpunkt eine
 * Abfrage. `GET` liefert `405`.
 *
 * Anfrage:
 * ```json
 * {
 *   "series": [
 *     { "symbol": "NVDA", "prices": [100, 102, 101, 105] },
 *     { "symbol": "QQQ",  "returns": [0.01, -0.02, 0.005] },
 *     { "symbol": "BTC",  "logReturns": [0.02, -0.01], "candles": [{ "high": 1, "low": 1, "close": 1 }] }
 *   ],
 *   "annualization": 252,
 *   "riskFreeRate": 0.02,
 *   "atrPeriod": 14
 * }
 * ```
 *
 * Antwort `200`:
 * ```json
 * { "ok": true, "configVersion": 1, "symbols": ["NVDA"],
 *   "metrics": [ { "symbol": "NVDA", "volatility": 0.49, "sharpe": 1.2,
 *                  "sortino": 1.8, "maxDrawdown": { "value": 0.12, "durationPeriods": 7 },
 *                  "profitFactor": 1.9, "regime": "NORMAL" } ] }
 * ```
 *
 * `400` bei ungültigen Eingaben, `413` bei Überschreiten der Größenlimits.
 */

import { PORTFOLIO_CONFIG_VERSION } from "@/portfolio/config";
import { computeAllMetrics } from "@/portfolio/pipeline";
import { asObject, errorResponse, methodNotAllowed, parseNumber, parseOptionalNumber, parseSeries, readJsonBody } from "../parse";

export const dynamic = "force-dynamic";

/** `GET` ist nicht erlaubt — dieser Endpunkt ist eine POST-Abfrage. */
export function GET(): Response {
  return methodNotAllowed();
}

/** Handler für `POST /api/portfolio/metrics`. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = asObject(await readJsonBody(req));
    const series = parseSeries(body.series);
    const metrics = computeAllMetrics(series, {
      annualization: parseOptionalNumber(body.annualization, "annualization", { min: 1, max: 100_000 }),
      riskFreeRate: parseOptionalNumber(body.riskFreeRate, "riskFreeRate", { min: -1, max: 1 }),
      ddof: parseOptionalNumber(body.ddof, "ddof", { min: 0, max: 1, integer: true }),
      atrPeriod: parseOptionalNumber(body.atrPeriod, "atrPeriod", { min: 1, max: 1000, integer: true }),
      downsideTarget: parseOptionalNumber(body.downsideTarget, "downsideTarget"),
      regime:
        body.regime === undefined
          ? undefined
          : {
              low: parseNumber(asObject(body.regime, "regime").low, "regime.low", { min: 0 }),
              normal: parseNumber(asObject(body.regime, "regime").normal, "regime.normal", { min: 0 }),
              high: parseNumber(asObject(body.regime, "regime").high, "regime.high", { min: 0 }),
            },
    });
    return Response.json({ ok: true, configVersion: PORTFOLIO_CONFIG_VERSION, ...metrics });
  } catch (e) {
    return errorResponse(e);
  }
}

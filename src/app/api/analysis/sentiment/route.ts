/**
 * `GET /api/analysis/sentiment` — Strukturierte Sentiment-Forecasts (RMA-P2-05, v1.64.0).
 *
 * Query-Parameter:
 *   `entityId`   Kanonische ID (optional, max 64 Zeichen)
 *   `status`     `ACTIVE` | `ABSTAIN` (optional)
 *   `horizon`    `4h` | `24h` | `72h` (optional)
 *   `from`       ISO-8601-Startdatum (optional)
 *   `to`         ISO-8601-Enddatum (optional)
 *   `limit`      1…200 (Default 50)
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "count": 1,
 *   "forecasts": [ ... ]
 * }
 * ```
 */

import { NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/secrets";
import { listSentimentForecasts } from "@/sentiment/store";
import {
  isSentimentHorizon,
  isSentimentStatus,
  SENTIMENT_LIMITS,
  type SentimentHorizon,
  type SentimentStatus,
} from "@/sentiment/types";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const rawStatus = url.searchParams.get("status");
    const rawHorizon = url.searchParams.get("horizon");
    const rawFrom = url.searchParams.get("from");
    const rawTo = url.searchParams.get("to");
    const rawLimit = url.searchParams.get("limit");

    // 1. Validierung entityId
    if (entityId !== undefined && (entityId.trim().length === 0 || entityId.length > 64)) {
      return NextResponse.json(
        { ok: false, error: "INVALID_ENTITY_ID", message: "entityId darf max 64 Zeichen lang sein." },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // 2. Validierung status
    let status: SentimentStatus | undefined;
    if (rawStatus !== null && rawStatus !== "") {
      const upper = rawStatus.trim().toUpperCase();
      if (!isSentimentStatus(upper)) {
        return NextResponse.json(
          { ok: false, error: "INVALID_STATUS", message: "status muss 'ACTIVE' oder 'ABSTAIN' sein." },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      status = upper;
    }

    // 3. Validierung horizon
    let horizon: SentimentHorizon | undefined;
    if (rawHorizon !== null && rawHorizon !== "") {
      const lower = rawHorizon.trim().toLowerCase();
      if (!isSentimentHorizon(lower)) {
        return NextResponse.json(
          { ok: false, error: "INVALID_HORIZON", message: "horizon muss '4h', '24h' oder '72h' sein." },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      horizon = lower;
    }

    // 4. Validierung from / to
    let from: Date | undefined;
    if (rawFrom !== null && rawFrom !== "") {
      from = new Date(rawFrom);
      if (!Number.isFinite(from.getTime())) {
        return NextResponse.json(
          { ok: false, error: "INVALID_DATE", message: "from muss ein gültiges ISO-8601-Datum sein." },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
    }

    let to: Date | undefined;
    if (rawTo !== null && rawTo !== "") {
      to = new Date(rawTo);
      if (!Number.isFinite(to.getTime())) {
        return NextResponse.json(
          { ok: false, error: "INVALID_DATE", message: "to muss ein gültiges ISO-8601-Datum sein." },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
    }

    // 5. Validierung limit
    let limit: number = SENTIMENT_LIMITS.defaultListLimit;
    if (rawLimit !== null && rawLimit !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > SENTIMENT_LIMITS.maxListLimit) {
        return NextResponse.json(
          { ok: false, error: "INVALID_LIMIT", message: `limit muss zwischen 1 und ${SENTIMENT_LIMITS.maxListLimit} liegen.` },
          { status: 400, headers: NO_STORE_HEADERS }
        );
      }
      limit = parsed;
    }

    const forecasts = await listSentimentForecasts({
      entityId,
      status,
      horizon,
      from,
      to,
      limit,
    });

    return NextResponse.json(
      { ok: true, count: forecasts.length, forecasts },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(error) },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

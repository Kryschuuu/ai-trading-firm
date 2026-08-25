import { NextResponse } from "next/server";
import { db } from "@/db";
import { positions } from "@/db/schema";
import { gte } from "drizzle-orm";
import { readEquitySeries } from "@/lib/equity";
import { periodStart, type Period } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Equity-Kurve für den Chart.
 *   ?range=day|week|month|all  (Standard: week)
 * Liefert die heruntergesampelte Serie plus Trade-Marker (Ein-/Ausstiege).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rangeRaw = (url.searchParams.get("range") ?? "week").toLowerCase();
  const allowed = ["day", "week", "month", "all"] as const;
  const range: Period | "all" = (allowed as readonly string[]).includes(rangeRaw)
    ? (rangeRaw as Period | "all")
    : "week";

  const since =
    range === "all"
      ? new Date(Date.now() - 90 * 86_400_000) // Retentionsfenster
      : periodStart(range);

  const [series, trades] = await Promise.all([
    readEquitySeries(since),
    db
      .select({
        symbol: positions.symbol,
        side: positions.side,
        entryPrice: positions.entryPrice,
        exitPrice: positions.exitPrice,
        realizedPnl: positions.realizedPnl,
        exitReason: positions.exitReason,
        status: positions.status,
        openedAt: positions.createdAt,
        closedAt: positions.updatedAt,
      })
      .from(positions)
      .where(gte(positions.createdAt, since)),
  ]);

  return NextResponse.json({
    ok: true,
    range,
    since: since.toISOString(),
    series,
    trades: trades.map((t) => ({
      ...t,
      realizedPnl: Number(t.realizedPnl ?? 0),
      entryPrice: Number(t.entryPrice),
      exitPrice: t.exitPrice != null ? Number(t.exitPrice) : null,
    })),
  });
}

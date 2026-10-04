/**
 * API-Route `GET /api/firm/equity` — Equity-Kurve mit Drawdown-Analyse (Lese-API).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 *
 * Parameter:
 *   ?range=day|week|month|quarter|halfyear|year|all     (Default: week)
 *       Aliase: 1d|24h|1w|7d|1m|30d|3m|90d|6m|180d|1y|365d|max|alles
 *   ?resolution=auto|raw|hourly|daily                   (Default: auto)
 *       auto   = Bucket-Breite aus Zeitraum und Punktdeckel (empfohlen)
 *       raw    = 60-s-Rohdaten (nur sinnvoll für kurze Fenster)
 *       hourly = feste Stunden-Buckets
 *       daily  = feste Tages-Buckets
 *   ?maxPoints=20…2000                                  (Default: 240)
 *
 * Antwort (Kurzform): Serie mit laufendem Höchststand und Drawdown je Punkt,
 * Kennzahlen (`stats` — u. a. max. Drawdown Peak-to-Trough, aktueller
 * Drawdown, Rendite, Tagesvolatilität), Trade-Marker (`markers`) sowie
 * Metadaten zur Aufbewahrung, damit die UI ehrlich sagen kann, ab wann die
 * Historie reicht („ab Aufbewahrungsfenster“ statt still abzuschneiden).
 *
 * Die Definitionen stehen in docs/EQUITY_CURVE.md; die Mathematik in
 * src/lib/equityAnalytics.ts (rein, getestet).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { db } from "@/db";
import { positions } from "@/db/schema";
import { gte, or, sql } from "drizzle-orm";
import { loadEquityRetentionConfig, readEquitySeriesWindow, readMonthlyEquity } from "@/lib/equity";
import {
  drawdownEpisodes,
  timeWeightedReturn,
  type EquityMarker,
  type TimeWeightedReturn,
} from "@/lib/equityAnalytics";
import { normalizeBenchmarkId, readBenchmarkSeries } from "@/lib/equityBenchmark";
import {
  equityRangeStart,
  equityRangeWindowMs,
  normalizeEquityRange,
  type EquityRange,
} from "@/lib/equityRange";
import { readStartingEquity } from "@/lib/startingEquity";

export const dynamic = "force-dynamic";

/** Feste Bucket-Breiten der expliziten Auflösungen (Sekunden). */
const RESOLUTION_SECONDS = { raw: 60, hourly: 3_600, daily: 86_400 } as const;
type Resolution = keyof typeof RESOLUTION_SECONDS | "auto";

export async function GET(req: Request) {
  // SEC-02: performance, drawdown and trade markers are sensitive portfolio
  // data — authorize before any DB access.
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const range: EquityRange = normalizeEquityRange(url.searchParams.get("range"));
  const resolutionRaw = (url.searchParams.get("resolution") ?? "auto").toLowerCase();
  const resolution: Resolution =
    resolutionRaw === "raw" || resolutionRaw === "hourly" || resolutionRaw === "daily" ? resolutionRaw : "auto";
  // `has()` statt `Number(null)`: ohne Parameter wurde der Deckel vorher auf
  // 20 geklemmt (Number(null) === 0) — die Kurve war dann unnötig grob.
  const maxPointsParam = url.searchParams.get("maxPoints");
  const maxPointsRaw = maxPointsParam === null ? Number.NaN : Number(maxPointsParam);
  const maxPoints = Number.isFinite(maxPointsRaw) ? Math.min(2000, Math.max(20, Math.trunc(maxPointsRaw))) : 240;

  // Referenzwert für den Vergleich (optional; ohne Daten keine Linie).
  const compareId = normalizeBenchmarkId(url.searchParams.get("compare"));

  const now = new Date();
  const retention = loadEquityRetentionConfig();
  const retentionStart = new Date(now.getTime() - retention.retentionDays * 86_400_000);
  const wantedStart = equityRangeStart(range, now);
  // „all“ = so weit zurück, wie die Aufbewahrung reicht; alle anderen Zeiträume
  // werden nie weiter als die Aufbewahrung geöffnet (sonst „leere Kurve“).
  const since =
    wantedStart && wantedStart.getTime() > retentionStart.getTime() ? wantedStart : retentionStart;

  const startEquity = readStartingEquity();

  // Explizites Fenster (Vorperioden-Vergleich). Beide Werte müssen lesbar sein;
  // sonst bleibt es beim Kalenderfenster aus `range` — kein stiller Teilschutz.
  const fromRaw = url.searchParams.get("from");
  const untilRaw = url.searchParams.get("until");
  const fromExplicit = fromRaw ? new Date(fromRaw) : null;
  const untilExplicit = untilRaw ? new Date(untilRaw) : null;
  const explicitWindow =
    fromExplicit && untilExplicit &&
    Number.isFinite(fromExplicit.getTime()) &&
    Number.isFinite(untilExplicit.getTime()) &&
    untilExplicit.getTime() > fromExplicit.getTime();
  const windowSince = explicitWindow ? (fromExplicit as Date) : since;
  const windowUntil = explicitWindow ? (untilExplicit as Date) : now;

  const fixedBucketSeconds = resolution === "auto" ? undefined : RESOLUTION_SECONDS[resolution];
  const window = await readEquitySeriesWindow({
    since: windowSince,
    until: windowUntil,
    // Feste Auflösung darf mehr Punkte liefern als der Chart-Deckel — die
    // Bucket-Breite bleibt exakt (Auflösung ist eine Zusage, keine Empfehlung).
    maxPoints: fixedBucketSeconds ? Math.max(maxPoints, 2000) : maxPoints,
    startEquity,
    bucketSeconds: fixedBucketSeconds,
  });

  const markers = await readTradeMarkers(windowSince, windowUntil);

  const stats = window.stats;

  // Zeitgewichtete Rendite: verkettete Tagesrenditen. Cashflows kennt das
  // Paper-Konto nicht — `flows.applied` bleibt dann `false` und die UI sagt
  // das ehrlich dazu (siehe docs/EQUITY_CURVE.md §3).
  const twr: TimeWeightedReturn = timeWeightedReturn(window.points);

  // Referenz: an den Kurvenstart skaliert, damit beide Linien in USD wie im
  // Index-Modus vergleichbar sind. Fehler/fehlende Historie ⇒ null.
  const benchmark =
    compareId && stats.firstEquity != null
      ? readBenchmarkSeries(compareId, {
          since: windowSince,
          until: windowUntil,
          equityAtStart: stats.firstEquity,
        })
      : null;

  // Die tiefsten Drawdown-Phasen (Peak → Tief → Erholung). Schwelle 0,1 %,
  // damit Mini-Schwankungen die Liste nicht füllen.
  const episodes = drawdownEpisodes(window.points, { topN: 5, minPct: 0.1 });

  // Monatsrenditen kommen aus SQL und decken IMMER die ganze Aufbewahrung ab
  // (nicht nur das gewählte Fenster) — die Heatmap zeigt die lange Historie,
  // auch wenn die Kurve gerade nur eine Woche zeigt.
  let monthly: Awaited<ReturnType<typeof readMonthlyEquity>> = [];
  try {
    monthly = await readMonthlyEquity(retentionStart, now);
  } catch {
    monthly = []; // Anzeige-Schicht: fehlende Monatsdaten brechen die Kurve nie
  }

  return NextResponse.json(
    {
      ok: true,
      range,
      /** Effektives Fenster (bei `from`/`until` das explizite Fenster). */
      since: windowSince.toISOString(),
      until: windowUntil.toISOString(),
      /** Kalenderfenster-Anfang aus `range` (null bei „all“). */
      calendarSince: since.toISOString(),
      /** Angefordertes Fenster (kann vor der Historie liegen — siehe `historyStart`). */
      requestedSince: wantedStart ? wantedStart.toISOString() : null,
      rangeMs: equityRangeWindowMs(range),
      /** Effektive Bucket-Breite + Klartext („1 Tag“). */
      bucketSeconds: window.bucketSeconds,
      resolution: window.resolution,
      maxPoints,
      series: window.points,
      markers,
      stats,
      /** Die tiefsten Drawdown-Phasen (Peak → Tief → Erholung, Top 5). */
      episodes,
      /** Monatsrenditen der gesamten Historie (Heatmap), aus SQL. */
      monthly,
      /** Zeitgewichtete Rendite (verkettet) + einfache Rendite zum Vergleich. */
      twr,
      /**
       * Referenzlinie (optional). Enthält `points` (skaliert), `returnPct` und
       * die Datenquelle; `null`, wenn keine Historie vorhanden ist.
       */
      benchmark: benchmark
        ? {
            id: benchmark.id,
            label: benchmark.label,
            source: benchmark.source,
            timeframe: benchmark.timeframe,
            points: benchmark.points,
            returnPct: benchmark.returnPct,
          }
        : null,
      startingEquity: startEquity,
      retention: {
        rawDays: retention.rawDays,
        retentionDays: retention.retentionDays,
        historyStart: window.meta.earliestTs,
        priorPeak: window.meta.priorPeak,
        priorTs: window.meta.priorTs,
        truncated:
          window.meta.earliestTs !== null &&
          Date.parse(window.meta.earliestTs) > windowSince.getTime() + 1000,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

/**
 * Trade-Marker für den Chart: Eröffnungen (`status=OPEN` oder geschlossen) am
 * `createdAt`, Schließungen am `updatedAt` mit realisiertem P&L. Beide
 * Zeitpunkte können außerhalb des Fensters liegen — gefiltert wird auf
 * „im Fenster“, nicht auf „im Fenster eröffnet“ (sonst fehlten die Exits
 * von Positionen, die vor dem Fenster aufgingen).
 */
async function readTradeMarkers(since: Date, until: Date): Promise<EquityMarker[]> {
  const rows = await db
    .select({
      id: positions.id,
      symbol: positions.symbol,
      side: positions.side,
      status: positions.status,
      entryPrice: positions.entryPrice,
      exitPrice: positions.exitPrice,
      realizedPnl: positions.realizedPnl,
      exitReason: positions.exitReason,
      openedAt: positions.createdAt,
      closedAt: positions.updatedAt,
    })
    .from(positions)
    .where(
      or(
        gte(positions.createdAt, since),
        sql`(${positions.status} = 'CLOSED' AND ${positions.updatedAt} >= ${since})`
      )
    )
    .limit(500);

  const markers: EquityMarker[] = [];
  for (const row of rows) {
    const openedAt = row.openedAt instanceof Date ? row.openedAt : new Date(row.openedAt as unknown as string);
    if (openedAt >= since && openedAt <= until) {
      markers.push({
        id: `${row.id}:entry`,
        kind: "ENTRY",
        ts: openedAt.toISOString(),
        symbol: row.symbol,
        side: row.side,
        price: Number(row.entryPrice),
      });
    }
    if (row.status === "CLOSED" && row.closedAt) {
      const closedAt = row.closedAt instanceof Date ? row.closedAt : new Date(row.closedAt as unknown as string);
      if (closedAt >= since && closedAt <= until) {
        markers.push({
          id: `${row.id}:exit`,
          kind: "EXIT",
          ts: closedAt.toISOString(),
          symbol: row.symbol,
          side: row.side,
          price: row.exitPrice != null ? Number(row.exitPrice) : null,
          pnl: Number(row.realizedPnl ?? 0),
          exitReason: row.exitReason,
        });
      }
    }
  }
  return markers.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

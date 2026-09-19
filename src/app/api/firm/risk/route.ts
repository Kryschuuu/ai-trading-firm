import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { positions } from "@/db/schema";
import { correlationClusters } from "@/portfolio";
import { getAdaptiveRiskState, getBaseLimits, getLimits } from "@/lib/riskGuard";
import {
  KELLY_STATS_TTL_MS,
  SIZING_CONFIG_BOUNDS,
  loadSizingConfig,
  resolveKellyEdge,
  type KellyEdge,
} from "@/lib/positionSizing";
import {
  CLUSTER_LIMITS_BOUNDS,
  CLUSTER_TIMEFRAME,
  getDefaultCorrelationSource,
  getClusterCacheStatus,
  loadClusterLimitsConfig,
} from "@/lib/clusterExposure";

export const dynamic = "force-dynamic";

/**
 * Risiko-Status: effektive Sizing- und Cluster-Limits im Order-Pfad
 * (GAP-04, v1.48.0, D3) + UNKNOWN-Zustände (Fail-closed-Markierungen,
 * Muster adaptiveRisk v1.36.21).
 *
 * Antwort (GET, lesend):
 *   sizing
 *     atrStopMult        wirksamer ATR-Stop-Multiplikator (RISK_ATR_STOP_MULT)
 *     kelly              Fractional-Kelly-Deckel: Status (off | ok |
 *                        unavailable), aktive Edge-Statistik aus dem
 *                        Trade-Journal (Trefferquote/Payoff, Stichprobe)
 *     limits             Basis- vs. effektive Limits (adaptive Reduktion),
 *                        aktives Volatilitätsregime
 *   clusterGuardrail
 *     mode/threshold/maxPerCluster/windowCandles/cacheTtlMs + Bounds
 *     cache              Zustand des Korrelations-Caches (TTL, lastComputedAt)
 *     openPositions      aktuell offene Positionssymbole
 *     currentClusters    Cluster der OFFENEN Positionen (frisch berechnet,
 *                        null = keine Daten → fail-closed-Kennzeichnung)
 *   unknown
 *     correlationUnavailable  true = keine Korrelationsaussage möglich
 *                             (stale/fehlende Daten — enforce würde
 *                             Aufstockungen ablehnen)
 *
 * Dauerhafte Historie der Guardrail-Entscheidungen: audit_log-Events
 * `CLUSTER_EXPOSURE_MONITOR` / `CLUSTER_EXPOSURE_BLOCKED` (Code
 * `cluster-exposure:…`) und `POSITION_SIZING` / `POSITION_SIZING_UNKNOWN`
 * (Code `sizing:atr-unknown:…`).
 */
export async function GET() {
  const sizingCfg = loadSizingConfig();
  const clusterCfg = loadClusterLimitsConfig();
  const base = getBaseLimits();
  const limits = getLimits();
  const adaptive = getAdaptiveRiskState();

  // Kelly-Edge nur laden, wenn der Deckel überhaupt an ist.
  let kellyEdge: KellyEdge | null = null;
  let kellyStatus: "off" | "ok" | "unavailable" = "off";
  if (sizingCfg.kellyFraction > 0) {
    kellyEdge = await resolveKellyEdge(sizingCfg);
    kellyStatus = kellyEdge != null ? "ok" : "unavailable";
  }

  // Offene Positionen (DB ist die Wahrheit; Fehler → leer, sichtbar).
  let openSymbols: string[] = [];
  try {
    const rows = await db
      .select({ symbol: positions.symbol })
      .from(positions)
      .where(eq(positions.status, "OPEN"));
    openSymbols = rows.map((r) => r.symbol).sort();
  } catch {
    openSymbols = [];
  }

  // Cluster der offenen Positionen (frisch, lokal aus dem HistoricalStore).
  let currentClusters: {
    clusters: Array<{ symbols: string[]; maxAbsCorrelation: number }>;
    observations: number;
    lastTs: string;
    computedAt: string;
  } | null = null;
  if (openSymbols.length >= 2) {
    try {
      const data = await getDefaultCorrelationSource()(openSymbols, clusterCfg.windowCandles);
      if (data) {
        currentClusters = {
          clusters: correlationClusters(data.matrix, clusterCfg.threshold).map((c) => ({
            symbols: c.symbols,
            maxAbsCorrelation: c.maxAbsCorrelation,
          })),
          observations: data.observations,
          lastTs: new Date(data.lastTs).toISOString(),
          computedAt: new Date(data.computedAt).toISOString(),
        };
      }
    } catch {
      currentClusters = null;
    }
  }

  const correlationUnavailable = openSymbols.length > 0 && currentClusters == null;

  return NextResponse.json({
    ok: true,
    sizing: {
      atrStopMult: sizingCfg.atrStopMult,
      atrStopMultBounds: [...SIZING_CONFIG_BOUNDS.atrStopMult],
      kelly: {
        enabled: sizingCfg.kellyFraction > 0,
        fraction: sizingCfg.kellyFraction,
        fractionBounds: [...SIZING_CONFIG_BOUNDS.kellyFraction],
        status: kellyStatus,
        edge: kellyEdge,
        statsTtlMs: KELLY_STATS_TTL_MS,
      },
      limits: {
        maxPositionPct: { base: base.maxPositionPct, effective: limits.maxPositionPct },
        maxRiskPerTrade: { base: base.maxRiskPerTrade, effective: limits.maxRiskPerTrade },
        defaultStopLossPct: limits.defaultStopLossPct,
        adaptiveRegime: adaptive?.regime ?? null,
        adaptiveFactor: adaptive?.factor ?? null,
      },
    },
    clusterGuardrail: {
      mode: clusterCfg.mode,
      threshold: clusterCfg.threshold,
      thresholdBounds: [...CLUSTER_LIMITS_BOUNDS.threshold],
      maxPerCluster: clusterCfg.maxPerCluster,
      maxPerClusterBounds: [...CLUSTER_LIMITS_BOUNDS.maxPerCluster],
      windowCandles: clusterCfg.windowCandles,
      windowCandlesBounds: [...CLUSTER_LIMITS_BOUNDS.windowCandles],
      cacheTtlMs: clusterCfg.cacheTtlMs,
      cacheTtlMsBounds: [...CLUSTER_LIMITS_BOUNDS.cacheTtlMs],
      timeframe: CLUSTER_TIMEFRAME,
      cache: getClusterCacheStatus(),
      openPositions: openSymbols,
      currentClusters,
    },
    unknown: {
      correlationUnavailable,
      note: correlationUnavailable
        ? "Keine Korrelationsaussage möglich (keine/veraltete Kerzen im HistoricalStore) — enforce-Modus würde Aufstockungen in möglicherweise korrelierte Cluster ablehnen (cluster-exposure:correlation-stale, fail-closed)."
        : "Keine UNKNOWN-Zustände.",
    },
  });
}

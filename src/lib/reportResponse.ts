/**
 * Laufzeitvertrag fuer `GET /api/firm/report`.
 *
 * TypeScript-Typen verschwinden im Browser-Bundle. Die Report-Komponente darf
 * deshalb eine Fehlerantwort (zum Beispiel `401 { ok: false, error: ... }`)
 * nicht einfach als `ReportData` behandeln: Der Renderer greift auf mehrere
 * Listen zu und wuerde bei einem Fehlerbody mit `undefined.length` abstuerzen.
 * Dieser kleine, IO-freie Guard bildet die API-Grenze explizit ab und wird von
 * der UI vor jedem State-Update verwendet.
 */

export type ReportData = {
  ok: boolean;
  period: string;
  since: string;
  kpis: {
    trades: number;
    realizedPnl: number;
    winRate: number | null;
    profitFactor: number | null;
    bestTrade: { symbol: string; pnl: number } | null;
    worstTrade: { symbol: string; pnl: number } | null;
    /** Groesster Rueckgang vom Hoechststand (Peak-to-Trough). */
    maxDrawdownPct: number;
    maxDrawdownAbs?: number;
    currentDrawdownPct?: number;
    maxDrawdownFrom?: string | null;
    maxDrawdownTo?: string | null;
    recoveredAt?: string | null;
    grossProfit?: number;
    grossLoss?: number;
    avgWin?: number | null;
    avgLoss?: number | null;
    /** Erwartungswert je Trade. */
    expectancy?: number | null;
    payoffRatio?: number | null;
    maxWinStreak?: number;
    maxLossStreak?: number;
    avgHoldHours?: number | null;
    stopLossHits: number;
    takeProfitHits: number;
  };
  symbols: { symbol: string; trades: number; wins: number; pnl: number }[];
  turnsByRole: Record<string, number>;
  decisionsByType: Record<string, number>;
  blocks: { reason: string; count: number; explanation: string | null }[];
  notableEvents: { at: string; event: string; level: string; detail: unknown }[];
  recommendations: {
    at: string;
    role: string;
    symbol: string;
    side: string;
    horizon?: string;
    thesis?: string;
    confidence?: number;
    entryZone?: string;
    stopLoss?: string;
    target?: string;
    riskFlags?: string[];
    fresh?: boolean;
  }[];
  summary: string[];
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Prueft den minimalen Rendervertrag, nicht nur `ok === true`.
 *
 * Die Listen sind Pflicht, weil die Reports-Ansicht sie direkt mappt bzw. ihre
 * Laenge rendert. Die fuenf numerischen KPI-Felder werden ebenfalls geprueft,
 * da der Renderer sie formatiert. Einzelne optionale Felder bleiben bewusst
 * optional und werden in der UI defensiv dargestellt.
 */
export function isReportData(value: unknown): value is ReportData {
  if (!isRecord(value) || value.ok !== true) return false;
  if (typeof value.period !== "string" || typeof value.since !== "string") return false;
  if (!isRecord(value.kpis)) return false;

  const kpis = value.kpis;
  if (
    !isFiniteNumber(kpis.trades) ||
    !isFiniteNumber(kpis.realizedPnl) ||
    !isFiniteNumber(kpis.maxDrawdownPct) ||
    !isFiniteNumber(kpis.stopLossHits) ||
    !isFiniteNumber(kpis.takeProfitHits)
  ) {
    return false;
  }

  return (
    Array.isArray(value.symbols) &&
    Array.isArray(value.blocks) &&
    Array.isArray(value.notableEvents) &&
    Array.isArray(value.recommendations) &&
    Array.isArray(value.summary)
  );
}

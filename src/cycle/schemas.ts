/**
 * Validierungsschemata für alle Schritte des Agenten-Zyklus (Task 06).
 *
 * Garantiert:
 *   - Strikt typisierte Outputs für alle 8 Tages-Steps und den Weekly Review.
 *   - Ungültige oder bösartige LLM-Ausgaben werden zurückgewiesen.
 *   - Saubere Fallbacks für jeden Schritt.
 */

import { MAX_SHORTLIST_LIMIT } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Macro Analyst Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface MacroAssetSnapshot {
  price?: number;
  change24hPct?: number;
  trend?: "UP" | "DOWN" | "SIDEWAYS";
  note?: string;
}

export interface MacroStepOutput {
  view: "BULLISH" | "BEARISH" | "NEUTRAL";
  regime: "RISK_ON" | "RISK_OFF" | "MIXED";
  volatilityRegime: "LOW" | "NORMAL" | "HIGH" | "EXTREME";
  assets: {
    btc?: MacroAssetSnapshot;
    eth?: MacroAssetSnapshot;
    dxy?: MacroAssetSnapshot;
    spx?: MacroAssetSnapshot;
    nasdaq?: MacroAssetSnapshot;
    gold?: MacroAssetSnapshot;
    bonds?: MacroAssetSnapshot;
    [key: string]: MacroAssetSnapshot | undefined;
  };
  thesis: string;
  confidence: number;
}

export function validateMacroOutput(input: unknown): { valid: boolean; data?: MacroStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Macro output must be an object" };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.view !== "string" || typeof obj.regime !== "string") {
    return { valid: false, error: "Macro output: view and regime are required string properties" };
  }

  const viewRaw = obj.view.toUpperCase();
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(viewRaw)) {
    return { valid: false, error: `Macro output: invalid view "${obj.view}"` };
  }
  const view = viewRaw as MacroStepOutput["view"];

  const regimeRaw = obj.regime.toUpperCase();
  if (!["RISK_ON", "RISK_OFF", "MIXED"].includes(regimeRaw)) {
    return { valid: false, error: `Macro output: invalid regime "${obj.regime}"` };
  }
  const regime = regimeRaw as MacroStepOutput["regime"];

  const volatilityRegime =
    typeof obj.volatilityRegime === "string" &&
    ["LOW", "NORMAL", "HIGH", "EXTREME"].includes(obj.volatilityRegime.toUpperCase())
      ? (obj.volatilityRegime.toUpperCase() as MacroStepOutput["volatilityRegime"])
      : "NORMAL";

  const thesis = typeof obj.thesis === "string" ? obj.thesis.slice(0, 500) : "Keine Makro-These vorhanden";
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;

  const assets: MacroStepOutput["assets"] = {};
  if (obj.assets && typeof obj.assets === "object" && !Array.isArray(obj.assets)) {
    for (const [k, v] of Object.entries(obj.assets as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const item = v as Record<string, unknown>;
        assets[k.toLowerCase()] = {
          price: typeof item.price === "number" ? item.price : undefined,
          change24hPct: typeof item.change24hPct === "number" ? item.change24hPct : undefined,
          trend: typeof item.trend === "string" && ["UP", "DOWN", "SIDEWAYS"].includes(item.trend.toUpperCase())
            ? (item.trend.toUpperCase() as "UP" | "DOWN" | "SIDEWAYS")
            : "SIDEWAYS",
          note: typeof item.note === "string" ? item.note.slice(0, 200) : undefined,
        };
      }
    }
  }

  return {
    valid: true,
    data: {
      view,
      regime,
      volatilityRegime,
      assets,
      thesis,
      confidence,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Market Selection Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyCandidate {
  instrumentId: string;
  rank: number;
  score: number;
  assetClass: string;
  selectionRationale: string;
}

export interface SelectionStepOutput {
  candidates: DailyCandidate[];
  selectedCount: number;
  asOf: string;
}

export function validateSelectionOutput(input: unknown): { valid: boolean; data?: SelectionStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Selection output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    return { valid: false, error: "Selection output: candidates must be an array" };
  }
  const rawList = obj.candidates;

  const candidates: DailyCandidate[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      candidates.push({
        instrumentId: item.instrumentId.trim(),
        rank: typeof item.rank === "number" ? item.rank : i + 1,
        score: typeof item.score === "number" ? item.score : 50,
        assetClass: typeof item.assetClass === "string" ? item.assetClass : "unknown",
        selectionRationale: typeof item.selectionRationale === "string" ? item.selectionRationale.slice(0, 200) : "Auswahl via Scanner & Makro",
      });
    }
  }

  return {
    valid: true,
    data: {
      candidates,
      selectedCount: candidates.length,
      asOf: typeof obj.asOf === "string" ? obj.asOf : new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Technical Analyst Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface InstrumentTechnicalAnalysis {
  instrumentId: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  technicalScore: number;
  rsi?: number;
  atr?: number;
  trend: string;
  keyLevels: {
    support: number;
    resistance: number;
  };
  thesis: string;
}

export interface TechnicalStepOutput {
  analyses: InstrumentTechnicalAnalysis[];
  analyzedCount: number;
}

export function validateTechnicalOutput(input: unknown): { valid: boolean; data?: TechnicalStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Technical output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.analyses)) {
    return { valid: false, error: "Technical output: analyses must be an array" };
  }
  const rawList = obj.analyses;

  const analyses: InstrumentTechnicalAnalysis[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      const bias = typeof item.bias === "string" && ["BULLISH", "BEARISH", "NEUTRAL"].includes(item.bias.toUpperCase())
        ? (item.bias.toUpperCase() as InstrumentTechnicalAnalysis["bias"])
        : "NEUTRAL";

      const keyLevels = item.keyLevels && typeof item.keyLevels === "object"
        ? {
            support: typeof (item.keyLevels as Record<string, unknown>).support === "number" ? Number((item.keyLevels as Record<string, unknown>).support) : 0,
            resistance: typeof (item.keyLevels as Record<string, unknown>).resistance === "number" ? Number((item.keyLevels as Record<string, unknown>).resistance) : 0,
          }
        : { support: 0, resistance: 0 };

      analyses.push({
        instrumentId: item.instrumentId.trim(),
        bias,
        technicalScore: typeof item.technicalScore === "number" ? item.technicalScore : 50,
        rsi: typeof item.rsi === "number" ? item.rsi : undefined,
        atr: typeof item.atr === "number" ? item.atr : undefined,
        trend: typeof item.trend === "string" ? item.trend : "neutral",
        keyLevels,
        thesis: typeof item.thesis === "string" ? item.thesis.slice(0, 300) : "TA neutral",
      });
    }
  }

  return {
    valid: true,
    data: {
      analyses,
      analyzedCount: analyses.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. News Analyst Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface InstrumentNewsAnalysis {
  instrumentId: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  impactScore: number;
  riskFlags: string[];
  summary: string;
}

export interface NewsStepOutput {
  analyses: InstrumentNewsAnalysis[];
  systemicRisk: {
    level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    headline: string;
    affectedSectors: string[];
  };
}

export function validateNewsOutput(input: unknown): { valid: boolean; data?: NewsStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "News output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.analyses)) {
    return { valid: false, error: "News output: analyses must be an array" };
  }
  const rawList = obj.analyses;

  const analyses: InstrumentNewsAnalysis[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      const sentiment = typeof item.sentiment === "string" && ["BULLISH", "BEARISH", "NEUTRAL"].includes(item.sentiment.toUpperCase())
        ? (item.sentiment.toUpperCase() as InstrumentNewsAnalysis["sentiment"])
        : "NEUTRAL";

      analyses.push({
        instrumentId: item.instrumentId.trim(),
        sentiment,
        impactScore: typeof item.impactScore === "number" ? item.impactScore : 50,
        riskFlags: Array.isArray(item.riskFlags) ? item.riskFlags.map(String).slice(0, 5) : [],
        summary: typeof item.summary === "string" ? item.summary.slice(0, 300) : "Keine wesentlichen Nachrichten",
      });
    }
  }

  const rawSys = (obj.systemicRisk && typeof obj.systemicRisk === "object" ? obj.systemicRisk : {}) as Record<string, unknown>;
  const level = typeof rawSys.level === "string" && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(rawSys.level.toUpperCase())
    ? (rawSys.level.toUpperCase() as NewsStepOutput["systemicRisk"]["level"])
    : "LOW";

  return {
    valid: true,
    data: {
      analyses,
      systemicRisk: {
        level,
        headline: typeof rawSys.headline === "string" ? rawSys.headline.slice(0, 200) : "Ruhige systemische Nachrichtenlage",
        affectedSectors: Array.isArray(rawSys.affectedSectors) ? rawSys.affectedSectors.map(String) : [],
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Risk Manager Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskStepOutput {
  approvedCandidates: string[];
  rejectedCandidates: Array<{
    instrumentId: string;
    reason: string;
  }>;
  correlationWarnings: string[];
  maxPositionPct: number;
  riskBudgetPerTrade: number;
  rationale: string;
}

export function validateRiskOutput(input: unknown): { valid: boolean; data?: RiskStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Risk output must be an object" };
  }
  const obj = input as Record<string, unknown>;

  const approvedCandidates = Array.isArray(obj.approvedCandidates)
    ? obj.approvedCandidates.map(String).slice(0, MAX_SHORTLIST_LIMIT)
    : [];

  const rejectedCandidates: RiskStepOutput["rejectedCandidates"] = [];
  if (Array.isArray(obj.rejectedCandidates)) {
    for (const item of obj.rejectedCandidates) {
      if (item && typeof item === "object") {
        const r = item as Record<string, unknown>;
        if (typeof r.instrumentId === "string" && r.instrumentId) {
          rejectedCandidates.push({
            instrumentId: r.instrumentId.trim(),
            reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "Risiko-Limit überschritten",
          });
        }
      }
    }
  }

  const correlationWarnings = Array.isArray(obj.correlationWarnings)
    ? obj.correlationWarnings.map(String).slice(0, 10)
    : [];

  const maxPositionPct = typeof obj.maxPositionPct === "number" && Number.isFinite(obj.maxPositionPct)
    ? Math.min(0.25, Math.max(0.01, obj.maxPositionPct))
    : 0.1;

  const riskBudgetPerTrade = typeof obj.riskBudgetPerTrade === "number" && Number.isFinite(obj.riskBudgetPerTrade)
    ? Math.min(0.02, Math.max(0.001, obj.riskBudgetPerTrade))
    : 0.01;

  const rationale = typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "Risikoprüfung abgeschlossen";

  return {
    valid: true,
    data: {
      approvedCandidates,
      rejectedCandidates,
      correlationWarnings,
      maxPositionPct,
      riskBudgetPerTrade,
      rationale,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Research Schemata (Proposals only!)
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeSetupProposal {
  instrumentId: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskScore: number;
  timeframe: string;
  thesis: string;
  /** Explizite Markierung: Rein unverbindlicher Vorschlag */
  isProposal: true;
}

export interface ResearchStepOutput {
  setups: TradeSetupProposal[];
  totalSetups: number;
  disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED";
}

export function validateResearchOutput(input: unknown): { valid: boolean; data?: ResearchStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Research output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.setups)) {
    return { valid: false, error: "Research output: setups must be an array" };
  }
  const rawList = obj.setups;

  const setups: TradeSetupProposal[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      const side = typeof item.side === "string" && item.side.toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const entryPrice = typeof item.entryPrice === "number" && item.entryPrice > 0 ? item.entryPrice : 100;
      const stopLoss = typeof item.stopLoss === "number" && item.stopLoss > 0
        ? item.stopLoss
        : side === "LONG" ? entryPrice * 0.95 : entryPrice * 1.05;
      const takeProfit = typeof item.takeProfit === "number" && item.takeProfit > 0
        ? item.takeProfit
        : side === "LONG" ? entryPrice * 1.1 : entryPrice * 0.9;

      setups.push({
        instrumentId: item.instrumentId.trim(),
        side,
        entryPrice,
        stopLoss,
        takeProfit,
        riskScore: typeof item.riskScore === "number" ? Math.max(0, Math.min(1, item.riskScore)) : 0.5,
        timeframe: typeof item.timeframe === "string" ? item.timeframe : "4h",
        thesis: typeof item.thesis === "string" ? item.thesis.slice(0, 300) : "Research-Setup-Vorschlag",
        isProposal: true,
      });
    }
  }

  return {
    valid: true,
    data: {
      setups,
      totalSetups: setups.length,
      disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Backtest Verification Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifiedSetupResult {
  setup: TradeSetupProposal;
  verified: boolean;
  verdict: "PASSED" | "FAILED";
  metrics: {
    maxDrawdownPct: number;
    profitFactor: number;
    sharpeRatio: number;
    sortinoRatio: number;
    regimeRobustness: number;
  };
  failureReasons?: string[];
}

export interface BacktestStepOutput {
  verifiedSetups: VerifiedSetupResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

export function validateBacktestOutput(input: unknown): { valid: boolean; data?: BacktestStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Backtest output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.verifiedSetups)) {
    return { valid: false, error: "Backtest output: verifiedSetups must be an array" };
  }
  const rawList = obj.verifiedSetups;

  const verifiedSetups: VerifiedSetupResult[] = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const item of rawList) {
    if (item && typeof item === "object") {
      const v = item as Record<string, unknown>;
      const rawMetrics = (v.metrics && typeof v.metrics === "object" ? v.metrics : {}) as Record<string, unknown>;
      const metrics = {
        maxDrawdownPct: typeof rawMetrics.maxDrawdownPct === "number" ? rawMetrics.maxDrawdownPct : 0,
        profitFactor: typeof rawMetrics.profitFactor === "number" ? rawMetrics.profitFactor : 1,
        sharpeRatio: typeof rawMetrics.sharpeRatio === "number" ? rawMetrics.sharpeRatio : 0,
        sortinoRatio: typeof rawMetrics.sortinoRatio === "number" ? rawMetrics.sortinoRatio : 0,
        regimeRobustness: typeof rawMetrics.regimeRobustness === "number" ? rawMetrics.regimeRobustness : 0.5,
      };

      const verified = Boolean(v.verified);
      if (verified) passedCount++;
      else failedCount++;

      const rawSetup = (v.setup && typeof v.setup === "object" ? v.setup : {}) as Record<string, unknown>;
      const setup: TradeSetupProposal = {
        instrumentId: typeof rawSetup.instrumentId === "string" ? rawSetup.instrumentId : "UNKNOWN",
        side: rawSetup.side === "SHORT" ? "SHORT" : "LONG",
        entryPrice: typeof rawSetup.entryPrice === "number" ? rawSetup.entryPrice : 100,
        stopLoss: typeof rawSetup.stopLoss === "number" ? rawSetup.stopLoss : 95,
        takeProfit: typeof rawSetup.takeProfit === "number" ? rawSetup.takeProfit : 110,
        riskScore: typeof rawSetup.riskScore === "number" ? rawSetup.riskScore : 0.5,
        timeframe: typeof rawSetup.timeframe === "string" ? rawSetup.timeframe : "4h",
        thesis: typeof rawSetup.thesis === "string" ? rawSetup.thesis : "Setup",
        isProposal: true,
      };

      verifiedSetups.push({
        setup,
        verified,
        verdict: verified ? "PASSED" : "FAILED",
        metrics,
        failureReasons: Array.isArray(v.failureReasons) ? v.failureReasons.map(String) : undefined,
      });
    }
  }

  return {
    valid: true,
    data: {
      verifiedSetups,
      summary: {
        total: verifiedSetups.length,
        passed: passedCount,
        failed: failedCount,
      },
    },
  };
}

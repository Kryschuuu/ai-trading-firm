/**
 * Step 7: Research (nach 10:00 UTC).
 *
 * Generiert konkrete Trade-Setups für vom Risk Manager freigegebene Kandidaten.
 *
 * HARTE SICHERHEITS-GARANTIE:
 * Setups sind AUSSCHLIESSLICH VORSCHLÄGE (isProposal: true).
 * Dieser Schritt platziert KEINE Orders und verändert KEINE Broker-Zustände.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type ResearchStepOutput, validateResearchOutput, type TradeSetupProposal } from "../schemas";
import { assertShortlistLimit } from "../security";
import type { RiskStepOutput, TechnicalStepOutput } from "../schemas";
import { HistoricalStore, DEFAULT_ANALYSIS_TIMEFRAME } from "@/lib/marketdata/historicalStore";
import { historyDir } from "@/lib/marketdata/config";
import {
  adaptResearchOutput,
  plausibilityAuditReason,
  toStepStatus,
  type PlausibilityCandle,
  type PlausibilityStepStatus,
} from "../plausibility";

/**
 * Research-Output mit sichtbarem Plausibilitäts-Status (GAP-08, v1.49.0).
 * Das Feld hängt der STEP an (nie das LLM — der Schema-Validator übernimmt
 * es bewusst nicht); es landet im Tages-Artefakt `07-research.json`.
 */
export type ResearchStepOutputWithStatus = ResearchStepOutput & {
  plausibility?: PlausibilityStepStatus;
};

/**
 * Lädt Referenzkerzen (Known-Good-Kurse) je Instrument aus dem
 * HistoricalStore — best-effort: Fehlt der Store oder eine Reihe, melden die
 * preisbezogenen Plausibilitäts-Regeln `referenceMissing` statt zu raten.
 * Der Pfad folgt `PAPER_HISTORY_DIR` (Tests injizieren ein Temp-Verzeichnis).
 */
function loadReferenceCandles(symbols: readonly string[]): Record<string, PlausibilityCandle[]> {
  const out: Record<string, PlausibilityCandle[]> = {};
  try {
    const store = new HistoricalStore(historyDir());
    for (const symbol of symbols.slice(0, 40)) {
      try {
        const rows = store.query({
          instrumentId: symbol,
          timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
          limit: 120,
        });
        const candles = rows
          .filter(
            (row) =>
              Number.isFinite(row.close) &&
              row.close > 0 &&
              Number.isFinite(row.high) &&
              Number.isFinite(row.low),
          )
          .map((row) => ({ close: row.close, high: row.high, low: row.low }));
        if (candles.length > 0) out[symbol] = candles;
      } catch {
        // Einzelne Reihe fehlt/fehlerhaft → referenceMissing für dieses Symbol.
      }
    }
  } catch {
    // Store nicht lesbar → alle preisbezogenen Regeln melden referenceMissing.
  }
  return out;
}

export interface ResearchStepInput {
  approvedCandidates?: string[];
}

export const researchStep: StepDefinition<ResearchStepInput, ResearchStepOutputWithStatus> = {
  stepId: "07-research",
  name: "Research",
  role: "RESEARCH",
  timeWindow: "11:00-12:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<ResearchStepInput>): Promise<ResearchStepOutputWithStatus> {
    const riskOutput = context.previousStepOutputs["06-risk-manager"] as RiskStepOutput | undefined;
    const techOutput = context.previousStepOutputs["04-technical-analyst"] as TechnicalStepOutput | undefined;

    const approved =
      context.input?.approvedCandidates ??
      riskOutput?.approvedCandidates ??
      [];

    assertShortlistLimit(approved, 40);

    context.log(`Erzeuge konkrete Setup-Vorschläge für ${approved.length} freigegebene Instrumente …`);

    // Deterministischer Fallback für Setups
    const defaultSetups: TradeSetupProposal[] = approved.slice(0, 10).map((sym) => {
      const ta = techOutput?.analyses.find((a) => a.instrumentId === sym);
      const isBull = ta?.bias === "BULLISH";
      const entryPrice = ta?.keyLevels.support && ta.keyLevels.support > 0 ? ta.keyLevels.support * 1.01 : 100;
      const stopLoss = isBull ? entryPrice * 0.95 : entryPrice * 1.05;
      const takeProfit = isBull ? entryPrice * 1.10 : entryPrice * 0.90;

      return {
        instrumentId: sym,
        side: isBull ? "LONG" : "SHORT",
        entryPrice: Number(entryPrice.toFixed(2)),
        stopLoss: Number(stopLoss.toFixed(2)),
        takeProfit: Number(takeProfit.toFixed(2)),
        riskScore: 0.5,
        timeframe: "4h",
        thesis: `Deterministisches ${isBull ? "Long" : "Short"}-Setup an Unterstützungs-/Widerstandsniveau`,
        isProposal: true,
      };
    });

    const fallback: ResearchStepOutput = {
      setups: defaultSetups,
      totalSetups: defaultSetups.length,
      disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
    };

    if (approved.length === 0) {
      return fallback;
    }

    const systemPrompt = `You are the Research Analyst of an autonomous trading firm.
Formulate concrete, disciplined trade setups for the approved candidate instruments.
SECURITY MANDATE: Your outputs are strictly PROPOSALS for evaluation. No execution occurs.
Specify exact entry, stop loss (mandatory), and take profit targets.
Respond strictly in JSON conforming to the schema.`;

    const userPrompt = `Formulate setups for approved instruments:
${JSON.stringify(approved)}
Technical context:
${JSON.stringify(techOutput?.analyses.slice(0, 40))}
JSON schema:
{
  "setups": [
    {
      "instrumentId": "string",
      "side": "LONG|SHORT",
      "entryPrice": 100.0,
      "stopLoss": 95.0,
      "takeProfit": 110.0,
      "riskScore": 0.4,
      "timeframe": "4h",
      "thesis": "string",
      "isProposal": true
    }
  ],
  "totalSetups": number,
  "disclaimer": "PROPOSAL_ONLY_NO_ORDERS_PLACED"
}`;

    // GAP-08: Plausibilitäts-Schicht über den Setup-Outputs (Monotonie,
    // Preisband um Known-Good-Kurse, Confidence/Begründung, Zahlenbezug).
    const candlesByInstrument = loadReferenceCandles(approved);

    const res = await context.ports.agent.invokeAgent<ResearchStepOutput>({
      role: "RESEARCH",
      systemPrompt,
      userPrompt,
      untrustedData: { approvedSymbols: approved },
      schemaValidator: validateResearchOutput,
      fallback,
      plausibility: {
        adapt: adaptResearchOutput,
        candlesByInstrument,
        fieldPrefix: "setups",
      },
    });

    // Fail-closed: Nach dem (einzigen) Plausibilitäts-Retry bleibt ein
    // unplausibler Output ein Skip — deterministischer Leer-Fallback, Audit
    // `CYCLE_STEP_SKIPPED` (Grund `plausibility:CODE`) und sichtbarer Status
    // im Output/Artefakt. Kein Setup-Export aus verworfenen Antworten.
    if (res.plausibility?.status === "SKIPPED") {
      const reason = plausibilityAuditReason(res.plausibility);
      await context.ports.audit.logEvent({
        event: "CYCLE_STEP_SKIPPED",
        level: "WARN",
        cycleId: context.cycleId,
        stepId: "07-research",
        role: "RESEARCH",
        timestamp: context.clock.toISOString(),
        detail: {
          reason,
          findings: res.plausibility.findings.map((f) => ({
            code: f.code,
            field: f.field,
            detail: f.detail,
          })),
          attempts: res.plausibility.attempts,
          approvedCount: approved.length,
          referenceMissing: res.plausibility.referenceMissingInstruments,
        },
      });
      context.log(
        `Research-Output verworfen (${reason}) — deterministischer Leer-Fallback, kein Setup-Export.`,
        "WARN",
      );
      const skipped: ResearchStepOutput = {
        setups: [],
        totalSetups: 0,
        disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
      };
      return { ...skipped, plausibility: toStepStatus(res.plausibility) };
    }

    if (res.plausibility) {
      return { ...res.output, plausibility: toStepStatus(res.plausibility) };
    }
    return res.output;
  },
};

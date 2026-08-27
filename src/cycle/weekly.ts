/**
 * Weekly Universe Review (Task 06).
 *
 * Führt 1× wöchentlich die Klassifikation des gesamten Universums durch:
 *   - CORE / ROTATION / DISCOVERY / EXCLUDED je Instrument mit reasons[]
 *   - Eingehende Signale: Neue Listings, Delistings, Liquiditätsveränderungen,
 *     Regimewechsel, Korrelationen, Volatilitätscluster, strukturelle News,
 *     Broker-Verfügbarkeit, Gebührenänderungen.
 *   - Erzeugt valides WeeklyReview-Artefakt mit Zusammenfassung und Änderungen.
 */

import type { StepDefinition, StepExecutionContext } from "./types";
import {
  type WeeklyReview,
  type WeeklyClassificationEntry,
  type UniverseClass,
  type WeeklyChanges,
  classifyWeekly,
  validateWeeklyReview,
} from "@/scanner/weekly";
import { loadScannerConfig } from "@/scanner/config";
import { scanUniverse } from "@/scanner/pipeline";
import { historicalStoreProvider, loadAllInstruments } from "@/scanner/service";
import { HistoricalStore } from "@/lib/marketdata/historicalStore";

export interface WeeklyStepInput {
  previousReview?: WeeklyReview | null;
  structuralNews?: string[];
  delistings?: string[];
  newListings?: string[];
  brokerAvailability?: Record<string, boolean>;
  feeChanges?: Record<string, { oldFee: number; newFee: number }>;
}

export interface WeeklyStepOutput {
  review: WeeklyReview;
  synthesis?: {
    executiveSummary: string;
    macroRegime: string;
    weeklyThemes: string[];
  };
}

/**
 * Step für den Weekly Universe Review.
 */
export const weeklyReviewStep: StepDefinition<WeeklyStepInput, WeeklyStepOutput> = {
  stepId: "01-weekly-review",
  name: "Weekly Universe Review",
  role: "WEEKLY_REVIEW",
  timeWindow: "00:00-04:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<WeeklyStepInput>): Promise<WeeklyStepOutput> {
    context.log("Starte Weekly Universe Review (Klassifikation CORE / ROTATION / DISCOVERY / EXCLUDED) …");

    const config = loadScannerConfig();
    const instruments = loadAllInstruments();
    const store = new HistoricalStore();
    const data = historicalStoreProvider(store, config.factors.correlation.benchmarkInstrumentId);

    // 1. Tagesscan für den Stichtag
    const scan = scanUniverse({ instruments, data, asOf: context.asOf, config });

    // 2. Deterministische Basis-Klassifikation
    const baseReview = classifyWeekly({
      scan,
      instruments,
      previous: context.input?.previousReview ?? null,
      config,
    });

    // 3. Einarbeitung externer Signale (strukturelle News, Broker-Verfügbarkeit, Gebühren)
    const externalBroker = context.input?.brokerAvailability ?? {};
    const externalFees = context.input?.feeChanges ?? {};
    const structuralNews = context.input?.structuralNews ?? [];

    const enrichedEntries: WeeklyClassificationEntry[] = baseReview.entries.map((entry) => {
      const reasons = [...entry.reasons];
      let assignedClass = entry.class;

      // Broker nicht verfügbar -> EXCLUDED
      if (externalBroker[entry.instrumentId] === false) {
        assignedClass = "EXCLUDED";
        if (!reasons.includes("broker-unavailable")) reasons.push("broker-unavailable");
      }

      // Gebührenerhöhung
      if (externalFees[entry.instrumentId]) {
        const feeChange = externalFees[entry.instrumentId];
        if (feeChange.newFee > feeChange.oldFee * 1.5) {
          if (!reasons.includes("fee-increase-50pct")) reasons.push("fee-increase-50pct");
        }
      }

      // Strukturelle News
      if (structuralNews.length > 0 && entry.score < 45) {
        if (!reasons.includes("structural-news-risk")) reasons.push("structural-news-risk");
      }

      return {
        ...entry,
        class: assignedClass,
        reasons: reasons.slice(0, 20),
      };
    });

    // Summary neu aggregieren
    const summary: Record<UniverseClass, number> = { CORE: 0, ROTATION: 0, DISCOVERY: 0, EXCLUDED: 0 };
    for (const e of enrichedEntries) {
      summary[e.class] += 1;
    }

    const changes: WeeklyChanges = {
      ...baseReview.changes,
      newListings: [...baseReview.changes.newListings, ...(context.input?.newListings ?? [])],
      delistings: [...baseReview.changes.delistings, ...(context.input?.delistings ?? [])],
    };

    const finalReview: WeeklyReview = {
      schemaVersion: 1,
      configVersion: config.version,
      asOf: context.asOf.toISOString(),
      entries: enrichedEntries,
      summary,
      changes,
      context: baseReview.context,
    };

    // Validierung gegen den strengen Contract
    const validatedReview = validateWeeklyReview(finalReview);

    // 4. LLM-Synthese des Reviews (Qualitative Einordnung)
    const fallbackSynthesis = {
      executiveSummary: `Weekly Universe Review: ${summary.CORE} CORE, ${summary.ROTATION} ROTATION, ${summary.DISCOVERY} DISCOVERY, ${summary.EXCLUDED} EXCLUDED.`,
      macroRegime: "NORMAL",
      weeklyThemes: ["Deterministische Wocheneinordnung", "Stabilität im Kernuniversum"],
    };

    const systemPrompt = `You are the Lead Universe Strategist of an autonomous trading firm.
Analyze the weekly universe classification results:
CORE: ${summary.CORE}, ROTATION: ${summary.ROTATION}, DISCOVERY: ${summary.DISCOVERY}, EXCLUDED: ${summary.EXCLUDED}.
Provide a concise executive summary and 2-3 key weekly themes.
Respond strictly in JSON matching the schema:
{"executiveSummary": "string", "macroRegime": "string", "weeklyThemes": ["string"]}`;

    const userPrompt = `Synthesize the weekly universe shifts.
Changes detected:
- New listings: ${changes.newListings.length}
- Delistings: ${changes.delistings.length}
- Liquidity drops: ${changes.liquidityDrops.length}
- Regime shifts: ${changes.regimeShifts.length}
Output strictly valid JSON.`;

    const res = await context.ports.agent.invokeAgent<{
      executiveSummary: string;
      macroRegime: string;
      weeklyThemes: string[];
    }>({
      role: "WEEKLY_REVIEW",
      systemPrompt,
      userPrompt,
      untrustedData: { changes, summary },
      schemaValidator: (parsed) => {
        if (!parsed || typeof parsed !== "object") return { valid: false, error: "Not an object" };
        const p = parsed as Record<string, unknown>;
        return {
          valid: true,
          data: {
            executiveSummary: typeof p.executiveSummary === "string" ? p.executiveSummary : fallbackSynthesis.executiveSummary,
            macroRegime: typeof p.macroRegime === "string" ? p.macroRegime : "NORMAL",
            weeklyThemes: Array.isArray(p.weeklyThemes) ? p.weeklyThemes.map(String) : fallbackSynthesis.weeklyThemes,
          },
        };
      },
      fallback: fallbackSynthesis,
    });

    context.log(
      `Weekly Review abgeschlossen: CORE ${summary.CORE} · ROTATION ${summary.ROTATION} · DISCOVERY ${summary.DISCOVERY} · EXCLUDED ${summary.EXCLUDED}`
    );

    return {
      review: validatedReview,
      synthesis: res.output,
    };
  },
};

/**
 * Erzeugt die Schritte für den wöchentlichen Universe-Review-Lauf.
 */
export function createWeeklySteps(): StepDefinition[] {
  return [weeklyReviewStep as unknown as StepDefinition];
}

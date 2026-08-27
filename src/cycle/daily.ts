/**
 * Tagespipeline für den Agenten-Zyklus (Task 06).
 *
 * Exakte Reihenfolge der 8 Schritte:
 *   1. 00:00–06:00  Market Scanner           (kein LLM)
 *   2. 06:00–07:00  Macro Analyst            (BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds + Volatilitätsregime)
 *   3. 07:00–08:00  Market Selection Agent   (erstellt Daily Candidate List)
 *   4. 08:00–09:00  Technical Analyst        (NUR Top-40 Code-Limit)
 *   5. 09:00–10:00  News Analyst             (NUR Top-40 + systemische Nachrichten)
 *   6. 10:00–11:00  Risk Manager             (Korrelation + Portfolio Exposure)
 *   7. danach       Research                 (konkrete Setups — nur Vorschläge)
 *   8. danach       Backtest-Verifikation    (MaxDD, Profit Factor, Sharpe, Sortino, Robustness)
 */

import type { StepDefinition } from "./types";
import { scannerStep } from "./steps/scannerStep";
import { macroStep } from "./steps/macroStep";
import { selectionStep } from "./steps/selectionStep";
import { technicalStep } from "./steps/technicalStep";
import { newsStep } from "./steps/newsStep";
import { riskStep } from "./steps/riskStep";
import { researchStep } from "./steps/researchStep";
import { backtestStep } from "./steps/backtestStep";

/**
 * Erzeugt die geordnete Liste aller 8 Schritte der Tagespipeline.
 */
export function createDailySteps(): StepDefinition[] {
  return [
    scannerStep as unknown as StepDefinition,
    macroStep as unknown as StepDefinition,
    selectionStep as unknown as StepDefinition,
    technicalStep as unknown as StepDefinition,
    newsStep as unknown as StepDefinition,
    riskStep as unknown as StepDefinition,
    researchStep as unknown as StepDefinition,
    backtestStep as unknown as StepDefinition,
  ];
}

/** Definition der Zeitfenster und Rollen als Referenz */
export const DAILY_CYCLE_SCHEDULE = [
  { stepId: "01-market-scanner", role: "MARKET_SCANNER", timeWindow: "00:00-06:00", llmAllowed: false },
  { stepId: "02-macro-analyst", role: "MACRO_ANALYST", timeWindow: "06:00-07:00", llmAllowed: true },
  { stepId: "03-market-selection", role: "MARKET_SELECTION", timeWindow: "07:00-08:00", llmAllowed: true },
  { stepId: "04-technical-analyst", role: "TECHNICAL_ANALYST", timeWindow: "08:00-09:00", llmAllowed: true, limit: 40 },
  { stepId: "05-news-analyst", role: "NEWS_ANALYST", timeWindow: "09:00-10:00", llmAllowed: true, limit: 40 },
  { stepId: "06-risk-manager", role: "RISK_MANAGER", timeWindow: "10:00-11:00", llmAllowed: true },
  { stepId: "07-research", role: "RESEARCH", timeWindow: "11:00-12:00", llmAllowed: true },
  { stepId: "08-backtest-verification", role: "BACKTEST_VERIFICATION", timeWindow: "12:00-13:00", llmAllowed: false },
] as const;

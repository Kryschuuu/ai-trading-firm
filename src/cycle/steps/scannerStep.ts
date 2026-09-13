/**
 * Step 1: Market Scanner (00:00–06:00 UTC).
 *
 * Deterministischer Scan über das Universum (Task 04).
 * HARTE ARCHITEKTUR-REGEL: KEIN LLM-Import, kein LLM-Aufruf.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import type { DailyUniverseArtifact } from "@/scanner/artifacts";

export interface ScannerStepInput {
  asOf?: string;
}

export const scannerStep: StepDefinition<
  ScannerStepInput,
  DailyUniverseArtifact
> = {
  stepId: "01-market-scanner",
  name: "Market Scanner",
  role: "MARKET_SCANNER",
  timeWindow: "00:00-06:00",
  llmAllowed: false, // VERBINDLICH: Kein LLM im Scanner
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 100,
  },

  async execute(
    context: StepExecutionContext<ScannerStepInput>,
  ): Promise<DailyUniverseArtifact> {
    context.log("Starte deterministischen Markt-Scan …");
    const scanArtifact = await context.ports.scanner.runScan(context.asOf);
    const readiness = scanArtifact.readiness;
    const readinessLine = readiness
      ? ` Readiness ${readiness.status} (${readiness.warmed}/${readiness.instruments} gewärmt, ${readiness.outOfScope} außer Scope).`
      : "";
    context.log(
      `Scan abgeschlossen: ${scanArtifact.funnel.scanned} gescannt, ${scanArtifact.funnel.eligible} geeignet, ` +
        `${scanArtifact.funnel.daily} Daily, ${scanArtifact.funnel.deep} Deep.${readinessLine}`,
    );
    // Bei WARMING/ERROR wird der Zyklus NICHT abgebrochen (die Fachschritte
    // reagieren mit leeren, ehrlichen Fallbacks), aber die Ursache ist
    // auditierbar: Datenproblem statt „keine Marktchance“.
    if (readiness && readiness.status !== "READY") {
      context.log(
        readiness.status === "ERROR"
          ? `Scanner-Readiness ERROR: ${readiness.error}`
          : `Scanner-Readiness WARMING: ${readiness.missing} Instrument(e) unter ${readiness.requiredCandles} Kerzen — Market-Data-Sync nachziehen.`,
      );
    }
    return scanArtifact;
  },
};

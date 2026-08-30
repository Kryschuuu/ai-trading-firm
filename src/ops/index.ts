/**
 * Operations Center — öffentliche Fassade (Task 10).
 *
 * Aggregationsschicht über bestehende Module. Sie liest, rechnet nichts neu
 * und speichert nichts: Universum, Scanner, Portfolio, Zyklen, Broker,
 * Routing, Agenten, Risiko, Audit und Hilfe werden nur **zusammengeführt**
 * und in das Anzeigeformat projiziert.
 *
 * ```ts
 * import { buildOperationsCenter } from "@/ops";
 * const payload = await buildOperationsCenter(resolveActor(req));
 * ```
 *
 * Architekturgrenze: Dieses Modul ist serverseitig (liest Dateisystem und
 * Datenbank über bestehende Fassaden) und gehört hinter read-only GET-Routen.
 * Es enthält keine Mutation, kein Secret und keinen Order-Pfad.
 */
import { buildOpsPayload } from "@/auth/ops";
import type { Actor } from "@/auth/types";

import { collectMarketDataExtras, collectSectionData, MAX_SECTION_ITEMS } from "./collect";
import { isOpsSectionId, OPS_SECTION_IDS, OPS_SECTION_STATUSES } from "./types";
import type { OpsPayload } from "./types";

export type {
  OpsHealth,
  OpsItem,
  OpsMetric,
  OpsPayload,
  OpsSection,
  OpsSectionData,
  OpsSectionDefinition,
  OpsSectionId,
  OpsSectionStatus,
  OpsTone,
} from "./types";

export { OPS_SECTION_IDS, OPS_SECTION_STATUSES, isOpsSectionId };
export { collectMarketDataExtras, collectSectionData, MAX_SECTION_ITEMS };
export type { OpsMarketDataExtras } from "./collect";
export {
  collectMarketDataReadiness,
  DISCOVERY_FRESHNESS_WINDOW_MS,
  MULTI_VENUE_LABEL,
  type MarketDataReadinessInput,
  type MarketDataReadinessReport,
} from "./marketDataReadiness";
export type { EligibilityDiagnosticsSummary } from "@/scanner/eligibilityDiagnostics";

/**
 * Baut den vollständigen Operations-Center-Payload.
 *
 * Reihenfolge: erst alle Kollektoren parallel (fail-soft je Sektion), dann
 * Zusammenführen mit dem Katalog aus `src/auth/ops`. Die Market-Data-Readiness
 * wird additiv angehängt (OPS-010): schlägt ihre Aggregation fehl, steht
 * `null` im Payload — Sektionen und Funnel bleiben unverändert lesbar.
 */
export async function buildOperationsCenter(actor: Actor | null): Promise<OpsPayload> {
  const data = await collectSectionData();
  const extras = collectMarketDataExtras();
  return buildOpsPayload(actor, data, {
    marketDataReadiness: extras?.report ?? null,
    eligibilityDiagnostics: extras?.diagnostics ?? null,
  });
}

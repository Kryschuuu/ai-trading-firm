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

import { collectSectionData, MAX_SECTION_ITEMS } from "./collect";
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
export { collectSectionData, MAX_SECTION_ITEMS };

/**
 * Baut den vollständigen Operations-Center-Payload.
 *
 * Reihenfolge: erst alle Kollektoren parallel (fail-soft je Sektion), dann
 * Zusammenführen mit dem Katalog aus `src/auth/ops`.
 */
export async function buildOperationsCenter(actor: Actor | null): Promise<OpsPayload> {
  const data = await collectSectionData();
  return buildOpsPayload(actor, data);
}

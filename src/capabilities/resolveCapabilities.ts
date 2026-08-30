/**
 * @deprecated CAP-008: Nutze `projectInstrumentAvailability` aus
 * `src/universe/capabilityProjection.ts`. Diese Fassade bleibt für bestehende
 * Importe und delegiert 1:1 an den Projektor (fail-closed).
 *
 * liveTradable kommt aus den Stammdaten (Default false). liveAvailable ist
 * niemals ein Seed-Wert.
 */
import type { CapabilityMatrix } from "./matrix";
import {
  currentProjectionContext,
  projectInstrumentAvailability,
  type AvailabilityProjection,
} from "../universe/capabilityProjection";

export type ResolvedInstrumentCapabilities = {
  liveAvailable: boolean;
  liveTradable: boolean;
};

export function resolveInstrumentCapabilities(
  venue: string,
  capabilityMatrix: CapabilityMatrix,
  liveTradable = false,
): ResolvedInstrumentCapabilities {
  const projected: AvailabilityProjection = projectInstrumentAvailability(
    { venue, liveTradable, paperAvailable: true },
    { ...currentProjectionContext(), capabilities: capabilityMatrix },
  );
  return { liveAvailable: projected.liveAvailable, liveTradable: projected.liveTradable };
}

import type { CapabilityMatrix } from "./matrix";

export type ResolvedInstrumentCapabilities = {
  liveAvailable: boolean;
  liveTradable: boolean;
};

// SICHERHEITSRELEVANT: Diese Funktion ist die EINZIGE Quelle der Wahrheit für
// live-Handelsfähigkeit auf Instrument-Anzeige-/API-Ebene. Ein UI/API-Konsument,
// der liveAvailable=true für einen tatsächlichen Adapter-Stub anzeigt, kann
// einen Nutzer zu einem fehlschlagenden oder unvorhersehbaren Live-Trade-Versuch
// verleiten.
export function resolveInstrumentCapabilities(
  venue: string,
  capabilityMatrix: CapabilityMatrix,
): ResolvedInstrumentCapabilities {
  const cap = capabilityMatrix[venue];
  if (!cap) return { liveAvailable: false, liveTradable: false };
  return {
    liveAvailable: cap.marketData === true,
    liveTradable: cap.trading === true,
  };
}

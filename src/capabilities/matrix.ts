/**
 * Capability-Matrix (SSoT) für venue-weite Adapter-Fähigkeiten.
 *
 * Dieses Modul ist die stabile Import-Fassade für Laufzeit-Projektionen.
 * Die konkrete Tabelle bleibt in `src/brokers/capabilities.ts`, damit die
 * Broker-Factory und bestehende Tests ihre historische Importstelle behalten.
 */
import { VENUE_CAPABILITIES } from "../brokers/capabilities";
import type { BrokerCapabilities } from "../contracts/broker";

export type CapabilityMatrix = Record<string, BrokerCapabilities | undefined>;

/** Single Source of Truth für Adapter-Capabilities. */
export const capabilityMatrix: CapabilityMatrix = VENUE_CAPABILITIES;

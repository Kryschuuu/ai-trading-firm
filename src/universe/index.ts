/**
 * Öffentliche API des Market-Universe-Moduls (Task 01).
 *
 * ```ts
 * import { getRegistry } from "@/universe";
 *
 * const registry = getRegistry();                 // lädt lazy, seedet bei Bedarf
 * const page = registry.query({ venue: "BINANCE", status: "active" });
 * ```
 *
 * Der Kern ist deterministisch: kein LLM, kein Netzwerk, keine Broker-SDKs.
 */

export * from "./types";
export * from "./validation";
export * from "./normalization";
export * from "./policy";
export * from "./store";
export * from "./audit";
export * from "./registry";
export * from "./seed";
export * from "./watchlist";
export * from "./capabilityProjection";

import { InstrumentRegistry, type RegistryOptions } from "./registry";
import { SEED_INSTRUMENTS } from "./seed";

const GLOBAL = globalThis as typeof globalThis & { __universeRegistry?: InstrumentRegistry };

/**
 * Prozessweite Registry-Instanz (auch über Next.js-HMR stabil).
 *
 * Ist die Persistenz leer (frischer Clone, gelöschte Datei), wird einmalig der
 * Watchlist-Seed importiert — die Anwendung startet damit nie ohne Universum.
 */
export function getRegistry(options: RegistryOptions = {}): InstrumentRegistry {
  if (!GLOBAL.__universeRegistry) {
    const registry = new InstrumentRegistry(options);
    registry.load();
    if (registry.size === 0) {
      registry.upsertMany([...SEED_INSTRUMENTS], "seed:bootstrap", "SEED");
    }
    GLOBAL.__universeRegistry = registry;
  }
  return GLOBAL.__universeRegistry;
}

/** Nur für Tests: Singleton verwerfen, damit ein neues Datenverzeichnis greift. */
export function resetRegistryForTests(): void {
  delete GLOBAL.__universeRegistry;
}

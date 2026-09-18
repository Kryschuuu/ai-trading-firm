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
  } else {
    // Cross-Prozess-Sichtbarkeit (CLI `market:sync` ↔ Next.js-Server):
    // Der Singleton lebt im langlebigen Server-Prozess. Schreibt ein
    // separater CLI-Prozess neue Instrumente, muss der Server sie beim
    // nächsten Zugriff sehen — sonst zeigt das Ops-Center dauerhaft 26
    // statt 250. `InstrumentRegistry.load()` prüft seit v1.40.0 die
    // Datei-Metadaten (mtime + Größe) und lädt transparent neu, wenn sie
    // sich geändert hat; hier reicht ein billiger `load()`-Aufruf (kein
    // Force, nur Stat-Check, kein File-Read wenn unverändert).
    try {
      GLOBAL.__universeRegistry.load();
    } catch {
      // best-effort: bei Stat/Read-Fehler bleibt der letzte bekannte Stand
      // sichtbar (fail-soft, nie crashen im Request-Pfad).
    }
  }
  return GLOBAL.__universeRegistry;
}

/** Nur für Tests: Singleton verwerfen, damit ein neues Datenverzeichnis greift. */
export function resetRegistryForTests(): void {
  delete GLOBAL.__universeRegistry;
}

/**
 * Öffentliche API des Scanner-Moduls (Task 04).
 *
 * ```ts
 * import { scanUniverse, writeDailyArtifact, classifyWeekly } from "@/scanner";
 *
 * const scan = scanUniverse({ instruments, data, asOf: "2026-08-27T00:00:00.000Z" });
 * scan.funnel.daily;                       // Top-100 Rotation
 * writeDailyArtifact(scan);                // artifacts/2026-08-27/universe.json
 * classifyWeekly({ scan, instruments });   // CORE/ROTATION/DISCOVERY/EXCLUDED
 * ```
 *
 * **Architektur-Grenze:** Dieses Modul importiert nie ein LLM, nie einen
 * Broker-SDK und nie eine Netzwerk-Bibliothek. Es liest ausschließlich
 * bereitgestellte Daten und rechnet deterministisch.
 */

export * from "./types";
export * from "./math";
export * from "./config";
export * from "./readiness";
export * from "./warmup";
export * from "./cache";
export * from "./regime";
export * from "./factors";
export * from "./ranker";
export * from "./filters";
export * from "./funnel";
export * from "./pipeline";
export * from "./weekly";
export * from "./artifacts";
export * from "./service";

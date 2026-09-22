/**
 * Deterministische Multi-Timeframe-Konfluenz (RMA-P2-03) — Barrel.
 *
 * Heiße Pfade (`cycle/steps`, `lib/analysts`) importieren bewusst die
 * SCHMALEN Module (`@/confluence/confluence`, `@/confluence/adapters`,
 * `@/confluence/config`), damit die Abhängigkeitsrichtung richtungsrein
 * bleibt. Dieses Barrel dient Doku-, Test- und API-Konsumenten.
 */
export * from "./types";
export * from "./config";
export * from "./features";
export * from "./confluence";
export * from "./adapters";

/**
 * Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04) — Barrel.
 *
 * Heiße/sync Pfade (Scanner-Service, CLI-Auswertung) importieren die
 * SCHMALEN Module direkt (`@/crossSectional/config`, `@/crossSectional/snapshot`,
 * `@/crossSectional/artifact`); das SERVER-seitige Persistenzmodul
 * (`./store`, `@/db`-Import) gehört in KEINEN Client-Import-Graph.
 * Dieses Barrel dient Doku-, Test- und API-Konsumenten.
 */

export * from "./types";
export * from "./math";
export * from "./config";
export * from "./momentum";
export * from "./universe";
export * from "./rank";
export * from "./snapshot";
export * from "./artifact";
export * from "./store";

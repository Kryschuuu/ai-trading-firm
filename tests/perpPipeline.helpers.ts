/**
 * Geteilte Typ-/Import-Brille der Perp-Pipeline-Tests (RMA-P2-02).
 *
 * Der Sync-Test arbeitet mit Adaptern, die `PerpFetchResult`-Formen direkt
 * zurückgeben; die Rohtypen sind über das Modul verstreut. Der Helper hält die
 * Tests frei von `any` (Baseline-Regel) und bindet sie an die realen Typen.
 */
export { PERP_LIMITS } from "../src/perpdata/types";
export type { PerpDataAdapter } from "../src/perpdata/port";
export type { PerpFetchResult, RawFundingRow as PerpRawFundingRowAlias } from "../src/perpdata/types";

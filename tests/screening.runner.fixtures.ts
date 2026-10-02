/**
 * Gemeinsame Fixtures der STX-05-04-Tests (Runner + Backtest-Adapter).
 *
 * Bewusst **keine** `.test.ts`-Datei: `npm test` läuft `tests/*.test.ts`, und
 * ein Import von Testcode würde die Suites des anderen Files mitlaufen lassen.
 */

import { createHash } from "node:crypto";
import type { StrategyMarketCandidate } from "../src/screening/types";

/**
 * Deterministische UUID aus einem Seed — die **Identität** einer Zelle darf
 * nicht von `randomUUID()` abhängen, sonst wäre ein Replay (gleicher Inhalt ⇒
 * gleicher `ssr1:`-Hash) nicht testbar.
 */
export function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Zelle einer Matrix — Felder, die Runner und Adapter lesen, plus Identität. */
export function cell(overrides: Partial<StrategyMarketCandidate> = {}): StrategyMarketCandidate {
  const venue = overrides.venue ?? "BINANCE";
  const instrumentId = overrides.instrumentId ?? `${venue}:CELL`;
  return {
    templateId: "ema-adx-trend",
    templateVersion: 1,
    strategyClass: "trend",
    instrumentId,
    venue,
    timeframe: "1h",
    dataQuality: 0.9,
    liquidity: 0.8,
    freshness: 0.85,
    strategyFit: 0.5,
    volatilityOpportunity: 0.7,
    correlationPenalty: 0.2,
    priority: 0.42,
    status: "DISCOVERED",
    reasons: [],
    strategyVersionId: deterministicUuid(instrumentId),
    ...overrides,
  };
}

/** N stabil sortierte Zellen mit absteigender Priorität (wie 05-02 sie liefert). */
export function cells(
  n: number,
  overrides: (i: number) => Partial<StrategyMarketCandidate> = () => ({}),
): StrategyMarketCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    cell({
      instrumentId: `BINANCE:CELL${String(i).padStart(4, "0")}`,
      priority: 1 - i / Math.max(1, n),
      ...overrides(i),
    }),
  );
}

/**
 * Geteilte Test-Fixtures des Cross-Sectional-Momentum-Rankings (RMA-P2-04).
 *
 * Die Fixtures sind klein, hand-verifizierbar und **deterministisch**:
 * Konstante Wachstumsraten je Instrument auf einem 1h-Raster.
 */

import type { CrossSectionalConfig, CrossSectionalSnapshot, MomentumCandle } from "../src/crossSectional/types";
import type { AssetClass } from "../src/universe/types";
import { buildCrossSectionalSnapshot } from "../src/crossSectional/snapshot";

/** 1h-Periodenlänge (ms). */
export const TF_MS = 3_600_000;
/** Starker, zeitstempel-gerade Referenzpunkt. */
export const T0 = 1_749_999_600_000;
/** Anzahl Kerzen je Fixture-Reihe. */
export const N_BARS = 400;
/** As-of des Standard-Snapshots: barEnd der letzten Kerze. */
export const AS_OF = T0 + N_BARS * TF_MS;

export interface CandidateFixture {
  id: string;
  status: string;
  assetClass: AssetClass;
  volume24h: number | null;
}

/** Kandidaten mit sinnvollen Defaults (alle aktiv, crypto, liquide). */
export function candidate(id: string, over: Partial<CandidateFixture> = {}): CandidateFixture {
  return { id, status: "active", assetClass: "crypto", volume24h: 1_000_000, ...over };
}

/**
 * Geometrische Kerzenreihe: `close_i = 100 * (1 + g)^i`, `ts_i = T0 + i*TF_MS`,
 * Ingestion `fetchedAt = ts + 1min` (also immer vor dem As-of).
 */
export function geoCandles(g: number, n: number = N_BARS, fetchedAtOffsetMs = 60_000): MomentumCandle[] {
  const out: MomentumCandle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ ts: T0 + i * TF_MS, close: 100 * Math.pow(1 + g, i), fetchedAtMs: T0 + i * TF_MS + fetchedAtOffsetMs });
  }
  return out;
}

/** Kleine Test-Config (2 Horizonte, Winsorize deaktiviert über [0,1]). */
export function testConfig(over: Partial<CrossSectionalConfig> = {}): CrossSectionalConfig {
  return {
    version: 1,
    description: "test-config",
    timeframe: "1h",
    availabilityPolicy: "ingested",
    horizons: [
      { id: "h3", lookback: 3, skip: 0, weight: 0.5 },
      { id: "h6", lookback: 6, skip: 0, weight: 0.5 },
    ],
    valueMode: "total",
    winsorLower: 0,
    winsorUpper: 1,
    minZStd: 1e-9,
    minHorizonCoverage: 0.5,
    minVolReturns: 3,
    eligibility: {
      minVolume24h: 1_000,
      // 6 = maximale Kerzenzahl im 6h-Max-Fenster auf dem 1h-Raster
      // (h6-Horizont: lookback 6 ⇒ maxWindow 6h ⇒ 6 geschlossene Kerzen).
      minCandles: 6,
      maxStaleBars: 2,
      assetClasses: null,
      maxUniverseSize: 100,
    },
    maxSnapshotAgeMs: 24 * 3_600_000,
    stabilityTopK: 3,
    ...over,
  };
}

/**
 * Standard-Universum: A (stark steigend), B (mild steigend), C (flach),
 * D (fallend) — alle 400 1h-Kerzen, alle liquide.
 */
export function standardUniverse(): {
  instruments: CandidateFixture[];
  candles: Map<string, MomentumCandle[]>;
} {
  const instruments = [candidate("V:A"), candidate("V:B"), candidate("V:C"), candidate("V:D")];
  const candles = new Map<string, MomentumCandle[]>([
    ["V:A", geoCandles(0.02)],
    ["V:B", geoCandles(0.01)],
    ["V:C", geoCandles(0)],
    ["V:D", geoCandles(-0.01)],
  ]);
  return { instruments, candles };
}

/**
 * DB-/API-Test-Helfer: 400 Kerzen, die exakt am Snapshot-As-of enden
 * (letzte barEnd = asOf) — damit liegt für BELIEBIGE (auch späte)
 * asOf-Zeiten eine vollständige 6h-Fenster-Historie vor.
 *
 * Ränge sind deterministisch: V:A > V:B > V:C > V:D (V:E mittig, wenn vorhanden).
 */
export const DB_RATES: Record<string, number> = { "V:A": 0.02, "V:B": 0.01, "V:C": 0, "V:D": -0.01 };

export function seriesEndingAt(asOf: number, rate: number): MomentumCandle[] {
  return Array.from({ length: N_BARS }, (_, i) => {
    const ts = asOf - (N_BARS - 1 - i) * TF_MS;
    return { ts, close: 100 * Math.pow(1 + rate, i), fetchedAtMs: ts + 60_000 };
  });
}

export function makeDbSnapshot(
  asOf: number,
  computedAt: number,
  extra: { rate?: number; addInstrument?: boolean } = {},
): CrossSectionalSnapshot {
  const instruments = Object.keys(DB_RATES).map((id) => candidate(id));
  const candles = new Map<string, MomentumCandle[]>(Object.entries(DB_RATES).map(([id, rate]) => [id, seriesEndingAt(asOf, rate)]));
  if (extra.addInstrument) {
    instruments.push(candidate("V:E", { volume24h: 900_000 }));
    candles.set("V:E", seriesEndingAt(asOf, extra.rate ?? 0.005));
  }
  return buildCrossSectionalSnapshot({
    asOf,
    computedAt,
    instruments,
    candles,
    config: testConfig(),
  });
}

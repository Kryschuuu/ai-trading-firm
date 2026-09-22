/**
 * Scanner-Integration des Faktors `crossSectionalMomentum` (RMA-P2-04, v1.63.0).
 *
 *   1. Explizites Unavailable: ohne injizierten Kontext (oder mit kaputtem
 *      Kontext) liefert der Faktor `available: false`, `raw: null` und den
 *      dokumentierten Neutralwert 0.5 — ein fehlender Rang geht NIEMALS
 *      still als 0-Momentum in eine Entscheidung ein (fail-closed).
 *   2. Gültiger Kontext: `raw = composite`, `normalized = percentile`,
 *      Rang/Snapshot im Detail (Provenienz nachvollziehbar).
 *   3. Score-Invarianz (dokumentierte Gewichtsentscheidung Gewicht 0):
 *      ein kompletter `scanUniverse`-Lauf mit und ohne Cross-Sectional-Karte
 *      erzeugt für jedes Instrument identischen Market Score und identischen
 *      Komponenten-Breakdown — der Faktor ist reine Diagnose und verändert
 *      den Score nicht (kein stilles Doppeltzählen des instrument-lokalen
 *      `momentum`-Faktors).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crossSectionalMomentumFactor,
  CROSS_SECTIONAL_MOMENTUM_NEUTRAL,
} from "../src/scanner/factors/crossSectionalMomentum";
import { scanUniverse } from "../src/scanner/pipeline";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/config";
import type { FactorInput } from "../src/scanner/types";
import type { CrossSectionalRankContext } from "../src/crossSectional/types";
import { AS_OF, healthyCandles, instrument } from "./fixtures/scannerFixtures";

/** Gültiger Referenz-Kontext (Instrument BINANCE:BTCUSDT). */
function ctx(over: Partial<CrossSectionalRankContext> = {}): CrossSectionalRankContext {
  return {
    instrumentId: "BINANCE:BTCUSDT",
    snapshotId: "xs1:" + "e".repeat(64),
    asOf: Date.parse("2026-09-21T00:00:00.000Z"),
    rank: 2,
    percentile: 0.8,
    composite: 1.25,
    ...over,
  };
}

/** Der Faktor liest ausschließlich `input.crossSectional` (reine Funktion). */
function input(crossSectional: CrossSectionalRankContext | null | undefined): FactorInput {
  return { crossSectional } as FactorInput;
}

test("unavailable ohne Kontext: available=false, raw=null, Neutralwert 0.5 (nie 0)", () => {
  const v = crossSectionalMomentumFactor.compute(input(undefined));
  assert.equal(v.available, false);
  assert.equal(v.raw, null);
  assert.equal(v.normalized, CROSS_SECTIONAL_MOMENTUM_NEUTRAL);
  assert.equal(v.normalized, 0.5, "Median des Querschnitts — kein 0-Momentum");
  assert.match(v.reason, /unavailable/i);
});

test("unavailable mit kaputtem Kontext (Perzentil 0/NaN/>1, Rang 0, NaN-Composite)", () => {
  const bad: Array<Partial<CrossSectionalRankContext>> = [
    { percentile: 0 },
    { percentile: NaN },
    { percentile: 1.2 },
    { rank: 0 },
    { composite: NaN },
  ];
  for (const over of bad) {
    const v = crossSectionalMomentumFactor.compute(input(ctx(over)));
    assert.equal(v.available, false, `ctx ${JSON.stringify(over)} ⇒ unavailable`);
    assert.equal(v.raw, null);
    assert.equal(v.normalized, 0.5);
  }
});

test("gültiger Kontext: raw=composite, normalized=percentile, Provenienz im Detail", () => {
  const c = ctx({ rank: 2, percentile: 0.8, composite: 1.25 });
  const v = crossSectionalMomentumFactor.compute(input(c));
  assert.equal(v.available, true);
  assert.equal(v.raw, 1.25);
  assert.equal(v.normalized, 0.8);
  assert.equal(v.detail?.rank, 2);
  assert.equal(v.detail?.percentile, 0.8);
  assert.equal(v.detail?.snapshotId, c.snapshotId);
  assert.equal(v.detail?.weight, 0, "diagnostischer Faktor: Score-Gewicht 0");
});

test("Score-Invarianz (Gewicht 0): Scan mit/ohne Cross-Sectional-Karte ⇒ identische Scores", () => {
  const instruments = [
    instrument({ symbol: "BTCUSDT", volume24h: 5_000_000_000, spread: 0.0001 }),
    instrument({ symbol: "ETHUSDT", volume24h: 3_000_000_000, spread: 0.00015 }),
  ];
  const map = new Map<string, CrossSectionalRankContext>([
    ["BINANCE:BTCUSDT", ctx({ instrumentId: "BINANCE:BTCUSDT", rank: 1, percentile: 1, composite: 2.1 })],
    ["BINANCE:ETHUSDT", ctx({ instrumentId: "BINANCE:ETHUSDT", rank: 2, percentile: 0.5, composite: -0.4 })],
  ]);

  const base = { candles: () => healthyCandles(90) };
  const a = scanUniverse({
    instruments,
    data: base,
    asOf: AS_OF,
    config: DEFAULT_SCANNER_CONFIG,
  });
  const b = scanUniverse({
    instruments,
    data: { ...base, crossSectional: (inst) => map.get(inst.id) ?? null },
    asOf: AS_OF,
    config: DEFAULT_SCANNER_CONFIG,
  });

  assert.equal(a.funnel.eligible.length, b.funnel.eligible.length, "Trichter bleibt unverändert");
  for (const id of instruments.map((i) => i.id)) {
    const sa = a.byId.get(id);
    const sb = b.byId.get(id);
    assert.ok(sa, `Instrument ${id} im Scan ohne Karte`);
    assert.ok(sb, `Instrument ${id} im Scan mit Karte`);
    assert.equal(sa!.score, sb!.score, `Market Score ${id} identisch`);
    assert.deepEqual(sa!.breakdown, sb!.breakdown, `Komponenten-Breakdown ${id} identisch`);
    // Der diagnostische Faktor selbst unterscheidet sich — das ist der Punkt:
    // Sichtbar, aber ohne Score-Auswirkung.
    assert.equal(sa!.factors.crossSectionalMomentum.available, false);
    assert.equal(sb!.factors.crossSectionalMomentum.available, true);
    assert.equal(sb!.factors.crossSectionalMomentum.normalized, id === "BINANCE:BTCUSDT" ? 1 : 0.5);
  }
});

/**
 * Unit-Tests des Point-in-Time Cross-Sectional Momentum Rankings (RMA-P2-04)
 * — reine Pfade ohne I/O (Determinismus, Formeln, Bounds, Negative Paths).
 *
 * Pflichtpunkte (PROMPT-P2-04):
 *   - bekannte Return-Fixture liefert exakte Rangfolge/Perzentile,
 *   - Eingabepermutation ändert das Ergebnis nicht,
 *   - zukünftig verfügbare Bar ändert den historischen Snapshot nicht,
 *   - unzureichende Historie/Liquidität führt zu Exclusion Reasons,
 *   - gleiches As-of/Config ist idempotent,
 *   - Universe-/Configänderung ändert den Snapshot-Hash,
 *   - Negative Paths für invalide, fehlende und stale Inputs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildCrossSectionalSnapshot, computeStability } from "../src/crossSectional/snapshot";
import { hashCrossSectionalConfig } from "../src/crossSectional/config";
import { pitVisibleCandles } from "../src/crossSectional/momentum";
import { quantileSorted, stdDev, mean } from "../src/crossSectional/math";
import { serializeCrossSectionalSnapshot } from "../src/crossSectional/artifact";
import type { CrossSectionalInput, MomentumCandle } from "../src/crossSectional/types";
import { AS_OF, N_BARS, T0, TF_MS, candidate, geoCandles, standardUniverse, testConfig } from "./crossSectional.fixtures";

function makeInput(over: Partial<CrossSectionalInput> = {}): CrossSectionalInput {
  const { instruments, candles } = standardUniverse();
  return {
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles,
    config: testConfig(),
    ...over,
  };
}

// ── 0: Basis — exakte Rangfolge/Perzentile (bekannte Return-Fixture) ───────

test("Fixtures: bekannte Return-Fixtur liefert exakte Rangfolge und Perzentile", () => {
  const snapshot = buildCrossSectionalSnapshot(makeInput());
  const ranked = snapshot.members.filter((m) => m.status === "RANKED");
  assert.equal(ranked.length, 4, "alle vier Instrumente ranken");
  assert.equal(snapshot.rankedCount, 4);
  assert.equal(snapshot.excludedCount, 0);
  assert.equal(snapshot.coverage, 1);

  // Erwartete Rohrenditen (h3: 3 1h-Kerzen): 1.02^3−1, 1.01^3−1, 0, 0.99^3−1.
  const byId = new Map(ranked.map((m) => [m.instrumentId, m]));
  assert.ok(Math.abs((byId.get("V:A")!.rawReturns.h3!.total as number) - (Math.pow(1.02, 3) - 1)) < 1e-10);
  assert.ok(Math.abs((byId.get("V:B")!.rawReturns.h3!.total as number) - (Math.pow(1.01, 3) - 1)) < 1e-10);
  assert.equal(byId.get("V:C")!.rawReturns.h3!.total, 0);
  assert.ok(Math.abs((byId.get("V:D")!.rawReturns.h3!.total as number) - (Math.pow(0.99, 3) - 1)) < 1e-10);

  // Exakte Rangfolge (A stark, B mild, C flach, D fallend) + Perzentile.
  assert.deepEqual(
    ranked.map((m) => m.instrumentId),
    ["V:A", "V:B", "V:C", "V:D"],
    "Rangfolge muss A > B > C > D sein",
  );
  assert.deepEqual(
    ranked.map((m) => m.rank),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    ranked.map((m) => m.percentile),
    [1.0, 0.75, 0.5, 0.25],
    "Perzentil = (n − rank + 1) / n",
  );

  // Explizite Unverfügbarkeit: geometrische Reihe ⇒ konstante Bar-Renditen
  // ⇒ σ=0 ⇒ volAdjusted null (fail-closed, nie 0) — total bleibt berechenbar.
  for (const id of ["V:A", "V:B", "V:C", "V:D"] as const) {
    assert.equal(byId.get(id)!.rawReturns.h3!.volAdjusted, null, `${id}: σ=0 ⇒ volAdjusted null`);
  }
  assert.equal(byId.get("V:C")!.rawReturns.h3!.available, true, "total ist trotzdem berechenbar");
});

test("volAdjusted: Formel total / (σ_window × √span) (unabhängig nachgerechnet)", () => {
  // 5 Kerzen mit variierenden Bar-Renditen (σ > 0), Fenster L=3 (span 3).
  const closes = [100, 101, 99, 102, 100.5];
  const cs: MomentumCandle[] = closes.map((close, i) => ({
    ts: T0 + i * TF_MS,
    close,
    fetchedAtMs: T0 + i * TF_MS + 60_000,
  }));
  const snapshot = buildCrossSectionalSnapshot({
    asOf: T0 + 5 * TF_MS,
    computedAt: T0 + 5 * TF_MS + 60_000,
    instruments: [candidate("V:V")],
    candles: new Map([["V:V", cs]]),
    config: testConfig({
      horizons: [{ id: "h3", lookback: 3, skip: 0, weight: 1 }],
      eligibility: { ...testConfig().eligibility, minCandles: 3 },
    }),
  });
  const v = snapshot.members.find((m) => m.instrumentId === "V:V")!;
  // Einzelmitglied-Querschnitt ist degenerated (RANG) — aber die ROH-Werte
  // müssen exakt der Formel folgen (das ist hier der Testgegenstand).
  assert.equal(v.status, "EXCLUDED", "Einzelmitglied ⇒ degenerated (kein Querschnitt möglich)");
  const hr = v.rawReturns.h3!;
  // Basis = letzte Kerze mit barEnd ≤ asOf−3h ⇒ close_1; Ende = close_4.
  const total = closes[4] / closes[1] - 1;
  const rets = [Math.log(closes[2] / closes[1]), Math.log(closes[3] / closes[2]), Math.log(closes[4] / closes[3])];
  const m = rets.reduce((a, r) => a + r, 0) / rets.length;
  const sigma = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / rets.length);
  const expected = total / (sigma * Math.sqrt(3));
  assert.ok(Math.abs((hr.total as number) - total) < 1e-9, "total exakt (10-Stellen-Rundung)");
  assert.ok(Math.abs((hr.volAdjusted as number) - expected) < 1e-9, `volAdjusted = total/(σ√span) (ist ${String(hr.volAdjusted)})`);
  assert.equal(hr.barsUsed, 4);
});

test("Fixtures: z-Scores sind Querschnitts-normiert (Mittelwert ≈ 0, Pop-σ = 1)", () => {
  const snapshot = buildCrossSectionalSnapshot(makeInput());
  const byId = new Map(snapshot.members.map((m) => [m.instrumentId, m]));
  const zs = (["V:A", "V:B", "V:C", "V:D"] as const).map((id) => byId.get(id)!.zScores.h3 as number);
  const m = mean(zs)!;
  const s = stdDev(zs)!;
  assert.ok(Math.abs(m) < 1e-9, `z-Mittelwert ≈ 0 (ist ${m})`);
  assert.ok(Math.abs(s - 1) < 1e-9, `z-σ ≈ 1 (ist ${s})`);
  // Composite ist die (gewichtete) z-Mittelung über beide Horizonte.
  const a = byId.get("V:A")!;
  assert.ok(a.composite !== null && (a.composite as number) > 0);
  const d = byId.get("V:D")!;
  assert.ok(d.composite !== null && (d.composite as number) < 0);
});

// ── 1: Determinismus & Permutationsinvarianz ───────────────────────────────

test("Determinismus: Eingabepermutation ändert das Snapshot nicht", () => {
  const base = makeInput();
  const a = buildCrossSectionalSnapshot(base);
  const perm = buildCrossSectionalSnapshot({
    ...base,
    instruments: [...base.instruments].reverse(),
  });
  assert.equal(serializeCrossSectionalSnapshot(a), serializeCrossSectionalSnapshot(perm), "byte-identisches Artefakt");
  assert.equal(a.provenance.snapshotId, perm.provenance.snapshotId);
  assert.equal(a.provenance.dataHash, perm.provenance.dataHash);
  assert.equal(a.provenance.universeHash, perm.provenance.universeHash);
});

test("Determinismus: gleiches As-of/Config ist idempotent (Snapshot-ID stabil)", () => {
  const input = makeInput();
  const a = buildCrossSectionalSnapshot(input);
  const b = buildCrossSectionalSnapshot({ ...input });
  assert.equal(a.provenance.snapshotId, b.provenance.snapshotId, "deterministische Snapshot-ID");
  assert.equal(serializeCrossSectionalSnapshot(a), serializeCrossSectionalSnapshot(b));
  // computedAt ist KEIN Teil der Identität — ein späterer Retry desselben
  // fachlichen Laufs bleibt derselbe Snapshot.
  const retry = buildCrossSectionalSnapshot({ ...input, computedAt: input.computedAt + 3_600_000 });
  assert.equal(a.provenance.snapshotId, retry.provenance.snapshotId, "computedAt gehört nicht zur Identität");
});

// ── 2: Point-in-Time / Look-ahead ──────────────────────────────────────────

test("Look-ahead (ingested): später ingestierte (veränderte) Bar ändert den historischen Snapshot NICHT", () => {
  // Zustand AM CUTOFF: V:A-Kerze i=398 existiert noch nicht (noch nicht
  // ingested). Zustand NACHHER: dieselbe Kerze wird 5h nach dem As-of
  // nachgeliefert (Backfill) mit verfälschtem Close. Beide Läufe mit dem
  // SELBEN As-of müssen byte-identisch sein.
  const { instruments } = standardUniverse();
  const candlesAtCutoff = new Map<string, MomentumCandle[]>([
    ["V:A", (standardUniverse().candles.get("V:A") ?? []).filter((c) => c.ts !== T0 + 398 * TF_MS)],
    ["V:B", standardUniverse().candles.get("V:B")!],
    ["V:C", standardUniverse().candles.get("V:C")!],
    ["V:D", standardUniverse().candles.get("V:D")!],
  ]);
  const config = testConfig({ eligibility: { ...testConfig().eligibility, minCandles: 5 } });
  const before = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles: candlesAtCutoff,
    config,
  });

  const backfilled = (candlesAtCutoff.get("V:A") ?? []).concat([
    { ts: T0 + 398 * TF_MS, close: (standardUniverse().candles.get("V:A") ?? [])[398].close * 2, fetchedAtMs: AS_OF + 5 * TF_MS },
  ]);
  const candlesAfter = new Map(candlesAtCutoff);
  candlesAfter.set("V:A", backfilled);
  const after = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles: candlesAfter,
    config,
  });

  // Die Lücke bei i=398 komprimiert A's Horizon-Spans unter die Lookbacks
  // ⇒ A wird in BEIDEN Zuständen konsistent mit Grund ausgeschlossen.
  assert.equal(before.rankedCount, 3);
  assert.equal(
    (before.members.find((m) => m.instrumentId === "V:A") as { exclusionReason: string }).exclusionReason,
    "INSUFFICIENT_HORIZON_COVERAGE",
  );
  assert.equal(
    serializeCrossSectionalSnapshot(before),
    serializeCrossSectionalSnapshot(after),
    "historischer Snapshot bleibt unverändert (kein Look-ahead)",
  );
  assert.equal(before.provenance.dataHash, after.provenance.dataHash);
});

test("Look-ahead (bar_close): dieselbe spätere Bar WIRD berücksichtigt (dokumentierte Forschungsannahme)", () => {
  const base = makeInput({ config: testConfig({ availabilityPolicy: "bar_close" }) });
  const before = buildCrossSectionalSnapshot(base);
  const backfilled = (base.candles.get("V:A") ?? []).map((c) =>
    c.ts === T0 + 398 * TF_MS ? { ...c, close: c.close * 2, fetchedAtMs: AS_OF + 5 * TF_MS } : c,
  );
  const candles = new Map(base.candles);
  candles.set("V:A", backfilled);
  const after = buildCrossSectionalSnapshot({ ...base, candles });
  assert.notEqual(before.provenance.dataHash, after.provenance.dataHash, "bar_close: Backfill verändert den Stand");
});

test("Look-ahead: Kerzen mit barEnd > asOf sind strukturell ausgeschlossen", () => {
  const base = makeInput();
  const withFuture = [...(base.candles.get("V:B") ?? []), { ts: AS_OF, close: 999, fetchedAtMs: AS_OF - 60_000 }];
  const candles = new Map(base.candles);
  candles.set("V:B", withFuture);
  const after = buildCrossSectionalSnapshot({ ...base, candles });
  const b = after.members.find((m) => m.instrumentId === "V:B")!;
  assert.equal((b.rawReturns.h3 as { barsUsed: number }).barsUsed, 4, "nichts nach dem Cutoff zählte");
});

test("pitVisibleCutoff: ungültige spätere Backfill-Kerze zahlt NICHT als invalidAtCutoff (ingested)", () => {
  const good = geoCandles(0.01, 10);
  const withLateBad = [
    ...good,
    { ts: T0 + 10 * TF_MS, close: Number.NaN, fetchedAtMs: T0 + 10 * TF_MS + 60_000 }, // barEnd > asOf(= T0+10*TF)? barEnd = T0+11h
  ];
  const ctx = { asOf: T0 + 10 * TF_MS, tfMs: TF_MS, policy: "ingested" as const };
  const { visible, invalidAtCutoff } = pitVisibleCandles(withLateBad, ctx);
  assert.equal(visible.length, 10);
  assert.equal(invalidAtCutoff, 0, "späte kaputte Kerze war am Cutoff unbekannt");
  // Dieselbe kaputte Kerze ABER bis asOf (T0+11h) ingested ⇒ zählt.
  const withEarlyBad = [
    ...good,
    { ts: T0 + 10 * TF_MS, close: Number.NaN, fetchedAtMs: T0 + 10 * TF_MS + 60_000 },
  ];
  const ctx2 = { asOf: T0 + 11 * TF_MS, tfMs: TF_MS, policy: "ingested" as const };
  const r2 = pitVisibleCandles(withEarlyBad, ctx2);
  assert.equal(r2.invalidAtCutoff, 1, "am Cutoff bekannte kaputte Kerze zählt");
});

// ── 3: Eligibility / Exclusion Reasons (fail-closed) ───────────────────────

test("Eligibility: Status/Assetklasse/Liquidität führen zu geschlossenen Exclusion-Reasons", () => {
  const { candles } = standardUniverse();
  const instruments = [
    candidate("V:A"),
    candidate("V:B"),
    candidate("V:C"),
    candidate("V:H", { status: "halted" }),
    candidate("V:EQ", { assetClass: "equity" }),
    candidate("V:NV", { volume24h: null }),
    candidate("V:LV", { volume24h: 500 }),
  ];
  const snapshot = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles,
    config: testConfig({ eligibility: { ...testConfig().eligibility, assetClasses: ["crypto"] } }),
  });
  const reasons = new Map(snapshot.members.map((m) => [m.instrumentId, m.exclusionReason]));
  assert.equal(reasons.get("V:A"), null, "A bleibt im Universum");
  assert.equal(reasons.get("V:B"), null);
  assert.equal(reasons.get("V:C"), null);
  assert.equal(reasons.get("V:H"), "INACTIVE");
  assert.equal(reasons.get("V:EQ"), "NOT_IN_ASSET_CLASSES");
  assert.equal(reasons.get("V:NV"), "NO_LIQUIDITY_DATA", "null-Liquidität ≠ 0 (fail-closed)");
  assert.equal(reasons.get("V:LV"), "BELOW_MIN_VOLUME");
  assert.equal(snapshot.rankedCount, 3, "die drei Eligible ranken");
  assert.equal(snapshot.exclusionCounts.INACTIVE, 1);
  assert.equal(snapshot.exclusionCounts.NO_LIQUIDITY_DATA, 1);
  // Exkludierte tragen keine Ränge.
  const h = snapshot.members.find((m) => m.instrumentId === "V:H")!;
  assert.equal(h.status, "EXCLUDED");
  assert.equal(h.rank, null);
  assert.equal(h.composite, null);
});

test("Eligibility: fehlende/stale/kurz Historie ⇒ NO_BARS_AT_CUTOFF/STALE_DATA/INSUFFICIENT_HISTORY", () => {
  // 10 flache Kerzen, die letzte endet exakt am As-of (frisch).
  const shortBars = Array.from({ length: 10 }, (_, i) => ({
    ts: T0 + (N_BARS - 10 + i) * TF_MS,
    close: 100,
    fetchedAtMs: T0 + (N_BARS - 10 + i) * TF_MS + 60_000,
  }));
  const candles = new Map<string, MomentumCandle[]>([
    // 398 Kerzen, die gesamte Reihe 2h zurückgeschoben ⇒ letzte Kerze endet
    // 4h vor dem As-of (stale bei maxStaleBars=2).
    [
      "V:STALE",
      geoCandles(0.01, N_BARS - 2).map((c) => ({ ...c, ts: c.ts - 2 * TF_MS })),
    ],
    // 10 Kerzen, davon nur 7 im 6h-Max-Fenster ⇒ INSUFFICIENT_HISTORY
    // (minCandles=10), frisch genug für STALE.
    ["V:SHORT", shortBars],
  ]);
  const instruments = [candidate("V:STALE"), candidate("V:SHORT"), candidate("V:NOPE")];
  const snapshot = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles,
    config: testConfig({ eligibility: { ...testConfig().eligibility, minCandles: 10 } }),
  });
  const reasons = new Map(snapshot.members.map((m) => [m.instrumentId, m.exclusionReason]));
  assert.equal(reasons.get("V:STALE"), "STALE_DATA");
  assert.equal(reasons.get("V:SHORT"), "INSUFFICIENT_HISTORY");
  assert.equal(reasons.get("V:NOPE"), "NO_BARS_AT_CUTOFF");
  assert.equal(snapshot.rankedCount, 0);
  assert.equal(snapshot.coverage, 0);
});

test("Eligibility: UNIVERSE_CAP kappst deterministisch (volumenstärkste bleiben)", () => {
  const { candles } = standardUniverse();
  const instruments = [
    candidate("V:A", { volume24h: 100_000 }),
    candidate("V:B", { volume24h: 200_000 }),
    candidate("V:C", { volume24h: 300_000 }),
    candidate("V:D", { volume24h: 400_000 }),
  ];
  const snapshot = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles,
    config: testConfig({ eligibility: { ...testConfig().eligibility, maxUniverseSize: 2 } }),
  });
  const reasons = new Map(snapshot.members.map((m) => [m.instrumentId, m.exclusionReason]));
  assert.equal(reasons.get("V:C"), null);
  assert.equal(reasons.get("V:D"), null);
  assert.equal(reasons.get("V:A"), "UNIVERSE_CAP");
  assert.equal(reasons.get("V:B"), "UNIVERSE_CAP");
});

test("Negative: invalide Kerzen (NaN-Close) ⇒ INVALID_INPUT statt stiller Reparatur", () => {
  const base = makeInput();
  const withBad = (base.candles.get("V:A") ?? []).map((c) =>
    c.ts === T0 + 200 * TF_MS ? { ...c, close: Number.NaN } : c,
  );
  const candles = new Map(base.candles);
  candles.set("V:A", withBad);
  const snapshot = buildCrossSectionalSnapshot({ ...base, candles });
  const a = snapshot.members.find((m) => m.instrumentId === "V:A")!;
  assert.equal(a.status, "EXCLUDED");
  assert.equal(a.exclusionReason, "INVALID_INPUT");
  assert.equal(a.rank, null);
  assert.equal(snapshot.exclusionCounts.INVALID_INPUT, 1);
  // Die anderen drei Instrumente bleiben unverändert gerankt.
  assert.equal(snapshot.rankedCount, 3);
});

// ── 4: Provenance-Hashes (Universe/Config/Data) ────────────────────────────

test("Provenance: Universe-Änderung ändert universeHash/dataHash/Snapshot-ID", () => {
  const base = makeInput();
  const a = buildCrossSectionalSnapshot(base);
  const withExtra = buildCrossSectionalSnapshot({
    ...base,
    instruments: [...base.instruments, candidate("V:E")],
    candles: new Map([...base.candles, ["V:E", geoCandles(0.005)]]),
  });
  assert.notEqual(a.provenance.universeHash, withExtra.provenance.universeHash);
  assert.notEqual(a.provenance.dataHash, withExtra.provenance.dataHash);
  assert.notEqual(a.provenance.snapshotId, withExtra.provenance.snapshotId);
  assert.equal(a.provenance.configHash, withExtra.provenance.configHash, "Config blieb gleich");
});

test("Provenance: Config-Änderung ändert configHash/Snapshot-ID (keine Still-Umdeutung)", () => {
  const base = makeInput();
  const a = buildCrossSectionalSnapshot(base);
  const changed = buildCrossSectionalSnapshot({
    ...base,
    config: testConfig({ horizons: [{ id: "h3", lookback: 3, skip: 0, weight: 1 }] }),
  });
  assert.notEqual(a.provenance.configHash, changed.provenance.configHash);
  assert.notEqual(a.provenance.snapshotId, changed.provenance.snapshotId);
  assert.equal(a.provenance.universeHash, changed.provenance.universeHash, "Universe blieb gleich");
});

// ── 5: Skip-Period, Degenerierung, Winsorize, Tie-Break ────────────────────

test("Skip-Period: lookback 4 + skip 1 nimmt den 5 Perioden zurückliegenden Preis", () => {
  const snapshot = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments: [candidate("V:A"), candidate("V:B")],
    candles: new Map([
      ["V:A", geoCandles(0.02)],
      ["V:B", geoCandles(0.01)],
    ]),
    config: testConfig({
      horizons: [{ id: "h4s1", lookback: 4, skip: 1, weight: 1 }],
      eligibility: { ...testConfig().eligibility, minCandles: 5 },
    }),
  });
  const b = snapshot.members.find((m) => m.instrumentId === "V:B")!;
  assert.equal(b.status, "RANKED");
  const hr = b.rawReturns.h4s1!;
  // Basis = letzte Kerze mit barEnd ≤ asOf − 5h ⇒ close_394; Ende = close_399
  // ⇒ Rendite 1.01^5 − 1.
  assert.ok(Math.abs((hr.total as number) - (Math.pow(1.01, 5) - 1)) < 1e-10);
  assert.equal(hr.barsUsed, 6, "Fenster umfasst 6 Kerzen (span 5 + 1)");
});

test("Tie-Break: gleiche Composites ⇒ kanonische ID-Reihenfolge (Eingabe-Reihenfolge egal)", () => {
  const base = makeInput();
  const withTie = buildCrossSectionalSnapshot({
    ...base,
    instruments: [...base.instruments, candidate("V:E")],
    candles: new Map([...base.candles, ["V:E", geoCandles(0.01)]]), // identisch mit V:B
  });
  const ranked = withTie.members.filter((m) => m.status === "RANKED");
  const order = ranked.map((m) => m.instrumentId);
  // V:B und V:E haben identische Rohrenditen ⇒ Composite-Gleichstand ⇒
  // lexikografisch: V:B vor V:E.
  const iB = order.indexOf("V:B");
  const iE = order.indexOf("V:E");
  assert.ok(iB >= 0 && iE >= 0 && iB < iE, `Tie-Break nach ID (Ordnung: ${order.join(",")})`);
  const sameComposite =
    (ranked[iB].composite as number) === (ranked[iE].composite as number);
  assert.ok(sameComposite, "Gleichstand muss dasselbe Composite tragen");

  // Permutierte Eingabe liefert dieselbe Rangfolge.
  const perm = buildCrossSectionalSnapshot({
    ...base,
    instruments: [candidate("V:E"), candidate("V:D"), candidate("V:C"), candidate("V:B"), candidate("V:A")],
    candles: new Map([...base.candles, ["V:E", geoCandles(0.01)]]),
  });
  assert.deepEqual(
    perm.members.filter((m) => m.status === "RANKED").map((m) => m.instrumentId),
    order,
  );
});

test("Degenerat: komplett flache Reihe ⇒ CROSS_SECTION_DEGENERATE (nie 0-Rang)", () => {
  const instruments = [candidate("V:F1"), candidate("V:F2")];
  const candles = new Map<string, MomentumCandle[]>([
    ["V:F1", geoCandles(0)],
    ["V:F2", geoCandles(0)],
  ]);
  const snapshot = buildCrossSectionalSnapshot({
    asOf: AS_OF,
    computedAt: AS_OF + 60_000,
    instruments,
    candles,
    config: testConfig(),
  });
  assert.equal(snapshot.rankedCount, 0);
  for (const m of snapshot.members) {
    assert.equal(m.status, "EXCLUDED");
    assert.equal(m.exclusionReason, "CROSS_SECTION_DEGENERATE");
    assert.equal(m.rank, null);
  }
  assert.equal(snapshot.coverage, 0);
});

test("Winsorize: Extremwert wird an den Quantil-Grenzen gekappt, nicht verschwinden", () => {
  const instruments = Array.from({ length: 10 }, (_, i) => candidate(`V:W${String(i + 1).padStart(2, "0")}`));
  const rates = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 5.0];
  const candles = new Map(
    instruments.map((c, i) => {
      // 6 Kerzen: flach bis k=4, Sprung in der letzten (k=5) ⇒ 4-Bar-Rendite = rate.
      const cs = Array.from({ length: 6 }, (_, k) => ({
        ts: T0 + k * TF_MS,
        close: k < 5 ? 100 : 100 * (1 + rates[i]),
        fetchedAtMs: T0 + k * TF_MS + 60_000,
      }));
      return [c.id, cs];
    }),
  );
  const snapshot = buildCrossSectionalSnapshot({
    asOf: T0 + 6 * TF_MS,
    computedAt: T0 + 6 * TF_MS + 60_000,
    instruments,
    candles,
    config: testConfig({
      horizons: [{ id: "h4", lookback: 4, skip: 0, weight: 1 }],
      winsorLower: 0.1,
      winsorUpper: 0.9,
      eligibility: { ...testConfig().eligibility, minCandles: 4 },
    }),
  });
  const outlier = snapshot.members.find((m) => m.instrumentId === "V:W10")!;
  assert.equal(outlier.status, "RANKED");
  // 10 Werte: q(0.9) = 0.09×0.9 + 5.0×0.1 = 0.581 (Type-7-Interpolation).
  assert.ok(
    Math.abs((outlier.winsorized.h4 as number) - 0.581) < 1e-9,
    `Outlier wird auf q(0.9) gekappt (ist ${String(outlier.winsorized.h4)})`,
  );
  assert.ok((outlier.rawReturns.h4!.total as number) > 4.9, "Rohwert bleibt dokumentiert (5.0)");
  assert.equal(outlier.rank, 1, "auch gekappt bleibt der Outlier auf Rang 1");
});

// ── 6: Stabilität/Turnover (bounded) ───────────────────────────────────────

test("Stability: Top-K-Overlap und mittlere Rangänderung (bounded Werte)", () => {
  const current = new Map([["A", 1], ["B", 2], ["C", 3]]);
  const prev = { snapshotId: "xs1:abc", ranks: new Map([["A", 2], ["B", 1], ["C", 4]]) };
  const s = computeStability(current, prev, 2);
  assert.equal(s?.prevSnapshotId, "xs1:abc");
  assert.equal(s?.topK, 2);
  assert.equal(s?.topKOverlap, 1.0, "Top-2-Mengen identisch ⇒ Jaccard 1");
  assert.equal(s?.rankShiftMean, 1.0, "|Δ| = 1+1+1 über 3 gemeinsame Instrumente");
  assert.equal(s?.commonCount, 3);
  // Ohne Vorgänger: null (kein erfundener Vergleichsstand).
  assert.equal(computeStability(current, null, 2), null);
});

// ── 7: Reine Hilfen (Formel-Grundlagen) ────────────────────────────────────

test("Math: quantileSorted ist deterministisch (Type 7)", () => {
  assert.equal(quantileSorted([1, 2, 3, 4], 0), 1);
  assert.equal(quantileSorted([1, 2, 3, 4], 1), 4);
  assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantileSorted([], 0.5), null);
  assert.throws(() => quantileSorted([1], 1.2));
});

test("Math: stdDev ist Populations-σ (Repo-Konvention) und null-behaftet", () => {
  assert.ok(Math.abs((stdDev([1, 2, 3, 4]) as number) - Math.sqrt(1.25)) < 1e-12);
  assert.equal(stdDev([]), null);
  assert.equal(stdDev([Number.NaN, 1]), null);
});

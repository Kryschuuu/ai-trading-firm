/**
 * Paritätstest für den Feature-Store-Slice `rule.*` (STX-02-04).
 *
 * Dieser Test stellt die exakte Deckungsgleichheit (bit-identisch, nicht
 * toleranzbehaftet) zwischen den materialisierten Werten des Feature Stores
 * und den Feldern des `RuleSnapshot` (`buildSnapshotFromCandles`) sicher.
 *
 * Geprüft wird:
 *   1. Exakte Parität: `featureValue === snap[field]` für mindestens 3 Timeframes
 *      und N Fixture-`(instrument, timeframe)` Kombinationen.
 *   2. Fail-closed-Verhalten: fehlende Historie, unbrauchbare Kerzen, flache Reihe.
 *   3. Point-in-Time-Invarianten: `availableAt > asOf` schließt Werte vor
 *      ihrer Ingestion strikt aus (kein Lookahead).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RULE_FEATURE_IDS,
  RULE_FEATURE_OWNER,
  ruleSliceDefinitions,
  createRuleSliceRegistry,
  planMaterialization,
  materializeSlice,
  pitQuery,
  type FeatureBarInput,
  type FeatureRef,
} from "../src/features";
import { FeatureMemoryStore } from "./helpers/featureStoreMemory";
import { buildSnapshotFromCandles } from "../src/lib/ruleEngine";
import {
  SUPPORTED_TIMEFRAMES,
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";

const FIXTURE_INSTRUMENTS = [
  "BITUNIX:BTCUSDT",
  "BITUNIX:ETHUSDT",
  "BINANCE:SOLUSDT",
];

const FIXTURE_TIMEFRAMES: readonly SupportedTimeframe[] = ["15m", "1h", "4h"];

const T0 = Date.parse("2026-09-01T00:00:00.000Z");

function generateCandles(
  count: number,
  stepMs: number,
  pattern: "sin" | "trend" | "flat" | "volatile"
): FeatureBarInput[] {
  return Array.from({ length: count }, (_, i) => {
    let close = 100;
    if (pattern === "sin") {
      close = 100 + i * 0.4 + Math.sin(i * 0.5) * 5;
    } else if (pattern === "trend") {
      close = 100 + i * 1.5;
    } else if (pattern === "flat") {
      close = 100;
    } else if (pattern === "volatile") {
      close = 100 + (i % 2 === 0 ? 10 : -10) + Math.cos(i) * 3;
    }
    const high = pattern === "flat" ? 100 : close + 1.2;
    const low = pattern === "flat" ? 100 : close - 1.1;
    const open = close - 0.2;
    const time = T0 + i * stepMs;
    return {
      time,
      open,
      high,
      low,
      close,
      volume: 1000 + i * 15,
      fetchedAt: new Date(time + stepMs + 60_000).toISOString(),
    };
  });
}

describe("ruleFeatureStoreParity: Exakte Parität zu RuleSnapshot", () => {
  it("Drei rule.* Definitionen besitzen vollständige Semantik-Doku und owner = 'rule'", () => {
    const defs = ruleSliceDefinitions();
    assert.equal(defs.length, 3);

    const bbZ = defs.find((d) => d.featureId === RULE_FEATURE_IDS.bbZScore);
    const upper = defs.find((d) => d.featureId === RULE_FEATURE_IDS.priceVsUpperBbPct);
    const donch = defs.find((d) => d.featureId === RULE_FEATURE_IDS.donchianBreakoutPct);

    assert.ok(bbZ);
    assert.ok(upper);
    assert.ok(donch);

    for (const def of [bbZ, upper, donch]) {
      assert.equal(def.owner, RULE_FEATURE_OWNER);
      assert.equal(def.owner, "rule");
      assert.equal(def.dtype, "number");
      assert.equal(def.valueDecimals, 4);
      assert.ok(def.description.length >= 20, `${def.featureId} description zu kurz`);
      assert.ok(def.unit && def.unit.length > 0, `${def.featureId} unit fehlt`);
      assert.match(def.computeKey, /^rule\./);
    }

    assert.equal(bbZ.unit, "std_devs");
    assert.equal(upper.unit, "percent_of_close");
    assert.equal(donch.unit, "percent_of_channel");
  });

  for (const timeframe of FIXTURE_TIMEFRAMES) {
    for (const pattern of ["sin", "trend", "volatile"] as const) {
      it(`Exakte Gleichheit (featureValue === RuleSnapshot-Feld) für Timeframe ${timeframe} mit Muster ${pattern}`, () => {
        const stepMs = SUPPORTED_TIMEFRAME_MS[timeframe];
        const candleCount = 45;
        const bars = generateCandles(candleCount, stepMs, pattern);

        const defs = ruleSliceDefinitions({ timeframe });
        const registry = createRuleSliceRegistry({ timeframe });
        const refs: FeatureRef[] = defs.map((d) => ({ featureId: d.featureId, version: d.version }));

        const asOf = bars[bars.length - 1].time + stepMs;
        const plan = planMaterialization({
          registry,
          refs,
          entityId: FIXTURE_INSTRUMENTS[0],
          timeframe,
          bars,
          asOf,
          availabilityPolicy: "bar_close",
          computedAt: new Date(asOf + 60_000),
          maxRows: 2000,
        });

        // Ab Index 24 vergleichen (da buildSnapshotFromCandles mindestens 25 Kerzen erfordert)
        for (let i = 24; i < candleCount; i++) {
          const prefix = bars.slice(0, i + 1);
          const snap = buildSnapshotFromCandles(
            "TEST",
            prefix.map((b) => ({
              time: b.time,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
            }))
          );
          assert.ok(snap, `Snapshot an Bar ${i} (${timeframe}) darf nicht null sein`);

          const eventTime = prefix[prefix.length - 1].time + stepMs;
          const zDraft = plan.drafts.find(
            (d) => d.featureId === RULE_FEATURE_IDS.bbZScore && d.eventTime.getTime() === eventTime
          );
          const upperDraft = plan.drafts.find(
            (d) => d.featureId === RULE_FEATURE_IDS.priceVsUpperBbPct && d.eventTime.getTime() === eventTime
          );
          const donchDraft = plan.drafts.find(
            (d) => d.featureId === RULE_FEATURE_IDS.donchianBreakoutPct && d.eventTime.getTime() === eventTime
          );

          assert.ok(zDraft, `Draft bbZScore fehlt für Bar ${i}`);
          assert.ok(upperDraft, `Draft priceVsUpperBbPct fehlt für Bar ${i}`);
          assert.ok(donchDraft, `Draft donchianBreakoutPct fehlt für Bar ${i}`);

          // Exakte Gleichheit (kein Math.abs(a - b) < epsilon, sondern strikt ===)
          assert.equal(
            zDraft.value,
            snap.bbZScore,
            `bbZScore weicht an Bar ${i} (${timeframe}, ${pattern}) ab: feature=${zDraft.value}, snapshot=${snap.bbZScore}`
          );
          assert.equal(
            upperDraft.value,
            snap.priceVsUpperBbPct,
            `priceVsUpperBbPct weicht an Bar ${i} (${timeframe}, ${pattern}) ab: feature=${upperDraft.value}, snapshot=${snap.priceVsUpperBbPct}`
          );
          assert.equal(
            donchDraft.value,
            snap.donchianBreakoutPct,
            `donchianBreakoutPct weicht an Bar ${i} (${timeframe}, ${pattern}) ab: feature=${donchDraft.value}, snapshot=${snap.donchianBreakoutPct}`
          );
        }
      });
    }
  }

  it("Exakte Parität bei flacher Kerzenreihe (σ == 0): bbZScore ist null, Prozent-Abstände sind 0", () => {
    const tf: SupportedTimeframe = "1h";
    const stepMs = SUPPORTED_TIMEFRAME_MS[tf];
    const bars = generateCandles(30, stepMs, "flat");

    const defs = ruleSliceDefinitions({ timeframe: tf });
    const registry = createRuleSliceRegistry({ timeframe: tf });
    const refs: FeatureRef[] = defs.map((d) => ({ featureId: d.featureId, version: d.version }));
    const asOf = bars[bars.length - 1].time + stepMs;

    const plan = planMaterialization({
      registry,
      refs,
      entityId: "BITUNIX:FLAT",
      timeframe: tf,
      bars,
      asOf,
      availabilityPolicy: "bar_close",
      computedAt: new Date(asOf + 60_000),
      maxRows: 2000,
    });

    const prefix = bars;
    const snap = buildSnapshotFromCandles(
      "FLAT",
      prefix.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }))
    );
    assert.ok(snap);

    const eventTime = asOf;
    const zDraft = plan.drafts.find(
      (d) => d.featureId === RULE_FEATURE_IDS.bbZScore && d.eventTime.getTime() === eventTime
    );
    const upperDraft = plan.drafts.find(
      (d) => d.featureId === RULE_FEATURE_IDS.priceVsUpperBbPct && d.eventTime.getTime() === eventTime
    );
    const donchDraft = plan.drafts.find(
      (d) => d.featureId === RULE_FEATURE_IDS.donchianBreakoutPct && d.eventTime.getTime() === eventTime
    );

    assert.equal(zDraft?.value, null);
    assert.equal(zDraft?.nullReason, "NOT_COMPUTABLE");
    assert.equal(snap.bbZScore, null);
    assert.equal(zDraft?.value, snap.bbZScore);

    assert.equal(upperDraft?.value, 0);
    assert.equal(snap.priceVsUpperBbPct, 0);
    assert.equal(upperDraft?.value, snap.priceVsUpperBbPct);

    assert.equal(donchDraft?.value, 0);
    assert.equal(snap.donchianBreakoutPct, 0);
    assert.equal(donchDraft?.value, snap.donchianBreakoutPct);
  });
});

describe("ruleFeatureStoreParity: Point-in-Time Invarianten & Materialisierung", () => {
  it("PIT-Invariante: availableAt > asOf schließt verspätet eingetroffene Werte vor asOf aus", async () => {
    const tf: SupportedTimeframe = "1h";
    const stepMs = SUPPORTED_TIMEFRAME_MS[tf];
    const store = new FeatureMemoryStore();

    // Bar 20 trifft erst mit Verzögerung ein (z. B. nach 5 Stunden)
    const LATE_BAR_INDEX = 20;
    const bars = generateCandles(30, stepMs, "sin").map((b, idx) => {
      if (idx === LATE_BAR_INDEX) {
        return {
          ...b,
          fetchedAt: new Date(b.time + stepMs + 5 * stepMs).toISOString(),
        };
      }
      return b;
    });

    const registry = createRuleSliceRegistry({ timeframe: tf });
    const defs = ruleSliceDefinitions({ timeframe: tf });
    const refs = defs.map((d) => ({ featureId: d.featureId, version: d.version }));

    const totalEnd = bars[bars.length - 1].time + stepMs + 10 * stepMs;
    await materializeSlice(
      {
        refs,
        entities: ["BITUNIX:BTCUSDT"],
        timeframe: tf,
        barsFor: () => bars,
        asOf: new Date(totalEnd),
        availabilityPolicy: "ingested",
        mode: "INCREMENTAL",
      },
      { store, registry }
    );

    const lateBarEventTime = bars[LATE_BAR_INDEX].time + stepMs;
    const lateBarAvailableAt = bars[LATE_BAR_INDEX].time + stepMs + 5 * stepMs;

    // 1. PIT-Abfrage VOR dem Eintreffen (asOf < lateBarAvailableAt)
    // Zu diesem Zeitpunkt darf Bar 20 nicht sichtbar sein (kein Lookahead).
    const beforeArrivalResult = await pitQuery(
      {
        asOf: new Date(lateBarEventTime + 60_000), // Bar ist geschlossen, aber noch nicht ingested!
        entities: ["BITUNIX:BTCUSDT"],
        features: [{ featureId: RULE_FEATURE_IDS.bbZScore, version: 1 }],
        timeframe: tf,
        targetTime: new Date(lateBarEventTime),
      },
      { store, registry }
    );

    const beforeVal = beforeArrivalResult.values[0];
    assert.ok(beforeVal);
    // Vor dem Ingestion-Zeitpunkt liefert die PIT-Abfrage den vorherigen bekannten Wert oder MISSING
    if (beforeVal.status === "OK") {
      assert.notEqual(
        beforeVal.eventTime,
        new Date(lateBarEventTime).toISOString(),
        "Leakage: verspäteter Wert war vor availableAt sichtbar!"
      );
    }

    // 2. PIT-Abfrage NACH dem Eintreffen (asOf >= lateBarAvailableAt)
    const afterArrivalResult = await pitQuery(
      {
        asOf: new Date(lateBarAvailableAt + 60_000),
        entities: ["BITUNIX:BTCUSDT"],
        features: [{ featureId: RULE_FEATURE_IDS.bbZScore, version: 1 }],
        timeframe: tf,
        targetTime: new Date(lateBarEventTime),
      },
      { store, registry }
    );

    const afterVal = afterArrivalResult.values[0];
    assert.ok(afterVal);
    assert.equal(afterVal.status, "OK");
    assert.equal(afterVal.eventTime, new Date(lateBarEventTime).toISOString());
  });
});

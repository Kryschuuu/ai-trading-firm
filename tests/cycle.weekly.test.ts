/**
 * Tests für den Weekly Universe Review (Task 06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import { weeklyReviewStep, createWeeklySteps, type WeeklyStepInput } from "../src/cycle/weekly";
import { UNIVERSE_CLASSES, validateWeeklyReview } from "@/scanner/weekly";
import type { StepExecutionContext } from "../src/cycle/types";

test("Weekly Review: createWeeklySteps liefert genau den Review-Step", () => {
  const steps = createWeeklySteps();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].stepId, "01-weekly-review");
  assert.equal(steps[0].role, "WEEKLY_REVIEW");
  assert.equal(steps[0].llmAllowed, true);
});

test("Weekly Review: erzeugt valide Klassifikation (CORE/ROTATION/DISCOVERY/EXCLUDED) mit reasons[]", async () => {
  const clock = new SimulatedClock("2026-08-30T01:00:00.000Z");
  const ports = createTestPorts();

  ports.agent.setResponseForRole("WEEKLY_REVIEW", {
    executiveSummary: "Stabiles Marktumfeld, Kern-Assets bleiben intakt.",
    macroRegime: "NORMAL",
    weeklyThemes: ["Hohe Liquidität bei BTC", "Selektive Konsolidierung"],
  });

  const ctx: StepExecutionContext<WeeklyStepInput> = {
    cycleId: "test-weekly",
    date: "2026-08-30",
    asOf: clock.now(),
    clock,
    input: {
      newListings: ["BINANCE:NEWUSDT"],
      delistings: ["BINANCE:OLDUSDT"],
    },
    previousStepOutputs: {},
    ports,
    emitEscalation: () => {},
    log: () => {},
  };

  const output = await weeklyReviewStep.execute(ctx);
  assert.ok(output.review);
  assert.equal(output.review.schemaVersion, 1);

  // Zusammenfassung enthält alle 4 Klassen
  for (const cls of UNIVERSE_CLASSES) {
    assert.ok(typeof output.review.summary[cls] === "number", `Klasse ${cls} fehlt in summary`);
  }

  // Einträge validieren
  assert.ok(output.review.entries.length > 0);
  for (const entry of output.review.entries.slice(0, 10)) {
    assert.ok(UNIVERSE_CLASSES.includes(entry.class));
    assert.ok(Array.isArray(entry.reasons));
    assert.ok(entry.reasons.length > 0);
    assert.ok(typeof entry.score === "number");
    assert.ok(typeof entry.asOf === "string");
  }

  // Änderungen wurden eingepflegt
  assert.ok(output.review.changes.newListings.includes("BINANCE:NEWUSDT"));
  assert.ok(output.review.changes.delistings.includes("BINANCE:OLDUSDT"));

  // Synthese ist vorhanden
  assert.ok(output.synthesis);
  assert.equal(output.synthesis?.macroRegime, "NORMAL");
  assert.equal(output.synthesis?.weeklyThemes.length, 2);

  // Gegen das strenge validateWeeklyReview validieren
  const validated = validateWeeklyReview(output.review);
  assert.equal(validated.entries.length, output.review.entries.length);
});

test("Weekly Review: reagiert auf Broker-Ausfall und Gebührenerhöhungen", async () => {
  const clock = new SimulatedClock("2026-08-30T01:00:00.000Z");
  const ports = createTestPorts();

  const ctx: StepExecutionContext<WeeklyStepInput> = {
    cycleId: "test-weekly-broker-fee",
    date: "2026-08-30",
    asOf: clock.now(),
    clock,
    input: {
      brokerAvailability: {
        "BINANCE:BTCUSDT": false, // Broker weg!
      },
      feeChanges: {
        "BINANCE:ETHUSDT": { oldFee: 0.0005, newFee: 0.0015 }, // > 50 % Anstieg!
      },
    },
    previousStepOutputs: {},
    ports,
    emitEscalation: () => {},
    log: () => {},
  };

  const output = await weeklyReviewStep.execute(ctx);
  const btcEntry = output.review.entries.find((e) => e.instrumentId === "BINANCE:BTCUSDT");
  assert.ok(btcEntry);
  assert.equal(btcEntry?.class, "EXCLUDED");
  assert.ok(btcEntry?.reasons.includes("broker-unavailable"));

  const ethEntry = output.review.entries.find((e) => e.instrumentId === "BINANCE:ETHUSDT");
  if (ethEntry) {
    assert.ok(ethEntry.reasons.includes("fee-increase-50pct"));
  }
});

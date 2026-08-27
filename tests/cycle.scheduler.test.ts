/**
 * Tests für Scheduler und Clock (Task 06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedClock, SystemClock, formatDateYYYYMMDD, getIsoWeekString, isInTimeWindow } from "../src/cycle/clock";
import { CycleScheduler } from "../src/cycle/scheduler";
import { createTestPorts } from "../src/cycle/ports";
import type { StepDefinition } from "../src/cycle/types";

test("Clock: SystemClock liefert valide ISO-Zeitstempel und ms", () => {
  const clock = new SystemClock();
  assert.ok(clock.nowMs() > 0);
  assert.ok(Date.parse(clock.toISOString()) > 0);
  assert.ok(clock.now() instanceof Date);
});

test("Clock: SimulatedClock spult Zeit deterministisch vor", () => {
  const clock = new SimulatedClock("2026-08-27T00:00:00.000Z");
  assert.equal(clock.toISOString(), "2026-08-27T00:00:00.000Z");
  assert.equal(formatDateYYYYMMDD(clock.now()), "2026-08-27");
  assert.equal(getIsoWeekString(clock.now()), "2026-W35");

  clock.advanceHours(6);
  assert.equal(clock.toISOString(), "2026-08-27T06:00:00.000Z");

  clock.advanceMinutes(30);
  assert.equal(clock.toISOString(), "2026-08-27T06:30:00.000Z");

  clock.advanceDays(1);
  assert.equal(clock.toISOString(), "2026-08-28T06:30:00.000Z");
  assert.equal(formatDateYYYYMMDD(clock.now()), "2026-08-28");
});

test("Clock: isInTimeWindow prüft Zeitfenster korrekt", () => {
  assert.equal(isInTimeWindow("06:15", "06:00-07:00"), true);
  assert.equal(isInTimeWindow("05:59", "06:00-07:00"), false);
  assert.equal(isInTimeWindow("07:00", "06:00-07:00"), false); // Endwert ist exklusiv
  assert.equal(isInTimeWindow("23:30", "23:00-02:00"), true);
  assert.equal(isInTimeWindow("01:30", "23:00-02:00"), true);
  assert.equal(isInTimeWindow("03:00", "23:00-02:00"), false);
});

test("Scheduler: Zeitraffer-Ausführung von Daily und Weekly", async () => {
  const clock = new SimulatedClock("2026-08-27T00:00:00.000Z"); // Donnerstag
  const testPorts = createTestPorts();

  const dummyStep: StepDefinition = {
    stepId: "step-1",
    name: "Dummy Step",
    role: "MARKET_SCANNER",
    timeWindow: "00:00-06:00",
    llmAllowed: false,
    async execute() {
      return { ok: true, step: 1 };
    },
  };

  const scheduler = new CycleScheduler({
    clock,
    ports: testPorts,
    dailyStepsFactory: () => [dummyStep],
    weeklyStepsFactory: () => [dummyStep],
    config: {
      dailyStartHourUtc: 0,
      weeklyReviewDay: 0, // Sonntag
      weeklyReviewHourUtc: 0,
    },
  });

  // 1. Daily Lauf ausführen
  const dailyRec = await scheduler.runDaily();
  assert.equal(dailyRec.status, "COMPLETED");
  assert.equal(dailyRec.date, "2026-08-27");
  assert.equal(dailyRec.steps.length, 1);

  // 2. Tick bei 00:00 Donnerstag: Daily wurde schon ausgeführt, Weekly noch nicht fällig
  const tick1 = await scheduler.tick();
  assert.equal(tick1.ranDaily, false);
  assert.equal(tick1.ranWeekly, false);

  // 3. Zeit vorspulen auf Sonntag 2026-08-30
  clock.setTime("2026-08-30T01:00:00.000Z");
  const tickSunday = await scheduler.tick();
  assert.equal(tickSunday.ranDaily, true); // Neuer Tag
  assert.equal(tickSunday.ranWeekly, true); // Sonntag
  assert.equal(tickSunday.weeklyRecord?.status, "COMPLETED");
  assert.equal(tickSunday.weeklyRecord?.week, "2026-W35");
});

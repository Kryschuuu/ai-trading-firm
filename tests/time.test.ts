import { test } from "node:test";
import assert from "node:assert/strict";
import {
  berlinDayKey,
  startOfBerlinDay,
  startOfBerlinWeek,
  startOfBerlinMonth,
  startOfBerlinQuarter,
  startOfBerlinHalfYear,
  startOfBerlinYear,
  isPeriod,
  periodStart,
} from "../src/lib/time";

test("berlinDayKey kippt um 00:00 Ortszeit, nicht UTC", () => {
  assert.equal(berlinDayKey(new Date("2026-01-01T22:59:00Z")), "2026-01-01"); // 23:59 MEZ
  assert.equal(berlinDayKey(new Date("2026-01-01T23:00:00Z")), "2026-01-02"); // 00:00 MEZ
});

test("startOfBerlinDay im Winter: Mitternacht = 23:00 UTC des Vortags", () => {
  const at = new Date("2026-01-15T14:30:00Z"); // 15:30 MEZ
  assert.equal(
    startOfBerlinDay(at).toISOString(),
    new Date("2026-01-14T23:00:00Z").toISOString()
  );
});

test("startOfBerlinDay im Sommer: Mitternacht = 22:00 UTC des Vortags", () => {
  const at = new Date("2026-07-15T14:30:00Z"); // 16:30 CEST
  assert.equal(
    startOfBerlinDay(at).toISOString(),
    new Date("2026-07-14T22:00:00Z").toISOString()
  );
});

test("startOfBerlinDay kurz vor/nach der DST-Kante 2026 (29.3., 02:00→03:00)", () => {
  const before = startOfBerlinDay(new Date("2026-03-29T01:00:00Z")); // 02:00 MEZ → Tag 29.3.
  const after = startOfBerlinDay(new Date("2026-03-29T04:00:00Z")); // 06:00 CEST → Tag 29.3.
  assert.equal(berlinDayKey(before), "2026-03-29");
  assert.equal(berlinKey(after), "2026-03-29");
});

function berlinKey(d: Date): string {
  return berlinDayKey(d);
}

test("startOfBerlinWeek liefert Montagsmitternacht", () => {
  // 2026-08-24 ist ein Montag
  const wednesday = new Date("2026-08-26T12:00:00Z");
  const mondayStart = startOfBerlinWeek(wednesday);
  assert.equal(mondayStart.toISOString(), "2026-08-23T22:00:00.000Z"); // Mo 00:00 CEST
});

test("startOfBerlinMonth liefert den Monatsersten", () => {
  const midMarch = new Date("2026-03-15T12:00:00Z");
  assert.equal(startOfBerlinMonth(midMarch).toISOString(), "2026-02-28T23:00:00.000Z");
});

test("periodStart mappt korrekt", () => {
  const now = new Date("2026-05-20T09:00:00Z");
  assert.deepEqual(periodStart("day", now), startOfBerlinDay(now));
  assert.deepEqual(periodStart("week", now), startOfBerlinWeek(now));
  assert.deepEqual(periodStart("month", now), startOfBerlinMonth(now));
});

test("startOfBerlinQuarter liefert den Quartalsersten (Jan/Apr/Jul/Okt)", () => {
  // 20.05.2026 → Q2 beginnt am 1. April 00:00 CEST = 31.03. 22:00 UTC.
  assert.equal(startOfBerlinQuarter(new Date("2026-05-20T09:00:00Z")).toISOString(), "2026-03-31T22:00:00.000Z");
  // 02.01.2026 → Q1 beginnt am 1. Januar 00:00 MEZ = 31.12. 23:00 UTC.
  assert.equal(startOfBerlinQuarter(new Date("2026-01-02T09:00:00Z")).toISOString(), "2025-12-31T23:00:00.000Z");
  // 01.10.2026 → Q4 beginnt am 1. Oktober.
  assert.equal(startOfBerlinQuarter(new Date("2026-10-01T09:00:00Z")).toISOString(), "2026-09-30T22:00:00.000Z");
});

test("startOfBerlinHalfYear und startOfBerlinYear liegen auf dem 1.1./1.7.", () => {
  assert.equal(startOfBerlinHalfYear(new Date("2026-03-15T12:00:00Z")).toISOString(), "2025-12-31T23:00:00.000Z");
  assert.equal(startOfBerlinHalfYear(new Date("2026-08-15T12:00:00Z")).toISOString(), "2026-06-30T22:00:00.000Z");
  assert.equal(startOfBerlinYear(new Date("2026-08-15T12:00:00Z")).toISOString(), "2025-12-31T23:00:00.000Z");
});

test("periodStart kennt Quartal, Halbjahr und Jahr; isPeriod ist die Wache", () => {
  const now = new Date("2026-05-20T09:00:00Z");
  assert.deepEqual(periodStart("quarter", now), startOfBerlinQuarter(now));
  assert.deepEqual(periodStart("halfyear", now), startOfBerlinHalfYear(now));
  assert.deepEqual(periodStart("year", now), startOfBerlinYear(now));

  assert.equal(isPeriod("quarter"), true);
  assert.equal(isPeriod("all"), false);
  assert.equal(isPeriod(""), false);
});

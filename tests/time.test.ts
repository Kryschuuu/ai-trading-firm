import { test } from "node:test";
import assert from "node:assert/strict";
import {
  berlinDayKey,
  startOfBerlinDay,
  startOfBerlinWeek,
  startOfBerlinMonth,
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

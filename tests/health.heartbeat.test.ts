/**
 * GAP-10 (v1.45.0) — Heartbeat & Stale-Erkennung (D4).
 *
 * Abnahmekriterien aus
 * docs/audits/2026-09-18-feature-gap/findings/GAP-10-observability-circuit-breaker.md:
 *
 *   - `/api/health` meldet `monitorLastTickAt` + `stale`.
 *   - Stale-Erkennung mit Fake-Clock: exakte Grenzwerte
 *     (`HEALTH_STALE_AFTER_MS`, Default 300000, Bounds [30000, 3600000]).
 *   - Ein Prozess ohne jemals gelaufenen Tick gilt als stale (fail-loud).
 *
 * Rein rechnend (keine DB, kein Netzwerk); die Route wird zusätzlich direkt
 * aufgerufen — sie antwortet konstruktionsbedingt IMMER mit HTTP 200.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  HEALTH_STALE_AFTER_MS_BOUNDS,
  HEALTH_STALE_AFTER_MS_DEFAULT,
  HEALTH_STALE_AFTER_MS_FLAG,
  heartbeatSnapshot,
  loadHealthConfig,
  readHeartbeat,
} from "../src/lib/heartbeat";
import { __resetAllSingletonsForTests, state } from "../src/lib/stateRegistry";

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

beforeEach(() => {
  __resetAllSingletonsForTests();
});

afterEach(() => {
  __resetAllSingletonsForTests();
});

test("D4: Grenzwerte — genau an der Schwelle gesund, ein Millisekündchen darüber stale", () => {
  const threshold = HEALTH_STALE_AFTER_MS_DEFAULT;
  assert.equal(threshold, 300_000);
  assert.deepEqual(HEALTH_STALE_AFTER_MS_BOUNDS, { min: 30_000, max: 3_600_000 });

  const atThreshold = heartbeatSnapshot({ now: NOW, lastTickAtMs: NOW - threshold, staleAfterMs: threshold });
  assert.equal(atThreshold.stale, false, "Alter == Schwelle ist noch gesund");
  assert.equal(atThreshold.monitorAgeMs, threshold);

  const overThreshold = heartbeatSnapshot({ now: NOW, lastTickAtMs: NOW - threshold - 1, staleAfterMs: threshold });
  assert.equal(overThreshold.stale, true, "Alter > Schwelle ist stale");
  assert.equal(overThreshold.monitorAgeMs, threshold + 1);
});

test("D4: noch nie ein Tick → stale (fail-loud), Zeitstempel null", () => {
  const never = heartbeatSnapshot({ now: NOW, lastTickAtMs: null });
  assert.equal(never.stale, true);
  assert.equal(never.monitorLastTickAt, null);
  assert.equal(never.monitorAgeMs, null);
  assert.equal(never.staleAfterMs, HEALTH_STALE_AFTER_MS_DEFAULT);
});

test("D4: Schwelle kommt aus HEALTH_STALE_AFTER_MS und wird geklemmt (Bounds + Warnung)", () => {
  assert.equal(loadHealthConfig({}).staleAfterMs, HEALTH_STALE_AFTER_MS_DEFAULT);
  assert.equal(loadHealthConfig({ HEALTH_STALE_AFTER_MS: "60000" }).staleAfterMs, 60_000);
  assert.equal(loadHealthConfig({ HEALTH_STALE_AFTER_MS: "1000" }).staleAfterMs, 30_000, "untere Bound");
  assert.equal(loadHealthConfig({ HEALTH_STALE_AFTER_MS: "99999999" }).staleAfterMs, 3_600_000, "obere Bound");
  assert.equal(loadHealthConfig({ HEALTH_STALE_AFTER_MS: "abc" }).staleAfterMs, 300_000, "Default bei Unsinn");
  assert.equal(HEALTH_STALE_AFTER_MS_FLAG, "HEALTH_STALE_AFTER_MS");

  const custom = heartbeatSnapshot({ now: NOW, lastTickAtMs: NOW - 45_000, staleAfterMs: 30_000 });
  assert.equal(custom.stale, true);
});

test("D4: readHeartbeat liest den RAM-Heartbeat des Ticks (keine DB, kein Tick = stale)", () => {
  assert.equal(readHeartbeat(NOW).stale, true, "frischer Prozess: noch kein Tick");
  state.monitorLastTickAt.set(NOW - 1_000);
  const fresh = readHeartbeat(NOW);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.monitorLastTickAt, new Date(NOW - 1_000).toISOString());
  assert.equal(fresh.monitorAgeMs, 1_000);
});

test("D4: /api/health enthält monitorLastTickAt + stale — und bleibt bei jedem Fehler HTTP 200", async () => {
  const { GET } = await import("../src/app/api/health/route");
  const res = await GET();
  assert.equal(res.status, 200, "ein Healthcheck darf den Prozess nie als down melden");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.ok("monitorLastTickAt" in body, "monitorLastTickAt fehlt");
  assert.ok("stale" in body, "stale fehlt");
  assert.equal(body.stale, true, "ohne Tick ist der Monitor stale (fail-loud)");
  assert.equal(body.staleAfterMs, HEALTH_STALE_AFTER_MS_DEFAULT);
  assert.equal(typeof body.version, "string");
});

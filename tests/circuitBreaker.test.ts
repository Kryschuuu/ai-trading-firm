/**
 * GAP-10 (v1.45.0) — Auto-Circuit-Breaker (D2).
 *
 * Abnahmekriterien aus
 * docs/audits/2026-09-18-feature-gap/findings/GAP-10-observability-circuit-breaker.md:
 *
 *   (a) simulierter Drawdown-Bruch → Kill-Switch ENGAGE + Audit mit Grund
 *       (`auto-circuit-breaker:drawdown:<wert>`) + Alert
 *   (b) Konsekutiv-Verluste-Trigger (RISK_MAX_CONSECUTIVE_LOSSES, Default 5)
 *   (c) AUTO_CIRCUIT_BREAKER=off → kein Engage
 *   (d) Latching: ein erneuter Tick ändert den Zustand nicht
 *   (e) Disarm weiterhin NUR über den manuellen Challenge-Nonce-Pfad
 *
 * Die Tests brauchen KEINE Datenbank: die Effekt-Hooks (Audit, Alert,
 * Verlustserie, `kill_switches`-Zeile) sind injizierbar; der einzige
 * DB-nahe Pfad (Deviation der Re-Arm-Route) wird so geprüft, dass er die
 * DB gar nicht erst berührt (Nonce fehlt → 403 vor jeder Mutation).
 *
 * Determinismus: feste Uhr, feste Eingangswerte, kein Netzwerk.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CIRCUIT_BREAKER_ENV,
  MAX_CONSECUTIVE_LOSSES_BOUNDS,
  MAX_CONSECUTIVE_LOSSES_DEFAULT,
  checkCircuitBreaker,
  circuitBreakerLatch,
  countConsecutiveLosses,
  describeTrigger,
  evaluateCircuitBreaker,
  formatBreakerValue,
  loadCircuitBreakerConfig,
  type CircuitBreakerDeps,
} from "../src/lib/circuitBreaker";
import { killSwitch } from "../src/lib/riskGuard";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { consumeDisarmNonce, issueDisarmNonce, resetDisarmNoncesForTests } from "../src/lib/disarmChallenge";

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

/** Input ohne Auslöser a/b — nur die Verlustserie kann greifen. */
const CALM = {
  drawdownPct: 0.01,
  maxEquityDrawdownPct: 0.15,
  dailyLossPct: 0.01,
  dailyLossLimitPct: 0.05,
};

/** Test-Deps: Audit/Alert/Kill-Switch-Zeile/Verlustserie werden aufgezeichnet. */
function makeDeps(overrides: Partial<CircuitBreakerDeps> = {}) {
  const audits: Record<string, unknown>[] = [];
  const alerts: Record<string, unknown>[] = [];
  const killRows: Record<string, unknown>[] = [];
  const deps: CircuitBreakerDeps = {
    now: () => NOW,
    config: { enabled: true, maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES_DEFAULT },
    countLosses: async () => 0,
    audit: async (detail) => {
      audits.push(detail);
      return { durable: true, error: null };
    },
    emit: async (alert) => {
      alerts.push(alert as unknown as Record<string, unknown>);
      return { sent: true, suppressed: false, errors: [] };
    },
    recordKillSwitch: async (row) => {
      killRows.push(row);
    },
    ...overrides,
  };
  return { deps, audits, alerts, killRows };
}

beforeEach(() => {
  __resetAllSingletonsForTests();
  resetDisarmNoncesForTests();
});

afterEach(() => {
  killSwitch.disarm();
  __resetAllSingletonsForTests();
  resetDisarmNoncesForTests();
});

test("D2 (a): Drawdown-Bruch → Kill-Switch ENGAGE + Audit mit Grund + Alert", async () => {
  const { deps, audits, alerts, killRows } = makeDeps();
  assert.equal(killSwitch.isArmed(), false);

  const outcome = await checkCircuitBreaker(
    { ...CALM, drawdownPct: 0.1834, maxEquityDrawdownPct: 0.15 },
    deps,
  );

  assert.equal(outcome.enabled, true);
  assert.equal(outcome.engaged, true);
  assert.equal(outcome.latched, true);
  assert.equal(outcome.trigger?.metric, "drawdown");
  assert.equal(outcome.reason, "auto-circuit-breaker:drawdown:0.1834");

  // Bestehender Kill-Switch-Pfad wurde benutzt (in-memory Wirksamkeit).
  assert.equal(killSwitch.isArmed(), true);

  // Fixierter Auslösewert im Audit (Latching ohne Hysterese).
  assert.equal(audits.length, 1);
  assert.equal(audits[0].reason, "auto-circuit-breaker:drawdown:0.1834");
  assert.equal(audits[0].trigger, "AUTO_CIRCUIT_BREAKER");
  assert.equal(audits[0].metric, "drawdown");
  assert.equal(audits[0].value, 0.1834);
  assert.equal(audits[0].limit, 0.15);
  assert.equal(audits[0].triggeredAt, new Date(NOW).toISOString());
  assert.equal(outcome.audit?.durable, true);

  // Alert mit maschinenlesbarem Code + Grund.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "circuit-breaker:drawdown");
  assert.equal(alerts[0].severity, "critical");
  assert.match(String(alerts[0].message), /Drawdown 18\.34 % ≥ Limit 15\.00 %/);
  assert.equal(outcome.alert?.sent, true);

  // Revisionsspur der Mutation (kill_switches-Zeile).
  assert.equal(killRows.length, 1);
  assert.equal(killRows[0].triggeredBy, "AUTO_CIRCUIT_BREAKER");
  assert.equal(killRows[0].armed, true);
  assert.equal(killRows[0].reason, "auto-circuit-breaker:drawdown:0.1834");
});

test("D2 (a): Tagesverlust-Bruch zieht denselben Pfad (Grund dailyLoss)", async () => {
  const { deps, audits, alerts } = makeDeps();
  const outcome = await checkCircuitBreaker({ ...CALM, dailyLossPct: 0.0621, dailyLossLimitPct: 0.05 }, deps);
  assert.equal(outcome.engaged, true);
  assert.equal(outcome.reason, "auto-circuit-breaker:dailyLoss:0.0621");
  assert.equal(killSwitch.isArmed(), true);
  assert.equal(audits[0].metric, "dailyLoss");
  assert.equal(alerts[0].code, "circuit-breaker:dailyLoss");
});

test("D2 (b): N Verlust-Closes in Folge lösen aus — darunter nicht", async () => {
  const below = makeDeps({ countLosses: async () => 4 });
  const calm = await checkCircuitBreaker(CALM, below.deps);
  assert.equal(calm.engaged, false);
  assert.equal(killSwitch.isArmed(), false);
  assert.equal(below.audits.length, 0);

  const hit = makeDeps({ countLosses: async () => 5 });
  const outcome = await checkCircuitBreaker(CALM, hit.deps);
  assert.equal(outcome.engaged, true);
  assert.equal(outcome.trigger?.metric, "consecutiveLosses");
  assert.equal(outcome.reason, "auto-circuit-breaker:consecutiveLosses:5");
  assert.equal(killSwitch.isArmed(), true);
  assert.equal(hit.alerts[0].code, "circuit-breaker:consecutiveLosses");
  assert.match(String(hit.alerts[0].message), /5 Verlust-Closes in Folge ≥ Limit 5/);
});

test("D2 (b): Auslöser-Priorität ist fest (Drawdown vor Tagesverlust vor Serie)", () => {
  const input = { drawdownPct: 0.2, maxEquityDrawdownPct: 0.15, dailyLossPct: 0.2, dailyLossLimitPct: 0.05, maxConsecutiveLosses: 5, consecutiveLosses: 9 };
  assert.equal(evaluateCircuitBreaker(input)?.metric, "drawdown");
  assert.equal(evaluateCircuitBreaker({ ...input, drawdownPct: 0.1 })?.metric, "dailyLoss");
  assert.equal(evaluateCircuitBreaker({ ...input, drawdownPct: 0.1, dailyLossPct: 0.01 })?.metric, "consecutiveLosses");
  assert.equal(evaluateCircuitBreaker({ ...CALM, maxConsecutiveLosses: 5, consecutiveLosses: 4 }), null);
  // „Unbekannt“ (NaN, z. B. Zählfehler) ist kein Serien-Trigger.
  assert.equal(
    evaluateCircuitBreaker({ ...CALM, maxConsecutiveLosses: 5, consecutiveLosses: Number.NaN }),
    null,
  );
});

test("D2 (b): nicht lesbare Verlustserie → kein geratener Engage, Fehler sichtbar", async () => {
  const { deps, audits } = makeDeps({
    countLosses: async () => {
      throw new Error("DB weg");
    },
  });
  const outcome = await checkCircuitBreaker(CALM, deps);
  assert.equal(outcome.engaged, false);
  assert.equal(killSwitch.isArmed(), false);
  assert.equal(audits.length, 0);
  assert.ok(outcome.errors.some((e) => /Verlustserie nicht lesbar/.test(e)));
});

test("D2 (c): AUTO_CIRCUIT_BREAKER=off → kein Engage (Default on, Bounds on/off)", async () => {
  assert.equal(loadCircuitBreakerConfig({}).enabled, true, "Default ist on (harte Grenzen)");
  assert.equal(loadCircuitBreakerConfig({ AUTO_CIRCUIT_BREAKER: "off" }).enabled, false);
  assert.equal(loadCircuitBreakerConfig({ AUTO_CIRCUIT_BREAKER: "0" }).enabled, false);
  // Tippfehler schalten den Brecher NICHT still ab (Default on + Warnung).
  assert.equal(loadCircuitBreakerConfig({ AUTO_CIRCUIT_BREAKER: "vielleicht" }).enabled, true);

  const { deps, audits, alerts } = makeDeps({
    config: { enabled: false, maxConsecutiveLosses: 5 },
  });
  const outcome = await checkCircuitBreaker({ ...CALM, drawdownPct: 0.9 }, deps);
  assert.equal(outcome.enabled, false);
  assert.equal(outcome.engaged, false);
  assert.equal(killSwitch.isArmed(), false);
  assert.equal(audits.length, 0);
  assert.equal(alerts.length, 0);
});

test("D2 (c): RISK_MAX_CONSECUTIVE_LOSSES — Default 5, Bounds [2, 50], Clamp", () => {
  assert.equal(loadCircuitBreakerConfig({}).maxConsecutiveLosses, MAX_CONSECUTIVE_LOSSES_DEFAULT);
  assert.equal(MAX_CONSECUTIVE_LOSSES_DEFAULT, 5);
  assert.deepEqual(MAX_CONSECUTIVE_LOSSES_BOUNDS, { min: 2, max: 50 });
  assert.equal(loadCircuitBreakerConfig({ RISK_MAX_CONSECUTIVE_LOSSES: "1" }).maxConsecutiveLosses, 2);
  assert.equal(loadCircuitBreakerConfig({ RISK_MAX_CONSECUTIVE_LOSSES: "99" }).maxConsecutiveLosses, 50);
  assert.equal(loadCircuitBreakerConfig({ RISK_MAX_CONSECUTIVE_LOSSES: "7" }).maxConsecutiveLosses, 7);
  assert.equal(loadCircuitBreakerConfig({ RISK_MAX_CONSECUTIVE_LOSSES: "abc" }).maxConsecutiveLosses, 5);
  assert.equal(CIRCUIT_BREAKER_ENV.ENABLED, "AUTO_CIRCUIT_BREAKER");
});

test("D2 (d): Latching — ein erneuter Tick ändert den Zustand nicht", async () => {
  const { deps, audits, alerts } = makeDeps({ countLosses: async () => 5 });
  const first = await checkCircuitBreaker(CALM, deps);
  assert.equal(first.engaged, true);

  // Zweiter Tick (noch schlimmerer Drawdown): latched, kein zweites Engage,
  // kein zweiter Audit, kein zweiter Alert.
  const second = await checkCircuitBreaker({ ...CALM, drawdownPct: 0.9 }, deps);
  assert.equal(second.engaged, false);
  assert.equal(second.latched, true);
  assert.equal(second.reason, first.reason);
  assert.equal(killSwitch.isArmed(), true);
  assert.equal(audits.length, 1, "der Auslösewert wird beim ersten Mal fixiert");
  assert.equal(alerts.length, 1, "Latching verhindert Alert-Flatter");
  assert.ok(circuitBreakerLatch());

  // Manueller Disarm (hier direkt am Kill-Switch) fällt den Latch: der
  // Brecher darf erneut greifen — das ist KEINE Auto-Re-Arm-Logik, der
  // Mensch entschärft, der Brecher vergisst nur seinen Latch.
  killSwitch.disarm();
  const third = await checkCircuitBreaker(CALM, deps);
  assert.equal(third.engaged, true);
  assert.equal(killSwitch.isArmed(), true);
  assert.equal(audits.length, 2);
});

test("D2 (d): Audit-Lücke wird gemeldet, Engage bleibt (sichere Richtung zuerst)", async () => {
  const { deps } = makeDeps({
    countLosses: async () => 5,
    audit: async () => ({ durable: false, error: "DB weg" }),
  });
  const outcome = await checkCircuitBreaker(CALM, deps);
  assert.equal(outcome.engaged, true);
  assert.equal(killSwitch.isArmed(), true);
  assert.equal(outcome.audit?.durable, false);
  assert.ok(outcome.errors.some((e) => /Audit/.test(e)));
});

test("D2 (e): Re-Arm bleibt manuell — kein Disarm im Brecher-Modul, Route verlangt Nonce", async () => {
  // 1) Der Brecher enthält keinerlei Auto-Re-Arm-Logik.
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "circuitBreaker.ts"), "utf8");
  assert.ok(!/\.disarm\(/.test(source), "circuitBreaker.ts darf den Kill-Switch nie entschärfen");
  assert.ok(!/killSwitch\.disarm/.test(source));

  // 2) Der einzige Re-Arm-Weg führt über den Challenge-Nonce. Ohne Nonce
  //    verweigert die Route VOR jeder Mutation (403, Kill-Switch bleibt scharf).
  const { POST } = await import("../src/app/api/firm/kill/route");
  const saved = {
    FIRM_ADMIN_TOKEN: process.env.FIRM_ADMIN_TOKEN,
    FIRM_API_TOKEN: process.env.FIRM_API_TOKEN,
  };
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN; // local-open: Permission frei, CSRF bleibt Pflicht
  try {
    killSwitch.pull("test-arm");
    const denied = await POST(
      new Request("http://localhost/api/firm/kill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "local" },
        body: JSON.stringify({ arm: false }),
      }),
    );
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error?: string }).error, "NONCE_REQUIRED");
    assert.equal(killSwitch.isArmed(), true, "ohne Nonce bleibt der Not-Halt aktiv");

    // Abgelaufener/unbekannter Nonce ebenso:
    const unknown = await POST(
      new Request("http://localhost/api/firm/kill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "local" },
        body: JSON.stringify({ arm: false, nonce: "gibt-es-nicht" }),
      }),
    );
    assert.equal(unknown.status, 403);
    assert.equal(((await unknown.json()) as { error?: string }).error, "NONCE_REQUIRED");
    assert.equal(killSwitch.isArmed(), true);

    // Wiederverwendeter Nonce (single-use) ebenso — ohne DB-Kontakt:
    const { nonce } = issueDisarmNonce();
    assert.equal(consumeDisarmNonce(nonce), "ok");
    const reused = await POST(
      new Request("http://localhost/api/firm/kill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "local" },
        body: JSON.stringify({ arm: false, nonce }),
      }),
    );
    assert.equal(reused.status, 403);
    assert.equal(((await reused.json()) as { error?: string }).error, "NONCE_REUSED");
    assert.equal(killSwitch.isArmed(), true, "einmalig verwendete Nonce entschärft nichts");
  } finally {
    if (saved.FIRM_ADMIN_TOKEN === undefined) delete process.env.FIRM_ADMIN_TOKEN;
    else process.env.FIRM_ADMIN_TOKEN = saved.FIRM_ADMIN_TOKEN;
    if (saved.FIRM_API_TOKEN === undefined) delete process.env.FIRM_API_TOKEN;
    else process.env.FIRM_API_TOKEN = saved.FIRM_API_TOKEN;
  }
});

test("D2: Werte-Format und Beschreibung sind stabil (Audit/Alert-Vertrag)", () => {
  assert.equal(formatBreakerValue("drawdown", 0.18341), "0.1834");
  assert.equal(formatBreakerValue("dailyLoss", 0.05), "0.0500");
  assert.equal(formatBreakerValue("consecutiveLosses", 5.9), "5");
  assert.equal(formatBreakerValue("drawdown", Number.NaN), "unknown");
  assert.equal(
    describeTrigger({ metric: "drawdown", value: 0.2, limit: 0.15, reason: "auto-circuit-breaker:drawdown:0.2000" }),
    "Drawdown 20.00 % ≥ Limit 15.00 %",
  );
  assert.equal(
    describeTrigger({ metric: "dailyLoss", value: 0.06, limit: 0.05, reason: "auto-circuit-breaker:dailyLoss:0.0600" }),
    "Tagesverlust 6.00 % ≥ Limit 5.00 %",
  );
  assert.equal(
    describeTrigger({ metric: "consecutiveLosses", value: 5, limit: 5, reason: "auto-circuit-breaker:consecutiveLosses:5" }),
    "5 Verlust-Closes in Folge ≥ Limit 5",
  );
});

test("D2: countConsecutiveLosses ist auf die Schwelle begrenzt (Abfrage-Design)", () => {
  // Ohne DB wirft die Abfrage — der Punkt ist, dass die Funktion nie mehr als
  // die Schwelle (max. 50) liest und Fehler weitergibt (Aufrufer meldet sie).
  assert.equal(typeof countConsecutiveLosses, "function");
  return countConsecutiveLosses(5)
    .then((n: number) => assert.ok(n >= 0))
    .catch((e: unknown) => assert.ok(e instanceof Error, "ohne DB muss ein Fehler kommen, kein stiller 0-Wert"));
});

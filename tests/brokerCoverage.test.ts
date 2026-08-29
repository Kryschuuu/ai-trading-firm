/**
 * Coverage-Modell (Operations Center): Trennung „registrierte" vs.
 * „tatsächlich abgedeckte" Venues.
 *
 * Prüft die reine Projektion (`computeBrokerCoverage`) sowie den API-Endpunkt
 * `GET /api/brokers/coverage`. Die Live-Bewertung wird für Determinismus
 * injiziert (Default wäre der zentrale Live-Gate-Enforcer).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBrokerCoverage,
  COVERAGE_METRIC_IDS,
  COVERAGE_METRIC_LABELS,
  INTERNAL_VENUE,
} from "../src/brokers/coverage";
import { BROKER_VENUE_IDS } from "../src/contracts/broker";

/** Deterministische Live-Bewertung: alles gesperrt (Default-Zustand). */
const allLocked = () => ({ enabled: false, reason: "LIVE_GATE_LOCKED: test" });

test("Coverage: registrierte Venues == Anzahl Adapter (SSoT)", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  assert.equal(c.registeredVenues, BROKER_VENUE_IDS.length);
  assert.equal(c.rows.length, BROKER_VENUE_IDS.length);
});

test("Coverage: intern vs. extern (PAPER ist der einzige interne Simulator)", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  assert.equal(c.internalVenues, 1);
  assert.equal(c.externalVenues, BROKER_VENUE_IDS.length - 1);
  const internalRow = c.rows.find((r) => r.internal);
  assert.ok(internalRow);
  assert.equal(internalRow.venue, INTERNAL_VENUE);
});

test("Coverage: Headline-Zahlen entsprechen dem geforderten Bild (1/1/0)", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  // Nur reale externe Venues zählen für die Headline: heute exakt BITUNIX.
  assert.equal(c.fullDiscoveryVenues, 1, "1 externes Venue mit voller Discovery");
  assert.equal(c.paperMarketDataVenues, 1, "1 externes Venue mit Paper-Market-Data");
  assert.equal(c.liveEnabledVenues, 0, "0 Venues mit aktiviertem Live Trading");
});

test("Coverage: alle fünf Metriken vorhanden und korrekt beschriftet", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  assert.deepEqual(
    c.metrics.map((m) => m.id),
    [...COVERAGE_METRIC_IDS]
  );
  for (const m of c.metrics) {
    assert.equal(m.label, COVERAGE_METRIC_LABELS[m.id]);
    assert.equal(m.total, BROKER_VENUE_IDS.length);
    assert.equal(m.covered, m.venues.length);
    assert.ok(m.covered >= 0 && m.covered <= m.total);
  }
});

test("Coverage: Discovery/Market-Data decken PAPER + BITUNIX ab (Capability-SSoT)", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  const discovery = c.metrics.find((m) => m.id === "discovery");
  const marketData = c.metrics.find((m) => m.id === "marketData");
  const paper = c.metrics.find((m) => m.id === "paperExecution");
  assert.ok(discovery && marketData && paper);
  assert.deepEqual([...discovery.venues].sort(), ["BITUNIX", "PAPER"]);
  assert.deepEqual([...marketData.venues].sort(), ["BITUNIX", "PAPER"]);
  assert.deepEqual([...paper.venues].sort(), ["BITUNIX", "PAPER"]);
});

test("Coverage: Testnet ist heute nirgends abgedeckt", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  const testnet = c.metrics.find((m) => m.id === "testnetExecution");
  assert.ok(testnet);
  assert.equal(testnet.covered, 0);
});

test("Coverage: Live-Execution folgt dem Gate — freigegebenes Venue erhöht die Zahl", () => {
  const withLive = computeBrokerCoverage({
    liveDecision: (v) =>
      v === "BITUNIX"
        ? { enabled: true, reason: "LIVE_ORDER_ALLOWED: test" }
        : { enabled: false, reason: "LIVE_GATE_LOCKED: test" },
  });
  assert.equal(withLive.liveEnabledVenues, 1);
  const liveMetric = withLive.metrics.find((m) => m.id === "liveExecution");
  assert.ok(liveMetric);
  assert.deepEqual(liveMetric.venues, ["BITUNIX"]);
  const bitunixRow = withLive.rows.find((r) => r.venue === "BITUNIX");
  assert.ok(bitunixRow);
  assert.equal(bitunixRow.liveEnabled, true);
  assert.equal(bitunixRow.liveCapable, true);
});

test("Coverage: liveCapable ≠ liveEnabled (Fähigkeit vs. Freigabe getrennt)", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  const bitunix = c.rows.find((r) => r.venue === "BITUNIX");
  assert.ok(bitunix);
  // Capability true, aber Freigabe (Gate) false → beide Konzepte getrennt.
  assert.equal(bitunix.liveCapable, true);
  assert.equal(bitunix.liveEnabled, false);
});

test("Coverage: Default-Live-Bewertung (zentraler Enforcer) sperrt fail-safe", () => {
  // Ohne Injektion liest computeBrokerCoverage den zentralen Live-Gate-Enforcer
  // (read-only, audit:false). Default-Zustand nach Task 11: alles gesperrt.
  const c = computeBrokerCoverage();
  assert.equal(c.liveEnabledVenues, 0);
  for (const row of c.rows) {
    assert.equal(row.liveEnabled, false);
    assert.match(row.liveReason, /LIVE/);
  }
});

test("Coverage: Detailtabelle enthält jedes registrierte Venue mit Label", () => {
  const c = computeBrokerCoverage({ liveDecision: allLocked });
  const venues = c.rows.map((r) => r.venue).sort();
  assert.deepEqual(venues, [...BROKER_VENUE_IDS].sort());
  for (const row of c.rows) {
    assert.ok(row.label.length > 0, `${row.venue} braucht ein Label`);
  }
});
